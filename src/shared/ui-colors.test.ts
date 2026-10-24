import { expect, it } from "vitest";
import { DEFAULT_UI_COLORS, normalizeUiColors, uiColorTokens } from "./ui-colors";
it("keeps existing appearance until custom colors are explicitly enabled", () => {
  expect(normalizeUiColors(undefined)).toEqual(DEFAULT_UI_COLORS);
  expect(uiColorTokens(normalizeUiColors(undefined))).toEqual({});
});
it("accepts normalized hex colors and rejects CSS expressions", () => {
  expect(normalizeUiColors({ enabled: true, accent: "#AABBCC", background: "url(x)", foreground: "red;display:none" })).toEqual({ ...DEFAULT_UI_COLORS, enabled: true, accent: "#aabbcc" });
});
it("maps custom colors to shared legacy and React tokens", () => {
  const tokens = uiColorTokens({ enabled: true, accent: "#123456", background: "#222222", foreground: "#eeeeee" });
  expect(tokens["--ff-accent"]).toBe("#123456");
  expect(tokens["--rb-pink-500"]).toBe("#123456");
  expect(tokens["--ff-bg-workspace"]).toBe("#222222");
  expect(tokens["--rb-text-default"]).toBe("#eeeeee");
});
