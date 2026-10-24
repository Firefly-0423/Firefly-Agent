import { beforeEach, afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = vi.hoisted(() => ({ directory: "" }));
vi.mock("electron", () => ({
  app: { getPath: () => sandbox.directory, isReady: () => true },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plain: string) => Buffer.from(JSON.stringify({ fixture: plain })),
    decryptString: (bytes: Buffer) => JSON.parse(bytes.toString()).fixture,
  },
}));
import { loadChannelsSettings, saveChannelsSettings } from "./settings-store";

const file = () => join(sandbox.directory, "channels-settings.json");
const seed = (value: unknown) => fs.writeFileSync(file(), JSON.stringify(value));
beforeEach(() => { sandbox.directory = fs.mkdtempSync(join(tmpdir(), "secure-channel-settings-")); });
afterEach(() => { fs.rmSync(sandbox.directory, { recursive: true, force: true }); });

it("defaults to disabled channels, restricted private access and chat without tools", () => {
  const settings = loadChannelsSettings();
  expect(settings.wechat).toMatchObject({ enabled: false, allowAnyPrivate: false, allowedSenderIds: [] });
  expect(settings.feishu).toMatchObject({ enabled: false, allowAnyPrivate: false, allowedSenderIds: [] });
  expect(settings.qq.enabled).toEqual(false);
  expect(settings.qq.port).toEqual(6200);
  expect(settings.rateLimitPerUser).toEqual(10);
  expect(settings.toolSandbox).toEqual("off");
});

it("preserves legacy open access only for channels that were enabled", () => {
  seed({ wechat: { enabled: true }, feishu: { enabled: false } });
  const settings = loadChannelsSettings();
  expect(settings.wechat.allowAnyPrivate).toEqual(true);
  expect(settings.feishu.allowAnyPrivate).toEqual(false);
});

it("persists explicit sender rules, drops malformed IDs and keeps rules through unrelated patches", () => {
  seed({ wechat: { enabled: true } });
  saveChannelsSettings({ wechat: { allowAnyPrivate: false, allowedSenderIds: ["reviewer@im.wechat", "invalid sender", "reviewer@im.wechat"] } as never });
  expect(loadChannelsSettings().wechat.allowAnyPrivate).toEqual(false);
  expect(loadChannelsSettings().wechat.allowedSenderIds).toStrictEqual(["reviewer@im.wechat"]);
  saveChannelsSettings({ wechat: { enabled: true } as never });
  expect(loadChannelsSettings().wechat).toMatchObject({ allowAnyPrivate: false, allowedSenderIds: ["reviewer@im.wechat"] });
});

it("keeps an unsupported stored secret byte-for-byte when reads and updates fail", () => {
  const original = JSON.stringify({ feishu: { appSecret: "plain:unsupported-contract" } });
  fs.writeFileSync(file(), original);
  expect(() => loadChannelsSettings()).toThrow("CHANNELS_SETTINGS_READ_FAILED");
  expect(() => saveChannelsSettings({ feishu: { enabled: true } })).toThrow("CHANNELS_SETTINGS_READ_FAILED");
  expect(fs.readFileSync(file(), "utf8")).toEqual(original);
});

it("encrypts QQ credentials and normalizes numeric allowlists", () => {
  saveChannelsSettings({ qq: {
    enabled: true, listenMode: "wsl", port: 6200, accessToken: "contract-qq-credential",
    allowedPrivateUserIds: [" 35791 ", "letters", "35791"], allowedGroupIds: ["24680"],
    groupRequireMention: true, groupReplyStyle: "reply-and-mention", groupToolPolicy: "off", groupMemoryPolicy: "shared-personal",
  } });
  expect(fs.readFileSync(file(), "utf8")).not.toContain("contract-qq-credential");
  const settings = loadChannelsSettings();
  expect(settings.qq.accessToken).toEqual("contract-qq-credential");
  expect(settings.qq.allowedPrivateUserIds).toStrictEqual(["35791"]);
  expect(settings.qq.allowedGroupIds).toStrictEqual(["24680"]);
});

it("stores public app metadata beside an encrypted secret and restores both", () => {
  saveChannelsSettings({ feishu: { enabled: true, appId: "cli_contract_review", appSecret: "contract-feishu-credential" } });
  const raw = fs.readFileSync(file(), "utf8");
  expect(raw).not.toContain("contract-feishu-credential");
  expect(raw).toContain("cli_contract_review");
  expect(raw).toContain('"appSecret": "enc:');
  expect(loadChannelsSettings().feishu).toMatchObject({ appId: "cli_contract_review", appSecret: "contract-feishu-credential" });
});

it("retains an omitted secret and replaces one explicitly supplied later", () => {
  saveChannelsSettings({ feishu: { enabled: true, appSecret: "contract-original" } });
  saveChannelsSettings({ feishu: { enabled: false, appId: "cli_contract_updated" } });
  expect(loadChannelsSettings().feishu).toMatchObject({ enabled: false, appId: "cli_contract_updated", appSecret: "contract-original" });
  saveChannelsSettings({ feishu: { enabled: true, appSecret: "contract-replacement" } });
  expect(loadChannelsSettings().feishu.appSecret).toEqual("contract-replacement");
});

it.each([["all", "all"], ["unknown-policy", "off"], ["safe-only", "off"]] as const)(
  "loads stored tool mode %s as %s", (stored, expected) => {
    seed({ toolSandbox: stored });
    expect(loadChannelsSettings().toolSandbox).toEqual(expected);
  },
);
it("round-trips the explicit tools-off preference", () => {
  saveChannelsSettings({ toolSandbox: "off" });
  expect(loadChannelsSettings().toolSandbox).toEqual("off");
});
