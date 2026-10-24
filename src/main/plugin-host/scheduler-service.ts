import type {
  PluginPromptMode,
  PluginScheduledExecutionSpec,
  PluginScheduledTask,
  PluginScheduledTaskHistory,
  PluginScheduledTaskInput,
  PluginScheduledTaskPatch,
  PluginSchedulerService,
} from "../../plugins/api";
import {
  computeExecutionSpecFingerprint,
  isPluginTaskEffectivelyEnabled,
  taskExecutionSpec,
} from "../scheduler/execution-spec";
import { validateSchedule } from "../scheduler/scheduler-store";
import type {
  NewScheduledTaskInput,
  ScheduledTask,
  ScheduledTaskHistoryEntry,
  ScheduledTaskPatch,
} from "../scheduler/types";
import { pluginHostError } from "./errors";

/** 调度存储的只读视图：真实实现是 scheduler-store，测试注入内存假件。 */
export interface PluginSchedulerStore {
  getTasks(): ScheduledTask[];
  addTask(input: NewScheduledTaskInput): ScheduledTask;
  updateTask(id: string, patch: ScheduledTaskPatch): ScheduledTask;
  deleteTask(id: string): boolean;
  getHistory(taskId: string, limit?: number): ScheduledTaskHistoryEntry[];
}

export interface PluginSchedulerServiceOptions {
  pluginId: string;
  store: PluginSchedulerStore;
  /** 插件停止信号；触发后每次调用都以 E_PLUGIN_STOPPING 失败。 */
  signal?: AbortSignal;
  /** 当前时间，测试可注入固定值；缺省为真实时间。 */
  now?: () => Date;
}

const ALLOWED_MODES: readonly PluginPromptMode[] = ["chat", "work", "code"];
const HISTORY_DEFAULT_LIMIT = 10;
const HISTORY_MAX_LIMIT = 100;

/**
 * 插件调度服务。插件只能操作自己创建的任务；新建的任务一律以停用状态落盘，
 * 必须经用户在宿主界面确认后才会运行。改动执行规格（计划、提示词、模式、
 * 工具白名单）会撤销已有授权；只改标题不会。
 */
export function createPluginSchedulerService(options: PluginSchedulerServiceOptions): PluginSchedulerService {
  const { pluginId, store, signal } = options;
  const clock = options.now ?? (() => new Date());
  const logPrefix = `plugin:${pluginId}:scheduler`;

  function ensureRunning(): void {
    if (signal?.aborted) {
      throw pluginHostError("E_PLUGIN_STOPPING", `插件 ${pluginId} 已停止，调度服务不可用`);
    }
  }

  function ensureMode(mode: unknown): void {
    if (!ALLOWED_MODES.includes(mode as PluginPromptMode)) {
      throw pluginHostError("E_INVALID_ARGUMENT", `非法会话模式: ${String(mode)}`);
    }
  }

  function ensureToolIdList(toolIds: unknown): void {
    if (!Array.isArray(toolIds) || toolIds.some((item) => typeof item !== "string")) {
      throw pluginHostError("E_INVALID_ARGUMENT", "工具白名单必须是字符串数组");
    }
  }

  function ensureSchedule(schedule: unknown): void {
    try {
      validateSchedule(schedule as Parameters<typeof validateSchedule>[0]);
    } catch (failure) {
      throw pluginHostError("E_INVALID_ARGUMENT", (failure as Error).message);
    }
  }

  /**
   * 校验一份完整的执行规格。一次性任务的时间只在本次新提交计划时检查，
   * 因为更新元数据时保留的旧计划可能已经过期，不应阻止改标题。
   */
  function ensureSpec(spec: PluginScheduledExecutionSpec, isNewPlan: boolean): void {
    if (typeof spec.prompt !== "string" || spec.prompt.trim().length === 0) {
      throw pluginHostError("E_INVALID_ARGUMENT", "提示词不能为空");
    }
    ensureSchedule(spec.schedule);
    ensureMode(spec.mode);
    ensureToolIdList(spec.allowedToolIds);
    if (isNewPlan && spec.schedule.kind === "once"
      && new Date(spec.schedule.runAt).getTime() <= clock().getTime()) {
      throw pluginHostError("E_INVALID_ARGUMENT", "一次性任务时间必须晚于当前时间");
    }
  }

  function ensureId(id: unknown): void {
    if (!id || typeof id !== "string") {
      throw pluginHostError("E_INVALID_ARGUMENT", `非法任务 id: ${String(id)}`);
    }
  }

  /** 返回本插件拥有的任务；不存在或不归属本插件时分别抛出 E_NOT_FOUND / E_NOT_OWNER。 */
  function requireOwnedTask(id: string): ScheduledTask {
    const found = store.getTasks().find((task) => task.id === id);
    if (found === undefined) {
      throw pluginHostError("E_NOT_FOUND", `任务不存在: ${id}`);
    }
    // 非本插件的任务一律拒绝，不区分归属于其他插件还是用户，防止探测。
    if (found.ownerPluginId !== pluginId) {
      throw pluginHostError("E_NOT_OWNER", `任务不属于插件 ${pluginId}: ${id}`);
    }
    return found;
  }

  function toPluginTask(task: ScheduledTask): PluginScheduledTask {
    const view: PluginScheduledTask = {
      id: task.id,
      title: task.title,
      schedule: task.schedule,
      prompt: task.prompt,
      mode: task.mode ?? "work",
      allowedToolIds: [...task.allowedToolIds],
      enabled: isPluginTaskEffectivelyEnabled(task),
      nextFireAt: task.nextFireAt,
      ...(task.lastFiredAt ? { lastFiredAt: task.lastFiredAt } : {}),
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    };
    return view;
  }

  function toHistoryView(entry: ScheduledTaskHistoryEntry): PluginScheduledTaskHistory {
    const view: PluginScheduledTaskHistory = {
      id: entry.id,
      taskId: entry.taskId,
      status: entry.status,
      startedAt: entry.firedAt,
      ...(entry.finishedAt ? { finishedAt: entry.finishedAt } : {}),
      ...(entry.outputPreview ? { summary: entry.outputPreview } : {}),
    };
    return view;
  }

  return {
    async createTask(input) {
      ensureRunning();
      if (!input || typeof input.title !== "string" || input.title.trim().length === 0) {
        throw pluginHostError("E_INVALID_ARGUMENT", "标题不能为空");
      }
      ensureSpec(input, true);
      let created: ScheduledTask;
      try {
        // 宿主内部字段不取自插件输入，这里固定写入。
        created = store.addTask({
          title: input.title.trim(),
          prompt: input.prompt.trim(),
          enabled: false,
          schedule: input.schedule,
          toolMode: "allow-list",
          allowedToolIds: input.allowedToolIds,
          ownerPluginId: pluginId,
          pluginUserEnabled: false,
          approvalFingerprint: "",
          mode: input.mode,
        });
      } catch (failure) {
        throw pluginHostError("E_INTERNAL", "创建调度任务失败", { cause: failure, logPrefix });
      }
      return toPluginTask(created);
    },

    async listTasks() {
      ensureRunning();
      return store
        .getTasks()
        .filter((task) => task.ownerPluginId === pluginId)
        .map(toPluginTask);
    },

    async updateTask(id, patch: PluginScheduledTaskPatch) {
      ensureRunning();
      ensureId(id);
      const existing = requireOwnedTask(id);

      // 先合并出更新后的完整规格，再据此判断规格是否真的变化。
      const merged: PluginScheduledExecutionSpec = {
        schedule: patch.schedule ?? existing.schedule,
        prompt: patch.prompt !== undefined ? patch.prompt.trim() : existing.prompt,
        mode: patch.mode ?? existing.mode ?? "work",
        allowedToolIds: patch.allowedToolIds ?? existing.allowedToolIds,
      };
      if (patch.title !== undefined && (typeof patch.title !== "string" || patch.title.trim().length === 0)) {
        throw pluginHostError("E_INVALID_ARGUMENT", "标题不能为空");
      }
      ensureSpec(merged, patch.schedule !== undefined);

      const specDiffers = computeExecutionSpecFingerprint(taskExecutionSpec(existing))
        !== computeExecutionSpecFingerprint(merged);

      // 只转发插件可写的字段。即便 patch 中混入了 enabled、approvalFingerprint
      // 等宿主字段，也会在这里被丢弃。
      const write: ScheduledTaskPatch = {};
      if (patch.title !== undefined) write.title = patch.title.trim();
      if (patch.schedule !== undefined) write.schedule = patch.schedule;
      if (patch.prompt !== undefined) write.prompt = patch.prompt.trim();
      if (patch.mode !== undefined) write.mode = patch.mode;
      if (patch.allowedToolIds !== undefined) write.allowedToolIds = patch.allowedToolIds;
      if (specDiffers) {
        // 规格已变：收回用户授权并清空指纹，等待用户重新确认。
        write.pluginUserEnabled = false;
        write.approvalFingerprint = "";
      }

      let saved: ScheduledTask;
      try {
        saved = store.updateTask(id, write);
      } catch (failure) {
        throw pluginHostError("E_INTERNAL", "更新调度任务失败", { cause: failure, logPrefix });
      }
      return toPluginTask(saved);
    },

    async deleteTask(id) {
      ensureRunning();
      ensureId(id);
      requireOwnedTask(id);
      try {
        return store.deleteTask(id);
      } catch (failure) {
        throw pluginHostError("E_INTERNAL", "删除调度任务失败", { cause: failure, logPrefix });
      }
    },

    async getHistory(id, limit) {
      ensureRunning();
      ensureId(id);
      const size = limit ?? HISTORY_DEFAULT_LIMIT;
      if (!Number.isInteger(size) || size < 1 || size > HISTORY_MAX_LIMIT) {
        throw pluginHostError("E_INVALID_ARGUMENT", `非法历史条数: ${String(limit)}（1-${HISTORY_MAX_LIMIT}）`);
      }
      requireOwnedTask(id);
      return store.getHistory(id, size).map(toHistoryView);
    },
  };
}
