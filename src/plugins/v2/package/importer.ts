import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm } from "node:fs/promises";
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

export interface ImporterFsOps {
  cp: typeof cp;
  lstat: typeof lstat;
  mkdir: typeof mkdir;
  mkdtemp: typeof mkdtemp;
  readdir: typeof readdir;
  realpath: typeof realpath;
  rename: typeof rename;
  rm: typeof rm;
}

const DEFAULT_FS: ImporterFsOps = {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
};

class InstallTargetSafetyError extends Error {
  constructor(readonly code: ManifestError["code"], message: string) {
    super(message);
  }
}

export interface ImportedPackageHandle {
  ok: true;
  manifest: PluginManifestV1;
  installDir: string;
  files: string[];
  sourceKind: "local-folder" | "local-package";
  /** SHA-256 over the staged package: every file's relative path and content digest, in path order. */
  contentSha256: string;
  /**
   * Only present with `deferSwap`: moves the staged files into `installDir` (the previous directory,
   * if any, becomes a backup). Until it runs, `installDir` is untouched and `rollback()` only drops staging.
   */
  swap?: () => Promise<void>;
  commit: () => Promise<void>;
  rollback: () => Promise<void>;
}

export type ImportPackageResult =
  | ImportedPackageHandle
  | { ok: false; errors: ManifestError[] };

function fail(code: ManifestError["code"], message: string, file?: string): ImportPackageResult {
  return { ok: false, errors: [{ code, path: "", message, ...(file ? { file } : {}) }] };
}

function isMissingError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function normalizeForCompare(targetPath: string): string {
  return process.platform === "win32" ? targetPath.toLowerCase() : targetPath;
}

function isStrictlyInside(parent: string, child: string): boolean {
  const normParent = normalizeForCompare(parent);
  const normChild = normalizeForCompare(child);
  return normParent !== normChild && within(normParent, normChild);
}

/**
 * Walks every path segment from the filesystem root down to `targetPath`.
 * Rejects any existing symlink or junction, rejects non-directory segments, and
 * resolves the deepest existing ancestor via `realpath` to compute the canonical path.
 */
async function resolveSafeDirectoryChain(
  targetPath: string,
  fsOps: ImporterFsOps,
  label: string,
): Promise<{ canonical: string; exists: boolean }> {
  const resolved = path.resolve(targetPath);
  const parsedRoot = path.parse(resolved).root;
  const parts = path.relative(parsedRoot, resolved).split(path.sep).filter(Boolean);

  let current = parsedRoot;
  let lastExisting = parsedRoot;
  let missingIndex = -1;

  for (let i = 0; i < parts.length; i += 1) {
    current = path.join(current, parts[i]);
    let info;
    try {
      info = await fsOps.lstat(current);
    } catch (error) {
      if (isMissingError(error)) {
        missingIndex = i;
        break;
      }
      throw error;
    }
    if (info.isSymbolicLink()) {
      throw new InstallTargetSafetyError("symlink_not_allowed", `${label}路径不能包含符号链接或 junction: ${current}`);
    }
    if (!info.isDirectory()) {
      throw new InstallTargetSafetyError("invalid_path", `${label}路径必须是目录: ${current}`);
    }
    lastExisting = current;
  }

  const realExisting = await fsOps.realpath(lastExisting);
  const suffix = missingIndex >= 0 ? parts.slice(missingIndex) : [];
  return {
    canonical: path.join(realExisting, ...suffix),
    exists: missingIndex === -1,
  };
}

async function assertSafeInstallHierarchy(
  pluginsRoot: string,
  pluginIdDir: string,
  fsOps: ImporterFsOps,
  extraDirs: Array<{ path: string; label: string }> = [],
): Promise<{ canonicalPluginsRoot: string; canonicalPluginIdDir: string }> {
  const rootChain = await resolveSafeDirectoryChain(pluginsRoot, fsOps, "插件安装根目录");
  const pluginChain = await resolveSafeDirectoryChain(pluginIdDir, fsOps, "插件目录");
  if (!isStrictlyInside(rootChain.canonical, pluginChain.canonical)) {
    throw new InstallTargetSafetyError("path_traversal", "插件安装路径越界");
  }
  for (const extra of extraDirs) {
    const extraChain = await resolveSafeDirectoryChain(extra.path, fsOps, extra.label);
    if (!isStrictlyInside(pluginChain.canonical, extraChain.canonical)) {
      throw new InstallTargetSafetyError("path_traversal", `${extra.label}路径越界`);
    }
  }
  return {
    canonicalPluginsRoot: rootChain.canonical,
    canonicalPluginIdDir: pluginChain.canonical,
  };
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

async function existsAsFile(filePath: string, fsOps: ImporterFsOps): Promise<boolean> {
  try {
    const info = await fsOps.lstat(filePath);
    return !info.isSymbolicLink() && info.isFile();
  } catch {
    return false;
  }
}

async function resolveExtractedRoot(extractDir: string, fsOps: ImporterFsOps): Promise<{ dir: string; legacyOnly: boolean }> {
  if (await existsAsFile(path.join(extractDir, MANIFEST_FILE_NAME), fsOps)) {
    return { dir: extractDir, legacyOnly: false };
  }
  if (await existsAsFile(path.join(extractDir, LEGACY_MANIFEST_FILE_NAME), fsOps)) {
    return { dir: extractDir, legacyOnly: true };
  }
  const entries = (await fsOps.readdir(extractDir, { withFileTypes: true }))
    .filter((entry) => entry.name !== "__MACOSX");
  if (entries.length === 1 && entries[0].isDirectory()) {
    const nested = path.join(extractDir, entries[0].name);
    const nestedInfo = await fsOps.lstat(nested);
    if (!nestedInfo.isSymbolicLink()) {
      if (await existsAsFile(path.join(nested, MANIFEST_FILE_NAME), fsOps)) {
        return { dir: nested, legacyOnly: false };
      }
      if (await existsAsFile(path.join(nested, LEGACY_MANIFEST_FILE_NAME), fsOps)) {
        return { dir: nested, legacyOnly: true };
      }
    }
  }
  return { dir: extractDir, legacyOnly: false };
}

async function copyValidatedFiles(
  sourceDir: string,
  targetDir: string,
  files: readonly string[],
  fsOps: ImporterFsOps,
): Promise<void> {
  for (const relative of files) {
    const parts = relative.split("/");
    const src = path.join(sourceDir, ...parts);
    const dst = path.join(targetDir, ...parts);
    await fsOps.mkdir(path.dirname(dst), { recursive: true });
    await fsOps.cp(src, dst, { dereference: false, errorOnExist: true });
  }
}

/** Digest of the staged copy (what would be installed), so a confirmation binds to the exact bytes. */
async function hashStagedPackage(stagingDir: string, files: readonly string[]): Promise<string> {
  const hash = createHash("sha256");
  for (const relative of [...files].sort()) {
    const content = await readFile(path.join(stagingDir, ...relative.split("/")));
    hash.update(`${relative}\u0000${createHash("sha256").update(content).digest("hex")};`);
  }
  return hash.digest("hex");
}

async function inspectSourceDir(
  packageDir: string,
  hostVersion: string,
  fsOps: ImporterFsOps,
): Promise<
  | { ok: true; manifest: PluginManifestV1; files: string[] }
  | { ok: false; errors: ManifestError[] }
> {
  if (
    !(await existsAsFile(path.join(packageDir, MANIFEST_FILE_NAME), fsOps))
    && (await existsAsFile(path.join(packageDir, LEGACY_MANIFEST_FILE_NAME), fsOps))
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
    /** Validate and stage only; the caller performs the directory swap through `handle.swap()`. */
    deferSwap?: boolean;
    fs?: Partial<ImporterFsOps>;
  },
): Promise<ImportPackageResult> {
  const fsOps: ImporterFsOps = { ...DEFAULT_FS, ...options.fs };
  const hostVersion = options.hostVersion ?? PLUGIN_HOST_VERSION;
  const resolvedSource = path.resolve(sourcePath);

  let sourceInfo;
  try {
    sourceInfo = await fsOps.lstat(resolvedSource);
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
      extractDir = await fsOps.mkdtemp(path.join(os.tmpdir(), "firefly-plugin-import-"));
      try {
        await extractZip(resolvedSource, { dir: extractDir });
      } catch (error) {
        return { ok: false, errors: [mapZipExtractionError(error)] };
      }
      const resolved = await resolveExtractedRoot(extractDir, fsOps);
      if (resolved.legacyOnly) {
        return fail("legacy_manifest", LEGACY_MANIFEST_MESSAGE);
      }
      packageDir = resolved.dir;
    } else {
      return fail("invalid_path", "插件包必须是本地文件夹、.ffplugin 或 .zip 文件");
    }

    const inspected = await inspectSourceDir(packageDir, hostVersion, fsOps);
    if (!inspected.ok) {
      return inspected;
    }

    const { manifest, files } = inspected;
    const pluginsRoot = path.resolve(options.pluginsRoot);
    const pluginIdDir = path.join(pluginsRoot, manifest.id);
    const targetDir = path.join(pluginIdDir, manifest.version);
    if (!isStrictlyInside(pluginsRoot, pluginIdDir) || !isStrictlyInside(pluginIdDir, targetDir)) {
      return fail("path_traversal", "插件安装路径越界");
    }

    let stagingDir: string | undefined;
    let backupDir: string | undefined;
    let movedTarget = false;
    let stagingCreated = false;
    const deferred = options.deferSwap === true;
    let deferredReturned = false;

    const hierarchy = (...extra: { path: string; label: string }[]) =>
      assertSafeInstallHierarchy(pluginsRoot, pluginIdDir, fsOps, extra);

    const swapIntoPlace = async (): Promise<void> => {
      let targetExistsNow = false;
      try {
        await fsOps.lstat(targetDir);
        targetExistsNow = true;
      } catch (error) {
        if (!isMissingError(error)) throw error;
      }

      if (targetExistsNow) {
        if (options.allowOverwrite === false) {
          throw new InstallTargetSafetyError("invalid_value", `插件 ${manifest.id}@${manifest.version} 已安装`);
        }
        backupDir = path.join(pluginIdDir, `.backup-${randomUUID()}`);
        await hierarchy(
          { path: targetDir, label: "插件目标目录" },
          { path: backupDir, label: "插件备份目录" },
        );
        await fsOps.rename(targetDir, backupDir);
      }

      await hierarchy(
        { path: stagingDir!, label: "插件暂存目录" },
        { path: targetDir, label: "插件目标目录" },
        ...(backupDir ? [{ path: backupDir, label: "插件备份目录" }] : []),
      );
      await fsOps.rename(stagingDir!, targetDir);
      movedTarget = true;
    };

    const restoreBackupIfNotSwapped = async (): Promise<void> => {
      if (!movedTarget && backupDir) {
        await hierarchy(
          { path: targetDir, label: "插件目标目录" },
          { path: backupDir, label: "插件备份目录" },
        )
          .then(() => fsOps.rename(backupDir!, targetDir))
          .catch(() => {});
      }
    };

    const cleanStagingIfNotSwapped = async (): Promise<void> => {
      if (stagingDir && stagingCreated && !movedTarget) {
        await hierarchy({ path: stagingDir, label: "插件暂存目录" })
          .then(() => fsOps.rm(stagingDir!, { recursive: true, force: true }))
          .catch(() => {});
      }
    };


    try {
      await assertSafeInstallHierarchy(pluginsRoot, pluginIdDir, fsOps, [
        { path: targetDir, label: "插件目标目录" },
      ]);

      let targetExists = false;
      try {
        await fsOps.lstat(targetDir);
        targetExists = true;
      } catch (error) {
        if (!isMissingError(error)) throw error;
      }

      if (targetExists && options.allowOverwrite === false) {
        return fail("invalid_value", `插件 ${manifest.id}@${manifest.version} 已安装`);
      }

      await fsOps.mkdir(pluginIdDir, { recursive: true });
      await assertSafeInstallHierarchy(pluginsRoot, pluginIdDir, fsOps, [
        { path: targetDir, label: "插件目标目录" },
      ]);

      stagingDir = path.join(pluginIdDir, `.staging-${randomUUID()}`);
      await fsOps.mkdir(stagingDir, { recursive: true });
      stagingCreated = true;
      await assertSafeInstallHierarchy(pluginsRoot, pluginIdDir, fsOps, [
        { path: stagingDir, label: "插件暂存目录" },
        { path: targetDir, label: "插件目标目录" },
      ]);
      await copyValidatedFiles(packageDir, stagingDir, files, fsOps);
      await assertSafeInstallHierarchy(pluginsRoot, pluginIdDir, fsOps, [
        { path: stagingDir, label: "插件暂存目录" },
        { path: targetDir, label: "插件目标目录" },
      ]);

      const contentSha256 = await hashStagedPackage(stagingDir, files);

      if (!deferred) await swapIntoPlace();

      let settled = false;
      deferredReturned = deferred;
      return {
        ok: true,
        manifest,
        installDir: targetDir,
        files,
        sourceKind,
        contentSha256,
        ...(deferred
          ? {
              async swap() {
                if (settled || movedTarget) return;
                try {
                  await swapIntoPlace();
                } catch (error) {
                  await restoreBackupIfNotSwapped();
                  await cleanStagingIfNotSwapped();
                  throw error;
                }
              },
            }
          : {}),
        async commit() {
          if (settled) return;
          if (deferred && !movedTarget) throw new Error("插件目录尚未切换，不能提交");
          if (backupDir) {
            await assertSafeInstallHierarchy(pluginsRoot, pluginIdDir, fsOps, [
              { path: targetDir, label: "插件目标目录" },
              { path: backupDir, label: "插件备份目录" },
            ]);
            await fsOps.rm(backupDir, { recursive: true, force: true });
          }
          settled = true;
        },
        async rollback() {
          if (settled) return;
          if (deferred && !movedTarget) {
            await cleanStagingIfNotSwapped();
            settled = true;
            return;
          }
          await assertSafeInstallHierarchy(pluginsRoot, pluginIdDir, fsOps, [
            { path: targetDir, label: "插件目标目录" },
            ...(backupDir ? [{ path: backupDir, label: "插件备份目录" }] : []),
          ]);
          await fsOps.rm(targetDir, { recursive: true, force: true });
          if (backupDir) {
            let backupExists = false;
            try {
              await fsOps.lstat(backupDir);
              backupExists = true;
            } catch (error) {
              if (!isMissingError(error)) throw error;
            }
            if (backupExists) {
              await assertSafeInstallHierarchy(pluginsRoot, pluginIdDir, fsOps, [
                { path: targetDir, label: "插件目标目录" },
                { path: backupDir, label: "插件备份目录" },
              ]);
              await fsOps.rename(backupDir, targetDir);
            }
            const restoredInfo = await fsOps.lstat(targetDir);
            if (restoredInfo.isSymbolicLink() || !restoredInfo.isDirectory()) {
              throw new InstallTargetSafetyError("symlink_not_allowed", "回滚后的插件目录无效");
            }
          } else {
            let stillExists = false;
            try {
              await fsOps.lstat(targetDir);
              stillExists = true;
            } catch (error) {
              if (!isMissingError(error)) throw error;
            }
            if (stillExists) {
              throw new Error(`未能移除失败的插件目录: ${targetDir}`);
            }
          }
          settled = true;
        },
      };
    } catch (error) {
      await restoreBackupIfNotSwapped();
      if (error instanceof InstallTargetSafetyError) {
        return fail(error.code, error.message);
      }
      throw error;
    } finally {
      if (!deferredReturned) await cleanStagingIfNotSwapped();
    }
  } finally {
    if (extractDir) {
      await fsOps.rm(extractDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
