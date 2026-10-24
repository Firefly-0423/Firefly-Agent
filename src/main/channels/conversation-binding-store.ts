import * as fs from "node:fs";
import * as path from "node:path";
import { app } from "electron";
import type { ChannelChatType } from "./types";

const STORE_VERSION = 1;
export type ExternalChannelChat = { lastAt: number; senderName?: string; chatType: ChannelChatType; chatId: string; channel: string; sessionId: string };
export type ChannelConversationBinding = { updatedAt: number; conversationId: string; sessionId: string };
export type ChannelConversationBindingSnapshot = { bindings: ChannelConversationBinding[]; externalChats: ExternalChannelChat[] };
type PersistedBindingState = { version: typeof STORE_VERSION; externalChats: ExternalChannelChat[]; bindings: ChannelConversationBinding[] };
const emptyState = (): PersistedBindingState => ({ version: STORE_VERSION, externalChats: [], bindings: [] });
function isExternalChat(candidate: unknown): candidate is ExternalChannelChat {
  if (!candidate || typeof candidate !== "object") return false;
  const record = candidate as Partial<ExternalChannelChat>;
  return typeof record.sessionId === "string" && record.sessionId.length > 0 && record.sessionId.length <= 128
    && typeof record.channel === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(record.channel)
    && typeof record.chatId === "string" && record.chatId.length > 0 && record.chatId.length <= 256
    && (record.chatType === "private" || record.chatType === "group")
    && (record.senderName === undefined || (typeof record.senderName === "string" && record.senderName.length <= 256))
    && typeof record.lastAt === "number" && Number.isFinite(record.lastAt);
}
function isBinding(candidate: unknown): candidate is ChannelConversationBinding {
  if (!candidate || typeof candidate !== "object") return false;
  const record = candidate as Partial<ChannelConversationBinding>;
  return typeof record.sessionId === "string" && record.sessionId.length > 0 && record.sessionId.length <= 128
    && typeof record.conversationId === "string" && record.conversationId.length > 0 && record.conversationId.length <= 128
    && typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt);
}

export class ChannelConversationBindingStore {
  private cached: PersistedBindingState | null = null;
  private needsWrite = false;
  private writtenAt = 0;
  constructor(private readonly filePath: string, private readonly maxExternalChats = 200) {}

  observe(chat: ExternalChannelChat): void {
    if (!isExternalChat(chat)) throw new Error("Invalid external chat");
    const document = this.load();
    const previous = document.externalChats.find((record) => record.sessionId === chat.sessionId);
    const changed = !previous || previous.channel !== chat.channel || previous.chatId !== chat.chatId
      || previous.chatType !== chat.chatType || previous.senderName !== chat.senderName;
    const observed = document.externalChats.filter((record) => record.sessionId !== chat.sessionId);
    observed.push({ ...chat });
    observed.sort((left, right) => right.lastAt - left.lastAt);
    const pinned = new Set(document.bindings.map((record) => record.sessionId));
    const retained = observed.filter((record) => pinned.has(record.sessionId));
    const expendable = observed.filter((record) => !pinned.has(record.sessionId));
    const allowance = Math.max(0, this.maxExternalChats - retained.length);
    document.externalChats = [...retained, ...expendable.slice(0, allowance)].sort((left, right) => right.lastAt - left.lastAt);
    this.needsWrite = true;
    const instant = Date.now();
    if (changed || instant < this.writtenAt || instant - this.writtenAt >= 5_000) this.persist();
  }
  flush(): void { if (this.needsWrite) this.persist(); }
  bind(sessionId: string, conversationId: string, updatedAt = Date.now()): void {
    const document = this.load();
    if (!document.externalChats.some((record) => record.sessionId === sessionId)) throw new Error("Unknown external chat");
    if (!conversationId || conversationId.length > 128) throw new Error("Invalid conversation id");
    document.bindings = document.bindings.filter((record) => record.sessionId !== sessionId);
    document.bindings.push({ sessionId, conversationId, updatedAt });
    this.persist();
  }
  unbind(sessionId: string): boolean {
    const document = this.load();
    const remaining = document.bindings.filter((record) => record.sessionId !== sessionId);
    if (remaining.length === document.bindings.length) return false;
    document.bindings = remaining;
    this.persist();
    return true;
  }
  resolve(sessionId: string): string | null { return this.load().bindings.find((record) => record.sessionId === sessionId)?.conversationId ?? null; }
  list(): ChannelConversationBindingSnapshot {
    const document = this.load();
    return { externalChats: document.externalChats.map((record) => ({ ...record })), bindings: document.bindings.map((record) => ({ ...record })) };
  }
  private load(): PersistedBindingState {
    if (this.cached) return this.cached;
    try {
      const document = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<PersistedBindingState>;
      if (document.version !== STORE_VERSION || !Array.isArray(document.externalChats) || !document.externalChats.every(isExternalChat)
        || !Array.isArray(document.bindings) || !document.bindings.every(isBinding)) this.cached = emptyState();
      else {
        const known = new Set(document.externalChats.map((record) => record.sessionId));
        const pinned = new Set(document.bindings.filter(isBinding).map((record) => record.sessionId));
        const pinnedCount = document.externalChats.filter((record) => pinned.has(record.sessionId)).length;
        const expendable = document.externalChats.filter((record) => !pinned.has(record.sessionId));
        const allowance = Math.max(0, this.maxExternalChats - pinnedCount);
        this.cached = {
          version: STORE_VERSION,
          externalChats: [...document.externalChats].sort((left, right) => right.lastAt - left.lastAt)
            .filter((record) => pinned.has(record.sessionId))
            .concat(expendable.sort((left, right) => right.lastAt - left.lastAt).slice(0, allowance))
            .sort((left, right) => right.lastAt - left.lastAt),
          bindings: document.bindings.filter((record) => known.has(record.sessionId)),
        };
      }
    } catch { this.cached = emptyState(); }
    return this.cached;
  }
  private persist(): void {
    this.needsWrite = true;
    const document = this.load();
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const staging = `${this.filePath}.tmp`;
    fs.writeFileSync(staging, JSON.stringify(document, null, 2), "utf8");
    fs.renameSync(staging, this.filePath);
    this.needsWrite = false;
    this.writtenAt = Date.now();
  }
}
let singleton: ChannelConversationBindingStore | null = null;
export function getChannelConversationBindingStore(): ChannelConversationBindingStore {
  if (!singleton) singleton = new ChannelConversationBindingStore(path.join(app.getPath("userData"), "channels", "context-bindings.json"));
  return singleton;
}
