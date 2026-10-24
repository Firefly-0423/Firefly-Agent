import * as fs from "node:fs";
import * as path from "node:path";
import { app } from "electron";
import { createChannelMemoryAccountIdentity, type ChannelAdapter, type ChannelMemoryAccountIdentity } from "../base";
import type { ChannelAttachment, ChannelCapability, ChannelStatus, IncomingMessage, MessageHandler, OutgoingMessage, OutgoingPart, } from "../../types";
import { loadChannelsSettings, type QqBotChannelConfig } from "../../settings-store";
import { QqBotApiClient, QqBotApiError } from "./qqbot-api-client";
import { QqBotWsClient, type QqBotEventType } from "./qqbot-ws-client";
import { splitQqText } from "../qq/napcat-adapter";

const CAPABILITY: ChannelCapability = { text: true, image: false, audio: false, file: false, video: false, markdown: false, card: false, sticker: false, maxTextLength: 0 };
type InboundReplyContext = { seqUsed: number; receivedAt: number; chatType: "private" | "group"; messageId: string };
const REPLY_WINDOW_MS = { private: 60 * 60_000, group: 5 * 60_000 } as const;
const REPLY_SEQ_LIMIT = { private: 4, group: 5 } as const;
export function isQqBotEventAllowed(data: { chatType: "private" | "group"; senderId: string; chatId: string }, config: QqBotChannelConfig): boolean {
  return data.chatType === "private" ? config.allowAnyPrivate || config.allowedUserOpenids.includes(data.senderId) : config.allowedGroupOpenids.includes(data.chatId);
}
function parseTimestamp(source: string): Date {
  if (source) { const instant = Date.parse(source); if (Number.isFinite(instant)) return new Date(instant); }
  return new Date();
}
function parseAttachments(source: unknown): ChannelAttachment[] {
  if (!Array.isArray(source)) return [];
  const media: ChannelAttachment[] = [];
  for (const entry of source) {
    const descriptor = (entry ?? {}) as Record<string, unknown>;
    const contentType = String(descriptor.content_type ?? "");
    const address = String(descriptor.voice_wav_url ?? descriptor.url ?? "");
    if (!address) continue;
    let category: ChannelAttachment["kind"] = "file";
    if (contentType.startsWith("image/")) category = "image";
    else if (contentType === "voice") category = "audio";
    else if (contentType.startsWith("video/")) category = "video";
    media.push({ kind: category, url: address, mime: contentType || undefined, caption: typeof descriptor.filename === "string" && descriptor.filename ? descriptor.filename : undefined });
  }
  return media;
}
export function normalizeQqBotEvent(type: QqBotEventType, data: Record<string, unknown>): IncomingMessage | null {
  if (type !== "C2C_MESSAGE_CREATE" && type !== "GROUP_AT_MESSAGE_CREATE" && type !== "GROUP_MESSAGE_CREATE") return null;
  const author = (data.author ?? {}) as Record<string, unknown>;
  const grouped = type !== "C2C_MESSAGE_CREATE";
  const person = String(author[grouped ? "member_openid" : "user_openid"] ?? "");
  const room = grouped ? String(data.group_openid ?? "") : person;
  if (!person || !room) return null;
  const words = String(data.content ?? "").trim();
  const media = parseAttachments(data.attachments);
  if (!words && media.length === 0) return null;
  const timestamp = parseTimestamp(String(data.timestamp ?? ""));
  return { channel: "qqbot", chatType: grouped ? "group" : "private", messageId: String(data.id ?? ""), senderId: person,
    senderName: typeof author.username === "string" && author.username ? author.username : undefined,
    chatId: room, text: words, attachments: media.length > 0 ? media : undefined, at: timestamp, _raw: data };
}

export class QqBotAdapter implements ChannelAdapter {
  readonly id = "qqbot" as const;
  readonly displayName = "QQ 机器人（官方）";
  readonly capability = CAPABILITY;
  onMessage: MessageHandler | null = null;
  private readonly accountAuthority = createChannelMemoryAccountIdentity();
  private restClient: QqBotApiClient | null = null;
  private lifecycleEpoch = 0;
  private authenticatedAppId = "";
  private gateway: QqBotWsClient | null = null;
  private connectionStatus: ChannelStatus = { enabled: false, phase: "offline", message: "未启用" };
  private accountLabel = "";
  private authenticated = false;
  private rejectedSender: { openid: string; chatType: "private" | "group"; at: number } | null = null;
  private recentMessages = new Map<string, number>();
  private replyWindows = new Map<string, InboundReplyContext>();
  constructor(private readonly onStatusChanged?: () => void) {}
  async start(): Promise<void> {
    const epoch = ++this.lifecycleEpoch;
    this.accountAuthority.revoke(); this.authenticatedAppId = ""; this.authenticated = false;
    const settings = loadChannelsSettings().qqbot;
    if (!settings.enabled) { this.setStatus({ enabled: false, phase: "offline", message: "未启用" }); return; }
    if (!settings.appId || !settings.appSecret) { this.setStatus({ enabled: true, phase: "config_missing", message: "缺少 AppID / AppSecret，请到 q.qq.com 创建机器人后填写" }); return; }
    this.setStatus({ enabled: true, phase: "starting", message: "正在连接 QQ 开放平台网关" });
    const identifier = settings.appId;
    this.authenticatedAppId = identifier;
    const connection = new QqBotApiClient({ appId: identifier, clientSecret: settings.appSecret });
    this.restClient = connection;
    try {
      const address = await connection.getGatewayUrl();
      if (epoch !== this.lifecycleEpoch) return;
      this.gateway = new QqBotWsClient({
        gatewayUrl: address, getAccessToken: () => connection.getAccessToken(),
        onDispatch: (event, payload) => { if (epoch === this.lifecycleEpoch) this.handleDispatch(event, payload); },
        onReadyChange: (authenticated) => {
          if (epoch !== this.lifecycleEpoch) return;
          this.authenticated = authenticated;
          if (authenticated) this.accountAuthority.authenticate(`qqbot:${identifier}`);
          else this.accountAuthority.revoke();
          this.setStatus({ enabled: true, phase: authenticated ? "running" : "starting",
            message: authenticated ? `网关已连接${this.accountLabel ? `（${this.accountLabel}）` : ""}` : "网关重连中", detail: this.statusDetail() });
        },
        onError: (failure) => {
          if (epoch !== this.lifecycleEpoch) return;
          if (this.connectionStatus.phase === "running" && !this.authenticated) return;
          this.setStatus({ enabled: true, phase: this.gateway?.isReady ? "running" : "error", message: failure.message, detail: this.statusDetail() });
        },
      });
      await this.gateway.start();
    } catch (failure) {
      if (epoch !== this.lifecycleEpoch) return;
      this.accountAuthority.revoke();
      const diagnostic = failure instanceof Error ? failure.message : String(failure);
      this.setStatus({ enabled: true, phase: "error", message: diagnostic });
      throw failure;
    }
  }
  async stop(): Promise<void> {
    this.lifecycleEpoch++; this.accountAuthority.revoke(); this.authenticatedAppId = "";
    const connection = this.gateway;
    this.gateway = null; this.restClient = null; this.authenticated = false; this.accountLabel = ""; this.rejectedSender = null;
    this.recentMessages.clear(); this.replyWindows.clear();
    this.setStatus({ enabled: false, phase: "offline", message: "已停止" });
    await connection?.stop();
  }
  getMemoryAccountIdentity(): ChannelMemoryAccountIdentity | null {
    const settings = loadChannelsSettings().qqbot;
    if (!settings.enabled || settings.appId !== this.authenticatedAppId || !settings.appSecret || !this.authenticated) this.accountAuthority.revoke();
    return this.accountAuthority.read();
  }
  getStatus(): ChannelStatus {
    const settings = loadChannelsSettings().qqbot;
    return !settings.enabled ? { enabled: false, phase: "offline", message: "未启用" } : this.connectionStatus;
  }
  async testConnection(): Promise<{ ok: boolean; error?: string; detail?: Record<string, unknown> }> {
    const settings = loadChannelsSettings().qqbot;
    if (!settings.appId || !settings.appSecret) return { ok: false, error: "AppID / AppSecret 未配置" };
    try {
      const connection = new QqBotApiClient({ appId: settings.appId, clientSecret: settings.appSecret });
      await connection.getGatewayUrl();
      return { ok: true, detail: { appId: settings.appId } };
    } catch (failure) {
      const diagnostic = failure instanceof QqBotApiError ? failure : failure instanceof Error ? failure : new Error(String(failure));
      return { ok: false, error: diagnostic.message };
    }
  }
  async send(msg: OutgoingMessage): Promise<{ ok: boolean; error?: string }> {
    const connection = this.restClient;
    if (!connection || !this.authenticated) return { ok: false, error: "QQ 机器人网关未连接" };
    const category = msg.chatType ?? "private";
    const request = this.replyWindows.get(msg.targetId);
    if (!request) return { ok: false, error: "官方 QQ Bot 仅支持被动回复（没有可引用的入站消息）" };
    const window = REPLY_WINDOW_MS[category];
    if (Date.now() - request.receivedAt > window) return { ok: false, error: `被动回复窗口已过（${category === "private" ? "60 分钟" : "5 分钟"}）` };
    const limit = REPLY_SEQ_LIMIT[category];
    if (request.seqUsed >= limit) return { ok: false, error: `该消息回复次数已达上限（${limit} 次）` };
    const paragraphs: string[] = [];
    let diagnostic: string | undefined;
    for (const fragment of msg.parts) {
      try { paragraphs.push(...this.partToChunks(fragment)); }
      catch (failure) { diagnostic = failure instanceof Error ? failure.message : String(failure); }
    }
    if (paragraphs.length === 0) return { ok: false, error: diagnostic || "没有可发送的 QQ Bot 内容" };
    let delivered = 0;
    for (const paragraph of paragraphs) {
      if (request.seqUsed >= limit) { diagnostic = `回复次数达上限，余下 ${paragraphs.length - delivered} 段未发送`; break; }
      request.seqUsed++;
      try {
        await connection.sendText({ openid: msg.targetId, chatType: category }, paragraph, { msgId: request.messageId, msgSeq: request.seqUsed });
        delivered++;
      } catch (failure) { diagnostic = failure instanceof Error ? failure.message : String(failure); }
    }
    if (delivered > 0 && diagnostic) console.warn("[QqBotAdapter] QQ Bot 消息部分发送失败:", diagnostic);
    return delivered > 0 ? { ok: true } : { ok: false, error: diagnostic || "QQ Bot 发送失败" };
  }
  getConnectionInfo(): Record<string, unknown> { return this.statusDetail(); }
  private handleDispatch(event: QqBotEventType, payload: Record<string, unknown>): void {
    if (event === "READY") {
      const account = (payload.user ?? {}) as Record<string, unknown>;
      this.accountLabel = typeof account.username === "string" ? account.username : "";
      return;
    }
    const message = normalizeQqBotEvent(event, payload);
    if (!message) return;
    const settings = loadChannelsSettings().qqbot;
    if (!isQqBotEventAllowed({ chatType: message.chatType ?? "private", senderId: message.senderId, chatId: message.chatId }, settings)) {
      this.rejectedSender = { openid: message.chatType === "group" ? message.chatId : message.senderId, chatType: message.chatType ?? "private", at: Date.now() };
      this.setStatus({ ...this.connectionStatus, detail: this.statusDetail() }); return;
    }
    const identifier = `${message.messageId}`;
    if (identifier) {
      const instant = Date.now();
      for (const [key, expiration] of this.recentMessages) if (expiration <= instant) this.recentMessages.delete(key);
      if (this.recentMessages.has(identifier)) return;
      this.recentMessages.set(identifier, instant + 10 * 60_000);
    }
    if (message.messageId) this.replyWindows.set(message.chatId, { messageId: message.messageId, chatType: message.chatType ?? "private", receivedAt: Date.now(), seqUsed: 0 });
    void this.deliverIncoming(message);
  }
  private async deliverIncoming(message: IncomingMessage): Promise<void> {
    const epoch = this.lifecycleEpoch;
    try {
      await this.downloadAttachments(message);
      if (epoch !== this.lifecycleEpoch) return;
      await this.onMessage?.(message);
    } catch (failure) { console.warn("[QqBotAdapter] QQ Bot 消息处理失败:", failure instanceof Error ? failure.message : String(failure)); }
  }
  private partToChunks(fragment: OutgoingPart): string[] {
    if (fragment.kind === "text") return splitQqText(fragment.text);
    if (fragment.kind !== "card") throw new Error(`QQ Bot 官方渠道暂不支持发送 ${fragment.kind} 类型内容`);
    const content = [fragment.title, fragment.markdown, ...(fragment.fields ?? []).map((entry) => `${entry.key}: ${entry.value}`)].filter(Boolean).join("\n");
    return splitQqText(content);
  }
  private async downloadAttachments(message: IncomingMessage): Promise<void> {
    if (!message.attachments?.length) return;
    const directory = path.join(app.getPath("userData"), "channels", "cache", "qqbot");
    fs.mkdirSync(directory, { recursive: true });
    for (const media of message.attachments) {
      if (!media.url) continue;
      try {
        const received = await fetch(media.url);
        if (!received.ok || !received.body) throw new Error(`HTTP ${received.status}`);
        const reader = received.body.getReader();
        const buffers: Uint8Array[] = [];
        let occupied = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          occupied += value.byteLength;
          if (occupied > 8 * 1024 * 1024) { await reader.cancel().catch(() => undefined); throw new Error("附件超过 8 MiB 限制"); }
          buffers.push(value);
        }
        const suffix = media.kind === "image" ? (media.mime?.split("/")[1] ?? "jpg") : media.kind === "audio" ? "wav" : media.kind === "video" ? "mp4" : "bin";
        const filename = path.join(directory, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${suffix}`);
        fs.writeFileSync(filename, Buffer.concat(buffers));
        media.filePath = filename; media.url = undefined;
      } catch (failure) { console.warn("[QqBotAdapter] 附件下载失败（保留 URL 占位）:", failure instanceof Error ? failure.message : String(failure)); }
    }
  }
  private statusDetail(): Record<string, unknown> {
    return { appId: loadChannelsSettings().qqbot.appId || undefined, botNickname: this.accountLabel || undefined, wsReady: this.authenticated,
      lastRejectedOpenid: this.rejectedSender?.openid, lastRejectedChatType: this.rejectedSender?.chatType,
      lastRejectedAt: this.rejectedSender ? new Date(this.rejectedSender.at).toISOString() : undefined };
  }
  private setStatus(value: ChannelStatus): void { this.connectionStatus = value; this.onStatusChanged?.(); }
}
