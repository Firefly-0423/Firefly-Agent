// 打包并运行 H 检索评测。用法见 README.md。
//   npm run eval:memory-history -- --sizes 60,200 --split dev
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..", "..");
const outfile = path.join(root, "output", "eval-build", "memory-history-eval.cjs");
fs.mkdirSync(path.dirname(outfile), { recursive: true });

await build({
  absWorkingDir: root,
  entryPoints: [path.join(here, "run.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  logLevel: "error",
  alias: { electron: path.join(here, "electron-stub.ts") },
  // 向量库与原生分词器由生产代码在运行时按名字加载，不打进包里。
  external: ["@node-rs/jieba", "@xenova/transformers", "onnxruntime-node", "sharp"],
});

const child = spawnSync(process.execPath, [outfile, ...process.argv.slice(2)], { cwd: root, stdio: "inherit" });
process.exit(child.status ?? 1);
