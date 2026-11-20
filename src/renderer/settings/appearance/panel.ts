import type {} from "../../global";
import {
  CHAT_FONT_SIZE_MAX,
  CHAT_FONT_SIZE_MIN,
  CODE_FONT_SIZE_MAX,
  CODE_FONT_SIZE_MIN,
  DEFAULT_CHAT_APPEARANCE,
  UI_FONT_SIZE_MAX,
  UI_FONT_SIZE_MIN,
  clampFiniteNumber,
  normalizeChatAppearance,
  type ChatAppearanceSettings,
} from "../../../shared/chat-appearance";
import { normalizeUiFont, type UiFont } from "../../../shared/ui-font";
import { normalizeUiIcon, type UiIcon } from "../../../shared/ui-icon";
import { normalizeUiTheme, type UiTheme } from "../../../shared/ui-theme";
import { t } from "../i18n";
import { onChoice, selectButtons } from "../shared/option-group";
import { setAppearanceSaveStatus } from "../shared/save-status";
import type { GeneralSettings } from "../shared/types";
import { bindAppearanceAdvanced } from "./advanced";
import { bindUiColorControls } from "./colors";
import {
  appearanceForm,
  chatFontSizeInput,
  chatLineHeightInput,
  chatLineHeightVal,
  chatParaSpacingInput,
  chatParaSpacingVal,
  codeFontSizeInput,
  petAlwaysOnTopInput,
  petVisibleInput,
  petZoomInput,
  petZoomVal,
  uiFontCurrent,
  uiFontCustomOption,
  uiFontImportButton,
  uiFontResetButton,
  uiFontSelect,
  uiFontSizeInput,
  uiIconSelect,
  uiThemeSelect,
} from "./dom";

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
let uiColorControls: ReturnType<typeof bindUiColorControls> | undefined;
let appearanceAdvanced: ReturnType<typeof bindAppearanceAdvanced> | undefined;

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

function renderUiFont(font: UiFont): void {
  uiFontCurrent.textContent = font.kind === "custom" ? font.displayName : t("settings.appearance.font.defaultNotion");
  uiFontResetButton.hidden = font.kind !== "custom";
  uiFontCustomOption.disabled = font.kind !== "custom";
  uiFontSelect.value = font.kind === "custom" ? "custom" : "default";
}

function renderChatAppearanceControls(settings: ChatAppearanceSettings): void {
  savedChatAppearance = settings;
  appearanceAdvanced?.render(settings);
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

function bindPetControl(control: HTMLInputElement, apply: () => void): void {
  control.addEventListener("change", () => {
    apply();
    setAppearanceSaveStatus(t("settings.status.appliedOk"), "is-ok");
  });
}

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

/** 绑定外观面板的配色、排版、字体、主题/图标与桌宠控件。 */
export function initAppearancePanel(): void {
  uiColorControls = bindUiColorControls(appearanceForm, colors => window.settings!.saveGeneral({ uiColors: colors }));
  // The "高级" preferences save on their own; a reset also restores the sizes and spacing above, so redraw those too.
  appearanceAdvanced = bindAppearanceAdvanced(appearanceForm, async patch => {
    await saveAppearancePatch(patch as Partial<GeneralSettings>);
    if ("chatLineHeight" in patch) renderChatAppearanceControls({ ...savedChatAppearance, ...patch });
  });

  (["uiFontSize", "chatFontSize", "codeFontSize"] as PixelSizeKey[]).forEach(bindPixelSizeInput);
  uiFontSelect.addEventListener("change", () => {
    if (uiFontSelect.value === "default") uiFontResetButton.click();
  });

  bindPetControl(petAlwaysOnTopInput, () => window.settings?.setPetAlwaysOnTop(petAlwaysOnTopInput.checked));
  uiFontImportButton.addEventListener("click", () => void changeFont("import"));
  uiFontResetButton.addEventListener("click", () => void changeFont("reset"));

  onChoice(uiThemeSelect, ".appearance-theme-option", option => void chooseTheme(option));
  onChoice(uiIconSelect, ".appearance-icon-option", option => void chooseIcon(option));

  bindPetControl(petVisibleInput, () => window.settings?.setPetVisible(petVisibleInput.checked));
  petZoomInput.addEventListener("input", () => {
    petZoomVal.textContent = Math.round(Number(petZoomInput.value) * 100) + "%";
  });
  bindPetControl(petZoomInput, () => window.settings?.setPetZoom(Number(petZoomInput.value)));

  bindSpacingSlider("chatLineHeight", chatLineHeightInput, chatLineHeightVal, "--rb-chat-line-height", "");
  bindSpacingSlider("chatParaSpacing", chatParaSpacingInput, chatParaSpacingVal, "--rb-chat-para-spacing", "em");

  appearanceForm.addEventListener("submit", event => event.preventDefault());
}

/** 用单次 `getGeneral()` 结果回填外观与桌宠设置。 */
export function hydrateAppearanceSettings(config: GeneralSettings): void {
  uiColorControls?.load(config.uiColors);
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
