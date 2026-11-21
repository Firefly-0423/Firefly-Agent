import { initEndpointView } from "./endpoint-view";
import type {} from "../../global";
import { renderProviderRows } from "./provider-rows";
import { applyProviderEditorLayout, mountProfileEditor, placeSaveStatus, renderKeepingProfileEditor } from "./provider-editor";
import { getCustomEndpointMode, getCustomEndpointProvider, type CustomEndpointMode } from "../custom-endpoint-state";
import { apiState, type SavedProfileLite } from "./state";
import { readReasoningLevels, writeReasoningLevels } from "./reasoning-levels";
import { declarationOf } from "./input-modalities";
import { apiForm, presetCards, profileList, profileListCount, profileEditorTitle, deleteProfileBtn, displayNameInput, baseUrlInput, modelInput, contextWindowInput, apiKeyInput, transportSelect, customEndpointControls } from "./dom";
import { MODEL_PRESETS } from "./presets";
import { showConfirm } from "../shared/modal";
import { setSaveStatus } from "../shared/save-status";
import { t } from "../i18n";
import type { InputModalitiesPanel } from "./input-modalities";
import type { initEndpointView } from "./endpoint-view";

export function initProfileDraftController(deps: { inputModalities: InputModalitiesPanel; applyPreset: ReturnType<typeof initEndpointView>["applyPreset"] }) {
const { inputModalities, applyPreset } = deps;
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


function bind(): void {
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


}
return { bind, isCurrentProfilePanel, updateProfileDraftState, profileDraftSnapshot, hasUnsavedProfileDraft, renderProfileList, reloadProfiles, applyEditingStateUI,
  isSavePending: () => profileSavePending, isTransitionPending: () => profileTransitionPending,
  setSavePending: (pending: boolean) => { profileSavePending = pending; }, setDraftBaseline: (snapshot: string) => { profileDraftBaseline = snapshot; } };
}
