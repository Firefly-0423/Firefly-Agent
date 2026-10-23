import { saveStatus, fireflySaveStatus, preferencesSaveStatus, runtimeSaveStatus } from "./shell";
import { appearanceSaveStatus } from "../appearance/dom";
import { t } from "../i18n";

// 更新结果前清除上一轮状态类。
function paintStatus(target: HTMLElement, message: string, stateClass?: string): void {
  target.textContent = message;
  target.className = "save-status";
  if (stateClass) target.classList.add(stateClass);
}

export function setSaveStatus(text: string, cls?: string): void {
  paintStatus(saveStatus, text, cls);
  const waiting = !cls && text === t("settings.status.waiting");
  saveStatus.toggleAttribute("data-idle", waiting);
}

export function setFireflySaveStatus(text: string, cls?: string): void {
  paintStatus(fireflySaveStatus, text, cls);
}

export function setPreferencesSaveStatus(text: string, cls?: string): void {
  paintStatus(preferencesSaveStatus, text, cls);
}

export function setAppearanceSaveStatus(text: string, cls?: string): void {
  paintStatus(appearanceSaveStatus, text, cls);
}

export function setRuntimeSaveStatus(text: string, cls?: string): void {
  paintStatus(runtimeSaveStatus, text, cls);
}
