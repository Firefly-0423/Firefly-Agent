import type { RunActivityRecord } from "../../../../../shared/chat-types";

export type AssistantVisibilityState = {
  runActivity?: RunActivityRecord;
  sticker?: string | null;
  responseStarted?: boolean;
  reasoningStreaming?: boolean;
  reasoning?: string;
  loading?: boolean;
  transientText?: string;
  content: string;
};

export function assistantRenderStages(message: AssistantVisibilityState): Array<"activity" | "reasoning" | "assistant"> {
  const visible: Array<"activity" | "reasoning" | "assistant"> = [];
  if (message.runActivity) visible.push("activity");
  if (message.reasoning || message.reasoningStreaming) visible.push("reasoning");
  if (message.responseStarted || message.transientText || message.content || message.sticker) visible.push("assistant");
  return visible;
}

export function resolveReasoningExpanded(expandedById: Readonly<Record<string, boolean>>, messageId: string): boolean {
  const preference = expandedById[messageId];
  return preference ?? true;
}

export function updateReasoningExpanded(expandedById: Readonly<Record<string, boolean>>, messageId: string, expanded: boolean): Record<string, boolean> {
  if (expandedById[messageId] === expanded) return expandedById;
  return { ...expandedById, [messageId]: expanded };
}
