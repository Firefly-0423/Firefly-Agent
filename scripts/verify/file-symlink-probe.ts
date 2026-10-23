import { rmSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

export class Win32SymlinkError extends Error {
  constructor(readonly win32Code: number) {
    super(`CreateSymbolicLinkW failed: ${win32Code}`);
  }
}

interface ProbeOperations { create(): void; remove(): void }
function createWindowsFileSymlink(target: string, link: string): void {
  if (!process.env.SystemRoot) throw new Error("Windows SystemRoot is required for the symlink probe");
  // Same inherited token, no UAC, execution-policy override or privilege adjustment.
  // Node/libuv merges native 5 and 1314 into EPERM; retain the original native result instead.
  const output = execFileSync(path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"), [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-File", path.join(__dirname, "file-symlink-probe.ps1"),
    "-TargetFile", target, "-LinkFile", link,
  ], { encoding: "utf8", windowsHide: true, timeout: 30000 });
  const result = JSON.parse(output);
  if (!result || typeof result.win32Code !== "number" || !Number.isSafeInteger(result.win32Code) || result.win32Code < 0) {
    throw new Error("Invalid native file-symlink probe result");
  }
  if (result.win32Code !== 0) throw new Win32SymlinkError(result.win32Code);
}

export function probeFileSymlink(target: string, link: string, operations: ProbeOperations = {
  create: () => process.platform === "win32" ? createWindowsFileSymlink(target, link) : symlinkSync(target, link),
  remove: () => rmSync(link),
}): { supported: boolean; reason?: string } {
  try {
    operations.create();
  } catch (error) {
    if (error instanceof Win32SymlinkError && error.win32Code === 1314) {
      return { supported: false, reason: "Windows file symlink unavailable: ERROR_PRIVILEGE_NOT_HELD (1314)" };
    }
    throw error;
  }
  // A failed deletion is a broken fixture, even if its error looks like a permission error.
  operations.remove();
  return { supported: true };
}
