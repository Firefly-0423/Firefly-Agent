import { describe, expect, it, vi } from "vitest";
import {
  HEAD_MIN_Y,
  HIDDEN_DRAWABLE_IDS,
  NON_BODY_DRAWABLE_IDS,
  canvasToModelPoint,
  installHiddenDrawableGuard,
  pointInTriangle,
  resolveFireflyHitRegions,
  type HitRegionDrawable,
} from "./model-regions";

function fakeCore(opacities: Record<string, number>) {
  const ids = Object.keys(opacities);
  const original = vi.fn((index: number) => opacities[ids[index]]);
  const core = {
    getDrawableIndex: vi.fn((id: string) => ids.indexOf(id)),
    getDrawableOpacity: original as (index: number) => number,
  };
  return { core, original, ids };
}

describe("installHiddenDrawableGuard", () => {
  it("hides the drink, cake plate and table drawables and leaves the chair and shadow untouched", () => {
    expect(HIDDEN_DRAWABLE_IDS).toEqual(["ArtMesh153", "ArtMesh154", "ArtMesh155"]);
    const { core } = fakeCore({
      ArtMesh153: 1, ArtMesh154: 1, ArtMesh155: 1, ArtMesh156: 1, ArtMesh157: 0.5,
    });
    installHiddenDrawableGuard(core);
    expect(core.getDrawableOpacity(0)).toBe(0);
    expect(core.getDrawableOpacity(1)).toBe(0);
    expect(core.getDrawableOpacity(2)).toBe(0);
    expect(core.getDrawableOpacity(3)).toBe(1);
    expect(core.getDrawableOpacity(4)).toBe(0.5);
  });

  it("keeps hidden drawables at zero on every read, including after the original value changes", () => {
    const { core, original } = fakeCore({ ArtMesh153: 1, ArtMesh156: 1 });
    installHiddenDrawableGuard(core);
    for (let frame = 0; frame < 3; frame++) {
      original.mockReturnValue(1);
      expect(core.getDrawableOpacity(0)).toBe(0);
      expect(core.getDrawableOpacity(1)).toBe(1);
    }
  });

  it("restores the original accessor when uninstalled", () => {
    const { core, original } = fakeCore({ ArtMesh153: 1, ArtMesh156: 1 });
    const restore = installHiddenDrawableGuard(core);
    expect(core.getDrawableOpacity).not.toBe(original);
    restore();
    expect(core.getDrawableOpacity).toBe(original);
    expect(core.getDrawableOpacity(0)).toBe(1);
  });

  it("ignores hidden ids that the model does not contain", () => {
    const { core } = fakeCore({ ArtMesh156: 0.7 });
    installHiddenDrawableGuard(core, ["ArtMesh999"]);
    expect(core.getDrawableOpacity(0)).toBe(0.7);
  });
});

describe("NON_BODY_DRAWABLE_IDS", () => {
  it("lists only the hidden scenery, the chair and the foot shadow (ArtMesh23 is a character mesh)", () => {
    expect([...NON_BODY_DRAWABLE_IDS].sort()).toEqual([
      "ArtMesh153", "ArtMesh154", "ArtMesh155", "ArtMesh156", "ArtMesh157",
    ]);
    expect(NON_BODY_DRAWABLE_IDS.has("ArtMesh23")).toBe(false);
  });
});

describe("HEAD_MIN_Y", () => {
  it("is the documented -0.06 model-unit boundary", () => {
    expect(HEAD_MIN_Y).toBe(-0.06);
  });
});

describe("canvasToModelPoint", () => {
  it("inverts the library's forward transform px = x*ppu + W/2, py = -y*ppu + H/2", () => {
    const space = { pixelsPerUnit: 100, originalWidth: 400, originalHeight: 500 };
    // 模型点 (0.25, -0.5) 经库的正变换得到画布点 (225, 300)。
    expect(canvasToModelPoint(225, 300, space)).toEqual({ x: 0.25, y: -0.5 });
    expect(canvasToModelPoint(200, 250, space)).toEqual({ x: 0, y: 0 });
  });
});

describe("pointInTriangle", () => {
  const ax = 0, ay = 0, bx = 10, by = 0, cx = 0, cy = 10;
  it("accepts interior points and the edges", () => {
    expect(pointInTriangle(2, 2, ax, ay, bx, by, cx, cy)).toBe(true);
    expect(pointInTriangle(5, 0, ax, ay, bx, by, cx, cy)).toBe(true);
  });
  it("rejects exterior points regardless of winding order", () => {
    expect(pointInTriangle(20, 20, ax, ay, bx, by, cx, cy)).toBe(false);
    expect(pointInTriangle(2, 2, ax, ay, cx, cy, bx, by)).toBe(true);
    expect(pointInTriangle(-1, 5, ax, ay, cx, cy, bx, by)).toBe(false);
  });
});

describe("resolveFireflyHitRegions", () => {
  const COVER = () => true;
  const drawable = (overrides: Partial<HitRegionDrawable> & { id: string }): HitRegionDrawable => ({
    index: 0,
    opacity: 1,
    ...overrides,
  });
  const resolve = (
    entries: Array<Partial<HitRegionDrawable> & { id: string }>,
    pointModelY: number,
    hits: (index: number) => boolean = COVER,
  ) => resolveFireflyHitRegions({
    drawables: entries.map((entry, index) => drawable({ index, ...entry })),
    excludedDrawableIds: NON_BODY_DRAWABLE_IDS,
    isPointInDrawable: hits,
    pointModelY,
  });

  it("returns Head for face meshes above the boundary (eye, cheek, bangs and ArtMesh23)", () => {
    expect(resolve([{ id: "ArtMesh40" }], 0.12)).toEqual(["Head"]);
    expect(resolve([{ id: "ArtMesh50" }], 0.02)).toEqual(["Head"]);
    expect(resolve([{ id: "ArtMesh60" }], 0.35)).toEqual(["Head"]);
    expect(resolve([{ id: "ArtMesh23" }], 0.1)).toEqual(["Head"]);
  });

  it("returns Head when any visible character mesh is hit above the boundary", () => {
    expect(resolve([
      { id: "ArtMesh40", opacity: 0 },
      { id: "ArtMesh50" },
    ], 0.1, (index) => index === 1)).toEqual(["Head"]);
  });

  it("returns Body for chest, hand, leg and clothing meshes below the boundary", () => {
    expect(resolve([{ id: "ArtMesh90" }], -0.2)).toEqual(["Body"]);
    expect(resolve([{ id: "ArtMesh100" }], -0.45)).toEqual(["Body"]);
    expect(resolve([{ id: "ArtMesh110" }], -0.8)).toEqual(["Body"]);
    expect(resolve([{ id: "ArtMesh23" }], -0.2)).toEqual(["Body"]);
  });

  it("returns nothing for the chair, the foot shadow and the hidden desk items", () => {
    for (const id of ["ArtMesh156", "ArtMesh157", "ArtMesh153", "ArtMesh154", "ArtMesh155"]) {
      expect(resolve([{ id }], -0.5), id).toEqual([]);
      expect(resolve([{ id }], 0.2), id).toEqual([]);
    }
  });

  it("returns nothing for hidden (opacity zero) character meshes", () => {
    expect(resolve([{ id: "ArtMesh90", opacity: 0 }], -0.2)).toEqual([]);
  });

  it("treats the boundary value as Head and anything just below it as Body", () => {
    expect(resolve([{ id: "ArtMesh70" }], HEAD_MIN_Y)).toEqual(["Head"]);
    expect(resolve([{ id: "ArtMesh70" }], HEAD_MIN_Y - 0.0001)).toEqual(["Body"]);
  });

  it("uses an injected boundary when provided", () => {
    expect(resolveFireflyHitRegions({
      drawables: [drawable({ id: "ArtMesh70" })],
      excludedDrawableIds: NON_BODY_DRAWABLE_IDS,
      isPointInDrawable: COVER,
      pointModelY: 0,
      headMinY: 0.5,
    })).toEqual(["Body"]);
  });

  it("returns nothing when no candidate mesh contains the point", () => {
    expect(resolve([{ id: "ArtMesh90" }], -0.2, () => false)).toEqual([]);
  });
});
