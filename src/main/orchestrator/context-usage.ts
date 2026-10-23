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
    systemPrompt: 0, tools: 0, skills: 0, runtimeAndToolLogs: 0, conversation: 0, other: 0, toolDefinitions: 0,
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
  const categories: ContextUsageCategory[] = order.map((key) => ({ key, tokens: totals[key] }));
  return {
    phase: input.phase, ...(input.runId ? { runId: input.runId } : {}),
    ...(typeof input.round === "number" ? { round: input.round } : {}),
    contextWindowTokens: input.contextWindowTokens,
    totalTokens: categories.reduce((total, bucket) => total + bucket.tokens, 0),
    categories,
    messageCount: input.messages.length,
    updatedAt: Date.now(),
  };
}
