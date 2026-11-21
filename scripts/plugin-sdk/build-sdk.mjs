// 构建 @firefly_wu/plugin-sdk，分四步：
//   1. 同步 LICENSE
//   2. 用 tsc 生成 .d.ts 类型声明到 dist/，并内联协议声明文件
//   3. 用 esbuild 输出 CJS（dist/）与 ESM（dist/esm/），内联 src/shared/plugin-protocol.ts
//   4. 用 esbuild 把 firefly-plugin 命令行（源码在 src/plugins/v2/cli，复用 src/shared/plugin-manifest 的校验器）
//      打成单文件 dist/cli/firefly-plugin.mjs，并复制清单 JSON Schema 到 dist/
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";

const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const sdkRoot = path.join(repoRoot, "plugin-sdk");
const distRoot = path.join(sdkRoot, "dist");

async function syncFromHost(hostRelative, sdkRelative) {
  await cp(path.join(repoRoot, hostRelative), path.join(sdkRoot, sdkRelative));
}

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? listFiles(full) : [full];
    }),
  );
  return nested.flat();
}

/** 生成自包含的 .d.ts：以仓库根编译声明到临时目录，再把协议声明收拢到 dist/plugin-protocol.d.ts。 */
async function buildDeclarations() {
  const tscEntry = path.join(repoRoot, "node_modules", "typescript", "bin", "tsc");
  const tmpOut = path.join(distRoot, ".dts-tmp");
  execFileSync(
    process.execPath,
    [
      tscEntry,
      "-p",
      path.join(sdkRoot, "tsconfig.json"),
      "--declaration",
      "--emitDeclarationOnly",
      "--rootDir",
      repoRoot,
      "--outDir",
      tmpOut,
    ],
    { cwd: repoRoot, stdio: "inherit" },
  );

  const emittedSdkDir = path.join(tmpOut, "plugin-sdk", "src");
  const emittedFiles = (await listFiles(emittedSdkDir)).filter((file) => file.endsWith(".d.ts"));
  for (const file of emittedFiles) {
    const rel = path.relative(emittedSdkDir, file);
    const dest = path.join(distRoot, rel);
    await mkdir(path.dirname(dest), { recursive: true });
    const content = (await readFile(file, "utf8")).replaceAll(
      '"../../src/shared/plugin-protocol"',
      '"./plugin-protocol"',
    );
    await writeFile(dest, content, "utf8");
  }

  await cp(
    path.join(tmpOut, "src", "shared", "plugin-protocol.d.ts"),
    path.join(distRoot, "plugin-protocol.d.ts"),
  );
  await rm(tmpOut, { recursive: true, force: true });
}

/** CJS 与 ESM：主入口与 testing 入口各打一个包，内联协议代码，保留 external 依赖（如 ajv）。 */
async function bundleEntries() {
  const bundles = [
    { entry: "src/index.ts", cjs: "dist/index.js", esm: "dist/esm/index.mjs" },
    { entry: "src/testing/index.ts", cjs: "dist/testing/index.js", esm: "dist/esm/testing/index.mjs" },
  ];
  for (const { entry, cjs, esm } of bundles) {
    const common = {
      entryPoints: [path.join(sdkRoot, entry)],
      target: "node18",
      platform: "node",
      bundle: true,
      packages: "external",
    };
    await build({ ...common, format: "cjs", outfile: path.join(sdkRoot, cjs) });
    await build({ ...common, format: "esm", outfile: path.join(sdkRoot, esm) });
  }
}

/**
 * 命令行的源码在宿主仓库里（要复用 src/shared/plugin-manifest 的校验器），而 SDK 包不直接引用内部源码目录。
 * 用 esbuild 把校验器和 jszip 内联成单文件，发布的包不新增运行时依赖，也不出现指向 src/ 的模块引用。
 */
async function bundleCli() {
  await build({
    entryPoints: [path.join(repoRoot, "src/plugins/v2/cli/bin.ts")],
    outfile: path.join(sdkRoot, "dist/cli/firefly-plugin.mjs"),
    format: "esm",
    target: "node18",
    platform: "node",
    bundle: true,
    banner: {
      js: [
        "#!/usr/bin/env node",
        'import { createRequire as __createRequire } from "node:module";',
        "const require = __createRequire(import.meta.url);",
      ].join("\n"),
    },
  });
  await cp(
    path.join(repoRoot, "src/shared/plugin-manifest/manifest.schema.json"),
    path.join(sdkRoot, "dist/firefly.plugin.schema.json"),
  );
}

await syncFromHost("LICENSE", "LICENSE");
await rm(distRoot, { recursive: true, force: true });
await buildDeclarations();
await bundleEntries();
await bundleCli();

console.log("plugin-sdk 构建完成");
