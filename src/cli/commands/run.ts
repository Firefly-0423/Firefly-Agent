/**
 * firefly run: launch Electron from the current directory.
 *
 * Development compatibility command. Requires a project root with a
 * runnable package.json; installed applications use their executable.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { errLine } from "../util/log.js";
import { resolveElectron } from "../util/resolve-electron.js";

export type RunResult =
  | { kind: "ok"; code: number }
  | { kind: "not-in-project" };

export async function runFireflyRun(): Promise<RunResult> {
  const cwd = process.cwd();
  if (!existsSync(path.join(cwd, "package.json"))) return { kind: "not-in-project" };
  const electron = resolveElectron(cwd);
  // Windows wraps electron.cmd in a shell shim, so it must go through cmd /c.
  const viaShim = process.platform === "win32" && electron.endsWith(".cmd");
  const args = [".", "--firefly-profile=development"];
  const child = viaShim
    ? spawn("cmd", ["/c", electron, ...args], { stdio: "inherit", cwd })
    : spawn(electron, args, { stdio: "inherit", cwd });
  return new Promise((settle) => {
    // A signal-terminated child is reported as a generic failure (code 1).
    child.on("exit", (code, signal) => settle({ kind: "ok", code: signal ? 1 : (code ?? 0) }));
    child.on("error", (err) => {
      errLine(`firefly run: failed to spawn electron: ${err.message}`);
      settle({ kind: "ok", code: 1 });
    });
  });
}

/** Drive `run` from the dispatch layer; returns the exit code. */
export async function cmdRun(): Promise<number> {
  const result = await runFireflyRun();
  if (result.kind === "not-in-project") {
    errLine(
      `firefly run: no package.json found in ${process.cwd()}. Run this compatibility command from the Firefly project directory, or use the desktop installer.`,
    );
    return 0;
  }
  return result.code;
}
