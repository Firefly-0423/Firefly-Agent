import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export function detectMpvBinary(): string | null {
  const platform = os.platform();
  // 固定路径候选：打包内资源 > dev 暂存目录 > 系统安装目录
  const repoRoot = path.resolve(__dirname, "..", "..", "..", "..");
  const fixedCandidates =
    platform === "win32"
      ? [
          path.join(process.resourcesPath ?? "", "bin", "mpv", "mpv.exe"),
          path.join(repoRoot, "resources", "bin", "mpv", "mpv.exe"),
          path.join(process.env.PROGRAMFILES ?? "C:\\Program Files", "mpv", "mpv.exe"),
          path.join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "mpv", "mpv.exe"),
        ]
      : platform === "darwin"
        ? ["/opt/homebrew/bin/mpv", "/usr/local/bin/mpv"]
        : ["/usr/bin/mpv", "/usr/local/bin/mpv"];
  for (const c of fixedCandidates) {
    try {
      if (fs.existsSync(c)) {
        console.log("[mpv] detectMpvBinary →", c);
        return c;
      }
    } catch { /* ignore */ }
  }
  // PATH 兜底：探测方式和实际 spawn 一致，探测通过才认为可用。
  // 之前无条件返回裸 "mpv"，没装 mpv 的机器上 spawn 必然 ENOENT（issue #98）
  if (canSpawnMpv()) {
    console.log("[mpv] detectMpvBinary → mpv (PATH)");
    return "mpv";
  }
  console.warn("[mpv] detectMpvBinary: 未找到可用的 mpv 二进制");
  return null;
}

/** 试跑一次 `mpv --version` 验证 PATH 里的 mpv 真的存在且能执行。 */
function canSpawnMpv(): boolean {
  try {
    const probe = spawnSync("mpv", ["--version"], { timeout: 5000, windowsHide: true });
    return probe.status === 0;
  } catch {
    return false;
  }
}
