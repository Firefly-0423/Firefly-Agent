import { initFetchModelsController } from "./api/fetch-models-controller";
import { initEndpointView } from "./api/endpoint-view";
import { bindDesktopAsrSettings } from "./desktop-asr-settings";
import type {} from "../global";
import { parseContextWindowTokens } from "../../shared/context-window";
import { renderProviderRows } from "./api/provider-rows";
import { applyProviderEditorLayout, mountProfileEditor, placeSaveStatus, renderKeepingProfileEditor } from "./api/provider-editor";
import { mountSettingsSearch } from "./shared/search";
import { type ApiTransport } from "../../shared/api-endpoint";
import { getCustomEndpointMode, getCustomEndpointProvider, type CustomEndpointMode } from "./custom-endpoint-state";
import { mountPluginPanels } from "./plugin-panels";
import { apiState, type SavedProfileLite } from "./api/state";
import { bindReasoningLevels, readReasoningLevels, writeReasoningLevels } from "./api/reasoning-levels";
import { declarationOf } from "./api/input-modalities";
import { apiForm, apiRuntimeForm, presetCards, profileList, profileListCount, profileEditorTitle, deleteProfileBtn, displayNameInput, baseUrlInput, modelInput, contextWindowInput, apiKeyInput, testConnectionBtn, transportSelect, customEndpointControls, toggleEnableThinking, toggleDisableThinking, toggleDisableMaxToken } from "./api/dom";
import { hydrateAppearanceSettings, initAppearancePanel } from "./appearance/panel";
import { hydrateGeneralSettings, initGeneralPanel } from "./general/panel";
import { hydrateChatPreferences, initChatPreferencesPanel } from "./preferences/chat-panel";
import { hydrateFireflyConfig, initFireflyPanel } from "./preferences/firefly-panel";
import { minBtn, closeBtn } from "./shared/shell";
import type { ModelSettings, ProviderProfile } from "./shared/types";
import { installPreviewBridge } from "./shared/preview-bridge";
import { createSectionRouter } from "./shared/section-router";
import { MODEL_PRESETS } from "./api/presets";
import { attachCardSelect, enhanceSelects } from "./shared/dropdown";
import { attachDatePicker } from "./shared/date-picker";
import { trackRangeFills } from "./shared/range-fill";
import { userBirthdayInput } from "./user/dom";
import { showConfirm } from "./shared/modal";
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

const fetchModels = initFetchModelsController({ updateProfileDraftState, getApiKeyForRequest: () => getApiKeyForRequest() });
const { inputModalities, fillModelOptions } = fetchModels;
const { fillPresetOptions, findPreset, applyPreset, getCurrentModelValue, getApiKeyForRequest, validateActiveCustomEndpoint } = initEndpointView({ fillModelOptions, updateProfileDraftState });

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
