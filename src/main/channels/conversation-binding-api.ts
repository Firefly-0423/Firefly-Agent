import type { ChatSessionMeta } from "../../shared/chat-types";
import type { ChannelConversationBindingSnapshot, ChannelConversationBindingStore } from "./conversation-binding-store";

export type ContextConversationSummary = { updatedAt: number; mode: string; title: string; id: string };
export interface ContextBindingSnapshot extends ChannelConversationBindingSnapshot {
  conversations: ContextConversationSummary[];
}
export type ContextBindingResult = { error?: string; ok: boolean };

export function getContextBindingSnapshot(store: ChannelConversationBindingStore, sessions: ChatSessionMeta[] | ContextConversationSummary[]): ContextBindingSnapshot {
  const listed = store.list();
  return {
    externalChats: listed.externalChats,
    bindings: listed.bindings,
    conversations: sessions.map((conversation) => ({ id: conversation.id, title: conversation.title, mode: conversation.mode ?? "work", updatedAt: conversation.updatedAt })),
  };
}

function validIdentifier(candidate: unknown): candidate is string {
  return typeof candidate === "string" && candidate.length !== 0 && !(candidate.length > 128);
}

export function bindContextConversation(store: ChannelConversationBindingStore, payload: unknown, conversationExists: (conversationId: string) => boolean): ContextBindingResult {
  if (!payload || typeof payload !== "object") return { ok: false, error: "请求格式无效" };
  const request = payload as { sessionId?: unknown; conversationId?: unknown };
  if (!validIdentifier(request.sessionId)) return { ok: false, error: "外部聊天标识无效" };
  if (!validIdentifier(request.conversationId)) return { ok: false, error: "桌面对话标识无效" };
  const known = store.list().externalChats.some((external) => external.sessionId === request.sessionId);
  if (!known) return { ok: false, error: "外部聊天不存在" };
  if (!conversationExists(request.conversationId)) return { ok: false, error: "桌面对话不存在" };
  try {
    store.bind(request.sessionId, request.conversationId);
    return { ok: true };
  } catch (failure) { return { ok: false, error: failure instanceof Error ? failure.message : String(failure) }; }
}

export function unbindContextConversation(store: ChannelConversationBindingStore, sessionId: unknown): ContextBindingResult {
  if (!validIdentifier(sessionId)) return { ok: false, error: "外部聊天标识无效" };
  store.unbind(sessionId);
  return { ok: true };
}
