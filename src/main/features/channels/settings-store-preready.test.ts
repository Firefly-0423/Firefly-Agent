import { expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const host = vi.hoisted(() => ({ directory: "", ready: false, available: false }));
vi.mock("electron", () => ({
  app: { getPath: () => host.directory, getName: () => "Contract readiness host", isReady: () => host.ready },
  safeStorage: {
    isEncryptionAvailable: () => host.available,
    encryptString: (value: string) => Buffer.from(JSON.stringify([value])),
    decryptString: (value: Buffer) => JSON.parse(value.toString())[0],
  },
}));
import { loadChannelsSettings, saveChannelsSettings } from "./settings-store";

it("switches from fallback protection to keychain encryption once the same process becomes ready", () => {
  host.directory = fs.mkdtempSync(join(tmpdir(), "preready-channel-settings-"));
  const disk = () => JSON.parse(fs.readFileSync(join(host.directory, "channels-settings.json"), "utf8"));
  try {
    host.ready = false;
    host.available = false;
    saveChannelsSettings({ feishu: { enabled: true, appId: "cli_readiness", appSecret: "before-ready-contract" } });
    expect(disk().feishu.appSecret).toMatch(/^obf2:/);
    host.ready = true;
    host.available = true;
    saveChannelsSettings({ feishu: { enabled: true, appId: "cli_readiness", appSecret: "after-ready-contract" } });
    expect(disk().feishu.appSecret).toMatch(/^enc:/);
    expect(loadChannelsSettings().feishu.appSecret).toEqual("after-ready-contract");
  } finally {
    fs.rmSync(host.directory, { force: true, recursive: true });
  }
});
