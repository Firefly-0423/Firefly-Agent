import { t } from "../i18n";

export const STICKER_SEND_ENABLED_KEY = "settings.panel.firefly.sticker.sendEnabled";
export const STICKER_SEND_DISABLED_KEY = "settings.panel.firefly.sticker.sendDisabled";

/**
 * 表情包“发送状态”文案跟随开关：开启 = 允许发送（与 stickerEnabled 语义一致），关闭 = 不发送。
 * 同时改写 data-i18n，语言切换时 applyTranslations 会按当前开关状态取到正确文案。
 */
export function renderStickerSendStatus(element: HTMLElement, enabled: boolean): void {
  const key = enabled ? STICKER_SEND_ENABLED_KEY : STICKER_SEND_DISABLED_KEY;
  element.setAttribute("data-i18n", key);
  element.textContent = t(key);
}
