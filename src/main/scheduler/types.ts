import type { PluginPromptMode } from "../../plugins/api";

export type ScheduleConfig =
  | { runAt: string; kind: "once" }
  | { timeOfDay: string; kind: "daily" }
  | { timeOfDay: string; dayOfWeek: 0 | 1 | 2 | 3 | 4 | 5 | 6; kind: "weekly" }
  | { unit: "minutes" | "hours"; every: number; kind: "interval" };
export type ScheduleKind = ScheduleConfig["kind"];
export type SchedulerToolMode = "all-enabled" | "allow-list";

type ExecutionFields = {
  approvalFingerprint?: string;
  pluginUserEnabled?: boolean;
  mode?: PluginPromptMode;
  schedule: ScheduleConfig;
  prompt: string;
  title: string;
};
export type ScheduledTask = ExecutionFields & {
  ownerPluginId?: string;
  updatedAt: string;
  createdAt: string;
  allowedToolIds: string[];
  toolMode: SchedulerToolMode;
  lastFiredAt?: string;
  nextFireAt: string | null;
  enabled: boolean;
  id: string;
};
export type NewScheduledTaskInput = ExecutionFields & {
  ownerPluginId?: string;
  allowedToolIds?: string[];
  toolMode?: SchedulerToolMode;
  enabled?: boolean;
};
export type ScheduledTaskPatch = Partial<ExecutionFields & {
  allowedToolIds: string[];
  toolMode: SchedulerToolMode;
  lastFiredAt: string;
  nextFireAt: string | null;
  enabled: boolean;
}>;
export type ScheduledTaskHistoryEntry = {
  recoveredAt?: string;
  hostEpoch?: string;
  externalEffectsMayContinue?: boolean;
  executionOutcome?: "unknown";
  errorMessage?: string;
  outputPreview?: string;
  reason?: string;
  durationMs?: number;
  finishedAt?: string;
  effectiveToolIds: string[];
  status: "running" | "success" | "failed" | "skipped" | "interrupted";
  firedAt: string;
  taskTitle: string;
  taskId: string;
  id: string;
};
export type ScheduledRunResult = {
  error?: string;
  reply?: string;
  effectiveToolIds: string[];
  historyId: string;
  ok: boolean;
};
export type SchedulerIpcResult<T = unknown> = { reason?: string; error?: string; value?: T; ok: boolean };
