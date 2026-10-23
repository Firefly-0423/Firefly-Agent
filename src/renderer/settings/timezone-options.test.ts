import { describe, expect, it } from "vitest";
import { resolveChatContextTimezone, stripLeakedChatTimeContext } from "../../main/chat/chat-time-context";
import { FALLBACK_TIMEZONE, TIMEZONE_OPTIONS, normalizeTimezoneOptionValue } from "./timezone-options";

describe("timezone options", () => {
  it("lists each zone once, as an IANA Area/City name with the label format", () => {
    const values = TIMEZONE_OPTIONS.map((option) => option.value);
    expect(new Set(values).size).toBe(values.length);
    for (const { label, value } of TIMEZONE_OPTIONS) {
      expect(label).toMatch(/^.+时间（UTC[+-]\d{2}:\d{2}）$/);
      expect(value).toMatch(/^[A-Za-z_]+(\/[A-Za-z_]+)+$/);
      expect(() => new Intl.DateTimeFormat("en-US", { timeZone: value })).not.toThrow();
    }
  });

  it("is accepted unchanged by the main-process resolver, so a saved choice is never silently replaced", () => {
    for (const { value } of TIMEZONE_OPTIONS) {
      expect(resolveChatContextTimezone(value)).toBe(value);
    }
  });

  it("is recognised by the main-process time-metadata filter, so leaked time prefixes are stripped", () => {
    for (const { value } of TIMEZONE_OPTIONS) {
      expect(stripLeakedChatTimeContext(`[2026-10-13 10:00, ${value}] 你好`)).toBe("你好");
    }
  });

  it("keeps Asia/Shanghai as the fallback and the first choice", () => {
    expect(FALLBACK_TIMEZONE).toBe("Asia/Shanghai");
    expect(TIMEZONE_OPTIONS[0].value).toBe(FALLBACK_TIMEZONE);
  });

  it("accepts listed zones and falls back for empty, unknown or unlisted values", () => {
    expect(normalizeTimezoneOptionValue(" Asia/Hong_Kong ")).toBe("Asia/Hong_Kong");
    expect(normalizeTimezoneOptionValue("Pacific/Honolulu")).toBe("Pacific/Honolulu");
    expect(normalizeTimezoneOptionValue("")).toBe(FALLBACK_TIMEZONE);
    expect(normalizeTimezoneOptionValue(undefined)).toBe(FALLBACK_TIMEZONE);
    expect(normalizeTimezoneOptionValue("Asia/Kathmandu")).toBe(FALLBACK_TIMEZONE);
  });
});
