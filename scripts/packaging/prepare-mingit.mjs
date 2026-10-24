// 准备随包分发的 MinGit：按 vendor/mingit-manifest.json 下载、校验并解压到 resources/mingit。
// 已解压且 git 能运行时直接复用；下载的压缩包必须通过 SHA-256 校验，
// 解压放在临时目录里完成，确认可用后才替换正式目录。
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { access, mkdir, readFile, rename, rm } from "node:fs/promises";
import { Readable, pipeline as streamPipeline } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import path from "node:path";
import { extractZip } from "../../src/shared/zip-extraction.ts";
import { rejectZipSymlink } from "../../src/shared/zip-entry-policy.ts";

const execFileAsync = promisify(execFile);
const pipeline = promisify(streamPipeline);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const DOWNLOAD_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 3_000;

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

/** 实际运行 git --version，能正常返回才算可用。 */
async function probeGit(gitExe) {
  try {
    await execFileAsync(gitExe, ["--version"], { windowsHide: true, timeout: PROBE_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

async function downloadFile(url, destination) {
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: abortController.signal });
    if (!response.ok || !response.body) {
      throw new Error(`MinGit download failed: ${response.status} ${response.statusText}`);
    }
    await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
  } catch (error) {
    if (abortController.signal.aborted) throw new Error("MinGit download timed out after 120 seconds");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** 确保缓存目录里有一份校验通过的压缩包；先落到 .partial，校验通过再改名。 */
async function ensureVerifiedArchive({ manifest, cacheDir, download }) {
  await mkdir(cacheDir, { recursive: true });
  const archive = path.join(cacheDir, manifest.assetName);
  if (await matchesHash(archive, manifest.sha256)) return archive;

  const partial = `${archive}.partial`;
  await rm(partial, { force: true });
  await download(manifest.url, partial);

  const received = await sha256File(partial);
  if (received !== manifest.sha256) {
    await rm(partial, { force: true });
    throw new Error(`MinGit SHA-256 mismatch: expected ${manifest.sha256}, received ${received}`);
  }
  await rm(archive, { force: true });
  await rename(partial, archive);
  return archive;
}

export async function prepareMinGit(options) {
  const { manifest, cacheDir, outputDir } = options;
  const download = options.download ?? downloadFile;
  const probe = options.probe ?? probeGit;
  const unpack =
    options.extract ??
    ((archive, destination) => extractZip(archive, { dir: destination, onEntry: rejectZipSymlink }));

  const installedGit = path.join(outputDir, "cmd", "git.exe");
  if ((await pathExists(installedGit)) && (await probe(installedGit))) return "cached";

  const archive = await ensureVerifiedArchive({ manifest, cacheDir, download });

  // 先解压到临时目录，验证通过后再替换正式目录，失败时不留下半成品
  const stagingDir = `${outputDir}.tmp-${process.pid}`;
  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });
  try {
    await unpack(archive, stagingDir);
    if (!(await probe(path.join(stagingDir, "cmd", "git.exe")))) {
      throw new Error("MinGit archive does not contain a runnable cmd/git.exe");
    }
    await rm(outputDir, { recursive: true, force: true });
    await rename(stagingDir, outputDir);
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true });
    throw error;
  }
  return "prepared";
}

// 只有直接用 node 运行本文件时才执行准备流程
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = JSON.parse(await readFile(path.join(projectRoot, "vendor", "mingit-manifest.json"), "utf8"));
  const outcome = await prepareMinGit({
    manifest,
    cacheDir: path.join(projectRoot, ".cache", "mingit"),
    outputDir: path.join(projectRoot, "resources", "mingit"),
  });
  console.log(`[MinGit] ${outcome}: ${manifest.version}`);
}
