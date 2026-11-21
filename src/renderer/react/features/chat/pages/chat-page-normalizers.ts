import type { ChatMessage, ChatMessageChannelSource, ChatSession, ConversationMode } from "../../../../../shared/chat-types";
import { describePermissionRequest, type AgentRunStage, type ComposerInteraction } from "../components/run-presentation";
import type { ChatMessageItem } from "../components/ChatMessageList";
import type { WeatherData } from "../components/weather/weather-types";
import type { PermissionApprovalRequest } from "./chat-page-bridge";
import { isRunStatusCandidate } from "./session-run-status";
import { recoverInterruptedMessage } from "./session-runtime-state";
import { t } from "../../../i18n";
import type { RunStatusItem } from "../../../../../shared/run-status";
import { resolveRunFinishedStage } from "../../../../../shared/run-display";

export const LAST_MODE_STORAGE_KEY = "firefly-react-last-mode";
const modes: readonly ConversationMode[] = ["chat", "work", "code"];
const supportedChannels = new Set<ChatMessageChannelSource["channel"]>(["wechat", "feishu", "qq", "qqbot"]);

export function isConversationMode(value: string): value is ConversationMode {
  return modes.includes(value as ConversationMode);
}
function asRecord(raw: unknown): Record<string, unknown> | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  return raw as Record<string, unknown>;
}
function asNonEmptyString(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  return raw.trim() ? raw.trim() : undefined;
}
function normalizeChannelSource(raw: unknown): ChatMessageChannelSource | undefined {
  const fields = asRecord(raw);
  if (!fields || typeof fields.channel !== "string" || !supportedChannels.has(fields.channel as ChatMessageChannelSource["channel"])) return undefined;
  const display = asNonEmptyString(fields.senderName);
  const chatKind = fields.chatType === "private" || fields.chatType === "group" ? fields.chatType : undefined;
  return {
    channel: fields.channel as ChatMessageChannelSource["channel"],
    ...(chatKind ? { chatType: chatKind } : {}), ...(display ? { senderName: display } : {}),
  };
}

export function parseSessionRunActiveError(message: string): string | undefined {
  const marker = "SESSION_RUN_ACTIVE:";
  if (!message.startsWith(marker)) return undefined;
  return message.slice(marker.length) || undefined;
}

export function normalizeWeatherData(value: unknown): WeatherData | undefined {
  const fields = asRecord(value);
  if (!fields) return undefined;
  const provider = asNonEmptyString(fields.source);
  const place = asRecord(fields.location);
  const region = asNonEmptyString(place?.province);
  const cityName = asNonEmptyString(place?.city);
  const degrees = typeof fields.temp === "number" ? fields.temp : undefined;
  const moisture = typeof fields.humidity === "number" ? fields.humidity : undefined;
  if (!provider || !region || !cityName || degrees === undefined || moisture === undefined) return undefined;
  if (provider === "open-meteo") {
    const condition = typeof fields.weatherCode === "number" ? fields.weatherCode : undefined;
    const direction = typeof fields.windDeg === "number" ? fields.windDeg : undefined;
    const speed = typeof fields.windSpeed === "number" ? fields.windSpeed : undefined;
    if (condition === undefined || direction === undefined || speed === undefined) return undefined;
    return {
      source: "open-meteo", location: { province: region, city: cityName }, weatherCode: condition,
      temp: degrees, feelsLike: typeof fields.feelsLike === "number" ? fields.feelsLike : degrees,
      humidity: moisture, windDeg: direction, windSpeed: speed,
      precipitation: typeof fields.precipitation === "number" ? fields.precipitation : 0,
      pressure: typeof fields.pressure === "number" ? fields.pressure : 0,
    };
  }
  if (provider === "amap") {
    const description = asNonEmptyString(fields.weather);
    const direction = asNonEmptyString(fields.windDirection);
    const strength = asNonEmptyString(fields.windPower);
    const reported = asNonEmptyString(fields.reporttime);
    if (!description || !direction || !strength || !reported) return undefined;
    return {
      source: "amap", location: { province: region, city: cityName }, weather: description,
      temp: degrees, humidity: moisture, windDirection: direction, windPower: strength, reporttime: reported,
    };
  }
  return undefined;
}

export function permissionInteraction(request: PermissionApprovalRequest): ComposerInteraction {
  const path = [request.args.path, request.args.filePath].find((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0);
  return {
    kind: "permission", id: request.id, toolName: request.toolName || request.toolId,
    summary: describePermissionRequest(request), targetPath: path,
    ...(request.agentId ? { agentId: request.agentId } : {}),
    ...(request.toolCallId ? { toolCallId: request.toolCallId } : {}),
    ...(request.childRunId ? { childRunId: request.childRunId } : {}),
  };
}

export function stageForStep(stepName: string | undefined): AgentRunStage | undefined {
  switch (stepName) {
    case "agent-graph-action-gate": return { kind: "understanding" };
    case "agent-graph-plan": return { kind: "planning" };
    case "agent-graph-soul": return { kind: "responding" };
  }
  const toolPrefix = "agent-graph-tool-";
  return stepName?.startsWith(toolPrefix) ? { kind: "executing", detail: stepName.slice(toolPrefix.length) } : undefined;
}

export function toUiMessages(session: ChatSession, statuses?: readonly RunStatusItem[]): ChatMessageItem[] {
  return session.messages.map((original) => {
    const status = original.role === "model" ? statuses?.find(item => item.assistantTurnId === original.id
      && (item.phase === "unavailable" || item.sessionId === session.id
        && (!original.runSnapshot?.runId || original.runSnapshot.runId === item.runId))) : undefined;
    const stored = status?.phase === "finished" && status.message.id === original.id && status.message.role === "model"
      ? { ...original, ...status.message } : original;
    const view: ChatMessageItem = {
      id: stored.id, role: stored.role === "model" ? "assistant" : "user", content: stored.content,
      modelContext: stored.modelContext, channelSource: normalizeChannelSource(stored.channelSource),
      reasoning: stored.reasoning, reasoningBlocks: stored.reasoningBlocks, processMessages: stored.processMessages,
      agentRounds: stored.agentRounds, taskDelegations: stored.taskDelegations, runActivity: stored.runActivity,
      ttsCacheKey: stored.ttsCacheKey, ttsCacheVersion: stored.ttsCacheVersion,
      responseStarted: stored.role === "model" && Boolean(stored.content.trim() || stored.sticker),
      sticker: stored.sticker, toolExecutions: stored.toolExecutions, attachments: stored.attachments,
      contextUsage: stored.contextUsage, workReadReport: stored.workReadReport, runId: stored.runSnapshot?.runId,
      ...(stored.role === "user" && stored.runInsertion && { runInsertion: stored.runInsertion }),
    };
    if (status?.phase === "running" || status?.phase === "settling") return {
      ...view, runId: status.runId, loading: true, streaming: false, reasoningStreaming: false,
      runStage: { kind: "executing", detail: t(status.phase === "settling" ? "runPresentation.observedSettling" : "runPresentation.observedRunning") },
    };
    if (status?.phase === "finished") return applySSettlementProjection({ ...view,
      loading: false, streaming: false, reasoningStreaming: false,
      runStage: resolveRunFinishedStage({ status: stored.runSnapshot?.terminalStatus }),
    }, stored.sSettlement);
    if (statuses !== undefined && (!status || status.phase === "unavailable")
      && isRunStatusCandidate(stored)) return {
      ...view, loading: false, streaming: false, reasoningStreaming: false,
      runStatusNotice: t("runPresentation.observedUnavailable"),
    };
    // Unknown ownership must not turn a live checkpoint into an interrupted run.
    const recover = statuses === undefined || status?.phase === "interrupted";
    const restored = recover && stored.runSnapshot ? recoverInterruptedMessage(view, stored.runSnapshot) : view;
    return applySSettlementProjection(restored, stored.sSettlement);
  });
}

export function applySSettlementProjection(item: ChatMessageItem, projection: ChatMessage["sSettlement"]): ChatMessageItem {
  if (!projection) return item;
  const committed = projection.state === "success";
  return {
    ...item, sSettlement: projection, content: committed ? projection.originalText : "", transientText: undefined,
    loading: false, waitingForFirstEvent: false, streaming: false, reasoningStreaming: false, responseStarted: committed,
    runId: projection.runId, sticker: committed ? item.sticker : undefined,
    ttsCacheKey: committed ? item.ttsCacheKey : undefined, ttsCacheVersion: committed ? item.ttsCacheVersion : undefined,
    runStage: { kind: committed ? "completed" : "failed" },
    processMessages: (item.processMessages ?? []).filter((entry) => !entry.interrupted || entry.content !== projection.originalText),
    runActivity: item.runActivity ? {
      ...item.runActivity, activeReasoningStartedAt: undefined,
      completedAt: item.runActivity.completedAt ?? item.runActivity.startedAt, keepExpanded: !committed,
    } : undefined,
  };
}

export function getInitialMode(): ConversationMode {
  try {
    const last = localStorage.getItem(LAST_MODE_STORAGE_KEY);
    if (last && isConversationMode(last)) return last;
  } catch { return "chat"; }
  return "chat";
}
