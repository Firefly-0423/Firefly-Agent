import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ available: true, encrypt: vi.fn(), decrypt: vi.fn(), warn: vi.fn() }));
vi.mock("electron", () => ({ safeStorage: {
  isEncryptionAvailable: () => state.available,
  encryptString: state.encrypt,
  decryptString: state.decrypt,
} }));
vi.mock("../logging/logger", () => ({ logger: { warn: state.warn }, LogTag: { Runtime: "runtime" } }));
import { decodeCredentials, migrateCredentials, writeCredentials } from "./credential-storage";

let directory: string;
let file: string;
const fields = new Set(["apiKey"]);
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-credentials-"));
  file = path.join(directory, "settings.json");
  state.available = true;
  state.encrypt.mockReset().mockImplementation((text: string) => Buffer.from(`encrypted:${text}`));
  state.decrypt.mockReset().mockImplementation((bytes: Buffer) => {
    if (!bytes.toString().startsWith("encrypted:")) throw new Error("decrypt failed");
    return bytes.toString().slice(10);
  });
  state.warn.mockClear();
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true }); });

it("encrypts every copy of a secret, preserves metadata and round trips", () => {
  const plain = { apiKey: "top", perProvider: { test: { apiKey: "provider" } }, modelProfiles: [{ apiKey: "profile" }], other: 42 };
  writeCredentials(file, plain, fields);
  const disk = JSON.parse(fs.readFileSync(file, "utf8"));
  expect(disk.apiKey).toMatchObject({ $safeStorage: 1, ciphertext: expect.any(String) });
  expect(disk.perProvider.test.apiKey).not.toBe("provider");
  expect(disk.modelProfiles[0].apiKey).not.toBe("profile");
  expect(decodeCredentials(disk, fields)).toEqual(plain);
  expect(fs.readdirSync(directory)).toEqual(["settings.json"]);
});

it("migrates legacy JSON without normalizing away unknown settings", () => {
  const original = JSON.stringify({ apiKey: "legacy", retired: { keep: true } });
  fs.writeFileSync(file, original);
  migrateCredentials(file, original, JSON.parse(original), fields);
  expect(decodeCredentials(JSON.parse(fs.readFileSync(file, "utf8")), fields)).toEqual(JSON.parse(original));
  expect(JSON.parse(fs.readFileSync(file, "utf8")).apiKey).not.toBe("legacy");
});

it("keeps plaintext working and warns when encryption is unavailable, then migrates on retry", () => {
  state.available = false;
  writeCredentials(file, { apiKey: "legacy" }, fields);
  const original = fs.readFileSync(file, "utf8");
  expect(JSON.parse(original)).toEqual({ apiKey: "legacy" });
  expect(state.warn).toHaveBeenCalledWith("runtime", expect.stringContaining("CREDENTIAL_STORAGE_PLAINTEXT"));
  state.available = true;
  migrateCredentials(file, original, JSON.parse(original), fields);
  expect(JSON.parse(fs.readFileSync(file, "utf8")).apiKey).not.toBe("legacy");
});

it.each(["unavailable", "decrypt", "encrypt", "write", "rename"])("preserves an existing encrypted file on %s failure", (failure) => {
  writeCredentials(file, { apiKey: "original" }, fields);
  const original = fs.readFileSync(file, "utf8");
  if (failure === "unavailable") state.available = false;
  if (failure === "decrypt") state.decrypt.mockImplementation(() => { throw new Error("private error"); });
  if (failure === "encrypt") state.encrypt.mockImplementation(() => { throw new Error("private error"); });
  if (failure === "write") vi.spyOn(fs, "writeFileSync").mockImplementation(() => { throw new Error("write failed"); });
  if (failure === "rename") vi.spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("rename failed"); });
  expect(() => writeCredentials(file, { apiKey: "replacement" }, fields)).toThrow();
  expect(fs.readFileSync(file, "utf8")).toBe(original);
  expect(fs.readdirSync(directory)).toEqual(["settings.json"]);
  expect(JSON.stringify(state.warn.mock.calls)).not.toContain("private error");
});

it.each(["encrypt", "rename"])("keeps legacy data usable after migration %s failure", (failure) => {
  const original = '{"apiKey":"legacy"}';
  fs.writeFileSync(file, original);
  if (failure === "encrypt") state.encrypt.mockImplementation(() => { throw new Error("private error"); });
  else vi.spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("rename failed"); });
  expect(() => migrateCredentials(file, original, JSON.parse(original), fields)).not.toThrow();
  expect(fs.readFileSync(file, "utf8")).toBe(original);
  expect(fs.readdirSync(directory)).toEqual(["settings.json"]);
  expect(state.warn).toHaveBeenCalled();
});

it("refuses malformed encrypted values and never replaces a concurrently updated legacy file", () => {
  expect(() => decodeCredentials({ apiKey: { $safeStorage: 9, ciphertext: "bad" } }, fields)).toThrow();
  expect(() => decodeCredentials({ apiKey: { $safeStorage: 1, ciphertext: "%%%" } }, fields)).toThrow();
  const old = '{"apiKey":"old"}', current = '{"apiKey":"current"}';
  fs.writeFileSync(file, current);
  migrateCredentials(file, old, JSON.parse(old), fields);
  expect(fs.readFileSync(file, "utf8")).toBe(current);
});
