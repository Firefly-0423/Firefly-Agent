import { expect, test } from "vitest";
import { clampFloatingCardPosition } from "./floating-card";

test.each([
  [{ x: 1500, y: -40 }, { x: 784, y: 0 }],
  [{ x: -1, y: 900 }, { x: 0, y: 720 }],
  [{ x: 310, y: 180 }, { x: 310, y: 180 }],
])("keeps a dragged card reachable: %j", (requested, expected) => {
  const actual = clampFloatingCardPosition(requested,
    { width: 240, minVisibleHeight: 48 }, { width: 1024, height: 768 });
  expect(actual).toStrictEqual(expected);
});

test("pins oversized cards to the viewport origin", () => {
  expect(clampFloatingCardPosition({ x: 30, y: 60 },
    { width: 500, minVisibleHeight: 90 }, { width: 200, height: 40 }))
    .toStrictEqual({ x: 0, y: 0 });
});
