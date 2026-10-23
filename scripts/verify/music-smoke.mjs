#!/usr/bin/env node
// 在 Electron 里运行已编译的音乐冒烟入口，并把退出码原样透传。
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const compiledEntry = path.join(rootDir, "dist", "main", "main", "music", "music-smoke-entry.js");

if (!existsSync(compiledEntry)) {
  console.error(`[music-smoke-runner] compiled entry not found: ${compiledEntry}`);
  console.error("[music-smoke-runner] run 'npm run build:main' first");
  process.exit(1);
}

// electron 包在 Node 里 require 得到的是可执行文件路径
const electronBinary = createRequire(import.meta.url)("electron");

spawn(electronBinary, [compiledEntry], { env: { ...process.env }, stdio: "inherit" })
  .on("exit", (code) => process.exit(code ?? 1));
