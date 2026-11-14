import fs from "node:fs";
import path from "node:path";
import { vi } from "vitest";
import { DEFAULT_CHAT_APPEARANCE } from "../../shared/chat-appearance";
import { DEFAULT_TIMEOUT_SETTINGS, type TimeoutSettings } from "../../shared/timeout-types";
import { DEFAULT_UI_COLORS } from "../../shared/ui-colors";
import { DEFAULT_UI_FONT } from "../../shared/ui-font";
import type { SchedulerApi } from "./scheduler/types";
import { modalState } from "./shared/modal-state";
import type { GeneralSettings, MemoryPanelApi, ModelSettings, SettingsApi } from "./shared/types";

const SETTINGS_HTML_PATH = path.resolve(__dirname, "index.html");
let cachedBodyHtml: string | null = null;

function extractBodyHtml(): string {
  if (cachedBodyHtml !== null) return cachedBodyHtml;
  const rawHtml = fs.readFileSync(SETTINGS_HTML_PATH, "utf-8");
  const bodyMatch = rawHtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const rawBody = bodyMatch ? bodyMatch[1] : rawHtml;
  cachedBodyHtml = rawBody.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  return cachedBodyHtml;
}

export function createDefaultGeneralSettings(overrides: Partial<GeneralSettings> = {}): GeneralSettings {
  return {
    maxParallelToolCalls: 4,
    maxToolRounds: 200,
    runTimeoutMinutes: 120,
    chatSocialContextEnabled: true,
    petAlwaysOnTop: true,
    petVisible: true,
    petZoom: 1,
    ...DEFAULT_CHAT_APPEARANCE,
    sidebarVisible: true,
    toastSoundEnabled: true,
    launchAtLogin: false,
    language: "zh-CN",
    uiTheme: "pearl-white",
    uiColors: { ...DEFAULT_UI_COLORS, dark: { ...DEFAULT_UI_COLORS.dark } },
    uiFont: { ...DEFAULT_UI_FONT },
    uiIcon: "firefly",
    segmentedChatEnabled: true,
    proactiveChatMode: "off",
    proactiveDeliveryTarget: "local",
    screenshotHotkey: "Alt+Shift+S",
    weatherSource: "open-meteo",
    weatherEnabled: false,
    amapKey: "",
    travelEnabled: false,
    musicEnabled: true,
    playwrightMcpEnabled: false,
    searchEngine: "off",
    searchBochaKey: "",
    searchTavilyKey: "",
    searchMinimaxKey: "",
    searchAnySearchKey: "",
    emailEnabled: false,
    emailSmtpHost: "",
    emailSmtpPort: 465,
    emailSmtpSecure: true,
    emailSmtpUser: "",
    emailSmtpPass: "",
    emailFromName: "",
    ...overrides,
  };
}

export function createDefaultModelSettings(overrides: Partial<ModelSettings> = {}): ModelSettings {
  return {
    mode: "auto",
    provider: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-pro",
    apiKey: "",
    stickerEnabled: false,
    stickerSize: "standard",
    stickerSimilarityThreshold: 0.55,
    chatRequestTimeoutSec: 300,
    ...overrides,
  };
}

export async function flushMicrotasks(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
}

export interface MountSettingsOptions {
  hash?: string;
  general?: Partial<GeneralSettings>;
  config?: Partial<ModelSettings>;
  timeouts?: Partial<TimeoutSettings>;
  settings?: Partial<SettingsApi>;
  scheduler?: Partial<SchedulerApi>;
  memoryPanel?: Partial<MemoryPanelApi>;
  music?: Record<string, unknown>;
  tokenUsage?: Record<string, unknown>;
  user?: Record<string, unknown>;
  appUpdate?: Record<string, unknown>;
  plugins?: Record<string, unknown>;
  flushRounds?: number;
}

export interface MountedSettingsPage {
  settings: SettingsApi;
  emitChannelsStatusChanged: (status: unknown) => void;
  emitSwitchSection: (section: string) => void;
}

export async function mountSettingsPage(options: MountSettingsOptions = {}): Promise<MountedSettingsPage> {
  vi.resetModules();

  if (typeof window.localStorage?.clear === "function") {
    window.localStorage.clear();
  }
  window.location.hash = options.hash ?? "";
  document.documentElement.removeAttribute("data-ui-theme");
  document.documentElement.removeAttribute("data-reduce-motion");
  document.documentElement.style.cssText = "";
  document.body.innerHTML = extractBodyHtml();

  let currentGeneral = createDefaultGeneralSettings(options.general);
  let currentConfig = createDefaultModelSettings(options.config);
  let currentTimeouts: TimeoutSettings = { ...DEFAULT_TIMEOUT_SETTINGS, ...options.timeouts };
  let channelsStatusListener: ((status: unknown) => void) | null = null;
  let switchSectionListener: ((section: string) => void) | null = null;

  const baseSettings: SettingsApi = {
    minimize: vi.fn(),
    close: vi.fn(),
    getGeneral: vi.fn(async () => ({ ...currentGeneral })),
    saveGeneral: vi.fn(async (patch: Partial<GeneralSettings>) => {
      currentGeneral = { ...currentGeneral, ...patch };
      return { ...currentGeneral };
    }),
    getConfig: vi.fn(async () => ({ ...currentConfig })),
    saveConfig: vi.fn(async (patch: Partial<ModelSettings>) => {
      currentConfig = { ...currentConfig, ...patch };
      return { ...currentConfig };
    }),
    getTimeoutSettings: vi.fn(async () => ({ ...currentTimeouts })),
    saveTimeoutSettings: vi.fn(async (patch: Partial<TimeoutSettings>) => {
      currentTimeouts = { ...currentTimeouts, ...patch };
      return { ...currentTimeouts };
    }),
    onSwitchSection: vi.fn((callback: (section: string) => void) => {
      switchSectionListener = callback;
      return () => {
        if (switchSectionListener === callback) switchSectionListener = null;
      };
    }),
    pickUiFont: vi.fn(async () => null),
    importUiFont: vi.fn(async () => ({ ...DEFAULT_UI_FONT })),
    resetUiFont: vi.fn(async () => ({ ...DEFAULT_UI_FONT })),
    setPetAlwaysOnTop: vi.fn(),
    setPetVisible: vi.fn(),
    setPetZoom: vi.fn(),
    beginScreenshotHotkeyCapture: vi.fn(async () => true),
    endScreenshotHotkeyCapture: vi.fn(async () => true),
    openStickerManager: vi.fn(async () => ({ ok: true })),
    stickerPickFile: vi.fn(async () => null),
    stickerAdd: vi.fn(async () => ({ ok: false })),
    getToolCatalog: vi.fn(async () => []),
    getToolModeOverrides: vi.fn(async () => ({})),
    setToolModeOverride: vi.fn(async () => ({ ok: true })),
    getSkillCatalog: vi.fn(async () => []),
    rescanSkills: vi.fn(async () => ({ ok: true, count: 0 })),
    getSkillModeOverrides: vi.fn(async () => ({})),
    setSkillModeOverride: vi.fn(async () => ({ ok: true })),
    addMcpServer: vi.fn(async () => ({ ok: false })),
    removeMcpServer: vi.fn(async () => ({ ok: true })),
    setMcpServerEnabled: vi.fn(async () => ({ ok: true })),
    listMcpServers: vi.fn(async () => []),
    channelsGetConfig: vi.fn(async () => ({ wechat: {}, feishu: {}, qq: {} })),
    channelsSaveConfig: vi.fn(async (patch: unknown) => patch),
    channelsRestart: vi.fn(async () => ({ ok: true })),
    channelsSenderResolve: vi.fn(async () => ({ ok: true })),
    channelsQqTestConnection: vi.fn(async () => ({ ok: false })),
    channelsQqResolveAuthRequirement: vi.fn(async () => ({ ok: false, requiresAccessToken: false })),
    channelsQqBotTestConnection: vi.fn(async () => ({ ok: false })),
    channelsLogGet: vi.fn(async () => []),
    channelsLogClear: vi.fn(async () => ({ ok: true })),
    channelsContextBindingsGet: vi.fn(async () => ({ externalChats: [], bindings: [], conversations: [] })),
    channelsContextBind: vi.fn(async () => ({ ok: true })),
    channelsContextUnbind: vi.fn(async () => ({ ok: true })),
    onChannelsInstallProgress: vi.fn(() => () => {}),
    onChannelsWechatQrcode: vi.fn(() => () => {}),
    onChannelsWechatLoginDone: vi.fn(() => () => {}),
    channelsWechatLoginStart: vi.fn(async () => ({ ok: false })),
    channelsGetStatus: vi.fn(async () => ({})),
    onChannelsStatusChanged: vi.fn((callback: (status: unknown) => void) => {
      channelsStatusListener = callback;
      return () => {
        if (channelsStatusListener === callback) channelsStatusListener = null;
      };
    }),
    ...options.settings,
  };

  Object.assign(window, { settings: baseSettings });

  const win = window as unknown as Record<string, unknown>;
  if (options.scheduler) {
    win.fireflyScheduler = {
      list: vi.fn(async () => ({ ok: true, value: [] })),
      add: vi.fn(async () => ({ ok: false, error: "not mocked" })),
      update: vi.fn(async () => ({ ok: false, error: "not mocked" })),
      delete: vi.fn(async () => ({ ok: false, error: "not mocked" })),
      toggle: vi.fn(async () => ({ ok: false, error: "not mocked" })),
      fireNow: vi.fn(async () => ({ ok: false, error: "not mocked" })),
      getHistory: vi.fn(async () => ({ ok: true, value: [] })),
      getTools: vi.fn(async () => ({ ok: true, value: [] })),
      ...options.scheduler,
    };
  }
  if (options.memoryPanel) {
    win.memoryPanel = {
      getData: vi.fn(async () => ({
        backendStatus: { available: false },
        facts: [],
        candidates: [],
        coverage: { status: "unmeasured" },
        importedDocs: [],
      })),
      deleteImportedDoc: vi.fn(async () => ({ ok: false, deleted: 0 })),
      ...options.memoryPanel,
    };
  }
  if (options.music) win.music = options.music;
  if (options.tokenUsage) win.tokenUsage = options.tokenUsage;
  if (options.user) win.user = options.user;
  if (options.appUpdate) win.appUpdate = options.appUpdate;
  if (options.plugins) win.plugins = options.plugins;

  await import("./settings");
  await flushMicrotasks(options.flushRounds ?? 10);

  return {
    settings: baseSettings,
    emitChannelsStatusChanged: (status: unknown) => {
      channelsStatusListener?.(status);
    },
    emitSwitchSection: (section: string) => {
      switchSectionListener?.(section);
    },
  };
}

export function cleanupSettingsPage(): void {
  window.dispatchEvent(new Event("pagehide"));
  window.dispatchEvent(new Event("beforeunload"));

  for (const id of ["ff-modal-overlay", "ff-html-modal-overlay", "ff-input-modal-overlay"]) {
    document.getElementById(id)?.remove();
  }
  document.querySelectorAll(".ff-toast-container").forEach((node) => node.remove());

  modalState.ffOverlay = null;
  modalState.ffHtmlOverlay = null;
  modalState.ffInputOverlay = null;
  modalState.noticeContainer = null;
  modalState.blockingQueue = [];
  modalState.blockingActive = false;

  const win = window as unknown as Record<string, unknown>;
  for (const key of ["settings", "fireflyScheduler", "memoryPanel", "music", "tokenUsage", "user", "appUpdate", "plugins"]) {
    delete win[key];
  }

  document.body.innerHTML = "";
  document.documentElement.removeAttribute("data-ui-theme");
  document.documentElement.removeAttribute("data-reduce-motion");
  document.documentElement.style.cssText = "";
  window.location.hash = "";
  vi.useRealTimers();
}
