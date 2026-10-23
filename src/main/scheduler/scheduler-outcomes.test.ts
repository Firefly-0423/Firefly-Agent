import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC } from "../../shared/ipc-channels";
import { createSchedulerStore } from "./scheduler-store";
import { createSchedulerRunner } from "./scheduler-runner";
import { SchedulerEngine } from "./scheduler-engine";
import { registerSchedulerIpc } from "./scheduler-ipc";
import { toastEvents } from "../toast/toast-events";
import type { ScheduledTaskHistoryEntry } from "./types";

const model = vi.hoisted(() => ({ terminal: undefined as undefined | "success" | "timeout" | "cancelled" | "runtime_error", executions: 0,
  eventTerminal: undefined as undefined | "success" | "timeout" | "cancelled" | "runtime_error", noResult: false }));
vi.mock("electron", () => ({ app: { getPath: () => { throw Error("real profile forbidden"); } }, ipcMain: {} }));
vi.mock("../orchestrator/tools/registry/tool-registry", () => ({ toolRegistry: { getAllTools: () => [] } }));
vi.mock("../orchestrator/firefly-agent", () => ({ FireflyAgent: class {
  lastResult = model.noResult ? undefined : { reply: "partial reply", ...(model.terminal ? { terminal: { status: model.terminal } } : {}) };
  runWithEvents() { return { subscribe({ complete, next }: { complete(): void; next(event: unknown): void }) {
    model.executions++;
    queueMicrotask(() => {
      next({ type: "TEXT_MESSAGE_CONTENT", delta: "partial reply" });
      if (model.eventTerminal) next({ type: "RUN_FINISHED", threadId: "agent-thread", runId: "history", result: {
        status: model.eventTerminal, reason: "fixture_terminal", externalEffectsMayContinue: model.eventTerminal !== "success" } });
      complete();
    });
    return { unsubscribe() {} };
  } }; }
} }));
const cleanup: Array<() => void | Promise<void>> = [];
beforeEach(() => { model.terminal = undefined; model.executions = 0; model.eventTerminal = undefined; model.noResult = false; });
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); vi.restoreAllMocks(); });
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function fixture(options: { close?: () => Promise<void>; historyFailure?: "initial" | "final"; deliveryFailure?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-scheduler-outcome-"));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createSchedulerStore({ tasksFile: path.join(root, "tasks.json"), historyFile: path.join(root, "history.jsonl"), now: () => new Date("2026-10-18T10:00:00Z"), id: () => "task" }); store.load();
  const task = store.addTask({ title: "offline", prompt: "offline", schedule: { kind: "daily", timeOfDay: "12:00" }, toolMode: "allow-list", allowedToolIds: [] });
  const finished: string[] = [], schedulerFinished: string[] = [], toasts: unknown[] = [], writes: ScheduledTaskHistoryEntry[] = [];
  const events: Array<{ type: string; result?: unknown; message?: string; schedulerRunId?: string }> = [];
  cleanup.push(toastEvents.onSchedulerFinished(event => { toasts.push(event); }));
  let closeCalls = 0;
  const runner = createSchedulerRunner({
    buildOptions: async () => ({ modelProfileId: "synthetic-profile", messages: [{ role: "user", content: "offline" }], settings: { provider: "test", model: "offline", baseUrl: "", apiKey: "" }, timeoutMs: 500 } as never),
    memoryHost: { prepareBackgroundRun: async input => ({ sessionId: "synthetic", signal: input.signal, transcriptSink: {} as never, openMemoryRun: async () => { throw Error("unused model"); }, close: async () => { closeCalls++; await options.close?.(); } }) },
    recordHistory: entry => {
      writes.push(entry);
      if (options.historyFailure === "initial" || options.historyFailure === "final" && entry.status !== "running") throw Error("synthetic history write failure");
      store.recordHistory(entry);
    },
    getChatWebContents: () => ({ isDestroyed: () => false, send: (_channel: string, event: typeof events[number]) => { events.push(event); } }) as never,
    id: () => "history", now: () => new Date("2026-10-18T10:00:00Z"),
    publishLifecycle: { publishTurnStarted() {}, publishTurnFinished(event) { finished.push(event.status); if (options.deliveryFailure) throw Error("synthetic delivery failure"); }, publishSchedulerFinished(event) { schedulerFinished.push(event.status); } } as never,
  });
  cleanup.push(() => runner.close());
  return { store, task, runner, finished, schedulerFinished, toasts, writes, events, closeCalls: () => closeCalls };
}

const terminalEvents = (events: Array<{ type: string }>) => events.filter(event => event.type === "RUN_FINISHED" || event.type === "RUN_ERROR");

describe("one scheduler terminal after execution and cleanup", () => {
  it.each(["timeout", "cancelled", "runtime_error"] as const)("persists and returns the actual non-success terminal %s", async terminal => {
    model.terminal = terminal; const f = fixture();
    const result = await f.runner.runScheduledTask(f.task, new Date(), false);
    expect(result).toMatchObject({ ok: false, historyId: "history", reply: "partial reply" });
    expect(result.error).toContain(terminal);
    expect(f.store.getHistory("task")[0]).toMatchObject({ status: "failed" });
    expect(f.finished).toEqual([terminal]); expect(f.schedulerFinished).toEqual([terminal]); expect(f.toasts).toEqual([]);
  });
  it.each(["success", undefined] as const)("retains success and the legacy no-terminal fallback (%s)", async terminal => {
    model.terminal = terminal; const f = fixture();
    expect((await f.runner.runScheduledTask(f.task, new Date(), false)).ok).toBe(true);
    expect(f.store.getHistory("task")[0].status).toBe("success"); expect(f.finished).toEqual(["success"]); expect(f.toasts).toHaveLength(1);
  });
  it("does not record or publish success until resource cleanup actually settles", async () => {
    const close = gate(), f = fixture({ close: () => close.promise }); let settled = false;
    const running = f.runner.runScheduledTask(f.task, new Date(), false).then(result => { settled = true; return result; });
    try {
      await vi.waitFor(() => expect(f.closeCalls()).toBe(1));
      expect(settled).toBe(false); expect(f.finished).toEqual([]); expect(f.toasts).toEqual([]);
      expect(f.store.getHistory("task")[0].status).toBe("running");
    } finally { close.resolve(); await running; }
    expect((await running).ok).toBe(true); expect(f.finished).toEqual(["success"]);
  });
  it("reports cleanup failure once and warns about effects that may already have been applied", async () => {
    const f = fixture({ close: async () => { throw Error("synthetic close failure"); } });
    const result = await f.runner.runScheduledTask(f.task, new Date(), false);
    expect(result).toMatchObject({ ok: false, reply: "partial reply" });
    expect(result.error).toMatch(/may already have taken effect/i);
    expect(f.store.getHistory("task")[0]).toMatchObject({ status: "failed", errorMessage: expect.stringContaining("synthetic close failure") });
    expect(f.finished).toEqual(["runtime_error"]); expect(f.schedulerFinished).toEqual(["runtime_error"]); expect(f.toasts).toEqual([]);
    expect(model.executions).toBe(1); expect(f.closeCalls()).toBe(1);
  });
  it.each(["initial", "final"] as const)("contains %s history failure without recursively using the failed writer", async historyFailure => {
    const f = fixture({ historyFailure });
    const result = await f.runner.runScheduledTask(f.task, new Date(), false);
    expect(result.ok).toBe(false); expect(result.error).toContain("synthetic history write failure");
    expect(f.finished).toEqual(["runtime_error"]); expect(f.schedulerFinished).toEqual(["runtime_error"]); expect(f.toasts).toEqual([]);
    expect(f.writes).toHaveLength(historyFailure === "initial" ? 1 : 2);
    expect(model.executions).toBe(historyFailure === "initial" ? 0 : 1);
    if (historyFailure === "final") expect(f.store.getHistory("task")[0].status).toBe("running");
  });
  it("does not rewrite an outcome or publish a second terminal when notification delivery throws", async () => {
    const f = fixture({ deliveryFailure: true });
    expect((await f.runner.runScheduledTask(f.task, new Date(), false)).ok).toBe(true);
    expect(f.store.getHistory("task")[0].status).toBe("success"); expect(f.finished).toEqual(["success"]); expect(f.schedulerFinished).toEqual(["success"]);
  });
  it("propagates a failed run through fireNow and its existing IPC result shape", async () => {
    model.terminal = "timeout"; const f = fixture();
    const engine = new SchedulerEngine({ store: f.store, runTask: f.runner.runScheduledTask });
    const handlers = new Map<string, (...args: any[]) => any>();
    registerSchedulerIpc(f.store, engine, () => [], { handle: (channel, handler) => { handlers.set(channel, handler); }, removeHandler() {}, on() {}, dispose() {} });
    const response = await handlers.get(IPC.SCHEDULER_FIRE_NOW)!(null, f.task.id);
    expect(response).toMatchObject({ ok: false, reason: expect.stringContaining("timeout") });
    expect(f.store.getHistory("task")[0].status).toBe("failed");
  });
  it.each(["success", "cleanup failure", "history failure", "timeout"])("publishes one IPC terminal only after finalization: %s", async kind => {
    const close = gate();
    model.eventTerminal = kind === "timeout" ? "timeout" : "success";
    model.terminal = model.eventTerminal;
    const f = fixture({ historyFailure: kind === "history failure" ? "final" : undefined,
      close: async () => { await close.promise; if (kind === "cleanup failure") throw Error("close failed"); } });
    const running = f.runner.runScheduledTask(f.task, new Date(), false);
    try {
      await vi.waitFor(() => expect(f.closeCalls()).toBe(1));
      expect(f.events.some(event => event.type === "TEXT_MESSAGE_CONTENT")).toBe(true);
      expect(terminalEvents(f.events)).toEqual([]);
      expect(f.store.getHistory("task")[0].status).toBe("running");
    } finally { close.resolve(); await running; }
    const terminal = terminalEvents(f.events);
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({ type: kind === "success" ? "RUN_FINISHED" : "RUN_ERROR", schedulerRunId: "history" });
    if (kind === "success") expect(terminal[0]).toMatchObject({ runId: "history", result: { status: "success", reason: "fixture_terminal" } });
    else expect((await running).ok).toBe(false);
    // The existing renderer consumes and removes its stream on the first terminal.
    expect(terminal[0].type === "RUN_ERROR").toBe(kind !== "success");
  });
  it.each(["cancelled", "timeout", "runtime_error"] as const)("uses an event-only %s terminal when Agent has no lastResult", async terminal => {
    model.eventTerminal = terminal; model.noResult = true;
    const f = fixture();
    const result = await f.runner.runScheduledTask(f.task, new Date(), false);
    expect(result.ok).toBe(false); expect(result.error).toContain(terminal);
    expect(f.store.getHistory("task")[0].status).toBe("failed");
    expect(f.finished).toEqual([terminal]); expect(f.schedulerFinished).toEqual([terminal]); expect(f.toasts).toEqual([]);
    expect(terminalEvents(f.events)).toEqual([expect.objectContaining({ type: "RUN_ERROR" })]);
  });
});
