import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import { createLarkChannel, Domain, LoggerLevel, type LarkChannel, type NormalizedMessage, type SendInput, type EventName, } from "@larksuiteoapi/node-sdk";
import { createChannelMemoryAccountIdentity, type ChannelAdapter, type ChannelMemoryAccountIdentity } from "../base";
import type { ChannelCapability, ChannelStatus, IncomingMessage, MessageHandler, OutgoingMessage, OutgoingPart, } from "../../types";
import { loadChannelsSettings } from "../../settings-store";
import { admitSender } from "../../sender-gate";
import { getAudioDurationMs } from "./audio-duration";
import { logger, LogTag } from "../../../logging/logger";

export { transcodeAudioFileToFeishuOpus } from "./audio-transcode";
const LOG = "[FeishuAdapter]";
const FEISHU_CAPABILITY: ChannelCapability = { text: true, image: true, audio: true, file: true, video: true, markdown: true, card: true, sticker: true, maxTextLength: 4000 };
function resourceKindToExt(category: string): { ext: string; mime: string } {
  if (category === "image" || category === "sticker") return { ext: ".png", mime: "image/png" };
  if (category === "audio") return { ext: ".mp3", mime: "audio/mpeg" };
  if (category === "video") return { ext: ".mp4", mime: "video/mp4" };
  return { ext: ".bin", mime: "application/octet-stream" };
}
async function downloadLarkResource(connection: LarkChannel, messageId: string, fileKey: string, kind: string): Promise<string | null> {
  const directory = path.join(app.getPath("userData"), "channels", "cache");
  fs.mkdirSync(directory, { recursive: true });
  const suffix = resourceKindToExt(kind).ext;
  const keyEnding = fileKey.slice(-8);
  const filename = path.join(directory, `feishu-${messageId}-${keyEnding}${suffix}`);
  if (fs.existsSync(filename)) return filename;
  try {
    const category = (kind === "file" || kind === "audio" || kind === "video") ? "file" : "image";
    const resource = await connection.rawClient.im.v1.messageResource.get({ path: { message_id: messageId, file_key: fileKey }, params: { type: category } });
    if (resource && typeof resource.writeFile === "function") await resource.writeFile(filename);
    else {
      const readable = resource.getReadableStream();
      const buffers: Buffer[] = [];
      await new Promise<void>((accept, fail) => {
        readable.on("data", (bytes: Buffer) => buffers.push(bytes));
        readable.on("end", () => accept());
        readable.on("error", (failure: Error) => fail(failure));
      });
      fs.writeFileSync(filename, Buffer.concat(buffers));
    }
    const metadata = fs.statSync(filename);
    console.log(LOG, `已下载飞书资源 → ${filename} (${metadata.size} bytes, kind=${kind})`);
    return filename;
  } catch (failure) {
    console.warn(LOG, `下载飞书资源失败: messageId=${messageId} fileKey=${fileKey} err=`, failure instanceof Error ? failure.message : failure);
    return null;
  }
}
async function normalizeLarkMessage(connection: LarkChannel, message: NormalizedMessage): Promise<IncomingMessage> {
  let content = "";
  const category = message.rawContentType ?? "text";
  const media: IncomingMessage["attachments"] = [];
  if (category === "text") {
    try { content = (JSON.parse(message.content) as { text?: string }).text ?? message.content; }
    catch { content = message.content; }
  } else if (category === "image" || category === "file" || category === "audio" || category === "video" || category === "sticker") {
    for (const resource of message.resources ?? []) {
      const filename = await downloadLarkResource(connection, message.messageId, resource.fileKey, resource.type);
      if (!filename) continue;
      const mime = resourceKindToExt(resource.type).mime;
      media.push({ kind: resource.type === "sticker" ? "image" : resource.type as "image" | "file" | "audio" | "video", filePath: filename, mime, caption: resource.fileName });
      if (!content) content = `[${category}]`;
      content = (content ? content + "\n" : "") + `[附件: ${filename}]`;
    }
    if (media.length === 0) content = `[${category}]`;
  } else content = `[${category}]`;
  return { channel: "feishu", senderId: message.senderId ?? "", senderName: message.senderName, chatId: message.chatId, threadId: message.threadId,
    text: content, attachments: media.length > 0 ? media : undefined, at: new Date(message.createTime ?? Date.now()), _raw: message };
}
async function sendLark(connection: LarkChannel, targetId: string, fragment: OutgoingPart): Promise<{ messageId: string } | null> {
  let payload: SendInput | undefined;
  switch (fragment.kind) {
    case "text": payload = { text: fragment.text } as SendInput; break;
    case "image":
      if (fragment.filePath) payload = { image: { source: fragment.filePath } } as SendInput;
      else if (fragment.url) throw new Error("image URL 需要先下载到本地 filePath");
      else throw new Error("image part needs filePath or url");
      break;
    case "audio":
      if (fragment.mime === "audio/ogg" || path.extname(fragment.filePath).toLowerCase() === ".opus") payload = { audio: { source: fragment.filePath } } as SendInput;
      else {
        const measured = await getAudioDurationMs(fragment.filePath);
        console.log("[Feishu audio] send file:", fragment.filePath, "duration:", measured, "mime:", fragment.mime);
        if (!measured) throw new Error(`无法解析音频时长: ${fragment.filePath}`);
        payload = { audio: { source: fragment.filePath, duration: measured } } as SendInput;
      }
      break;
    case "file": payload = { file: { source: fragment.filePath, fileName: fragment.name || path.basename(fragment.filePath) } }; break;
    case "video": payload = { video: { source: fragment.filePath } }; break;
    case "card": payload = { card: {
      schema: "2.0", header: { title: { tag: "plain_text", content: fragment.title }, template: "blue" },
      elements: [{ tag: "div", text: { tag: "lark_md", content: fragment.markdown ?? "" } },
        ...(fragment.fields && fragment.fields.length > 0 ? [{ tag: "div", fields: fragment.fields.map((entry) => ({ is_short: true, text: { tag: "lark_md", content: `**${entry.key}**\n${entry.value}` } })) }] : [])],
    } } as unknown as SendInput; break;
    case "sticker": payload = { image: { source: fragment.imagePath } } as SendInput; break;
  }
  const receipt = payload ? (await connection.send(targetId, payload)) ?? null : null;
  if (!receipt || typeof receipt.messageId !== "string" || !receipt.messageId.trim()) throw new Error("飞书发送未返回有效消息回执");
  return receipt;
}

export class FeishuAdapter implements ChannelAdapter {
  readonly id = "feishu" as const;
  readonly displayName = "飞书";
  readonly capability = FEISHU_CAPABILITY;
  onMessage: MessageHandler | null = null;
  private readonly accountAuthority = createChannelMemoryAccountIdentity();
  private channel: LarkChannel | null = null;
  private lifecycleEpoch = 0;
  private authenticatedAppId = "";
  private connectionStatus: ChannelStatus = { enabled: false, phase: "config_missing" };
  private reconnectDeadline: NodeJS.Timeout | null = null;
  constructor() {}
  private async rebuildChannel(): Promise<LarkChannel | null> {
    const config = loadChannelsSettings().feishu;
    if (!config.enabled) { this.connectionStatus = { enabled: false, phase: "offline", message: "未启用" }; return null; }
    if (!config.appId || !config.appSecret) { this.connectionStatus = { enabled: true, phase: "config_missing", message: "App ID / App Secret 缺失" }; return null; }
    const identifier = config.appId;
    this.authenticatedAppId = identifier;
    const connection = createLarkChannel({ appId: identifier, appSecret: config.appSecret, domain: Domain.Feishu, loggerLevel: LoggerLevel.warn, transport: "websocket" });
    connection.on("message" as EventName, async (message: NormalizedMessage) => {
      if (this.channel !== connection) return;
      if (message.chatType !== "p2p") { console.log(LOG, `忽略 ${message.chatType} 消息 (私聊优先)`); return; }
      let rules: ReturnType<typeof loadChannelsSettings>["feishu"] | null = null;
      try { rules = loadChannelsSettings().feishu; }
      catch (failure) { console.warn(LOG, "读取发送者白名单失败，按拒绝处理:", failure); }
      if (!admitSender("feishu", rules, message.senderId ?? "", message.senderName)) { console.warn(LOG, "陌生发送者已拦截，等待在设置中批准"); return; }
      try {
        const incoming = await normalizeLarkMessage(connection, message);
        if (this.channel === connection && this.onMessage) await this.onMessage(incoming);
      } catch (failure) { console.error(LOG, "处理入站消息失败:", failure); }
    });
    connection.on("error" as EventName, (failure: unknown) => {
      if (this.channel !== connection) return;
      const diagnostic = failure instanceof Error ? failure.message : String(failure);
      console.error(LOG, "channel error:", diagnostic);
      this.connectionStatus = { enabled: true, phase: "error", message: diagnostic };
    });
    connection.on("reconnecting" as EventName, () => {
      if (this.channel !== connection) return;
      this.accountAuthority.revoke(); console.log(LOG, "reconnecting…");
      this.connectionStatus = { enabled: true, phase: "starting", message: "重新连接中" };
    });
    connection.on("reconnected" as EventName, () => {
      if (this.channel !== connection) return;
      this.accountAuthority.authenticate(`feishu:${identifier}`); console.log(LOG, "reconnected");
      this.connectionStatus = { enabled: true, phase: "running", message: "已连接" };
    });
    this.channel = connection;
    return connection;
  }
  async start(): Promise<void> {
    const epoch = ++this.lifecycleEpoch;
    this.accountAuthority.revoke(); this.authenticatedAppId = ""; this.clearConnectRetryTimer();
    const connection = await this.rebuildChannel();
    if (!connection || epoch !== this.lifecycleEpoch || this.channel !== connection) return;
    try {
      await connection.connect();
      if (epoch !== this.lifecycleEpoch || this.channel !== connection) { await connection.disconnect(); return; }
      this.accountAuthority.authenticate(`feishu:${this.authenticatedAppId}`);
      this.connectionStatus = { enabled: true, phase: "running", message: "长连接已建立" };
      logger.info(LogTag.Feishu, "WS long connection ready");
    } catch (failure) {
      if (epoch !== this.lifecycleEpoch || this.channel !== connection) return;
      this.accountAuthority.revoke();
      const diagnostic = failure instanceof Error ? failure.message : String(failure);
      console.error(LOG, "connect() failed:", diagnostic);
      this.connectionStatus = { enabled: true, phase: "error", message: diagnostic };
      this.scheduleConnectRetry();
    }
  }
  private scheduleConnectRetry(): void {
    if (this.reconnectDeadline) return;
    console.warn(LOG, "30 秒后自动重建连接");
    const epoch = this.lifecycleEpoch;
    this.reconnectDeadline = setTimeout(() => {
      this.reconnectDeadline = null;
      if (epoch !== this.lifecycleEpoch || !loadChannelsSettings().feishu.enabled) return;
      void this.rebuild();
    }, 30_000);
  }
  private clearConnectRetryTimer(): void { if (this.reconnectDeadline) { clearTimeout(this.reconnectDeadline); this.reconnectDeadline = null; } }
  async stop(): Promise<void> {
    this.lifecycleEpoch++; this.accountAuthority.revoke(); this.authenticatedAppId = ""; this.clearConnectRetryTimer();
    const connection = this.channel;
    this.channel = null; this.connectionStatus = { enabled: false, phase: "offline", message: "已停止" };
    if (connection) { try { await connection.disconnect(); } catch (failure) { console.warn(LOG, "disconnect 失败:", failure); } }
  }
  getMemoryAccountIdentity(): ChannelMemoryAccountIdentity | null {
    const config = loadChannelsSettings().feishu;
    const connectionState = this.channel?.getConnectionStatus?.()?.state;
    if (!config.enabled || config.appId !== this.authenticatedAppId || !config.appSecret || !this.channel || (connectionState !== undefined && connectionState !== "connected")) this.accountAuthority.revoke();
    return this.accountAuthority.read();
  }
  getStatus(): ChannelStatus {
    const config = loadChannelsSettings().feishu;
    if (!config.enabled) return { enabled: false, phase: "offline", message: "未启用" };
    if (!config.appId || !config.appSecret) return { enabled: true, phase: "config_missing", message: "App ID/Secret 缺失" };
    return this.connectionStatus;
  }
  async send(msg: OutgoingMessage): Promise<{ ok: boolean; error?: string }> {
    if (!this.channel) { console.warn(LOG, "send 失败: 长连接未建立"); return { ok: false, error: "飞书长连接未建立" }; }
    if (!msg.parts || msg.parts.length === 0) return { ok: false, error: "没有可发送的内容" };
    console.log(LOG, `send: targetId=${msg.targetId} parts=${msg.parts.length}`);
    let diagnostic: string | undefined;
    let delivered = false;
    for (const fragment of msg.parts) {
      try {
        const receipt = await sendLark(this.channel, msg.targetId, fragment);
        console.log(LOG, `send ok: messageId=${receipt?.messageId ?? "?"}`);
        delivered = true;
      } catch (failure) {
        diagnostic = failure instanceof Error ? failure.message : String(failure);
        console.error(LOG, `send part failed: targetId=${msg.targetId} part=${fragment.kind} err=`, diagnostic, failure);
      }
    }
    return !delivered ? { ok: false, error: diagnostic ?? "send failed" } : { ok: true };
  }
  public async rebuild(): Promise<void> {
    const stopping = this.stop();
    const epoch = this.lifecycleEpoch;
    await stopping;
    if (epoch === this.lifecycleEpoch) await this.start();
  }
}
