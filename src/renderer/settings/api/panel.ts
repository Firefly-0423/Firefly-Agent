import { initProfileDraftController } from "./profile-draft";
import { initFetchModelsController } from "./fetch-models-controller";
import { initEndpointView } from "./endpoint-view";
import type {} from "../../global";
import { parseContextWindowTokens } from "../../../shared/context-window";
import { type ApiTransport } from "../../../shared/api-endpoint";
import { apiState, type SavedProfileLite } from "./state";
import { bindReasoningLevels, readReasoningLevels, writeReasoningLevels } from "./reasoning-levels";
import { declarationOf } from "./input-modalities";
import { apiForm, apiRuntimeForm, presetCards, displayNameInput, baseUrlInput, contextWindowInput, apiKeyInput, testConnectionBtn, transportSelect, toggleEnableThinking, toggleDisableThinking, toggleDisableMaxToken } from "./dom";
import type { ModelSettings, ProviderProfile } from "../shared/types";
import { attachCardSelect } from "../shared/dropdown";
import { setSaveStatus, setRuntimeSaveStatus } from "../shared/save-status";
import { saveTimeoutSettings } from "../timeout/panel";
import { t, subscribeLocaleChanged } from "../i18n";

export function initApiPanel() {
  const fetchModels = initFetchModelsController({ updateProfileDraftState: () => profiles.updateProfileDraftState(), getApiKeyForRequest: () => getApiKeyForRequest() });
  const { inputModalities, fillModelOptions } = fetchModels;
  const { fillPresetOptions, findPreset, applyPreset, getCurrentModelValue, getApiKeyForRequest, validateActiveCustomEndpoint } = initEndpointView({ fillModelOptions, updateProfileDraftState: () => profiles.updateProfileDraftState() });

  const profiles = initProfileDraftController({ inputModalities, applyPreset });
  const { isCurrentProfilePanel, updateProfileDraftState, profileDraftSnapshot, hasUnsavedProfileDraft, renderProfileList, reloadProfiles, applyEditingStateUI } = profiles;

  function hydrateApiConfig(config: ModelSettings): void {
    applyPreset(config.provider, config.model, config.apiKey, config.baseUrl, config.displayName, config.explicitTransport);
    toggleEnableThinking.checked = config.thinkingOverride === 1;
    toggleDisableThinking.checked = config.thinkingOverride === -1;
    toggleDisableMaxToken.checked = !!config.disableMaxToken;
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

  return { hydrateApiConfig, fillPresetOptions, isCurrentProfilePanel, reloadProfiles, applyEditingStateUI, renderProfileList, markProfilesReadFailed: () => { apiState.profilesLoadState = "error"; } };
}
