import { FIREFLY_STICKERS } from "./firefly-stickers";
// 表情包体系的共享类型，main 与 renderer 共用

/** 内置表情包 ID，渲染端据此判断来源 */
export const BUILT_IN_STICKER_IDS = FIREFLY_STICKERS.map((item) => item.id);

export type BuiltInStickerId = (typeof BUILT_IN_STICKER_IDS)[number];

/** 内置 ID 或用户自定义字符串 */
export type AnyStickerId = string;

/** 用户新增表情包的元数据，存于 userData/sticker-manifest.json */
export type UserStickerMeta = {
  createdAt: number;
  phrases: string[];
  description: string;
  file: string;
  id: string;
};

/** 表情包管理窗口使用的配置项 */
export type StickerConfigItem = {
  description?: string;
  builtIn: boolean;
  enabled: boolean;
  src: string;
  id: string;
};

export type StickerSize = "small" | "standard" | "large";

export type StickerManagerApi = {
  setEnabled: (id: string, enabled: boolean) => Promise<StickerConfigItem[]>;
  getConfig: () => Promise<StickerConfigItem[]>;
  close: () => void;
  minimize: () => void;
};
