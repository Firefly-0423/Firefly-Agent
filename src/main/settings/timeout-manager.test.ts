import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CHAT_REQUEST_TIMEOUT_MS, DEFAULT_TIMEOUT_SETTINGS, type TimeoutSettings } from "../../shared/timeout-types";

const state = vi.hoisted(() => ({ directory: "" }));

vi.mock("electron", () => ({
  app: { getPath: () => state.directory },
}));

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-timeout-settings-"));
  state.directory = root;
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

async function load() {
  return import("./timeout-manager");
}

const file = (): string => path.join(root, "timeout-settings.json");
const write = (value: unknown): void => fs.writeFileSync(file(), JSON.stringify(value));

describe("getTimeoutSettings", () => {
  it("returns the defaults when the file is missing", async () => {
    const { getTimeoutSettings } = await load();
    expect(getTimeoutSettings()).toEqual(DEFAULT_TIMEOUT_SETTINGS);
    expect(getTimeoutSettings()).not.toBe(DEFAULT_TIMEOUT_SETTINGS);
  });

  it("caches the first load for the lifetime of the module", async () => {
    write({ testTimeout: 1000 });
    const { getTimeoutSettings } = await load();
    const first = getTimeoutSettings();
    write({ testTimeout: 2000 });
    expect(getTimeoutSettings()).toBe(first);
    expect(getTimeoutSettings().testTimeout).toBe(1000);
  });

  it("normalizes a partial stored file, using defaults for missing and falsy values", async () => {
    write({
      testTimeout: 2500,
      chatRequestTimeout: 0,
      userChoiceTimeout: 45000,
      profileMinimumRemainingBudgetMs: 0,
      modelRequestTimeoutSec: 90,
    });
    const { getTimeoutSettings } = await load();
    expect(getTimeoutSettings()).toEqual({
      testTimeout: 2500,
      chatRequestTimeout: DEFAULT_CHAT_REQUEST_TIMEOUT_MS,
      userChoiceTimeout: 45000,
      profileMinimumRemainingBudgetMs: -1,
      modelRequestTimeoutSec: 90,
    });
  });

  it("falls back to the defaults for malformed JSON and logs the failure", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    fs.writeFileSync(file(), "{not json");
    const { getTimeoutSettings } = await load();
    expect(getTimeoutSettings()).toEqual(DEFAULT_TIMEOUT_SETTINGS);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("falls back to the defaults when the file cannot be read", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root);
    fs.mkdirSync(file());
    const { getTimeoutSettings } = await load();
    expect(getTimeoutSettings()).toEqual(DEFAULT_TIMEOUT_SETTINGS);
    expect(error).toHaveBeenCalledTimes(1);
  });
});

describe("saveTimeoutSettings", () => {
  it("merges a partial update into the loaded settings and persists it", async () => {
    write({ testTimeout: 1000 });
    const { saveTimeoutSettings } = await load();
    expect(saveTimeoutSettings({ userChoiceTimeout: 7000 })).toEqual({
      ...DEFAULT_TIMEOUT_SETTINGS,
      testTimeout: 1000,
      userChoiceTimeout: 7000,
    });
    expect(JSON.parse(fs.readFileSync(file(), "utf8"))).toEqual({
      ...DEFAULT_TIMEOUT_SETTINGS,
      testTimeout: 1000,
      userChoiceTimeout: 7000,
    });
    const second = saveTimeoutSettings({ testTimeout: 3000 });
    expect(second).toEqual({
      ...DEFAULT_TIMEOUT_SETTINGS,
      testTimeout: 3000,
      userChoiceTimeout: 7000,
    });
  });

  it("returns the same cached object that later reads observe", async () => {
    const { getTimeoutSettings, saveTimeoutSettings } = await load();
    const returned = saveTimeoutSettings({ chatRequestTimeout: 1234 });
    expect(returned).toBe(getTimeoutSettings());
    expect(returned.chatRequestTimeout).toBe(1234);
  });

  it("creates the user data directory before writing", async () => {
    const nested = path.join(root, "nested", "profile");
    state.directory = nested;
    const { saveTimeoutSettings } = await load();
    saveTimeoutSettings({ testTimeout: 5000 });
    expect(fs.existsSync(path.join(nested, "timeout-settings.json"))).toBe(true);
  });

  it("persists values that are loaded by a fresh module instance", async () => {
    const first = await load();
    first.saveTimeoutSettings({ userChoiceTimeout: 9000 });
    vi.resetModules();
    state.directory = root;
    const second = await load();
    expect(second.getTimeoutSettings().userChoiceTimeout).toBe(9000);
  });

  it("accepts a settings object whose fields are already complete", async () => {
    const { saveTimeoutSettings } = await load();
    const settings: TimeoutSettings = {
      testTimeout: 1,
      chatRequestTimeout: 2,
      userChoiceTimeout: 3,
      profileMinimumRemainingBudgetMs: 4,
    };
    expect(saveTimeoutSettings(settings)).toEqual(settings);
  });
});
