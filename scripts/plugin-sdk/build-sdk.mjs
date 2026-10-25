// 构建 @firefly/plugin-sdk，分三步：
//   1. 把 src/plugins 下的 api.ts 与 manifest.schema.json 原样同步进 SDK 源码（公开契约只有这一份来源）
//   2. 用 tsc 输出 CJS 和类型声明到 dist/
//   3. 用 esbuild 输出 ESM 到 dist/esm/
import { cp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";

const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const sdkRoot = path.join(repoRoot, "plugin-sdk");

/** 把宿主里的文件原样复制到 SDK 里；verify-package.mjs 要求它与宿主文件逐字节一致，因此不能做任何加工。 */
async function syncFromHost(hostRelative, sdkRelative) {
  await cp(path.join(repoRoot, hostRelative), path.join(sdkRoot, sdkRelative));
}

/** CJS 与类型声明：直接用 node 驱动仓库内 typescript 的 js 入口，避开 Windows 上派生 .cmd 的跨平台问题。 */
function compileWithTsc() {
  const tscEntry = path.join(repoRoot, "node_modules", "typescript", "bin", "tsc");
  execFileSync(process.execPath, [tscEntry, "-p", path.join(sdkRoot, "tsconfig.json")], {
    cwd: repoRoot,
    stdio: "inherit",
  });
}

/** ESM：主入口与 testing 入口各打一个包。JSON Schema 会被内联，运行时唯一的外部依赖只剩 ajv。 */
async function bundleEsm() {
  const bundles = [
    { entry: "src/index.ts", outfile: "dist/esm/index.mjs" },
    { entry: "src/testing/index.ts", outfile: "dist/esm/testing/index.mjs" },
  ];
  for (const { entry, outfile } of bundles) {
    await build({
      entryPoints: [path.join(sdkRoot, entry)],
      outfile: path.join(sdkRoot, outfile),
      format: "esm",
      target: "node18",
      platform: "node",
      bundle: true,
      packages: "external",
    });
  }
}

await syncFromHost("LICENSE", "LICENSE");
await syncFromHost("src/plugins/api.ts", "src/api.ts");
await syncFromHost("src/plugins/manifest.schema.json", "src/manifest.schema.json");

await rm(path.join(sdkRoot, "dist"), { recursive: true, force: true });
compileWithTsc();
await bundleEsm();

console.log("plugin-sdk 构建完成");
