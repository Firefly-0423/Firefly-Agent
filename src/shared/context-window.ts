/**
 * 上下文窗口与自动压缩的唯一定义点（主进程、设置页共用）。
 *
 * 其他模块只能从这里取默认值、上下限与压缩阈值，禁止再写 256000 / 0.7 / 0.8 这类字面量。
 */

/** 默认上下文窗口（Token）：1M。档案未单独设置时使用。 */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 1_000_000;

/** 用户可设置的最小 / 最大上下文窗口（Token）。上限固定 1M。 */
export const MIN_CONTEXT_WINDOW_TOKENS = 4_096;
export const MAX_CONTEXT_WINDOW_TOKENS = 1_000_000;

/** 自动压缩阈值：已用上下文达到窗口的 85% 时触发。 */
export const AUTO_COMPACT_THRESHOLD = 0.85;

/**
 * 旧版本设置页在「留空」时把 256000 写进档案，导致几乎所有已保存档案都带着它。
 * 仅用于一次性迁移：见 model-settings 的 contextWindowVersion。
 */
export const LEGACY_DEFAULT_CONTEXT_WINDOW_TOKENS = 256_000;

/** 合法值取整并夹到 [最小, 最大]；非数字或小于最小值返回 undefined（回退默认）。 */
export function parseContextWindowTokens(value: unknown): number | undefined {
  const raw = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < MIN_CONTEXT_WINDOW_TOKENS) return undefined;
  return Math.min(MAX_CONTEXT_WINDOW_TOKENS, Math.round(raw));
}

export function resolveContextWindowTokens(value: unknown, fallback = DEFAULT_CONTEXT_WINDOW_TOKENS): number {
  return parseContextWindowTokens(value) ?? fallback;
}

export interface AutoCompactLimitOptions {
  /** 为回复预留的 Token；窗口扣除预留与余量后的可用输入是触发线的上限。 */
  reservedOutputTokens?: number;
  /** 固定安全余量（Token）。 */
  safetyMarginTokens?: number;
  /** 触发比例，默认 AUTO_COMPACT_THRESHOLD。 */
  threshold?: number;
}

/**
 * 自动压缩触发线（Token）：窗口 × 阈值；窗口很小时不超过「窗口 − 预留输出 − 余量」，
 * 以免触发线本身高于模型实际能收下的输入。
 */
export function autoCompactTriggerTokens(contextWindowTokens: number, options: AutoCompactLimitOptions = {}): number {
  const { reservedOutputTokens = 0, safetyMarginTokens = 0, threshold = AUTO_COMPACT_THRESHOLD } = options;
  const usable = contextWindowTokens - reservedOutputTokens - safetyMarginTokens;
  return Math.max(1, Math.min(Math.floor(contextWindowTokens * threshold), usable));
}

/** 设置页 / 模型卡片上的紧凑显示：1000000 → "1M"，256000 → "256k"。 */
export function formatContextWindowTokens(tokens: number): string {
  if (tokens >= 1_000_000 && tokens % 1_000_000 === 0) return `${tokens / 1_000_000}M`;
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`;
  return `${Math.round(tokens / 1000)}k`;
}
