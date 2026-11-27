import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSchedulerStore } from "../../../main/features/scheduler/scheduler-store";
import type { ScheduledTask } from "../../../main/platform/schedule/schedule-types";
import {
  PLUGIN_TO_HOST_METHODS as P,
  type ProtocolScheduleTriggerChunk,
} from "../../../shared/plugin-protocol";
import type { PluginRpc } from "../../../shared/plugin-rpc";
import { bindPluginScheduleRpc, createPluginScheduleService } from "./index";

type Handler = (params: unknown, context: { signal: AbortSignal }) => unknown;

const BASE_TIME = new Date("2032-03-10T10:00:00.000Z");
const PLUGIN_ID = "dev.firefly.ack";
const TIMEOUT_MS = 60_000;

describe("schedules.onTrigger completion acknowledgement", () => {
  let workdir: string;
  let idCounter: number;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
    idCounter = 1;
    workdir = mkdtempSync(join(tmpdir(), "ff-v2-schedule-rpc-"));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(workdir, { recursive: true, force: true });
  });

  async function setup() {
    const store = createSchedulerStore({
      tasksFile: join(workdir, "scheduled-tasks.json"),
      historyFile: join(workdir, "scheduled-tasks-history.jsonl"),
      now: () => new Date(),
      id: () => `store-task-${idCounter++}`,
    });
    store.load();
    const service = createPluginScheduleService({
      store,
      stateFile: join(workdir, "plugin-schedules-state.json"),
      now: () => new Date(),
      id: () => `id-${idCounter++}`,
      refreshEngine: () => {},
    });

    const handlers = new Map<string, Handler>();
    const rpc = {
      handle(method: string, handler: Handler) {
        handlers.set(method, handler);
        return () => handlers.delete(method);
      },
    } as unknown as PluginRpc;
    const unbind = bindPluginScheduleRpc(
      service,
      { pluginId: PLUGIN_ID, declared: true, hasPermission: () => true, triggerTimeoutMs: TIMEOUT_MS },
      rpc,
    );

    const streamAbort = new AbortController();
    const stream = (handlers.get(P.schedulesOnTrigger)!({}, { signal: streamAbort.signal }) as AsyncIterable<ProtocolScheduleTriggerChunk>)[Symbol.asyncIterator]();
    const next = stream.next();
    await vi.advanceTimersByTimeAsync(0);

    const proposed = await service.forPlugin(PLUGIN_ID).propose({
      title: "Callback",
      schedule: { kind: "interval", minutes: 5 },
      action: { type: "callback" },
    });
    service.confirmProposal(proposed.taskId);
    const task: ScheduledTask = store.getTasks()[0];

    const fire = () => service.runScheduledTask(task, new Date(), false);
    const report = (result: Record<string, unknown>) => handlers.get(P.schedulesTriggerResult)!(result, { signal: new AbortController().signal });
    return { store, task, fire, report, next, stream, streamAbort, unbind };
  }

  it("keeps the run lock and writes no history while the plugin callback is still running", async () => {
    const { store, task, fire, next } = await setup();
    const first = fire();
    const chunk = (await next).value as ProtocolScheduleTriggerChunk;
    expect(chunk.taskId).toEqual(expect.any(String));
    expect(chunk.triggerId).toEqual(expect.any(String));
    await vi.advanceTimersByTimeAsync(0);

    let settled = false;
    void first.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    expect(store.getHistory(task.id)).toEqual([]);

    // A second trigger for the same task is skipped, not run alongside the first.
    await expect(fire()).resolves.toMatchObject({ ok: false, error: "task already running" });
    expect(store.getHistory(task.id).map((row) => row.status)).toEqual(["skipped"]);

    await vi.advanceTimersByTimeAsync(1);
    await first;
  });

  it("records a success entry only after the plugin reports the callback finished", async () => {
    const { store, task, fire, report, next } = await setup();
    const running = fire();
    const chunk = (await next).value as ProtocolScheduleTriggerChunk;
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getHistory(task.id)).toEqual([]);

    await expect(report({ triggerId: chunk.triggerId, ok: true })).resolves.toBe(true);
    await expect(running).resolves.toMatchObject({ ok: true });
    expect(store.getHistory(task.id).map((row) => row.status)).toEqual(["success"]);
    // Late duplicate acknowledgements are ignored.
    await expect(report({ triggerId: chunk.triggerId, ok: true })).resolves.toBe(false);
  });

  it("records a failure with the plugin's error and no success entry when the callback throws", async () => {
    const { store, task, fire, report, next } = await setup();
    const running = fire();
    const chunk = (await next).value as ProtocolScheduleTriggerChunk;
    await vi.advanceTimersByTimeAsync(0);

    await report({ triggerId: chunk.triggerId, ok: false, error: { message: "boom" } });
    await expect(running).resolves.toMatchObject({ ok: false, error: "boom" });
    const history = store.getHistory(task.id);
    expect(history.map((row) => row.status)).toEqual(["failed"]);
    expect(history[0].errorMessage).toBe("boom");
  });

  it("fails with a timeout and releases the lock when the plugin never acknowledges", async () => {
    const { store, task, fire, next } = await setup();
    const running = fire();
    await next;
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);

    await expect(running).resolves.toMatchObject({ ok: false });
    const history = store.getHistory(task.id);
    expect(history.map((row) => row.status)).toEqual(["failed"]);
    expect(history[0].errorMessage).toContain(`${TIMEOUT_MS}ms`);
  });

  it("fails and releases the lock when the stream is aborted mid-callback", async () => {
    const { store, task, fire, next, stream, streamAbort } = await setup();
    const running = fire();
    await next;
    await vi.advanceTimersByTimeAsync(0);

    streamAbort.abort();
    await stream.next();
    await expect(running).resolves.toMatchObject({ ok: false });
    expect(store.getHistory(task.id).map((row) => row.status)).toEqual(["failed"]);
    // The lock is free: a new trigger is not skipped as "already running".
    const again = fire();
    await vi.advanceTimersByTimeAsync(0);
    await expect(again).resolves.not.toMatchObject({ error: "task already running" });
  });

  it("fails the in-flight callback when the plugin host stops", async () => {
    const { store, task, fire, next, stream, unbind } = await setup();
    const running = fire();
    await next;
    await vi.advanceTimersByTimeAsync(0);

    unbind();
    await stream.next();
    await expect(running).resolves.toMatchObject({ ok: false });
    expect(store.getHistory(task.id).map((row) => row.status)).toEqual(["failed"]);
  });
});
