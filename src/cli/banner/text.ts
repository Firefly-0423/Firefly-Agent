/** 边框内固定展示的三行；最后一行列出支持的模式，刻意不是版本号 */
export const BANNER_LINES = ["♡ Firefly_Agent ♡", "Your Desktop AI Companion", "Chat · Work · Code"] as const;

export const ABOUT_LINES = ["GitHub:   https://github.com/Firefly-0423/Firefly-Agent", "License:  MIT code; assets: THIRD_PARTY_NOTICES.md"] as const;

/** 终端宽度未知或过窄时使用的边框宽度 */
export const DEFAULT_BANNER_WIDTH = 64;
/** 边框最小宽度，再窄就放不下那句话了 */
export const MIN_BANNER_WIDTH = 60;

export interface RenderOptions {
  /** 覆盖自动探测到的宽度，主要给测试用 */
  width?: number;
  /** 预留给 v1.x，目前不读取，保留在类型里以免以后改调用方 */
  quote?: string;
}
