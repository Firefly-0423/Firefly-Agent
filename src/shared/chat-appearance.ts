// 外观排版设置 —— Main / Preload / Renderer 共用类型与归一化。
//
// 数值字段存储无单位数字，CSS 应用时再补单位：
// - chatLineHeight：行高（无单位）
// - chatParaSpacing：段间距（em）
// - uiFontSize / chatFontSize / codeFontSize：字号（px）

import { DARK_CODE_THEMES, LIGHT_CODE_THEMES, type DarkCodeTheme, type LightCodeTheme } from "./code-themes";

export interface ChatAppearanceSettings {
  /** 行高，无单位数字 */
  chatLineHeight: number;
  /** 消息段落之间的间距，单位 em */
  chatParaSpacing: number;
  /** 界面基础字号（px） */
  uiFontSize: number;
  /** 消息正文字号（px） */
  chatFontSize: number;
  /** 代码块字号（px） */
  codeFontSize: number;
  /** 减少动态效果：跟随系统、始终减少、始终保留动画 */
  reduceMotion: ReduceMotionPreference;
  /** 代码字体：系统等宽或几款常见编程字体 */
  codeFont: CodeFontChoice;
  /** 对话内容铺满整个对话区，而不是居中的阅读宽度 */
  fullWidthChat: boolean;
  /** 差异标记：只用红绿底色，或只用 +/− 符号 */
  diffMarkers: DiffMarkerStyle;
  /** 悬停可交互元素时显示手形指针 */
  pointerCursor: boolean;
  /** 输入时自动排版标点：引号、破折号、省略号、箭头 */
  smartPunctuation: boolean;
  /** 浅色主题下代码块的配色 */
  codeThemeLight: LightCodeTheme;
  /** 深色主题下代码块的配色 */
  codeThemeDark: DarkCodeTheme;
}

export const REDUCE_MOTION_PREFERENCES = ["system", "on", "off"] as const;
export type ReduceMotionPreference = (typeof REDUCE_MOTION_PREFERENCES)[number];
export const CODE_FONT_CHOICES = ["system", "jetbrains", "cascadia", "consolas"] as const;
export type CodeFontChoice = (typeof CODE_FONT_CHOICES)[number];
export const DIFF_MARKER_STYLES = ["color", "signs"] as const;
export type DiffMarkerStyle = (typeof DIFF_MARKER_STYLES)[number];

/** CSS font stacks for each code font choice. */
export const CODE_FONT_STACKS: Record<CodeFontChoice, string> = {
  system: 'ui-monospace, "Cascadia Mono", Consolas, monospace',
  jetbrains: '"JetBrains Mono", ui-monospace, Consolas, monospace',
  cascadia: '"Cascadia Code", "Cascadia Mono", ui-monospace, monospace',
  consolas: 'Consolas, ui-monospace, monospace',
};

export const DEFAULT_CHAT_APPEARANCE: ChatAppearanceSettings = {
  chatLineHeight: 1.75,
  chatParaSpacing: 0.5,
  uiFontSize: 16,
  chatFontSize: 14,
  codeFontSize: 13,
  reduceMotion: "system",
  codeFont: "system",
  fullWidthChat: false,
  diffMarkers: "color",
  pointerCursor: false,
  smartPunctuation: false,
  codeThemeLight: "firefly",
  codeThemeDark: "firefly",
};

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? value as T : fallback;
}

export const CHAT_LINE_HEIGHT_MIN = 1.0;
export const CHAT_LINE_HEIGHT_MAX = 3.0;
export const CHAT_PARA_SPACING_MIN = 0.2;
export const CHAT_PARA_SPACING_MAX = 1.2;
export const UI_FONT_SIZE_MIN = 12;
export const UI_FONT_SIZE_MAX = 20;
export const CHAT_FONT_SIZE_MIN = 12;
export const CHAT_FONT_SIZE_MAX = 22;
export const CODE_FONT_SIZE_MIN = 11;
export const CODE_FONT_SIZE_MAX = 20;

/**
 * 将有限数值 clamp 到 [min, max]；非有限值（NaN / Infinity / 非 number）回退默认值。
 */
export function clampFiniteNumber(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}

function clampPixelSize(value: unknown, min: number, max: number, fallback: number): number {
  return Math.round(clampFiniteNumber(value, min, max, fallback));
}

/**
 * 从任意输入归一化为合法 ChatAppearanceSettings。
 * 输入可以是完整对象、部分对象（旧存档只有 chatLineHeight）、null、undefined 或其他任意值；
 * 缺失或非法的字段回退默认值，多余字段被忽略。
 */
export function normalizeChatAppearance(
  input: unknown,
): ChatAppearanceSettings {
  const source =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};

  return {
    chatLineHeight: clampFiniteNumber(
      source.chatLineHeight,
      CHAT_LINE_HEIGHT_MIN,
      CHAT_LINE_HEIGHT_MAX,
      DEFAULT_CHAT_APPEARANCE.chatLineHeight,
    ),
    chatParaSpacing: clampFiniteNumber(
      source.chatParaSpacing,
      CHAT_PARA_SPACING_MIN,
      CHAT_PARA_SPACING_MAX,
      DEFAULT_CHAT_APPEARANCE.chatParaSpacing,
    ),
    uiFontSize: clampPixelSize(
      source.uiFontSize,
      UI_FONT_SIZE_MIN,
      UI_FONT_SIZE_MAX,
      DEFAULT_CHAT_APPEARANCE.uiFontSize,
    ),
    chatFontSize: clampPixelSize(
      source.chatFontSize,
      CHAT_FONT_SIZE_MIN,
      CHAT_FONT_SIZE_MAX,
      DEFAULT_CHAT_APPEARANCE.chatFontSize,
    ),
    codeFontSize: clampPixelSize(
      source.codeFontSize,
      CODE_FONT_SIZE_MIN,
      CODE_FONT_SIZE_MAX,
      DEFAULT_CHAT_APPEARANCE.codeFontSize,
    ),
    reduceMotion: oneOf(source.reduceMotion, REDUCE_MOTION_PREFERENCES, DEFAULT_CHAT_APPEARANCE.reduceMotion),
    codeFont: oneOf(source.codeFont, CODE_FONT_CHOICES, DEFAULT_CHAT_APPEARANCE.codeFont),
    fullWidthChat: source.fullWidthChat === true,
    diffMarkers: oneOf(source.diffMarkers, DIFF_MARKER_STYLES, DEFAULT_CHAT_APPEARANCE.diffMarkers),
    pointerCursor: source.pointerCursor === true,
    smartPunctuation: source.smartPunctuation === true,
    codeThemeLight: oneOf(source.codeThemeLight, LIGHT_CODE_THEMES, DEFAULT_CHAT_APPEARANCE.codeThemeLight),
    codeThemeDark: oneOf(source.codeThemeDark, DARK_CODE_THEMES, DEFAULT_CHAT_APPEARANCE.codeThemeDark),
  };
}
