import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyHistoryHelpers } from "../verify/history-helpers.mjs";

const defaultRepoRoot = fileURLToPath(new URL("../../", import.meta.url));

export async function buildHistoryHelpers({
  repoRoot = defaultRepoRoot,
  platform = process.platform,
  run = spawnSync,
} = {}) {
  if (platform !== "win32") {
    throw new Error(`History helper build requires Windows (current platform: ${platform}); native helpers were not built`);
  }
  const targetDir = path.join(repoRoot, "native", "target");
  // Cargo target overrides or a broken runner must not make old .exe files look freshly built.
  for (const name of ["firefly-history-read.exe", "firefly-history-presence.exe"])
    await rm(path.join(targetDir, "release", name), { force: true });
  const result = run("cargo", [
    "build", "--release", "--locked", "--manifest-path", "native/Cargo.toml",
    "--features", "history-read", "--bin", "firefly-history-read", "--bin", "firefly-history-presence",
  ], {
    cwd: repoRoot,
    shell: false,
    stdio: "inherit",
    // Match electron-builder's resource source even when the caller overrides Cargo's target directory.
    env: { ...process.env, CARGO_TARGET_DIR: targetDir },
  });
  if (result.error) throw new Error(`failed to launch Cargo: ${result.error.message}`, { cause: result.error });
  if (result.status !== 0) throw new Error(`Cargo history helper build failed (${result.signal ?? result.status ?? "unknown exit"})`);
  return verifyHistoryHelpers(path.join(targetDir, "release"));
}

const isDirectRun = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  buildHistoryHelpers().then(helpers => {
    for (const helper of helpers)
      console.log(`[history-helpers] built and verified ${helper.helperPath} (${helper.size} bytes)`);
  }).catch(error => {
    console.error(`[history-helpers] build failed: ${error.message}`);
    process.exitCode = 1;
  });
}
