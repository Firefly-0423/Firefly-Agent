import { createRequire } from "node:module";
import path from "node:path";
import { expect, it } from "vitest";

const { loadTheme } = createRequire(import.meta.url)(path.join(process.cwd(),
  "vendor/firefly-skills/skills/pptx-generator/scripts/theme-loader.js"));

it("loads the presentation Skill's own default palette without an adjacent Skill", () => {
  expect(loadTheme()).toEqual({ primary: "22223B", secondary: "4A4E69", accent: "9A8C98", light: "C9ADA7", bg: "F2E9E4" });
  expect(loadTheme("business")).toEqual(loadTheme());
  const palette = loadTheme();
  palette.primary = "FFFFFF";
  expect(loadTheme().primary).toBe("22223B");
  expect(() => loadTheme("unknown")).toThrow("Unknown presentation theme");
});
