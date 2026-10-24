import { describe, expect, it } from "vitest";
import { formatTokens, legendRows, niceMax, stackSegments, USAGE_PALETTE, OTHER_COLOR } from "./format";

describe("usage formatting", () => {
  it("abbreviates token counts and promotes a thousand thousands to M", () => {
    expect([0, 999, 1234, 12_345, 123_456, 999_960, 1_000_000, 1_500_000, 2_000_000_000].map(formatTokens))
      .toEqual(["0", "999", "1.2k", "12.3k", "123k", "1M", "1M", "1.5M", "2B"]);
    expect([Number.NaN, -5].map(formatTokens)).toEqual(["0", "0"]);
  });

  it("colours the biggest categories, merges the rest into Other, and makes the shares add up to 100", () => {
    const items = Array.from({ length: 9 }, (_, index) => ({ name: `m${index}`, tokens: 100 - index * 10 }));
    const rows = legendRows(items);
    expect(rows).toHaveLength(USAGE_PALETTE.length + 1);
    expect(rows.slice(0, 3).map(row => row.name)).toEqual(["m0", "m1", "m2"]);
    expect(rows.at(-1)).toEqual(expect.objectContaining({ isOther: true, color: OTHER_COLOR, tokens: 30 + 20 }));
    expect(rows.reduce((sum, row) => sum + row.share, 0)).toBe(100);
    // Three equal categories would be 33/33/33 by rounding; the largest remainder gives the spare point to one of them.
    expect(legendRows([{ name: "a", tokens: 1 }, { name: "b", tokens: 1 }, { name: "c", tokens: 1 }]).map(row => row.share).sort()).toEqual([33, 33, 34]);
    expect(legendRows([{ name: "a", tokens: 0 }])).toEqual([]);
  });

  it("stacks a day in legend order and folds unlisted categories into Other", () => {
    const legend = legendRows(Array.from({ length: 9 }, (_, index) => ({ name: `m${index}`, tokens: 100 - index * 10 })));
    const segments = stackSegments({ m0: 5, m1: 0, m7: 4, m8: 3, unknown: 2 }, legend);
    expect(segments.map(segment => [segment.name, segment.tokens])).toEqual([["m0", 5], ["", 9]]);
    expect(segments[0]!.color).toBe(USAGE_PALETTE[0]);
    expect(segments[1]!.color).toBe(OTHER_COLOR);
  });

  it("rounds a chart's top to 1, 2 or 5 times a power of ten", () => {
    expect([0, 0.4, 1, 1.5, 3, 7, 12_345, 2_000_000].map(niceMax)).toEqual([1, 1, 1, 2, 5, 10, 20_000, 2_000_000]);
  });
});
