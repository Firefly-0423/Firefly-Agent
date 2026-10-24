import { IPC } from "../../shared/ipc-channels";
import { createIpcScope, type IpcScope } from "../application/ipc-scope";
import type { ToolDefinition } from "../orchestrator/tools/registry/tool-registry";
import * as executionSpec from "./execution-spec";
import type { SchedulerEngine } from "./scheduler-engine";
import type { NewScheduledTaskInput, ScheduledTask, ScheduledTaskPatch, SchedulerIpcResult } from "./types";

type SchedulerStoreLike = {
  getHistory(taskId: string, limit?: number): unknown[];
  getTasks(): ScheduledTask[];
  addTask(input: NewScheduledTaskInput): unknown;
  updateTask(id: string, patch: ScheduledTaskPatch): unknown;
  toggleTask(id: string, enabled: boolean): unknown;
  deleteTask(id: string): boolean;
};

export type SchedulerToolInfo = {
  id: string;
  name: string;
  description: string;
  risk: string;
  enabled: boolean;
};

/** 给渲染层看的任务视图，去掉授权指纹和用户授权位这类宿主内部字段 */
export type RendererScheduledTask = Omit<ScheduledTask, "approvalFingerprint" | "pluginUserEnabled">;

/**
 * 渲染层投影。插件任务的 enabled 显示为有效授权状态，
 * 与引擎判断是否运行时采用同一口径。
 */
export function projectTaskForRenderer(task: ScheduledTask): RendererScheduledTask {
  const { approvalFingerprint: _fingerprint, pluginUserEnabled: _userEnabled, ...visible } = task;
  if (!task.ownerPluginId) return visible;
  return { ...visible, enabled: executionSpec.isPluginTaskEffectivelyEnabled(task) };
}

let registered = false;

function describeTool(tool: ToolDefinition): SchedulerToolInfo {
  return {
    id: tool.id,
    name: tool.name,
    description: tool.description,
    enabled: tool.enabled,
    risk: tool.risk ?? "safe",
  };
}

function succeed<T>(value: T): SchedulerIpcResult<T> {
  return { ok: true, value };
}

function failure(err: unknown): SchedulerIpcResult {
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

/** 注册调度相关 IPC；整个进程只注册一次，重复调用直接返回 */
export function registerSchedulerIpc(
  store: SchedulerStoreLike,
  engine: SchedulerEngine,
  getTools: () => ToolDefinition[],
  ipcOption?: IpcScope,
): void {
  if (registered) return;
  registered = true;
  const ipc = ipcOption ?? createIpcScope();

  ipc.handle(IPC.SCHEDULER_LIST, () => {
    try {
      return succeed(store.getTasks().map(projectTaskForRenderer));
    } catch (err) {
      return failure(err);
    }
  });

  ipc.handle(IPC.SCHEDULER_ADD, (_event, input: NewScheduledTaskInput) => {
    try {
      return succeed(store.addTask(input));
    } catch (err) {
      return failure(err);
    }
  });

  ipc.handle(IPC.SCHEDULER_UPDATE, (_event, id: string, patch: ScheduledTaskPatch) => {
    try {
      const current = store.getTasks().find((t) => t.id === id);
      // 插件任务保存时按新规格重算授权指纹，并剔除宿主固定的字段
      const effective = current?.ownerPluginId ? executionSpec.authorizePluginTaskUpdatePatch(current, patch) : patch;
      return succeed(store.updateTask(id, effective));
    } catch (err) {
      return failure(err);
    }
  });

  ipc.handle(IPC.SCHEDULER_DELETE, (_event, id: string) => {
    try {
      return succeed(store.deleteTask(id));
    } catch (err) {
      return failure(err);
    }
  });

  ipc.handle(IPC.SCHEDULER_TOGGLE, (_event, id: string, enabled: boolean) => {
    try {
      const task = store.getTasks().find((t) => t.id === id);
      // 用户任务直接改 enabled，插件任务改授权位并按当前规格写指纹
      const patch = task?.ownerPluginId ? executionSpec.pluginTaskTogglePatch(task, enabled) : { enabled };
      return succeed(store.updateTask(id, patch));
    } catch (err) {
      return failure(err);
    }
  });

  ipc.handle(IPC.SCHEDULER_GET_HISTORY, (_event, taskId: string, limit?: number) => {
    try {
      return succeed(store.getHistory(taskId, limit));
    } catch (err) {
      return failure(err);
    }
  });

  ipc.handle(IPC.SCHEDULER_FIRE_NOW, async (_event, id: string) => {
    try {
      const outcome = await engine.fireNow(id);
      if (!outcome.ok) return { ok: false, reason: outcome.reason };
      return succeed(true);
    } catch (err) {
      return failure(err);
    }
  });

  ipc.handle(IPC.SCHEDULER_GET_TOOLS, () => succeed(getTools().map(describeTool)));
}
