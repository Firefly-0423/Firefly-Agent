import { logger } from "../../shared/logger";
import { execSync } from "child_process";
import * as path from "path";
import * as fs from "fs";

export type GpuAclHealOptions = {
  userDataDir: string;
  exeDir: string;
  isPackaged: boolean;
  platform?: NodeJS.Platform;
  mkdirSync?: (p: string) => void;
  writeFileSync?: (p: string) => void;
  existsSync?: (p: string) => boolean;
  queryAcl?: (dir: string) => string;
  runCommand?: (cmd: string) => void;
};
export type GpuAclHealStatus =
  | "failed" | "already_ok" | "granted"
  | "skipped_sentinel" | "skipped_platform" | "skipped_dev";

function executeGrant(command: string): void {
  execSync(command, { stdio: "ignore", timeout: 15_000, windowsHide: true });
}
function readAcl(quotedPath: string): string {
  return execSync(`icacls ${quotedPath}`, { encoding: "utf8", timeout: 15_000, windowsHide: true }).toString();
}

// 在 GPU 启动之前同步完成；只有成功路径才留下标记。
export function ensureGpuSandboxAcl(options: GpuAclHealOptions): GpuAclHealStatus {
  const system = options.platform ?? process.platform;
  if (system !== "win32") return "skipped_platform";
  if (!options.isPackaged) return "skipped_dev";
  const grantAccess = options.runCommand ?? executeGrant;
  const inspectAccess = options.queryAcl ?? readAcl;
  const hasFile = options.existsSync ?? ((filename: string) => fs.existsSync(filename));
  const saveMarker = options.writeFileSync ?? ((filename: string) => fs.writeFileSync(filename, new Date().toISOString(), "utf8"));
  const prepareDirectory = options.mkdirSync ?? ((directory: string) => fs.mkdirSync(directory, { recursive: true }));
  const stamp = path.join(options.userDataDir, "gpu-acl-ok");
  if (hasFile(stamp)) return "skipped_sentinel";
  const installation = `"${options.exeDir}"`;
  const remember = (): void => {
    prepareDirectory(options.userDataDir);
    saveMarker(stamp);
  };
  try {
    const permissions = inspectAccess(installation);
    if (/S-1-15-2-2|RESTRICTED APPLICATION PACKAGES/i.test(permissions)) {
      try { remember(); } catch { /* 已有权限时，标记失败只会导致重查。 */ }
      return "already_ok";
    }
  } catch { /* 查询失败仍可尝试授权。 */ }
  try {
    grantAccess(`icacls ${installation} /grant *S-1-15-2-2:(OI)(CI)(RX) /C`);
    remember();
    logger.info(`[GpuAclHeal] 已补装 GPU 沙箱读取权限 (S-1-15-2-2)，目录: ${options.exeDir}`);
    return "granted";
  } catch (failure) {
    const detail = failure instanceof Error ? failure.message : String(failure);
    logger.warn("[GpuAclHeal] 补权限失败（下次启动重试）:", detail);
    return "failed";
  }
}
