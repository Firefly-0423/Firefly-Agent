import { showMemoryView } from "./memory/entries-panel";
import { bindDesktopAsrSettings } from "./desktop-asr-settings";
import type {} from "../global";
import { bindUiColorControls } from "./appearance/colors";
import { DEFAULT_UI_COLORS } from "../../shared/ui-colors";
import { parseContextWindowTokens } from "../../shared/context-window";
import { renderProviderRows } from "./api/provider-rows";
import { applyProviderEditorLayout, mountProfileEditor, placeSaveStatus, renderKeepingProfileEditor } from "./api/provider-editor";
import { bindSettingsNavigation, resolveSettingsSection, updateSettingsNavigation } from "./shared/navigation";
import { mountSettingsSearch } from "./shared/search";
import "../ui/base.css";
import "../ui/theme";
import { normalizeChatSocialContextEnabled, normalizeProactiveChatMode, normalizeProactiveDeliveryTarget, normalizeSegmentedChatEnabled, type ProactiveChatMode, type ProactiveDeliveryTarget } from "../../shared/preferences";
import { isProactiveDeliveryTargetSelectable } from "../../shared/proactive-delivery";
import { normalizeUiTheme, type UiTheme } from "../../shared/ui-theme";
import { DEFAULT_UI_FONT, normalizeUiFont, type UiFont } from "../../shared/ui-font";
import { normalizeUiIcon, type UiIcon } from "../../shared/ui-icon";
import { type ReasoningPreference } from "../../shared/reasoning";
import { resolveApiEndpoint, type ApiTransport } from "../../shared/api-endpoint";
import { CHAT_FONT_SIZE_MAX, CHAT_FONT_SIZE_MIN, CODE_FONT_SIZE_MAX, CODE_FONT_SIZE_MIN, DEFAULT_CHAT_APPEARANCE, UI_FONT_SIZE_MAX, UI_FONT_SIZE_MIN, clampFiniteNumber, normalizeChatAppearance, type ChatAppearanceSettings } from "../../shared/chat-appearance";
import { CUSTOM_ENDPOINT_PROVIDERS, getCustomEndpointMode, getCustomEndpointPresentation, getCustomEndpointProvider, validateCustomEndpointConfig, type CustomEndpointMode } from "./custom-endpoint-state";
import type { ScheduleConfig, SchedulerApi, SchedulerResult, SchedulerToolInfo, SchedulerToolMode, ScheduledTask, ScheduledTaskHistoryEntry } from "./scheduler/types";
import { channelsState } from "./channels/state";
import { mountPluginPanels } from "./plugin-panels";
import { channelsWechatEnabledEl, channelsFeishuEnabledEl, channelsWechatStatusEl, channelsFeishuStatusEl, channelsRateUserEl, channelsRateChannelEl, channelsStickerEl, channelsMirrorEl, channelsToolSandboxOffEl, channelsToolSandboxAllEl, channelsFeishuAppIdEl, channelsFeishuAppSecretEl, channelsFeishuAppSecretRevealBtn, channelsFeishuSaveBtn, channelsWechatLoginBtn, channelsWechatRestartBtn, channelsWechatFeedbackEl, channelsFeishuFeedbackEl, channelsLogListEl, channelsLogRefreshBtn, channelsLogClearBtn } from "./channels/dom";
import { memoryImportedList } from "./memory/dom";
import { schedulerState } from "./scheduler/state";
import { schedulerNewBtn, schedulerEmpty, schedulerList, schedulerEditor, schedulerEditorTitle, schedulerEditorClose, schedulerTitleInput, schedulerPromptInput, schedulerEnabledInput, schedulerKindInput, schedulerOnceRunAtInput, schedulerTimeOfDayInput, schedulerDayOfWeekInput, schedulerIntervalEveryInput, schedulerIntervalUnitInput, schedulerToolLimitInput, schedulerToolPicker, schedulerToolEmptyHint, schedulerSaveStatus, schedulerCancelBtn, schedulerSaveBtn } from "./scheduler/dom";
import { modalState } from "./shared/modal-state";
import { formatDateTime, escapeHtml } from "./shared/format";
import { parsePositiveIntOrThrow, parseCommandLine } from "./shared/parse";
import { apiState, type SavedProfileLite } from "./api/state";
import { bindReasoningLevels, readReasoningLevels, writeReasoningLevels } from "./api/reasoning-levels";
import { createModelPicker } from "./api/model-picker";
import { createInputModalitiesPanel, declarationOf, type InputModalitiesPanel } from "./api/input-modalities";
import { inputModalitiesSelect, inputModalitiesHint } from "./api/dom";
import type { InputModality } from "../../shared/input-modalities";
import { apiForm, apiRuntimeForm, presetCards, profileList, profileListCount, profileEditorTitle, deleteProfileBtn, presetWebsiteLink, displayNameInput, baseUrlInput, baseUrlResetBtn, modelInput, modelInputSuggestions, contextWindowInput, apiKeyInput, apiKeyLabel, apiKeyHint, testConnectionBtn, transportSelect, transportHint, endpointPreview, customEndpointControls, customEndpointOverrides, customEndpointSummary, customEndpointGuideBtn, workFlowAdaptBtn, apiNoteText, fetchModelsBtn, fetchModelsStatus, fetchModelsPicker, fetchModelsSearch, fetchModelsList, fetchModelsEmpty, embeddingDimensionsInput, toggleEnableThinking, toggleDisableThinking, toggleDisableMaxToken } from "./api/dom";
import { appearanceForm, appearanceSaveStatus, petAlwaysOnTopInput, petVisibleInput, petZoomInput, petZoomVal, chatLineHeightInput, chatLineHeightVal, chatParaSpacingInput, chatParaSpacingVal, uiFontCurrent, uiFontSelect, uiFontCustomOption, uiFontImportButton, uiFontResetButton, uiFontSizeInput, chatFontSizeInput, codeFontSizeInput, uiIconSelect, uiThemeSelect, screenshotHotkeyInput } from "./appearance/dom";
import { generalForm, languageSelect, segmentedChatEnabledInput, proactiveChatSelect, proactiveDeliveryRow, proactiveDeliverySelect, chatSocialContextEnabledInput, toastSoundEnabledInput, launchAtLoginInput, desktopSaveStatus } from "./general/dom";
import { minBtn, closeBtn, preferencesForm, sectionTitle, sectionHint, placeholderPanel, fireflyPanel, disclaimerPanel, pluginsPanel, placeholderIcon, placeholderTitle, placeholderCopy, saveStatus, runtimeSaveStatus, preferencesSaveStatus, fireflySaveStatus, openStickerManagerBtn, addStickerBtn } from "./shared/shell";
import { permissionBlocksWrap, permissionNote } from "./plugins/dom";
import { stickerEnabledInput, stickerSizeSelect, stickerThresholdInput, stickerThresholdVal, stickerAddOverlay, stickerAddPickBtn, stickerAddFileName, stickerAddId, stickerAddDesc, stickerAddPhrases, stickerAddError, stickerAddConfirm, stickerAddCancel } from "./preferences/dom";
import { pluginsState } from "./plugins/state";
import type { GeneralSettings, MemoryPanelApi, MemoryPanelPayload, ModelPreset, ModelSettings, ProviderProfile, SettingsApi, UserApi } from "./shared/types";
import { MODEL_PRESETS, sortPresetsForDisplay } from "./api/presets";
import { attachCardSelect, enhanceSelects } from "./shared/dropdown";
import { attachDatePicker } from "./shared/date-picker";
import { bindAppearanceAdvanced } from "./appearance/advanced";
import { trackRangeFills } from "./shared/range-fill";
import { userBirthdayInput } from "./user/dom";
import { showConfirm, showHtmlModal, showInputModal } from "./shared/modal";
import { setSaveStatus, setFireflySaveStatus, setPreferencesSaveStatus, setAppearanceSaveStatus, setRuntimeSaveStatus } from "./shared/save-status";
import { renderEmptyState, renderInfoList } from "./shared/render";
import { shallowEqual, safeGet } from "./shared/utils";
import { loadMemoryPanel, refreshShadowPanel } from "./memory/panel";
import { setSchedulerStatus, renderSchedulerTools, renderSchedulerList, loadSchedulerPanel, openSchedulerEditor, closeSchedulerEditor, updateSchedulerConditionalFields, collectSchedule, collectAllowedToolIds, saveSchedulerTask, toggleSchedulerTask, fireSchedulerTask, deleteSchedulerTask, toggleSchedulerHistory } from "./scheduler/panel";
import { loadMusicPanel, disposeMusicPanel } from "./music/qqmusic-panel";
import { loadChannelsPanel } from "./channels/panel";
import { renderProactiveDeliveryAvailability } from "./channels/panel";
import "./email/panel";
import "./search/panel";
import { saveTimeoutSettings } from "./timeout/panel";
import { DEFAULT_TIMEOUT_SETTINGS, type TimeoutSettings } from "../../shared/timeout-types";
import "./user/panel";
import "./plugins/panel";
import "./plugins/permission";
import "./rag/panel";
import "./preferences/panel";
import "./mcp/panel";
import { t, subscribeLocaleChanged } from "./i18n";
import { renderStickerSendStatus } from "./preferences/sticker-send-status";

declare global {
  interface Window {
    fireflyScheduler?: SchedulerApi;
    user?: UserApi;
    memoryPanel?: MemoryPanelApi;
  }
}

const MIMO_ICON_URL = "https://raw.githubusercontent.com/lobehub/lobe-icons/refs/heads/master/packages/static-png/light/xiaomimimo.png";

const unavailableSettings = async () => ({ ok: false, error: "settings api unavailable" });
const emptyList = async () => [];
const emptyObject = async () => ({});
const noSubscription = () => () => {};

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
      chatSocialContextEnabled: false,
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

const NAV_LABELS: Record<string, { emoji: string; title: string; hint: string }> = Object.fromEntries([
  ["usage", "", t("settings.usage.title"), t("settings.usage.hint")],
  ["subagents", "", t("settings.subagents.title"), t("settings.subagents.hint")],
  ["asr", "🎙", t("settings.desktopAsr.title"), t("settings.desktopAsr.hint")],
  ["memory", `<img src="../avatars/firefly-avatar.png" width="24" height="24" alt="" aria-hidden="true" style="vertical-align:-3px" />`, t("settings.nav.memory"), t("settings.nav.memoryHint")],
  ["chat", `<svg style="vertical-align:-3px" width="24" height="24" viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M33 38H22V30H36V22H44V38H39L36 41L33 38Z" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 6H36V30H17L13 34L9 30H4V6Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M19 18H20" stroke="currentColor" stroke-width="4" stroke-linecap="round"/><path d="M26 18H27" stroke="currentColor" stroke-width="4" stroke-linecap="round"/><path d="M12 18H13" stroke="currentColor" stroke-width="4" stroke-linecap="round"/></svg>`, t("settings.nav.chat"), t("settings.nav.chatHint")],
  ["user", `<svg style="vertical-align:-3px" width="24" height="24" viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M44 8H4V38H19L24 43L29 38H44V8Z" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="24" cy="19" r="5" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M33 32C33 27.5817 28.9706 24 24 24C19.0294 24 15 27.5817 15 32" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`, t("settings.nav.user"), t("settings.nav.userHint")],
  ["tasks", `<svg style="vertical-align:-3px" width="24" height="24" viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M23.9998 44.3332C34.1251 44.3332 42.3332 36.1251 42.3332 25.9999C42.3332 15.8747 34.1251 7.66656 23.9998 7.66656C13.8746 7.66656 5.6665 15.8747 5.6665 25.9999C5.6665 36.1251 13.8746 44.3332 23.9998 44.3332Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M23.7594 15.3536L23.7582 26.3624L31.5305 34.1347" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 9.00001L11 4.00001" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M44 9.00001L37 4.00001" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`, t("settings.nav.tasks"), t("settings.nav.tasksHint")],
  ["plugins", "🔌", t("settings.nav.plugins"), t("settings.nav.pluginsHint")],
  ["mcp", "🧩", t("settings.nav.mcp"), t("settings.mcpUi.hint")],
  ["preferences", `<svg width="24" height="24" viewBox="0 0 48 48" fill="none" aria-hidden="true" style="vertical-align:-3px"><title>偏好设置</title><path d="M12 35.0137H9H4V8.01273C4 6.90868 4.89543 6.01367 6 6.01367H42C43.1046 6.01367 44 6.90868 44 8.01273V35.0137H36" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M24 32L14 42H34L24 32Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/></svg>`, "偏好设置", "设置聊天窗口和输出行为的默认偏好"],
  ["appearance", `<svg width="24" height="24" viewBox="0 0 48 48" fill="none" aria-hidden="true" style="vertical-align:-3px"><title>外观设置</title><path d="M24 44C29.9601 44 26.3359 35.136 30 31C33.1264 27.4709 44 29.0856 44 24C44 12.9543 35.0457 4 24 4C12.9543 4 4 12.9543 4 24C4 35.0457 12.9543 44 24 44Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M28 17C29.6569 17 31 15.6569 31 14C31 12.3431 29.6569 11 28 11C26.3431 11 25 12.3431 25 14C25 15.6569 26.3431 17 28 17Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M16 21C17.6569 21 19 19.6569 19 18C19 16.3431 17.6569 15 16 15C14.3431 15 13 16.3431 13 18C13 19.6569 14.3431 21 16 21Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M17 34C18.6569 34 20 32.6569 20 31C20 29.3431 18.6569 28 17 28C15.3431 28 14 29.3431 14 31C14 32.6569 15.3431 34 17 34Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/></svg>`, "外观设置", "调整窗口布局、界面主题与流萤桌宠"],
  ["general", `<svg width="24" height="24" viewBox="0 0 48 48" fill="none" aria-hidden="true" style="vertical-align:-3px"><title>通用设置</title><path d="M18.2838 43.1713C14.9327 42.1736 11.9498 40.3213 9.58787 37.867C10.469 36.8227 11 35.4734 11 34.0001C11 30.6864 8.31371 28.0001 5 28.0001C4.79955 28.0001 4.60139 28.01 4.40599 28.0292C4.13979 26.7277 4 25.3803 4 24.0001C4 21.9095 4.32077 19.8938 4.91579 17.9995C4.94381 17.9999 4.97188 18.0001 5 18.0001C8.31371 18.0001 11 15.3138 11 12.0001C11 11.0488 10.7786 10.1493 10.3846 9.35011C12.6975 7.1995 15.5205 5.59002 18.6521 4.72314C19.6444 6.66819 21.6667 8.00013 24 8.00013C26.3333 8.00013 28.3556 6.66819 29.3479 4.72314C32.4795 5.59002 35.3025 7.1995 37.6154 9.35011C37.2214 10.1493 37 11.0488 37 12.0001C37 15.3138 39.6863 18.0001 43 18.0001C43.0281 18.0001 43.0562 17.9999 43.0842 17.9995C43.6792 19.8938 44 21.9095 44 24.0001C44 25.3803 43.8602 26.7277 43.594 28.0292C43.3986 28.01 43.2005 28.0001 43 28.0001C39.6863 28.0001 37 30.6864 37 34.0001C37 35.4734 37.531 36.8227 38.4121 37.867C36.0502 40.3213 33.0673 42.1736 29.7162 43.1713C28.9428 40.752 26.676 39.0001 24 39.0001C21.324 39.0001 19.0572 40.752 18.2838 43.1713Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M24 31C27.866 31 31 27.866 31 24C31 20.134 27.866 17 24 17C20.134 17 17 20.134 17 24C17 27.866 20.134 31 24 31Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/></svg>`, "通用设置", t("settings.nav.generalHint")],
  ["api", `<svg width="24" height="24" viewBox="0 0 48 48" fill="none" aria-hidden="true" style="vertical-align:-3px"><title>API 设置</title><g clip-path="url(#api-key-nav-clip)"><circle cx="15" cy="33" r="8" fill="none" stroke="currentColor" stroke-width="4"/><path d="M29 16L35.5 22" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M20 26L37 7" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M35 11L42 17.5" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></g><defs><clipPath id="api-key-nav-clip"><rect width="48" height="48" fill="none"/></clipPath></defs></svg>`, "API 设置", "选择预设后只需要填写 API Key。"],
  ["api-advanced", `<svg width="24" height="24" viewBox="0 0 48 48" fill="none" aria-hidden="true" style="vertical-align:-3px"><title>高级设置</title><path d="M34.0003 41L44 24L34.0003 7H14.0002L4 24L14.0002 41H34.0003Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M24 29C26.7614 29 29 26.7614 29 24C29 21.2386 26.7614 19 24 19C21.2386 19 19 21.2386 19 24C19 26.7614 21.2386 29 24 29Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/></svg>`, "高级设置", "配置 API 超时时间、调用模式．"],
  ["firefly", "🌸", t("settings.nav.firefly"), t("settings.nav.fireflyHint")],
  ["disclaimer", `<svg width="24" height="24" viewBox="0 0 48 48" fill="none" aria-hidden="true" style="vertical-align:-3px"><title>免责声明</title><rect x="13" y="10" width="28" height="34" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M35 10V4H8C7.44772 4 7 4.44772 7 5V38H13" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M21 22H33" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M21 30H33" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`, "免责声明", "使用条款与隐私说明"],
].map(([section, emoji, title, hint]) => [section, { emoji, title, hint }]));

minBtn.addEventListener("click", () => window.settings?.minimize());
closeBtn.addEventListener("click", () => window.settings?.close());

const uiColorControls = bindUiColorControls(appearanceForm, colors => window.settings!.saveGeneral({ uiColors: colors }));

async function saveAppearancePatch(patch: Partial<GeneralSettings>, successText = t("settings.status.applied")): Promise<void> {
  const report = setAppearanceSaveStatus;
  try {
    report(t("settings.status.applying"));
    await window.settings!.saveGeneral(patch);
    report(successText, "is-ok");
  } catch (failure) {
    console.error("自动应用外观设置失败:", failure);
    report(t("settings.status.applyFailed"), "is-error");
  }
}

function markChoice(button: HTMLButtonElement, selected: boolean, radio = false): void {
  button.classList.toggle("is-active", selected);
  if (radio) button.setAttribute("aria-checked", String(selected));
  button.setAttribute("aria-pressed", String(selected));
}

function selectButtons(root: HTMLElement, selector: string, matches: (button: HTMLButtonElement) => boolean, radio = false): void {
  for (const button of root.querySelectorAll<HTMLButtonElement>(selector)) {
    markChoice(button, matches(button), radio);
  }
}

function applyOptionGroupValue(group: HTMLElement, value: string): void {
  selectButtons(group, ".option-block", option => option.dataset.value === value);
}

function getOptionGroupValue(group: HTMLElement, fallback: string): string {
  const selected = group.querySelector<HTMLButtonElement>(".option-block.is-active");
  return selected?.dataset.value ?? fallback;
}

function stickerSize(value: string | undefined): "small" | "standard" | "large" {
  if (value === "small" || value === "large") return value;
  return "standard";
}

function getStickerSizeValue(): "small" | "standard" | "large" {
  return stickerSize(getOptionGroupValue(stickerSizeSelect, "standard"));
}

function applyStickerSizeSelection(size: "small" | "standard" | "large"): void {
  applyOptionGroupValue(stickerSizeSelect, size);
}

type UiLanguage = "zh-CN" | "en";
const normalizeUiLanguage = (language: unknown): UiLanguage => language === "en" ? "en" : "zh-CN";
const applyLanguageSelection = (language: UiLanguage): void => {
  selectButtons(languageSelect, ".language-option", option => option.dataset.lang === language);
};

const applyProactiveChatSelection = (mode: ProactiveChatMode): void => applyOptionGroupValue(proactiveChatSelect, mode);
const applyProactiveDeliverySelection = (target: ProactiveDeliveryTarget): void => applyOptionGroupValue(proactiveDeliverySelect, target);
const getProactiveChatValue = (): ProactiveChatMode => normalizeProactiveChatMode(getOptionGroupValue(proactiveChatSelect, "off"));
const getProactiveDeliveryValue = (): ProactiveDeliveryTarget => normalizeProactiveDeliveryTarget(getOptionGroupValue(proactiveDeliverySelect, "local"));

function renderProactiveDeliveryVisibility(): void {
  const enabled = getProactiveChatValue() === "on";
  proactiveDeliveryRow.hidden = !enabled;
}

function renderUiFont(font: UiFont): void {
  uiFontCurrent.textContent = font.kind === "custom" ? font.displayName : t("settings.appearance.font.defaultNotion");
  uiFontResetButton.hidden = font.kind !== "custom";
  uiFontCustomOption.disabled = font.kind !== "custom";
  uiFontSelect.value = font.kind === "custom" ? "custom" : "default";
}

// 外观排版：行高、段间距、三个字号。设置窗口自己的界面字号即时生效，其他窗口由主进程广播。
type PixelSizeKey = "uiFontSize" | "chatFontSize" | "codeFontSize";
const pixelSizeInputs: Record<PixelSizeKey, HTMLInputElement> = {
  uiFontSize: uiFontSizeInput,
  chatFontSize: chatFontSizeInput,
  codeFontSize: codeFontSizeInput,
};
const pixelSizeRanges: Record<PixelSizeKey, [number, number]> = {
  uiFontSize: [UI_FONT_SIZE_MIN, UI_FONT_SIZE_MAX],
  chatFontSize: [CHAT_FONT_SIZE_MIN, CHAT_FONT_SIZE_MAX],
  codeFontSize: [CODE_FONT_SIZE_MIN, CODE_FONT_SIZE_MAX],
};
let savedChatAppearance: ChatAppearanceSettings = { ...DEFAULT_CHAT_APPEARANCE };
// The "高级" preferences save on their own; a reset also restores the sizes and spacing above, so redraw those too.
const appearanceAdvanced = bindAppearanceAdvanced(appearanceForm, async patch => {
  await saveAppearancePatch(patch as Partial<GeneralSettings>);
  if ("chatLineHeight" in patch) renderChatAppearanceControls({ ...savedChatAppearance, ...patch });
});

function renderChatAppearanceControls(settings: ChatAppearanceSettings): void {
  savedChatAppearance = settings;
  appearanceAdvanced.render(settings);
  chatLineHeightInput.value = String(settings.chatLineHeight);
  chatLineHeightVal.textContent = settings.chatLineHeight.toFixed(2);
  document.documentElement.style.setProperty("--rb-chat-line-height", String(settings.chatLineHeight));
  chatParaSpacingInput.value = String(settings.chatParaSpacing);
  chatParaSpacingVal.textContent = settings.chatParaSpacing.toFixed(2) + "em";
  document.documentElement.style.setProperty("--rb-chat-para-spacing", settings.chatParaSpacing + "em");
  for (const key of Object.keys(pixelSizeInputs) as PixelSizeKey[]) {
    pixelSizeInputs[key].value = String(settings[key]);
  }
  document.documentElement.style.setProperty("--ff-ui-font-size", `${settings.uiFontSize}px`);
}

function bindPixelSizeInput(key: PixelSizeKey): void {
  const input = pixelSizeInputs[key];
  const [min, max] = pixelSizeRanges[key];
  input.addEventListener("input", () => {
    const value = Number(input.value);
    if (input.value.trim() && Number.isFinite(value) && key === "uiFontSize") {
      document.documentElement.style.setProperty("--ff-ui-font-size", `${clampFiniteNumber(value, min, max, savedChatAppearance.uiFontSize)}px`);
    }
    setAppearanceSaveStatus(t("settings.status.releaseApply"));
  });
  input.addEventListener("change", () => {
    const raw = input.value.trim();
    const value = Number(raw);
    if (!raw || !Number.isFinite(value)) {
      input.value = String(savedChatAppearance[key]);
      return;
    }
    const next = Math.round(clampFiniteNumber(value, min, max, savedChatAppearance[key]));
    input.value = String(next);
    savedChatAppearance = { ...savedChatAppearance, [key]: next };
    void saveAppearancePatch({ [key]: next } as Partial<GeneralSettings>);
  });
}

function renderUiTheme(theme: UiTheme): void {
  selectButtons(uiThemeSelect, ".appearance-theme-option", option => option.dataset.value === theme, true);
}

function renderUiIcon(icon: UiIcon): void {
  selectButtons(uiIconSelect, ".appearance-icon-option", option => option.dataset.icon === icon);
}

function presetLogo(preset: ModelPreset): HTMLSpanElement {
  const logo = document.createElement("span");
  logo.className = "preset-card__logo";
  if (!preset.iconUrl) {
    logo.textContent = preset.shortName.charAt(0);
    return logo;
  }
  const image = document.createElement("img");
  Object.assign(image, { src: preset.iconUrl, alt: "", width: 24, height: 24 });
  logo.appendChild(image);
  return logo;
}

function fillPresetOptions(): void {
  if (!presetCards) return;
  presetCards.replaceChildren();
  const visible = sortPresetsForDisplay(MODEL_PRESETS).filter(preset => !preset.hiddenInPresetList && !preset.customEndpointMode);
  visible.forEach(preset => {
    const choice = document.createElement("button");
    choice.type = "button";
    choice.className = "preset-card";
    choice.dataset.provider = preset.providerName;
    if (preset.disabled) {
      choice.classList.add("is-disabled");
      choice.disabled = true;
    }
    choice.appendChild(presetLogo(preset));
    const name = document.createElement("span");
    name.className = "preset-card__name";
    name.textContent = preset.shortName;
    if (preset.disabled) name.textContent += t("settings.preset.disabledSuffix");
    choice.appendChild(name);
    presetCards.appendChild(choice);
  });
}

function setActivePresetCard(provider: string): void {
  if (!presetCards) return;
  const selected = getCustomEndpointMode(provider) ? CUSTOM_ENDPOINT_PROVIDERS.cloud : provider;
  for (const card of presetCards.querySelectorAll<HTMLElement>(".preset-card")) {
    card.classList.toggle("is-active", card.dataset.provider === selected);
  }
}

function findPreset(provider: string): ModelPreset {
  const firstAvailable = MODEL_PRESETS.find(candidate => !candidate.disabled) ?? MODEL_PRESETS[0];
  return MODEL_PRESETS.find(candidate => candidate.providerName === provider) ?? firstAvailable;
}

// 表单每次被填成另一个档案 / 厂商，就作废还在路上的“获取模型列表”，并收起上一个档案的候选列表。
// 输入类型面板：三态控件 + 生效结果说明；状态与保存口径见 api/input-modalities.ts。
const inputModalities: InputModalitiesPanel = createInputModalitiesPanel({ select: inputModalitiesSelect, hint: inputModalitiesHint }, {
  getProvider: () => apiState.activeProvider,
  getModel: () => modelInput.value.trim(),
  resolve: (input) => window.settings?.resolveInputModalities?.(input) ?? Promise.resolve(undefined),
  t: (key) => t(key),
  onChange: () => updateProfileDraftState(),
});
/** 最近一次“获取模型列表”给出的各型号输入模态；选中某个型号时记为厂商接口记录。 */
const fetchedInputModalities = new Map<string, InputModality[] | undefined>();
let fetchModelsGeneration = 0;
let closeFetchedModelPicker: () => void = () => {};
function fillModelSuggestions(models: readonly { id: string; name?: string }[]): void {
  modelInputSuggestions.replaceChildren();
  models.forEach(({ id, name }) => {
    const suggestion = document.createElement("option");
    suggestion.value = id;
    if (name) suggestion.label = name;
    modelInputSuggestions.appendChild(suggestion);
  });
}

function fillModelOptions(preset: ModelPreset, preferredModel?: string): void {
  ++fetchModelsGeneration;
  fetchedInputModalities.clear();
  closeFetchedModelPicker();
  if (fetchModelsStatus) {
    fetchModelsStatus.textContent = "";
    fetchModelsStatus.classList.remove("is-error", "is-ok");
  }
  fillModelSuggestions(preset.mainModels.map(id => ({ id })));
  modelInput.value = preferredModel ?? preset.mainModels[0] ?? "";
  inputModalities.modelChanged();
}

// ── 档案编辑（表单绑定档案，不再绑定"当前厂商"） ────────────────

// Only profile fields are replaced by profile/provider navigation. Global timeout
// and override controls retain their values when the editor changes.
// An async response belongs to the form instance that submitted it.
function isCurrentProfilePanel(): boolean {
  return document.getElementById("api-form") === apiForm;
}

let profileDraftBaseline = "";
let profileTransitionPending = false;
let profileSavePending = false;
let profileEditorReturnProfileId: string | undefined;
const profilePendingButtons = new Map<HTMLButtonElement, boolean>();

function profileDraftSnapshot(): string {
  return JSON.stringify([
    apiState.activeProvider, displayNameInput.value, baseUrlInput.value,
    modelInput.value, apiKeyInput.value, transportSelect.value,
    contextWindowInput.value,
    readReasoningLevels() ?? null,
    inputModalities.declared() ?? null,
  ]);
}

function hasUnsavedProfileDraft(): boolean {
  return apiState.editorOpen && profileDraftSnapshot() !== profileDraftBaseline;
}

/** Present the existing draft state without inferring connection health or saving anything. */
function updateProfileDraftState(): void {
  const state = document.getElementById("profile-draft-state");
  const editor = document.getElementById("profile-editor");
  editor?.setAttribute("aria-busy", String(profileSavePending));
  if (profileSavePending) {
    apiForm.querySelectorAll<HTMLButtonElement>('button[type="submit"], #close-profile-editor, #delete-profile-btn, #add-profile-btn, [data-profile-action], [data-provider-tab], .preset-card, [data-custom-endpoint-mode]').forEach(button => {
      if (!profilePendingButtons.has(button)) profilePendingButtons.set(button, button.disabled);
      button.disabled = true;
    });
  } else {
    for (const [button, disabled] of profilePendingButtons) button.disabled = disabled;
    profilePendingButtons.clear();
  }
  if (!state) return;
  const kind = profileSavePending ? "saving" : hasUnsavedProfileDraft() ? "dirty" : apiState.editingProfileId ? "saved" : "new";
  state.dataset.state = kind;
  const text = t(`settings.providerUi.draftState.${kind}`);
  if (state.textContent !== text) state.textContent = text;
}

/** Keep clean navigation synchronous; a single pending prompt owns its target. */
function changeProfileEditor(change: () => void): void {
  if (profileTransitionPending || profileSavePending) return;
  if (!hasUnsavedProfileDraft()) {
    change();
    return;
  }
  profileTransitionPending = true;
  void showConfirm({
    title: t("settings.providerUi.discardTitle"),
    message: t("settings.providerUi.discardMessage"),
    confirmText: t("settings.providerUi.discardConfirm"),
    cancelText: t("settings.providerUi.discardCancel"),
    dangerous: true,
  }).then(confirmed => {
    profileTransitionPending = false;
    if (confirmed) change();
  });
}

/** 已配置模型列表：每个档案一张卡片，编辑器内联在选中的卡片里。 */
function renderProfileList(): void {
  if (!profileList) return;
  const count = apiState.profiles.length;
  profileListCount.textContent = count ? t("settings.profile.count", { count }) : "";
  const editingId = apiState.editorOpen ? apiState.editingProfileId : undefined;
  // 编辑器挂在选中的卡片里：重绘前先让出，重绘后挂回（草稿与焦点原样保留）。
  renderKeepingProfileEditor(apiForm, editingId, () => {
    if (count === 0) {
      profileList.replaceChildren();
      const empty = document.createElement("div");
      empty.className = "profile-list__empty";
      empty.textContent = t(apiState.profilesLoadState === "loading"
        ? "settings.profile.loading"
        : apiState.profilesLoadState === "error"
          ? "settings.profile.readFailed"
          : "settings.profile.empty");
      profileList.appendChild(empty);
      return;
    }
    renderProviderRows(profileList, apiState.profiles, apiState.defaultProfileId, editingId);
  });
}

/** 从 main 拉取档案列表并渲染。 */
async function reloadProfiles(): Promise<void> {
  if (!isCurrentProfilePanel()) return;
  apiState.profilesLoadState = "loading";
  renderProfileList();
  try {
    const catalog = await window.settings?.listModelProfiles?.();
    if (!isCurrentProfilePanel()) return;
    if (!catalog) throw new Error("Model profile bridge unavailable");
    apiState.profiles = catalog.profiles as SavedProfileLite[];
    apiState.defaultProfileId = catalog.defaultModelProfileId;
    apiState.profilesLoadState = "ready";
    renderProfileList();
  } catch (error) {
    if (!isCurrentProfilePanel()) return;
    apiState.profilesLoadState = "error";
    renderProfileList();
    throw error;
  }
}

function applyEditingStateUI(): void {
  const editing = Boolean(apiState.editingProfileId);
  profileEditorTitle.textContent = t(editing ? "settings.profile.editorTitle.edit" : "settings.profile.editorTitle.new");
  deleteProfileBtn.hidden = !editing;
  document.getElementById("profile-editor")!.hidden = !apiState.editorOpen;
  // 新建草稿展开时，“添加模型提供商”让位给草稿本身。
  document.getElementById("add-profile-btn")!.hidden = apiState.editorOpen && !apiState.editingProfileId;
  document.querySelector<HTMLElement>(".provider-tabs")!.hidden = Boolean(apiState.editingProfileId);
  applyProviderEditorLayout(apiForm, getCustomEndpointMode(apiState.activeProvider) ? "custom" : "preset", Boolean(apiState.editingProfileId));
  syncCustomEndpointControlsVisibility();
  mountProfileEditor(apiForm, apiState.editorOpen ? apiState.editingProfileId : undefined);
  placeSaveStatus(apiForm, apiState.editorOpen);
}

/** 云端/本地切换与接入说明只在“添加自定义 API”时出现；已保存的卡片里切模式等于换了一份新草稿，会让人困惑。 */
function syncCustomEndpointControlsVisibility(): void {
  customEndpointControls.hidden = !getCustomEndpointMode(apiState.activeProvider) || Boolean(apiState.editingProfileId);
}

/** 载入档案到编辑表单。 */
function editProfile(profile: SavedProfileLite): void {
  Object.assign(apiState, { editorOpen: true, editingProfileId: profile.id, editingReasoning: profile.reasoning });
  applyPreset(profile.provider, profile.model, profile.apiKey, profile.baseUrl, profile.displayName, profile.explicitTransport);
  // 档案级字段：未定义 = 老档案，留空按默认值
  contextWindowInput.value = profile.contextWindowTokens ? String(profile.contextWindowTokens) : "";
  writeReasoningLevels(profile.reasoningLevels);
  inputModalities.load(declarationOf(profile), modelInput.value.trim());
  applyEditingStateUI();
  renderProfileList();
  profileDraftBaseline = profileDraftSnapshot();
  updateProfileDraftState();
  setSaveStatus(t("settings.profile.editing", { name: profile.displayName || profile.model }));
  (getCustomEndpointMode(profile.provider) ? displayNameInput : apiKeyInput).focus();
}

/** 开始新建草稿：preset 预填 URL/模型/协议，清空 Key 与昵称。 */
function startNewDraft(providerName: string): void {
  profileEditorReturnProfileId = undefined;
  apiState.editorOpen = true;
  apiState.editingProfileId = undefined;
  apiState.editingReasoning = undefined;
  applyPreset(providerName);
  contextWindowInput.value = "";
  writeReasoningLevels(undefined);
  inputModalities.load(undefined, modelInput.value.trim());
  applyEditingStateUI();
  renderProfileList();
  profileDraftBaseline = profileDraftSnapshot();
  updateProfileDraftState();
  setSaveStatus(t("settings.status.waiting"));
}

/** 模式按钮已删除——模型名永远从 input 读取。保留函数名供旧调用点用，语义不变。 */
function getCurrentModelValue(): string {
  return modelInput.value;
}

const LOCAL_ENDPOINT_AUTH_FALLBACK = "__FIREFLY_LOCAL_NO_AUTH__";

function getApiKeyForRequest(): string {
  const key = apiKeyInput.value.trim();
  if (getCustomEndpointMode(apiState.activeProvider) !== "local" || key) return key;
  return LOCAL_ENDPOINT_AUTH_FALLBACK;
}

function validateActiveCustomEndpoint(): string | null {
  const kind = getCustomEndpointMode(apiState.activeProvider);
  return kind ? validateCustomEndpointConfig(kind, {
    baseUrl: baseUrlInput.value,
    model: getCurrentModelValue(),
    apiKey: apiKeyInput.value,
  }) : null;
}

function updateEndpointPreview(): void {
  const protocol = transportSelect.value as ApiTransport;
  const address = baseUrlInput.value.trim();
  const defaultSuffix = protocol === "anthropic" ? "/v1/messages" : protocol === "responses" ? "/responses" : "/chat/completions";
  if (!address) {
    endpointPreview.textContent = t("settings.api.endpointPreview.default", { defaultSuffix });
    return;
  }
  const resolved = resolveApiEndpoint(address, protocol);
  endpointPreview.textContent = resolved.appendedSuffix
    ? t("settings.api.endpointPreview.suffix", { appendedSuffix: resolved.appendedSuffix, url: resolved.url })
    : t("settings.api.endpointPreview.full", { url: resolved.url });
}

function applyCustomEndpointUI(preset: ModelPreset): void {
  const mode = getCustomEndpointMode(preset.providerName);
  customEndpointControls.hidden = mode === null || Boolean(apiState.editingProfileId);
  customEndpointOverrides.hidden = mode === null;
  transportSelect.disabled = false;
  if (mode) {
    apiState.customEndpointMode = mode;
    const view = getCustomEndpointPresentation(mode);
    selectButtons(customEndpointControls, "[data-custom-endpoint-mode]", button => button.dataset.customEndpointMode === mode);
    customEndpointSummary.textContent = t(mode === "local" ? "settings.customEndpoint.localHint" : "settings.customEndpoint.cloudHint");
    apiKeyLabel.textContent = view.apiKeyOptional ? t("settings.customEndpoint.apiKey.optional") : "API Key";
    apiKeyHint.textContent = t(view.apiKeyOptional ? "settings.customEndpoint.apiKey.localHint" : "settings.customEndpoint.apiKey.proxyHint");
    apiKeyInput.placeholder = view.apiKeyOptional ? t("settings.customEndpoint.apiKey.optionalPlaceholder") : "sk-...";
    baseUrlInput.placeholder = view.baseUrlPlaceholder;
    modelInput.placeholder = t("settings.customEndpoint.modelPlaceholder");
    transportHint.textContent = t("settings.customEndpoint.transportHint");
    baseUrlResetBtn.title = t("settings.customEndpoint.baseUrlResetTitle");
    apiNoteText.textContent = t("settings.customEndpoint.note");
    return;
  }
  apiKeyLabel.textContent = "API Key";
  apiKeyHint.textContent = t("settings.api.keyHint.default");
  apiKeyInput.placeholder = "sk-...";
  baseUrlInput.placeholder = "https://api.deepseek.com";
  modelInput.placeholder = t("settings.api.modelPlaceholder.default");
  transportHint.textContent = t("settings.api.transportHint.default");
  baseUrlResetBtn.title = t("settings.api.baseUrlResetTitle.default");
  apiNoteText.textContent = t("settings.api.note.default");
}

function presetAddress(preset: ModelPreset, protocol: ApiTransport, address: string): string {
  if (!preset.anthropicBaseUrl) return address;
  if (protocol === "anthropic" && address === preset.baseUrl) return preset.anthropicBaseUrl;
  if ((protocol === "openai" || protocol === "responses") && address === preset.anthropicBaseUrl) return preset.baseUrl;
  return address;
}

function showPresetWebsite(preset: ModelPreset): void {
  if (!preset.websiteUrl) {
    presetWebsiteLink.style.display = "none";
    return;
  }
  presetWebsiteLink.href = preset.websiteUrl;
  presetWebsiteLink.title = t("settings.preset.websiteTitle", { shortName: preset.shortName });
  presetWebsiteLink.style.display = "";
}

export function applyPreset(
  providerName: string,
  preferredModel?: string,
  preferredApiKey?: string,
  preferredBaseUrl?: string,
  preferredDisplayName?: string,
  preferredExplicitTransport?: ApiTransport,
): void {
  const chosen = findPreset(providerName);
  setActivePresetCard(chosen.providerName);
  displayNameInput.value = preferredDisplayName && preferredDisplayName !== chosen.shortName ? preferredDisplayName : "";
  displayNameInput.placeholder = chosen.shortName;
  const protocol = preferredExplicitTransport ?? chosen.transport;
  baseUrlInput.value = presetAddress(chosen, protocol, preferredBaseUrl ?? chosen.baseUrl);
  fillModelOptions(chosen, preferredModel);
  const custom = getCustomEndpointMode(chosen.providerName);
  // 无鉴权的本地标记不显示在输入框；切换档案必须清掉上一份密钥。
  apiKeyInput.value = custom === "local" && preferredApiKey === LOCAL_ENDPOINT_AUTH_FALLBACK ? "" : preferredApiKey ?? "";
  transportSelect.value = protocol;
  applyCustomEndpointUI(chosen);
  updateEndpointPreview();
  showPresetWebsite(chosen);
  apiState.activeProvider = chosen.providerName;
  applyProviderEditorLayout(apiForm, custom ? "custom" : "preset", Boolean(apiState.editingProfileId));
}

function restoreModelSettings(config: ModelSettings): void {
  applyPreset(config.provider, config.model, config.apiKey, config.baseUrl, config.displayName, config.explicitTransport);
  stickerEnabledInput.checked = config.stickerEnabled !== false;
  syncStickerSendStatus();
  applyStickerSizeSelection(config.stickerSize);
  const similarity = config.stickerSimilarityThreshold ?? 0.55;
  stickerThresholdInput.value = String(similarity);
  stickerThresholdVal.textContent = similarity.toFixed(2);
  if (embeddingDimensionsInput) embeddingDimensionsInput.value = config.embeddingDimensions ? String(config.embeddingDimensions) : "";
  toggleEnableThinking.checked = config.thinkingOverride === 1;
  toggleDisableThinking.checked = config.thinkingOverride === -1;
  toggleDisableMaxToken.checked = !!config.disableMaxToken;
}

async function loadConfig(): Promise<void> {
  try {
    fillPresetOptions();
    const cfg = await window.settings!.getConfig();
    if (!isCurrentProfilePanel()) return;
restoreModelSettings(cfg);

    // 所有卡片默认折叠（默认档案只带“默认”标记），点“编辑”才展开；
    // 表单里的全局项（超时等）已由各自面板按已存配置填好。
    await reloadProfiles();
    if (!isCurrentProfilePanel()) return;

    applyEditingStateUI();
    setSaveStatus(t("settings.status.waiting"));
    setFireflySaveStatus(t("settings.status.waiting"));
  } catch {
    if (!isCurrentProfilePanel()) return;
    fillPresetOptions();
    apiState.profilesLoadState = "error";
    renderProfileList();
    setSaveStatus(t("settings.status.readFailed"), "is-error");
    setFireflySaveStatus(t("settings.status.readFailed"), "is-error");
  }
}

function restorePetAndAppearance(config: GeneralSettings): void {
  petAlwaysOnTopInput.checked = config.petAlwaysOnTop;
  petVisibleInput.checked = config.petVisible;
  const zoom = config.petZoom ?? 1;
  petZoomInput.value = String(zoom);
  petZoomVal.textContent = Math.round(zoom * 100) + "%";
  renderChatAppearanceControls(normalizeChatAppearance(config));
  renderUiFont(normalizeUiFont(config.uiFont));
  renderUiIcon(normalizeUiIcon(config.uiIcon));
  renderUiTheme(normalizeUiTheme(config.uiTheme));
}

function restoreChatPreferences(config: GeneralSettings): void {
  segmentedChatEnabledInput.checked = normalizeSegmentedChatEnabled(config.segmentedChatEnabled);
  applyProactiveChatSelection(normalizeProactiveChatMode(config.proactiveChatMode));
  applyProactiveDeliverySelection(normalizeProactiveDeliveryTarget(config.proactiveDeliveryTarget));
  renderProactiveDeliveryVisibility();
  if (screenshotHotkeyInput) screenshotHotkeyInput.value = config.screenshotHotkey ?? "Alt+Shift+S";
}

async function loadGeneralSettings(): Promise<void> {
  try {
    const cfg = await window.settings!.getGeneral();
    uiColorControls.load(cfg.uiColors);
    chatSocialContextEnabledInput.checked = normalizeChatSocialContextEnabled(cfg.chatSocialContextEnabled);
    toastSoundEnabledInput.checked = cfg.toastSoundEnabled !== false;
    launchAtLoginInput.checked = cfg.launchAtLogin === true;
    restorePetAndAppearance(cfg);
    restoreChatPreferences(cfg);
    void window.settings!.channelsGetStatus()
      .then((status: unknown) => renderProactiveDeliveryAvailability(status as Record<string, { phase?: string }>))
      .catch(() => renderProactiveDeliveryAvailability({}));
    applyLanguageSelection(normalizeUiLanguage(cfg.language));
    setPreferencesSaveStatus(t("settings.status.waiting"));
    setAppearanceSaveStatus(t("settings.status.waiting"));
  } catch {
    setPreferencesSaveStatus(t("settings.status.prefsReadFailed"), "is-error");
    setAppearanceSaveStatus(t("settings.status.appearanceReadFailed"), "is-error");
  }
}

function bindExclusiveToggle(selected: HTMLInputElement, other: HTMLInputElement): void {
  selected.addEventListener("change", () => {
    if (selected.checked) other.checked = false;
  });
}
bindExclusiveToggle(toggleEnableThinking, toggleDisableThinking);
bindExclusiveToggle(toggleDisableThinking, toggleEnableThinking);

function syncStickerSendStatus(): void {
  const display = document.getElementById("sticker-send-status");
  if (display) renderStickerSendStatus(display, stickerEnabledInput.checked);
}

const dirtyStickers = (): void => setFireflySaveStatus(t("settings.status.dirty"));
const dirtyPreferences = (): void => setPreferencesSaveStatus(t("settings.status.dirty"));

function onChoice(root: HTMLElement, selector: string, choose: (button: HTMLButtonElement) => void): void {
  root.querySelectorAll<HTMLButtonElement>(selector).forEach(option => {
    option.addEventListener("click", () => choose(option));
  });
}

stickerEnabledInput.addEventListener("change", () => {
  syncStickerSendStatus();
  dirtyStickers();
});
onChoice(stickerSizeSelect, ".option-block", option => {
  applyStickerSizeSelection(stickerSize(option.dataset.value));
  dirtyStickers();
});
stickerThresholdInput.addEventListener("input", () => {
  stickerThresholdVal.textContent = parseFloat(stickerThresholdInput.value).toFixed(2);
  dirtyStickers();
});

(["uiFontSize", "chatFontSize", "codeFontSize"] as PixelSizeKey[]).forEach(bindPixelSizeInput);
uiFontSelect.addEventListener("change", () => {
  if (uiFontSelect.value === "default") uiFontResetButton.click();
});

function bindPetControl(control: HTMLInputElement, apply: () => void): void {
  control.addEventListener("change", () => {
    apply();
    setAppearanceSaveStatus(t("settings.status.appliedOk"), "is-ok");
  });
}
bindPetControl(petAlwaysOnTopInput, () => window.settings?.setPetAlwaysOnTop(petAlwaysOnTopInput.checked));

async function changeFont(action: "import" | "reset"): Promise<void> {
  const importing = action === "import";
  const trigger = importing ? uiFontImportButton : uiFontResetButton;
  try {
    let path: string | null | undefined;
    if (importing) {
      path = await window.settings?.pickUiFont();
      if (!path) return;
    }
    trigger.disabled = true;
    if (importing) setAppearanceSaveStatus(t("settings.status.importingFont"));
    const font = importing ? await window.settings!.importUiFont(path!) : await window.settings!.resetUiFont();
    renderUiFont(font);
    setAppearanceSaveStatus(t(importing ? "settings.status.fontApplied" : "settings.status.fontResetOk"), "is-ok");
  } catch (failure) {
    console.error(importing ? "导入字体失败:" : "恢复默认字体失败:", failure);
    setAppearanceSaveStatus(t(importing ? "settings.status.importFontFailed" : "settings.status.fontResetFailed"), "is-error");
  } finally {
    trigger.disabled = false;
  }
}
uiFontImportButton.addEventListener("click", () => void changeFont("import"));
uiFontResetButton.addEventListener("click", () => void changeFont("reset"));

async function chooseTheme(option: HTMLButtonElement): Promise<void> {
  const chosen = normalizeUiTheme(option.dataset.value);
  const previous = uiThemeSelect.querySelector<HTMLButtonElement>(".appearance-theme-option.is-active")?.dataset.value;
  if (previous === chosen) return;
  renderUiTheme(chosen);
  try {
    await window.settings!.saveGeneral({ uiTheme: chosen });
    setAppearanceSaveStatus(t("settings.status.themeApplied"), "is-ok");
  } catch (failure) {
    console.error("应用主题失败:", failure);
    renderUiTheme(normalizeUiTheme(previous));
    setAppearanceSaveStatus(t("settings.status.themeFailed"), "is-error");
  }
}
onChoice(uiThemeSelect, ".appearance-theme-option", option => void chooseTheme(option));

async function chooseIcon(option: HTMLButtonElement): Promise<void> {
  const chosen = normalizeUiIcon(option.dataset.icon);
  try {
    await window.settings!.saveGeneral({ uiIcon: chosen });
    renderUiIcon(chosen);
    setAppearanceSaveStatus(t("settings.status.iconApplied"), "is-ok");
  } catch (failure) {
    console.error("应用图标失败:", failure);
    setAppearanceSaveStatus(t("settings.status.iconFailed"), "is-error");
  }
}
onChoice(uiIconSelect, ".appearance-icon-option", option => void chooseIcon(option));

bindPetControl(petVisibleInput, () => window.settings?.setPetVisible(petVisibleInput.checked));
petZoomInput.addEventListener("input", () => {
  petZoomVal.textContent = Math.round(Number(petZoomInput.value) * 100) + "%";
});
bindPetControl(petZoomInput, () => window.settings?.setPetZoom(Number(petZoomInput.value)));

function bindSpacingSlider(key: "chatLineHeight" | "chatParaSpacing", input: HTMLInputElement, label: HTMLElement, css: string, unit: string): void {
  input.addEventListener("input", () => {
    const spacing = Number(input.value);
    label.textContent = spacing.toFixed(2) + unit;
    document.documentElement.style.setProperty(css, String(spacing) + unit);
    setAppearanceSaveStatus(t("settings.status.releaseApply"));
  });
  input.addEventListener("change", () => {
    void saveAppearancePatch({ [key]: Number(input.value) });
  });
}
bindSpacingSlider("chatLineHeight", chatLineHeightInput, chatLineHeightVal, "--rb-chat-line-height", "");
bindSpacingSlider("chatParaSpacing", chatParaSpacingInput, chatParaSpacingVal, "--rb-chat-para-spacing", "em");

onChoice(proactiveChatSelect, ".option-block", option => {
  applyProactiveChatSelection(normalizeProactiveChatMode(option.dataset.value));
  renderProactiveDeliveryVisibility();
  dirtyPreferences();
});
onChoice(proactiveDeliverySelect, ".option-block", option => {
  if (option.disabled) return;
  applyProactiveDeliverySelection(normalizeProactiveDeliveryTarget(option.dataset.value));
  dirtyPreferences();
});

// ── 模型厂商 Work 流程适配说明 ──────────────────────────────
// 展示各厂商结构化输出档位与实测兼容性；「详细文档」在 app 内本地渲染完整实测报告。
// 模型厂商 Work 流程适配（手写 HTML，避免引入 markdown 渲染依赖）
const WORK_FLOW_COMPAT_MD = `
<h2>模型兼容性</h2>
<blockquote>流萤会根据不同厂商自动选择对应的 Structured Output Profile。</blockquote>
<table>
  <thead>
    <tr><th>厂商</th><th>支持状态</th><th>档位</th><th>已实测模型</th><th>说明</th></tr>
  </thead>
  <tbody>
    <tr><td>OpenAI</td><td>⚠️ 文档适配</td><td>A</td><td>-</td><td>已完成官方协议适配，等待实测。</td></tr>
    <tr><td>Claude</td><td>⚠️ 文档适配</td><td>A</td><td>-</td><td>已完成官方协议适配，等待实测。</td></tr>
    <tr><td>Kimi</td><td>✅ 已实测</td><td>A</td><td>K2.6、K2.7 Code</td><td>推荐普通 API，Coding 端点不建议用于 Work。</td></tr>
    <tr><td>DeepSeek</td><td>✅ 已实测</td><td>B</td><td>V4.1 Flash、V4 Pro</td><td>推荐，速度快、稳定。</td></tr>
    <tr><td>Qwen</td><td>✅ 已实测</td><td>B</td><td>Qwen3.7 Max</td><td>推荐，表现稳定。</td></tr>
    <tr><td>GLM</td><td>✅ 已实测</td><td>B</td><td>GLM 5.1、5.2</td><td>推荐，4.7 不建议。</td></tr>
    <tr><td>MiMo</td><td>✅ 已实测</td><td>B</td><td>MiMo 2.5、2.5 Pro</td><td>推荐，表现稳定。</td></tr>
    <tr><td>MiniMax</td><td>✅ 已实测</td><td>M</td><td>MiniMax M3</td><td>推荐，需使用 M 档适配。</td></tr>
    <tr><td>OpenRouter</td><td>⚠️ 文档适配</td><td>D</td><td>-</td><td>聚合网关，型号由所选模型决定，未实测；请自行验证。</td></tr>
    <tr><td>其他模型</td><td>⚠️ 文档适配</td><td>D</td><td>-</td><td>使用通用兼容模式，请自行验证。</td></tr>
  </tbody>
</table>
<h3>档位说明</h3>
<ul>
  <li><strong>A</strong>：原生 JSON Schema / Function Calling</li>
  <li><strong>B</strong>：JSON Object + 本地校验</li>
  <li><strong>M</strong>：MiniMax 专用适配</li>
  <li><strong>D</strong>：通用兼容模式（未知模型 / 自定义端点）</li>
</ul>
`.trim();

function buildWorkFlowAdaptBody(): string {
  return [
    '<div class="custom-endpoint-guide-warning work-flow-adapt-meta">',
    "  <strong>模型厂商 Work 流程适配</strong>",
    '  <span class="work-flow-adapt-date">最新更新于 2026/7/24</span>',
    "</div>",
    `<div class="work-flow-adapt-table">${WORK_FLOW_COMPAT_MD}</div>`,
  ].join("\n");
}

workFlowAdaptBtn?.addEventListener("click", () => {
  void showHtmlModal({
    title: t("settings.workFlow.adaptTitle"),
    icon: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"/><path d="M12 10.5V17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="7.25" r="1.1" fill="currentColor"/></svg>',
    htmlBody: buildWorkFlowAdaptBody(),
  });
});

async function testActiveConnection(button: HTMLButtonElement): Promise<void> {
  const provider = apiState.activeProvider;
  const baseUrl = baseUrlInput.value;
  const model = getCurrentModelValue().trim();
  const invalid = validateActiveCustomEndpoint();
  if (invalid) {
    setSaveStatus(invalid, "is-error");
    return;
  }
  const apiKey = getApiKeyForRequest();
  if (!baseUrl || !model) {
    setSaveStatus(t(!baseUrl ? "settings.api.needUrlBeforeTest" : "settings.api.needModelBeforeTest"), "is-error");
    return;
  }
  if (!await saveTimeoutSettings(true)) return;
  setSaveStatus(t("settings.api.testing"));
  button.disabled = true;
  const failed = (error: string): void => setSaveStatus(t("settings.api.testFailed", { error }), "is-error");
  try {
    const response = await window.settings!.testConnection!({
      provider, baseUrl, model, apiKey,
      explicitTransport: transportSelect.value as ProviderProfile["explicitTransport"],
      reasoning: apiState.editingReasoning,
    });
    if (!response.ok) {
      failed(response.error ?? t("settings.api.unknownError"));
    } else {
      setSaveStatus(t("settings.api.testOk", { latency: response.latency, sample: response.sample ?? "" }), "is-ok");
    }
  } catch (failure) {
    failed(failure instanceof Error ? failure.message : String(failure));
  } finally {
    button.disabled = false;
  }
}
if (testConnectionBtn) {
  const trigger = testConnectionBtn;
  trigger.addEventListener("click", () => void testActiveConnection(trigger));
}

bindReasoningLevels();

// ── 从厂商获取模型列表：型号由接入的厂商决定，预设只是拉不到时的兜底建议 ──
const modelPicker = fetchModelsPicker && fetchModelsSearch && fetchModelsList && fetchModelsEmpty
  ? createModelPicker({ root: fetchModelsPicker, search: fetchModelsSearch, list: fetchModelsList, empty: fetchModelsEmpty }, (id) => {
    modelInput.value = id;
    modelInput.dispatchEvent(new Event("input", { bubbles: true }));
    inputModalities.picked(id, fetchedInputModalities.get(id));
  })
  : undefined;
closeFetchedModelPicker = () => modelPicker?.close();
modelInput.addEventListener("input", () => {
  const typed = modelInput.value.trim();
  modelPicker?.syncCurrent(typed);
  inputModalities.modelChanged();
  // 原生 datalist 选中（或手填成了列表里的 id）不会经过自定义选择器；
  // 只要这个 id 是刚拉取到的厂商模型，就按厂商返回的模态记录，避免图片能力被静默丢掉。
  if (fetchedInputModalities.has(typed)) inputModalities.picked(typed, fetchedInputModalities.get(typed));
});
function fetchModelsErrorText(error: string): string {
  const status = /^HTTP_(\d+)$/.exec(error)?.[1];
  if (status === "401" || status === "403") return t("settings.panel.api.field.model.fetch.unauthorized", { status });
  if (status === "404") return t("settings.panel.api.field.model.fetch.notFound");
  if (status) return t("settings.panel.api.field.model.fetch.http", { status });
  if (error === "MISSING_API_KEY" || error === "MISSING_BASE_URL") return t("settings.panel.api.field.model.fetch.needKey");
  if (error === "TIMEOUT") return t("settings.panel.api.field.model.fetch.timeout");
  if (error === "BAD_RESPONSE") return t("settings.panel.api.field.model.fetch.empty");
  return t("settings.panel.api.field.model.fetch.network");
}
fetchModelsBtn?.addEventListener("click", async () => {
  if (!fetchModelsBtn || !fetchModelsStatus) return;
  const show = (text: string, tone: "" | "is-error" | "is-ok" = "") => {
    fetchModelsStatus.textContent = text;
    fetchModelsStatus.classList.remove("is-error", "is-ok");
    if (tone) fetchModelsStatus.classList.add(tone);
  };
  show(t("settings.panel.api.field.model.fetch.loading"));
  modelPicker?.close();
  fetchModelsBtn.disabled = true;
  const generation = fetchModelsGeneration;
  try {
    const result = await settings.fetchModels?.({
      provider: apiState.activeProvider,
      baseUrl: baseUrlInput.value.trim(),
      apiKey: getApiKeyForRequest(),
      explicitTransport: transportSelect.value as ApiTransport,
    });
    // 等待期间切到了别的档案：结果属于上一个档案，丢掉，不要写进现在这个档案的候选里
    if (generation !== fetchModelsGeneration) return;
    if (!result) { show(fetchModelsErrorText("NETWORK"), "is-error"); return; }
    if (!result.ok) { show(fetchModelsErrorText(result.error), "is-error"); return; }
    fetchedInputModalities.clear();
    for (const model of result.models) fetchedInputModalities.set(model.id, model.inputModalities);
    fillModelSuggestions(result.models);

    modelPicker?.open(result.models, modelInput.value.trim());
    show(t("settings.panel.api.field.model.fetch.done", { count: result.models.length }), "is-ok");
  } catch {
    if (generation === fetchModelsGeneration) show(fetchModelsErrorText("NETWORK"), "is-error");
  } finally {
    fetchModelsBtn.disabled = false;
  }
});

baseUrlResetBtn.addEventListener("click", () => {
  const chosen = findPreset(apiState.activeProvider);
  if (!chosen) return;
  baseUrlInput.value = transportSelect.value === "anthropic" && chosen.anthropicBaseUrl ? chosen.anthropicBaseUrl : chosen.baseUrl;
  updateEndpointPreview();
  setSaveStatus(t("settings.api.baseUrlResetOk"));
  updateProfileDraftState();
});

function changeTransport(): void {
  const chosen = findPreset(apiState.activeProvider);
  const stripSlash = (url: string): string => url.replace(/\/$/, "");
  const address = stripSlash(baseUrlInput.value.trim());
  const known = [chosen.baseUrl, chosen.anthropicBaseUrl].filter((url): url is string => Boolean(url)).map(stripSlash);
  const protocol = transportSelect.value;
  if (known.includes(address)) {
    if (protocol === "anthropic" && chosen.anthropicBaseUrl) baseUrlInput.value = chosen.anthropicBaseUrl;
    else if (protocol === "openai" || protocol === "responses") baseUrlInput.value = chosen.baseUrl;
  }
  updateEndpointPreview();
  if (protocol === "anthropic" && !chosen.anthropicBaseUrl && chosen.transport !== "anthropic") {
    transportHint.textContent = t("settings.api.anthropicHintMissing");
  }
  setSaveStatus(t("settings.status.dirty"));
  updateProfileDraftState();
}
baseUrlInput.addEventListener("input", updateEndpointPreview);
transportSelect.addEventListener("change", changeTransport);

apiRuntimeForm.addEventListener("submit", async event => {
  event.preventDefault();
  const report = setRuntimeSaveStatus;
  report(t("settings.status.saving"));
  try {
    const saved = await saveTimeoutSettings(false);
    if (saved) report(t("settings.status.saved"), "is-ok");
  } catch {
    report(t("settings.status.saveFailed"), "is-error");
  }
});
appearanceForm.addEventListener("submit", event => event.preventDefault());

// 通用设置只有语言一项：选择即保存（main 端 saveGeneralSettings 与既有配置合并，单项保存不会覆盖其他字段）。
languageSelect.querySelectorAll<HTMLButtonElement>(".language-option").forEach((button) => {
  button.addEventListener("click", async () => {
    const previous = normalizeUiLanguage(languageSelect.querySelector<HTMLButtonElement>(".language-option.is-active")?.dataset.lang);
    const language = normalizeUiLanguage(button.dataset.lang);
    applyLanguageSelection(language);
    try {
      await window.settings!.saveGeneral({ language });
    } catch {
      applyLanguageSelection(previous);
    }
  });
});

// 桌面与系统：两个开关同样选择即保存；失败时回滚开关并显示提示。
function setDesktopSaveStatus(text: string, cls = ""): void {
  desktopSaveStatus.textContent = text;
  desktopSaveStatus.className = `save-status ${cls}`.trim();
  desktopSaveStatus.hidden = !text;
}

function bindDesktopSwitch(input: HTMLInputElement, save: (checked: boolean) => Promise<unknown>): void {
  input.addEventListener("change", async () => {
    const next = input.checked;
    try {
      await save(next);
      setDesktopSaveStatus("");
    } catch {
      input.checked = !next;
      setDesktopSaveStatus(t("settings.panel.general.desktopSaveFailed"), "is-error");
    }
  });
}

bindDesktopSwitch(toastSoundEnabledInput, checked => window.settings!.saveGeneral({ toastSoundEnabled: checked }));
bindDesktopSwitch(launchAtLoginInput, checked => window.settings!.saveGeneral({ launchAtLogin: checked }));

// 版本号：设置页底部与“关于”卡片共用 appUpdate 状态里的 currentVersion。
void window.appUpdate?.getState().then((state) => {
  document.querySelectorAll<HTMLElement>("[data-app-version]").forEach((el) => {
    el.textContent = state.currentVersion;
  });
}).catch(() => {});

function bindSettingsSubmit(form: HTMLFormElement, report: (text: string, cls?: string) => void, save: () => Promise<unknown>): void {
  form.addEventListener("submit", async event => {
    event.preventDefault();
    report(t("settings.status.saving"));
    try {
      await save();
      report(t("settings.status.saved"), "is-ok");
    } catch {
      report(t("settings.status.saveFailed"), "is-error");
    }
  });
}

function embeddingDimensions(): number | undefined {
  const entered = embeddingDimensionsInput?.value?.trim();
  const number = entered ? Number(entered) : NaN;
  if (!Number.isFinite(number) || number <= 0) return undefined;
  return Math.max(1, Math.min(65536, Math.round(number)));
}
bindSettingsSubmit(fireflyPanel, setFireflySaveStatus, () => {
  const dimensions = embeddingDimensions();
  return window.settings!.saveConfig({
    stickerEnabled: stickerEnabledInput.checked,
    stickerSize: getStickerSizeValue(),
    stickerSimilarityThreshold: parseFloat(stickerThresholdInput.value),
    embeddingDimensions: dimensions,
  });
});

apiForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!isCurrentProfilePanel() || profileSavePending || profileTransitionPending || !apiState.editorOpen) return;
  const settings = window.settings!;
  const customValidationError = validateActiveCustomEndpoint();
  if (customValidationError) {
    setSaveStatus(customValidationError, "is-error");
    return;
  }
  profileSavePending = true;
  updateProfileDraftState();
  const submittedDraft = profileDraftSnapshot();
  const submittedGlobalOptions = {
    thinkingOverride: toggleEnableThinking.checked ? 1 as const : toggleDisableThinking.checked ? -1 as const : 0 as const,
    disableMaxToken: toggleDisableMaxToken.checked,
  };
  setSaveStatus(t("settings.status.saving"));
  try {
    // 档案保存：editingProfileId 存在 = 更新（字段全量覆盖），否则新增。
    // 上下文窗口跟随档案；留空/非法 = 不写入，回退默认 1M；超出范围夹到 4096–1M。
    const isEditing = Boolean(apiState.editingProfileId);
    const profile = {
      id: apiState.editingProfileId,
      provider: apiState.activeProvider,
      displayName: displayNameInput.value.trim() || findPreset(apiState.activeProvider).shortName,
      baseUrl: baseUrlInput.value.trim(),
      model: getCurrentModelValue().trim(),
      apiKey: getApiKeyForRequest(),
      explicitTransport: transportSelect.value as ApiTransport,
      reasoning: apiState.editingReasoning,
      // 没声明（自动）= undefined：保存时清掉旧声明，回到按型号名判断。
      reasoningLevels: readReasoningLevels(),
      // 输入类型：未声明（自动）= undefined，保存时清掉旧声明；厂商记录只在它对应的型号上带出（见 input-modalities.ts）
      inputModalities: inputModalities.declared()?.modalities,
      inputModalitiesSource: inputModalities.declared()?.source,
      contextWindowTokens: parseContextWindowTokens(contextWindowInput.value),
    };
    if (!await saveTimeoutSettings(true) || !isCurrentProfilePanel()) return;
    setSaveStatus(t("settings.status.saving"));
    const result = await settings.saveModelProfile?.(profile);
    if (!isCurrentProfilePanel()) return;
    if (!result) throw new Error(t("settings.profile.listUnavailable"));
    // Retain a successful profile write even if the subsequent global save fails.
    // A retry must update that profile, rather than create a duplicate draft.
    if (!isEditing && result.added) {
      // 新建成功后切到编辑态，用户可直接再改再存
      const saved = (result.profiles as SavedProfileLite[]).at(-1);
      if (saved && saved.id) {
        apiState.editingProfileId = saved.id;
        apiState.editingReasoning = saved.reasoning;
        apiState.profiles = result.profiles as SavedProfileLite[];
        apiState.defaultProfileId = result.defaultModelProfileId;
        applyEditingStateUI();
        renderProfileList();
      }
    }
    // 全局选项（思考开关/maxToken）不随档案走，单独保存
    await settings.saveConfig(submittedGlobalOptions);
    if (!isCurrentProfilePanel()) return;
    await reloadProfiles();
    if (!isCurrentProfilePanel()) return;
    if (isEditing || result.added) {
      // Follow the refreshed Main values only when no newer profile edit exists.
      // The key remains the submitted input; catalog credentials are never copied here.
      if (profileDraftSnapshot() === submittedDraft) {
        const saved = apiState.profiles.find(profile => profile.id === apiState.editingProfileId);
        if (saved) {
          applyPreset(saved.provider, saved.model, apiKeyInput.value, saved.baseUrl, saved.displayName,
            saved.explicitTransport);
          contextWindowInput.value = saved.contextWindowTokens ? String(saved.contextWindowTokens) : "";
          writeReasoningLevels(saved.reasoningLevels);
          inputModalities.load(declarationOf(saved), saved.model);
          apiState.editingReasoning = saved.reasoning;
        }
        profileDraftBaseline = profileDraftSnapshot();
      } else {
        profileDraftBaseline = submittedDraft;
      }
      if (hasUnsavedProfileDraft()) {
        setSaveStatus(t("settings.providerUi.savedWithChanges"));
      } else {
        setSaveStatus(t(isEditing ? "settings.profile.savedUpdated" : "settings.profile.savedAdded"), "is-ok");
      }
    } else {
      setSaveStatus(t("settings.profile.duplicate"), "is-error");
    }
  } catch {
    if (isCurrentProfilePanel()) setSaveStatus(t("settings.status.saveFailed"), "is-error");
  } finally {
    profileSavePending = false;
    if (isCurrentProfilePanel()) updateProfileDraftState();
  }
});

const navigationButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".nav-item"));
const panelSections = Array.from(document.querySelectorAll<HTMLElement>("[data-panel]"), panel => panel.dataset.panel!);

/** Reads the usage history each time the page is opened, so it never shows stale numbers. */
async function loadUsage(): Promise<void> {
  const host = document.getElementById("usage-history-panel");
  if (!host) return;
  const { loadUsagePanel } = await import("./usage/panel");
  await loadUsagePanel(host, (window as typeof window & { tokenUsage?: import("./usage/panel").UsageBridge }).tokenUsage ?? {});
}

/** Reads the 12 sub-agents and their model choice each time the page is opened, so it never shows a stale selection. */
async function loadSubagents(): Promise<void> {
  const host = document.getElementById("agent-routing-panel");
  if (!host || !window.settings) return;
  const { loadAgentRoutingPanel } = await import("./api/agent-routing");
  await loadAgentRoutingPanel(host, window.settings);
}

function switchSection(requestedSection: string): void {
  const section = resolveSettingsSection(requestedSection, navigationButtons, panelSections);
  const copy = NAV_LABELS[section] ?? NAV_LABELS.api;
  sectionTitle.textContent = copy.title;
  sectionHint.textContent = copy.hint;

  const show = (key: string, panel: HTMLElement): void => {
    panel.classList.toggle("is-hidden", section !== key);
  };
  const showId = (key: string, id: string): void => {
    const panel = document.getElementById(id);
    if (panel) show(key, panel);
  };
  showId("asr", "desktop-asr-form");
  const forms: [string, HTMLElement][] = [
    ["api", apiForm], ["api-advanced", apiRuntimeForm], ["appearance", appearanceForm],
    ["general", generalForm], ["preferences", preferencesForm], ["firefly", fireflyPanel],
    ["disclaimer", disclaimerPanel],
  ];
  forms.forEach(([key, form]) => show(key, form));
  showId("memory", "memory-panel");
  if (section === "memory") void refreshShadowPanel();
  showId("user", "user-panel");
  showId("tasks", "tasks-panel");
  if (section === "tasks") void loadSchedulerPanel();
  show("plugins", pluginsPanel);
  showId("mcp", "mcp-panel");
  showId("channels", "channels-panel");
  if (section === "channels") void loadChannelsPanel();
  showId("music", "music-panel");
  if (section === "music") void loadMusicPanel();
  else disposeMusicPanel();
  showId("subagents", "subagents-panel");
  if (section === "subagents") void loadSubagents();
  showId("usage", "usage-panel");
  if (section === "usage") void loadUsage();

  const hasPanel = forms.some(([key]) => key === section) || [
    "asr", "memory", "user", "tasks", "plugins", "mcp", "channels", "music", "subagents", "usage",
  ].includes(section);
  placeholderPanel.classList.toggle("is-hidden", hasPanel);
  if (!hasPanel) {
    placeholderIcon.innerHTML = copy.emoji;
    placeholderTitle.textContent = copy.title;
    placeholderCopy.textContent = t("settings.placeholder.copy");
  }
  updateSettingsNavigation(navigationButtons, section === "music" ? "plugins" : section);
  document.querySelector(".settings-content")?.scrollTo?.({ top: 0 });
}

bindSettingsNavigation(navigationButtons, switchSection);

{
  const nav = document.querySelector<HTMLElement>(".settings-nav");
  const input = document.getElementById("settings-search") as HTMLInputElement | null;
  const results = document.getElementById("settings-search-results");
  const status = document.getElementById("settings-search-status");
  if (nav && input && results && status) {
    const search = mountSettingsSearch({ root: document, nav, input, results, status, buttons: navigationButtons, select: switchSection });
    // Results are built from translated text, so rebuild them when the language changes.
    subscribeLocaleChanged(() => { if (input.value) search.refresh(); });
  }
}

const schedulerClicks: [HTMLButtonElement | null, () => void][] = [
  [schedulerNewBtn, () => void openSchedulerEditor()],
  [schedulerEditorClose, closeSchedulerEditor],
  [schedulerCancelBtn, closeSchedulerEditor],
  [schedulerSaveBtn, () => void saveSchedulerTask()],
];
schedulerClicks.forEach(([button, act]) => button?.addEventListener("click", act));
[schedulerKindInput, schedulerToolLimitInput].forEach(input => input?.addEventListener("change", updateSchedulerConditionalFields));
updateSchedulerConditionalFields();

// 启动请求按原来的顺序发出，面板切换仍可独立刷新。
void loadConfig();
void loadGeneralSettings();
void bindDesktopAsrSettings(document, window.settings);
void mountPluginPanels();
window.settings?.onChannelsStatusChanged(status => renderProactiveDeliveryAvailability(status as Record<string, { phase?: string }>));
void loadChannelsPanel();
/** "memory-graph" (from the chat's memory card) opens 流萤记忆 in its graph view. */
function openSection(requested: string): void {
  if (requested !== "memory-graph") { switchSection(requested); return; }
  switchSection("memory"); showMemoryView("graph");
}
openSection((window.location.hash || "#general").slice(1));
window.settings?.onSwitchSection?.(section => openSection(section));

async function removeImportedDocument(event: Event): Promise<void> {
  const origin = event.target as HTMLElement | null;
  const trigger = origin?.closest<HTMLElement>(".memory-record__delete");
  if (!trigger) return;
  const importId = trigger.dataset.importId || "";
  const fileName = trigger.dataset.fileName || t("settings.importDoc.unnamed");
  const approved = await showConfirm({
    title: t("settings.importDoc.deleteTitle"),
    message: t("settings.importDoc.deleteMessage", { fileName }),
    confirmText: t("settings.importDoc.deleteConfirm"),
    cancelText: t("settings.modal.cancel"),
    dangerous: true,
  });
  if (!approved) return;
  try {
    const response = await window.memoryPanel?.deleteImportedDoc(importId, fileName);
    if (response?.ok) await loadMemoryPanel();
  } catch (failure) {
    console.error("[settings] delete imported doc failed", failure);
  }
}
memoryImportedList?.addEventListener("click", event => void removeImportedDocument(event));

void loadMemoryPanel();

// ── 音乐工具路由 ──────────────────────────────────────────────
document.getElementById("music-platform-qq")?.addEventListener("click", () => {
  switchSection("music");
});

// ── 厂商与 API 协议用下拉框选（DSH 的做法）；卡片留在页面里继续承担状态和监听，下拉框只是它们的前台。
if (presetCards) attachCardSelect(presetCards, ".preset-card", {
  label: t("settings.providerUi.providerLabel"),
  placeholder: t("settings.providerUi.providerPlaceholder"),
  valueOf: card => card.dataset.provider,
  textOf: card => card.querySelector(".preset-card__name")?.textContent ?? card.dataset.provider ?? "",
  isSelected: card => card.classList.contains("is-active"),
  iconOf: card => card.querySelector(".preset-card__logo")?.firstElementChild ?? card.querySelector(".preset-card__logo"),
});
const transportCards = document.getElementById("transport-select");
if (transportCards) attachCardSelect(transportCards, ".preset-card", {
  label: t("panel.api.field.transport.groupLabel"),
  valueOf: card => card.dataset.value,
  textOf: card => card.querySelector(".preset-card__name")?.textContent ?? card.dataset.value ?? "",
  isSelected: card => card.getAttribute("aria-pressed") === "true",
  iconOf: card => card.querySelector(".preset-card__logo")?.firstElementChild ?? card.querySelector(".preset-card__logo"),
});

// Every native <select> in the window gets the shared dropdown, and the birthday a calendar (the native ones stutter).
if (userBirthdayInput) attachDatePicker(userBirthdayInput);
enhanceSelects(document.body);
trackRangeFills(document.body);

function chooseProvider(event: Event): void {
  const choice = (event.target as HTMLElement).closest<HTMLElement>(".preset-card");
  if (!choice || choice.classList.contains("is-disabled")) return;
  const storedName = choice.dataset.provider;
  if (!storedName) return;
  const provider = getCustomEndpointMode(storedName) ? getCustomEndpointProvider(apiState.customEndpointMode) : storedName;
  if (apiState.editorOpen && !apiState.editingProfileId && provider === apiState.activeProvider) return;
  changeProfileEditor(() => {
    startNewDraft(provider);
    setSaveStatus(t("settings.preset.appliedDraftHint"));
  });
}
presetCards?.addEventListener("click", chooseProvider);

function chooseEndpointMode(event: Event): void {
  const choice = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-custom-endpoint-mode]");
  const mode = choice?.dataset.customEndpointMode as CustomEndpointMode | undefined;
  if (!mode || mode === apiState.customEndpointMode) return;
  changeProfileEditor(() => {
    apiState.customEndpointMode = mode;
    startNewDraft(getCustomEndpointProvider(mode));
    setSaveStatus(t(mode === "local" ? "settings.customEndpoint.localDraftHint" : "settings.customEndpoint.cloudDraftHint"));
  });
}
customEndpointControls?.addEventListener("click", chooseEndpointMode);

// ── 档案列表：点击档案载入编辑 ────────────────────────────────
profileList?.addEventListener("click", (e) => {
  const button = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-profile-action]");
  const row = button?.closest<HTMLElement>(".provider-row");
  const profile = apiState.profiles.find(p => p.id === row?.dataset.profileId);
  if (!profile) return;
  if (button?.dataset.profileAction === "delete") {
    requestDeleteProfile(profile.id);
  } else if (apiState.editorOpen && apiState.editingProfileId === profile.id) {
    // 再点已展开的卡片 = 折叠（草稿有改动时先确认）。
    profileEditorReturnProfileId = profile.id;
    closeProfileEditor();
  } else {
    changeProfileEditor(() => {
      profileEditorReturnProfileId = profile.id;
      editProfile(profile);
    });
  }
});

// ── 删除当前编辑的档案 ────────────────────────────────────────
async function deleteProfile(profileId: string): Promise<void> {
  const rowIndex = apiState.profiles.findIndex(profile => profile.id === profileId);
  const profile = apiState.profiles.find((p) => p.id === profileId);
  const name = profile?.displayName || profile?.model || t("settings.profile.fallbackName");
  try {
    await window.settings?.deleteModelProfile?.(profileId);
    setSaveStatus(t("settings.profile.deleted", { name }), "is-ok");
    await reloadProfiles();
    // 仅删除当前编辑项时收起编辑器（不再自动展开别的卡片），其余草稿保留。
    if (apiState.editingProfileId === profileId) {
      apiState.editingProfileId = undefined;
      apiState.editingReasoning = undefined;
      apiState.editorOpen = false;
      applyEditingStateUI();
    }
    const editButtons = Array.from(profileList.querySelectorAll<HTMLButtonElement>('[data-profile-action="edit"]'));
    (editButtons[Math.min(Math.max(rowIndex, 0), editButtons.length - 1)] ?? document.getElementById("add-profile-btn"))?.focus();
  } catch {
    setSaveStatus(t("settings.profile.deleteFailed"), "is-error");
  }
}

function requestDeleteProfile(profileId: string): void {
  if (profileSavePending || profileTransitionPending) return;
  if (apiState.editingProfileId === profileId) changeProfileEditor(() => void deleteProfile(profileId));
  else void deleteProfile(profileId);
}

deleteProfileBtn?.addEventListener("click", () => {
  if (apiState.editingProfileId) requestDeleteProfile(apiState.editingProfileId);
});

function addProfile(): void {
  if (apiState.editorOpen && !apiState.editingProfileId) {
    apiKeyInput.focus();
    return;
  }
  changeProfileEditor(() => {
    startNewDraft(MODEL_PRESETS.find(preset => !preset.disabled && !preset.customEndpointMode)!.providerName);
    apiKeyInput.focus();
  });
}
document.getElementById("add-profile-btn")?.addEventListener("click", addProfile);
/** 折叠编辑器（“取消”按钮与再点已展开的卡片共用）；焦点回到打开它的卡片。 */
function closeProfileEditor(): void {
  changeProfileEditor(() => {
    const originId = profileEditorReturnProfileId ?? apiState.editingProfileId;
    apiState.editorOpen = false;
    applyEditingStateUI();
    renderProfileList();
    const origin = Array.from(profileList.querySelectorAll<HTMLButtonElement>('[data-profile-action="edit"]'))
      .find(button => button.closest<HTMLElement>('[data-profile-id]')?.dataset.profileId === originId);
    (origin ?? document.getElementById("add-profile-btn"))?.focus();
  });
}
document.getElementById("close-profile-editor")?.addEventListener("click", closeProfileEditor);
const providerTabs = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-provider-tab]"));
function selectProviderTab(button: HTMLButtonElement, focusTab = false): void {
  const custom = button.dataset.providerTab === "custom";
  if (custom === Boolean(getCustomEndpointMode(apiState.activeProvider))) {
    if (focusTab) button.focus();
    return;
  }
  changeProfileEditor(() => {
    startNewDraft(custom
      ? getCustomEndpointProvider(apiState.customEndpointMode)
      : MODEL_PRESETS.find(preset => !preset.disabled && !preset.customEndpointMode)!.providerName);
    if (focusTab) button.focus();
  });
}
providerTabs.forEach((button, index) => {
  button.addEventListener("click", () => selectProviderTab(button));
  button.addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? providerTabs[0]
      : event.key === "End" ? providerTabs.at(-1)!
      : providerTabs[(index + 1) % providerTabs.length];
    selectProviderTab(next, true);
  });
});

apiForm.addEventListener("input", () => {
  if (!profileSavePending) setSaveStatus(t("settings.status.dirty"));
  updateProfileDraftState();
});
apiForm.addEventListener("change", updateProfileDraftState);

function translateProviderUi(): void {
  document.querySelectorAll<HTMLElement>('[data-i18n^="settings.providerUi."]').forEach(element => {
    element.textContent = t(element.dataset.i18n!);
  });
  const tabList = document.querySelector<HTMLElement>(".provider-tabs");
  tabList?.setAttribute("aria-label", t("settings.providerUi.addTitle"));
}
translateProviderUi();
subscribeLocaleChanged(() => {
  translateProviderUi();
  renderProfileList();
  applyEditingStateUI();
  updateProfileDraftState();
});

chatSocialContextEnabledInput.addEventListener("change", dirtyPreferences);
segmentedChatEnabledInput.addEventListener("change", dirtyPreferences);

bindSettingsSubmit(preferencesForm, setPreferencesSaveStatus, () => window.settings!.saveGeneral({
  chatSocialContextEnabled: chatSocialContextEnabledInput.checked,
  segmentedChatEnabled: segmentedChatEnabledInput.checked,
  proactiveChatMode: getProactiveChatValue(),
  proactiveDeliveryTarget: getProactiveDeliveryValue(),
  screenshotHotkey: screenshotHotkeyInput?.value || "Alt+Shift+S",
}));
