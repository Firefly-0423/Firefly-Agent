import { expect, describe, it } from "vitest";
import { DEFAULT_UI_FONT, normalizeUiFont, isSupportedFontFileName } from "../shared/ui-font";
import { isSafeUiFontRequest, getUiFontResponseHeaders } from "./protocols/ui-font-protocol";

describe("imported font selection and delivery", () => {
  it.each([undefined, { kind: "custom", fileName: "../private.ttf", displayName: "Hidden" },
    { kind: "custom", fileName: "web.woff2", displayName: "Web" }])("falls back for %j", value => {
    expect(normalizeUiFont(value)).toEqual(DEFAULT_UI_FONT);
  });
  it("retains a valid custom file while trimming its display label", () => {
    expect(normalizeUiFont({ kind: "custom", displayName: "  Reading face  ", fileName: "reading-72.otf" }))
      .toEqual({ displayName: "Reading face", fileName: "reading-72.otf", kind: "custom" });
  });
  it.each([["reading.ttf", true], ["reading.OTF", true], ["..\\reading.ttf", false], ["reading.ttf/child", false]] as const)(
    "validates both selection and requests for %s", (name, allowed) => {
      expect(isSupportedFontFileName(name)).toBe(allowed);
      expect(isSafeUiFontRequest(name)).toBe(allowed);
    });
  it("rejects traversal requests and sends cross-origin font MIME headers", () => {
    expect(isSafeUiFontRequest("../reading.ttf")).toBe(false);
    for (const extension of ["ttf", "otf"]) {
      expect(getUiFontResponseHeaders(`reading.${extension}`)).toEqual({
        "Access-Control-Allow-Origin": "*", "Content-Type": `font/${extension}`,
        "Cross-Origin-Resource-Policy": "cross-origin",
      });
    }
  });
});
