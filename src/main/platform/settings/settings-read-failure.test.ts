import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ directory: "" }));
vi.mock("electron", () => ({ app: { getPath: () => state.directory } }));

beforeEach(() => {
  vi.resetModules();
  state.directory = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-read-test-"));
});
afterEach(() => fs.rmSync(state.directory, { recursive: true, force: true }));

for (const kind of ["model", "general"] as const) {
  describe(`${kind} settings read protection`, () => {
    async function storage() {
      if (kind === "model") {
        const settings = await import("./model-settings");
        return { load: settings.loadModelSettings, assert: settings.assertModelSettingsReadable, save: () => settings.saveModelSettings({}) };
      }
      const settings = await import("./settings-facade");
      return { load: settings.loadGeneralSettings, assert: settings.assertGeneralSettingsReadable, save: () => settings.saveGeneralSettings({}) };
    }
    const filename = kind === "model" ? "model-settings.json" : "app-settings.json";
    const code = kind === "model" ? "MODEL_SETTINGS_READ_FAILED" : "GENERAL_SETTINGS_READ_FAILED";

    it("distinguishes first use without writing an empty file", async () => {
      const store = await storage();
      expect(store.load()).toBeTruthy();
      expect(store.assert).not.toThrow();
      expect(fs.existsSync(path.join(state.directory, filename))).toBe(false);
    });

    it("loads valid empty settings without changing the original", async () => {
      const file = path.join(state.directory, filename);
      const contents = kind === "model" ? '{"schemaVersion":2,"modelProfiles":[]}' : '{}';
      fs.writeFileSync(file, contents);
      const store = await storage();
      store.load();
      expect(store.assert).not.toThrow();
      expect(fs.readFileSync(file, "utf8")).toBe(contents);
    });

    it.each(["{broken", "null", "[]"])("preserves corrupt settings and blocks writes: %s", async (contents) => {
      const file = path.join(state.directory, filename);
      fs.writeFileSync(file, contents);
      const store = await storage();
      store.load();
      expect(store.assert).toThrow(code);
      expect(store.save).toThrow(code);
      expect(fs.readFileSync(file, "utf8")).toBe(contents);
      expect(fs.readdirSync(state.directory)).toEqual([filename]);
    });

    if (kind === "model") {
      it("rejects an unsupported settings schema without rewriting the file", async () => {
        const file = path.join(state.directory, filename);
        const contents = '{"provider":"DeepSeek","baseUrl":"https://example.test","apiKey":"private-test"}';
        fs.writeFileSync(file, contents);
        const store = await storage();
        expect(store.assert).toThrow(code);
        expect(store.save).toThrow(code);
        expect(fs.readFileSync(file, "utf8")).toBe(contents);
      });
    }

    it("does not treat an unreadable filesystem entry as first use", async () => {
      const file = path.join(state.directory, filename);
      fs.mkdirSync(file);
      const store = await storage();
      store.load();
      expect(store.assert).toThrow(code);
      expect(store.save).toThrow(code);
      expect(fs.statSync(file).isDirectory()).toBe(true);
    });
  });
}

it("preserves a saved model profile when loading", async () => {
  const settings = await import("./model-settings");
  settings.saveModelProfile({ provider: "openai", model: "test-model", displayName: "Public test" });
  const file = path.join(state.directory, "model-settings.json");
  const contents = fs.readFileSync(file, "utf8");
  vi.resetModules();
  const reloaded = await import("./model-settings");
  reloaded.assertModelSettingsReadable();
  expect(reloaded.loadModelSettings().modelProfiles).toHaveLength(1);
  expect(fs.readFileSync(file, "utf8")).toBe(contents);
});
