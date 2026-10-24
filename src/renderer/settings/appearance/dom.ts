// 元素在模块加载时绑定，空值约定由各面板决定。
function control<T extends HTMLElement | null>(id: string): T {
  return document.getElementById(id) as T;
}

export const appearanceForm = control<HTMLFormElement>("appearance-form");
export const appearanceSaveStatus = control<HTMLElement>("appearance-save-status");
export const petAlwaysOnTopInput = control<HTMLInputElement>("pet-always-on-top");
export const petVisibleInput = control<HTMLInputElement>("pet-visible");
export const petZoomInput = control<HTMLInputElement>("pet-zoom");
export const petZoomVal = control<HTMLElement>("pet-zoom-val");
export const chatLineHeightInput = control<HTMLInputElement>("chat-line-height");
export const chatLineHeightVal = control<HTMLElement>("chat-line-height-val");
export const chatParaSpacingInput = control<HTMLInputElement>("chat-para-spacing");
export const chatParaSpacingVal = control<HTMLElement>("chat-para-spacing-val");
export const uiFontCurrent = control<HTMLElement>("ui-font-current");
export const uiFontSelect = control<HTMLSelectElement>("ui-font-select");
export const uiFontCustomOption = control<HTMLOptionElement>("ui-font-custom-option");
export const uiFontImportButton = control<HTMLButtonElement>("ui-font-import");
export const uiFontResetButton = control<HTMLButtonElement>("ui-font-reset");
export const uiFontSizeInput = control<HTMLInputElement>("ui-font-size-input");
export const chatFontSizeInput = control<HTMLInputElement>("chat-font-size-input");
export const codeFontSizeInput = control<HTMLInputElement>("code-font-size-input");
export const uiIconSelect = control<HTMLElement>("ui-icon-select");
export const uiThemeSelect = control<HTMLElement>("ui-theme-select");
export const screenshotHotkeyInput = control<HTMLInputElement | null>("screenshot-hotkey-input");
