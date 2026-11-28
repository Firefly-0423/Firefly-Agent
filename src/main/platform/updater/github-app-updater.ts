import * as path from "node:path";
import { app } from "electron";
import { autoUpdater } from "electron-updater";
import { createAppUpdateService, type AppUpdateService, type AppUpdaterLike } from "./app-update-service";

type GitHubUpdateOptions = { currentVersion: string; isPackaged: boolean };

type InstallDirTarget = { installDirectory?: string };

/** 升级时固定装回当前运行目录，不依赖注册表里可能缺失或漂移的 InstallLocation */
function pinInstallDirectory(): void {
  // NsisUpdater 会把该值作为 /D= 参数传给安装器
  (autoUpdater as unknown as InstallDirTarget).installDirectory = path.dirname(app.getPath("exe"));
}

export function createGitHubAppUpdateService(options: GitHubUpdateOptions): AppUpdateService {
  const { currentVersion, isPackaged } = options;
  if (isPackaged) pinInstallDirectory();

  return createAppUpdateService({
    updater: autoUpdater as unknown as AppUpdaterLike,
    currentVersion,
    isPackaged,
    updatesEnabled: false,
  });
}

export function scheduleStartupUpdateCheck(service: AppUpdateService, delayMs = 10_000): () => void {
  const pending = setTimeout(() => void service.check(), delayMs);
  pending.unref?.();
  return () => clearTimeout(pending);
}
