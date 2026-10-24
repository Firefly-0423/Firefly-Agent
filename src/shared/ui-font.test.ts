import { describe, expect, it } from "vitest";
import { DEFAULT_UI_FONT, isSupportedFontFileName, normalizeUiFont } from "./ui-font";

describe("normalizeUiFont", () => {
  it("returns the default font when the value is missing or malformed", () => {
    expect(normalizeUiFont(undefined)).toEqual({ kind: "source-han" });
    expect(normalizeUiFont(null)).toEqual(DEFAULT_UI_FONT);
    expect(normalizeUiFont("custom.ttf")).toEqual(DEFAULT_UI_FONT);
    expect(normalizeUiFont(42)).toEqual(DEFAULT_UI_FONT);
    expect(normalizeUiFont([])).toEqual(DEFAULT_UI_FONT);
  });

  it("accepts source-han and any other non-custom kind as the default font", () => {
    expect(normalizeUiFont({ kind: "source-han" })).toEqual(DEFAULT_UI_FONT);
    expect(normalizeUiFont({ kind: "unknown" })).toEqual(DEFAULT_UI_FONT);
  });

  it("keeps a valid custom font and trims the display name", () => {
    expect(normalizeUiFont({
      kind: "custom",
      fileName: "custom-a1b2.otf",
      displayName: "  可爱字体  ",
    })).toEqual({
      kind: "custom",
      fileName: "custom-a1b2.otf",
      displayName: "可爱字体",
    });
  });

  it("accepts uppercase extensions and multi-dot file names", () => {
    expect(normalizeUiFont({
      kind: "custom",
      fileName: "My.Font-v2.TTF",
      displayName: "My Font",
    })).toEqual({ kind: "custom", fileName: "My.Font-v2.TTF", displayName: "My Font" });
  });

  it("truncates an overlong display name to 80 characters after trimming", () => {
    const font = normalizeUiFont({
      kind: "custom",
      fileName: "font.ttf",
      displayName: "  " + "字".repeat(100) + "  ",
    });
    expect(font.kind).toBe("custom");
    if (font.kind === "custom") {
      expect(font.displayName).toHaveLength(80);
      expect(font.displayName).toBe("字".repeat(80));
    }
  });

  it.each([
    ["missing file name", { kind: "custom", displayName: "Font" }],
    ["non-string file name", { kind: "custom", fileName: 7, displayName: "Font" }],
    ["path traversal", { kind: "custom", fileName: "../font.ttf", displayName: "Font" }],
    ["absolute path", { kind: "custom", fileName: "C:/font.ttf", displayName: "Font" }],
    ["unsupported extension", { kind: "custom", fileName: "font.woff2", displayName: "Font" }],
    ["missing extension", { kind: "custom", fileName: "font", displayName: "Font" }],
    ["leading dot", { kind: "custom", fileName: ".font.ttf", displayName: "Font" }],
    ["leading dash", { kind: "custom", fileName: "-font.ttf", displayName: "Font" }],
    ["space in name", { kind: "custom", fileName: "my font.ttf", displayName: "Font" }],
    ["missing display name", { kind: "custom", fileName: "font.ttf" }],
    ["non-string display name", { kind: "custom", fileName: "font.ttf", displayName: 7 }],
    ["blank display name", { kind: "custom", fileName: "font.ttf", displayName: "   " }],
  ])("falls back to the default for %s", (_label, value) => {
    expect(normalizeUiFont(value)).toEqual(DEFAULT_UI_FONT);
  });
});

describe("isSupportedFontFileName", () => {
  it.each(["a.ttf", "font.ttf", "font.OTF", "custom-a1b2.otf", "My.Font-v2.TTF"])("accepts %s", (fileName) => {
    expect(isSupportedFontFileName(fileName)).toBe(true);
  });

  it.each([
    "",
    "font",
    "font.woff2",
    "font.ttf ",
    " font.ttf",
    "../font.ttf",
    "..\\font.ttf",
    "font.ttf/other",
    "C:/font.ttf",
    ".hidden.ttf",
    "_font.ttf",
    "字体.ttf",
  ])("rejects %j", (fileName) => {
    expect(isSupportedFontFileName(fileName)).toBe(false);
  });
});
