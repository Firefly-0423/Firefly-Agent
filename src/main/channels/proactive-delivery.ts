import type { ChannelManager } from "./manager";
import { createChannelDeliveryService, type ChannelDeliveryService } from "./delivery-service";
import { appendHistory as appendChannelHistory } from "./history-log";
import { appendLog as appendChannelLog, type LogEntry } from "./message-log";
import type { ChannelId, IncomingMessage, OutgoingMessage } from "./types";

export type ProactiveMobileChannel = Extract<ChannelId, "wechat" | "feishu">;
export type RecentProactiveChannelRecipient = { updatedAt: number; sessionId: string; threadId?: string; targetId: string };
export interface ProactiveChannelRecipientRegistry {
  get(channel: ProactiveMobileChannel): RecentProactiveChannelRecipient | null;
  remember(message: IncomingMessage, sessionId: string): void;
}
export type ProactiveChannelDeliveryResult = { kind: "committed"; deliveredParts: number; totalParts: number } | { kind: "cancelled"; reason: string };
interface ProactiveChannelDeliveryInput {
  canContinue?: () => boolean;
  appendLog?: (entry: Omit<LogEntry, "at">) => void;
  appendHistory?: typeof appendChannelHistory;
  recipientRegistry?: ProactiveChannelRecipientRegistry;
  delivery?: ChannelDeliveryService;
  manager: Pick<ChannelManager, "getAdapter">;
  text: string;
  channel: ProactiveMobileChannel;
}
export function createProactiveChannelRecipientRegistry(): ProactiveChannelRecipientRegistry {
  const latest = new Map<ProactiveMobileChannel, RecentProactiveChannelRecipient>();
  return {
    remember(message, sessionId) {
      if (message.channel !== "wechat" && message.channel !== "feishu") return;
      const destination = message.chatId.trim();
      if (!destination || !sessionId) return;
      latest.set(message.channel, { targetId: destination, ...(message.threadId ? { threadId: message.threadId } : {}), sessionId, updatedAt: message.at.getTime() });
    },
    get(channel) { return latest.get(channel) ?? null; },
  };
}
const recipients = createProactiveChannelRecipientRegistry();
export function rememberProactiveChannelRecipient(message: IncomingMessage, sessionId: string): void { recipients.remember(message, sessionId); }
export function canStartProactiveChannelDelivery(channel: ProactiveMobileChannel, manager: Pick<ChannelManager, "getAdapter">, recipientRegistry: ProactiveChannelRecipientRegistry = recipients): boolean {
  const transport = manager.getAdapter(channel);
  return transport?.getStatus().phase === "running" && recipientRegistry.get(channel) !== null;
}
export async function sendProactiveChannelMessage(input: ProactiveChannelDeliveryInput): Promise<ProactiveChannelDeliveryResult> {
  const transport = input.manager.getAdapter(input.channel);
  if (!transport || transport.getStatus().phase !== "running") return { kind: "cancelled", reason: "channel_offline" };
  const destination = (input.recipientRegistry ?? recipients).get(input.channel);
  if (!destination) return { kind: "cancelled", reason: "recipient_unavailable" };
  const sender = input.delivery ?? createChannelDeliveryService(input.manager);
  const candidates = [input.text.trim()].filter(Boolean);
  if (candidates.length === 0) return { kind: "cancelled", reason: "empty_text" };
  const confirmed: string[] = [];
  for (const paragraph of candidates) {
    if (input.canContinue && !input.canContinue()) break;
    if (transport.getStatus().phase !== "running") break;
    const outgoing: OutgoingMessage = { channel: input.channel, targetId: destination.targetId,
      ...(destination.threadId ? { threadId: destination.threadId } : {}), parts: [{ kind: "text", text: paragraph }] };
    const receipt = await sender.send(outgoing);
    if (!receipt.ok) break;
    confirmed.push(paragraph);
  }
  if (confirmed.length === 0) return { kind: "cancelled", reason: "send_failed" };
  const committed = confirmed.join("");
  (input.appendHistory ?? appendChannelHistory)(destination.sessionId, "assistant", committed);
  (input.appendLog ?? appendChannelLog)({ dir: "outgoing", channel: input.channel, senderId: destination.targetId, chatId: destination.targetId, text: committed, hasAttachments: false });
  return { kind: "committed", deliveredParts: confirmed.length, totalParts: candidates.length };
}
