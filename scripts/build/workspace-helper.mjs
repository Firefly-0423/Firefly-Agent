import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyWorkspaceHelper } from "../verify/workspace-helper.mjs";
const defaultRepoRoot = fileURLToPath(new URL("../../", import.meta.url));
export async function buildWorkspaceHelper({ repoRoot = defaultRepoRoot, platform = process.platform, run = spawnSync } = {}) {
  if (platform !== "win32") throw new Error(`Workspace helper build requires Windows (current platform: ${platform})`);
  const targetDir = path.join(repoRoot, "native", "target");
  await rm(path.join(targetDir, "release", "firefly-workspace.exe"), { force: true });
  const result = run("cargo", ["build", "--release", "--locked", "--manifest-path", "native/Cargo.toml",
    "--features", "workspace-handle", "--bin", "firefly-workspace"], {
    cwd: repoRoot, shell: false, stdio: "inherit", env: { ...process.env, CARGO_TARGET_DIR: targetDir },
  });
  if (result.error) throw new Error(`Workspace Cargo launch failed: ${result.error.message}`, { cause: result.error });
  if (result.status !== 0) throw new Error(`Workspace Cargo build failed (${result.signal ?? result.status ?? "unknown exit"})`);
  return verifyWorkspaceHelper(path.join(targetDir, "release"));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildWorkspaceHelper().then(result => console.log(`[workspace-helper] built and verified ${result.helperPath} (${result.size} bytes)`))
    .catch(error => { console.error(`[workspace-helper] ${error.message}`); process.exitCode = 1; });
}
