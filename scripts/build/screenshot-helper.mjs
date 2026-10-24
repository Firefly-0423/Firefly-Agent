// 编译原生截图程序（native/ 下的 Rust 工程），把产物放进 resources/bin 并做完整性校验。
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { verifyScreenshotHelper } from "../verify/screenshot-helper.mjs";

const rootDir = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const HELPER_EXE = "firefly-screenshot.exe";

const cargoManifest = path.join(rootDir, "native", "Cargo.toml");
const compiledExe = path.join(rootDir, "native", "target", "release", HELPER_EXE);
const stagedExe = path.join(rootDir, "resources", "bin", HELPER_EXE);

/** 以 release 模式并锁定依赖编译；失败时直接结束进程，沿用 Cargo 的退出码。 */
function compileWithCargo() {
  const run = spawnSync(
    "cargo",
    ["build", "--release", "--locked", "--manifest-path", cargoManifest],
    { cwd: rootDir, shell: false, stdio: "inherit" },
  );
  if (run.error) {
    console.error(`[screenshot-helper] failed to launch Cargo: ${run.error.message}`);
    process.exit(1);
  }
  if (run.status !== 0) process.exit(run.status ?? 1);
}

compileWithCargo();

await mkdir(path.dirname(stagedExe), { recursive: true });
await copyFile(compiledExe, stagedExe);

const { helperPath, size } = await verifyScreenshotHelper(stagedExe);
console.log(`[screenshot-helper] staged ${helperPath} (${size} bytes)`);
