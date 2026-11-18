import type { ChatMessage } from "../../../shared/chat-types";
import type { AgentRunStore } from "../../agent/loop/run-store";

export function projectRunInsertions(
  sessionId: string, messages: ChatMessage[], read: AgentRunStore["insertionEvidence"],
): ChatMessage[] {
  if (!messages.some(message => message.role === "user" && message.runInsertion?.assistantTurnId)) return messages;
  const assistants = new Map(messages.filter(message => message.role === "model").map(message => [message.id, message]));
  const runs = new Map<string, ReturnType<typeof read>>();
  return messages.map(message => {
    const marker = message.role === "user" ? message.runInsertion : undefined;
    if (!marker?.assistantTurnId) return message;
    const assistant = assistants.get(marker.assistantTurnId);
    if (!assistant || (assistant.runSnapshot?.runId && assistant.runSnapshot.runId !== marker.runId)) return message;
    if (!runs.has(marker.runId)) {
      try { runs.set(marker.runId, read(marker.runId)); }
      catch {
        // Optional receipt evidence must not prevent the conversation from opening.
        runs.set(marker.runId, null);
      }
    }
    const run = runs.get(marker.runId);
    if (run?.conversationId !== sessionId) return message;
    const receipt = run.insertions?.find(item =>
      item.messageId === message.id && item.sourceRunId === marker.runId && item.revision === marker.revision);
    return receipt
      ? { ...message, runInsertion: { ...marker, delivery: { round: receipt.round, order: receipt.order } } }
      : message;
  });
}
