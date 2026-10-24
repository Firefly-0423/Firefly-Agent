import type { ChatMessageChannelSource, ConversationMode } from "../../../../../shared/chat-types";

type RevisableMessage = {
  channelSource?: ChatMessageChannelSource;
  reasoningStreaming?: boolean;
  streaming?: boolean;
  loading?: boolean;
  role: "user" | "assistant" | "model" | "system";
  id: string;
};

export type RevisableLastTurn = { assistantMessageId: string; userMessageId: string };

export function resolveRevisableLastTurn(messages: readonly RevisableMessage[], mode: ConversationMode): RevisableLastTurn | null {
  if (mode !== "chat" || messages.length < 2) return null;
  const question = messages[messages.length - 2];
  const answer = messages[messages.length - 1];
  if (question.role !== "user") return null;
  if (answer.role !== "assistant" && answer.role !== "model") return null;
  if (question.channelSource || answer.channelSource) return null;
  if (answer.loading || answer.streaming || answer.reasoningStreaming) return null;
  return { userMessageId: question.id, assistantMessageId: answer.id };
}
