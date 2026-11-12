import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function fixedMpvPaths(platform: NodeJS.Platform): string[] {
  if (platform !== "win32") {
    return platform === "darwin"
      ? ["/opt/homebrew/bin/mpv", "/usr/local/bin/mpv"]
      : ["/usr/bin/mpv", "/usr/local/bin/mpv"];
  }
  const executable = ["mpv", "mpv.exe"];
  const root = path.resolve(__dirname, "..", "..", "..", "..", "..", "..");
  return [
    path.join(process.resourcesPath ?? "", "bin", ...executable),
    path.join(root, "resources", "bin", ...executable),
    path.join(process.env.PROGRAMFILES ?? "C:\\Program Files", ...executable),
    path.join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", ...executable),
  ];
}

export function detectMpvBinary(): string | null {
  for (const candidate of fixedMpvPaths(os.platform())) {
    try {
      if (fs.existsSync(candidate)) {
        console.log("[mpv] detectMpvBinary →", candidate);
        return candidate;
      }
    } catch { /* try the next location */ }
  }
  if (canSpawnMpv()) {
    console.log("[mpv] detectMpvBinary → mpv (PATH)");
    return "mpv";
  }
  console.warn("[mpv] detectMpvBinary: 未找到可用的 mpv 二进制");
  return null;
}

function canSpawnMpv(): boolean {
  try {
    const probe = spawnSync("mpv", ["--version"], { timeout: 5000, windowsHide: true });
    return probe.status === 0;
  } catch {
    return false;
  }
}
