import { describe, expect, it } from "vitest";
import {
  computeNextCronFireAt,
  parseCronExpression,
  PluginScheduleError,
  validateAndConvertSchedule,
  validateTimezone,
} from "./index";

describe("cron parsing and validation", () => {
  it("parses valid 5-field cron expressions including ranges, steps, lists, and Sunday=7", () => {
    const parsed = parseCronExpression("0,30 9-17/2 1-15 1,6 7");
    expect(Array.from(parsed.minutes)).toEqual([0, 30]);
    expect(Array.from(parsed.hours)).toEqual([9, 11, 13, 15, 17]);
    expect(Array.from(parsed.daysOfMonth)).toHaveLength(15);
    expect(Array.from(parsed.months)).toEqual([1, 6]);
    expect(Array.from(parsed.daysOfWeek)).toEqual([0]);
  });

  it.each([
    ["empty string", ""],
    ["too few fields", "0 9 * *"],
    ["too many fields", "0 9 * * * *"],
    ["minute out of range", "60 9 * * *"],
    ["hour out of range", "0 24 * * *"],
    ["day of month zero", "0 9 0 * *"],
    ["month out of range", "0 9 * 13 *"],
    ["day of week out of range", "0 9 * * 8"],
    ["zero step", "*/0 * * * *"],
    ["reversed range", "0 17-9 * * *"],
    ["non-numeric token", "abc 9 * * *"],
  ])("rejects invalid cron expression (%s) with ERR_INVALID_ARGUMENT", (_label, expr) => {
    expect(() => parseCronExpression(expr)).toThrowError(PluginScheduleError);
    try {
      parseCronExpression(expr);
      expect.unreachable();
    } catch (error) {
      expect((error as PluginScheduleError).code).toBe("ERR_INVALID_ARGUMENT");
    }
  });

  it("validates IANA timezones and rejects unknown ones", () => {
    expect(() => validateTimezone("Asia/Shanghai")).not.toThrow();
    expect(() => validateTimezone("America/New_York")).not.toThrow();
    expect(() => validateTimezone("Invalid/Timezone")).toThrowError(PluginScheduleError);
    expect(() => validateTimezone("   ")).toThrowError(PluginScheduleError);
  });

  it("computes the next fire timestamp in a specified timezone", () => {
    // 2032-03-10T01:10:00Z is 2032-03-10 09:10 in Asia/Shanghai (UTC+8)
    const after = new Date("2032-03-10T01:10:00.000Z");
    const next = computeNextCronFireAt("15 9 * * *", after, "Asia/Shanghai");
    expect(next.toISOString()).toBe("2032-03-10T01:15:00.000Z");
  });

  it("uses union semantics when both day-of-month and day-of-week are restricted", () => {
    // 2032-03-10 is Wednesday (dow=3). Restrict DOM=15 and DOW=3 -> next match is 2032-03-10 12:00Z
    const after = new Date("2032-03-10T00:00:00.000Z");
    const next = computeNextCronFireAt("0 12 15 * 3", after, "UTC");
    expect(next.toISOString()).toBe("2032-03-10T12:00:00.000Z");
  });

  it("rejects impossible calendar dates such as Feb 30", () => {
    expect(() => computeNextCronFireAt("0 9 30 2 *", new Date("2032-01-01T00:00:00.000Z"), "UTC")).toThrowError(
      PluginScheduleError,
    );
  });
});

describe("validateAndConvertSchedule", () => {
  const now = new Date("2032-03-10T10:00:00.000Z");

  it("maps once, interval, simple daily/weekly cron, and general/timezone cron accurately", () => {
    expect(
      validateAndConvertSchedule({ kind: "once", at: now.getTime() + 60_000 }, now),
    ).toEqual({
      storeSchedule: { kind: "once", runAt: "2032-03-10T10:01:00.000Z" },
      requiresCronRearm: false,
    });

    expect(
      validateAndConvertSchedule({ kind: "interval", minutes: 30 }, now),
    ).toEqual({
      storeSchedule: { kind: "interval", every: 30, unit: "minutes" },
      requiresCronRearm: false,
    });

    expect(
      validateAndConvertSchedule({ kind: "interval", minutes: 2880 }, now),
    ).toEqual({
      storeSchedule: { kind: "interval", every: 48, unit: "hours" },
      requiresCronRearm: false,
    });

    expect(
      validateAndConvertSchedule({ kind: "cron", expression: "30 9 * * *" }, now),
    ).toEqual({
      storeSchedule: { kind: "daily", timeOfDay: "09:30" },
      requiresCronRearm: false,
    });

    expect(
      validateAndConvertSchedule({ kind: "cron", expression: "15 8 * * 7" }, now),
    ).toEqual({
      storeSchedule: { kind: "weekly", dayOfWeek: 0, timeOfDay: "08:15" },
      requiresCronRearm: false,
    });

    expect(
      validateAndConvertSchedule({ kind: "cron", expression: "*/15 * * * *", timezone: "UTC" }, now),
    ).toEqual({
      storeSchedule: { kind: "once", runAt: "2032-03-10T10:15:00.000Z" },
      requiresCronRearm: true,
    });
  });

  it.each([
    ["once in the past", { kind: "once", at: now.getTime() - 1000 }],
    ["once equal to now", { kind: "once", at: now.getTime() }],
    ["once NaN", { kind: "once", at: Number.NaN }],
    ["interval 0", { kind: "interval", minutes: 0 }],
    ["interval fractional", { kind: "interval", minutes: 1.5 }],
    ["interval above max hours", { kind: "interval", minutes: 169 * 60 }],
    ["interval >1440 non-multiple of 60", { kind: "interval", minutes: 1501 }],
    ["unknown kind", { kind: "yearly" }],
  ])("rejects invalid schedule (%s) with ERR_INVALID_ARGUMENT", (_label, schedule) => {
    try {
      validateAndConvertSchedule(schedule as never, now);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PluginScheduleError);
      expect((error as PluginScheduleError).code).toBe("ERR_INVALID_ARGUMENT");
    }
  });
});
