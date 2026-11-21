import { initApiPanel } from "./api/panel";
import { bindDesktopAsrSettings } from "./desktop-asr-settings";
import type {} from "../global";
import { mountSettingsSearch } from "./shared/search";
import { mountPluginPanels } from "./plugin-panels";
import { hydrateAppearanceSettings, initAppearancePanel } from "./appearance/panel";
import { hydrateGeneralSettings, initGeneralPanel } from "./general/panel";
import { hydrateChatPreferences, initChatPreferencesPanel } from "./preferences/chat-panel";
import { hydrateFireflyConfig, initFireflyPanel } from "./preferences/firefly-panel";
import { minBtn, closeBtn } from "./shared/shell";
import { installPreviewBridge } from "./shared/preview-bridge";
import { createSectionRouter } from "./shared/section-router";
import { enhanceSelects } from "./shared/dropdown";
import { attachDatePicker } from "./shared/date-picker";
import { trackRangeFills } from "./shared/range-fill";
import { userBirthdayInput } from "./user/dom";
import { setSaveStatus, setFireflySaveStatus, setPreferencesSaveStatus, setAppearanceSaveStatus } from "./shared/save-status";
import { initMemoryPanel, loadMemoryPanel } from "./memory/panel";
import { initSchedulerPanel } from "./scheduler/panel";
import { initMusicShortcut } from "./music/panel";
import { loadChannelsPanel, renderProactiveDeliveryAvailability } from "./channels/panel";
import { t, subscribeLocaleChanged } from "./i18n";
import "../ui/base.css";
import "../ui/theme";
import "./email/panel";
import "./search/panel";
import "./user/panel";
import "./plugins/panel";
import "./plugins/permission";
import "./rag/panel";
import "./preferences/panel";
import "./mcp/panel";
const MIMO_ICON_URL = "https://raw.githubusercontent.com/lobehub/lobe-icons/refs/heads/master/packages/static-png/light/xiaomimimo.png";
installPreviewBridge();
minBtn.addEventListener("click", () => window.settings?.minimize());
closeBtn.addEventListener("click", () => window.settings?.close());
initGeneralPanel();
initAppearancePanel();
initChatPreferencesPanel();
initFireflyPanel();
const apiPanel = initApiPanel();

async function loadConfig(): Promise<void> {
  try {
    apiPanel.fillPresetOptions();
    const cfg = await window.settings!.getConfig();
    if (!apiPanel.isCurrentProfilePanel()) return;
    apiPanel.hydrateApiConfig(cfg);
    hydrateFireflyConfig(cfg);
    // 所有卡片默认折叠（默认档案只带“默认”标记），点“编辑”才展开；
    // 表单里的全局项（超时等）已由各自面板按已存配置填好。
    await apiPanel.reloadProfiles();
    if (!apiPanel.isCurrentProfilePanel()) return;
    apiPanel.applyEditingStateUI();
    setSaveStatus(t("settings.status.waiting"));
    setFireflySaveStatus(t("settings.status.waiting"));
  } catch {
    if (!apiPanel.isCurrentProfilePanel()) return;
    apiPanel.fillPresetOptions();
    apiPanel.markProfilesReadFailed();
    apiPanel.renderProfileList();
    setSaveStatus(t("settings.status.readFailed"), "is-error");
    setFireflySaveStatus(t("settings.status.readFailed"), "is-error");
  }
}

async function loadGeneralSettings(): Promise<void> {
  try {
    const cfg = await window.settings!.getGeneral();
    hydrateAppearanceSettings(cfg);
    hydrateChatPreferences(cfg);
    void window.settings!.channelsGetStatus()
      .then((status: unknown) => renderProactiveDeliveryAvailability(status as Record<string, { phase?: string }>))
      .catch(() => renderProactiveDeliveryAvailability({}));
    hydrateGeneralSettings(cfg);
    setPreferencesSaveStatus(t("settings.status.waiting"));
    setAppearanceSaveStatus(t("settings.status.waiting"));
  } catch {
    setPreferencesSaveStatus(t("settings.status.prefsReadFailed"), "is-error");
    setAppearanceSaveStatus(t("settings.status.appearanceReadFailed"), "is-error");
  }
}

const sectionRouter = createSectionRouter();
{
  const nav = document.querySelector<HTMLElement>(".settings-nav");
  const input = document.getElementById("settings-search") as HTMLInputElement | null;
  const results = document.getElementById("settings-search-results");
  const status = document.getElementById("settings-search-status");
  if (nav && input && results && status) {
    const search = mountSettingsSearch({ root: document, nav, input, results, status, buttons: Array.from(document.querySelectorAll<HTMLButtonElement>(".nav-item")), select: sectionRouter.switchSection });
    // Results are built from translated text, so rebuild them when the language changes.
    subscribeLocaleChanged(() => { if (input.value) search.refresh(); });
  }
}
initSchedulerPanel();
initMemoryPanel();
initMusicShortcut(() => sectionRouter.switchSection("music"));
// 启动请求按原来的顺序发出，面板切换仍可独立刷新。
void loadConfig();
void loadGeneralSettings();
void bindDesktopAsrSettings(document, window.settings);
void mountPluginPanels();
window.settings?.onChannelsStatusChanged(status => renderProactiveDeliveryAvailability(status as Record<string, { phase?: string }>));
void loadChannelsPanel();
sectionRouter.openInitialSection();
void loadMemoryPanel();
// Every native <select> in the window gets the shared dropdown, and the birthday a calendar (the native ones stutter).
if (userBirthdayInput) attachDatePicker(userBirthdayInput);
enhanceSelects(document.body);
trackRangeFills(document.body);
