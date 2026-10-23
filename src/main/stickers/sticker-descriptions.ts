import { FIREFLY_AUTO_STICKERS, FIREFLY_STICKERS } from "../../shared/firefly-stickers";

export interface StickerDescription {
  phrases: string[];
}

export const BUILT_IN_STICKER_DESCRIPTIONS: Record<string, StickerDescription> = Object.fromEntries(
  FIREFLY_STICKERS.map(sticker => [sticker.id, { phrases: [...sticker.phrases] }]),
);

/** 自动发送只在这组里做语义匹配；手动表情包（其余内置）不会被自动选中。 */
export const AUTO_SEND_STICKER_DESCRIPTIONS: Record<string, StickerDescription> = Object.fromEntries(
  FIREFLY_AUTO_STICKERS.map(sticker => [sticker.id, { phrases: [...sticker.phrases] }]),
);

export const BUILT_IN_STICKER_FILES: Record<string, string> = Object.fromEntries(
  FIREFLY_STICKERS.map(sticker => [sticker.id, sticker.file]),
);
