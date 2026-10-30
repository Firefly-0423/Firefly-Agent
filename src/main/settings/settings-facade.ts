import * as fs from "fs";
import * as path from "path";
import { DEFAULT_UI_COLORS, normalizeUiColors } from "../../shared/ui-colors";
import { logger, LogTag } from "../logging/logger";
import { DEFAULT_UI_FONT, normalizeUiFont } from "../../shared/ui-font";
import { normalizeUiTheme } from "../../shared/ui-theme";
import { normalizeUiIcon } from "../../shared/ui-icon";
import { DEFAULT_CHAT_APPEARANCE, normalizeChatAppearance } from "../../shared/chat-appearance";
import {
  normalizeChatSocialContextEnabled,
  normalizeProactiveChatMode,
  normalizeProactiveDeliveryTarget,
  normalizeSegmentedChatEnabled,
} from "../../shared/preferences";
import { normalizeWindowVisibilitySettings } from "../windows/window-visibility-settings";
import { getGeneralSettingsPath } from "../storage/settings-store";
import type { GeneralSettings } from "./general-settings";
import { DEFAULT_MAX_TOOL_ROUNDS, DEFAULT_RUN_TIMEOUT_MS } from "../orchestrator/harness/types";
import { decodeCredentials, migrateCredentials, writeCredentials, GENERAL_CREDENTIAL_FIELDS } from "./credential-storage";
import type { ToolModeOverrides } from "../orchestrator/tools/registry/tool-registry";
import type { SkillModeOverrides } from "../skills/types";
import { normalizeLspServerOverrides } from "../lsp/server-catalog";
import {
  applyInstallerLaunchAtLoginSelection,
  consumeInstallerLaunchAtLoginSelection,
} from "./launch-at-login";

type LooseInput = Record<string, unknown>;

// 默认值表。它只作为缺省回退使用，本身不会整体落盘，因此键序可以自由排列。
const FALLBACK_SETTINGS: GeneralSettings = {
  ...DEFAULT_CHAT_APPEARANCE,
  asrAliyunAccessKeyId: "",
  asrAliyunAccessKeySecret: "",
  asrAliyunAppKey: "",
  asrEngine: "off",
  asrLanguage: "zh",
  asrMosslandKey: "",
  amapKey: "",
  chatSocialContextEnabled: true,
  chatToolsEnabled: false,
  emailEnabled: false,
  emailFromName: "",
  emailSmtpHost: "",
  emailSmtpPass: "",
  emailSmtpPort: 465,
  emailSmtpSecure: true,
  emailSmtpUser: "",
  language: "zh-CN",
  launchAtLogin: false,
  lspServerOverrides: [],
  maxParallelToolCalls: 4,
  maxToolRounds: DEFAULT_MAX_TOOL_ROUNDS,
  musicEnabled: true,
  petAlwaysOnTop: true,
  petVisible: true,
  petZoom: 1,
  playwrightMcpEnabled: false,
  plugins: {},
  proactiveChatMode: "off",
  proactiveDeliveryTarget: "local",
  runTimeoutMinutes: DEFAULT_RUN_TIMEOUT_MS / 60_000,
  screenshotHotkey: "Alt+Shift+S",
  searchAnySearchKey: "",
  searchBochaKey: "",
  searchEngine: "off",
  searchMinimaxKey: "",
  searchTavilyKey: "",
  segmentedChatEnabled: true,
  sidebarVisible: true,
  skillModeOverrides: {},
  toastSoundEnabled: true,
  toolModeOverrides: {},
  travelEnabled: false,
  uiColors: { ...DEFAULT_UI_COLORS },
  uiFont: DEFAULT_UI_FONT,
  uiIcon: "firefly",
  uiTheme: "pearl-white",
  weatherEnabled: false,
  weatherSource: "open-meteo",
};

const changeListeners = new Set<(before: GeneralSettings, after: GeneralSettings) => void>();

let settingsCache: GeneralSettings | null = null;
let readHadFailed = false;

export function assertGeneralSettingsReadable(): void {
  loadGeneralSettings();
  if (readHadFailed) {
    throw new Error("GENERAL_SETTINGS_READ_FAILED: 应用设置读取失败，原文件已保留");
  }
}

export function onGeneralSettingsChanged(
  listener: (before: GeneralSettings, after: GeneralSettings) => void,
): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

function emitChange(before: GeneralSettings, after: GeneralSettings): void {
  changeListeners.forEach((listener) => listener(before, after));
}

// ---- 基础取值工具：只接受类型正确的值，其余回退 ----

function asText(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asFlag(value: unknown, fallback: boolean): boolean {
  return value === undefined ? fallback : Boolean(value);
}

function oneOfOptions<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return options.includes(String(value) as T) ? (value as T) : fallback;
}

function toNumeric(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

function clampRounded(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = toNumeric(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(numeric)));
}

function parallelLimit(value: unknown): number {
  const numeric = toNumeric(value);
  if (!Number.isFinite(numeric)) {
    return FALLBACK_SETTINGS.maxParallelToolCalls;
  }
  return Math.max(1, Math.min(8, Math.trunc(numeric)));
}

/** 0 表示“不限”，因此只接受真正的数字或非空数字字符串；null、空串、空白都回退。 */
function nonNegativeInt(value: unknown, max: number, fallback: number): number {
  let numeric: number;
  if (typeof value === "number") {
    numeric = value;
  } else if (typeof value === "string" && value.trim() !== "") {
    numeric = Number(value);
  } else {
    numeric = Number.NaN;
  }
  if (!Number.isFinite(numeric) || numeric < 0) {
    return fallback;
  }
  return Math.min(max, Math.trunc(numeric));
}

function wholeOrUndefined(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.round(value);
}

function boundedZoom(value: unknown): number {
  if (typeof value !== "number") {
    return FALLBACK_SETTINGS.petZoom;
  }
  return Math.max(0.5, Math.min(2, value));
}

function keepBooleanSwitches(value: unknown): Record<string, boolean> {
  const entries = Object.entries((value ?? {}) as object);
  return Object.fromEntries(entries.filter((pair): pair is [string, boolean] => typeof pair[1] === "boolean"));
}

/**
 * 通用“按模式覆盖”结构的清洗：只保留 { id: { mode: boolean } }，
 * 其中 mode 必须在允许列表内，非法项丢弃，没有有效模式的 id 也丢弃。
 */
function cleanModeOverrides(value: unknown, allowedModes: readonly string[]): Record<string, Record<string, boolean>> {
  if (!value || typeof value !== "object") {
    return {};
  }
  const cleaned: Record<string, Record<string, boolean>> = {};
  for (const [id, modeMap] of Object.entries(value)) {
    if (!modeMap || typeof modeMap !== "object") {
      continue;
    }
    const kept: Record<string, boolean> = {};
    for (const [mode, flag] of Object.entries(modeMap)) {
      if (allowedModes.includes(mode) && typeof flag === "boolean") {
        kept[mode] = flag;
      }
    }
    if (Object.keys(kept).length > 0) {
      cleaned[id] = kept;
    }
  }
  return cleaned;
}

/** 将任意输入规范化为完整的 GeneralSettings。未知键被忽略，已退役的键也不会保留。 */
export function normalizeGeneralSettings(
  input: Partial<GeneralSettings> | null | undefined,
): GeneralSettings {
  const src = (input ?? {}) as LooseInput;
  const windowVisibility = normalizeWindowVisibilitySettings(input);
  const portForSecure = clampRounded(src.emailSmtpPort, 1, 65535, FALLBACK_SETTINGS.emailSmtpPort);

  // 键的插入顺序会影响落盘 JSON 的字段顺序，因此下面的顺序需要与既有文件保持一致。
  return {
    plugins: keepBooleanSwitches(src.plugins),
    maxParallelToolCalls: parallelLimit(src.maxParallelToolCalls),
    maxToolRounds: nonNegativeInt(src.maxToolRounds, 10_000, FALLBACK_SETTINGS.maxToolRounds),
    runTimeoutMinutes: nonNegativeInt(src.runTimeoutMinutes, 24 * 60, FALLBACK_SETTINGS.runTimeoutMinutes),
    chatSocialContextEnabled: normalizeChatSocialContextEnabled(src.chatSocialContextEnabled),
    petAlwaysOnTop: asFlag(src.petAlwaysOnTop, FALLBACK_SETTINGS.petAlwaysOnTop),
    petVisible: asFlag(src.petVisible, FALLBACK_SETTINGS.petVisible),
    petZoom: boundedZoom(src.petZoom),
    petWindowX: wholeOrUndefined(src.petWindowX),
    petWindowY: wholeOrUndefined(src.petWindowY),
    sidebarVisible: windowVisibility.sidebarVisible,
    toastSoundEnabled: asFlag(src.toastSoundEnabled, FALLBACK_SETTINGS.toastSoundEnabled),
    launchAtLogin: Boolean(src.launchAtLogin),
    language: src.language === "en" ? "en" : "zh-CN",
    uiTheme: normalizeUiTheme(src.uiTheme),
    uiColors: normalizeUiColors(src.uiColors),
    uiFont: normalizeUiFont(src.uiFont),
    uiIcon: normalizeUiIcon(src.uiIcon),
    segmentedChatEnabled: normalizeSegmentedChatEnabled(src.segmentedChatEnabled),
    proactiveChatMode: normalizeProactiveChatMode(src.proactiveChatMode),
    proactiveDeliveryTarget: normalizeProactiveDeliveryTarget(src.proactiveDeliveryTarget),
    weatherSource: oneOfOptions(src.weatherSource, ["open-meteo", "amap"] as const, "open-meteo"),
    weatherEnabled: Boolean(src.weatherEnabled),
    amapKey: asText(src.amapKey),
    travelEnabled: Boolean(src.travelEnabled),
    musicEnabled: asFlag(src.musicEnabled, true),
    playwrightMcpEnabled: Boolean(src.playwrightMcpEnabled),
    searchEngine: oneOfOptions(src.searchEngine, ["off", "bocha", "tavily", "minimax", "anySearch"] as const, "off"),
    searchBochaKey: asText(src.searchBochaKey),
    searchTavilyKey: asText(src.searchTavilyKey),
    searchMinimaxKey: asText(src.searchMinimaxKey),
    searchAnySearchKey: asText(src.searchAnySearchKey),
    emailEnabled: Boolean(src.emailEnabled),
    emailSmtpHost: asText(src.emailSmtpHost),
    emailSmtpPort: clampRounded(src.emailSmtpPort, 1, 65535, FALLBACK_SETTINGS.emailSmtpPort),
    emailSmtpSecure: asFlag(src.emailSmtpSecure, portForSecure === 465),
    emailSmtpUser: asText(src.emailSmtpUser),
    emailSmtpPass: asText(src.emailSmtpPass),
    emailFromName: asText(src.emailFromName),
    asrMosslandKey: asText(src.asrMosslandKey, asText(src.ttsMosslandKey)),
    asrEngine: oneOfOptions(src.asrEngine, ["off", "aliyun", "mossland", "local"] as const, "off"),
    asrAliyunAppKey: asText(src.asrAliyunAppKey),
    asrAliyunAccessKeyId: asText(src.asrAliyunAccessKeyId),
    asrAliyunAccessKeySecret: asText(src.asrAliyunAccessKeySecret),
    asrLanguage: oneOfOptions(src.asrLanguage, ["zh", "en", "auto"] as const, "zh"),
    screenshotHotkey: asText(src.screenshotHotkey).trim() || FALLBACK_SETTINGS.screenshotHotkey,

    ...normalizeChatAppearance(input),
    toolModeOverrides: cleanModeOverrides(src.toolModeOverrides, ["chat", "work", "code"]) as ToolModeOverrides,
    chatToolsEnabled: Boolean(src.chatToolsEnabled),
    skillModeOverrides: cleanModeOverrides(src.skillModeOverrides, ["work", "code"]) as SkillModeOverrides,
    lspServerOverrides: normalizeLspServerOverrides(src.lspServerOverrides),
  };
}

/**
 * 从磁盘读取并应用安装程序留下的开机启动选择。读取失败时标记 readHadFailed，阻止后续写入覆盖原文件。
 */
function readFromDisk(): GeneralSettings {
  try {
    const filePath = getGeneralSettingsPath();
    const { raw, present } = readSettingsDocument(filePath);
    const existing = decodeCredentials(JSON.parse(raw), GENERAL_CREDENTIAL_FIELDS) as Partial<GeneralSettings>;
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
      throw new Error("Invalid general settings");
    }
    const installerChoice = consumeInstallerLaunchAtLoginSelection(
      path.join(path.dirname(filePath), "installer-options.json"),
      fs,
    );
    const merged = applyInstallerLaunchAtLoginSelection(existing as Partial<GeneralSettings>, installerChoice);
    if (installerChoice !== null) {
      // 只写回安装程序的明确选择，不要顺带重写已经保存的其它键。
      writeCredentials(filePath, merged, GENERAL_CREDENTIAL_FIELDS);
    } else if (present) {
      migrateCredentials(filePath, raw, existing, GENERAL_CREDENTIAL_FIELDS);
    }
    return normalizeGeneralSettings(merged);
  } catch {
    readHadFailed = true;
    logger.warn(LogTag.Runtime, "general settings read failed; writes blocked");
    return { ...FALLBACK_SETTINGS };
  }
}

/** 文件不存在时视为首次使用（返回空对象）；存在但不可读时抛出，交由上层标记失败。 */
function readSettingsDocument(filePath: string): { raw: string; present: boolean } {
  let exists = true;
  try {
    fs.statSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    exists = false;
  }
  return { raw: exists ? fs.readFileSync(filePath, "utf8") : "{}", present: exists };
}

export function loadGeneralSettings(): GeneralSettings {
  if (settingsCache === null) {
    settingsCache = readFromDisk();
  }
  return settingsCache;
}

export function saveGeneralSettings(partial: Partial<GeneralSettings>): GeneralSettings {
  assertGeneralSettingsReadable();
  const before = loadGeneralSettings();
  assertGeneralSettingsReadable();
  const next = normalizeGeneralSettings({ ...before, ...partial });
  writeCredentials(getGeneralSettingsPath(), next, GENERAL_CREDENTIAL_FIELDS);
  settingsCache = next;
  emitChange(before, next);
  return next;
}
