// 示例插件的端到端验证：模拟"仓库之外的空项目"，只用打包后的 SDK 编译并冒烟测试三个示例。
// 流程：构建 SDK → npm pack → 在临时空项目里安装 tarball → 用 tsc 编译三个示例 →
//       拼出可安装目录（manifest.json + index.cjs）→ 用 Mock Context 做冒烟注册与契约断言
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const sdkRoot = path.join(repoRoot, "plugin-sdk");
const examplesRoot = path.join(repoRoot, "examples");
const EXAMPLE_IDS = ["weather-tool", "long-term-memory", "scheduled-automation"];

// npm 的命令行入口：优先用 npm run 注入的 npm_execpath（跨平台，指向真实的 npm-cli.js，
// Linux CI 上 node 和 npm 不在同一目录）；直接运行本脚本时退回 Windows 安装器的目录布局
const npmEntry = process.env.npm_execpath
  ?? path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
const tscEntry = path.join(repoRoot, "node_modules", "typescript", "bin", "tsc");

function fail(message) {
  console.error(`[test-examples] ${message}`);
  process.exit(1);
}

/** 用当前 node 运行一个 js 入口，输出直通终端。 */
function runNode(script, scriptArgs, spawnOptions = {}) {
  execFileSync(process.execPath, [script, ...scriptArgs], { stdio: "inherit", ...spawnOptions });
}

/** 构建 SDK 并 npm pack，返回 tarball 的绝对路径（保证 tarball 来自当前源码）。 */
function packSdk() {
  runNode(path.join(repoRoot, "scripts/plugin-sdk/build-sdk.mjs"), []);
  const output = execFileSync(process.execPath, [npmEntry, "pack"], { cwd: sdkRoot, encoding: "utf8" });
  const fileName = output.trim().split("\n").at(-1)?.trim();
  if (!fileName?.endsWith(".tgz")) fail("npm pack 未返回 tarball 文件名");
  return path.join(sdkRoot, fileName);
}

/** 把示例源码（manifest、tsconfig、index.ts）复制进临时项目，跳过编译产物和 zip。 */
async function copyExampleSources(projectDir) {
  for (const id of EXAMPLE_IDS) {
    await cp(path.join(examplesRoot, id), path.join(projectDir, "examples", id), {
      recursive: true,
      filter: (file) => !file.includes(`${path.sep}dist`) && !file.endsWith(".zip"),
    });
  }
}

/** 拼出可安装的插件目录：编译出的 index.js 改名为 index.cjs，再配上原 manifest.json。 */
async function assembleInstallDir(projectDir) {
  const installDir = path.join(projectDir, "install");
  for (const id of EXAMPLE_IDS) {
    const target = path.join(installDir, id);
    await cp(path.join(projectDir, "examples", id, "dist", "index.js"), path.join(target, "index.cjs"));
    await cp(path.join(examplesRoot, id, "manifest.json"), path.join(target, "manifest.json"));
  }
  return installDir;
}

const tarball = packSdk();
const projectDir = await mkdtemp(path.join(tmpdir(), "firefly-plugin-examples-"));

try {
  await writeFile(
    path.join(projectDir, "package.json"),
    JSON.stringify({ name: "plugin-example-e2e", private: true }, null, 2),
  );

  // 安装打包后的 SDK（它依赖的 ajv 由 npm 从 registry 或缓存解析）
  runNode(npmEntry, ["install", "--no-save", "--no-audit", "--no-fund", tarball], { cwd: projectDir });

  await copyExampleSources(projectDir);
  for (const id of EXAMPLE_IDS) {
    runNode(tscEntry, ["-p", path.join(projectDir, "examples", id, "tsconfig.json")]);
  }
  const installDir = await assembleInstallDir(projectDir);

  // 冒烟脚本复制进临时项目再运行，这样它 require 到的是刚安装的 SDK
  const smokeScript = path.join(projectDir, "smoke.mjs");
  await writeFile(smokeScript, await readFile(path.join(repoRoot, "scripts/plugin-sdk/smoke-examples.mjs")));
  runNode(smokeScript, [installDir], { cwd: projectDir });

  console.log("[test-examples] 三个示例编译与冒烟测试全部通过");
} finally {
  await rm(projectDir, { recursive: true, force: true });
  await rm(tarball, { force: true });
}
