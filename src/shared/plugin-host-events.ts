/** Host-internal lifecycle event and scheduling contracts (transport-neutral, no Node/Electron imports). */

export type PluginPromptMode = "chat" | "work" | "code";
export type PluginTurnStatus = "success" | "cancelled" | "timeout" | "runtime_error";
export type PluginToolRisk = "safe" | "fs-read" | "fs-write" | "shell" | "network" | "input-control";
export type PluginToolStatus = "success" | "failure" | "unknown" | "not_executed";
export type PluginPromptSource = "conversation" | "scheduler" | "plugin-agent";

export interface PluginHostEventBase {
  eventId: string;
  timestamp: string;
}

export interface PluginToolFinishedEvent extends PluginHostEventBase {
  runId: string;
  toolId: string;
  toolCallId: string;
  status: PluginToolStatus;
  risk: PluginToolRisk;
  durationMs?: number;
}

export interface PluginTurnCompletedEvent {
  source: "desktop" | "channel";
  mode: PluginPromptMode;
  conversationId: string;
  channel?: string;
  runId?: string;
}

interface PluginTurnEventBase extends PluginHostEventBase {
  runId: string;
  mode: PluginPromptMode;
}

type DesktopTurnOrigin = {
  source: "desktop";
  conversationId: string;
  inputMessageId: string;
};

type ChannelTurnOrigin = {
  source: "channel";
  channel: string;
  conversationId?: string;
};

type SchedulerTurnOrigin = {
  source: "scheduler";
  taskId: string;
  schedulerRunId: string;
};

export type PluginTurnStartedEvent = PluginTurnEventBase &
  (DesktopTurnOrigin | ChannelTurnOrigin | SchedulerTurnOrigin);

interface PluginTurnFinishedBase extends PluginTurnEventBase {
  status: PluginTurnStatus;
  durationMs?: number;
}

export type PluginTurnFinishedEvent = PluginTurnFinishedBase &
  (
    | (DesktopTurnOrigin & { finalMessageId?: string })
    | ChannelTurnOrigin
    | SchedulerTurnOrigin
  );

export interface PluginSchedulerFinishedEvent extends PluginHostEventBase {
  taskId: string;
  schedulerRunId: string;
  status: PluginTurnStatus;
  durationMs?: number;
}

export type PluginScheduleConfig =
  | { kind: "cron"; expression: string; timezone?: string }
  | { kind: "interval"; every: number; unit: "minutes" | "hours" }
  | { kind: "weekly"; dayOfWeek: 0 | 1 | 2 | 3 | 4 | 5 | 6; timeOfDay: string }
  | { kind: "daily"; timeOfDay: string }
  | { kind: "once"; runAt: string };

export interface PluginScheduledExecutionSpec {
  schedule: PluginScheduleConfig;
  prompt: string;
  mode: PluginPromptMode;
  allowedToolIds: string[];
}

interface PluginPromptBuildInputCommon {
  userText: string;
  conversationId?: string;
  channel?: string;
  mode: PluginPromptMode;
}

export type PluginPromptBuildInput =
  | (PluginPromptBuildInputCommon & { source: "conversation" })
  | (PluginPromptBuildInputCommon & { source: "scheduler" })
  | (PluginPromptBuildInputCommon & { source: "plugin-agent" });
