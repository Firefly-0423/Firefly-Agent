import { describe, expect, it, vi } from "vitest";
import {
  AMAP_MAP,
  WMO_MAP,
  formatDateText,
  formatReportTime,
  mapAmapWeather,
  mapWmoCode,
  omWindDir,
} from "./weather-utils";

const t = vi.hoisted(() =>
  vi.fn((key: string, options?: Record<string, unknown>) =>
    options ? `${key}:${JSON.stringify(options)}` : key,
  ),
);

vi.mock("../../../../i18n", () => ({ t }));

describe("mapWmoCode", () => {
  it("maps every known WMO code to its category and translated key", () => {
    for (const [code, [category, key]] of Object.entries(WMO_MAP)) {
      expect(mapWmoCode(Number(code))).toEqual([category, key]);
    }
  });

  it("falls back to cloudy/unknown for codes outside the table", () => {
    for (const code of [7, 100, -1, Number.NaN]) {
      expect(mapWmoCode(code)).toEqual(["cloudy", "weather.unknown"]);
    }
  });
});

describe("mapAmapWeather", () => {
  it("maps every known Chinese description", () => {
    for (const [text, category] of Object.entries(AMAP_MAP)) {
      expect(mapAmapWeather(text)).toBe(category);
    }
  });

  it("defaults unknown, empty and differently-cased text to cloudy", () => {
    for (const text of ["", "未知", "晴转多云", "晴 "]) {
      expect(mapAmapWeather(text)).toBe("cloudy");
    }
  });
});

describe("omWindDir", () => {
  it("rounds degrees to the nearest of sixteen compass directions", () => {
    expect(omWindDir(0)).toBe("weather.windDirN");
    expect(omWindDir(11.24)).toBe("weather.windDirN");
    expect(omWindDir(11.25)).toBe("weather.windDirNNE");
    expect(omWindDir(90)).toBe("weather.windDirE");
    expect(omWindDir(180)).toBe("weather.windDirS");
    expect(omWindDir(270)).toBe("weather.windDirW");
    expect(omWindDir(348.74)).toBe("weather.windDirNNW");
    expect(omWindDir(348.75)).toBe("weather.windDirN");
  });

  it("wraps full turns back to north", () => {
    expect(omWindDir(360)).toBe("weather.windDirN");
    expect(omWindDir(720)).toBe("weather.windDirN");
  });
});

describe("formatReportTime", () => {
  it("keeps only HH:mm from a report timestamp", () => {
    expect(formatReportTime("2026-07-28 14:30:00")).toBe(
      'weather.updatedAt:{"time":"14:30"}',
    );
    expect(formatReportTime("2026-07-28 09:05")).toBe(
      'weather.updatedAt:{"time":"09:05"}',
    );
  });

  it("passes an empty time when the timestamp has no time part", () => {
    expect(formatReportTime("2026-07-28")).toBe('weather.updatedAt:{"time":""}');
    expect(formatReportTime("")).toBe('weather.updatedAt:{"time":""}');
  });
});

describe("formatDateText", () => {
  it("formats month, day and weekday from the supplied local date", () => {
    const date = new Date(2026, 6, 28); // Tuesday
    expect(formatDateText(date)).toBe(
      'weather.dateText:{"month":7,"day":28,"week":"weather.weekday2"}',
    );
  });

  it("uses every weekday key from Sunday through Saturday", () => {
    for (let day = 0; day < 7; day++) {
      const date = new Date(2026, 5, 7 + day); // 2026-06-07 is a Sunday
      expect(formatDateText(date)).toContain(`"week":"weather.weekday${day}"`);
    }
  });
});
