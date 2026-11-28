export const DEFAULT_MODEL_REQUEST_TIMEOUT_MS = 60_000;
export const MIN_MODEL_REQUEST_TIMEOUT_MS = 10_000;
export const MAX_MODEL_REQUEST_TIMEOUT_MS = 600_000;

export interface ModelTimeoutSettings { modelRequestTimeoutSec?: number }
export interface ResolvedModelTimeout {
  totalBudgetMs: number;
  perAttemptTimeoutMs: number;
}

export function normalizeModelRequestTimeoutMs(value: unknown): number {
  const milliseconds = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    return DEFAULT_MODEL_REQUEST_TIMEOUT_MS;
  }
  const rounded = Math.round(milliseconds);
  return Math.max(MIN_MODEL_REQUEST_TIMEOUT_MS, Math.min(MAX_MODEL_REQUEST_TIMEOUT_MS, rounded));
}

export function resolveModelRequestTimeoutMs(userSettings?: { modelRequestTimeoutSec?: number }): number {
  return userSettings?.modelRequestTimeoutSec
    ? normalizeModelRequestTimeoutMs(userSettings.modelRequestTimeoutSec * 1000)
    : DEFAULT_MODEL_REQUEST_TIMEOUT_MS;
}

export function resolveTotalBudgetMs(requestTimeoutMs: number, maxAttempts: number): number {
  const attempts = Math.max(1, maxAttempts);
  return requestTimeoutMs * attempts;
}

export function resolveModelTimeout(userSettings: ModelTimeoutSettings | undefined, maxAttempts: number): ResolvedModelTimeout {
  const timeout = resolveModelRequestTimeoutMs(userSettings);
  return { perAttemptTimeoutMs: timeout, totalBudgetMs: resolveTotalBudgetMs(timeout, maxAttempts) };
}
