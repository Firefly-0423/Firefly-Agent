import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ directory: "", available: true, encrypt: vi.fn(), decrypt: vi.fn(), poll: vi.fn(), warn: vi.fn() }));
vi.mock("electron", () => ({ app: { getPath: () => state.directory }, safeStorage: {
  isEncryptionAvailable: () => state.available, encryptString: state.encrypt, decryptString: state.decrypt,
} }));
vi.mock("../../../logging/logger", () => ({ logger: { warn: state.warn }, LogTag: { Runtime: "runtime", Wechat: "wechat" } }));
vi.mock("./ilink-protocol-client", async (original) => ({ ...(await original<typeof import("./ilink-protocol-client")>()), pollQrStatus: state.poll }));
import { ILinkBotAdapter, loadCredentials } from "./ilink-bot-adapter";
import { writeCredentials, GENERAL_CREDENTIAL_FIELDS } from "../../../settings/credential-storage";

const credentials = { botToken: "bot-secret", ilinkBotId: "bot-id", ilinkUserId: "user-id", baseUrl: "https://example.test" };
let file: string;
beforeEach(() => {
  state.directory = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-wechat-credentials-"));
  fs.mkdirSync(path.join(state.directory, "weixin"));
  file = path.join(state.directory, "weixin", "credentials.json");
  state.available = true;
  state.warn.mockClear();
  state.encrypt.mockReset().mockImplementation((text: string) => Buffer.from(`encrypted:${text}`));
  state.decrypt.mockReset().mockImplementation((bytes: Buffer) => {
    if (!bytes.toString().startsWith("encrypted:")) throw new Error("private decrypt error");
    return bytes.toString().slice(10);
  });
  state.poll.mockReset().mockResolvedValue({ status: "confirmed", bot_token: credentials.botToken, ilink_bot_id: credentials.ilinkBotId, ilink_user_id: credentials.ilinkUserId, baseurl: credentials.baseUrl });
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(state.directory, { recursive: true, force: true }); });

it("migrates plaintext tokens and reconnects with the original credentials", async () => {
  fs.writeFileSync(file, JSON.stringify({ ...credentials, unknown: "preserved" }));
  expect(await loadCredentials()).toEqual({ ...credentials, unknown: "preserved" });
  expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({ botToken: { $safeStorage: 1 }, unknown: "preserved" });
  expect(await loadCredentials()).toEqual({ ...credentials, unknown: "preserved" });
});

it("encrypts QR login tokens before storing them", async () => {
  expect(await new ILinkBotAdapter().login("qr-fixture")).toEqual(credentials);
  expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({ botToken: { $safeStorage: 1 } });
  expect(await loadCredentials()).toEqual(credentials);
});

it("keeps plaintext login working with a warning if safeStorage is unavailable", async () => {
  state.available = false;
  await new ILinkBotAdapter().login("qr-fixture");
  expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(credentials);
  expect(await loadCredentials()).toEqual(credentials);
  expect(state.warn).toHaveBeenCalledWith("runtime", expect.stringContaining("CREDENTIAL_STORAGE_PLAINTEXT"));
});

it.each(["unavailable", "corrupt"])("preserves existing encrypted login and refuses replacement when %s", async (failure) => {
  await new ILinkBotAdapter().login("qr-fixture");
  const original = fs.readFileSync(file, "utf8");
  if (failure === "unavailable") state.available = false;
  else state.decrypt.mockImplementation(() => { throw new Error("private decrypt error"); });
  expect(await loadCredentials()).toBeNull();
  await expect(new ILinkBotAdapter().login("qr-fixture")).rejects.toThrow("CREDENTIAL_STORAGE_UNREADABLE");
  expect(fs.readFileSync(file, "utf8")).toBe(original);
  expect(JSON.stringify(state.warn.mock.calls)).not.toMatch(/bot-secret|private decrypt error/);
});

it("retains usable legacy credentials when migration encryption fails", async () => {
  const original = JSON.stringify(credentials);
  fs.writeFileSync(file, original);
  state.encrypt.mockImplementation(() => { throw new Error("encryption failed"); });
  expect(await loadCredentials()).toEqual(credentials);
  expect(fs.readFileSync(file, "utf8")).toBe(original);
});

it("recognizes encrypted ASR credentials in the direct WeChat settings reader", () => {
  writeCredentials(path.join(state.directory, "app-settings.json"), {
    asrEngine: "aliyun", asrAliyunAppKey: "app-key", asrAliyunAccessKeyId: "id", asrAliyunAccessKeySecret: "asr-secret",
  }, GENERAL_CREDENTIAL_FIELDS);
  const adapter = new ILinkBotAdapter();
  expect((adapter as unknown as { isAsrConfigured(): boolean }).isAsrConfigured()).toBe(true);
  state.available = false;
  expect((adapter as unknown as { isAsrConfigured(): boolean }).isAsrConfigured()).toBe(false);
});
