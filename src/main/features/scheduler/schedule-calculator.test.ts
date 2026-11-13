import { expect, it } from "vitest";
import { computeInitialNextFireAt as initial, computeNextFireAtAfter as after, normalizeOverdueNextFireAt as normalize } from "./schedule-calculator";

it("accepts a future one-shot time and rejects past or equal times", () => {
  const schedule = { kind: "once" as const, runAt: "2026-10-21T06:00:00.000Z" };
  expect(initial(schedule, new Date("2026-10-21T05:00:00Z"))?.toISOString()).toBe("2026-10-21T06:00:00.000Z");
  expect(initial(schedule, new Date("2026-10-21T07:00:00Z"))).toBeNull();
  expect(initial(schedule, new Date(schedule.runAt))).toBeNull();
});
it("uses the next strictly future daily occurrence in local time", () => {
  const schedule = { kind: "daily" as const, timeOfDay: "10:15" };
  const today = initial(schedule, new Date(2026, 9, 21, 9, 45));
  expect(today).toEqual(new Date(2026, 9, 21, 10, 15));
  const tomorrow = initial(schedule, new Date(2026, 9, 21, 10, 45));
  expect(tomorrow).toEqual(new Date(2026, 9, 22, 10, 15));
});
it("resolves the next requested weekday with its local hour and minute", () => {
  const monday = new Date(2026, 9, 19, 7);
  expect(monday.getDay()).toBe(1);
  const next = initial({ kind: "weekly", dayOfWeek: 4, timeOfDay: "11:45" }, monday);
  expect(next).toEqual(new Date(2026, 9, 22, 11, 45));
  expect(next?.getDay()).toBe(4);
});
it("advances interval schedules from their planned slot and rolls missed slots forward", () => {
  const schedule = { kind: "interval" as const, every: 1, unit: "hours" as const };
  const slot = new Date("2026-10-21T06:00:00Z");
  expect(after(schedule, slot)?.toISOString()).toBe("2026-10-21T07:00:00.000Z");
  expect(normalize(schedule, slot, new Date("2026-10-21T10:15:00Z"))?.toISOString()).toBe("2026-10-21T11:00:00.000Z");
});
it("normalizes very old minute schedules to a strictly future slot", () => {
  const now = new Date("2026-10-21T10:00:00Z");
  const next = normalize({ kind: "interval", every: 1, unit: "minutes" }, new Date("2025-02-01T00:00:00Z"), now);
  expect(next?.getTime()).toBeGreaterThan(now.getTime());
  expect(next?.toISOString()).toBe("2026-10-21T10:01:00.000Z");
});
