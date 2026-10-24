import { afterEach, describe, expect, it, vi } from "vitest";
import { decideRetry, getRetryParams, sleepWithJitter } from "./retry-policy";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("Retry timing and cancellation", () => {
  it("keeps a half-jitter delay pending until precisely 115 percent of the base interval", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const finished = vi.fn();
    const waiting = sleepWithJitter(1_000).then(finished);
    await vi.advanceTimersByTimeAsync(1_149);
    expect(finished).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    expect(finished).toHaveBeenCalledTimes(1);
  });

  it("interrupts an outstanding backoff in the same microtask turn", async () => {
    vi.useFakeTimers();
    const cancellation = new AbortController();
    const failure = vi.fn();
    const success = vi.fn();
    const waiting = sleepWithJitter(3_000, cancellation.signal).then(success, failure);
    cancellation.abort();
    await waiting;
    expect(success).not.toHaveBeenCalled();
    expect(failure).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: "AbortError" }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects an already cancelled signal without scheduling work", async () => {
    vi.useFakeTimers();
    await expect(sleepWithJitter(20, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("limits partial retry to reads and publishes the exact backoff budgets", () => {
    expect(["read_only", "idempotent_mutation", "non_idempotent_side_effect"].map(
      (effect) => decideRetry("partial_failure", effect as Parameters<typeof decideRetry>[1]),
    )).toEqual(["retry", "no_retry", "no_retry"]);
    expect(["transient", "timeout", "rate_limited", "partial_failure", "fatal"].map(
      (category) => getRetryParams(category as Parameters<typeof getRetryParams>[0]),
    )).toEqual([
      { maxRetries: 3, backoffMs: [500, 1000, 2000] },
      { maxRetries: 2, backoffMs: [1000, 3000] },
      { maxRetries: 2, backoffMs: [2000, 5000] },
      { maxRetries: 1, backoffMs: [500] },
      { maxRetries: 0, backoffMs: [] },
    ]);
  });
});
