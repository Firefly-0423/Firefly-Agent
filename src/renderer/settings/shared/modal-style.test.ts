// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { showInputModal } from "./modal";

const asset = (relative: string) => readFileSync(resolve(__dirname, relative), "utf8");

test("feedback styles expose the shared radius, danger color, semantic selectors and reduced-motion policy", () => {
  const themeRules = asset("../../ui/theme.css");
  expect(themeRules.includes("--rb-feedback-radius: 12px")).toBe(true);
  expect(themeRules.includes("--rb-feedback-danger:")).toBe(true);
  const settingsRules = asset("../settings.css");
  for (const rule of [".ff-modal--danger", ".ff-notice--success", "@media (prefers-reduced-motion: reduce)"]) {
    expect(settingsRules.includes(rule), rule).toEqual(true);
  }
});

test("input modal presentation comes from stylesheets rather than an inline attribute", async () => {
  const answer = showInputModal({ title: "Optional label", message: "Name this connection." });
  try {
    const field = document.querySelector<HTMLInputElement>("#ff-input-field");
    expect(field).not.toBeNull();
    expect(field!.hasAttribute("style")).toBe(false);
  } finally {
    document.querySelector<HTMLButtonElement>("#ff-input-cancel")!.click();
    await expect(answer).resolves.toBeNull();
  }
});
