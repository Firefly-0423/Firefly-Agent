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

/** 绑定设置表单提交，统一在保存期间与成功/失败后更新状态提示。 */
export function bindSettingsSubmit(form: HTMLFormElement, report: (text: string, cls?: string) => void, save: () => Promise<unknown>): void {
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
