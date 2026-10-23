import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { lstat, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { extractZip as extract } from "../shared/zip-extraction";
import { inspectPluginDir } from "./loader";
import type { PluginManifest } from "./types";

const MIB = 1024 * 1024;

export const PLUGIN_ZIP_LIMITS = {
  entries: 2_000,
  compressionRatio: 200,
  archiveBytes: 50 * MIB,
  entryBytes: 50 * MIB,
  expandedBytes: 200 * MIB,
} as const;

/** 已解压并校验通过、等待提交的插件包。 */
export type PreparedPluginZip = {
  manifest: PluginManifest;
  pluginDir: string;
  stagingDir: string;
};

/**
 * 宿主安装记录的保留文件名。市场安装来源记录存放在宿主管理的
 * plugin-install-metadata 目录里，插件包内不得出现同名文件，
 * 以免插件包伪造来源信息。
 */
const HOST_METADATA_RESERVED_NAME = "firefly-market.json";

/** 市场安装来源记录（由宿主持久化，和插件目录分开存放）。 */
export type PluginHostMetadata = {
  installedAt: string;
  installedVersion: string;
  registryId: string;
  origin: "market";
};

const hostMetadataPath = (userPluginRoot: string, pluginId: string): string =>
  path.join(path.dirname(userPluginRoot), "plugin-install-metadata", `${pluginId}.json`);

export async function writeHostMetadata(userPluginRoot: string, pluginId: string, metadata: PluginHostMetadata): Promise<void> {
  const target = hostMetadataPath(userPluginRoot, pluginId);
  const body = JSON.stringify(metadata, null, 2);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${body}\n`, "utf8");
}

/** 读取市场安装来源记录；文件缺失或损坏时返回 undefined，按本地插件处理。 */
export function readHostMetadataSync(userPluginRoot: string, pluginId: string): PluginHostMetadata | undefined {
  try {
    const saved = JSON.parse(
      readFileSync(hostMetadataPath(userPluginRoot, pluginId), "utf8"),
    ) as Partial<PluginHostMetadata>;
    if (saved.origin !== "market" || typeof saved.installedVersion !== "string") return undefined;

    const textOrEmpty = (value: unknown): string => (typeof value === "string" ? value : "");
    return {
      origin: "market",
      registryId: textOrEmpty(saved.registryId),
      installedVersion: saved.installedVersion,
      installedAt: textOrEmpty(saved.installedAt),
    };
  } catch {
    return undefined;
  }
}

export const removeHostMetadata = (userPluginRoot: string, pluginId: string): Promise<void> =>
  rm(hostMetadataPath(userPluginRoot, pluginId), { force: true });

/** 校验 ZIP 条目名并返回用于去重的规范化名称（小写、无尾部斜杠）。 */
function validateEntryName(fileName: string): string {
  if (!fileName || fileName.includes("\0")) throw new Error("ZIP 包含空文件名或 NUL 字符");

  const slashed = fileName.replace(/\\/g, "/");
  if (slashed.startsWith("/") || /^[a-zA-Z]:/.test(slashed)) {
    throw new Error(`ZIP 包含绝对路径: ${fileName}`);
  }

  const parts = slashed.split("/").filter(Boolean);
  if (parts.some((p) => p === "." || p === ".." || p.includes(":"))) {
    throw new Error(`ZIP 包含不安全路径: ${fileName}`);
  }
  const unsupportedOnWindows = (p: string): boolean =>
    /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p);
  if (parts.some(unsupportedOnWindows)) {
    throw new Error(`ZIP 包含 Windows 不支持的路径: ${fileName}`);
  }
  return slashed.replace(/\/+$/, "").toLowerCase();
}

/** 递归确认解压结果里只有普通文件和目录。 */
async function assertNoLinks(root: string): Promise<void> {
  const children = await readdir(root, { withFileTypes: true });
  for (const child of children) {
    const target = path.join(root, child.name);
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw new Error(`ZIP 不允许包含符号链接: ${child.name}`);
    if (info.isDirectory()) {
      await assertNoLinks(target);
      continue;
    }
    if (!info.isFile()) throw new Error(`ZIP 包含不支持的文件类型: ${child.name}`);
  }
}

/** manifest.json 要么在根目录，要么在唯一的顶层目录里。 */
async function locatePluginDirectory(stagingDir: string): Promise<string> {
  if (existsSync(path.join(stagingDir, "manifest.json"))) return stagingDir;

  const top = (await readdir(stagingDir, { withFileTypes: true })).filter((e) => e.name !== "__MACOSX");
  if (top.length !== 1 || !top[0].isDirectory()) {
    throw new Error("ZIP 必须在根目录或唯一的顶层目录中包含 manifest.json");
  }
  return path.join(stagingDir, top[0].name);
}

export type PreparePluginZipOptions = {
  /**
   * 期望的插件身份（市场安装时传入）。解出的 manifest 必须与之完全一致，
   * 防止下载到的插件包与市场登记条目不符。
   */
  expectedIdentity?: { id: string; version: string };
};

export async function preparePluginZip(zipPath: string, userPluginRoot: string, opts: PreparePluginZipOptions = {}): Promise<PreparedPluginZip> {
  if (path.extname(zipPath).toLowerCase() !== ".zip") throw new Error("只能导入 .zip 插件包");
  const archive = await stat(zipPath);
  if (!archive.isFile()) throw new Error("所选路径不是普通 ZIP 文件");
  if (archive.size > PLUGIN_ZIP_LIMITS.archiveBytes) throw new Error("ZIP 文件超过 50 MiB 限制");

  await mkdir(userPluginRoot, { recursive: true });
  const stagingBase = path.join(path.dirname(userPluginRoot), "plugin-install-staging");
  await mkdir(stagingBase, { recursive: true });
  const stagingDir = path.join(stagingBase, randomUUID());

  let seenEntries = 0;
  let totalBytes = 0;
  const seenNames = new Set<string>();

  try {
    await extract(zipPath, {
      dir: stagingDir,
      onEntry(entry) {
        const name = validateEntryName(entry.fileName);
        if (seenNames.has(name)) throw new Error(`ZIP 包含重复或大小写冲突路径: ${entry.fileName}`);
        if ((name.split("/").pop() ?? "") === HOST_METADATA_RESERVED_NAME) {
          throw new Error(`ZIP 不允许包含宿主保留文件: ${entry.fileName}`);
        }
        seenNames.add(name);

        seenEntries += 1;
        if (seenEntries > PLUGIN_ZIP_LIMITS.entries) throw new Error("ZIP 文件条目超过 2000 项限制");
        if ((entry.generalPurposeBitFlag & 1) !== 0) throw new Error("不支持加密 ZIP");

        // 高 16 位是 Unix 权限位，0xa000 表示符号链接
        const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
        if ((unixMode & 0xf000) === 0xa000) throw new Error(`ZIP 不允许包含符号链接: ${entry.fileName}`);

        const { uncompressedSize, compressedSize } = entry;
        if (uncompressedSize > PLUGIN_ZIP_LIMITS.entryBytes) {
          throw new Error(`ZIP 单文件解压后超过 50 MiB: ${entry.fileName}`);
        }
        totalBytes += uncompressedSize;
        if (totalBytes > PLUGIN_ZIP_LIMITS.expandedBytes) throw new Error("ZIP 解压总量超过 200 MiB 限制");

        const suspiciousRatio = compressedSize === 0
          || uncompressedSize / compressedSize > PLUGIN_ZIP_LIMITS.compressionRatio;
        if (uncompressedSize > 1024 * 1024 && suspiciousRatio) {
          throw new Error(`ZIP 条目压缩比异常: ${entry.fileName}`);
        }
      },
    });

    await assertNoLinks(stagingDir);
    const pluginDir = await locatePluginDirectory(stagingDir);
    const inspected = inspectPluginDir(pluginDir);
    if (!inspected.manifest) throw new Error(inspected.error ?? "插件 manifest 校验失败");

    const { manifest } = inspected;
    const want = opts.expectedIdentity;
    if (want && (manifest.id !== want.id || manifest.version !== want.version)) {
      throw new Error(
        `插件包与市场登记信息不符: 期望 ${want.id}@${want.version}，`
        + `实际 ${manifest.id}@${manifest.version}`,
      );
    }
    return { stagingDir, pluginDir, manifest };
  } catch (error) {
    // 校验失败时不留下半成品暂存目录
    await rm(stagingDir, { force: true, recursive: true });
    throw error;
  }
}

export const discardPreparedPlugin = (prepared: PreparedPluginZip): Promise<void> =>
  rm(prepared.stagingDir, { recursive: true, force: true });

export type CommitPreparedPluginOptions = {
  /** 市场安装时传入：目录提交前先写来源记录，提交失败则一并回滚清除。 */
  marketOrigin?: { registryId: string };
};

export async function commitPreparedPlugin(
  prepared: PreparedPluginZip, userPluginRoot: string, replace: boolean, opts: CommitPreparedPluginOptions = {},
): Promise<string> {
  const pluginId = prepared.manifest.id;
  const destination = path.join(userPluginRoot, pluginId);
  const backupRoot = path.join(path.dirname(userPluginRoot), "plugin-install-backups");
  const backup = path.join(backupRoot, `${pluginId}-${randomUUID()}`);
  const hadExisting = existsSync(destination);
  if (hadExisting && !replace) throw new Error(`插件已存在: ${pluginId}`);

  let movedToBackup = false;
  // 替换时先留存旧来源记录，提交失败要原样恢复，免得旧插件丢了市场身份
  const priorMetadata = opts.marketOrigin ? readHostMetadataSync(userPluginRoot, pluginId) : undefined;

  try {
    if (opts.marketOrigin) {
      const { registryId } = opts.marketOrigin;
      await writeHostMetadata(userPluginRoot, pluginId, {
        origin: "market",
        registryId,
        installedVersion: prepared.manifest.version,
        installedAt: new Date().toISOString(),
      });
    }
    if (hadExisting) {
      await mkdir(backupRoot, { recursive: true });
      await rename(destination, backup);
      movedToBackup = true;
    }
    await rename(prepared.pluginDir, destination);
  } catch (error) {
    if (movedToBackup && !existsSync(destination)) await rename(backup, destination);
    if (opts.marketOrigin) {
      if (priorMetadata) await writeHostMetadata(userPluginRoot, pluginId, priorMetadata);
      else await removeHostMetadata(userPluginRoot, pluginId);
    }
    throw error;
  } finally {
    await rm(prepared.stagingDir, { recursive: true, force: true });
  }

  if (movedToBackup) {
    try {
      await rm(backup, { recursive: true, force: true });
    } catch (error) {
      console.warn(`[plugins] 已安装 ${pluginId}，但旧版本备份清理失败:`, error);
    }
  }
  return destination;
}
