import { DEFAULT_CHAT_APPEARANCE } from "../../../shared/chat-appearance";
import { DEFAULT_TIMEOUT_SETTINGS, type TimeoutSettings } from "../../../shared/timeout-types";
import { DEFAULT_UI_COLORS } from "../../../shared/ui-colors";
import { DEFAULT_UI_FONT } from "../../../shared/ui-font";
import type { SchedulerApi } from "../scheduler/types";
import type { GeneralSettings, MemoryPanelApi, ModelSettings, SettingsApi, UserApi } from "./types";

declare global {
  interface Window {
    fireflyScheduler?: SchedulerApi;
    user?: UserApi;
    memoryPanel?: MemoryPanelApi;
  }
}

const unavailableSettings = async () => ({ ok: false, error: "settings api unavailable" });
const emptyList = async () => [];
const emptyObject = async () => ({});
const noSubscription = () => () => {};

// 浏览器预览没有持久化后端；这些默认值按功能域分别构造，避免凭据对象被复用。
function previewSearchSettings() {
  return {
    searchEngine: "off" as const,
    searchBochaKey: "", searchTavilyKey: "",
    searchMinimaxKey: "", searchAnySearchKey: "",
  };
}

function previewEmailSettings() {
  return {
    emailEnabled: false,
    emailSmtpHost: "", emailSmtpPort: 465, emailSmtpSecure: true,
    emailSmtpUser: "", emailSmtpPass: "", emailFromName: "",
  };
}

export function installPreviewBridge(): void {
  if (!window.settings) {
    (window as unknown as { settings: SettingsApi }).settings = {
      minimize: () => {},
      close: () => {},
      getConfig: () =>
        Promise.resolve({
          mode: "auto",
          provider: "DeepSeek",
          baseUrl: "https://api.deepseek.com",
          model: "deepseek-v4-pro",
          apiKey: "",
          stickerEnabled: false,
          stickerSize: "standard",
          stickerSimilarityThreshold: 0.55,
          chatRequestTimeoutSec: 300,
        }),
      saveConfig: (c) => Promise.resolve(c as ModelSettings),
      getGeneral: () => Promise.resolve({
        maxParallelToolCalls: 4,
        maxToolRounds: 200,
        runTimeoutMinutes: 120,
        petAlwaysOnTop: true,
        petVisible: true,
        petZoom: 1,
        ...DEFAULT_CHAT_APPEARANCE,
        sidebarVisible: true,
        language: "zh-CN",
        uiTheme: "pearl-white",
        uiColors: { ...DEFAULT_UI_COLORS },
        uiFont: DEFAULT_UI_FONT,
        uiIcon: "firefly",
        segmentedChatEnabled: true,
        proactiveChatMode: "off",
        proactiveDeliveryTarget: "local",
        chatSocialContextEnabled: true,
        screenshotHotkey: "Alt+Shift+S",
        weatherSource: "open-meteo",
        weatherEnabled: false,
        amapKey: "",
        travelEnabled: false,
        musicEnabled: true,
        playwrightMcpEnabled: false,
        ...previewSearchSettings(),
        ...previewEmailSettings(),
      }),
      saveGeneral: (c) => Promise.resolve(c as GeneralSettings),
      channelsGetConfig: () => Promise.resolve({ wechat: {}, feishu: {}, qq: {} }),
      channelsSaveConfig: emptyObject,
      channelsRestart: () => Promise.resolve({ ok: false }),
      channelsQqTestConnection: unavailableSettings,
      channelsQqResolveAuthRequirement: () =>
        Promise.resolve({ ok: false, requiresAccessToken: false, error: "settings api unavailable" }),
      channelsQqBotTestConnection: unavailableSettings,
      channelsSenderResolve: unavailableSettings,
      channelsLogGet: emptyList,
      channelsLogClear: () => Promise.resolve({ ok: true }),
      channelsContextBindingsGet: () => Promise.resolve({ externalChats: [], bindings: [], conversations: [] }),
      channelsContextBind: unavailableSettings,
      channelsContextUnbind: unavailableSettings,
      onChannelsInstallProgress: noSubscription,
      onChannelsWechatQrcode: noSubscription,
      onChannelsWechatLoginDone: noSubscription,
      channelsWechatLoginStart: unavailableSettings,
      channelsGetStatus: emptyObject,
      onChannelsStatusChanged: noSubscription,
      beginScreenshotHotkeyCapture: () => Promise.resolve(true),
      endScreenshotHotkeyCapture: () => Promise.resolve(true),
      setPetAlwaysOnTop: () => {},
      setPetVisible: () => {},
      setPetZoom: () => {},
      pickUiFont: () => Promise.resolve(null),
      importUiFont: () => Promise.resolve(DEFAULT_UI_FONT),
      resetUiFont: () => Promise.resolve(DEFAULT_UI_FONT),
      openStickerManager: unavailableSettings,
      stickerPickFile: async () => null,
      stickerAdd: async () => { throw new Error("settings api unavailable"); },
      getToolCatalog: emptyList,
      getToolModeOverrides: emptyObject,
      setToolModeOverride: unavailableSettings,
      getSkillCatalog: emptyList,
      rescanSkills: async () => ({ ok: false, count: 0, error: "settings api unavailable" }),
      getSkillModeOverrides: emptyObject,
      setSkillModeOverride: unavailableSettings,
      addMcpServer: unavailableSettings,
      removeMcpServer: unavailableSettings,
      setMcpServerEnabled: unavailableSettings,
      listMcpServers: emptyList,
      getTimeoutSettings: async () => DEFAULT_TIMEOUT_SETTINGS,
      saveTimeoutSettings: async c => (c as TimeoutSettings),
    };
  }

  if (!window.fireflyScheduler) {
    const missingScheduler = async () => ({ ok: false as const, error: "scheduler api unavailable" });
    const schedulerItems = async () => ({ ok: true as const, value: [] });
    const schedulerFallback: SchedulerApi = {
      list: schedulerItems,
      add: missingScheduler,
      update: missingScheduler,
      delete: missingScheduler,
      toggle: missingScheduler,
      fireNow: async () => ({ ok: false, reason: "scheduler api unavailable" }),
      getHistory: schedulerItems,
      getTools: schedulerItems,
    };
    window.fireflyScheduler = schedulerFallback;
  }
}
