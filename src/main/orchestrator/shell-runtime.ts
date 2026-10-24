import { spawn } from "child_process";
import fs from "fs";
import path from "path";

export type ShellKind = "cmd" | "bash";
export interface ResolvedShellExecutable { executable: string; kind: ShellKind }

export function buildDirectShellInvocation(
  shell: ResolvedShellExecutable,
  command: string,
): { command: string; args: string[]; windowsVerbatimArguments: boolean } {
  const usesBash = shell.kind === "bash";
  return {
    command: shell.executable,
    args: usesBash ? ["--noprofile", "--norc", "-lc", command] : ["/d", "/s", "/c", command],
    windowsVerbatimArguments: !usesBash,
  };
}

function collectBashCandidates(): string[] {
  const locations: string[] = [];
  for (const segment of (process.env.PATH ?? "").split(path.delimiter)) {
    const folder = segment.trim().replace(/^"|"$/g, "");
    if (folder) locations.push(path.join(folder, "bash.exe"));
  }
  const systemInstall = process.env.ProgramFiles;
  const legacyInstall = process.env["ProgramFiles(x86)"];
  const userInstall = process.env.LOCALAPPDATA;
  if (systemInstall) locations.push(path.join(systemInstall, "Git", "bin", "bash.exe"));
  if (legacyInstall) locations.push(path.join(legacyInstall, "Git", "bin", "bash.exe"));
  if (userInstall) locations.push(path.join(userInstall, "Programs", "Git", "bin", "bash.exe"));
  const unique = new Set<string>();
  return locations.filter((location) => {
    const identity = path.normalize(location).toLowerCase();
    if (unique.has(identity)) return false;
    unique.add(identity);
    return true;
  });
}

function probeBash(executable: string): Promise<boolean> {
  return new Promise((complete) => {
    let done = false;
    const conclude = (success: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      complete(success);
    };
    const probe = spawn(executable, ["--noprofile", "--norc", "-lc", "printf firefly-bash-probe"], {
      shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
    });
    let response = "";
    probe.stdout?.on("data", (part: Buffer) => { response += part.toString("utf8"); });
    probe.on("error", () => conclude(false));
    probe.on("close", (exitCode) => conclude(exitCode === 0 && response === "firefly-bash-probe"));
    const deadline = setTimeout(() => {
      try { probe.kill("SIGKILL"); } catch { /* 退出后无需再处理。 */ }
      conclude(false);
    }, 3_000);
  });
}

export async function resolveShellExecutable(kind: ShellKind): Promise<ResolvedShellExecutable | null> {
  if (kind === "cmd") return { kind, executable: process.env.ComSpec || "cmd.exe" };
  for (const location of collectBashCandidates()) {
    if (!fs.existsSync(location)) continue;
    const usable = await probeBash(location);
    if (usable) return { kind, executable: location };
  }
  return null;
}
