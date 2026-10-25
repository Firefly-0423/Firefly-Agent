import { markChannelTextTransform } from "../../../memory-context/channel-memory-ingress";
import { promises as fs } from "node:fs";
import path from "node:path";
import { app } from "electron";
import { decode, isSilk } from "silk-wasm";
import { ILinkClient, MediaType, pollQrStatus, SessionExpiredError, type CDNMedia, type Credentials, type SendMessageItem, type WeixinMessage, } from "./ilink-protocol-client";
import { uploadWechatMedia, uploadWechatMediaFile } from "./wechat-media-upload";
import { downloadWechatMedia } from "./wechat-media-download";
import { encodeWechatVoiceSilk } from "./wechat-voice-encoding";
import { SAVE_INTENT_TTL_MS, buildUnsupportedWechatFilePrompt, buildWechatAsrFailedPrompt, buildWechatAsrMissingPrompt, buildWechatSaveSuccessPrompt, buildWechatSaveIntentPrompt, buildWechatVideoPrompt, describeInboundWechatMedia, getWechatDisplayName, isWechatSaveIntent, type InboundMediaDescriptor, } from "./inbound-media";
import { getAsrConfig, type AsrConfig } from "../../../asr/asr-config";
import { createAsrStream } from "../../../asr/asr-dispatcher";
import { createAbortError, raceWithSignal } from "../../../utils/abort-utils";
import type { ChannelAttachment, ChannelCapability, ChannelId, ChannelStatus, IncomingMessage, MessageHandler, OutgoingMessage, } from "../../types";
import { createChannelMemoryAccountIdentity, type ChannelAdapter, type ChannelMemoryAccountIdentity } from "../base";
import { logger, LogTag } from "../../../logging/logger";
import { loadChannelsSettings } from "../../settings-store";
import { admitSender } from "../../sender-gate";
import { decodeCredentials, migrateCredentials, writeCredentials, GENERAL_CREDENTIAL_FIELDS } from "../../../settings/credential-storage";

const LOG_PREFIX = "[WechatBot]";
type PendingInboundMedia = { expiresAt: number; messageId: string; media: InboundMediaDescriptor };
const CAPABILITY: ChannelCapability = { text: true, image: true, audio: false, file: true, video: true, markdown: false, card: false, sticker: true, maxTextLength: 2048 };
export class ILinkBotAdapter implements ChannelAdapter {
  readonly id: ChannelId = "wechat";
  readonly displayName = "微信";
  readonly capability = CAPABILITY;
  onMessage: MessageHandler | null = null;
  private readonly accountAuthority = createChannelMemoryAccountIdentity();
  private client: ILinkClient | null = null;
  private pollCancellation: AbortController | null = null;
  private activePolling: Promise<void> | null = null;
  isLoggedIn = false;
  currentCredentials: Credentials | null = null;
  private replyContextByTarget = new Map<string, string>();
  private recentEvents = new Map<string, number>();
  private saveRequests = new Map<string, number>();
  private heldMedia = new Map<string, PendingInboundMedia>();
  private uploadMedia = uploadWechatMediaFile;
  private uploadMediaData = uploadWechatMedia;
  private downloadMedia = downloadInboundWechatMedia;
  private saveInboundMedia = saveInboundWechatMedia;
  private transcribeVoice = transcribeInboundWechatVoice;
  private isAsrConfigured = isWechatAsrConfigured;
  private encodeVoice = encodeWechatVoiceSilk;
  status: ChannelStatus = { enabled: false, phase: "offline" };

  async start(): Promise<void> {
    this.accountAuthority.revoke(); this.pollCancellation?.abort();
    const cancellation = new AbortController();
    this.pollCancellation = cancellation;
    this.status = { enabled: true, phase: "starting" };
    logger.info(LogTag.Wechat, "Starting...");
    const account = await loadCredentials();
    if (cancellation.signal.aborted) return;
    if (!account) {
      this.status = { enabled: true, phase: "config_missing", message: "未登录，请先扫码" };
      console.log(LOG_PREFIX, "No credentials, please run /wechat login"); return;
    }
    this.currentCredentials = account; this.client = new ILinkClient(account); this.isLoggedIn = true;
    this.activePolling = this.#pollLoop(this.client, cancellation.signal, `wechat:${account.ilinkBotId}`);
    this.status = { enabled: true, phase: "running", message: "微信已连接" };
    logger.info(LogTag.Wechat, `Connected as botId=${account.ilinkBotId}`);
  }
  async stop(): Promise<void> {
    this.accountAuthority.revoke(); console.log(LOG_PREFIX, "Stopping..."); this.pollCancellation?.abort();
    const polling = this.activePolling;
    this.activePolling = null; this.pollCancellation = null; this.client = null; this.isLoggedIn = false;
    this.status = { enabled: false, phase: "offline" };
    if (polling) { try { await polling; } catch { /* 关闭时不再传播轮询异常。 */ } }
  }
  async send(msg: OutgoingMessage): Promise<{ ok: boolean; error?: string }> {
    const connection = this.client;
    try { return await this.sendConnectedMessage(msg); }
    catch (failure) {
      if (failure instanceof SessionExpiredError && this.client === connection) {
        this.accountAuthority.revoke(); this.pollCancellation?.abort();
        this.status = { enabled: true, phase: "error", message: "会话已过期，请重新扫码登录" };
      }
      throw failure;
    }
  }
  private async sendConnectedMessage(msg: OutgoingMessage): Promise<{ ok: boolean; error?: string }> {
    if (!this.client) return { ok: false, error: "微信未连接" };
    const token = this.replyContextByTarget.get(msg.targetId);
    if (!token) return { ok: false, error: "缺少微信 context_token，无法回复" };
    let delivered = false;
    let diagnostic: string | undefined;
    for (const fragment of msg.parts) {
      let receipt: { ok: boolean; error?: string };
      let fallback: string;
      let warning: string;
      switch (fragment.kind) {
        case "text": {
          const content = fragment.text.trim();
          if (!content) continue;
          receipt = await this.client.sendText(msg.targetId, content, token);
          fallback = "微信文本发送失败"; warning = "text_item 发送失败:"; break;
        }
        case "image": {
          if (!fragment.filePath) return { ok: false, error: "微信图片发送需要本地 filePath" };
          const uploaded = await this.uploadMedia(this.client, msg.targetId, fragment.filePath, MediaType.IMAGE);
          receipt = await this.client.sendMessage(msg.targetId, [buildImageItem(uploaded)], token);
          fallback = "微信图片发送失败"; warning = "image_item 发送失败:"; break;
        }
        case "sticker": {
          const uploaded = await this.uploadMedia(this.client, msg.targetId, fragment.imagePath, MediaType.IMAGE);
          receipt = await this.client.sendMessage(msg.targetId, [buildImageItem(uploaded)], token);
          fallback = "微信表情发送失败"; warning = "sticker image_item 发送失败:"; break;
        }
        case "audio": {
          const voice = await this.buildVoiceItem(msg.targetId, fragment.filePath).catch((failure) => {
            if (failure instanceof SessionExpiredError) throw failure;
            console.warn(LOG_PREFIX, "voice_item 构造失败（跳过语音）:", failure instanceof Error ? failure.message : failure);
            return null;
          });
          if (!voice) continue;
          receipt = await this.client.sendMessage(msg.targetId, [voice], token);
          fallback = "微信语音发送失败"; warning = "voice_item 发送失败:"; break;
        }
        case "file": {
          const uploaded = await this.uploadMedia(this.client, msg.targetId, fragment.filePath, MediaType.FILE);
          receipt = await this.client.sendMessage(msg.targetId, [buildFileItem(uploaded, path.basename(fragment.name ?? fragment.filePath))], token);
          fallback = "微信文件发送失败"; warning = "file_item 发送失败:"; break;
        }
        case "video": {
          const uploaded = await this.uploadMedia(this.client, msg.targetId, fragment.filePath, MediaType.VIDEO);
          receipt = await this.client.sendMessage(msg.targetId, [buildVideoItem(uploaded)], token);
          fallback = "微信视频发送失败"; warning = "video_item 发送失败:"; break;
        }
        default: continue;
      }
      if (receipt.ok) delivered = true;
      else { diagnostic = receipt.error ?? fallback; console.warn(LOG_PREFIX, warning, diagnostic); }
    }
    return !delivered && diagnostic ? { ok: false, error: diagnostic } : { ok: true };
  }
  private async buildVoiceItem(targetId: string, filePath: string): Promise<SendMessageItem> {
    if (!this.client) throw new Error("微信未连接");
    const bytes = await fs.readFile(filePath);
    const voice = await this.encodeVoice(bytes, { format: "wav" });
    const uploaded = await this.uploadMediaData(this.client, targetId, voice.data, MediaType.VOICE);
    return buildVoiceItem(uploaded, voice.durationMs, voice.sampleRate, voice.encodeType);
  }
  getMemoryAccountIdentity(): ChannelMemoryAccountIdentity | null { return this.accountAuthority.read(); }
  getStatus(): ChannelStatus { return this.status; }
  async login(qrcode: string): Promise<Credentials> {
    console.log(LOG_PREFIX, "Waiting for QR scan...");
    while (true) {
      let response: Awaited<ReturnType<typeof pollQrStatus>>;
      try { response = await pollQrStatus(qrcode); }
      catch (failure) { if ((failure as Error).name === "AbortError") throw new Error("login aborted"); continue; }
      console.log(LOG_PREFIX, "QR status:", response.status);
      if (response.status === "confirmed") {
        if (!response.bot_token || !response.ilink_bot_id) throw new Error("confirmed but missing bot_token or ilink_bot_id");
        const account: Credentials = { botToken: response.bot_token, ilinkBotId: response.ilink_bot_id,
          baseUrl: response.baseurl ?? "https://ilinkai.weixin.qq.com", ilinkUserId: response.ilink_user_id ?? "" };
        await saveCredentials(account); return account;
      }
      if (response.status === "expired") throw new Error("二维码已过期，请重新扫码");
    }
  }
  async logout(): Promise<void> {
    await this.stop(); await deleteCredentials(); this.currentCredentials = null; this.isLoggedIn = false;
    this.status = { enabled: false, phase: "offline", message: "已登出" };
  }
  async #pollLoop(connection: ILinkClient, signal: AbortSignal, accountKey: string): Promise<void> {
    let cursor = "";
    let expired = false;
    while (!signal.aborted && !expired) {
      try {
        const batch = await connection.getUpdates(cursor, signal);
        if (signal.aborted) break;
        this.accountAuthority.authenticate(accountKey); cursor = batch.buf;
        for (const message of batch.messages) { if (signal.aborted) break; await this.dispatchInbound(message, signal); }
      } catch (failure) {
        if (signal.aborted) break;
        this.accountAuthority.revoke();
        if (failure instanceof SessionExpiredError) {
          console.warn(LOG_PREFIX, "Session expired — please re-login"); expired = true;
          this.status = { enabled: true, phase: "error", message: "会话已过期，请重新扫码登录" }; break;
        }
        await delay(2_000, signal);
      }
    }
  }
  private async dispatchInbound(message: WeixinMessage, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return;
    if (!this.onMessage) { console.warn(LOG_PREFIX, "onMessage 未注入，跳过消息"); return; }
    let rules: ReturnType<typeof loadChannelsSettings>["wechat"] | null = null;
    try { rules = loadChannelsSettings().wechat; }
    catch (failure) { console.warn(LOG_PREFIX, "读取发送者白名单失败，按拒绝处理:", failure); }
    if (!admitSender("wechat", rules, message.fromUserId)) { console.warn(LOG_PREFIX, "陌生发送者已拦截，等待在设置中批准"); return; }
    if (message.msgId) {
      const instant = Date.now();
      for (const [key, expiration] of this.recentEvents) if (expiration <= instant) this.recentEvents.delete(key);
      const identifier = JSON.stringify([this.currentCredentials?.ilinkBotId, message.fromUserId, message.msgId]);
      if (this.recentEvents.has(identifier)) return;
      this.recentEvents.set(identifier, instant + 5 * 60_000);
      if (this.recentEvents.size > 2_048) this.recentEvents.delete(this.recentEvents.keys().next().value!);
    }
    console.log(LOG_PREFIX, `inbound from=${message.fromUserId} text=${(message.content ?? "").slice(0, 80)}`);
    this.replyContextByTarget.set(message.fromUserId, message.contextToken);
    const descriptors = describeInboundWechatMedia(message.items);
    const recognized = await this.#maybeTranscribeInboundVoice(message, descriptors, signal);
    if (recognized === null || signal?.aborted) return;
    const interception = await this.#maybeInterceptInboundMedia(message, descriptors);
    if (signal?.aborted) return;
    if (interception.handled) {
      if (interception.text) void this.#sendInterceptText(message.fromUserId, message.contextToken, interception.text);
      return;
    }
    const downloaded = await this.#downloadInboundAttachments(message, descriptors, signal);
    if (downloaded === null || signal?.aborted) return;
    const incoming: IncomingMessage = { channel: "wechat", messageId: message.msgId || undefined, senderId: message.fromUserId, chatId: message.fromUserId,
      text: recognized || message.content || "", attachments: downloaded.length > 0 ? downloaded : undefined, at: new Date(), _raw: message };
    if (recognized) markChannelTextTransform(incoming, "asr");
    void this.onMessage(incoming).catch((failure) => { console.error(LOG_PREFIX, "dispatcher error:", failure); });
  }
  async #maybeInterceptInboundMedia(message: WeixinMessage, descriptors: InboundMediaDescriptor[]): Promise<{ handled: boolean; text?: string }> {
    const instant = Date.now();
    this.#clearExpiredInboundState(message.fromUserId, instant);
    const preferred = loadWechatPreferredName();
    const content = message.content ?? "";
    if (isWechatSaveIntent(content)) {
      const saveable = firstSaveableMedia(descriptors);
      if (saveable) { const notice = await this.#saveInboundMedia(saveable, message.msgId || String(instant), preferred); return { handled: true, text: notice }; }
      const waiting = this.heldMedia.get(message.fromUserId);
      if (waiting) {
        const notice = await this.#saveInboundMedia(waiting.media, waiting.messageId, preferred);
        this.heldMedia.delete(message.fromUserId); return { handled: true, text: notice };
      }
      this.saveRequests.set(message.fromUserId, instant + SAVE_INTENT_TTL_MS);
      return { handled: true, text: buildWechatSaveIntentPrompt(preferred) };
    }
    if (descriptors.length === 0) return { handled: false };
    const requestedUntil = this.saveRequests.get(message.fromUserId);
    if (requestedUntil !== undefined) {
      const saveable = firstSaveableMedia(descriptors);
      if (saveable) {
        this.saveRequests.delete(message.fromUserId);
        const notice = await this.#saveInboundMedia(saveable, message.msgId || String(instant), preferred);
        return { handled: true, text: notice };
      }
    }
    const movie = descriptors.find((descriptor) => descriptor.kind === "video");
    if (movie) {
      if (this.saveRequests.has(message.fromUserId)) {
        this.saveRequests.delete(message.fromUserId);
        const notice = await this.#saveInboundMedia(movie, message.msgId || String(instant), preferred); return { handled: true, text: notice };
      }
      this.heldMedia.set(message.fromUserId, { media: movie, messageId: message.msgId || String(instant), expiresAt: instant + SAVE_INTENT_TTL_MS });
      return { handled: true, text: buildWechatVideoPrompt(preferred) };
    }
    const voice = descriptors.find((descriptor) => descriptor.kind === "voice");
    if (voice && !this.isAsrConfigured()) return { handled: true, text: buildWechatAsrMissingPrompt(preferred) };
    const opaque = descriptors.find((descriptor) => descriptor.kind === "file" && !descriptor.analyzable);
    if (opaque) {
      if (this.saveRequests.has(message.fromUserId)) {
        this.saveRequests.delete(message.fromUserId);
        const notice = await this.#saveInboundMedia(opaque, message.msgId || String(instant), preferred); return { handled: true, text: notice };
      }
      this.heldMedia.set(message.fromUserId, { media: opaque, messageId: message.msgId || String(instant), expiresAt: instant + SAVE_INTENT_TTL_MS });
      return { handled: true, text: buildUnsupportedWechatFilePrompt(preferred) };
    }
    return { handled: false };
  }
  async #saveInboundMedia(descriptor: InboundMediaDescriptor, messageId: string, preferred: string): Promise<string> {
    try { const filename = await this.saveInboundMedia(descriptor, messageId); return buildWechatSaveSuccessPrompt(preferred, filename); }
    catch (failure) {
      const diagnostic = failure instanceof Error ? failure.message : String(failure);
      console.warn(LOG_PREFIX, "入站媒体保存失败:", diagnostic);
      return `${preferred}，这个文件保存失败啦：${diagnostic}`;
    }
  }
  async #maybeTranscribeInboundVoice(message: WeixinMessage, descriptors: InboundMediaDescriptor[], signal?: AbortSignal): Promise<string | undefined | null> {
    const voice = descriptors.find((descriptor) => descriptor.kind === "voice");
    if (!voice) return undefined;
    const preferred = loadWechatPreferredName();
    if (!this.isAsrConfigured()) { await this.#sendInterceptText(message.fromUserId, message.contextToken, buildWechatAsrMissingPrompt(preferred), signal); return null; }
    try {
      const recognized = (await this.transcribeVoice(voice, message.msgId || String(Date.now()), signal)).trim();
      if (!recognized) { await this.#sendInterceptText(message.fromUserId, message.contextToken, buildWechatAsrFailedPrompt(preferred, "没有识别到文字"), signal); return null; }
      return recognized;
    } catch (failure) {
      const diagnostic = failure instanceof Error ? failure.message : String(failure);
      console.warn(LOG_PREFIX, "入站语音识别失败:", diagnostic);
      await this.#sendInterceptText(message.fromUserId, message.contextToken, buildWechatAsrFailedPrompt(preferred, diagnostic), signal); return null;
    }
  }
  async #downloadInboundAttachments(message: WeixinMessage, descriptors: InboundMediaDescriptor[], signal?: AbortSignal): Promise<ChannelAttachment[] | null> {
    const downloaded: ChannelAttachment[] = [];
    for (const descriptor of descriptors) {
      if (descriptor.kind !== "image" && !(descriptor.kind === "file" && descriptor.analyzable)) continue;
      if (!descriptor.media) {
        await this.#sendInterceptText(message.fromUserId, message.contextToken, `${loadWechatPreferredName()}，这个微信附件缺少下载信息，可以再发一次。`, signal); return null;
      }
      try {
        const local = await this.downloadMedia(descriptor, message.msgId || String(Date.now()));
        downloaded.push({ kind: descriptor.kind === "image" ? "image" : "file", filePath: local.filePath, mime: local.mime, caption: descriptor.fileName });
      } catch (failure) {
        const diagnostic = failure instanceof Error ? failure.message : String(failure);
        console.warn(LOG_PREFIX, "入站媒体下载失败:", diagnostic);
        await this.#sendInterceptText(message.fromUserId, message.contextToken, `${loadWechatPreferredName()}，这个微信附件下载失败：${diagnostic}。可以再发一次。`, signal); return null;
      }
    }
    return downloaded;
  }
  #clearExpiredInboundState(targetId: string, now: number): void {
    const requestedUntil = this.saveRequests.get(targetId);
    if (requestedUntil !== undefined && requestedUntil <= now) this.saveRequests.delete(targetId);
    const waiting = this.heldMedia.get(targetId);
    if (waiting && waiting.expiresAt <= now) this.heldMedia.delete(targetId);
  }
  async #sendInterceptText(toUserId: string, contextToken: string, text: string, signal?: AbortSignal): Promise<void> {
    if (!this.client || signal?.aborted) return;
    const receipt = await this.client.sendText(toUserId, text, contextToken);
    if (!receipt.ok) console.warn(LOG_PREFIX, "入站媒体拦截回复发送失败:", receipt.error);
  }
}

function buildImageItem(media: CDNMedia): SendMessageItem { return { type: 2, image_item: { media } }; }
function buildFileItem(media: CDNMedia, fileName: string): SendMessageItem { return { type: 4, file_item: { file_name: fileName, media } }; }
function buildVideoItem(media: CDNMedia): SendMessageItem { return { type: 5, video_item: { media } }; }
function buildVoiceItem(media: CDNMedia, playtime: number, sampleRate: number, encodeType: number): SendMessageItem {
  return { type: 3, voice_item: { media, encode_type: encodeType, sample_rate: sampleRate, playtime } };
}
function firstSaveableMedia(descriptors: InboundMediaDescriptor[]): InboundMediaDescriptor | undefined {
  return descriptors.find((descriptor) => (descriptor.kind === "image" || descriptor.kind === "file" || descriptor.kind === "video") && Boolean(descriptor.media));
}
type DownloadedInboundMedia = { mime: string; filePath: string };
async function downloadInboundWechatMedia(descriptor: InboundMediaDescriptor, messageId: string): Promise<DownloadedInboundMedia> {
  if (!descriptor.media) throw new Error("缺少媒体下载参数");
  const bytes = await downloadWechatMedia(descriptor.media);
  const suffix = pickInboundExtension(descriptor, bytes);
  const directory = path.join(app.getPath("userData"), "channels", "cache");
  await fs.mkdir(directory, { recursive: true });
  const filename = path.join(directory, buildStoredFileName("wechat", messageId, descriptor.fileName || descriptor.kind, suffix));
  await fs.writeFile(filename, bytes);
  return { filePath: filename, mime: mimeFromExtension(suffix) };
}
async function saveInboundWechatMedia(descriptor: InboundMediaDescriptor, messageId: string): Promise<string> {
  if (!descriptor.media) throw new Error("缺少媒体下载参数");
  const bytes = await downloadWechatMedia(descriptor.media);
  const suffix = pickInboundExtension(descriptor, bytes);
  const directory = path.join(app.getPath("desktop"), "Firefly 收件箱");
  await fs.mkdir(directory, { recursive: true });
  const filename = path.join(directory, buildStoredFileName("wechat", messageId, descriptor.fileName || descriptor.kind, suffix));
  await fs.writeFile(filename, bytes);
  return filename;
}
async function transcribeInboundWechatVoice(descriptor: InboundMediaDescriptor, _messageId: string, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw createAbortError();
  if (!descriptor.media) throw new Error("缺少语音下载参数");
  const config = getAsrConfig();
  if (!config || (config.engine === "aliyun" && (!config.appKey || !config.accessKeyId || !config.accessKeySecret)) || (config.engine === "mossland" && !config.apiKey)) throw new Error("ASR 未配置");
  const bytes = await downloadWechatMedia(descriptor.media);
  const rate = descriptor.sampleRate ?? 16000;
  if (rate !== 16000) throw new Error(`暂不支持 ${rate}Hz 微信语音识别`);
  let samples = bytes;
  if (isSilk(bytes)) { const decoded = await decode(bytes, rate); samples = Buffer.from(decoded.data); }
  return transcribePcmWithConfiguredAsr(samples, config, signal);
}
async function transcribePcmWithConfiguredAsr(samples: Buffer, config: AsrConfig, signal?: AbortSignal): Promise<string> {
  const sentences: string[] = [];
  const recognizer = createAsrStream(config, () => {}, (content) => { if (content.trim()) sentences.push(content.trim()); });
  const deadline = new AbortController();
  let expired = false;
  const timer = config.engine === "aliyun" ? setTimeout(() => { expired = true; deadline.abort(); }, 15_000) : undefined;
  const cancellation = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  try {
    if (cancellation.aborted) throw createAbortError();
    const recognized = await raceWithSignal((async () => {
      await recognizer.start();
      if (cancellation.aborted) throw createAbortError();
      recognizer.sendAudio(samples);
      return recognizer.stop();
    })(), cancellation);
    const content = (recognized || sentences.join("")).trim();
    if (content) return content;
    throw new Error("没有识别到文字");
  } catch (failure) {
    if (expired && !signal?.aborted) {
      const content = sentences.join("").trim();
      if (content) return content;
      throw new Error("ASR timeout");
    }
    throw failure;
  } finally { clearTimeout(timer); recognizer.cancel(); }
}
function delay(duration: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((accept) => {
    const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", finish); accept(); };
    const timer = setTimeout(finish, duration);
    signal?.addEventListener("abort", finish, { once: true });
  });
}
function pickInboundExtension(descriptor: InboundMediaDescriptor, bytes: Buffer): string {
  if (descriptor.extension) return descriptor.extension;
  return descriptor.kind === "image" ? inferImageExtension(bytes) ?? ".jpg" : ".bin";
}
function inferImageExtension(bytes: Buffer): string | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return ".png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return ".jpg";
  if (bytes.length >= 6 && (bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a")) return ".gif";
  if (bytes.length >= 12 && bytes.subarray(8, 12).toString("ascii") === "WEBP") return ".webp";
  if (bytes.length >= 2 && bytes.subarray(0, 2).toString("ascii") === "BM") return ".bmp";
  return undefined;
}
function mimeFromExtension(suffix: string): string {
  const formats: Record<string, string> = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp",
    ".txt": "text/plain", ".md": "text/plain", ".markdown": "text/plain", ".log": "text/plain", ".csv": "text/plain", ".tsv": "text/plain",
    ".json": "application/json", ".pdf": "application/pdf", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };
  const normalized = suffix.toLowerCase();
  return Object.hasOwn(formats, normalized) ? formats[normalized] : "application/octet-stream";
}
function sanitizeFileName(candidate: string): string { return candidate.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim() || "attachment"; }
function buildStoredFileName(prefix: string, messageId: string, fileName: string, ext: string): string {
  const parsed = path.parse(fileName);
  const label = sanitizeFileName(parsed.name || fileName);
  return `${sanitizeFileName(prefix)}-${sanitizeFileName(messageId)}-${Date.now()}-${label}${ext}`;
}
function credPath(): string { return path.join(app.getPath("userData"), "weixin", "credentials.json"); }
const CREDENTIAL_FIELDS = new Set(["botToken"]);
export async function loadCredentials(): Promise<Credentials | null> {
  try {
    const bytes = await fs.readFile(credPath(), "utf8");
    const account = decodeCredentials(JSON.parse(bytes), CREDENTIAL_FIELDS) as Credentials;
    if (typeof account?.botToken !== "string" || !account.botToken || typeof account.ilinkBotId !== "string" || !account.ilinkBotId) return null;
    migrateCredentials(credPath(), bytes, account, CREDENTIAL_FIELDS);
    return account;
  } catch (failure) {
    if ((failure as NodeJS.ErrnoException).code !== "ENOENT") logger.warn(LogTag.Wechat, "WeChat credentials unreadable; original file retained");
    return null;
  }
}
async function saveCredentials(account: Credentials): Promise<void> {
  writeCredentials(credPath(), account, CREDENTIAL_FIELDS);
}
async function deleteCredentials(): Promise<void> { try { await fs.unlink(credPath()); } catch { /* 已无凭据。 */ } }
function loadWechatPreferredName(): string {
  try {
    const filename = path.join(app.getPath("userData"), "user-profile.json");
    const bytes = require("node:fs").readFileSync(filename, "utf8") as string;
    const profile = JSON.parse(bytes) as { callPreference?: unknown };
    return getWechatDisplayName(profile.callPreference);
  } catch { return "伙伴"; }
}
function isWechatAsrConfigured(): boolean {
  try {
    const filename = path.join(app.getPath("userData"), "app-settings.json");
    const bytes = require("node:fs").readFileSync(filename, "utf8") as string;
    const config = decodeCredentials(JSON.parse(bytes), GENERAL_CREDENTIAL_FIELDS) as { asrEngine?: unknown; asrAliyunAppKey?: unknown; asrAliyunAccessKeyId?: unknown; asrAliyunAccessKeySecret?: unknown; asrMosslandKey?: unknown; ttsMosslandKey?: unknown };
    if (config.asrEngine === "local") return true;
    if (config.asrEngine === "mossland") {
      const secret = config.asrMosslandKey ?? config.ttsMosslandKey;
      return Boolean(typeof secret === "string" && secret.trim());
    }
    if (config.asrEngine !== "aliyun") return false;
    return Boolean(typeof config.asrAliyunAppKey === "string" && config.asrAliyunAppKey.trim()
      && typeof config.asrAliyunAccessKeyId === "string" && config.asrAliyunAccessKeyId.trim()
      && typeof config.asrAliyunAccessKeySecret === "string" && config.asrAliyunAccessKeySecret.trim());
  } catch { return false; }
}
