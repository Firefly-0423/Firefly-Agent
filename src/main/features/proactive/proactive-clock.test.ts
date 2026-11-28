import { describe, expect, it } from "vitest";
import {
  DEFAULT_QUIET_HOURS,
  getZonedDateParts,
  isWithinQuietHours,
  minuteOfDay,
} from "./proactive-clock";

const at = (iso: string) => new Date(iso);

describe("getZonedDateParts", () => {
  it("returns the wall clock of the requested time zone, not the system one", () => {
    // 2026-10-13T14:30Z 是上海 22:30，纽约 10:30
    expect(getZonedDateParts(at("2026-10-13T14:30:00Z"), "Asia/Shanghai")).toEqual({ year: 2026, month: 10, day: 13, hour: 22, minute: 30 });
    expect(getZonedDateParts(at("2026-10-13T14:30:00Z"), "America/New_York")).toEqual({ year: 2026, month: 10, day: 13, hour: 10, minute: 30 });
  });

  it("uses 0, never 24, at midnight", () => {
    expect(getZonedDateParts(at("2026-10-13T16:00:00Z"), "Asia/Shanghai").hour).toBe(0);
  });

  it("falls back to the system clock for an invalid zone instead of throwing", () => {
    const parts = getZonedDateParts(at("2026-10-13T14:30:00Z"), "Foo/Bar");
    expect(parts.hour).toBe(new Date("2026-10-13T14:30:00Z").getHours());
  });

  it("follows daylight-saving transitions", () => {
    // 纽约 2026-11-01 回拨：05:30Z 和 06:30Z 的墙上时间都是 01:30
    expect(getZonedDateParts(at("2026-11-01T05:30:00Z"), "America/New_York")).toMatchObject({ hour: 1, minute: 30 });
    expect(getZonedDateParts(at("2026-11-01T06:30:00Z"), "America/New_York")).toMatchObject({ hour: 1, minute: 30 });
    // 2026-03-08 拨快：06:59Z 是 01:59，07:00Z 直接是 03:00，不存在 02:xx
    expect(getZonedDateParts(at("2026-03-08T06:59:00Z"), "America/New_York")).toMatchObject({ hour: 1, minute: 59 });
    expect(getZonedDateParts(at("2026-03-08T07:00:00Z"), "America/New_York")).toMatchObject({ hour: 3, minute: 0 });
  });
});

describe("isWithinQuietHours", () => {
  const minute = (h: number, m: number) => h * 60 + m;

  it("includes the start and excludes the end of the default 22:00-08:00 window", () => {
    expect(isWithinQuietHours(minute(21, 59))).toBe(false);
    expect(isWithinQuietHours(minute(22, 0))).toBe(true);
    expect(isWithinQuietHours(minute(23, 59))).toBe(true);
    expect(isWithinQuietHours(minute(0, 0))).toBe(true);
    expect(isWithinQuietHours(minute(7, 59))).toBe(true);
    expect(isWithinQuietHours(minute(8, 0))).toBe(false);
    expect(isWithinQuietHours(minute(14, 0))).toBe(false);
  });

  it("supports a window that does not cross midnight, and an empty one", () => {
    const noon = { startMinute: minute(12, 0), endMinute: minute(14, 0) };
    expect(isWithinQuietHours(minute(11, 59), noon)).toBe(false);
    expect(isWithinQuietHours(minute(12, 0), noon)).toBe(true);
    expect(isWithinQuietHours(minute(13, 59), noon)).toBe(true);
    expect(isWithinQuietHours(minute(14, 0), noon)).toBe(false);
    expect(isWithinQuietHours(minute(3, 0), { startMinute: 600, endMinute: 600 })).toBe(false);
  });

  it("judges the user's local night: 14:30Z is 22:30 in Shanghai but 10:30 in New York", () => {
    const quiet = (zone: string) => isWithinQuietHours(minuteOfDay(getZonedDateParts(at("2026-10-13T14:30:00Z"), zone)));
    expect(quiet("Asia/Shanghai")).toBe(true);
    expect(quiet("America/New_York")).toBe(false);
  });

  it("treats both occurrences of the repeated 01:30 as quiet", () => {
    for (const iso of ["2026-11-01T05:30:00Z", "2026-11-01T06:30:00Z"]) {
      expect(isWithinQuietHours(minuteOfDay(getZonedDateParts(at(iso), "America/New_York")))).toBe(true);
    }
  });

  it("exposes the default window as data", () => {
    expect(DEFAULT_QUIET_HOURS).toEqual({ startMinute: 1320, endMinute: 480 });
  });
});

describe("one clock for every proactive decision", () => {
  it("no proactive module derives the local hour from the system clock", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = __dirname;
    const offenders = readdirSync(dir)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && name !== "proactive-clock.ts")
      .filter((name) => /\.getHours\(\)|\.getMinutes\(\)/.test(readFileSync(join(dir, name), "utf8")));
    // 取墙上时间必须经过 getZonedDateParts(用户 IANA 时区)；proactive-clock.ts 里的降级分支是唯一例外。
    expect(offenders).toEqual([]);
  });
});
