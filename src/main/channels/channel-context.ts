import { createHash } from "crypto";
import type { PreparedOutgoing } from "./outgoing-composer";
import type { ChannelId, IncomingMessage } from "./types";

export type ChatMessage = { content?: string; role: "user" | "assistant" | "system" | "tool" };
export type DispatchContext = { boundConversationId: string | null; sessionId: string };
export type BoundConversationMessageMetadata = { sticker?: string; modelContext?: string; senderName?: string; chatType: "private" | "group"; channel: ChannelId };
export interface ChannelContext {
  appendAssistantContext(msg: IncomingMessage, context: DispatchContext, prepared: PreparedOutgoing): Promise<void>;
  appendIncomingContext(msg: IncomingMessage, context: DispatchContext): Promise<void>;
  resolvePriorMessages(context: DispatchContext, limit: number): Promise<ChatMessage[] | undefined>;
  recordIncomingSession(msg: IncomingMessage, context: DispatchContext): void;
  resolveDispatchContext(sessionId: string): DispatchContext;
}
export interface CreateChannelContextOptions {
  migrateHistory: (fromSessionId: string, toSessionId: string) => void;
  appendBoundConversationMessage?: (conversationId: string, role: "user" | "assistant", content: string, metadata: BoundConversationMessageMetadata) => void | Promise<void>;
  appendChannelHistory: (sessionId: string, role: "user" | "assistant", content: string) => void | Promise<void>;
  loadBoundConversationHistory?: (conversationId: string, limit: number) => Promise<ChatMessage[]>;
  loadRecentChannelHistory?: (sessionId: string, limit: number) => Promise<ChatMessage[]>;
  resolveBoundConversationId?: (sessionId: string) => string | null;
}
const senders = new Map<string, { channel: ChannelId; senderId: string; lastAt: number }>();
export function makeSessionId(channel: ChannelId, chatId: string): string {
  const digest = createHash("sha256").update(`${channel}:${chatId}`).digest("hex").slice(0, 16);
  return `channel:${channel}:${digest}`;
}
export function formatChannelUserText(msg: IncomingMessage): string {
  if (msg.chatType !== "group") return msg.text;
  const author = msg.senderName ? `${msg.senderName} (${msg.senderId})` : msg.senderId;
  const quotation = msg.reply?.text ? `\n引用 ${msg.reply.senderName || msg.reply.senderId || "未知用户"}：${msg.reply.text}` : "";
  return `[群聊发送者：${author}]${quotation}\n${msg.text}`;
}
export function lookupOriginalSender(sessionId: string): { channel: ChannelId; senderId: string } | null {
  const known = senders.get(sessionId);
  return known ? { channel: known.channel, senderId: known.senderId } : null;
}
function recordSession(channel: ChannelId, senderId: string, sessionId: string): void {
  senders.set(sessionId, { channel, senderId, lastAt: Date.now() });
  if (senders.size <= 5000) return;
  const oldest = [...senders.entries()].sort((left, right) => left[1].lastAt - right[1].lastAt)[0];
  if (oldest) senders.delete(oldest[0]);
}
export function createChannelContext(options: CreateChannelContextOptions): ChannelContext {
  return {
    resolveDispatchContext(sessionId) {
      let requested: string | null = null;
      try { requested = options.resolveBoundConversationId?.(sessionId) ?? null; }
      catch (failure) { console.warn("[ChannelContext]", "绑定查询失败，继续使用渠道上下文:", failure); }
      const available = Boolean(requested && options.loadBoundConversationHistory);
      return { sessionId, boundConversationId: available ? requested : null };
    },
    recordIncomingSession(msg, context) {
      if (msg.channel === "feishu" && msg.chatType === "private") options.migrateHistory(makeSessionId(msg.channel, msg.senderId), context.sessionId);
      recordSession(msg.channel, msg.senderId, context.sessionId);
    },
    async resolvePriorMessages(context, limit) {
      if (context.boundConversationId && options.loadBoundConversationHistory) {
        try { return await options.loadBoundConversationHistory(context.boundConversationId, limit); }
        catch (failure) { console.warn("[ChannelContext]", "绑定历史读取失败，回退到渠道历史:", failure); }
      }
      if (!options.loadRecentChannelHistory) return undefined;
      try { return await options.loadRecentChannelHistory(context.sessionId, limit); }
      catch (failure) { console.warn("[ChannelContext]", "渠道历史读取失败，继续不带历史:", failure); return undefined; }
    },
    async appendIncomingContext(msg, context) {
      const rendered = formatChannelUserText(msg);
      try { await options.appendChannelHistory(context.sessionId, "user", rendered); }
      catch (failure) { console.warn("[ChannelContext]", "渠道用户历史写入失败:", failure); }
      if (!context.boundConversationId || !options.appendBoundConversationMessage) return;
      try {
        await options.appendBoundConversationMessage(context.boundConversationId, "user", msg.text, {
          channel: msg.channel, chatType: msg.chatType ?? "private", senderName: msg.senderName, modelContext: rendered === msg.text ? undefined : rendered,
        });
      } catch (failure) { console.warn("[ChannelContext]", "绑定会话用户消息写入失败:", failure); }
    },
    async appendAssistantContext(msg, context, prepared) {
      try { await options.appendChannelHistory(context.sessionId, "assistant", prepared.assistantText); }
      catch (failure) { console.warn("[ChannelContext]", "渠道助手历史写入失败:", failure); }
      if (!context.boundConversationId || !options.appendBoundConversationMessage) return;
      try {
        await options.appendBoundConversationMessage(context.boundConversationId, "assistant", prepared.assistantText, {
          channel: msg.channel, chatType: msg.chatType ?? "private", senderName: msg.senderName, modelContext: undefined,
          ...(prepared.stickerId ? { sticker: prepared.stickerId } : {}),
        });
      } catch (failure) { console.warn("[ChannelContext]", "绑定会话助手消息写入失败:", failure); }
    },
  };
}
