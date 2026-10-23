import { createChannelMemoryAccountIdentity, type ChannelAdapter, type ChannelMemoryAccountIdentity } from "../base";
import type { ChannelCapability, ChannelStatus, IncomingMessage, MessageHandler, OutgoingMessage, OutgoingPart, } from "../../types";
import { loadChannelsSettings } from "../../settings-store";
import { OneBotActionClient } from "./onebot-action-client";
import { OneBotMediaManager, versionAtLeast, ONEBOT_STREAM_MIN_VERSION } from "./onebot-media";
import { normalizeOneBotMessage } from "./onebot-normalizer";
import { OneBotReverseWsServer, type OneBotListeningInfo } from "./onebot-reverse-ws";
import { isOneBotMessageEvent, oneBotId, type OneBotEvent, type OneBotLoginInfo, type OneBotSegment, type OneBotVersionInfo, } from "./onebot-types";
import type { QqChannelConfig } from "../../settings-store";

const CAPABILITY: ChannelCapability = { text: true, image: true, audio: true, file: true, video: true, markdown: false, card: false, sticker: true, maxTextLength: 0 };
export function splitQqText(text: string, maxCodepoints = 1500): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const pieces: string[] = [];
  let remaining = Array.from(trimmed);
  while (remaining.length > maxCodepoints) {
    const available = remaining.slice(0, maxCodepoints);
    let boundary = -1;
    for (let position = available.length - 1; position >= Math.floor(maxCodepoints * 0.55); position--) {
      if (/[。！？!?；;…\n]/u.test(available[position])) { boundary = position + 1; break; }
    }
    if (boundary < 0) boundary = maxCodepoints;
    pieces.push(available.slice(0, boundary).join("").trim());
    remaining = remaining.slice(boundary);
  }
  const ending = remaining.join("").trim();
  if (ending) pieces.push(ending);
  return pieces.filter(Boolean);
}
export function isQqEventAllowed(event: { message_type: "private" | "group"; user_id: string | number; group_id?: string | number; message: OneBotSegment[] }, config: QqChannelConfig, selfId: string): boolean {
  const author = oneBotId(event.user_id);
  if (event.message_type === "private") return config.allowedPrivateUserIds.includes(author);
  const room = oneBotId(event.group_id);
  if (!config.allowedGroupIds.includes(room)) return false;
  return !config.groupRequireMention || event.message.some((fragment) => fragment.type === "at" && oneBotId(fragment.data.qq) === selfId);
}
function delay(duration: number): Promise<void> { return new Promise((accept) => setTimeout(accept, duration)); }

export class NapCatAdapter implements ChannelAdapter {
  readonly id = "qq" as const;
  readonly displayName = "QQ（NapCat）";
  readonly capability = CAPABILITY;
  onMessage: MessageHandler | null = null;
  private readonly accountAuthority = createChannelMemoryAccountIdentity();
  private lifecycleEpoch = 0;
  private peerEpoch = 0;
  private listener: OneBotReverseWsServer | null = null;
  private actionConnection: OneBotActionClient | null = null;
  private mediaFiles = new OneBotMediaManager(() => this.actionConnection, undefined, () => {
    this.streamCapable = false;
    this.setStatus({ enabled: true, phase: "running", message: `NapCat Stream API 不可用；请升级到 ${ONEBOT_STREAM_MIN_VERSION}+`, detail: this.statusDetail() });
  });
  private connectionStatus: ChannelStatus = { enabled: false, phase: "offline", message: "未启用" };
  private accountId = "";
  private accountLabel = "";
  private napcatVersion = "";
  private streamCapable = false;
  private binding: OneBotListeningInfo | null = null;
  private recentMessages = new Map<string, number>();
  constructor(private readonly onStatusChanged?: () => void) {}
  async start(): Promise<void> {
    const epoch = ++this.lifecycleEpoch;
    this.peerEpoch++;
    this.accountAuthority.revoke();
    this.actionConnection = null;
    this.accountId = "";
    const settings = loadChannelsSettings().qq;
    if (!settings.enabled) { this.setStatus({ enabled: false, phase: "offline", message: "未启用" }); return; }
    this.setStatus({ enabled: true, phase: "starting", message: "正在启动 OneBot 监听" });
    await this.mediaFiles.start();
    if (epoch !== this.lifecycleEpoch) return;
    this.listener = new OneBotReverseWsServer({
      listenMode: settings.listenMode, customHost: settings.customHost, port: settings.port, accessToken: settings.accessToken,
      onEvent: (payload, connection) => { if (epoch === this.lifecycleEpoch) return this.handleEvent(payload, connection); },
      onClientConnected: (connection, handshake) => { if (epoch === this.lifecycleEpoch) return this.handleConnected(connection, handshake.headerSelfId); },
      onClientDisconnected: () => {
        if (epoch !== this.lifecycleEpoch) return;
        this.peerEpoch++;
        this.accountAuthority.revoke(); this.actionConnection = null; this.accountId = "";
        this.setStatus({ enabled: true, phase: "starting", message: "监听中，等待 NapCat 重连", detail: this.statusDetail() });
      },
      onError: (failure) => {
        if (epoch !== this.lifecycleEpoch) return;
        this.setStatus({ enabled: true, phase: "error", message: failure.message, detail: this.statusDetail() });
      },
    });
    const listener = this.listener;
    try {
      const binding = await listener.start();
      if (epoch !== this.lifecycleEpoch) { await listener.stop(); return; }
      this.binding = binding;
      this.setStatus({ enabled: true, phase: "starting", message: "监听中，等待 NapCat 连接", detail: this.statusDetail() });
    } catch (failure) {
      if (epoch !== this.lifecycleEpoch) return;
      this.accountAuthority.revoke(); this.mediaFiles.stop(); this.listener = null;
      const diagnostic = failure instanceof Error ? failure.message : String(failure);
      this.setStatus({ enabled: true, phase: "error", message: diagnostic });
      throw failure;
    }
  }
  async stop(): Promise<void> {
    this.lifecycleEpoch++; this.peerEpoch++; this.accountAuthority.revoke(); this.mediaFiles.stop();
    const listener = this.listener;
    this.listener = null; this.actionConnection = null; this.accountId = ""; this.accountLabel = ""; this.napcatVersion = "";
    this.streamCapable = false; this.binding = null; this.recentMessages.clear();
    this.setStatus({ enabled: false, phase: "offline", message: "已停止" });
    await listener?.stop();
  }
  getMemoryAccountIdentity(): ChannelMemoryAccountIdentity | null {
    if (!loadChannelsSettings().qq.enabled || !this.actionConnection || !this.accountId) this.accountAuthority.revoke();
    return this.accountAuthority.read();
  }
  getStatus(): ChannelStatus {
    const settings = loadChannelsSettings().qq;
    return !settings.enabled ? { enabled: false, phase: "offline", message: "未启用" } : this.connectionStatus;
  }
  getConnectionInfo(): Record<string, unknown> { return this.statusDetail(); }
  async testConnection(): Promise<{ ok: boolean; error?: string; detail?: Record<string, unknown> }> {
    if (!this.actionConnection || !this.accountId) return { ok: false, error: "NapCat 尚未连接" };
    try {
      const protocol = await this.actionConnection.call<Record<string, unknown>>("get_status");
      return { ok: true, detail: { ...this.statusDetail(), protocolStatus: protocol } };
    } catch (failure) { return { ok: false, error: failure instanceof Error ? failure.message : String(failure) }; }
  }
  async send(msg: OutgoingMessage): Promise<{ ok: boolean; error?: string }> {
    const connection = this.actionConnection;
    if (!connection || !this.accountId) return { ok: false, error: "NapCat 未连接" };
    const batches: OneBotSegment[][] = [];
    let diagnostic: string | undefined;
    for (const fragment of msg.parts) {
      try { batches.push(...await this.partToPayloads(fragment)); }
      catch (failure) { diagnostic = failure instanceof Error ? failure.message : String(failure); }
    }
    if (batches.length === 0) return { ok: false, error: diagnostic || "没有可发送的 QQ 内容" };
    let delivered = 0;
    for (let position = 0; position < batches.length; position++) {
      const fragments = [...batches[position]];
      if (position === 0 && msg.chatType === "group" && msg.replyContext) {
        const quotation: OneBotSegment[] = [{ type: "reply", data: { id: msg.replyContext.messageId } }];
        if (msg.replyContext.mentionUserId) quotation.push({ type: "at", data: { qq: msg.replyContext.mentionUserId } }, { type: "text", data: { text: " " } });
        fragments.unshift(...quotation);
      }
      try {
        if (msg.chatType === "group") await connection.call("send_group_msg", { group_id: msg.targetId, message: fragments });
        else await connection.call("send_private_msg", { user_id: msg.targetId, message: fragments });
        delivered++;
      } catch (failure) { diagnostic = failure instanceof Error ? failure.message : String(failure); }
      if (position < batches.length - 1) await delay(500);
    }
    if (delivered > 0 && diagnostic) console.warn("[NapCatAdapter] QQ 消息部分发送失败:", diagnostic);
    return delivered > 0 ? { ok: true } : { ok: false, error: diagnostic || "QQ 发送失败" };
  }
  private async handleConnected(connection: OneBotActionClient, headerSelfId?: string): Promise<void> {
    const epoch = this.lifecycleEpoch;
    const session = ++this.peerEpoch;
    this.accountAuthority.revoke(); this.actionConnection = null; this.accountId = "";
    const account = await connection.call<OneBotLoginInfo>("get_login_info");
    if (epoch !== this.lifecycleEpoch || session !== this.peerEpoch) return;
    const implementation = await connection.call<OneBotVersionInfo>("get_version_info");
    if (epoch !== this.lifecycleEpoch || session !== this.peerEpoch) return;
    const identifier = oneBotId(account.user_id);
    if (!identifier) throw new Error("NapCat get_login_info 未返回 user_id");
    if (headerSelfId && headerSelfId !== identifier) throw new Error("NapCat X-Self-ID 与 get_login_info 不一致");
    this.actionConnection = connection; this.accountId = identifier; this.accountAuthority.authenticate(`qq:${identifier}`);
    this.accountLabel = account.nickname ?? ""; this.napcatVersion = implementation.app_version ?? "";
    this.streamCapable = versionAtLeast(this.napcatVersion, ONEBOT_STREAM_MIN_VERSION);
    this.setStatus({ enabled: true, phase: "running", message: this.streamCapable ? "NapCat 已连接" : `NapCat 已连接；媒体流需要 ${ONEBOT_STREAM_MIN_VERSION}+`, detail: this.statusDetail() });
  }
  private async handleEvent(payload: OneBotEvent, connection: OneBotActionClient): Promise<void> {
    if (connection !== this.actionConnection) return;
    if (!isOneBotMessageEvent(payload) || payload.post_type !== "message") return;
    if (!this.accountId || oneBotId(payload.self_id) !== this.accountId || oneBotId(payload.user_id) === this.accountId) return;
    const settings = loadChannelsSettings().qq;
    const author = oneBotId(payload.user_id);
    const room = payload.message_type === "group" ? oneBotId(payload.group_id) : author;
    if (!room) return;
    if (!isQqEventAllowed(payload, settings, this.accountId)) return;
    const identifier = `${this.accountId}:${oneBotId(payload.message_id)}`;
    const instant = Date.now();
    for (const [key, expiration] of this.recentMessages) if (expiration <= instant) this.recentMessages.delete(key);
    if (this.recentMessages.has(identifier)) return;
    this.recentMessages.set(identifier, instant + 10 * 60_000);
    const session = this.peerEpoch;
    try {
      const incoming = await normalizeOneBotMessage(payload, { selfId: this.accountId, client: connection, media: this.mediaFiles, supportsStream: this.streamCapable });
      if (connection !== this.actionConnection || session !== this.peerEpoch) return;
      await this.onMessage?.(incoming);
    } catch (failure) { console.warn("[NapCatAdapter] QQ 消息处理失败:", failure instanceof Error ? failure.message : String(failure)); }
  }
  private async partToPayloads(fragment: OutgoingPart): Promise<OneBotSegment[][]> {
    switch (fragment.kind) {
      case "text": return splitQqText(fragment.text).map((content) => [{ type: "text", data: { text: content } }]);
      case "card": {
        const content = [fragment.title, fragment.markdown, ...(fragment.fields ?? []).map((entry) => `${entry.key}: ${entry.value}`)].filter(Boolean).join("\n");
        return splitQqText(content).map((chunk) => [{ type: "text", data: { text: chunk } }]);
      }
      case "image": {
        const encoded = fragment.filePath ? await this.mediaFiles.encodeOutbound(fragment.filePath, "image", this.streamCapable) : fragment.url;
        if (!encoded) throw new Error("QQ 图片缺少 filePath/url");
        return [[{ type: "image", data: { file: encoded } }]];
      }
      case "sticker": return [[{ type: "image", data: { file: await this.mediaFiles.encodeOutbound(fragment.imagePath, "image", this.streamCapable) } }]];
      case "audio": return [[{ type: "record", data: { file: await this.mediaFiles.encodeOutbound(fragment.filePath, "audio", this.streamCapable) } }]];
      case "file": {
        const encoded = await this.mediaFiles.encodeOutbound(fragment.filePath, "file", this.streamCapable);
        return [[{ type: "file", data: { file: encoded, name: fragment.name } }]];
      }
      default: return [[{ type: "video", data: { file: await this.mediaFiles.encodeOutbound(fragment.filePath, "video", this.streamCapable) } }]];
    }
  }
  private statusDetail(): Record<string, unknown> {
    return { listenUrl: this.binding?.url, listenHost: this.binding?.host, listenMode: this.binding?.mode,
      selfId: this.accountId || undefined, nickname: this.accountLabel || undefined, appVersion: this.napcatVersion || undefined,
      supportsStream: this.streamCapable, streamMinimumVersion: ONEBOT_STREAM_MIN_VERSION };
  }
  private setStatus(value: ChannelStatus): void { this.connectionStatus = value; this.onStatusChanged?.(); }
}
