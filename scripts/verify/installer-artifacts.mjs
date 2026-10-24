// 安装包产物校验：在 electron-builder --win nsis 构建完成之后运行，
// 确认 NSIS 安装器、自动更新元数据和随包资源都齐全。
// 检查的目录是 electron-builder.yml 里 directories.output 指定的输出目录（默认 release/）：
//   1. Firefly_Agent-Setup-<version>.exe 存在，并且体积不会小得离谱
//   2. latest.yml 的 version 与 package.json 一致，path 指向同一个安装器，并带有 sha512
//   3. win-unpacked/resources 里有截图程序、QQ Music 桥接脚本、MinGit 与 Skills 目录
// 用法：node scripts/verify/installer-artifacts.mjs [--expect-version x.y.z]
//   --expect-version：打标签构建时传入标签版本，用来核对"产物版本与标签一致"
import { access, readdir, readFile, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { verifyScreenshotHelper } from "./screenshot-helper.mjs";

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// 体积低于这个值的安装器一定缺了资源（光 Electron 本体和 MinGit 就远超它）
const INSTALLER_MIN_SIZE = 20 * 1024 * 1024;
const EXPECTED_VENDOR_SKILLS = 50;
const EXPECTED_OWN_SKILLS = 4;

const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
const readYaml = async (file) => parseYaml(await readFile(file, "utf8"));

/** 两个目录名列表在忽略顺序的前提下是否完全相同。 */
function sameNames(actual, expected) {
  return JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
}

/** 路径是否存在；只有"不存在"算 false，其他访问错误照常抛出。 */
async function exists(target) {
  try {
    await access(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

/** 第 3 步中的 Skills 部分：分发目录与项目自带目录都要与 skills-manifest.json 对得上。 */
async function checkSkills(resourcesDir, unpackedDir) {
  const distDir = path.join(resourcesDir, "firefly-skills");
  const ownDir = path.join(unpackedDir, "skills");
  const manifest = await readJson(path.join(distDir, "skills-manifest.json"));
  const vendorNames = await readdir(path.join(distDir, "skills"));
  const ownNames = await readdir(ownDir);

  const countsOk =
    manifest.skills.length === EXPECTED_VENDOR_SKILLS && manifest.selfSkills.length === EXPECTED_OWN_SKILLS;
  if (!countsOk || !sameNames(vendorNames, manifest.skills) || !sameNames(ownNames, manifest.selfSkills)) {
    throw new Error("Skills distribution does not contain the expected 50+4 directories");
  }

  for (const id of manifest.skills) await stat(path.join(distDir, "skills", id, "SKILL.md"));
  for (const id of manifest.selfSkills) await stat(path.join(ownDir, id, "SKILL.md"));

  // 旧版的 Skills ZIP 已经退役，不应再出现在打包资源里
  if (await exists(path.join(distDir, "skills-snapshot.zip"))) {
    throw new Error("Retired Skills ZIP remains in packaged resources");
  }
}

export async function verifyInstallerArtifacts(options = {}) {
  const { expectVersion } = options;

  const { version } = await readJson(path.join(rootDir, "package.json"));
  const builderConfig = await readYaml(path.join(rootDir, "electron-builder.yml"));
  const outputDir = path.join(rootDir, builderConfig.directories?.output ?? "release");
  const installerName = (builderConfig.nsis?.artifactName ?? "Firefly_Agent-Setup-${version}.${ext}")
    .replace("${version}", version)
    .replace("${ext}", "exe");

  if (expectVersion && expectVersion !== version) {
    throw new Error(`标签版本 ${expectVersion} 与 package.json 版本 ${version} 不一致`);
  }

  // 第 1 步：安装器本体
  const installerPath = path.join(outputDir, installerName);
  const { size: installerSize } = await stat(installerPath);
  if (installerSize <= INSTALLER_MIN_SIZE) {
    throw new Error(`安装器体积异常（${installerSize} bytes）：${installerPath}`);
  }

  // 第 2 步：更新元数据。electron-updater 靠它下载更新，
  // 这里不校验，等于放过更新链路上的回归
  const latest = await readYaml(path.join(outputDir, "latest.yml"));
  if (latest.version !== version) {
    throw new Error(`latest.yml 版本 ${latest.version} 与 package.json 版本 ${version} 不一致`);
  }
  if (latest.path !== installerName) {
    throw new Error(`latest.yml path ${latest.path} 与安装器文件名 ${installerName} 不一致`);
  }
  if (typeof latest.sha512 !== "string" || latest.sha512 === "") {
    throw new Error("latest.yml 缺少 sha512 校验值");
  }

  // 第 3 步：win-unpacked 里的随包资源（内容与安装器一致，不必真的安装一遍）
  const unpackedDir = path.join(outputDir, "win-unpacked");
  const resourcesDir = path.join(unpackedDir, "resources");
  const screenshotHelper = await verifyScreenshotHelper(path.join(resourcesDir, "bin", "firefly-screenshot.exe"));
  await stat(path.join(resourcesDir, "music", "qqmusic_gsmtc.ps1"));

  // MinGit 的 cmd/git.exe 只是个几十 KB 的启动器，真正的程序在 mingw64/bin/，
  // 所以不按体积判断，而是实际运行 --version（与 prepare-mingit 的判定方式一致）
  const gitLauncher = path.join(resourcesDir, "mingit", "cmd", "git.exe");
  await stat(gitLauncher);
  const { stdout } = await execFileAsync(gitLauncher, ["--version"], { windowsHide: true, timeout: 10_000 });

  await checkSkills(resourcesDir, unpackedDir);

  return {
    installerPath,
    installerSize,
    version,
    gitVersion: stdout.trim(),
    screenshotSize: screenshotHelper.size,
  };
}

/** 从命令行参数里取 --expect-version 后面紧跟的那个值。 */
function readExpectedVersion(argv) {
  const flagAt = argv.indexOf("--expect-version");
  return flagAt === -1 ? undefined : argv[flagAt + 1];
}

// 只有直接用 node 运行本文件时才执行校验
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const summary = await verifyInstallerArtifacts({ expectVersion: readExpectedVersion(process.argv) });
    console.log(
      `[installer] verified ${summary.installerPath} (${summary.installerSize} bytes) — v${summary.version}`,
    );
    console.log("[installer] QQ Music bridge: present");
    console.log(`[installer] mingit: ${summary.gitVersion}`);
    console.log(`[installer] screenshot helper: ${summary.screenshotSize} bytes`);
  } catch (error) {
    console.error(`[installer] verification failed: ${error.message}`);
    process.exitCode = 1;
  }
}
