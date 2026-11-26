import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC } from "../../../shared/ipc-channels";
import { UnattendedApprovalUnsupportedError } from "../../../plugins/v2/schedules";
import { computeExecutionSpecFingerprint } from "./execution-spec";
import { registerSchedulerIpc } from "./scheduler-ipc";
import type { ScheduledTask } from "../../platform/schedule/schedule-types";

type Handler = (...args: any[]) => any;
const handlers = new Map<string, Handler>();
const scope = {
  handle: vi.fn((channel: string, handler: Handler) => { handlers.set(channel, handler); }),
  on: vi.fn(),
  removeHandler: vi.fn(),
  dispose: vi.fn(),
};
const store = {
  getTasks: vi.fn(),
  addTask: vi.fn(),
  updateTask: vi.fn(),
  deleteTask: vi.fn(),
  toggleTask: vi.fn(),
  getHistory: vi.fn(),
};
const guard = vi.fn();

registerSchedulerIpc(store as never, { fireNow: vi.fn() } as never, () => [], scope as never, guard);

function pluginTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  const task: ScheduledTask = {
    id: "task-1",
    title: "Plugin task",
    prompt: "prompt",
    enabled: false,
    schedule: { kind: "daily", timeOfDay: "09:00" },
    nextFireAt: "2026-08-18T09:00:00.000Z",
    toolMode: "allow-list",
    allowedToolIds: ["reader"],
    createdAt: "2026-08-17T00:00:00.000Z",
    updatedAt: "2026-08-17T00:00:00.000Z",
    ownerPluginId: "plugin-1",
    pluginUserEnabled: true,
    mode: "work",
    ...overrides,
  };
  return {
    ...task,
    approvalFingerprint: computeExecutionSpecFingerprint({
      schedule: task.schedule, prompt: task.prompt, mode: task.mode ?? "work", allowedToolIds: task.allowedToolIds,
    }),
  };
}

const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args);
const refuse = () => { throw new UnattendedApprovalUnsupportedError(["shell"]); };

beforeEach(() => {
  guard.mockReset();
  store.updateTask.mockReset();
  store.getTasks.mockReset();
});

describe("scheduler IPC unattended-approval guard for plugin tasks", () => {
  it("re-enabling a plugin task the guard refuses writes nothing and returns the stable reason", () => {
    store.getTasks.mockReturnValue([pluginTask({ pluginUserEnabled: false })]);
    guard.mockImplementation(refuse);

    const result = invoke(IPC.SCHEDULER_TOGGLE, "task-1", true);

    expect(result).toEqual({ ok: false, error: expect.stringContaining("can't approve unattended runs"), reason: "unattended_approval_unsupported" });
    expect(store.updateTask).not.toHaveBeenCalled();
  });

  it("pausing a plugin task is never guarded", () => {
    store.getTasks.mockReturnValue([pluginTask()]);
    guard.mockImplementation(refuse);
    store.updateTask.mockReturnValue({});

    expect(invoke(IPC.SCHEDULER_TOGGLE, "task-1", false)).toMatchObject({ ok: true });
    expect(guard).not.toHaveBeenCalled();
    expect(store.updateTask).toHaveBeenCalledWith("task-1", { pluginUserEnabled: false });
  });

  it("editing an enabled plugin task checks the task as it would be saved and writes nothing when refused", () => {
    store.getTasks.mockReturnValue([pluginTask()]);
    guard.mockImplementation(refuse);

    const result = invoke(IPC.SCHEDULER_UPDATE, "task-1", { allowedToolIds: ["danger"] });

    expect(guard).toHaveBeenCalledWith(expect.objectContaining({ id: "task-1", allowedToolIds: ["danger"], pluginUserEnabled: true }));
    expect(result).toMatchObject({ ok: false, reason: "unattended_approval_unsupported" });
    expect(store.updateTask).not.toHaveBeenCalled();
  });

  it("editing a paused plugin task that stays paused is not guarded", () => {
    store.getTasks.mockReturnValue([pluginTask({ pluginUserEnabled: false })]);
    guard.mockImplementation(refuse);
    store.updateTask.mockReturnValue({});

    expect(invoke(IPC.SCHEDULER_UPDATE, "task-1", { title: "Renamed" })).toMatchObject({ ok: true });
    expect(guard).not.toHaveBeenCalled();
  });

  it("a guard that accepts lets the toggle through", () => {
    store.getTasks.mockReturnValue([pluginTask({ pluginUserEnabled: false })]);
    store.updateTask.mockReturnValue({});

    expect(invoke(IPC.SCHEDULER_TOGGLE, "task-1", true)).toMatchObject({ ok: true });
    expect(guard).toHaveBeenCalledTimes(1);
    expect(store.updateTask).toHaveBeenCalledTimes(1);
  });
});
