import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ root: "" }));
vi.mock("electron", () => ({ app: { getPath: () => state.root } }));
beforeEach(() => {
  vi.resetModules();
  state.root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-current-skill-settings-"));
});
afterEach(() => fs.rmSync(state.root, { recursive: true, force: true }));

it("reads current mode overrides without rewriting the settings file", async () => {
  const file = path.join(state.root, "app-settings.json");
  const stored = JSON.stringify({ skillModeOverrides: { diagram: { code: false } } });
  fs.writeFileSync(file, stored);
  const settings = await import("./settings-facade");
  expect(settings.loadGeneralSettings().skillModeOverrides).toEqual({ diagram: { code: false } });
  expect(fs.readFileSync(file, "utf8")).toBe(stored);
});

it("blocks writes after a malformed current settings file is read", async () => {
  const file = path.join(state.root, "app-settings.json");
  fs.writeFileSync(file, "broken-json");
  const settings = await import("./settings-facade");
  expect(() => settings.saveGeneralSettings({ skillModeOverrides: {} })).toThrow();
  expect(fs.readFileSync(file, "utf8")).toBe("broken-json");
});
