import type { ChatMessage, ChatMessageChannelSource, ChatSession, ConversationMode } from "../../../../../shared/chat-types";
import { describePermissionRequest, type AgentRunStage, type ComposerInteraction } from "../components/run-presentation";
import type { ChatMessageItem } from "../components/ChatMessageList";
import type { WeatherData } from "../components/weather/weather-types";
import type { PermissionApprovalRequest } from "./chat-page-bridge";
import { recoverInterruptedMessage } from "./session-runtime-state";

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

export function toUiMessages(session: ChatSession): ChatMessageItem[] {
  return session.messages.map((stored) => {
    const view: ChatMessageItem = {
      id: stored.id, role: stored.role === "model" ? "assistant" : "user", content: stored.content,
      modelContext: stored.modelContext, channelSource: normalizeChannelSource(stored.channelSource),
      reasoning: stored.reasoning, reasoningBlocks: stored.reasoningBlocks, processMessages: stored.processMessages,
      agentRounds: stored.agentRounds, taskDelegations: stored.taskDelegations, runActivity: stored.runActivity,
      ttsCacheKey: stored.ttsCacheKey, ttsCacheVersion: stored.ttsCacheVersion,
      responseStarted: stored.role === "model" && Boolean(stored.content.trim() || stored.sticker),
      sticker: stored.sticker, toolExecutions: stored.toolExecutions, attachments: stored.attachments,
      contextUsage: stored.contextUsage, workReadReport: stored.workReadReport, runId: stored.runSnapshot?.runId,
    };
    const restored = stored.runSnapshot ? recoverInterruptedMessage(view, stored.runSnapshot) : view;
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
