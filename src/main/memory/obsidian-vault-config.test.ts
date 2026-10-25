import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ userData: "", warn: vi.fn() }));
vi.mock("electron", () => ({ app: { getPath: () => mocks.userData } }));
vi.mock("../logging/logger", () => ({ logger: { warn: mocks.warn }, LogTag: { Firefly: "Firefly" } }));

import {
  isVaultBound,
  loadObsidianVaultConfig,
  saveObsidianVaultConfig,
  unbindVault,
} from "./obsidian-vault-config";

let root = "";
const configPath = () => path.join(root, "obsidian-vault-config.json");
const writeRaw = (value: unknown) => fs.writeFileSync(configPath(), JSON.stringify(value), "utf8");

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-obsidian-config-"));
  mocks.userData = root;
  mocks.warn.mockClear();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("loadObsidianVaultConfig", () => {
  it("returns the unbound defaults when no file exists", () => {
    expect(loadObsidianVaultConfig()).toEqual({ vaultPath: "", autoSync: false, lastSyncAt: 0 });
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("loads a complete saved config", () => {
    writeRaw({ vaultPath: "C:/notes/vault", autoSync: true, lastSyncAt: 1234 });
    expect(loadObsidianVaultConfig()).toEqual({ vaultPath: "C:/notes/vault", autoSync: true, lastSyncAt: 1234 });
  });

  it("falls back per field for missing or mistyped values", () => {
    writeRaw({ vaultPath: 7, autoSync: "yes", lastSyncAt: "soon" });
    expect(loadObsidianVaultConfig()).toEqual({ vaultPath: "", autoSync: false, lastSyncAt: 0 });

    writeRaw({ vaultPath: "C:/vault", lastSyncAt: 99 });
    expect(loadObsidianVaultConfig()).toEqual({ vaultPath: "C:/vault", autoSync: false, lastSyncAt: 99 });
  });

  it("returns defaults and logs a warning for corrupt JSON", () => {
    fs.writeFileSync(configPath(), "{not json", "utf8");
    expect(loadObsidianVaultConfig()).toEqual({ vaultPath: "", autoSync: false, lastSyncAt: 0 });
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    expect(mocks.warn.mock.calls[0]?.[0]).toBe("Firefly");
    expect(String(mocks.warn.mock.calls[0]?.[1])).toContain("[obsidian-config] load failed");
  });
});

describe("saveObsidianVaultConfig", () => {
  it("merges a patch over the current config and returns the merge", () => {
    writeRaw({ vaultPath: "C:/old", autoSync: false, lastSyncAt: 5 });
    expect(saveObsidianVaultConfig({ autoSync: true })).toEqual({
      vaultPath: "C:/old",
      autoSync: true,
      lastSyncAt: 5,
    });
    expect(JSON.parse(fs.readFileSync(configPath(), "utf8"))).toEqual({
      vaultPath: "C:/old",
      autoSync: true,
      lastSyncAt: 5,
    });
  });

  it("creates the userData directory when it does not exist yet", () => {
    root = path.join(root, "nested", "userData");
    mocks.userData = root;
    expect(saveObsidianVaultConfig({ vaultPath: "C:/vault" })).toEqual({
      vaultPath: "C:/vault",
      autoSync: false,
      lastSyncAt: 0,
    });
    expect(fs.existsSync(configPath())).toBe(true);
  });

  it("writes pretty-printed JSON", () => {
    saveObsidianVaultConfig({ vaultPath: "C:/vault" });
    expect(fs.readFileSync(configPath(), "utf8")).toBe(
      JSON.stringify({ vaultPath: "C:/vault", autoSync: false, lastSyncAt: 0 }, null, 2),
    );
  });
});

describe("vault binding helpers", () => {
  it("reports bound only for a non-empty vault path", () => {
    expect(isVaultBound()).toBe(false);
    saveObsidianVaultConfig({ vaultPath: "C:/vault" });
    expect(isVaultBound()).toBe(true);
    saveObsidianVaultConfig({ vaultPath: "" });
    expect(isVaultBound()).toBe(false);
  });

  it("unbinds and resets auto sync and last sync time", () => {
    writeRaw({ vaultPath: "C:/vault", autoSync: true, lastSyncAt: 42 });
    expect(unbindVault()).toEqual({ vaultPath: "", autoSync: false, lastSyncAt: 0 });
    expect(loadObsidianVaultConfig()).toEqual({ vaultPath: "", autoSync: false, lastSyncAt: 0 });
  });
});
