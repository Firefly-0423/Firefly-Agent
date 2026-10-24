import * as fs from "fs";
import { randomUUID } from "node:crypto";
import * as path from "path";
import { app, safeStorage } from "electron";
import type { ChannelId } from "./types";
import { normalizeQqListenMode, type QqListenMode } from "../../shared/qq-listen";
import { normalizeSenderIds } from "./sender-gate";
export type { QqListenMode };

export type ChannelRuntimeConfig = { publicWebhookUrl?: string; manualCliPath?: string; enabled: boolean };
export type SenderAllowlistConfig = { allowedSenderIds: string[]; allowAnyPrivate: boolean };
export interface WechatChannelConfig extends ChannelRuntimeConfig, SenderAllowlistConfig {
  pairingPending?: Array<{ code: string; senderId: string; createdAt: number }>;
}
export interface FeishuChannelConfig extends ChannelRuntimeConfig, SenderAllowlistConfig { appSecret?: string; appId?: string; }
export interface QqChannelConfig extends ChannelRuntimeConfig {
  groupMemoryPolicy: "shared-personal"; groupToolPolicy: "off"; groupReplyStyle: "reply-and-mention"; groupRequireMention: true;
  allowedGroupIds: string[]; allowedPrivateUserIds: string[]; accessToken?: string; port: number; customHost?: string; listenMode: QqListenMode;
}
export interface QqBotChannelConfig extends ChannelRuntimeConfig {
  allowedGroupOpenids: string[]; allowedUserOpenids: string[]; allowAnyPrivate: boolean; appSecret?: string; appId?: string;
}
export type ChannelToolSandbox = "off" | "all";
export type ChannelsSettings = {
  toolSandbox: ChannelToolSandbox; mirrorToDesktop: boolean; stickerEnabled: boolean;
  rateLimitPerChannel: number; rateLimitPerUser: number; sharedSecret: string; inboundPort: number;
  qqbot: QqBotChannelConfig; qq: QqChannelConfig; feishu: FeishuChannelConfig; wechat: WechatChannelConfig;
};
export type ChannelConfigPatch = Partial<{
  toolSandbox: ChannelToolSandbox; mirrorToDesktop: boolean; stickerEnabled: boolean;
  rateLimitPerChannel: number; rateLimitPerUser: number; sharedSecret: string; inboundPort: number;
  qqbot: Partial<QqBotChannelConfig>; qq: Partial<QqChannelConfig>; feishu: Partial<FeishuChannelConfig>; wechat: Partial<WechatChannelConfig>;
}>;
type ChannelConfigMap = { qqbot: QqBotChannelConfig; qq: QqChannelConfig; feishu: FeishuChannelConfig; wechat: WechatChannelConfig };
const defaults: ChannelsSettings = {
  wechat: { enabled: false, allowAnyPrivate: false, allowedSenderIds: [] },
  feishu: { enabled: false, allowAnyPrivate: false, allowedSenderIds: [] },
  qq: { enabled: false, listenMode: "auto", port: 6200, allowedPrivateUserIds: [], allowedGroupIds: [], groupRequireMention: true,
    groupReplyStyle: "reply-and-mention", groupToolPolicy: "off", groupMemoryPolicy: "shared-personal" },
  qqbot: { enabled: false, allowAnyPrivate: false, allowedUserOpenids: [], allowedGroupOpenids: [] },
  inboundPort: 0, sharedSecret: "", rateLimitPerUser: 10, rateLimitPerChannel: 100, stickerEnabled: false, mirrorToDesktop: true, toolSandbox: "off",
};
const encryptedPrefix = "enc:";
const obscuredPrefix = "obf2:";
let encryptionAvailable: boolean | null = null;
function isSafeStorageAvailable(): boolean {
  if (encryptionAvailable !== null) return encryptionAvailable;
  if (!app.isReady()) return false;
  try { encryptionAvailable = safeStorage.isEncryptionAvailable(); }
  catch { encryptionAvailable = false; }
  return encryptionAvailable;
}
function getMachineKey(): Buffer {
  const material = `${app.getPath("userData")}::${app.getName()}::firefly-bot-secret`;
  const { createHash } = require("crypto") as typeof import("crypto");
  return createHash("sha256").update(material).digest().subarray(0, 16);
}
function xorBytes(bytes: Buffer, key: Buffer): Buffer {
  const transformed = Buffer.alloc(bytes.length);
  for (let offset = 0; offset < bytes.length; offset++) transformed[offset] = bytes[offset] ^ key[offset % key.length];
  return transformed;
}
function obfuscate(plaintext: string): string {
  const key = getMachineKey();
  const bytes = Buffer.from(plaintext, "utf8");
  return obscuredPrefix + xorBytes(bytes, key).toString("base64");
}
function deobfuscate(encoded: string): string {
  const key = getMachineKey();
  const payload = encoded.slice(obscuredPrefix.length);
  const bytes = Buffer.from(payload, "base64");
  return xorBytes(bytes, key).toString("utf8");
}
function encryptField(plaintext: string): string {
  if (!plaintext) return "";
  if (isSafeStorageAvailable()) {
    try { return encryptedPrefix + safeStorage.encryptString(plaintext).toString("base64"); }
    catch (failure) { console.warn("[ChannelsSettings] safeStorage.encryptString 失败, 回退混淆:", failure); }
  }
  return obfuscate(plaintext);
}
function decryptField(encoded: string): string {
  if (!encoded) return "";
  if (encoded.startsWith(encryptedPrefix)) {
    if (!isSafeStorageAvailable()) {
      console.warn("[ChannelsSettings] safeStorage 不可用, 无法解密 enc: 字段");
      throw new Error("CHANNEL_SECRET_DECRYPT_UNAVAILABLE");
    }
    try { return safeStorage.decryptString(Buffer.from(encoded.slice(encryptedPrefix.length), "base64")); }
    catch { throw new Error("CHANNEL_SECRET_DECRYPT_FAILED"); }
  }
  if (encoded.startsWith(obscuredPrefix)) {
    try { return deobfuscate(encoded); }
    catch { throw new Error("CHANNEL_SECRET_DECRYPT_FAILED"); }
  }
  throw new Error("CHANNEL_SECRET_FORMAT_INVALID");
}
export function decryptFeishuSecret(cfg: FeishuChannelConfig | undefined): string { return decryptField(cfg?.appSecret ?? ""); }
const filePath = () => path.join(app.getPath("userData"), "channels-settings.json");

function normalize(input: Partial<ChannelsSettings> | null | undefined): ChannelsSettings {
  const integer = (candidate: unknown, fallback: number, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number => {
    const numeric = Number(candidate);
    return Number.isFinite(numeric) ? Math.min(maximum, Math.max(minimum, Math.floor(numeric))) : fallback;
  };
  const boolean = (candidate: unknown, fallback: boolean): boolean => typeof candidate === "boolean" ? candidate : fallback;
  const text = (candidate: unknown): string => typeof candidate === "string" ? candidate : "";
  const sandbox = (candidate: unknown): ChannelToolSandbox => {
    if (candidate === "all") return "all";
    if (candidate === "off" || candidate === "safe-only") return "off";
    return defaults.toolSandbox;
  };
  const allowlist = (config: Partial<SenderAllowlistConfig & { enabled: boolean }> | undefined): SenderAllowlistConfig => {
    const previouslyOpen = config?.enabled === true && typeof config.allowAnyPrivate !== "boolean" && !Array.isArray(config.allowedSenderIds);
    return { allowAnyPrivate: boolean(config?.allowAnyPrivate, previouslyOpen), allowedSenderIds: normalizeSenderIds(config?.allowedSenderIds) };
  };
  const wechat: Partial<WechatChannelConfig> | undefined = input?.wechat;
  const feishu: Partial<FeishuChannelConfig> | undefined = input?.feishu;
  const qq: Partial<QqChannelConfig> | undefined = input?.qq;
  const qqbot: Partial<QqBotChannelConfig> | undefined = input?.qqbot;
  const ids = (candidate: unknown, accepted: RegExp): string[] => !Array.isArray(candidate) ? []
    : Array.from(new Set(candidate.map((identifier) => String(identifier).trim()).filter((identifier) => accepted.test(identifier))));
  return {
    wechat: {
      enabled: boolean(wechat?.enabled, false), ...allowlist(wechat),
      manualCliPath: typeof wechat?.manualCliPath === "string" ? wechat.manualCliPath : undefined,
      publicWebhookUrl: typeof wechat?.publicWebhookUrl === "string" ? wechat.publicWebhookUrl : undefined,
      pairingPending: Array.isArray(wechat?.pairingPending) ? wechat!.pairingPending!.map((pending) => ({
        code: text((pending as { code?: unknown }).code), senderId: text((pending as { senderId?: unknown }).senderId),
        createdAt: integer((pending as { createdAt?: unknown }).createdAt, Date.now()),
      })) : [],
    },
    feishu: {
      enabled: boolean(feishu?.enabled, false), ...allowlist(feishu),
      manualCliPath: typeof feishu?.manualCliPath === "string" ? feishu?.manualCliPath : undefined,
      publicWebhookUrl: typeof feishu?.publicWebhookUrl === "string" ? feishu?.publicWebhookUrl : undefined,
      appId: typeof feishu?.appId === "string" ? feishu?.appId : undefined,
      appSecret: typeof feishu?.appSecret === "string" ? feishu?.appSecret : undefined,
    },
    qq: {
      enabled: boolean(qq?.enabled, false), listenMode: normalizeQqListenMode(qq?.listenMode),
      customHost: typeof qq?.customHost === "string" && qq.customHost.trim() ? qq.customHost.trim() : undefined,
      port: integer(qq?.port, 6200, 1, 65535), accessToken: typeof qq?.accessToken === "string" ? qq.accessToken : undefined,
      allowedPrivateUserIds: ids(qq?.allowedPrivateUserIds, /^\d+$/), allowedGroupIds: ids(qq?.allowedGroupIds, /^\d+$/),
      groupRequireMention: true, groupReplyStyle: "reply-and-mention", groupToolPolicy: "off", groupMemoryPolicy: "shared-personal",
    },
    qqbot: {
      enabled: boolean(qqbot?.enabled, false),
      manualCliPath: typeof qqbot?.manualCliPath === "string" ? qqbot?.manualCliPath : undefined,
      publicWebhookUrl: typeof qqbot?.publicWebhookUrl === "string" ? qqbot?.publicWebhookUrl : undefined,
      appId: typeof qqbot?.appId === "string" ? qqbot.appId.trim() : undefined,
      appSecret: typeof qqbot?.appSecret === "string" ? qqbot?.appSecret : undefined,
      allowAnyPrivate: boolean(qqbot?.allowAnyPrivate, false), allowedUserOpenids: ids(qqbot?.allowedUserOpenids, /^[A-Za-z0-9_-]{8,64}$/),
      allowedGroupOpenids: ids(qqbot?.allowedGroupOpenids, /^[A-Za-z0-9_-]{8,64}$/),
    },
    inboundPort: integer(input?.inboundPort, 0, 0, 65535), sharedSecret: typeof input?.sharedSecret === "string" ? input.sharedSecret : "",
    rateLimitPerUser: integer(input?.rateLimitPerUser, 10, 1, 1000), rateLimitPerChannel: integer(input?.rateLimitPerChannel, 100, 1, 10000),
    stickerEnabled: boolean(input?.stickerEnabled, false), mirrorToDesktop: boolean(input?.mirrorToDesktop, true), toolSandbox: sandbox(input?.toolSandbox),
  };
}

export function loadChannelsSettings(): ChannelsSettings {
  try {
    const source = filePath();
    if (!fs.existsSync(source)) return { ...defaults };
    const parsed = JSON.parse(fs.readFileSync(source, "utf8")) as Partial<ChannelsSettings>;
    const settings = normalize(parsed);
    if (settings.feishu.appSecret) settings.feishu.appSecret = decryptField(settings.feishu.appSecret);
    if (settings.qq.accessToken) settings.qq.accessToken = decryptField(settings.qq.accessToken);
    if (settings.qqbot.appSecret) settings.qqbot.appSecret = decryptField(settings.qqbot.appSecret);
    return settings;
  } catch { throw new Error("CHANNELS_SETTINGS_READ_FAILED"); }
}
export function saveChannelsSettings(patch: Partial<ChannelsSettings>): ChannelsSettings {
  const previous = loadChannelsSettings();
  const combined: Partial<ChannelsSettings> = { ...previous, ...patch };
  if (patch.wechat) combined.wechat = { ...previous.wechat, ...patch.wechat };
  if (patch.feishu) combined.feishu = { ...previous.feishu, ...patch.feishu };
  if (patch.qq) combined.qq = { ...previous.qq, ...patch.qq };
  if (patch.qqbot) combined.qqbot = { ...previous.qqbot, ...patch.qqbot };
  if (typeof combined.feishu?.appSecret === "string" && combined.feishu.appSecret) {
    const secret = combined.feishu.appSecret;
    if (!secret.startsWith(encryptedPrefix) && !secret.startsWith(obscuredPrefix)) combined.feishu.appSecret = encryptField(secret);
  }
  if (typeof combined.qq?.accessToken === "string" && combined.qq.accessToken) {
    const secret = combined.qq.accessToken;
    if (!secret.startsWith(encryptedPrefix) && !secret.startsWith(obscuredPrefix)) combined.qq.accessToken = encryptField(secret);
  }
  if (typeof combined.qqbot?.appSecret === "string" && combined.qqbot.appSecret) {
    const secret = combined.qqbot.appSecret;
    if (!secret.startsWith(encryptedPrefix) && !secret.startsWith(obscuredPrefix)) combined.qqbot.appSecret = encryptField(secret);
  }
  const persisted = normalize(combined);
  fs.mkdirSync(path.dirname(filePath()), { recursive: true });
  const destination = filePath();
  const staging = `${destination}.update-${randomUUID()}`;
  try {
    fs.writeFileSync(staging, JSON.stringify(persisted, null, 2), { encoding: "utf8", flag: "wx" });
    fs.renameSync(staging, destination);
  } finally { fs.rmSync(staging, { force: true }); }
  return {
    ...persisted,
    feishu: { ...persisted.feishu, appSecret: decryptField(persisted.feishu.appSecret ?? "") },
    qq: { ...persisted.qq, accessToken: decryptField(persisted.qq.accessToken ?? "") },
    qqbot: { ...persisted.qqbot, appSecret: decryptField(persisted.qqbot.appSecret ?? "") },
  };
}
export function getChannelConfig<K extends ChannelId>(settings: ChannelsSettings, channel: K): ChannelConfigMap[K] { return settings[channel] as ChannelConfigMap[K]; }
