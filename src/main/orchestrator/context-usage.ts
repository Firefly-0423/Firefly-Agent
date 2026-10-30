import type { ChatMessage } from "./vendors/types";
import { estimateTokens, estimateMessageContentTokens } from "./context-manager";
import { isCompactionCheckpointMessage } from "./harness/compaction";
import type { ContextUsageCategory, ContextUsageCategoryKey, ContextUsagePhase, ContextUsageSnapshot } from "../../shared/context-usage";

export interface ContextUsageSnapshotInput {
  messages: ChatMessage[];
  runtimeContext?: string;
  toolSpecs?: Array<{ name: string; description: string; parameters: object }>;
  skillLayerContent?: string;
  toolLayerContent?: string;
  personaContent: string;
  contextWindowTokens: number;
  round?: number;
  runId?: string;
  phase: ContextUsagePhase;
  /** The provider's usage for the last request: its input and output tokens and how many messages it carried. */
  measured?: { inputTokens: number; outputTokens: number; messageCount: number };
}

function messageBucket(entry: ChatMessage): ContextUsageCategoryKey {
  if (isCompactionCheckpointMessage(entry)) return "conversation";
  if (entry.role === "tool") return "runtimeAndToolLogs";
  if (entry.visibility === "internal") return "runtimeAndToolLogs";
  switch (entry.role) {
    case "user": case "assistant": case "system": return "conversation";
    default: return "other";
  }
}

export function buildContextUsageSnapshot(input: ContextUsageSnapshotInput): ContextUsageSnapshot {
  const totals: Record<ContextUsageCategoryKey, number> = {
    systemPrompt: 0, tools: 0, skills: 0, runtimeAndToolLogs: 0, conversation: 0, other: 0, toolDefinitions: 0, retrieved: 0,
  };
  totals.systemPrompt += estimateTokens(input.personaContent);
  totals.skills += estimateTokens(input.skillLayerContent ?? "");
  totals.tools += Math.max(0, estimateTokens(input.toolLayerContent ?? "") - totals.skills);
  for (const definition of input.toolSpecs ?? []) {
    totals.tools += estimateTokens(definition.name + definition.description + JSON.stringify(definition.parameters));
  }
  if (input.runtimeContext?.trim()) {
    totals.runtimeAndToolLogs += estimateTokens(`<runtime_context>\n${input.runtimeContext.trim()}\n</runtime_context>`);
  }
  for (const entry of input.messages) totals[messageBucket(entry)] += estimateMessageContentTokens(entry.content ?? "") + 4;
  const order: ContextUsageCategoryKey[] = ["systemPrompt", "tools", "skills", "runtimeAndToolLogs", "conversation", "other"];
  let categories: ContextUsageCategory[] = order.map((key) => ({ key, tokens: totals[key] }));
  // With the provider's count the total is real: what that request carried, its reply, and an estimate of the
  // messages added since (tool results). What the estimate cannot see (memory, retrieved history, provider framing)
  // is shown as its own share; an estimate that overshoots is scaled down to the reported total instead.
  const measured = input.measured && Number.isSafeInteger(input.measured.inputTokens) && input.measured.inputTokens > 0 ? input.measured : undefined;
  if (measured) {
    const since = input.messages.slice(measured.messageCount + 1).reduce((sum, entry) => sum + estimateMessageContentTokens(entry.content ?? "") + 4, 0);
    const total = measured.inputTokens + Math.max(0, measured.outputTokens || 0) + since;
    const estimated = categories.reduce((sum, part) => sum + part.tokens, 0);
    if (estimated <= total) categories.push({ key: "retrieved", tokens: total - estimated });
    else {
      const scaled = categories.map((part) => ({ ...part, tokens: Math.floor(part.tokens * total / estimated) }));
      const largest = scaled.reduce((best, part, index) => part.tokens > scaled[best].tokens ? index : best, 0);
      scaled[largest].tokens += total - scaled.reduce((sum, part) => sum + part.tokens, 0);
      categories = scaled;
    }
  }
  return {
    ...(measured ? { measured: true } : {}),
    phase: input.phase, ...(input.runId ? { runId: input.runId } : {}),
    ...(typeof input.round === "number" ? { round: input.round } : {}),
    contextWindowTokens: input.contextWindowTokens,
    totalTokens: categories.reduce((total, bucket) => total + bucket.tokens, 0),
    categories,
    messageCount: input.messages.length,
    updatedAt: Date.now(),
  };
}
