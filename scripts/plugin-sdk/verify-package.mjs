// 校验 @firefly_wu/plugin-sdk 的打包质量，共五项：
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
import { npmCliEntry } from "./npm-cli.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const sdkRoot = path.join(repoRoot, "plugin-sdk");

function fail(message) {
  console.error(`[verify-package] ${message}`);
  process.exit(1);
}

// 打包检查一律用真正的 npm（外部插件作者就是这样用的）；pnpm run 下 npm_execpath 指向 pnpm，见 npm-cli.mjs。
// 一律用 node 去执行这个 js 入口，避免 Windows 上派生 .cmd 的已知问题
const npmEntry = npmCliEntry();

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
    fail("plugin-sdk/src/api.ts 与 src/plugins/api.ts 不一致，请运行 npm run build:plugin-sdk");
  }
}

function checkPackedFiles() {
  // 用 --json 读结构化清单：文本输出的文件列表写在 stderr，按 stdout 解析会得到空列表而误判通过。
  const listing = execFileSync(process.execPath, [npmEntry, "pack", "--dry-run", "--json"], {
    cwd: sdkRoot,
    encoding: "utf8",
  });
  const packed = (JSON.parse(listing)[0]?.files ?? []).map((file) => String(file.path).replace(/\\/g, "/"));
  if (!packed.includes("package.json") || !packed.some((name) => name.startsWith("dist/"))) {
    fail(`npm pack 清单缺少 package.json 或 dist/：${JSON.stringify(packed)}`);
  }
  const permitted = /^(dist\/|package\.json$|README\.md$|LICENSE$)/;
  const stray = packed.filter((name) => !permitted.test(name));
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
