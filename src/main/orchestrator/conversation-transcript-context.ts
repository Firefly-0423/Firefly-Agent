import { findSafeCutPointForRetainedTokens } from "./harness/compaction";
import type { HarnessRunSession } from "./harness/run-store";
import { DEFAULT_HARNESS_CONFIG, tryParseToolCallArgs, toolCallFingerprint, type UncertainEffect } from "./harness/types";
import type { ConversationTranscriptStore } from "./conversation-transcript-store";
import type { TranscriptEntry } from "./conversation-transcript-types";
import { classifySAssistantSettlement } from "./conversation-transcript-settlement";
import type { ChatMessage, ToolCall } from "./vendors/types";
import type { ChatMessage as StoredChatMessage } from "../../shared/chat-types";
import { autoCompactTriggerTokens } from "../../shared/context-window";

export interface TranscriptRunReader { get(runId: string): HarnessRunSession | null }
export interface MaterializedTranscript {
  throughSeq: number;
  uncertainEffects: UncertainEffect[];
  messageSources?: TranscriptEntry[];
  messages: ChatMessage[];
}
type UserEnvelope = Extract<TranscriptEntry, { kind: "user" | "turn_rewind" }>;
type AssistantEnvelope = Extract<TranscriptEntry, { kind: "assistant" }>;
type ActiveNode =
  | { kind: "user"; entry: UserEnvelope; text: string }
  | { kind: "assistant"; entry: AssistantEnvelope; toolResults: Map<string, { message: ChatMessage; entry: TranscriptEntry }> };

function findActiveUserIndex(active: ActiveNode[], turnId: string): number {
  let selected = -1, revision = -Infinity;
  active.forEach((node, offset) => {
    if (node.kind !== "user" || node.entry.turnId !== turnId) return;
    const candidate = node.entry.revision ?? 0;
    if (candidate > revision) { selected = offset; revision = candidate; }
  });
  return selected;
}
function syntheticToolMessage(call: ToolCall, outcome: "unknown" | "not_executed"): ChatMessage {
  return {
    role: "tool", toolCallId: call.id, name: call.name,
    content: JSON.stringify({
      outcome, tool: call.name,
      message: outcome === "unknown"
        ? "该工具已启动但结果未知（中断或轨迹写入失败）；不得自动重放，先查证或询问用户。"
        : "该工具从未执行（排队未启动即中断）；请根据当前任务自行决定是否重新调用。",
    }),
  };
}
function addUncertainEffect(effects: UncertainEffect[], runId: string | undefined, call: ToolCall): void {
  if (effects.some((candidate) => candidate.toolCallId === call.id)) return;
  const decoded = tryParseToolCallArgs(call);
  effects.push({
    id: `${runId ?? "unknown-run"}:${call.id}`, toolCallId: call.id,
    fingerprint: toolCallFingerprint(call.name, decoded ?? {}),
    ...(decoded === undefined ? { argumentsUnavailable: true as const } : {}),
    toolName: call.name, message: "该外部副作用在应用中断时尚未确认结果",
  });
}

export function materializeTranscript(entries: TranscriptEntry[], runReader: TranscriptRunReader, options: { missingRunEvidence?: "unknown" } = {}): MaterializedTranscript {
  const view: ActiveNode[] = [];
  const unresolved: UncertainEffect[] = [];
  let lastSequence = 0;
  for (const envelope of entries) {
    lastSequence = Math.max(lastSequence, envelope.seq);
    switch (envelope.kind) {
      case "user": view.push({ kind: "user", entry: envelope, text: envelope.payload.text }); break;
      case "assistant": view.push({ kind: "assistant", entry: envelope, toolResults: new Map() }); break;
      case "tool_result": {
        const owner = view.find((node) => node.kind === "assistant" && node.entry.id === envelope.payload.assistantEntryId);
        if (owner && owner.kind === "assistant" && !owner.toolResults.has(envelope.payload.toolCallId)) {
          owner.toolResults.set(envelope.payload.toolCallId, { message: envelope.payload.message, entry: envelope });
        }
        break;
      }
      case "turn_rewind": {
        const anchor = findActiveUserIndex(view, envelope.payload.anchorUserTurnId);
        if (envelope.payload.disposition === "keep_user") {
          if (anchor >= 0) view.length = anchor + 1;
        } else {
          if (anchor >= 0) view.length = anchor;
          view.push({ kind: "user", entry: envelope, text: envelope.payload.replacementUser?.text ?? "" });
        }
        break;
      }
    }
  }
  const messages: ChatMessage[] = [];
  const sources: TranscriptEntry[] = [];
  for (const node of view) {
    if (node.kind === "user") { messages.push({ role: "user", content: node.text }); sources.push(node.entry); continue; }
    const disposition = classifySAssistantSettlement(entries, node.entry.id);
    if (disposition !== "legacy" && disposition !== "success") continue;
    const assistant = node.entry.payload;
    messages.push(assistant);
    sources.push(node.entry);
    if (!assistant.toolCalls?.length) continue;
    const session = node.entry.runId ? runReader.get(node.entry.runId) : null;
    const executions = new Map(session?.toolCalls.map((execution) => [execution.toolCallId, execution]));
    for (const invocation of assistant.toolCalls) {
      const committed = node.toolResults.get(invocation.id);
      if (committed) { messages.push(committed.message); sources.push(committed.entry); continue; }
      sources.push(node.entry);
      const execution = executions.get(invocation.id);
      const uncertain = execution?.status === "started" || execution?.status === "unknown"
        || !session && options.missingRunEvidence === "unknown";
      if (uncertain) {
        if (execution?.sideEffect !== "read_only") addUncertainEffect(unresolved, node.entry.runId, invocation);
        messages.push(syntheticToolMessage(invocation, "unknown"));
      } else messages.push(syntheticToolMessage(invocation, "not_executed"));
    }
  }
  return { messages, messageSources: sources, uncertainEffects: unresolved, throughSeq: lastSequence };
}

export function projectSSettlementMessages(messages: readonly StoredChatMessage[], entries: TranscriptEntry[]): StoredChatMessage[] {
  const materialized = materializeTranscript(entries, { get: () => null });
  const liveIds = new Set(materialized.messageSources?.map((envelope) => envelope.id));
  const userEnvelopes = materialized.messageSources?.filter((envelope) => envelope.kind === "user" || envelope.kind === "turn_rewind") ?? [];
  return messages.map((display) => {
    const { sSettlement: discarded, ...projected } = display;
    if (display.role !== "model") return projected;
    const candidates = entries.filter((envelope) => envelope.kind === "assistant" && envelope.turnId === display.id && (envelope.sSettlement || envelope.roundId === "s-response"));
    const envelope = candidates.at(-1);
    if (!envelope || envelope.kind !== "assistant") return projected;
    let disposition = classifySAssistantSettlement(entries, envelope.id);
    if (disposition === "legacy") return projected;
    const user = [...userEnvelopes].reverse().find((candidate) => candidate.turnId === envelope.sSettlement?.userTurnId);
    if (candidates.length !== 1 || display.answersUserMessageId !== envelope.sSettlement?.userTurnId
      || user?.revision !== envelope.sSettlement?.userRevision || disposition === "success" && !liveIds.has(envelope.id)) disposition = "unknown";
    const settlement = { state: disposition, runId: envelope.runId ?? "", assistantEntryId: envelope.id, originalText: typeof envelope.payload.content === "string" ? envelope.payload.content : "" };
    if (disposition === "success") return {
      ...projected, content: settlement.originalText, sSettlement: settlement,
      runSnapshot: { ...display.runSnapshot, status: "terminal", terminalStatus: "success", runId: settlement.runId, updatedAt: envelope.at },
    };
    return { ...projected, content: "", sticker: undefined, ttsCacheKey: undefined, ttsCacheVersion: undefined, sSettlement: settlement };
  });
}

export async function buildModelContext(input: { store: ConversationTranscriptStore; conversationId: string; retainTokens: number; runReader: TranscriptRunReader }): Promise<MaterializedTranscript> {
  await input.store.waitForIdle(input.conversationId);
  const persisted = await input.store.read(input.conversationId);
  const context = materializeTranscript(persisted.entries, input.runReader);
  const boundary = findSafeCutPointForRetainedTokens(context.messages, input.retainTokens);
  return { messages: context.messages.slice(boundary), messageSources: context.messageSources?.slice(boundary), uncertainEffects: context.uncertainEffects, throughSeq: persisted.throughSeq };
}
export function resolveTranscriptRetainTokens(contextWindowTokens: number): number {
  const budget = { reservedOutputTokens: DEFAULT_HARNESS_CONFIG.reservedOutputTokens,
    safetyMarginTokens: DEFAULT_HARNESS_CONFIG.safetyMarginTokens, threshold: DEFAULT_HARNESS_CONFIG.compactionThreshold };
  return autoCompactTriggerTokens(contextWindowTokens, budget);
}
