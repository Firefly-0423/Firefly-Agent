import { describe, expect, it } from "vitest";
import { DEFAULT_UI_THEME, UI_THEMES, isDarkUiTheme, normalizeUiTheme } from "./ui-theme";

describe("ui theme", () => {
  it("offers exactly the light and the dark Firefly theme, light first", () => {
    expect([...UI_THEMES]).toEqual(["pearl-white", "firefly-dark"]);
    expect(DEFAULT_UI_THEME).toBe("pearl-white");
  });
  it("accepts both themes and sends anything else to the default", () => {
    expect(normalizeUiTheme("firefly-dark")).toBe("firefly-dark");
    expect(normalizeUiTheme("pearl-white")).toBe("pearl-white");
    for (const bad of [undefined, null, "", "dark", "classic", "polished-pink", "FIREFLY-DARK", 1, {}, ["firefly-dark"]]) {
      expect(normalizeUiTheme(bad)).toBe("pearl-white");
    }
  });
  it("identifies the dark theme", () => {
    expect(isDarkUiTheme("firefly-dark")).toBe(true);
    expect(isDarkUiTheme("pearl-white")).toBe(false);
  });
});
