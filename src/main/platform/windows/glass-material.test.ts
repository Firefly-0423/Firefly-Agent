import { describe, expect, it } from "vitest";
import { resolveGlassWindowOptions, supportsBackgroundMaterial } from "./glass-material";

describe("glass window material", () => {
  it("is available from Windows 11 22H2 onward only", () => {
    expect(supportsBackgroundMaterial("win32", "10.0.26300")).toBe(true);
    expect(supportsBackgroundMaterial("win32", "10.0.22621")).toBe(true);
    expect(supportsBackgroundMaterial("win32", "10.0.22000")).toBe(false);
    expect(supportsBackgroundMaterial("win32", "10.0.19045")).toBe(false);
    expect(supportsBackgroundMaterial("darwin", "10.0.26300")).toBe(false);
    expect(supportsBackgroundMaterial("win32", "")).toBe(false);
    expect(supportsBackgroundMaterial("win32", "garbage")).toBe(false);
  });

  it("uses an opaque window with acrylic when supported and the transparent window otherwise", () => {
    expect(resolveGlassWindowOptions("win32", "10.0.26300")).toEqual({
      glass: true,
      options: { transparent: false, backgroundMaterial: "acrylic" },
    });
    expect(resolveGlassWindowOptions("win32", "10.0.19045")).toEqual({
      glass: false,
      options: { transparent: true },
    });
  });
});
