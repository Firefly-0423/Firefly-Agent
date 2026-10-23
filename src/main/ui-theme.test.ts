import { it, expect } from "vitest";
import { normalizeUiTheme, isDarkUiTheme } from "../shared/ui-theme";

it("restores supported themes and replaces legacy or absent selections with pearl white", () => {
  const saved = [undefined, "classic", "polished-pink", "unlisted", "pearl-white", "firefly-dark"];
  expect(saved.map(normalizeUiTheme)).toEqual([
    "pearl-white", "pearl-white", "pearl-white", "pearl-white", "pearl-white", "firefly-dark",
  ]);
  expect([isDarkUiTheme("pearl-white"), isDarkUiTheme("firefly-dark")]).toEqual([false, true]);
});
