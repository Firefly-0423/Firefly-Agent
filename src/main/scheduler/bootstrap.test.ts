import { expect, it, vi } from "vitest";
import { createSchedulerSubsystem, type SchedulerSubsystemDeps } from "./bootstrap";
vi.mock("electron", () => ({ app: { getPath: () => "E:/scheduler-fixture" }, BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }));
vi.mock("./scheduler-store", () => ({ getSchedulerStore: vi.fn() }));
vi.mock("./scheduler-ipc", () => ({ registerSchedulerIpc: vi.fn() }));
vi.mock("../orchestrator/tools/registry/tool-registry", () => ({ toolRegistry: { getAllTools: () => [], getEnabledTools: () => [] } }));
vi.mock("../orchestrator/firefly-agent", () => ({ FireflyAgent: class {} }));

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
