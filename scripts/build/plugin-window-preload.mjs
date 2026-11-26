/**
 * 把 src/preload/plugin-window.ts 打成自包含的单文件预加载脚本。
 *
 * 插件窗口使用 sandbox: true，沙箱预加载只能 require("electron") 等内置模块，
 * 不能 require 本地文件；tsc 的 CommonJS 输出会保留 "../shared/ipc-channels"，
 * 所以 build:preload 在 tsc 之后用本脚本覆盖 dist/preload/preload/plugin-window.js。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const rootDir = fileURLToPath(new URL("../../", import.meta.url));

export async function buildPluginWindowPreload({
  outfile = path.join(rootDir, "dist/preload/preload/plugin-window.js"),
} = {}) {
  await build({
    entryPoints: [path.join(rootDir, "src/preload/plugin-window.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    external: ["electron"],
    logLevel: "warning",
  });
  return outfile;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildPluginWindowPreload()
    .then(file => console.log(`[plugin-window-preload] bundled ${file}`))
    .catch(error => { console.error(`[plugin-window-preload] ${error.message}`); process.exitCode = 1; });
}
