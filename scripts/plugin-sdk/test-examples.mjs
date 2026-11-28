// 1.2.0 示例插件的端到端验证：模拟"仓库之外的空项目"，使用打包后的 @firefly_wu/plugin-sdk 验证并打包两个示例，再用 createTestHost 冒烟测试。
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { npmCliEntry } from "./npm-cli.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const sdkRoot = path.join(repoRoot, "plugin-sdk");
const examplesRoot = path.join(sdkRoot, "examples");
const EXAMPLE_IDS = ["dev.firefly.weather", "dev.firefly.reminder"];

const npmEntry = npmCliEntry();

function fail(message) {
  console.error(`[test-examples] ${message}`);
  process.exit(1);
}

function runNode(script, scriptArgs, spawnOptions = {}) {
  execFileSync(process.execPath, [script, ...scriptArgs], { stdio: "inherit", ...spawnOptions });
}

function packSdk() {
  runNode(path.join(repoRoot, "scripts/plugin-sdk/build-sdk.mjs"), []);
  const output = execFileSync(process.execPath, [npmEntry, "pack"], { cwd: sdkRoot, encoding: "utf8" });
  const fileName = output.trim().split("\n").at(-1)?.trim();
  if (!fileName?.endsWith(".tgz")) fail("npm pack 未返回 tarball 文件名");
  return path.join(sdkRoot, fileName);
}

const tarball = packSdk();
const projectDir = await mkdtemp(path.join(tmpdir(), "firefly-plugin-examples-"));

try {
  await writeFile(
    path.join(projectDir, "package.json"),
    JSON.stringify({ name: "plugin-example-e2e", private: true }, null, 2),
  );

  // 安装打包后的 SDK tarball，验证外部插件项目的真实导入路径
  runNode(npmEntry, ["install", "--no-save", "--no-audit", "--no-fund", tarball], { cwd: projectDir });

  const cliBin = path.join(projectDir, "node_modules", "@firefly_wu", "plugin-sdk", "dist", "cli", "firefly-plugin.mjs");
  const packagesDir = path.join(projectDir, "packages");
  const sourcesDir = path.join(projectDir, "examples");
  await mkdir(packagesDir, { recursive: true });

  for (const id of EXAMPLE_IDS) {
    const dest = path.join(sourcesDir, id);
    await cp(path.join(examplesRoot, id), dest, {
      recursive: true,
      filter: (file) => !file.endsWith(".test.ts"),
    });
    runNode(cliBin, ["validate", dest], { cwd: projectDir });
    runNode(cliBin, ["pack", dest, "-o", path.join(packagesDir, `${id}.ffplugin`)], { cwd: projectDir });
  }

  const smokeScript = path.join(projectDir, "smoke.mjs");
  await writeFile(smokeScript, await readFile(path.join(repoRoot, "scripts/plugin-sdk/smoke-examples.mjs")));
  runNode(smokeScript, [sourcesDir, packagesDir], { cwd: projectDir });

  console.log("[test-examples] 两个 1.2.0 示例插件校验、打包与冒烟测试全部通过");
} finally {
  await rm(projectDir, { recursive: true, force: true });
  await rm(tarball, { force: true });
}
