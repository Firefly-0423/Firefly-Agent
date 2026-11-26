import { expect, it, vi } from "vitest";
import { createSchedulerSubsystem, type SchedulerSubsystemDeps } from "./bootstrap";
vi.mock("electron", () => ({ app: { getPath: () => "E:/scheduler-fixture" }, BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }));
vi.mock("./scheduler-store", () => ({ getSchedulerStore: vi.fn() }));
vi.mock("./scheduler-ipc", () => ({ registerSchedulerIpc: vi.fn() }));
vi.mock("../../tooling/registry/tool-registry", () => ({ toolRegistry: { getAllTools: () => [], getEnabledTools: () => [] } }));
vi.mock("../../agent/runtime/firefly-agent", () => ({ FireflyAgent: class {} }));

it("keeps assembly inert and separates idempotent initialization from engine start and stop", async () => {
  const store = { load: vi.fn(), onChange: vi.fn(), getTasks: () => [], updateTask: vi.fn(), recordHistory: vi.fn() };
  const engine = { start: vi.fn(), stop: vi.fn() }, register = vi.fn();
  const deps = { store, createEngine: () => engine, registerIpc: register,
    agentRuntime: {}, getReactChatWindow: () => null } as unknown as SchedulerSubsystemDeps;
  const subsystem = createSchedulerSubsystem(deps);
  expect(store.load).not.toHaveBeenCalled();
  expect(register).not.toHaveBeenCalled();
  expect(engine.start).not.toHaveBeenCalled();
  subsystem.initialize();
  expect(store.load).toHaveBeenCalledTimes(1);
  expect(register).toHaveBeenCalledTimes(1);
  expect(engine.start).not.toHaveBeenCalled();
  subsystem.initialize();
  expect(store.load).toHaveBeenCalledTimes(1);
  expect(register).toHaveBeenCalledTimes(1);
  subsystem.start();
  expect(engine.start).toHaveBeenCalledTimes(1);
  expect(engine.stop).not.toHaveBeenCalled();
  await subsystem.stop();
  expect(engine.stop).toHaveBeenCalledTimes(1);
  expect(engine.start).toHaveBeenCalledTimes(1);
});

it("runs a task the plugin host owns through that host and every other task through the agent runner", async () => {
  const runAgent = vi.fn(async () => ({ ok: true, historyId: "agent", effectiveToolIds: [] }));
  vi.doMock("./scheduler-runner", () => ({ createSchedulerRunner: () => ({ runScheduledTask: runAgent, close: async () => {} }) }));
  vi.resetModules();
  const { createSchedulerSubsystem: create } = await import("./bootstrap");
  const hostRun = vi.fn(async () => ({ ok: true, historyId: "plugin", effectiveToolIds: [] }));
  let wiring: { runTask: (t: unknown, d: Date, m: boolean) => Promise<{ historyId: string }> } | undefined;
  const store = { load: vi.fn(), onChange: vi.fn(), getTasks: () => [], updateTask: vi.fn(), recordHistory: vi.fn() };
  create({
    store, agentRuntime: {}, getReactChatWindow: () => null,
    createEngine: (deps: unknown) => { wiring = deps as typeof wiring; return { start: vi.fn(), stop: vi.fn() }; },
    runPluginTask: (task: { ownerPluginId?: string }, at: Date, manual: boolean) => task.ownerPluginId === "v2" ? hostRun(task, at, manual) : undefined,
  } as unknown as SchedulerSubsystemDeps);
  const at = new Date("2026-11-26T00:00:00Z");
  const owned = { id: "a", ownerPluginId: "v2" }, plain = { id: "b" };
  expect((await wiring!.runTask(owned, at, true)).historyId).toBe("plugin");
  expect(hostRun).toHaveBeenCalledTimes(1);
  expect(hostRun).toHaveBeenCalledWith(owned, at, true);
  expect(runAgent).not.toHaveBeenCalled();
  expect((await wiring!.runTask(plain, at, false)).historyId).toBe("agent");
  expect(runAgent).toHaveBeenCalledTimes(1);
  expect(runAgent).toHaveBeenCalledWith(plain, at, false);
  expect(hostRun).toHaveBeenCalledTimes(1);
});

it("hands the plugin task enable guard to the scheduler IPC", () => {
  const store = { load: vi.fn(), onChange: vi.fn(), getTasks: () => [], updateTask: vi.fn(), recordHistory: vi.fn() };
  const register = vi.fn(), guard = vi.fn(), canRunTask = vi.fn(), ipc = {};
  createSchedulerSubsystem({ store, createEngine: () => ({}), registerIpc: register, ipc, guardPluginTaskEnable: guard, canRunTask,
    agentRuntime: {}, getReactChatWindow: () => null } as unknown as SchedulerSubsystemDeps).initialize();
  expect(register).toHaveBeenCalledWith(store, expect.anything(), expect.any(Function), ipc, guard, canRunTask);
});

it.each([
  { outcome: "success", hostRun: async () => ({ ok: true, historyId: "plugin", effectiveToolIds: [] }) },
  { outcome: "failure", hostRun: async () => { throw new Error("callback failed"); } },
])("tells the chat panel to re-read after the plugin host finishes a run ($outcome), and not for agent runs", async ({ hostRun }) => {
  const runAgent = vi.fn(async () => ({ ok: true, historyId: "agent", effectiveToolIds: [] }));
  vi.doMock("./scheduler-runner", () => ({ createSchedulerRunner: () => ({ runScheduledTask: runAgent, close: async () => {} }) }));
  vi.resetModules();
  const { createSchedulerSubsystem: create, PLUGIN_TASK_FINISHED_EVENT } = await import("./bootstrap");
  const { IPC } = await import("../../../shared/ipc-channels");
  const send = vi.fn();
  const chat = { isDestroyed: () => false, webContents: { send } };
  let wiring: { runTask: (t: unknown, d: Date, m: boolean) => Promise<unknown> } | undefined;
  const store = { load: vi.fn(), onChange: vi.fn(), getTasks: () => [], updateTask: vi.fn(), recordHistory: vi.fn() };
  create({
    store, agentRuntime: {}, getReactChatWindow: () => chat,
    createEngine: (deps: unknown) => { wiring = deps as typeof wiring; return { start: vi.fn(), stop: vi.fn() }; },
    runPluginTask: (task: { ownerPluginId?: string }) => task.ownerPluginId === "v2" ? hostRun() : undefined,
  } as unknown as SchedulerSubsystemDeps);
  const at = new Date("2026-11-26T00:00:00Z");

  await wiring!.runTask({ id: "plain" }, at, true);
  expect(send).not.toHaveBeenCalled();

  await wiring!.runTask({ id: "owned", ownerPluginId: "v2" }, at, true).catch(() => undefined);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith(IPC.SCHEDULER_EVENT, { type: "CUSTOM", name: PLUGIN_TASK_FINISHED_EVENT, schedulerTaskId: "owned" });
});
