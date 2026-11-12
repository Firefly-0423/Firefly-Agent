import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeInitialNextFireAt, computeNextFireAtAfter, normalizeOverdueNextFireAt } from "./schedule-calculator";

describe("calendar schedules across daylight saving time", () => {
  const originalZone = process.env.TZ;
  beforeEach(() => { process.env.TZ = "America/New_York"; });
  afterEach(() => {
    if (originalZone === undefined) delete process.env.TZ;
    else process.env.TZ = originalZone;
  });

  it("returns to the configured daily time after the spring gap", () => {
    const schedule = { kind: "daily", timeOfDay: "02:30" } as const;
    const gap = computeInitialNextFireAt(schedule, new Date(2026, 2, 8, 0))!;
    expect(gap.getHours()).toBe(3);
    const next = computeNextFireAtAfter(schedule, gap)!;
    expect(next.toISOString()).toBe("2026-03-09T06:30:00.000Z");
    expect(normalizeOverdueNextFireAt(schedule, gap, new Date(2026, 2, 10, 0))?.getHours()).toBe(2);
  });

  it("does not carry today's spring gap adjustment into tomorrow or next week", () => {
    const now = new Date(2026, 2, 8, 4);
    expect(computeInitialNextFireAt({ kind: "daily", timeOfDay: "02:30" }, now)?.getHours()).toBe(2);
    expect(computeInitialNextFireAt({ kind: "weekly", dayOfWeek: 1, timeOfDay: "02:30" }, now)?.getHours()).toBe(2);
    expect(computeInitialNextFireAt({ kind: "weekly", dayOfWeek: 0, timeOfDay: "02:30" }, now)?.getHours()).toBe(2);
  });

  it("returns to the configured weekly time after the spring gap", () => {
    const schedule = { kind: "weekly", dayOfWeek: 0, timeOfDay: "02:30" } as const;
    const gap = computeInitialNextFireAt(schedule, new Date(2026, 2, 8, 0))!;
    expect(gap.getHours()).toBe(3);
    expect(computeNextFireAtAfter(schedule, gap)?.toISOString()).toBe("2026-03-15T06:30:00.000Z");
  });

  it("keeps daily wall time and interval elapsed time across the fall transition", () => {
    const before = new Date(2026, 9, 31, 12);
    const next = computeNextFireAtAfter({ kind: "daily", timeOfDay: "12:00" }, before)!;
    expect(next.getHours()).toBe(12);
    expect(next.getTime() - before.getTime()).toBe(25 * 60 * 60 * 1000);
    expect(computeNextFireAtAfter({ kind: "interval", every: 24, unit: "hours" }, before)!.getTime() - before.getTime()).toBe(24 * 60 * 60 * 1000);
  });
});
