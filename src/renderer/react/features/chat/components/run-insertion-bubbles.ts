import type { ConversationMode } from "../../../../../shared/chat-types";
import type { ChatMessageItem } from "./ChatMessageList";

export type RunInsertionBubble = { id: string; content: string; sticker?: string | null; round: number; order: number };
export type RunInsertionContent = RunInsertionBubble & { stickerUrl?: string; stickerUnavailable?: string };

export function insertionRoundNumber(roundId?: string): number | undefined {
  const parsed = /^round-(0|[1-9][0-9]*)$/.exec(roundId ?? "");
  return parsed ? Number(parsed[1]) : undefined;
}

/** Keep the source user row unless the original reply can show its bubble at a verified round boundary. */
export function placeRunInsertionBubbles(messages: ChatMessageItem[], mode: ConversationMode): ChatMessageItem[] {
  if (mode === "chat" || !messages.some(message => message.runInsertion?.delivery)) return messages;
  const replies = new Map(messages.filter(message => message.role === "assistant").map(message => [message.id, message]));
  const bubbles = new Map<ChatMessageItem, Map<string, RunInsertionBubble>>();
  const hidden = new Set<ChatMessageItem>();
  for (const message of messages) {
    const marker = message.role === "user" ? message.runInsertion : undefined;
    const delivery = marker?.delivery;
    if (!marker?.assistantTurnId || !delivery) continue;
    const reply = replies.get(marker.assistantTurnId);
    if (!reply?.runActivity || reply.runId !== marker.runId || !reply.agentRounds) continue;
    const boundary = reply.agentRounds.some(round =>
      round.id === `round-${delivery.round}`
      || (round.id === `round-${delivery.round - 1}` && round.status === "completed"));
    if (!boundary || reply.toolExecutions?.some(tool => insertionRoundNumber(tool.roundId) === undefined)) continue;
    const attached = bubbles.get(reply) ?? new Map<string, RunInsertionBubble>();
    attached.set(JSON.stringify([marker.runId, message.id, marker.revision]), {
      id: message.id, content: message.content, sticker: message.sticker, round: delivery.round, order: delivery.order,
    });
    bubbles.set(reply, attached);
    hidden.add(message);
  }
  if (hidden.size === 0) return messages;
  return messages.filter(message => !hidden.has(message)).map(message => {
    const attached = bubbles.get(message);
    return attached ? { ...message, insertionBubbles: [...attached.values()] } : message;
  });
}
