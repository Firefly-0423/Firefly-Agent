import { describe, expect, it } from "vitest";
import {
  AUTO_COMPACT_THRESHOLD,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  MAX_CONTEXT_WINDOW_TOKENS,
  autoCompactTriggerTokens,
  formatContextWindowTokens,
  parseContextWindowTokens,
  resolveContextWindowTokens,
} from "./context-window";

describe("context window limits", () => {
  it("defaults to 1M, caps at 1M and compacts at 85%", () => {
    expect(DEFAULT_CONTEXT_WINDOW_TOKENS).toBe(1_000_000);
    expect(MAX_CONTEXT_WINDOW_TOKENS).toBe(1_000_000);
    expect(AUTO_COMPACT_THRESHOLD).toBe(0.85);
  });

  it("accepts numbers and numeric strings in range, clamps the top, rejects the rest", () => {
    expect(parseContextWindowTokens(128_000)).toBe(128_000);
    expect(parseContextWindowTokens("200000")).toBe(200_000);
    expect(parseContextWindowTokens(2_500_000)).toBe(1_000_000);
    expect(parseContextWindowTokens(4_096)).toBe(4_096);
    expect(parseContextWindowTokens(4_095)).toBeUndefined();
    expect(parseContextWindowTokens("")).toBeUndefined();
    expect(parseContextWindowTokens("abc")).toBeUndefined();
    expect(parseContextWindowTokens(Number.NaN)).toBeUndefined();
    expect(parseContextWindowTokens(undefined)).toBeUndefined();
    expect(resolveContextWindowTokens(undefined)).toBe(1_000_000);
    expect(resolveContextWindowTokens(300_000)).toBe(300_000);
  });

  it("triggers at 85% of the window, never above the usable input budget", () => {
    expect(autoCompactTriggerTokens(1_000_000)).toBe(850_000);
    expect(autoCompactTriggerTokens(200_000, { reservedOutputTokens: 8_192, safetyMarginTokens: 512 })).toBe(170_000);
    expect(autoCompactTriggerTokens(10_000, { reservedOutputTokens: 8_192, safetyMarginTokens: 512 })).toBe(1_296);
    expect(autoCompactTriggerTokens(0)).toBe(1);
  });

  it("formats compactly", () => {
    expect(formatContextWindowTokens(1_000_000)).toBe("1M");
    expect(formatContextWindowTokens(256_000)).toBe("256k");
    expect(formatContextWindowTokens(128_000)).toBe("128k");
  });
});
