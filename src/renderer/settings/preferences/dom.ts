// 元素在模块加载时绑定，空值约定由各面板决定。
function control<T extends HTMLElement | null>(id: string): T {
  return document.getElementById(id) as T;
}

export const stickerEnabledInput = control<HTMLInputElement>("sticker-enabled");
export const stickerSizeSelect = control<HTMLElement>("sticker-size");
export const stickerThresholdInput = control<HTMLInputElement>("sticker-threshold");
export const stickerThresholdVal = control<HTMLElement>("sticker-threshold-val");
export const stickerAddOverlay = control<HTMLElement>("sticker-add-overlay");
export const stickerAddPickBtn = control<HTMLButtonElement>("sticker-add-pick-btn");
export const stickerAddFileName = control<HTMLElement>("sticker-add-file-name");
export const stickerAddId = control<HTMLInputElement>("sticker-add-id");
export const stickerAddDesc = control<HTMLInputElement>("sticker-add-desc");
export const stickerAddPhrases = control<HTMLTextAreaElement>("sticker-add-phrases");
export const stickerAddError = control<HTMLElement>("sticker-add-error");
export const stickerAddConfirm = control<HTMLButtonElement>("sticker-add-confirm");
export const stickerAddCancel = control<HTMLButtonElement>("sticker-add-cancel");
