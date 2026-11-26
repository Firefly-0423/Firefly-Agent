import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC } from "../../../shared/ipc-channels";
import { createPluginScheduleService } from "../../../plugins/v2/schedules";
import type { ScheduleProposalSpec } from "../../../plugins/v2/schedules/types";
import { createSchedulerStore } from "./scheduler-store";
import { registerPluginProposalIpc, type PluginProposalIpcResult, type PluginProposalView } from "./plugin-proposal-ipc";

vi.mock("electron", () => ({ app: { getPath: () => { throw Error("real profile forbidden"); } }, ipcMain: {} }));

const NOW = new Date("2032-03-10T10:00:00.000Z");
const PLUGIN = "dev.firefly.digest";

function runSpec(overrides: Partial<ScheduleProposalSpec> = {}): ScheduleProposalSpec {
  return {
    title: "Morning digest",
    schedule: { kind: "interval", minutes: 30 },
    action: { type: "run", prompt: "Summarize unread updates", mode: "work" },
    ...overrides,
  };
}

describe("plugin schedule proposal IPC", () => {
  let workdir: string;
  let counter: number;

  beforeEach(() => {
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-proposal-ipc-"));
    counter = 0;
  });
  afterEach(() => fs.rmSync(workdir, { recursive: true, force: true }));

  function makeStore() {
    const store = createSchedulerStore({
      tasksFile: path.join(workdir, "scheduled-tasks.json"),
      historyFile: path.join(workdir, "scheduled-tasks-history.jsonl"),
      now: () => NOW,
      id: () => `store-task-${counter++}`,
    });
    store.load();
    return store;
  }

  function setup(resolveTaskRisks?: () => Array<"shell">) {
    const store = makeStore();
    const stateChanged = vi.fn();
    const service = createPluginScheduleService({
      store,
      stateFile: path.join(workdir, "plugin-schedules-state.json"),
      now: () => NOW,
      id: () => `id-${counter++}`,
      onStateChanged: stateChanged,
      ...(resolveTaskRisks ? { resolveTaskRisks } : {}),
    });
    const handlers = new Map<string, (...args: any[]) => any>();
    registerPluginProposalIpc(
      { handle: (channel, handler) => { handlers.set(channel, handler); }, removeHandler() {}, on() {}, dispose() {} },
      service,
      (pluginId) => (pluginId === PLUGIN ? "Digest plugin" : undefined),
    );
    const call = <T = unknown>(channel: string, ...args: unknown[]) =>
      handlers.get(channel)!({}, ...args) as PluginProposalIpcResult<T>;
    /** Confirms like the panel does: with the revision of the proposal as last listed. */
    const confirm = (taskId: string) => {
      const listed = call<PluginProposalView[]>(IPC.SCHEDULER_PLUGIN_PROPOSALS_LIST);
      const revision = listed.ok ? listed.value.find((p) => p.taskId === taskId)?.revision : undefined;
      // Not listed (already decided or unknown): the service reports why before it looks at the revision.
      return call(IPC.SCHEDULER_PLUGIN_PROPOSALS_CONFIRM, taskId, revision ?? "not-listed");
    };
    return { store, service, stateChanged, handlers, call, confirm, plugin: service.forPlugin(PLUGIN) };
  }

  const tasksFileText = () => fs.readFileSync(path.join(workdir, "scheduled-tasks.json"), "utf8");

  it("registers the three proposal channels", () => {
    const { handlers } = setup();
    expect([...handlers.keys()].sort()).toEqual([
      IPC.SCHEDULER_PLUGIN_PROPOSALS_CONFIRM,
      IPC.SCHEDULER_PLUGIN_PROPOSALS_LIST,
      IPC.SCHEDULER_PLUGIN_PROPOSALS_REJECT,
    ].sort());
  });

  it("lists a pending create proposal with the plugin name and no scheduled task yet", async () => {
    const { call, plugin, store } = setup();
    const proposed = await plugin.propose(runSpec());

    const listed = call<PluginProposalView[]>(IPC.SCHEDULER_PLUGIN_PROPOSALS_LIST);

    expect(listed).toEqual({
      ok: true,
      value: [{
        proposalId: expect.any(String),
        revision: expect.stringMatching(/^[0-9a-f]{64}$/),
        taskId: proposed.taskId,
        pluginId: PLUGIN,
        pluginName: "Digest plugin",
        kind: "create",
        title: "Morning digest",
        schedule: { kind: "interval", minutes: 30 },
        action: { type: "run", prompt: "Summarize unread updates", mode: "work" },
        allowedToolIds: [],
        createdAt: NOW.toISOString(),
      }],
    });
    expect(store.getTasks()).toEqual([]);
  });

  it("falls back to the plugin id when the plugin name is unknown", async () => {
    const { call, service } = setup();
    await service.forPlugin("dev.firefly.unknown").propose(runSpec());
    const listed = call<PluginProposalView[]>(IPC.SCHEDULER_PLUGIN_PROPOSALS_LIST);
    expect(listed.ok && listed.value.map((p) => p.pluginName)).toEqual(["dev.firefly.unknown"]);
  });

  it("confirm creates the task in the scheduler store and clears the pending list", async () => {
    const { call, confirm, plugin, store } = setup();
    const proposed = await plugin.propose(runSpec());

    expect(confirm(proposed.taskId)).toEqual({ ok: true, value: true });

    expect(store.getTasks().map((t) => ({ title: t.title, owner: t.ownerPluginId }))).toEqual([
      { title: "Morning digest", owner: PLUGIN },
    ]);
    expect(call(IPC.SCHEDULER_PLUGIN_PROPOSALS_LIST)).toEqual({ ok: true, value: [] });
  });

  it("list gives every proposal a revision that changes when the pending spec changes", async () => {
    const { call, plugin } = setup();
    const created = await plugin.propose(runSpec());
    const revisionOf = () => {
      const listed = call<PluginProposalView[]>(IPC.SCHEDULER_PLUGIN_PROPOSALS_LIST);
      return listed.ok ? listed.value[0].revision : undefined;
    };
    const first = revisionOf();
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(revisionOf()).toBe(first);

    await plugin.update(created.taskId, { allowedToolIds: ["shell"] });

    expect(revisionOf()).not.toBe(first);
  });

  it("confirm with a revision from before the plugin edited the proposal is rejected and saves nothing", async () => {
    const { call, confirm, plugin, store, stateChanged } = setup();
    const created = await plugin.propose(runSpec());
    const reviewed = call<PluginProposalView[]>(IPC.SCHEDULER_PLUGIN_PROPOSALS_LIST);
    const revision = reviewed.ok ? reviewed.value[0].revision : undefined;
    await plugin.update(created.taskId, { allowedToolIds: ["shell"] });
    const changesBefore = stateChanged.mock.calls.length;

    const result = call(IPC.SCHEDULER_PLUGIN_PROPOSALS_CONFIRM, created.taskId, revision);

    expect(result).toMatchObject({ ok: false, code: "ERR_UNAVAILABLE" });
    expect(store.getTasks()).toEqual([]);
    expect(stateChanged).toHaveBeenCalledTimes(changesBefore);
    const relisted = call<PluginProposalView[]>(IPC.SCHEDULER_PLUGIN_PROPOSALS_LIST);
    expect(relisted.ok && relisted.value.map((p) => p.allowedToolIds)).toEqual([["shell"]]);
    expect(confirm(created.taskId)).toEqual({ ok: true, value: true });
    expect(store.getTasks().map((t) => t.allowedToolIds)).toEqual([["shell"]]);
  });

  it("confirm without a revision is rejected as an invalid argument and saves nothing", async () => {
    const { call, plugin, store } = setup();
    const created = await plugin.propose(runSpec());

    expect(call(IPC.SCHEDULER_PLUGIN_PROPOSALS_CONFIRM, created.taskId)).toMatchObject({ ok: false, code: "ERR_INVALID_ARGUMENT" });
    expect(store.getTasks()).toEqual([]);
  });

  it("reject leaves the scheduler store empty and clears the pending list", async () => {
    const { call, plugin, store } = setup();
    const proposed = await plugin.propose(runSpec());

    expect(call(IPC.SCHEDULER_PLUGIN_PROPOSALS_REJECT, proposed.taskId)).toEqual({ ok: true, value: true });

    expect(store.getTasks()).toEqual([]);
    expect(call(IPC.SCHEDULER_PLUGIN_PROPOSALS_LIST)).toEqual({ ok: true, value: [] });
  });

  it("confirming twice returns ERR_INVALID_ARGUMENT and does not create a second task", async () => {
    const { call, confirm, plugin, store, stateChanged } = setup();
    const proposed = await plugin.propose(runSpec());
    confirm(proposed.taskId);
    const before = tasksFileText();
    const changesBefore = stateChanged.mock.calls.length;

    const second = confirm(proposed.taskId);

    expect(second).toMatchObject({ ok: false, code: "ERR_INVALID_ARGUMENT" });
    expect(store.getTasks()).toHaveLength(1);
    expect(tasksFileText()).toBe(before);
    expect(stateChanged).toHaveBeenCalledTimes(changesBefore);
  });

  it("an unknown taskId returns ERR_INVALID_ARGUMENT for confirm and reject and writes nothing", () => {
    const { call, store, stateChanged } = setup();

    expect(call(IPC.SCHEDULER_PLUGIN_PROPOSALS_CONFIRM, "no-such-task")).toMatchObject({ ok: false, code: "ERR_INVALID_ARGUMENT" });
    expect(call(IPC.SCHEDULER_PLUGIN_PROPOSALS_REJECT, "no-such-task")).toMatchObject({ ok: false, code: "ERR_INVALID_ARGUMENT" });

    expect(store.getTasks()).toEqual([]);
    expect(stateChanged).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(workdir, "plugin-schedules-state.json"))).toBe(false);
  });

  it("confirming a proposal that needs unattended approval returns the stable reason, saves nothing and keeps it pending", async () => {
    const { call, confirm, plugin, store } = setup(() => ["shell"]);
    const proposed = await plugin.propose(runSpec({ allowedToolIds: ["run-shell"] }));

    expect(confirm(proposed.taskId)).toEqual({
      ok: false,
      error: expect.stringContaining("can't approve unattended runs"),
      code: "ERR_PERMISSION",
      reason: "unattended_approval_unsupported",
    });
    expect(store.getTasks()).toEqual([]);
    const listed = call<PluginProposalView[]>(IPC.SCHEDULER_PLUGIN_PROPOSALS_LIST);
    expect(listed.ok && listed.value.map((p) => p.taskId)).toEqual([proposed.taskId]);
  });

  it("confirming a rejected proposal returns ERR_REJECTED and creates no task", async () => {
    const { call, confirm, plugin, store } = setup();
    const proposed = await plugin.propose(runSpec());
    call(IPC.SCHEDULER_PLUGIN_PROPOSALS_REJECT, proposed.taskId);

    expect(confirm(proposed.taskId)).toMatchObject({ ok: false, code: "ERR_REJECTED" });
    expect(store.getTasks()).toEqual([]);
  });

  it("an update proposal carries the current task so the panel can show what changes, and confirm applies it", async () => {
    const { call, confirm, plugin, store } = setup();
    const created = await plugin.propose(runSpec());
    confirm(created.taskId);
    await plugin.update(created.taskId, { title: "Evening digest", schedule: { kind: "interval", minutes: 120 } });

    const listed = call<PluginProposalView[]>(IPC.SCHEDULER_PLUGIN_PROPOSALS_LIST);

    expect(listed).toMatchObject({
      ok: true,
      value: [{
        taskId: created.taskId,
        kind: "update",
        title: "Evening digest",
        schedule: { kind: "interval", minutes: 120 },
        current: {
          title: "Morning digest",
          schedule: { kind: "interval", minutes: 30 },
          action: { type: "run", prompt: "Summarize unread updates", mode: "work" },
        },
      }],
    });
    expect(store.getTasks().map((t) => t.title)).toEqual(["Morning digest"]);

    expect(confirm(created.taskId)).toEqual({ ok: true, value: true });
    expect(store.getTasks().map((t) => t.title)).toEqual(["Evening digest"]);
  });

  it("notifies once for each propose, confirm and reject that changed state", async () => {
    const { call, confirm, plugin, stateChanged } = setup();
    const a = await plugin.propose(runSpec());
    expect(stateChanged).toHaveBeenCalledTimes(1);
    confirm(a.taskId);
    expect(stateChanged).toHaveBeenCalledTimes(2);
    const b = await plugin.propose(runSpec({ title: "Other" }));
    call(IPC.SCHEDULER_PLUGIN_PROPOSALS_REJECT, b.taskId);
    expect(stateChanged).toHaveBeenCalledTimes(4);
  });

  it("a throwing change hook does not fail the confirmation", async () => {
    const store = makeStore();
    const service = createPluginScheduleService({
      store,
      stateFile: path.join(workdir, "state.json"),
      now: () => NOW,
      id: () => `id-${counter++}`,
      onStateChanged: () => { throw new Error("renderer gone"); },
    });
    const proposed = await service.forPlugin(PLUGIN).propose(runSpec());
    expect(() => service.confirmProposal(proposed.taskId)).not.toThrow();
    expect(store.getTasks()).toHaveLength(1);
  });
});
