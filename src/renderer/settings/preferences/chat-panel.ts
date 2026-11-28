import type {} from "../../global";
import { normalizeChatSocialContextEnabled, normalizeProactiveChatMode, normalizeProactiveDeliveryTarget, normalizeSegmentedChatEnabled, type ProactiveChatMode, type ProactiveDeliveryTarget } from "../../../shared/preferences";
import { screenshotHotkeyInput } from "../appearance/dom";
import { chatSocialContextEnabledInput, proactiveChatSelect, proactiveDeliveryRow, proactiveDeliverySelect, segmentedChatEnabledInput } from "../general/dom";
import { t } from "../i18n";
import { applyOptionGroupValue, getOptionGroupValue, onChoice } from "../shared/option-group";
import { bindSettingsSubmit, setPreferencesSaveStatus } from "../shared/save-status";
import { preferencesForm } from "../shared/shell";
import type { GeneralSettings } from "../shared/types";

const applyProactiveChatSelection = (mode: ProactiveChatMode): void => applyOptionGroupValue(proactiveChatSelect, mode);
const applyProactiveDeliverySelection = (target: ProactiveDeliveryTarget): void => applyOptionGroupValue(proactiveDeliverySelect, target);
const getProactiveChatValue = (): ProactiveChatMode => normalizeProactiveChatMode(getOptionGroupValue(proactiveChatSelect, "off"));
const getProactiveDeliveryValue = (): ProactiveDeliveryTarget => normalizeProactiveDeliveryTarget(getOptionGroupValue(proactiveDeliverySelect, "local"));

function renderProactiveDeliveryVisibility(): void {
  const enabled = getProactiveChatValue() === "on";
  proactiveDeliveryRow.hidden = !enabled;
}

const dirtyPreferences = (): void => setPreferencesSaveStatus(t("settings.status.dirty"));

/** 绑定聊天偏好选项与表单提交监听。 */
export function initChatPreferencesPanel(): void {
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

  chatSocialContextEnabledInput.addEventListener("change", dirtyPreferences);
  segmentedChatEnabledInput.addEventListener("change", dirtyPreferences);

  bindSettingsSubmit(preferencesForm, setPreferencesSaveStatus, () => window.settings!.saveGeneral({
    chatSocialContextEnabled: chatSocialContextEnabledInput.checked,
    segmentedChatEnabled: segmentedChatEnabledInput.checked,
    proactiveChatMode: getProactiveChatValue(),
    proactiveDeliveryTarget: getProactiveDeliveryValue(),
    screenshotHotkey: screenshotHotkeyInput?.value || "Alt+Shift+S",
  }));
}

/** 用单次 `getGeneral()` 结果回填聊天偏好面板。 */
export function hydrateChatPreferences(config: GeneralSettings): void {
  chatSocialContextEnabledInput.checked = normalizeChatSocialContextEnabled(config.chatSocialContextEnabled);
  segmentedChatEnabledInput.checked = normalizeSegmentedChatEnabled(config.segmentedChatEnabled);
  applyProactiveChatSelection(normalizeProactiveChatMode(config.proactiveChatMode));
  applyProactiveDeliverySelection(normalizeProactiveDeliveryTarget(config.proactiveDeliveryTarget));
  renderProactiveDeliveryVisibility();
  if (screenshotHotkeyInput) screenshotHotkeyInput.value = config.screenshotHotkey ?? "Alt+Shift+S";
}
