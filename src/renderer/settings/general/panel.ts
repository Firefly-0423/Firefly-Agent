import type {} from "../../global";
import { t } from "../i18n";
import { selectButtons } from "../shared/option-group";
import type { GeneralSettings } from "../shared/types";
import { desktopSaveStatus, languageSelect, launchAtLoginInput, toastSoundEnabledInput } from "./dom";

type UiLanguage = "zh-CN" | "en";
const normalizeUiLanguage = (language: unknown): UiLanguage => language === "en" ? "en" : "zh-CN";
const applyLanguageSelection = (language: UiLanguage): void => {
  selectButtons(languageSelect, ".language-option", option => option.dataset.lang === language);
};

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

/** 绑定通用面板的语言选择、桌面开关并读取当前版本号。 */
export function initGeneralPanel(): void {
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

  bindDesktopSwitch(toastSoundEnabledInput, checked => window.settings!.saveGeneral({ toastSoundEnabled: checked }));
  bindDesktopSwitch(launchAtLoginInput, checked => window.settings!.saveGeneral({ launchAtLogin: checked }));

  // 版本号：设置页底部与“关于”卡片共用 appUpdate 状态里的 currentVersion。
  void window.appUpdate?.getState().then((state) => {
    document.querySelectorAll<HTMLElement>("[data-app-version]").forEach((el) => {
      el.textContent = state.currentVersion;
    });
  }).catch(() => {});
}

/** 用单次 `getGeneral()` 结果回填通用面板状态。 */
export function hydrateGeneralSettings(config: GeneralSettings): void {
  toastSoundEnabledInput.checked = config.toastSoundEnabled !== false;
  launchAtLoginInput.checked = config.launchAtLogin === true;
  applyLanguageSelection(normalizeUiLanguage(config.language));
}
