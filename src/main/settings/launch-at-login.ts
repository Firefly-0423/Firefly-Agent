import { getStorageContext } from "../storage/storage-context";

export interface LoginItemSettingsApp { setLoginItemSettings(settings: { openAtLogin: boolean }): void; }

export interface InstallerOptionsFileSystem { readFileSync(path: string, encoding: "utf8"): string; unlinkSync(path: string): void; }

/** 仅正式版写入系统登录项；登录项属于操作系统全局状态，因此关闭时同样要同步。 */
export function syncLaunchAtLogin(enabled: boolean, app: LoginItemSettingsApp): void {
  if (getStorageContext().profile.kind !== "production") { return; }
  app.setLoginItemSettings({ openAtLogin: enabled });
}

/** 读取并删除安装程序写下的一次性选择。读取、解析、删除任一步失败都视为“没有选择”。 */
function takeInstallerChoice(file: string, fileSystem: InstallerOptionsFileSystem): boolean | null {
  const payload = JSON.parse(fileSystem.readFileSync(file, "utf8")) as { launchAtLogin?: unknown };
  fileSystem.unlinkSync(file);
  return typeof payload.launchAtLogin === "boolean" ? payload.launchAtLogin : null;
}

/**
 * 取得安装程序的开机启动选择，并在取得后移除该文件，之后的启动只听应用内设置。
 */
export function consumeInstallerLaunchAtLoginSelection(path: string, fileSystem: InstallerOptionsFileSystem): boolean | null {
  try {
    return takeInstallerChoice(path, fileSystem);
  } catch {
    return null;
  }
}

/** 若安装程序给出了选择则返回带有该值的新对象，否则原样返回入参。 */
export function applyInstallerLaunchAtLoginSelection<T extends object>(settings: T, selection: boolean | null): T {
  if (selection === null) { return settings; }
  return { ...settings, launchAtLogin: selection };
}
