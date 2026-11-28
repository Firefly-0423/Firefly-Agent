import { afterEach, expect, it, vi } from "vitest";
import { getStageTimeoutPolicy, resolveTimeoutPolicy, type RuntimeTimeoutStage } from "./timeout-policy";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
it.each<[RuntimeTimeoutStage, number]>([
  ["vision-caption", 30000], ["external-http", 30000], ["asr-mossland", 30000],
  ["tool-execution", 300000], ["memory-llm", 30000],
])("provides a usable timeout for %s", (stage, duration) => {
  expect(() => resolveTimeoutPolicy({ stage })).not.toThrow();
  expect(resolveTimeoutPolicy({ stage }).totalMs).toBe(duration);
  expect(getStageTimeoutPolicy(stage)).toEqual(resolveTimeoutPolicy({ stage }));
});
it("merges individual overrides without altering subsequent defaults", () => {
  const total = resolveTimeoutPolicy({ stage: "memory-llm", override: { totalMs: 47000 } });
  expect(total).toEqual({ totalMs: 47000, firstResponseMs: undefined, idleMs: undefined });
  const first = resolveTimeoutPolicy({ stage: "tool-execution", override: { firstResponseMs: 12000 } });
  expect(first.totalMs).toBe(300000);
  expect(first.firstResponseMs).toBe(12000);
  expect(resolveTimeoutPolicy({ stage: "memory-llm" }).totalMs).toBe(30000);
});
it("allows a consumer to cancel its deadline before successful completion", () => {
  const cancel = vi.spyOn(globalThis, "clearTimeout");
  const signal = new AbortController();
  const deadline = setTimeout(() => signal.abort(), resolveTimeoutPolicy({ stage: "memory-llm" }).totalMs);
  clearTimeout(deadline);
  expect(cancel).toHaveBeenCalledWith(deadline);
  expect(signal.signal.aborted).toBe(false);
});
it("aborts at the configured deadline when the consumer keeps the timer", () => {
  vi.useFakeTimers();
  const signal = new AbortController();
  const duration = resolveTimeoutPolicy({ stage: "memory-llm" }).totalMs;
  const deadline = setTimeout(() => signal.abort(), duration);
  expect(signal.signal.aborted).toBe(false);
  vi.advanceTimersByTime(duration - 1);
  expect(signal.signal.aborted).toBe(false);
  vi.advanceTimersByTime(2);
  expect(signal.signal.aborted).toBe(true);
  clearTimeout(deadline);
});
