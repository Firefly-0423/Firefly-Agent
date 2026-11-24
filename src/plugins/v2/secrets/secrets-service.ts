import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { PluginError } from "./errors";
import {
  assertSafePluginSecretsPaths,
  assertValidPluginId,
  assertValidSecretKey,
  resolveDefaultDataRoot,
  resolvePluginSecretsDir,
  resolvePluginSecretsFile,
  SECRET_KEY_PATTERN,
} from "./paths";

/**
 * Minimal Electron `safeStorage` contract injected for encryption/decryption.
 */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
  getSelectedStorageBackend?(): string;
}

export interface ScopedPluginSecrets {
  set(key: string, value: string): Promise<void>;
  get(key: string): Promise<string | null>;
  delete(key: string): Promise<boolean>;
  keys(): Promise<string[]>;
}

export interface PluginSecretsService {
  get(pluginId: string, key: string): Promise<string | null>;
  set(pluginId: string, key: string, value: string): Promise<void>;
  delete(pluginId: string, key: string): Promise<boolean>;
  list(pluginId: string): Promise<string[]>;
  deleteAll(pluginId: string): Promise<boolean>;
  forPlugin(pluginId: string): ScopedPluginSecrets;
}

export interface PluginSecretsServiceOptions {
  /**
   * Electron `safeStorage` implementation or test double.
   * When omitted, incomplete, or reporting unavailable, operations fail closed with `ERR_UNAVAILABLE`.
   */
  safeStorage?: SafeStorageLike | null;
  /**
   * Firefly data root (typically `StorageContext.dataRoot`).
   * Defaults to `getStorageContext().dataRoot` via `resolveDefaultDataRoot`.
   */
  dataRoot?: string | (() => string);
}

interface StoredEncryptedSecret {
  readonly $safeStorage: 1;
  readonly ciphertext: string;
}

interface StoredPluginSecretsFile {
  readonly version: 1;
  readonly entries: Record<string, StoredEncryptedSecret>;
}

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isMissingFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function assertSafeStorageAvailable(storage: SafeStorageLike | null | undefined): asserts storage is SafeStorageLike {
  if (
    !storage ||
    typeof storage.isEncryptionAvailable !== "function" ||
    typeof storage.encryptString !== "function" ||
    typeof storage.decryptString !== "function"
  ) {
    throw new PluginError("ERR_UNAVAILABLE", "System safeStorage is unavailable");
  }

  let available = false;
  try {
    available = storage.isEncryptionAvailable() === true;
    if (available && process.platform === "linux" && typeof storage.getSelectedStorageBackend === "function") {
      available = storage.getSelectedStorageBackend() !== "basic_text";
    }
  } catch {
    available = false;
  }

  if (!available) {
    throw new PluginError("ERR_UNAVAILABLE", "System safeStorage encryption is unavailable");
  }
}

function parseSecretsFile(raw: string): Map<string, StoredEncryptedSecret> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new PluginError("ERR_INTERNAL", "Plugin secrets store contains invalid JSON", { cause: error });
  }

  if (!isPlainObject(parsed) || parsed.version !== 1 || !isPlainObject(parsed.entries)) {
    throw new PluginError("ERR_INTERNAL", "Plugin secrets store has unsupported schema");
  }

  const entries = new Map<string, StoredEncryptedSecret>();
  for (const [key, item] of Object.entries(parsed.entries)) {
    if (!SECRET_KEY_PATTERN.test(key) || key.includes("..")) {
      throw new PluginError("ERR_INTERNAL", "Plugin secrets store contains invalid key");
    }
    if (!isPlainObject(item) || item.$safeStorage !== 1 || typeof item.ciphertext !== "string" || !BASE64_PATTERN.test(item.ciphertext)) {
      throw new PluginError("ERR_INTERNAL", "Plugin secrets store contains invalid encrypted entry");
    }
    entries.set(key, { $safeStorage: 1, ciphertext: item.ciphertext });
  }
  return entries;
}

async function readSecretsMap(targetFile: string): Promise<{ exists: boolean; entries: Map<string, StoredEncryptedSecret> }> {
  let raw: string;
  try {
    raw = await fs.readFile(targetFile, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return { exists: false, entries: new Map() };
    }
    throw new PluginError("ERR_INTERNAL", "Failed to read plugin secrets store", { cause: error });
  }
  return { exists: true, entries: parseSecretsFile(raw) };
}

async function writeSecretsMap(
  dataRoot: string,
  secretsDir: string,
  targetFile: string,
  entries: Map<string, StoredEncryptedSecret>,
): Promise<void> {
  const sortedEntries = Object.fromEntries(
    [...entries.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  const document: StoredPluginSecretsFile = {
    version: 1,
    entries: sortedEntries,
  };
  const payload = `${JSON.stringify(document, null, 2)}\n`;

  try {
    await fs.mkdir(secretsDir, { recursive: true });
  } catch (error) {
    throw new PluginError("ERR_INTERNAL", "Failed to create plugin secrets directory", { cause: error });
  }
  await assertSafePluginSecretsPaths(dataRoot, secretsDir, targetFile);

  const stagingFile = path.join(secretsDir, `.${path.basename(targetFile)}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(stagingFile, payload, { encoding: "utf8", flag: "wx", mode: 0o600, flush: true });
    await fs.rename(stagingFile, targetFile);
  } catch (error) {
    if (error instanceof PluginError) {
      throw error;
    }
    throw new PluginError("ERR_INTERNAL", "Failed to write plugin secrets store", { cause: error });
  } finally {
    try {
      await fs.unlink(stagingFile);
    } catch (cleanupError) {
      if (!isMissingFileError(cleanupError)) {
        // Best-effort temp cleanup; never mask original error.
      }
    }
  }
}

interface SealedSecret {
  readonly v: 1;
  readonly pluginId: string;
  readonly key: string;
  readonly value: string;
}

/** The plaintext that gets encrypted: the value bound to its owner and name, so a copied file or entry is refused. */
function sealSecret(pluginId: string, key: string, value: string): string {
  const sealed: SealedSecret = { v: 1, pluginId, key, value };
  return JSON.stringify(sealed);
}

function openSealedSecret(plaintext: string, pluginId: string, key: string): string {
  let sealed: unknown;
  try {
    sealed = JSON.parse(plaintext);
  } catch {
    throw new PluginError("ERR_INTERNAL", "Plugin secret payload is malformed");
  }
  if (!isPlainObject(sealed) || sealed.v !== 1 || typeof sealed.value !== "string") {
    throw new PluginError("ERR_INTERNAL", "Plugin secret payload is malformed");
  }
  if (sealed.pluginId !== pluginId || sealed.key !== key) {
    throw new PluginError("ERR_PERMISSION", "Plugin secret does not belong to this plugin and key");
  }
  return sealed.value;
}

/**
 * Lazily resolves Electron's `safeStorage` for production host wiring.
 */
export function resolveElectronSafeStorage(): SafeStorageLike | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require("electron") as { safeStorage?: SafeStorageLike };
    const candidate = electron?.safeStorage;
    if (
      candidate &&
      typeof candidate.isEncryptionAvailable === "function" &&
      typeof candidate.encryptString === "function" &&
      typeof candidate.decryptString === "function"
    ) {
      return candidate;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Creates the Firefly 1.2.0 host-side plugin secrets service.
 *
 * Secrets are stored per plugin under `<dataRoot>/plugin-secrets/<pluginId>.json`
 * with every value encrypted via injected `safeStorage`. When `safeStorage` is
 * missing or unavailable, operations fail closed with `ERR_UNAVAILABLE` and never
 * fall back to plaintext or write bytes to disk.
 */
export function createPluginSecretsService(options: PluginSecretsServiceOptions = {}): PluginSecretsService {
  const storage = options.safeStorage;
  const resolveRoot = (): string => {
    try {
      const root = typeof options.dataRoot === "function"
        ? options.dataRoot()
        : options.dataRoot ?? resolveDefaultDataRoot();
      if (typeof root !== "string" || root.trim() === "") {
        throw new Error("Empty dataRoot");
      }
      return path.resolve(root);
    } catch (error) {
      if (error instanceof PluginError) {
        throw error;
      }
      throw new PluginError("ERR_UNAVAILABLE", "Plugin secrets data directory is unavailable", { cause: error });
    }
  };

  // Serialize per-plugin mutations/reads so concurrent operations on one <id>.json never clobber each other.
  const pluginLocks = new Map<string, Promise<void>>();
  async function withPluginLock<T>(pluginId: string, task: () => Promise<T>): Promise<T> {
    const previous = pluginLocks.get(pluginId) ?? Promise.resolve();
    const run = previous.then(task);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    pluginLocks.set(pluginId, tail);
    try {
      return await run;
    } finally {
      if (pluginLocks.get(pluginId) === tail) {
        pluginLocks.delete(pluginId);
      }
    }
  }

  async function resolveCheckedPaths(pluginId: string): Promise<{ dataRoot: string; secretsDir: string; targetFile: string }> {
    const dataRoot = resolveRoot();
    const secretsDir = resolvePluginSecretsDir(dataRoot);
    const targetFile = resolvePluginSecretsFile(pluginId, dataRoot);
    await assertSafePluginSecretsPaths(dataRoot, secretsDir, targetFile);
    return { dataRoot, secretsDir, targetFile };
  }

  const service: PluginSecretsService = {
    async get(pluginId, key) {
      assertValidPluginId(pluginId);
      assertValidSecretKey(key);
      assertSafeStorageAvailable(storage);

      return withPluginLock(pluginId, async () => {
        assertSafeStorageAvailable(storage);
        const { targetFile } = await resolveCheckedPaths(pluginId);
        const { exists, entries } = await readSecretsMap(targetFile);
        if (!exists) {
          return null;
        }
        const entry = entries.get(key);
        if (!entry) {
          return null;
        }
        let decrypted: unknown;
        try {
          decrypted = storage.decryptString(Buffer.from(entry.ciphertext, "base64"));
        } catch (error) {
          throw new PluginError("ERR_INTERNAL", "Failed to decrypt plugin secret", { cause: error });
        }
        if (typeof decrypted !== "string") {
          throw new PluginError("ERR_INTERNAL", "Failed to decrypt plugin secret");
        }
        return openSealedSecret(decrypted, pluginId, key);
      });
    },

    async set(pluginId, key, value) {
      assertValidPluginId(pluginId);
      assertValidSecretKey(key);
      if (typeof value !== "string") {
        throw new PluginError("ERR_INVALID_ARGUMENT", "Secret value must be a string");
      }
      assertSafeStorageAvailable(storage);

      return withPluginLock(pluginId, async () => {
        assertSafeStorageAvailable(storage);
        const { dataRoot, secretsDir, targetFile } = await resolveCheckedPaths(pluginId);

        let encrypted: unknown;
        try {
          encrypted = storage.encryptString(sealSecret(pluginId, key, value));
        } catch (error) {
          throw new PluginError("ERR_INTERNAL", "Failed to encrypt plugin secret", { cause: error });
        }
        if (!Buffer.isBuffer(encrypted) && !(encrypted instanceof Uint8Array)) {
          throw new PluginError("ERR_INTERNAL", "Encryptor returned invalid ciphertext");
        }
        const ciphertext = Buffer.from(encrypted).toString("base64");

        const { entries } = await readSecretsMap(targetFile);
        entries.set(key, { $safeStorage: 1, ciphertext });
        await writeSecretsMap(dataRoot, secretsDir, targetFile, entries);
      });
    },

    async delete(pluginId, key) {
      assertValidPluginId(pluginId);
      assertValidSecretKey(key);
      assertSafeStorageAvailable(storage);

      return withPluginLock(pluginId, async () => {
        assertSafeStorageAvailable(storage);
        const { dataRoot, secretsDir, targetFile } = await resolveCheckedPaths(pluginId);
        const { exists, entries } = await readSecretsMap(targetFile);
        if (!exists || !entries.has(key)) {
          return false;
        }
        entries.delete(key);
        if (entries.size === 0) {
          try {
            await fs.unlink(targetFile);
            return true;
          } catch (error) {
            if (isMissingFileError(error)) {
              return false;
            }
            throw new PluginError("ERR_INTERNAL", "Failed to remove empty plugin secrets store", { cause: error });
          }
        }
        await writeSecretsMap(dataRoot, secretsDir, targetFile, entries);
        return true;
      });
    },

    async list(pluginId) {
      assertValidPluginId(pluginId);
      assertSafeStorageAvailable(storage);

      return withPluginLock(pluginId, async () => {
        assertSafeStorageAvailable(storage);
        const { targetFile } = await resolveCheckedPaths(pluginId);
        const { exists, entries } = await readSecretsMap(targetFile);
        if (!exists) {
          return [];
        }
        return [...entries.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      });
    },

    async deleteAll(pluginId) {
      assertValidPluginId(pluginId);

      return withPluginLock(pluginId, async () => {
        const { targetFile } = await resolveCheckedPaths(pluginId);
        try {
          await fs.unlink(targetFile);
          return true;
        } catch (error) {
          if (isMissingFileError(error)) {
            return false;
          }
          throw new PluginError("ERR_INTERNAL", "Failed to delete plugin secrets store", { cause: error });
        }
      });
    },

    forPlugin(pluginId) {
      return {
        set: (key, value) => service.set(pluginId, key, value),
        get: (key) => service.get(pluginId, key),
        delete: (key) => service.delete(pluginId, key),
        keys: () => service.list(pluginId),
      };
    },
  };

  return service;
}
