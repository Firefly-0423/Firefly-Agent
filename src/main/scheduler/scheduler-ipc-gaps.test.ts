import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC } from "../../shared/ipc-channels";
import type { ToolDefinition } from "../orchestrator/tools/registry/tool-registry";
import { computeExecutionSpecFingerprint } from "./execution-spec";
import { projectTaskForRenderer, registerSchedulerIpc } from "./scheduler-ipc";
import type { ScheduledTask } from "./types";

type Handler = (...args: any[]) => any;

const handlers = new Map<string, Handler>();
const scope = {
  handle: vi.fn((channel: string, handler: Handler) => {
    handlers.set(channel, handler);
  }),
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
const engine = { fireNow: vi.fn() };
let tools: ToolDefinition[] = [];

registerSchedulerIpc(
  store as never,
  engine as never,
  () => tools,
  scope as never,
);

function invoke(channel: string, ...args: any[]): any {
  const handler = handlers.get(channel);
  expect(handler, channel).toBeDefined();
  return handler!(...args);
}

function userTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "task-1",
    title: "Task",
    prompt: "prompt",
    enabled: true,
    schedule: { kind: "daily", timeOfDay: "09:00" },
    nextFireAt: "2026-08-18T09:00:00.000Z",
    toolMode: "all-enabled",
    allowedToolIds: ["a"],
    createdAt: "2026-08-17T00:00:00.000Z",
    updatedAt: "2026-08-17T00:00:00.000Z",
    ...overrides,
  };
}

function pluginTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  const task = userTask({
    ownerPluginId: "plugin-1",
    pluginUserEnabled: true,
    enabled: false,
    mode: "work",
    ...overrides,
  });
  return {
    ...task,
    approvalFingerprint: computeExecutionSpecFingerprint({
      schedule: task.schedule,
      prompt: task.prompt,
      mode: task.mode ?? "work",
      allowedToolIds: task.allowedToolIds,
    }),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  tools = [];
  store.getTasks.mockReturnValue([]);
});

describe("projectTaskForRenderer", () => {
  it("strips host-only authorization fields from user tasks", () => {
    const projected = projectTaskForRenderer(
      userTask({ approvalFingerprint: "fingerprint", pluginUserEnabled: true }),
    );

    expect(projected).not.toHaveProperty("approvalFingerprint");
    expect(projected).not.toHaveProperty("pluginUserEnabled");
    expect(projected.enabled).toBe(true);
    expect(projected.id).toBe("task-1");
  });

  it("maps plugin task enabled state to effective authorization", () => {
    const task = pluginTask();
    expect(projectTaskForRenderer(task).enabled).toBe(true);

    expect(projectTaskForRenderer({ ...task, prompt: "changed" }).enabled).toBe(false);
    expect(projectTaskForRenderer({ ...task, pluginUserEnabled: false }).enabled).toBe(false);
    expect(projectTaskForRenderer({ ...task, approvalFingerprint: undefined }).enabled).toBe(false);
    expect(projectTaskForRenderer({ ...task, ownerPluginId: undefined }).enabled).toBe(
      task.enabled,
    );
  });
});

describe("scheduler list/add/update/delete/toggle handlers", () => {
  it("lists renderer projections and reports store failures", () => {
    const tasks = [userTask(), pluginTask()];
    store.getTasks.mockReturnValue(tasks);

    const result = invoke(IPC.SCHEDULER_LIST);
    expect(result.ok).toBe(true);
    expect(result.value).toHaveLength(2);
    expect(result.value[0]).not.toHaveProperty("approvalFingerprint");
    expect(result.value[1].enabled).toBe(true);

    store.getTasks.mockImplementation(() => {
      throw new Error("synthetic list failure");
    });
    expect(invoke(IPC.SCHEDULER_LIST)).toEqual({ ok: false, error: "synthetic list failure" });

    store.getTasks.mockImplementation(() => {
      throw "synthetic string failure";
    });
    expect(invoke(IPC.SCHEDULER_LIST)).toEqual({ ok: false, error: "synthetic string failure" });
  });

  it("adds a task through the store and reports failures", () => {
    const input = { title: "New", prompt: "p", schedule: { kind: "once", runAt: "2026-08-18T09:00:00Z" } };
    const created = userTask({ id: "created" });
    store.addTask.mockReturnValue(created);

    expect(invoke(IPC.SCHEDULER_ADD, null, input)).toEqual({ ok: true, value: created });
    expect(store.addTask).toHaveBeenCalledWith(input);

    store.addTask.mockImplementation(() => {
      throw new Error("synthetic add failure");
    });
    expect(invoke(IPC.SCHEDULER_ADD, null, input)).toEqual({
      ok: false,
      error: "synthetic add failure",
    });
  });

  it("updates user tasks with the supplied patch unchanged", () => {
    const task = userTask();
    const patch = { title: "Renamed", enabled: false };
    store.getTasks.mockReturnValue([task]);
    store.updateTask.mockReturnValue({ ...task, ...patch });

    const result = invoke(IPC.SCHEDULER_UPDATE, null, task.id, patch);

    expect(result.ok).toBe(true);
    expect(store.updateTask).toHaveBeenCalledWith(task.id, patch);
  });

  it("rebinds plugin task authorization from the merged saved specification", () => {
    const task = pluginTask();
    const patch = {
      prompt: "new prompt",
      allowedToolIds: ["b"],
      enabled: true,
      toolMode: "all-enabled" as const,
    };
    store.getTasks.mockReturnValue([task]);
    store.updateTask.mockReturnValue({ ...task, prompt: patch.prompt });

    invoke(IPC.SCHEDULER_UPDATE, null, task.id, patch);

    const [id, effective] = store.updateTask.mock.calls[0];
    expect(id).toBe(task.id);
    expect(effective).not.toHaveProperty("enabled");
    expect(effective).not.toHaveProperty("toolMode");
    expect(effective.pluginUserEnabled).toBe(true);
    expect(effective.approvalFingerprint).toBe(
      computeExecutionSpecFingerprint({
        schedule: task.schedule,
        prompt: "new prompt",
        mode: "work",
        allowedToolIds: ["b"],
      }),
    );
  });

  it("updates unknown task ids with the raw patch", () => {
    const patch = { title: "Renamed" };
    store.getTasks.mockReturnValue([]);

    invoke(IPC.SCHEDULER_UPDATE, null, "missing", patch);

    expect(store.updateTask).toHaveBeenCalledWith("missing", patch);
  });

  it("deletes tasks and reports store failures", () => {
    store.deleteTask.mockReturnValue(true);
    expect(invoke(IPC.SCHEDULER_DELETE, null, "task-1")).toEqual({ ok: true, value: true });
    expect(store.deleteTask).toHaveBeenCalledWith("task-1");

    store.deleteTask.mockImplementation(() => {
      throw new Error("synthetic delete failure");
    });
    expect(invoke(IPC.SCHEDULER_DELETE, null, "task-1")).toEqual({
      ok: false,
      error: "synthetic delete failure",
    });
  });

  it("toggles user tasks by writing enabled directly", () => {
    const task = userTask();
    store.getTasks.mockReturnValue([task]);
    store.updateTask.mockReturnValue({ ...task, enabled: false });

    expect(invoke(IPC.SCHEDULER_TOGGLE, null, task.id, false)).toEqual({
      ok: true,
      value: { ...task, enabled: false },
    });
    expect(store.updateTask).toHaveBeenCalledWith(task.id, { enabled: false });
  });

  it("toggles plugin tasks through the authorization fingerprint", () => {
    const task = pluginTask();
    store.getTasks.mockReturnValue([task]);

    invoke(IPC.SCHEDULER_TOGGLE, null, task.id, true);
    expect(store.updateTask).toHaveBeenLastCalledWith(task.id, {
      pluginUserEnabled: true,
      approvalFingerprint: computeExecutionSpecFingerprint({
        schedule: task.schedule,
        prompt: task.prompt,
        mode: "work",
        allowedToolIds: task.allowedToolIds,
      }),
    });

    invoke(IPC.SCHEDULER_TOGGLE, null, task.id, false);
    expect(store.updateTask).toHaveBeenLastCalledWith(task.id, { pluginUserEnabled: false });
  });

  it("toggles unknown task ids as ordinary tasks", () => {
    store.getTasks.mockReturnValue([]);
    invoke(IPC.SCHEDULER_TOGGLE, null, "missing", true);
    expect(store.updateTask).toHaveBeenCalledWith("missing", { enabled: true });
  });
});

describe("scheduler history/fire/tools handlers", () => {
  it("passes the task id and optional limit to history", () => {
    store.getHistory.mockReturnValue([{ id: "history" }]);
    expect(invoke(IPC.SCHEDULER_GET_HISTORY, null, "task-1", 5)).toEqual({
      ok: true,
      value: [{ id: "history" }],
    });
    expect(store.getHistory).toHaveBeenCalledWith("task-1", 5);

    invoke(IPC.SCHEDULER_GET_HISTORY, null, "task-1");
    expect(store.getHistory).toHaveBeenLastCalledWith("task-1", undefined);
  });

  it("reports history failures", () => {
    store.getHistory.mockImplementation(() => {
      throw new Error("synthetic history failure");
    });
    expect(invoke(IPC.SCHEDULER_GET_HISTORY, null, "task-1")).toEqual({
      ok: false,
      error: "synthetic history failure",
    });
  });

  it("maps fireNow success, refusal and thrown failures", async () => {
    engine.fireNow.mockResolvedValue({ ok: true });
    await expect(invoke(IPC.SCHEDULER_FIRE_NOW, null, "task-1")).resolves.toEqual({
      ok: true,
      value: true,
    });

    engine.fireNow.mockResolvedValue({ ok: false, reason: "scheduler busy" });
    await expect(invoke(IPC.SCHEDULER_FIRE_NOW, null, "task-1")).resolves.toEqual({
      ok: false,
      reason: "scheduler busy",
    });

    engine.fireNow.mockRejectedValue(new Error("synthetic fire failure"));
    await expect(invoke(IPC.SCHEDULER_FIRE_NOW, null, "task-1")).resolves.toEqual({
      ok: false,
      error: "synthetic fire failure",
    });
  });

  it("maps tools to the renderer view and defaults missing risk to safe", () => {
    tools = [
      {
        id: "one",
        name: "One",
        description: "first",
        enabled: true,
        inputSchema: { type: "object", properties: {} },
        execute: vi.fn(),
      },
      {
        id: "two",
        name: "Two",
        description: "second",
        enabled: false,
        risk: "input-control",
        inputSchema: { type: "object", properties: {} },
        execute: vi.fn(),
      },
    ];

    expect(invoke(IPC.SCHEDULER_GET_TOOLS)).toEqual({
      ok: true,
      value: [
        { id: "one", name: "One", description: "first", enabled: true, risk: "safe" },
        { id: "two", name: "Two", description: "second", enabled: false, risk: "input-control" },
      ],
    });
  });

  it("registers only once", () => {
    const second = {
      handle: vi.fn(),
      on: vi.fn(),
      removeHandler: vi.fn(),
      dispose: vi.fn(),
    };
    registerSchedulerIpc(store as never, engine as never, () => [], second as never);
    expect(second.handle).not.toHaveBeenCalled();
  });
});
