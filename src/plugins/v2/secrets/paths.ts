import * as fs from "node:fs/promises";
import path from "node:path";
import { canonicalPath, within } from "../../../main/base/identity/runtime-profile";
import { getStorageContext } from "../../../main/base/storage/storage-context";
import { PluginError } from "./errors";

export const PLUGIN_SECRETS_DIRECTORY_NAME = "plugin-secrets";

/** Spec §4 rule 2: reverse-domain plugin ID, 6-64 characters. */
export const PLUGIN_ID_PATTERN = /^[a-z0-9]+(\.[a-z0-9-]+){2,}$/;
export const PLUGIN_ID_MIN_LENGTH = 6;
export const PLUGIN_ID_MAX_LENGTH = 64;

/** Secret key format: starts with alphanumeric, allows '.', '_', '-' up to 64 chars, no '..'. */
export const SECRET_KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export function assertValidPluginId(pluginId: unknown): asserts pluginId is string {
  if (
    typeof pluginId !== "string" ||
    pluginId.length < PLUGIN_ID_MIN_LENGTH ||
    pluginId.length > PLUGIN_ID_MAX_LENGTH ||
    !PLUGIN_ID_PATTERN.test(pluginId)
  ) {
    throw new PluginError("ERR_INVALID_ARGUMENT", "Invalid pluginId format");
  }
}

export function assertValidSecretKey(key: unknown): asserts key is string {
  if (typeof key !== "string" || !SECRET_KEY_PATTERN.test(key) || key.includes("..")) {
    throw new PluginError("ERR_INVALID_ARGUMENT", "Invalid secret key format");
  }
}

export function resolveDefaultDataRoot(): string {
  return getStorageContext().dataRoot;
}

export function resolvePluginSecretsDir(dataRoot: string = resolveDefaultDataRoot()): string {
  if (typeof dataRoot !== "string" || dataRoot.trim() === "") {
    throw new PluginError("ERR_UNAVAILABLE", "Plugin secrets data root is unavailable");
  }
  return path.join(path.resolve(dataRoot), PLUGIN_SECRETS_DIRECTORY_NAME);
}

export function resolvePluginSecretsFile(pluginId: string, dataRoot?: string): string {
  assertValidPluginId(pluginId);
  const secretsDir = resolvePluginSecretsDir(dataRoot);
  const targetFile = path.join(secretsDir, `${pluginId}.json`);
  if (!within(secretsDir, targetFile) || path.dirname(targetFile) !== secretsDir) {
    throw new PluginError("ERR_INVALID_ARGUMENT", "Plugin secrets path escapes boundary");
  }
  return targetFile;
}

async function lstatIfExists(targetPath: string) {
  try {
    return await fs.lstat(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw new PluginError("ERR_INTERNAL", "Failed to inspect plugin secrets path");
  }
}

/**
 * Verifies that `secretsDir` and `targetFile` stay inside `dataRoot` both lexically
 * and canonically, and rejects symlinks at the secrets directory or plugin file.
 */
export async function assertSafePluginSecretsPaths(
  dataRoot: string,
  secretsDir: string,
  targetFile: string,
): Promise<void> {
  const resolvedRoot = path.resolve(dataRoot);
  const resolvedDir = path.resolve(secretsDir);
  const resolvedFile = path.resolve(targetFile);

  if (!within(resolvedRoot, resolvedDir) || !within(resolvedDir, resolvedFile) || path.dirname(resolvedFile) !== resolvedDir) {
    throw new PluginError("ERR_INVALID_ARGUMENT", "Plugin secrets path escapes boundary");
  }

  const dirStat = await lstatIfExists(resolvedDir);
  if (dirStat) {
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
      throw new PluginError("ERR_INTERNAL", "Plugin secrets directory is invalid or a symlink");
    }
  }

  const fileStat = await lstatIfExists(resolvedFile);
  if (fileStat) {
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
      throw new PluginError("ERR_INTERNAL", "Plugin secrets file is invalid or a symlink");
    }
  }

  let canonicalRoot: string;
  let canonicalDir: string;
  let canonicalFile: string;
  try {
    canonicalRoot = canonicalPath(resolvedRoot);
    canonicalDir = canonicalPath(resolvedDir);
    canonicalFile = canonicalPath(resolvedFile);
  } catch {
    throw new PluginError("ERR_INTERNAL", "Failed to resolve canonical plugin secrets path");
  }

  if (!within(canonicalRoot, canonicalDir) || !within(canonicalDir, canonicalFile)) {
    throw new PluginError("ERR_INTERNAL", "Plugin secrets canonical path escapes boundary");
  }
}
