import { describe, expect, it } from "vitest";
import { makeSpark, sparkCount, sparkPace, stepSparks } from "./effort-sparks";

const fixed = (value: number) => () => value;

describe("effort sparks", () => {
  it("grows denser and faster with the level", () => {
    expect(sparkCount(0)).toBeLessThan(sparkCount(0.5));
    expect(sparkCount(0.5)).toBeLessThan(sparkCount(1));
    expect(sparkPace(1)).toBeGreaterThan(sparkPace(0));
    expect(sparkCount(7)).toBe(sparkCount(1));
  });

  it("drifts right and comes back in from the left once past the end", () => {
    const spark = { ...makeSpark(200, 28, fixed(0.5), true), x: 100 };
    const [moved] = stepSparks([spark], 0.1, 200, 28, 0, 1, fixed(0.5)).slice(0, 1);
    expect(moved.x).toBeGreaterThan(100);
    const [recycled] = stepSparks([{ ...spark, x: 260 }], 0.1, 200, 28, 0, 1, fixed(0.5));
    expect(recycled.x).toBeLessThanOrEqual(0);
  });

  it("keeps the stream at the size the level asks for and inside the bar's height", () => {
    const low = stepSparks([], 0.016, 200, 28, 0, 1, fixed(0.3));
    expect(low).toHaveLength(sparkCount(0));
    const high = stepSparks(low, 0.016, 200, 28, 1, 1, fixed(0.3));
    expect(high).toHaveLength(sparkCount(1));
    expect(stepSparks(high, 0.016, 200, 28, 0)).toHaveLength(sparkCount(0));
    expect(high.every((spark) => spark.y > 0 && spark.y < 28)).toBe(true);
  });
});
