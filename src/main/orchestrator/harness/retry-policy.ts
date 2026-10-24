import type { SideEffectKind, RetryDecision, ToolErrorCategory } from "./types";
import { createAbortError } from "../../utils/abort-utils";

export type RetryParams = { backoffMs: number[]; maxRetries: number };
export function decideRetry(category: ToolErrorCategory, sideEffect: SideEffectKind): RetryDecision {
  if (category === "fatal" || category === "runtime_safety" || sideEffect === "non_idempotent_side_effect") return "no_retry";
  if (sideEffect !== "read_only" && sideEffect !== "idempotent_mutation") return "no_retry";
  if (category === "transient" || category === "timeout" || category === "rate_limited") return "retry";
  return sideEffect === "read_only" && category === "partial_failure" ? "retry" : "no_retry";
}
export function getRetryParams(category: ToolErrorCategory): RetryParams {
  if (category === "transient") return { maxRetries: 3, backoffMs: [500, 1000, 2000] };
  if (category === "timeout") return { maxRetries: 2, backoffMs: [1000, 3000] };
  if (category === "rate_limited") return { maxRetries: 2, backoffMs: [2000, 5000] };
  return category === "partial_failure" ? { maxRetries: 1, backoffMs: [500] } : { maxRetries: 0, backoffMs: [] };
}
export function sleepWithJitter(ms: number, signal?: AbortSignal): Promise<void> {
  const spread = Math.random() * ms * 0.3;
  if (signal?.aborted) return Promise.reject(createAbortError());
  return new Promise((done, fail) => {
    const cancelled = () => {
      clearTimeout(alarm);
      signal?.removeEventListener("abort", cancelled);
      fail(createAbortError());
    };
    const alarm = setTimeout(() => {
      signal?.removeEventListener("abort", cancelled);
      done();
    }, ms + spread);
    signal?.addEventListener("abort", cancelled, { once: true });
  });
}
