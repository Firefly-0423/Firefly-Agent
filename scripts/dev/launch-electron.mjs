// Starts Electron from a source checkout with no setup: `npm run dev` (with --vite) and `npm start`.
// The development profile keeps its data in <repo>/output/development-profile (git-ignored), apart from an
// installed Firefly. An explicit FIREFLY_ISOLATION_ROOT (or the legacy FIREFLY_ISOLATED_SMOKE_APPDATA) still
// wins. The root travels in the environment, like `firefly run`, so no path ever needs command-line quoting.
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_ISOLATION = path.join("output", "development-profile");

/** Arguments and environment for the Electron child; creates the default data folder when it is used. */
export function launchPlan({ repoRoot, env, vite }) {
  const childEnv = { ...env, ...(vite ? { VITE_DEV: "1" } : {}) };
  if (!env.FIREFLY_ISOLATION_ROOT?.trim() && !env.FIREFLY_ISOLATED_SMOKE_APPDATA?.trim()) {
    childEnv.FIREFLY_ISOLATION_ROOT = path.resolve(repoRoot, DEFAULT_ISOLATION);
    fs.mkdirSync(childEnv.FIREFLY_ISOLATION_ROOT, { recursive: true });
  }
  return { args: [".", "--firefly-profile=development"], env: childEnv };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const electron = createRequire(import.meta.url)("electron");
  const plan = launchPlan({ repoRoot, env: process.env, vite: process.argv.includes("--vite") });
  const child = spawn(electron, plan.args, { cwd: repoRoot, env: plan.env, stdio: "inherit", windowsHide: false });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { if (!child.killed) child.kill(signal); });
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  child.on("error", error => { console.error(`[dev] Electron did not start: ${error.message}`); process.exit(1); });
}
