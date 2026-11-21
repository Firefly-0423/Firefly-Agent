import { initProfileDraftController } from "./api/profile-draft";
import { initFetchModelsController } from "./api/fetch-models-controller";
import { initEndpointView } from "./api/endpoint-view";
import { bindDesktopAsrSettings } from "./desktop-asr-settings";
import type {} from "../global";
import { parseContextWindowTokens } from "../../shared/context-window";
import { mountSettingsSearch } from "./shared/search";
import { type ApiTransport } from "../../shared/api-endpoint";
import { mountPluginPanels } from "./plugin-panels";
import { apiState, type SavedProfileLite } from "./api/state";
import { bindReasoningLevels, readReasoningLevels, writeReasoningLevels } from "./api/reasoning-levels";
import { declarationOf } from "./api/input-modalities";
import { apiForm, apiRuntimeForm, presetCards, displayNameInput, baseUrlInput, contextWindowInput, apiKeyInput, testConnectionBtn, transportSelect, toggleEnableThinking, toggleDisableThinking, toggleDisableMaxToken } from "./api/dom";
import { hydrateAppearanceSettings, initAppearancePanel } from "./appearance/panel";
import { hydrateGeneralSettings, initGeneralPanel } from "./general/panel";
import { hydrateChatPreferences, initChatPreferencesPanel } from "./preferences/chat-panel";
import { hydrateFireflyConfig, initFireflyPanel } from "./preferences/firefly-panel";
import { minBtn, closeBtn } from "./shared/shell";
import type { ModelSettings, ProviderProfile } from "./shared/types";
import { installPreviewBridge } from "./shared/preview-bridge";
import { createSectionRouter } from "./shared/section-router";
import { attachCardSelect, enhanceSelects } from "./shared/dropdown";
import { attachDatePicker } from "./shared/date-picker";
import { trackRangeFills } from "./shared/range-fill";
import { userBirthdayInput } from "./user/dom";
import { setSaveStatus, setFireflySaveStatus, setPreferencesSaveStatus, setAppearanceSaveStatus, setRuntimeSaveStatus } from "./shared/save-status";
import { initMemoryPanel, loadMemoryPanel } from "./memory/panel";
import { initSchedulerPanel } from "./scheduler/panel";
import { initMusicShortcut } from "./music/panel";
import { loadChannelsPanel } from "./channels/panel";
import { renderProactiveDeliveryAvailability } from "./channels/panel";
import { saveTimeoutSettings } from "./timeout/panel";
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

const fetchModels = initFetchModelsController({ updateProfileDraftState: () => profiles.updateProfileDraftState(), getApiKeyForRequest: () => getApiKeyForRequest() });
const { inputModalities, fillModelOptions } = fetchModels;
const { fillPresetOptions, findPreset, applyPreset, getCurrentModelValue, getApiKeyForRequest, validateActiveCustomEndpoint } = initEndpointView({ fillModelOptions, updateProfileDraftState: () => profiles.updateProfileDraftState() });

const profiles = initProfileDraftController({ inputModalities, applyPreset });
const { isCurrentProfilePanel, updateProfileDraftState, profileDraftSnapshot, hasUnsavedProfileDraft, renderProfileList, reloadProfiles, applyEditingStateUI } = profiles;

function restoreModelSettings(config: ModelSettings): void {
  applyPreset(config.provider, config.model, config.apiKey, config.baseUrl, config.displayName, config.explicitTransport);
  hydrateFireflyConfig(config);
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

function bindExclusiveToggle(selected: HTMLInputElement, other: HTMLInputElement): void {
  selected.addEventListener("change", () => {
    if (selected.checked) other.checked = false;
  });
}
bindExclusiveToggle(toggleEnableThinking, toggleDisableThinking);
bindExclusiveToggle(toggleDisableThinking, toggleEnableThinking);

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

fetchModels.bind();

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

apiForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!isCurrentProfilePanel() || profiles.isSavePending() || profiles.isTransitionPending() || !apiState.editorOpen) return;
  const settings = window.settings!;
  const customValidationError = validateActiveCustomEndpoint();
  if (customValidationError) {
    setSaveStatus(customValidationError, "is-error");
    return;
  }
  profiles.setSavePending(true);
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
        profiles.setDraftBaseline(profileDraftSnapshot());
      } else {
        profiles.setDraftBaseline(submittedDraft);
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
    profiles.setSavePending(false);
    if (isCurrentProfilePanel()) updateProfileDraftState();
  }
});

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

profiles.bind();

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
