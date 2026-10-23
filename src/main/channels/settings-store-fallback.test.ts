import { beforeEach, afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const sandbox = vi.hoisted(() => ({ directory: "" }));
vi.mock("electron", () => ({
  app: { getPath: () => sandbox.directory, getName: () => "Contract fallback host", isReady: () => true },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: vi.fn(() => { throw new Error("keychain unexpectedly called"); }),
    decryptString: vi.fn(() => { throw new Error("keychain unexpectedly called"); }),
  },
}));
import { loadChannelsSettings, saveChannelsSettings } from "./settings-store";
import { safeStorage } from "electron";

const file = () => join(sandbox.directory, "channels-settings.json");
const readDisk = () => fs.readFileSync(file(), "utf8");
beforeEach(() => { sandbox.directory = fs.mkdtempSync(join(tmpdir(), "fallback-channel-settings-")); vi.clearAllMocks(); });
afterEach(() => { fs.rmSync(sandbox.directory, { recursive: true, force: true }); });

it("starts with an existing isolated directory and no settings document", () => {
  expect(fs.existsSync(sandbox.directory)).toEqual(true);
  expect(fs.existsSync(file())).toEqual(false);
});

it("round-trips a fallback credential without exposing plaintext or using the keychain", () => {
  saveChannelsSettings({ feishu: { enabled: true, appSecret: "fallback-contract-value" } });
  const raw = readDisk();
  expect(raw).not.toContain("fallback-contract-value");
  expect(raw).toMatch(/"appSecret":\s*"(enc|obf2):/);
  expect(raw).toContain('"appSecret": "obf2:');
  expect(loadChannelsSettings().feishu.appSecret).toEqual("fallback-contract-value");
  expect(safeStorage.encryptString).not.toHaveBeenCalled();
  expect(safeStorage.decryptString).not.toHaveBeenCalled();
});

it("retains the same fallback ciphertext through repeated unrelated updates", () => {
  saveChannelsSettings({ feishu: { enabled: true, appSecret: "preserved-fallback-contract" } });
  const first = JSON.parse(readDisk()).feishu.appSecret;
  expect(loadChannelsSettings().feishu.appSecret).toEqual("preserved-fallback-contract");
  saveChannelsSettings({ rateLimitPerUser: 27 });
  expect(loadChannelsSettings().feishu.appSecret).toEqual("preserved-fallback-contract");
  expect(JSON.parse(readDisk()).feishu.appSecret).toMatch(/^obf2:/);
  expect(JSON.parse(readDisk()).feishu.appSecret).toEqual(first);
});

it("keeps credentials while changing public fields and the enable switch", () => {
  saveChannelsSettings({ feishu: { enabled: true, appSecret: "stable-fallback-contract" } });
  saveChannelsSettings({ feishu: { enabled: false, appId: "cli_fallback_updated" } });
  expect(loadChannelsSettings().feishu).toMatchObject({ enabled: false, appId: "cli_fallback_updated", appSecret: "stable-fallback-contract" });
});

it("refuses to overwrite an encrypted credential that this environment cannot decrypt", () => {
  const raw = '{"feishu":{"appSecret":"enc:fixture-unreadable"}}';
  fs.writeFileSync(file(), raw);
  expect(() => saveChannelsSettings({ rateLimitPerUser: 27 })).toThrow("CHANNELS_SETTINGS_READ_FAILED");
  expect(readDisk()).toEqual(raw);
});
