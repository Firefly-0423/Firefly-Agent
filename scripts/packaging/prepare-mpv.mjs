// 准备 mpv 二进制（仅 Windows 需要）。
//
// 流程：resources/bin/mpv 下已有可运行的 mpv.exe 就直接复用；否则把 .7z 下载到
// .cache/mpv/，校验 sha256 后用系统自带的 tar（bsdtar，Windows 10 起内置）解压，
// 先解压到临时目录，确认里面有 manifest.binaryPath 再替换正式目录。
//
// 整体套路与 prepare-mingit 相同，区别是解压走 tar，免得再引入 7zip 的 npm 依赖。
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, cp, mkdir, readFile, rename, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// rename 被杀毒软件等短暂占用时，等待这些毫秒数后重试（共 4 次尝试）
const RENAME_BACKOFF_MS = [300, 600, 900, 1200];
const TRANSIENT_RENAME_ERRORS = new Set(["EPERM", "EACCES"]);

export async function sha256File(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function pathExists(target) {
  return access(target).then(() => true, () => false);
}

/** 文件存在且 SHA-256 与期望值一致；读不到文件按不一致处理。 */
async function matchesHash(filePath, expected) {
  try {
    return (await sha256File(filePath)) === expected;
  } catch {
    return false;
  }
}

/** 运行 mpv --version，能正常返回才算可用。 */
async function probeMpv(executable) {
  try {
    await execFileAsync(executable, ["--version"], { windowsHide: true, timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * 用系统 tar 解压 .7z。bsdtar 支持 7z：Windows 10 1803 起自带，macOS 也自带。
 * 解压失败时抛出带提示的错误。
 */
async function extract7z(archive, destination) {
  try {
    await execFileAsync("tar", ["-xf", archive, "-C", destination], {
      windowsHide: true,
      timeout: 60_000,
    });
  } catch (err) {
    throw new Error(`tar 解压失败（${err.message}）。请确认系统 bsdtar 支持 7z；Windows 10 1803+ 自带。`);
  }
}

/**
 * 下载文件。GitHub release 在国内可能直连超时，而 Node 自带的 fetch（undici）
 * 不读系统代理，所以 Windows 改用 PowerShell 的 System.Net.WebClient（会走系统代理），
 * 其他平台改用 curl（读取 HTTPS_PROXY 环境变量）。
 */
async function downloadFile(url, destination) {
  if (process.platform === "win32") {
    const quote = (text) => text.replace(/'/g, "''");
    const script = [
      "$ProgressPreference='SilentlyContinue'",
      "$c=New-Object System.Net.WebClient",
      "$c.Headers.Add('User-Agent','firefly-prepare-mpv')",
      `$c.DownloadFile('${quote(url)}','${quote(destination)}')`,
    ].join("; ");
    try {
      await execFileAsync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
        windowsHide: true,
        timeout: 180_000,
      });
    } catch (err) {
      throw new Error(`WebClient 下载失败：${err.message}`);
    }
    return;
  }

  try {
    await execFileAsync("curl", ["-fsSL", "--max-time", "180", "-o", destination, url], {
      timeout: 200_000,
    });
  } catch (err) {
    throw new Error(`curl 下载失败：${err.message}`);
  }
}

/** 依次尝试主地址和镜像，任何一个成功即返回；全部失败则抛出最后一个错误的信息。 */
async function downloadFromAnySource(manifest, download, destination) {
  const sources = [manifest.url, ...(manifest.mirrors ?? [])];
  let lastFailure;
  for (const source of sources) {
    try {
      await download(source, destination);
      return;
    } catch (err) {
      lastFailure = err;
      console.warn(`[mpv] 下载失败，尝试下一个源：${err.message}`);
    }
  }
  throw new Error(`所有下载源均失败：${lastFailure?.message ?? "unknown"}`);
}

/** 确保缓存里有一份通过 SHA-256 校验的压缩包；先落到 .partial，校验通过再改名。 */
async function ensureVerifiedArchive({ manifest, cacheDir, download }) {
  await mkdir(cacheDir, { recursive: true });
  const archive = path.join(cacheDir, manifest.assetName);
  if (await matchesHash(archive, manifest.sha256)) return archive;

  const partial = `${archive}.partial`;
  await rm(partial, { force: true });
  await downloadFromAnySource(manifest, download, partial);

  const received = await sha256File(partial);
  if (received !== manifest.sha256) {
    await rm(partial, { force: true });
    throw new Error(`mpv SHA-256 mismatch: expected ${manifest.sha256}, received ${received}`);
  }
  await rm(archive, { force: true });
  await rename(partial, archive);
  return archive;
}

/**
 * 把 src 移到 dest。Windows 上 rename 偶尔因杀毒扫描占用报 EPERM/EACCES，
 * 这时按退避时间重试；仍失败就退回"复制后删除源目录"。其他错误直接抛出。
 */
async function moveWithRetry(src, dest) {
  for (const delay of RENAME_BACKOFF_MS) {
    try {
      await rename(src, dest);
      return;
    } catch (err) {
      if (!TRANSIENT_RENAME_ERRORS.has(err.code)) throw err;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  await cp(src, dest, { recursive: true, force: true });
  await rm(src, { recursive: true, force: true });
}

export async function prepareMpv(options) {
  const { manifest, cacheDir, outputDir } = options;
  const probe = options.probe ?? probeMpv;
  const download = options.download ?? downloadFile;
  const unpack = options.extract ?? extract7z;
  const installedBinary = path.join(outputDir, manifest.binaryPath);

  if ((await pathExists(installedBinary)) && (await probe(installedBinary))) return "cached";

  const archive = await ensureVerifiedArchive({ manifest, cacheDir, download });

  const stagingDir = `${outputDir}.tmp-${process.pid}`;
  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });
  try {
    await unpack(archive, stagingDir);
    if (!(await pathExists(path.join(stagingDir, manifest.binaryPath)))) {
      throw new Error(
        `mpv 压缩包内未找到 ${manifest.binaryPath}（请确认 manifest.binaryPath 与压缩包结构一致）`,
      );
    }
    await rm(outputDir, { recursive: true, force: true });
    await mkdir(path.dirname(installedBinary), { recursive: true });
    await moveWithRetry(stagingDir, outputDir);
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true });
    throw error;
  }
  return "prepared";
}

// 只有直接用 node 运行本文件时才执行准备流程
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = JSON.parse(await readFile(path.join(projectRoot, "vendor", "mpv-manifest.json"), "utf8"));
  const outcome = await prepareMpv({
    manifest,
    cacheDir: path.join(projectRoot, ".cache", "mpv"),
    outputDir: path.join(projectRoot, "resources", "bin", "mpv"),
  });
  console.log(`[mpv] ${outcome}: ${manifest.version}`);
}
