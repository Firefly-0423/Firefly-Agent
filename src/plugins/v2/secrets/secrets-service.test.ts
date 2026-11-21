import { access, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveRuntimeProfile } from "../../../main/base/identity/runtime-profile";
import { createStorageContext } from "../../../main/base/storage/storage-context";
import {
  createPluginSecretsService,
  isPluginError,
  resolvePluginSecretsDir,
  resolvePluginSecretsFile,
  type SafeStorageLike,
} from "./index";

const SEAL_PREFIX = Buffer.from("ff-v2-sealed:");

function xorBytes(input: Uint8Array): Buffer {
  return Buffer.from(input.map((byte) => byte ^ 0x5a));
}

function createFakeSafeStorage(options: {
  available?: boolean | (() => boolean);
  failEncrypt?: boolean;
  failDecrypt?: boolean;
  backend?: string;
} = {}): SafeStorageLike & {
  encryptCalls: number;
  decryptCalls: number;
} {
  const isAvailable = () =>
    typeof options.available === "function" ? options.available() : (options.available ?? true);

  const storage = {
    encryptCalls: 0,
    decryptCalls: 0,
    isEncryptionAvailable: () => isAvailable(),
    encryptString: (plainText: string): Buffer => {
      storage.encryptCalls += 1;
      if (options.failEncrypt) {
        throw new Error("encrypt-boom");
      }
      return Buffer.concat([SEAL_PREFIX, xorBytes(Buffer.from(plainText, "utf8"))]);
    },
    decryptString: (encrypted: Buffer): string => {
      storage.decryptCalls += 1;
      if (options.failDecrypt) {
        throw new Error("raw-decrypt-failure-detail");
      }
      if (!encrypted.subarray(0, SEAL_PREFIX.length).equals(SEAL_PREFIX)) {
        throw new Error("unexpected-prefix");
      }
      return xorBytes(encrypted.subarray(SEAL_PREFIX.length)).toString("utf8");
    },
    ...(options.backend !== undefined ? { getSelectedStorageBackend: () => options.backend! } : {}),
  };

  return storage;
}

async function capturePluginError(promise: Promise<unknown>): Promise<{ code: string; message: string; retryable: boolean }> {
  try {
    await promise;
  } catch (error) {
    expect(isPluginError(error)).toBe(true);
    if (!isPluginError(error)) {
      throw error;
    }
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  throw new Error("Expected promise to reject with PluginError");
}

async function listDirSafe(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), "ff-v2-secrets-"));
});

afterEach(async () => {
  vi.resetModules();
  await rm(tempRoot, { recursive: true, force: true });
});

describe("plugin secrets v2 service", () => {
  it("supports round-trip set, get, list, delete, deleteAll, and scoped forPlugin", async () => {
    const safeStorage = createFakeSafeStorage();
    const service = createPluginSecretsService({ dataRoot: tempRoot, safeStorage });
    const pluginId = "dev.firefly.weather";

    expect(await service.get(pluginId, "apiKey")).toBeNull();
    expect(await service.list(pluginId)).toEqual([]);
    await expect(access(resolvePluginSecretsDir(tempRoot))).rejects.toMatchObject({ code: "ENOENT" });

    await service.set(pluginId, "zKey", "密钥-🔑-value");
    await service.set(pluginId, "aKey", "");
    await service.set(pluginId, "constructor", "proto-safe");

    expect(await service.get(pluginId, "zKey")).toBe("密钥-🔑-value");
    expect(await service.get(pluginId, "aKey")).toBe("");
    expect(await service.get(pluginId, "constructor")).toBe("proto-safe");
    expect(await service.list(pluginId)).toEqual(["aKey", "constructor", "zKey"]);

    // Overwrite updates value cleanly without leaving temp files.
    await service.set(pluginId, "zKey", "updated-value");
    expect(await service.get(pluginId, "zKey")).toBe("updated-value");
    expect(await listDirSafe(resolvePluginSecretsDir(tempRoot))).toEqual([`${pluginId}.json`]);

    // Scoped Secrets view matching Spec §6.8.
    const scoped = service.forPlugin(pluginId);
    expect(await scoped.keys()).toEqual(["aKey", "constructor", "zKey"]);
    expect(await scoped.get("zKey")).toBe("updated-value");
    await scoped.set("scopedKey", "scoped-val");
    expect(await service.get(pluginId, "scopedKey")).toBe("scoped-val");
    expect(await scoped.delete("scopedKey")).toBe(true);
    expect(await scoped.delete("scopedKey")).toBe(false);

    // Delete remaining keys one by one; deleting last key removes the JSON file.
    expect(await service.delete(pluginId, "aKey")).toBe(true);
    expect(await service.delete(pluginId, "constructor")).toBe(true);
    expect(await service.delete(pluginId, "zKey")).toBe(true);
    expect(await service.delete(pluginId, "zKey")).toBe(false);
    expect(await service.get(pluginId, "zKey")).toBeNull();
    expect(await listDirSafe(resolvePluginSecretsDir(tempRoot))).toEqual([]);

    // deleteAll removes existing store and returns false when absent.
    await service.set(pluginId, "token", "abc");
    expect(await service.deleteAll(pluginId)).toBe(true);
    expect(await service.deleteAll(pluginId)).toBe(false);
    expect(await service.get(pluginId, "token")).toBeNull();
  });

  it("serializes concurrent writes for the same plugin without losing keys", async () => {
    const safeStorage = createFakeSafeStorage();
    const service = createPluginSecretsService({ dataRoot: tempRoot, safeStorage });
    const pluginId = "dev.firefly.concurrent";

    await Promise.all([
      service.set(pluginId, "key1", "val1"),
      service.set(pluginId, "key2", "val2"),
      service.set(pluginId, "key3", "val3"),
    ]);

    expect(await service.list(pluginId)).toEqual(["key1", "key2", "key3"]);
    expect(await service.get(pluginId, "key1")).toBe("val1");
    expect(await service.get(pluginId, "key2")).toBe("val2");
    expect(await service.get(pluginId, "key3")).toBe("val3");
  });

  it("never writes plaintext secret values onto disk", async () => {
    const safeStorage = createFakeSafeStorage();
    const service = createPluginSecretsService({ dataRoot: tempRoot, safeStorage });
    const pluginId = "dev.firefly.weather";
    const secretValue = "super-sensitive-plaintext-token-987654";

    await service.set(pluginId, "apiKey", secretValue);

    const filePath = resolvePluginSecretsFile(pluginId, tempRoot);
    const rawBytes = await readFile(filePath);
    expect(rawBytes.includes(Buffer.from(secretValue, "utf8"))).toBe(false);
    expect(rawBytes.includes(Buffer.from(secretValue, "utf8").toString("base64"))).toBe(false);

    const parsed = JSON.parse(rawBytes.toString("utf8")) as {
      version: number;
      entries: Record<string, { $safeStorage: number; ciphertext: string }>;
    };
    expect(parsed.version).toBe(1);
    expect(parsed.entries.apiKey.$safeStorage).toBe(1);
    expect(typeof parsed.entries.apiKey.ciphertext).toBe("string");
    expect(safeStorage.encryptCalls).toBe(1);
  });

  it("resolves default storage location from Firefly-1.2.0 StorageContext without hardcoded paths", async () => {
    const profile = resolveRuntimeProfile({
      argv: [],
      env: {},
      isPackaged: true,
      productionAppData: tempRoot,
    });
    const storageContext = createStorageContext(profile);
    const safeStorage = createFakeSafeStorage();
    const service = createPluginSecretsService({
      safeStorage,
      dataRoot: () => storageContext.dataRoot,
    });

    await service.set("dev.firefly.weather", "token", "secret-123");

    const expectedFile = path.join(storageContext.dataRoot, "plugin-secrets", "dev.firefly.weather.json");
    expect(path.basename(storageContext.dataRoot)).toBe("Firefly-1.2.0");
    await expect(access(expectedFile)).resolves.toBeUndefined();
    expect(await service.get("dev.firefly.weather", "token")).toBe("secret-123");
  });

  it("refuses a secret copied from another plugin's file or moved to another key name", async () => {
    const safeStorage = createFakeSafeStorage();
    const service = createPluginSecretsService({ dataRoot: tempRoot, safeStorage });
    await service.set("dev.firefly.victim", "token", "victim-secret");
    const victimFile = resolvePluginSecretsFile("dev.firefly.victim", tempRoot);
    const raw = await readFile(victimFile, "utf8");

    await writeFile(resolvePluginSecretsFile("dev.firefly.attacker", tempRoot), raw);
    const copied = await capturePluginError(service.get("dev.firefly.attacker", "token"));
    expect(copied.code).toBe("ERR_PERMISSION");
    expect(copied.message).not.toContain("victim-secret");

    const renamed = JSON.parse(raw) as { version: 1; entries: Record<string, unknown> };
    renamed.entries.other = renamed.entries.token;
    await writeFile(victimFile, JSON.stringify(renamed));
    expect((await capturePluginError(service.get("dev.firefly.victim", "other"))).code).toBe("ERR_PERMISSION");
    expect(await service.get("dev.firefly.victim", "token")).toBe("victim-secret");
  });

  it("turns a failure to create the secrets directory into ERR_INTERNAL without writing", async () => {
    const safeStorage = createFakeSafeStorage();
    await writeFile(path.join(tempRoot, "plugin-secrets"), "not a directory");
    const service = createPluginSecretsService({ dataRoot: tempRoot, safeStorage });
    const failure = await capturePluginError(service.set("dev.firefly.alpha", "token", "value"));
    expect(failure.code).toBe("ERR_INTERNAL");
    expect(await readFile(path.join(tempRoot, "plugin-secrets"), "utf8")).toBe("not a directory");
  });

  it("isolates secrets strictly per pluginId", async () => {
    const safeStorage = createFakeSafeStorage();
    const service = createPluginSecretsService({ dataRoot: tempRoot, safeStorage });
    const alpha = "dev.firefly.alpha";
    const beta = "dev.firefly.beta";

    await service.set(alpha, "sharedKey", "alpha-secret");
    expect(await service.get(beta, "sharedKey")).toBeNull();
    expect(await service.list(beta)).toEqual([]);
    expect(await service.delete(beta, "sharedKey")).toBe(false);

    await service.set(beta, "sharedKey", "beta-secret");
    expect(await service.get(alpha, "sharedKey")).toBe("alpha-secret");
    expect(await service.get(beta, "sharedKey")).toBe("beta-secret");

    expect(await service.deleteAll(beta)).toBe(true);
    expect(await service.get(alpha, "sharedKey")).toBe("alpha-secret");
    expect(await listDirSafe(resolvePluginSecretsDir(tempRoot))).toEqual([`${alpha}.json`]);
  });

  describe("input validation and path boundary security", () => {
    it.each([
      "",
      " ",
      "a.b.c",
      "pl-a",
      "Dev.firefly.weather",
      "../dev.firefly.evil",
      "dev/firefly/evil",
      "dev\\firefly\\evil",
      "dev.firefly..evil",
      ".dev.firefly.evil",
      "dev.firefly.evil.",
      `a.b.${"c".repeat(61)}`,
    ])("rejects invalid or traversal pluginId %j with ERR_INVALID_ARGUMENT and zero disk writes", async (badPluginId) => {
      const safeStorage = createFakeSafeStorage();
      const service = createPluginSecretsService({ dataRoot: tempRoot, safeStorage });

      expect((await capturePluginError(service.get(badPluginId, "apiKey"))).code).toBe("ERR_INVALID_ARGUMENT");
      expect((await capturePluginError(service.set(badPluginId, "apiKey", "val"))).code).toBe("ERR_INVALID_ARGUMENT");
      expect((await capturePluginError(service.delete(badPluginId, "apiKey"))).code).toBe("ERR_INVALID_ARGUMENT");
      expect((await capturePluginError(service.list(badPluginId))).code).toBe("ERR_INVALID_ARGUMENT");
      expect((await capturePluginError(service.deleteAll(badPluginId))).code).toBe("ERR_INVALID_ARGUMENT");

      expect(safeStorage.encryptCalls).toBe(0);
      expect(safeStorage.decryptCalls).toBe(0);
      await expect(access(resolvePluginSecretsDir(tempRoot))).rejects.toMatchObject({ code: "ENOENT" });
    });

    it.each([
      "",
      " ",
      ".",
      "..",
      "a..b",
      "../dev.firefly.other",
      "..\\dev.firefly.other",
      "a/b",
      "a\\b",
      "-leading",
      ".leading",
      "_leading",
      "__proto__",
      "bad\0null",
      "中文key",
      "k".repeat(65),
    ])("rejects invalid or traversal key %j with ERR_INVALID_ARGUMENT and zero disk writes", async (badKey) => {
      const safeStorage = createFakeSafeStorage();
      const service = createPluginSecretsService({ dataRoot: tempRoot, safeStorage });
      const pluginId = "dev.firefly.weather";

      expect((await capturePluginError(service.get(pluginId, badKey))).code).toBe("ERR_INVALID_ARGUMENT");
      expect((await capturePluginError(service.set(pluginId, badKey, "val"))).code).toBe("ERR_INVALID_ARGUMENT");
      expect((await capturePluginError(service.delete(pluginId, badKey))).code).toBe("ERR_INVALID_ARGUMENT");

      expect(safeStorage.encryptCalls).toBe(0);
      expect(safeStorage.decryptCalls).toBe(0);
      await expect(access(resolvePluginSecretsDir(tempRoot))).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("rejects non-string values with ERR_INVALID_ARGUMENT and zero disk writes", async () => {
      const safeStorage = createFakeSafeStorage();
      const service = createPluginSecretsService({ dataRoot: tempRoot, safeStorage });

      for (const badValue of [123, null, undefined, { secret: "x" }, ["a"]]) {
        const err = await capturePluginError(
          service.set("dev.firefly.weather", "apiKey", badValue as unknown as string),
        );
        expect(err.code).toBe("ERR_INVALID_ARGUMENT");
      }

      expect(safeStorage.encryptCalls).toBe(0);
      await expect(access(resolvePluginSecretsDir(tempRoot))).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("rejects when plugin-secrets directory is a symlink or junction pointing outside dataRoot", async () => {
      const outsideDir = await mkdtemp(path.join(tmpdir(), "ff-v2-outside-"));
      try {
        const secretsDir = resolvePluginSecretsDir(tempRoot);
        await symlink(outsideDir, secretsDir, process.platform === "win32" ? "junction" : "dir");

        const safeStorage = createFakeSafeStorage();
        const service = createPluginSecretsService({ dataRoot: tempRoot, safeStorage });

        expect((await capturePluginError(service.set("dev.firefly.evil", "k", "secret"))).code).toBe("ERR_INTERNAL");
        expect((await capturePluginError(service.get("dev.firefly.evil", "k"))).code).toBe("ERR_INTERNAL");
        expect((await capturePluginError(service.list("dev.firefly.evil"))).code).toBe("ERR_INTERNAL");
        expect(await listDirSafe(outsideDir)).toEqual([]);
      } finally {
        await rm(outsideDir, { recursive: true, force: true });
      }
    });

    it("rejects when a plugin secrets file is a symlink", async (ctx) => {
      const safeStorage = createFakeSafeStorage();
      const service = createPluginSecretsService({ dataRoot: tempRoot, safeStorage });
      const victimId = "dev.firefly.victim";
      const attackerId = "dev.firefly.attacker";

      await service.set(victimId, "apiKey", "victim-secret");
      const victimFile = resolvePluginSecretsFile(victimId, tempRoot);
      const attackerFile = resolvePluginSecretsFile(attackerId, tempRoot);

      try {
        await symlink(victimFile, attackerFile, "file");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EPERM" || code === "EACCES") {
          ctx.skip("Windows file symlink creation requires a privilege unavailable to this test process (EPERM)");
          return;
        }
        throw error;
      }

      expect((await lstat(attackerFile)).isSymbolicLink()).toBe(true);
      expect((await capturePluginError(service.get(attackerId, "apiKey"))).code).toBe("ERR_INTERNAL");
      expect((await capturePluginError(service.set(attackerId, "apiKey", "tampered"))).code).toBe("ERR_INTERNAL");
      expect((await capturePluginError(service.delete(attackerId, "apiKey"))).code).toBe("ERR_INTERNAL");
      expect((await capturePluginError(service.deleteAll(attackerId))).code).toBe("ERR_INTERNAL");
      expect(await service.get(victimId, "apiKey")).toBe("victim-secret");
    });

    it("rejects when a plugin secrets file path is a junction or directory", async () => {
      const outsideDir = await mkdtemp(path.join(tmpdir(), "ff-v2-file-junction-"));
      try {
        const secretsDir = resolvePluginSecretsDir(tempRoot);
        await mkdir(secretsDir, { recursive: true });
        const attackerId = "dev.firefly.attacker";
        const attackerFile = resolvePluginSecretsFile(attackerId, tempRoot);
        await symlink(outsideDir, attackerFile, process.platform === "win32" ? "junction" : "dir");

        const safeStorage = createFakeSafeStorage();
        const service = createPluginSecretsService({ dataRoot: tempRoot, safeStorage });

        expect((await capturePluginError(service.get(attackerId, "apiKey"))).code).toBe("ERR_INTERNAL");
        expect((await capturePluginError(service.set(attackerId, "apiKey", "tampered"))).code).toBe("ERR_INTERNAL");
        expect((await capturePluginError(service.delete(attackerId, "apiKey"))).code).toBe("ERR_INTERNAL");
        expect((await capturePluginError(service.deleteAll(attackerId))).code).toBe("ERR_INTERNAL");
      } finally {
        await rm(outsideDir, { recursive: true, force: true });
      }
    });
  });

  describe("safeStorage unavailability fail-closed behavior", () => {
    it("rejects with ERR_UNAVAILABLE and writes zero bytes when isEncryptionAvailable() is false", async () => {
      const safeStorage = createFakeSafeStorage({ available: false });
      const service = createPluginSecretsService({ dataRoot: tempRoot, safeStorage });
      const pluginId = "dev.firefly.weather";

      expect((await capturePluginError(service.set(pluginId, "apiKey", "secret"))).code).toBe("ERR_UNAVAILABLE");
      expect((await capturePluginError(service.get(pluginId, "apiKey"))).code).toBe("ERR_UNAVAILABLE");
      expect((await capturePluginError(service.list(pluginId))).code).toBe("ERR_UNAVAILABLE");
      expect((await capturePluginError(service.delete(pluginId, "apiKey"))).code).toBe("ERR_UNAVAILABLE");

      expect(safeStorage.encryptCalls).toBe(0);
      expect(safeStorage.decryptCalls).toBe(0);
      await expect(access(resolvePluginSecretsDir(tempRoot))).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("rejects with ERR_UNAVAILABLE and writes zero bytes when isEncryptionAvailable() throws", async () => {
      const safeStorage: SafeStorageLike = {
        isEncryptionAvailable: () => {
          throw new Error("keychain-locked");
        },
        encryptString: () => Buffer.from("unused"),
        decryptString: () => "unused",
      };
      const service = createPluginSecretsService({ dataRoot: tempRoot, safeStorage });
      const pluginId = "dev.firefly.weather";

      expect((await capturePluginError(service.set(pluginId, "apiKey", "secret"))).code).toBe("ERR_UNAVAILABLE");
      expect((await capturePluginError(service.get(pluginId, "apiKey"))).code).toBe("ERR_UNAVAILABLE");
      await expect(access(resolvePluginSecretsDir(tempRoot))).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("rejects with ERR_UNAVAILABLE when default StorageContext is not initialized", async () => {
      const safeStorage = createFakeSafeStorage();
      const service = createPluginSecretsService({ safeStorage });

      expect((await capturePluginError(service.set("dev.firefly.weather", "apiKey", "secret"))).code).toBe(
        "ERR_UNAVAILABLE",
      );
      expect(safeStorage.encryptCalls).toBe(0);
    });

    it("rejects with ERR_UNAVAILABLE and writes zero bytes when safeStorage is missing", async () => {
      const service = createPluginSecretsService({ dataRoot: tempRoot });
      const pluginId = "dev.firefly.weather";

      expect((await capturePluginError(service.set(pluginId, "apiKey", "secret"))).code).toBe("ERR_UNAVAILABLE");
      expect((await capturePluginError(service.get(pluginId, "apiKey"))).code).toBe("ERR_UNAVAILABLE");
      expect((await capturePluginError(service.list(pluginId))).code).toBe("ERR_UNAVAILABLE");
      expect((await capturePluginError(service.delete(pluginId, "apiKey"))).code).toBe("ERR_UNAVAILABLE");

      await expect(access(resolvePluginSecretsDir(tempRoot))).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("preserves existing encrypted file unmodified when safeStorage becomes unavailable", async () => {
      let available = true;
      const safeStorage = createFakeSafeStorage({ available: () => available });
      const service = createPluginSecretsService({ dataRoot: tempRoot, safeStorage });
      const pluginId = "dev.firefly.weather";

      await service.set(pluginId, "apiKey", "existing-secret");
      const filePath = resolvePluginSecretsFile(pluginId, tempRoot);
      const beforeBytes = await readFile(filePath);

      available = false;

      expect((await capturePluginError(service.set(pluginId, "apiKey", "new-plaintext"))).code).toBe("ERR_UNAVAILABLE");
      expect((await capturePluginError(service.set(pluginId, "otherKey", "another"))).code).toBe("ERR_UNAVAILABLE");
      expect((await capturePluginError(service.get(pluginId, "apiKey"))).code).toBe("ERR_UNAVAILABLE");
      expect((await capturePluginError(service.list(pluginId))).code).toBe("ERR_UNAVAILABLE");
      expect((await capturePluginError(service.delete(pluginId, "apiKey"))).code).toBe("ERR_UNAVAILABLE");

      const afterBytes = await readFile(filePath);
      expect(afterBytes.equals(beforeBytes)).toBe(true);
      expect(afterBytes.includes(Buffer.from("new-plaintext", "utf8"))).toBe(false);
    });

    it("allows deleteAll cleanup on uninstall even when safeStorage is unavailable", async () => {
      let available = true;
      const safeStorage = createFakeSafeStorage({ available: () => available });
      const service = createPluginSecretsService({ dataRoot: tempRoot, safeStorage });
      const pluginId = "dev.firefly.weather";

      await service.set(pluginId, "apiKey", "existing-secret");
      available = false;

      expect(await service.deleteAll(pluginId)).toBe(true);
      await expect(access(resolvePluginSecretsFile(pluginId, tempRoot))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  describe("cipher and storage corruption handling", () => {
    it("fails get with ERR_INTERNAL when decryption fails and does not leak raw error text", async () => {
      const writer = createPluginSecretsService({ dataRoot: tempRoot, safeStorage: createFakeSafeStorage() });
      await writer.set("dev.firefly.weather", "apiKey", "secret");

      const reader = createPluginSecretsService({
        dataRoot: tempRoot,
        safeStorage: createFakeSafeStorage({ failDecrypt: true }),
      });
      const err = await capturePluginError(reader.get("dev.firefly.weather", "apiKey"));
      expect(err.code).toBe("ERR_INTERNAL");
      expect(err.message).not.toContain("raw-decrypt-failure-detail");
    });

    it("does not overwrite a corrupted secrets file on set", async () => {
      const secretsDir = resolvePluginSecretsDir(tempRoot);
      const pluginId = "dev.firefly.corrupt";
      const filePath = resolvePluginSecretsFile(pluginId, tempRoot);
      await mkdir(secretsDir, { recursive: true });
      await writeFile(filePath, "{not-valid-json", "utf8");

      const service = createPluginSecretsService({ dataRoot: tempRoot, safeStorage: createFakeSafeStorage() });
      expect((await capturePluginError(service.set(pluginId, "k", "v"))).code).toBe("ERR_INTERNAL");
      expect(await readFile(filePath, "utf8")).toBe("{not-valid-json");
    });
  });
});
