export type ContextUsageCategoryKey = "systemPrompt" | "tools" | "skills"
  | "runtimeAndToolLogs" | "conversation" | "other" | "toolDefinitions";
export type ContextUsagePhase = "preRequest" | "terminal";
export type ContextUsageCategory = { tokens: number; key: ContextUsageCategoryKey };
export type ContextUsageSnapshot = {
  updatedAt: number;
  messageCount: number;
  categories: ContextUsageCategory[];
  totalTokens: number;
  contextWindowTokens: number;
  round?: number;
  runId?: string;
  phase: ContextUsagePhase;
};

const knownCategories = new Set<string>([
  "systemPrompt", "tools", "skills", "runtimeAndToolLogs",
  "conversation", "other", "toolDefinitions",
]);
function finiteNumber(candidate: unknown): candidate is number {
  return typeof candidate === "number" && Number.isFinite(candidate);
}
// token 与条数是非负整数；负数或小数说明遥测已损坏。
function wholeCount(candidate: unknown): candidate is number {
  return typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0;
}
export function isContextUsageSnapshot(value: unknown): value is ContextUsageSnapshot {
  if (!value || typeof value !== "object") return false;
  const usage = value as Partial<ContextUsageSnapshot>;
  if (usage.phase !== "preRequest" && usage.phase !== "terminal") return false;
  if (!wholeCount(usage.contextWindowTokens) || usage.contextWindowTokens < 1) return false;
  if (!wholeCount(usage.totalTokens)) return false;
  if (!wholeCount(usage.messageCount)) return false;
  if (!finiteNumber(usage.updatedAt)) return false;
  if (!Array.isArray(usage.categories)) return false;
  return usage.categories.every((part) => part && typeof part === "object"
    && typeof part.key === "string" && knownCategories.has(part.key)
    && wholeCount(part.tokens));
}
