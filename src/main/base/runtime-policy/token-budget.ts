export type RuntimeStage = "task-plan" | "ask-soul" | "memory-judge"
  | "memory-compressor" | "memory-reflect" | "memory-resolver";
export type TokenBudgetPolicy = {
  maxOutputTokens?: number; minOutputTokens?: number; defaultMaxOutputTokens: number;
};
export type ResolveTokenBudgetInput = { providerModelKey?: string; override?: number; stage: RuntimeStage };

const budgets: Record<RuntimeStage, TokenBudgetPolicy> = {
  "task-plan": { defaultMaxOutputTokens: 1200 }, "ask-soul": { defaultMaxOutputTokens: 1600 },
  "memory-judge": { defaultMaxOutputTokens: 800 }, "memory-compressor": { defaultMaxOutputTokens: 500 },
  "memory-reflect": { defaultMaxOutputTokens: 500 }, "memory-resolver": { defaultMaxOutputTokens: 700 },
};
export function getStageTokenPolicy(stage: RuntimeStage): Readonly<TokenBudgetPolicy> {
  return budgets[stage];
}
export function resolveMaxOutputTokens(input: ResolveTokenBudgetInput): number {
  const selected = budgets[input.stage];
  const requested = input.override;
  if (requested !== undefined && Number.isFinite(requested) && requested > 0) {
    const rounded = Math.round(requested);
    if (selected.minOutputTokens !== undefined && rounded < selected.minOutputTokens) return selected.minOutputTokens;
    if (selected.maxOutputTokens !== undefined && rounded > selected.maxOutputTokens) return selected.maxOutputTokens;
    return rounded;
  }
  return selected.defaultMaxOutputTokens;
}
