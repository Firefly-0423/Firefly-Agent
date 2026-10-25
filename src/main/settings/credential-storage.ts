import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { safeStorage } from "electron";
import { logger, LogTag } from "../logging/logger";

export const MODEL_CREDENTIAL_FIELDS = new Set(["apiKey"]);
export const GENERAL_CREDENTIAL_FIELDS = new Set([
  "amapKey", "searchBochaKey", "searchTavilyKey", "searchMinimaxKey", "searchAnySearchKey",
  "emailSmtpUser", "emailSmtpPass", "asrMosslandKey", "ttsMosslandKey",
  "asrAliyunAppKey", "asrAliyunAccessKeyId", "asrAliyunAccessKeySecret",
]);

function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
      && !(process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text");
  } catch { return false; }
}

function mapCredentials(value: unknown, fields: ReadonlySet<string>, map: (secret: unknown) => unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => mapCredentials(item, fields, map));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key, fields.has(key) ? map(item) : mapCredentials(item, fields, map),
  ]));
}

/** Decode before normalization: an unavailable/corrupt encrypted value must never become an empty secret. */
export function decodeCredentials<T>(value: T, fields: ReadonlySet<string>): T {
  return mapCredentials(value, fields, (secret) => {
    if (!secret || typeof secret !== "object") return secret;
    const encrypted = secret as { $safeStorage?: unknown; ciphertext?: unknown };
    if (encrypted.$safeStorage !== 1 || typeof encrypted.ciphertext !== "string"
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encrypted.ciphertext)
      || !encrypted.ciphertext || !encryptionAvailable()) {
      throw new Error("CREDENTIAL_STORAGE_UNREADABLE");
    }
    try { return safeStorage.decryptString(Buffer.from(encrypted.ciphertext, "base64")); }
    catch { throw new Error("CREDENTIAL_STORAGE_UNREADABLE"); }
  }) as T;
}

function encodeCredentials(value: unknown, fields: ReadonlySet<string>): unknown {
  const available = encryptionAvailable();
  let plaintext = false;
  const encoded = mapCredentials(value, fields, (secret) => {
    if (typeof secret !== "string" || !secret) return secret;
    if (!available) { plaintext = true; return secret; }
    try { return { $safeStorage: 1, ciphertext: safeStorage.encryptString(secret).toString("base64") }; }
    catch { throw new Error("CREDENTIAL_STORAGE_ENCRYPT_FAILED"); }
  });
  if (plaintext) logger.warn(LogTag.Runtime, "CREDENTIAL_STORAGE_PLAINTEXT: safeStorage unavailable; reusable credentials remain plaintext");
  return encoded;
}

function atomicWrite(file: string, value: unknown): void {
  const contents = JSON.stringify(value, null, 2);
  const staging = `${file}.${randomUUID()}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(staging, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(staging, file);
  } finally {
    try { fs.unlinkSync(staging); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.warn(LogTag.Runtime, "CREDENTIAL_STORAGE_TEMP_CLEANUP_FAILED");
      }
    }
  }
}

/** Never downgrade or overwrite a file whose existing credentials cannot be decrypted. */
export function writeCredentials(file: string, value: unknown, fields: ReadonlySet<string>): void {
  try { decodeCredentials(JSON.parse(fs.readFileSync(file, "utf8")), fields); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  atomicWrite(file, encodeCredentials(value, fields));
}

/** Best-effort migration preserves the original bytes on failure and keeps unknown legacy fields. */
export function migrateCredentials(file: string, original: string, decoded: unknown, fields: ReadonlySet<string>): void {
  let hasPlaintext = false;
  mapCredentials(JSON.parse(original), fields, (secret) => {
    if (typeof secret === "string" && secret) hasPlaintext = true;
    return secret;
  });
  if (!hasPlaintext) return;
  if (!encryptionAvailable()) {
    logger.warn(LogTag.Runtime, "CREDENTIAL_STORAGE_PLAINTEXT: safeStorage unavailable; reusable credentials remain plaintext");
    return;
  }
  try {
    const encrypted = encodeCredentials(decoded, fields);
    // An async reader (WeChat) must not migrate an obsolete snapshot over a newer login.
    if (fs.readFileSync(file, "utf8") === original) atomicWrite(file, encrypted);
  } catch {
    logger.warn(LogTag.Runtime, "CREDENTIAL_STORAGE_MIGRATION_FAILED: original credentials retained; migration will retry on next load");
  }
}

/** Keep the renderer's existing field types and configured/not-configured checks. */
export function maskCredentials<T>(value: T, fields: ReadonlySet<string>): T {
  return mapCredentials(value, fields, (secret) => typeof secret === "string" && secret ? "********" : secret) as T;
}
