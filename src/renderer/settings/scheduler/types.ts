// 设置页使用的定时任务请求与状态类型。
type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;
type IntervalUnit = "minutes" | "hours";

export type ScheduleConfig =
  | { kind: "once"; runAt: string }
  | { kind: "daily"; timeOfDay: string }
  | { kind: "weekly"; dayOfWeek: Weekday; timeOfDay: string }
  | { kind: "interval"; every: number; unit: IntervalUnit };

export type SchedulerToolMode = "all-enabled" | "allow-list";

export interface ScheduledTask {
  id: string; title: string; prompt: string;
  enabled: boolean; schedule: ScheduleConfig;
  nextFireAt: string | null; lastFiredAt?: string;
  toolMode: SchedulerToolMode; allowedToolIds: string[];
  createdAt: string; updatedAt: string;
  // 插件任务的 enabled 已包含主进程授权结果。
  ownerPluginId?: string;
  // 未指定模式时沿用 work。
  mode?: string;
}

type HistoryStatus = "running" | "success" | "failed" | "skipped" | "interrupted";

export interface ScheduledTaskHistoryEntry {
  id: string; taskId: string; taskTitle: string;
  firedAt: string; finishedAt?: string; durationMs?: number;
  status: HistoryStatus; hostEpoch?: string;
  executionOutcome?: "unknown"; externalEffectsMayContinue?: boolean;
  recoveredAt?: string; reason?: string;
  outputPreview?: string; errorMessage?: string;
  effectiveToolIds: string[];
}

export interface SchedulerToolInfo {
  id: string; name: string;
  description: string; enabled: boolean; risk: string;
}

export interface SchedulerResult<T> {
  ok: boolean; value?: T;
  error?: string; reason?: string;
}

type Reply<T> = Promise<SchedulerResult<T>>;

export interface SchedulerApi {
  list: () => Reply<ScheduledTask[]>;
  add: (input: unknown) => Reply<ScheduledTask>;
  update: (id: string, patch: unknown) => Reply<ScheduledTask>;
  delete: (id: string) => Reply<boolean>;
  toggle: (id: string, enabled: boolean) => Reply<ScheduledTask>;
  fireNow: (id: string) => Reply<boolean>;
  getHistory: (
    taskId: string, limit?: number,
  ) => Reply<ScheduledTaskHistoryEntry[]>;
  getTools: () => Reply<SchedulerToolInfo[]>;
}
