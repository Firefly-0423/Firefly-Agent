import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { within } from "../../../main/base/identity/runtime-profile";
import {
  LEGACY_MANIFEST_MESSAGE,
  MANIFEST_FILE_NAME,
  type ManifestError,
  type PluginManifestV1,
} from "../../../shared/plugin-manifest";
import { extractZip } from "../../../shared/zip-extraction";
import { inspectPackage } from "./inspect";

export const PLUGIN_HOST_VERSION = "1.2.0";
const LEGACY_MANIFEST_FILE_NAME = "manifest.json";
const ARCHIVE_EXTENSIONS = new Set([".ffplugin", ".zip"]);

export interface ImportedPackageHandle {
  ok: true;
  manifest: PluginManifestV1;
  installDir: string;
  files: string[];
  sourceKind: "local-folder" | "local-package";
  commit: () => Promise<void>;
  rollback: () => Promise<void>;
}

export type ImportPackageResult =
  | ImportedPackageHandle
  | { ok: false; errors: ManifestError[] };

function fail(code: ManifestError["code"], message: string, file?: string): ImportPackageResult {
  return { ok: false, errors: [{ code, path: "", message, ...(file ? { file } : {}) }] };
}

function mapZipExtractionError(error: unknown): ManifestError {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("ZIP_SYMLINK_FORBIDDEN")) {
    return { code: "symlink_not_allowed", path: "", message: "插件包内不允许包含符号链接" };
  }
  if (
    message.includes("ZIP_UNSAFE_PATH")
    || message.includes("ZIP_PATH_LIMIT")
    || /invalid relative path/i.test(message)
  ) {
    return { code: "path_traversal", path: "", message: "插件包内存在不安全的越界路径" };
  }
  return { code: "manifest_json", path: "", message: `无法解压插件包: ${message}` };
}

async function existsAsFile(filePath: string): Promise<boolean> {
  try {
    const info = await lstat(filePath);
    return !info.isSymbolicLink() && info.isFile();
  } catch {
    return false;
  }
}

async function resolveExtractedRoot(extractDir: string): Promise<{ dir: string; legacyOnly: boolean }> {
  if (await existsAsFile(path.join(extractDir, MANIFEST_FILE_NAME))) {
    return { dir: extractDir, legacyOnly: false };
  }
  if (await existsAsFile(path.join(extractDir, LEGACY_MANIFEST_FILE_NAME))) {
    return { dir: extractDir, legacyOnly: true };
  }
  const entries = (await readdir(extractDir, { withFileTypes: true }))
    .filter((entry) => entry.name !== "__MACOSX");
  if (entries.length === 1 && entries[0].isDirectory()) {
    const nested = path.join(extractDir, entries[0].name);
    const nestedInfo = await lstat(nested);
    if (!nestedInfo.isSymbolicLink()) {
      if (await existsAsFile(path.join(nested, MANIFEST_FILE_NAME))) {
        return { dir: nested, legacyOnly: false };
      }
      if (await existsAsFile(path.join(nested, LEGACY_MANIFEST_FILE_NAME))) {
        return { dir: nested, legacyOnly: true };
      }
    }
  }
  return { dir: extractDir, legacyOnly: false };
}

async function copyValidatedFiles(sourceDir: string, targetDir: string, files: readonly string[]): Promise<void> {
  for (const relative of files) {
    const parts = relative.split("/");
    const src = path.join(sourceDir, ...parts);
    const dst = path.join(targetDir, ...parts);
    await mkdir(path.dirname(dst), { recursive: true });
    await cp(src, dst, { dereference: false, errorOnExist: true });
  }
}

async function inspectSourceDir(packageDir: string, hostVersion: string): Promise<
  | { ok: true; manifest: PluginManifestV1; files: string[] }
  | { ok: false; errors: ManifestError[] }
> {
  if (
    !(await existsAsFile(path.join(packageDir, MANIFEST_FILE_NAME)))
    && (await existsAsFile(path.join(packageDir, LEGACY_MANIFEST_FILE_NAME)))
  ) {
    return { ok: false, errors: [{ code: "legacy_manifest", path: "", message: LEGACY_MANIFEST_MESSAGE }] };
  }
  const inspected = await inspectPackage(packageDir, { hostVersion });
  if (!inspected.ok) return { ok: false, errors: inspected.errors };
  return { ok: true, manifest: inspected.manifest, files: inspected.files };
}

/**
 * Validates and copies a 1.2.0 plugin package (local folder, `.ffplugin`, or `.zip`)
 * into `<pluginsRoot>/<id>/<version>/`.
 *
 * Validation runs entirely on the source directory or an OS temp extraction directory
 * before creating any directory or file under `pluginsRoot`.
 */
export async function importPluginPackage(
  sourcePath: string,
  options: {
    pluginsRoot: string;
    hostVersion?: string;
    allowOverwrite?: boolean;
  },
): Promise<ImportPackageResult> {
  const hostVersion = options.hostVersion ?? PLUGIN_HOST_VERSION;
  const resolvedSource = path.resolve(sourcePath);

  let sourceInfo;
  try {
    sourceInfo = await lstat(resolvedSource);
  } catch {
    return fail("manifest_missing", `插件路径不存在: ${sourcePath}`);
  }
  if (sourceInfo.isSymbolicLink()) {
    return fail("symlink_not_allowed", "插件包路径不能是符号链接");
  }

  let sourceKind: "local-folder" | "local-package";
  let extractDir: string | undefined;
  let packageDir: string;

  try {
    if (sourceInfo.isDirectory()) {
      sourceKind = "local-folder";
      packageDir = resolvedSource;
    } else if (sourceInfo.isFile()) {
      const ext = path.extname(resolvedSource).toLowerCase();
      if (!ARCHIVE_EXTENSIONS.has(ext)) {
        return fail("invalid_path", "仅支持本地文件夹、.ffplugin 或 .zip 插件包");
      }
      sourceKind = "local-package";
      extractDir = await mkdtemp(path.join(os.tmpdir(), "firefly-plugin-import-"));
      try {
        await extractZip(resolvedSource, { dir: extractDir });
      } catch (error) {
        return { ok: false, errors: [mapZipExtractionError(error)] };
      }
      const resolved = await resolveExtractedRoot(extractDir);
      if (resolved.legacyOnly) {
        return fail("legacy_manifest", LEGACY_MANIFEST_MESSAGE);
      }
      packageDir = resolved.dir;
    } else {
      return fail("invalid_path", "插件包必须是本地文件夹、.ffplugin 或 .zip 文件");
    }

    const inspected = await inspectSourceDir(packageDir, hostVersion);
    if (!inspected.ok) {
      return inspected;
    }

    const { manifest, files } = inspected;
    const pluginsRoot = path.resolve(options.pluginsRoot);
    const pluginIdDir = path.join(pluginsRoot, manifest.id);
    const targetDir = path.join(pluginIdDir, manifest.version);
    if (!within(pluginsRoot, pluginIdDir) || !within(pluginIdDir, targetDir)) {
      return fail("path_traversal", "插件安装路径越界");
    }

    await mkdir(pluginIdDir, { recursive: true });
    const stagingDir = path.join(pluginIdDir, `.staging-${randomUUID()}`);
    let backupDir: string | undefined;
    let movedTarget = false;

    try {
      await mkdir(stagingDir, { recursive: true });
      await copyValidatedFiles(packageDir, stagingDir, files);

      let targetExists = false;
      try {
        await lstat(targetDir);
        targetExists = true;
      } catch {
        targetExists = false;
      }

      if (targetExists) {
        if (options.allowOverwrite === false) {
          return fail("invalid_value", `插件 ${manifest.id}@${manifest.version} 已安装`);
        }
        backupDir = path.join(pluginIdDir, `.backup-${randomUUID()}`);
        await rename(targetDir, backupDir);
      }

      await rename(stagingDir, targetDir);
      movedTarget = true;

      let settled = false;
      return {
        ok: true,
        manifest,
        installDir: targetDir,
        files,
        sourceKind,
        async commit() {
          if (settled) return;
          settled = true;
          if (backupDir) {
            await rm(backupDir, { recursive: true, force: true });
          }
        },
        async rollback() {
          if (settled) return;
          settled = true;
          await rm(targetDir, { recursive: true, force: true });
          if (backupDir) {
            await rename(backupDir, targetDir);
          }
        },
      };
    } catch (error) {
      if (!movedTarget) {
        await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
        if (backupDir) {
          await rename(backupDir, targetDir).catch(() => {});
        }
      }
      throw error;
    }
  } finally {
    if (extractDir) {
      await rm(extractDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
