// 构建 @firefly_wu/plugin-sdk，分三步：
//   1. 把 src/plugins 下的 api.ts 与 manifest.schema.json 原样同步进 SDK 源码（公开契约只有这一份来源）
//   2. 用 tsc 输出 CJS 和类型声明到 dist/
//   3. 用 esbuild 输出 ESM 到 dist/esm/
//   4. 用 esbuild 把 firefly-plugin 命令行（源码在 src/plugins/v2/cli，复用 src/shared/plugin-manifest 的校验器）
//      打成单文件 dist/cli/firefly-plugin.mjs，并复制清单 JSON Schema 到 dist/
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

/**
 * 命令行的源码在宿主仓库里（要复用 src/shared/plugin-manifest 的校验器），而 SDK 的 tsconfig 把 rootDir 限在 plugin-sdk/src，
 * 不能直接 import 进来。所以不走 tsc，而是用 esbuild 打包：校验器和 jszip 一起内联成一个文件，
 * 发布的包不新增运行时依赖，也不出现指向 src/ 的模块引用。
 */
async function bundleCli() {
  await build({
    entryPoints: [path.join(repoRoot, "src/plugins/v2/cli/bin.ts")],
    outfile: path.join(sdkRoot, "dist/cli/firefly-plugin.mjs"),
    format: "esm",
    target: "node18",
    platform: "node",
    bundle: true,
    // jszip 等 CommonJS 依赖在 ESM 产物里需要一个 require
    banner: {
      js: [
        "#!/usr/bin/env node",
        'import { createRequire as __createRequire } from "node:module";',
        "const require = __createRequire(import.meta.url);",
      ].join("\n"),
    },
  });
  await cp(path.join(repoRoot, "src/shared/plugin-manifest/manifest.schema.json"), path.join(sdkRoot, "dist/firefly.plugin.schema.json"));
}

await syncFromHost("LICENSE", "LICENSE");
await syncFromHost("src/plugins/api.ts", "src/api.ts");
await syncFromHost("src/plugins/manifest.schema.json", "src/manifest.schema.json");

await rm(path.join(sdkRoot, "dist"), { recursive: true, force: true });
compileWithTsc();
await bundleEsm();
await bundleCli();

console.log("plugin-sdk 构建完成");
