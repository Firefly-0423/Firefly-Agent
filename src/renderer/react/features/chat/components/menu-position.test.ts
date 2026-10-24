import { describe, expect, it } from "vitest";
import { placeMenu } from "./menu-position";

const view = { width: 1000, height: 700 };
const menu = { width: 180, height: 220 };

describe("placeMenu", () => {
  it("keeps the anchor when the menu fits", () => {
    expect(placeMenu({ x: 100, y: 120 }, menu, view)).toEqual({ left: 100, top: 120 });
  });
  it("slides left when it would run off the right edge", () => {
    expect(placeMenu({ x: 950, y: 120 }, menu, view).left).toBe(1000 - 180 - 8);
  });
  it("opens upward from the anchor's top when there is no room below", () => {
    expect(placeMenu({ x: 100, y: 660, above: 640 }, menu, view)).toEqual({ left: 100, top: 420 });
  });
  it("pins to the bottom of the window when neither side has room", () => {
    expect(placeMenu({ x: 100, y: 200, above: 150 }, menu, { width: 1000, height: 230 })).toEqual({ left: 100, top: 8 });
  });
  it("never leaves the left or top margin", () => {
    expect(placeMenu({ x: -20, y: -5 }, menu, view)).toEqual({ left: 8, top: 8 });
  });
});
