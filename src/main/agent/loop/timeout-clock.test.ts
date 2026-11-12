import { afterEach, describe, expect, it, vi } from "vitest";
import { TimeoutClock } from "./timeout-clock";

describe("TimeoutClock", () => {
  it("does not expire a run when total execution timeout is disabled", () => {
    const clock = new TimeoutClock(0, 60_000);
    clock.startActive();
    expect(clock.isExecutionTimeout()).toBe(false);
    expect(clock.remainingExecutionMs()).toBe(Number.POSITIVE_INFINITY);
  });

  describe("deadline handler", () => {
    afterEach(() => vi.useRealTimers());

    it("fires once when the remaining execution time runs out", () => {
      vi.useFakeTimers();
      const clock = new TimeoutClock(1_000, 60_000);
      const onDeadline = vi.fn();
      clock.setDeadlineHandler(onDeadline);
      clock.startActive();
      vi.advanceTimersByTime(999);
      expect(onDeadline).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onDeadline).toHaveBeenCalledOnce();
      vi.advanceTimersByTime(10_000);
      expect(onDeadline).toHaveBeenCalledOnce();
    });

    it("does not count user wait time and resumes with the time that is left", () => {
      vi.useFakeTimers();
      const clock = new TimeoutClock(1_000, 600_000);
      const onDeadline = vi.fn();
      clock.setDeadlineHandler(onDeadline);
      clock.startActive();
      vi.advanceTimersByTime(400);
      clock.startUserWait();
      vi.advanceTimersByTime(60_000);
      expect(onDeadline).not.toHaveBeenCalled();
      clock.stopUserWait();
      vi.advanceTimersByTime(599);
      expect(onDeadline).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onDeadline).toHaveBeenCalledOnce();
    });

    it("never fires when disabled, cleared, or after the run stops", () => {
      vi.useFakeTimers();
      const disabled = new TimeoutClock(0, 1);
      const a = vi.fn();
      disabled.setDeadlineHandler(a);
      disabled.startActive();
      const cleared = new TimeoutClock(100, 1);
      const b = vi.fn();
      cleared.setDeadlineHandler(b);
      cleared.startActive();
      cleared.setDeadlineHandler(null);
      const stopped = new TimeoutClock(100, 1);
      const c = vi.fn();
      stopped.setDeadlineHandler(c);
      stopped.startActive();
      stopped.stopActive();
      vi.advanceTimersByTime(10_000);
      expect([a, b, c].map((fn) => fn.mock.calls.length)).toEqual([0, 0, 0]);
    });
  });
});
