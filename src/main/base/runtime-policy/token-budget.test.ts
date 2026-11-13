import { it, describe, expect } from "vitest";
import { getStageTokenPolicy, resolveMaxOutputTokens, type RuntimeStage } from "./token-budget";

describe("output allowances for background model stages", () => {
  it.each<[RuntimeStage, number]>([
    ["memory-resolver", 700], ["memory-reflect", 500], ["memory-compressor", 500],
    ["memory-judge", 800], ["ask-soul", 1600], ["task-plan", 1200],
  ])("exposes and resolves the %s default", (stage, allowance) => {
    expect(getStageTokenPolicy(stage).defaultMaxOutputTokens).toBe(allowance);
    expect(allowance).toBeGreaterThan(0);
    expect(resolveMaxOutputTokens({ stage })).toBe(allowance);
    for (const override of [0, -73, NaN, Infinity, -Infinity]) {
      expect(resolveMaxOutputTokens({ stage, override })).toBe(allowance);
    }
  });
  it("accepts a positive override and rounds fractions", () => {
    const resolve = (override: number) => resolveMaxOutputTokens({ override, stage: "task-plan" });
    expect([2310, 1742.7, 1742.4].map(resolve)).toEqual([2310, 1743, 1742]);
  });
});
