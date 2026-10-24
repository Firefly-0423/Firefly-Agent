// 校验 @firefly/plugin-sdk 的打包质量，共五项：
//   1. manifest.schema.json 与 PluginManifestInput 类型没有漂移（generate-schema --check）
//   2. 包内 vendored 的 api.ts 与宿主的 src/plugins/api.ts 逐字节一致
//   3. npm pack --dry-run 列出的文件只有 dist、package.json、README.md（以及 LICENSE）
//   4. 产物（d.ts 与 js）里没有指向 src/main、src/renderer 等内部路径的模块引用
//   5. CJS 与 ESM 两种入口都能加载，并导出关键常量
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const sdkRoot = path.join(repoRoot, "packages", "plugin-sdk");

function fail(message) {
  console.error(`[verify-package] ${message}`);
  process.exit(1);
}

// npm 的命令行入口：优先用 npm run 注入的 npm_execpath（跨平台，指向真实的 npm-cli.js，
// Linux CI 上 node 和 npm 不在同一目录）；直接运行本脚本时退回 Windows 安装器的目录布局。
// 一律用 node 去执行这个 js 入口，避免 Windows 上派生 .cmd 的已知问题
const npmEntry = process.env.npm_execpath
  ?? path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");

/** 递归列出目录下的所有文件。 */
async function listFiles(dir) {
  const nested = await Promise.all(
    (await readdir(dir, { withFileTypes: true })).map((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? listFiles(full) : [full];
    }),
  );
  return nested.flat();
}

function checkSchemaInSync() {
  const generator = path.join(repoRoot, "scripts/plugin-sdk/generate-schema.mjs");
  execFileSync(process.execPath, [generator, "--check"], { cwd: repoRoot, stdio: "inherit" });
}

async function checkVendoredApi() {
  const [host, vendored] = await Promise.all([
    readFile(path.join(repoRoot, "src/plugins/api.ts"), "utf8"),
    readFile(path.join(sdkRoot, "src/api.ts"), "utf8"),
  ]);
  if (host !== vendored) {
    fail("packages/plugin-sdk/src/api.ts 与 src/plugins/api.ts 不一致，请运行 npm run build:plugin-sdk");
  }
}

function checkPackedFiles() {
  const listing = execFileSync(process.execPath, [npmEntry, "pack", "--dry-run"], {
    cwd: sdkRoot,
    encoding: "utf8",
  });
  // 每个文件一行："<大小> <路径>"；只看带目录分隔的行，排除汇总信息
  const packed = [...listing.matchAll(/^\s+\S*\s+(\S+)$/gm)].map((m) => m[1]).filter((name) => name.includes("/"));
  const permitted = /^(dist\/|package\.json$|README\.md$|LICENSE$)/;
  const stray = packed.filter((name) => !permitted.test(name.replace(/\\/g, "/")));
  if (stray.length) fail(`npm pack 将包含意外文件: ${stray.join(", ")}`);
}

/** 只匹配 import / require 里的路径，注释里提到这些路径不算违规。 */
const INTERNAL_MODULE_REF = /(from\s+["']|require\(\s*["']|import\(\s*["'])(\.\.\/\.\.\/|src\/(main|renderer|shared|plugins))/;

async function checkNoInternalReferences() {
  const outputs = (await listFiles(path.join(sdkRoot, "dist"))).filter((file) => /\.(d\.ts|js|mjs)$/.test(file));
  for (const file of outputs) {
    if (INTERNAL_MODULE_REF.test(await readFile(file, "utf8"))) {
      fail(`${path.relative(sdkRoot, file)} 引用了内部路径（src/main、src/renderer 等）`);
    }
  }
}

async function checkEntryPoints() {
  const requireFromDist = createRequire(path.join(sdkRoot, "dist/cjs-probe.cjs"));
  const cjsMain = requireFromDist(path.join(sdkRoot, "dist/index.js"));
  const cjsTesting = requireFromDist(path.join(sdkRoot, "dist/testing/index.js"));

  const mainExports = ["CURRENT_PLUGIN_API_VERSION", "PLUGIN_CAPABILITIES", "PLUGIN_HOST_ERROR_CODES", "validateManifestData"];
  for (const name of mainExports) {
    if (!(name in cjsMain)) fail(`CJS 主入口缺少导出: ${name}`);
  }
  const testingExports = ["createMockPluginContext", "assertPluginTool", "assertValidManifest"];
  for (const name of testingExports) {
    if (!(name in cjsTesting)) fail(`CJS testing 入口缺少导出: ${name}`);
  }

  const esmMain = await import(pathToFileURL(path.join(sdkRoot, "dist/esm/index.mjs")).href);
  if (esmMain.CURRENT_PLUGIN_API_VERSION !== cjsMain.CURRENT_PLUGIN_API_VERSION) {
    fail("ESM 与 CJS 主入口的 API 版本常量不一致");
  }
}

checkSchemaInSync();
await checkVendoredApi();
checkPackedFiles();
await checkNoInternalReferences();
await checkEntryPoints();

console.log("[verify-package] plugin-sdk 打包校验全部通过");
