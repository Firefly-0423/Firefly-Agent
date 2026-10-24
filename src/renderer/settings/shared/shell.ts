// 加载模块时按既有顺序取得窗口壳元素。
function shellElement<T extends HTMLElement>(elementId: string): T {
  return document.getElementById(elementId) as T;
}

export const minBtn = shellElement<HTMLButtonElement>("min-btn");
export const closeBtn = shellElement<HTMLButtonElement>("close-btn");
export const preferencesForm = shellElement<HTMLFormElement>("preferences-form");
export const sectionTitle = shellElement<HTMLElement>("section-title");
export const sectionHint = shellElement<HTMLElement>("section-hint");
export const placeholderPanel = shellElement<HTMLElement>("placeholder-panel");
export const fireflyPanel = shellElement<HTMLFormElement>("firefly-panel");
export const disclaimerPanel = shellElement<HTMLElement>("disclaimer-panel");
export const pluginsPanel = shellElement<HTMLElement>("plugins-panel");
export const placeholderIcon = shellElement<HTMLElement>("placeholder-icon");
export const placeholderTitle = shellElement<HTMLElement>("placeholder-title");
export const placeholderCopy = shellElement<HTMLElement>("placeholder-copy");
export const saveStatus = shellElement<HTMLElement>("save-status");
export const runtimeSaveStatus = shellElement<HTMLElement>("runtime-save-status");
export const preferencesSaveStatus = shellElement<HTMLElement>("preferences-save-status");
export const fireflySaveStatus = shellElement<HTMLElement>("firefly-save-status");
export const openStickerManagerBtn = shellElement<HTMLButtonElement>("open-sticker-manager-btn");
export const addStickerBtn = shellElement<HTMLButtonElement>("add-sticker-btn");
