// 设置页使用的定时任务请求与状态类型。
type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;
type IntervalUnit = "minutes" | "hours";

export type ScheduleConfig =
  | { kind: "cron"; expression: string; timezone?: string }
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
  /** Stable PluginError code (e.g. ERR_REJECTED) on plugin proposal failures. */
  code?: string;
}

/** A plugin-proposed schedule in the plugin protocol's format, waiting for the user's decision. */
export type PluginProposalSchedule =
  | { kind: "cron"; expression: string; timezone?: string }
  | { kind: "once"; at: number }
  | { kind: "interval"; minutes: number };

export type PluginProposalAction =
  | { type: "run"; prompt: string; mode: string }
  | { type: "callback"; payload?: unknown };

export interface PluginProposal {
  proposalId: string;
  /** Fingerprint of the spec shown; sent back on confirm so an edit after review is not approved unseen. */
  revision: string;
  taskId: string; pluginId: string;
  /** Plugin display name; the plugin id when the name is unknown. */
  pluginName: string;
  kind: "create" | "update";
  title: string; schedule: PluginProposalSchedule; action: PluginProposalAction;
  allowedToolIds: string[]; createdAt: string;
  /** Present for an update whose target task still exists. */
  current?: {
    title: string; schedule: PluginProposalSchedule; action: PluginProposalAction; allowedToolIds: string[];
  };
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
  listPluginProposals?: () => Reply<PluginProposal[]>;
  confirmPluginProposal?: (taskId: string, revision: string) => Reply<boolean>;
  rejectPluginProposal?: (taskId: string) => Reply<boolean>;
}
