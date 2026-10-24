import { BrowserWindow } from "electron";
import { IPC } from "../../shared/ipc-channels";
import { createIpcScope, type IpcScope, type IpcScopeMainLike } from "../application/ipc-scope";
import type { AppUpdateState } from "../../shared/app-update";
import type { AppUpdateService } from "./app-update-service";

type WindowLike = {
  isDestroyed(): boolean;
  webContents: { send(channel: string, payload: AppUpdateState): void };
};

export type ControlledShutdownRequest = {
  reason: string;
  finalAction(): void;
};

export type RequestControlledShutdown = (input: ControlledShutdownRequest) => Promise<boolean>;

export type RegisterAppUpdateIpcOptions = {
  service: AppUpdateService;
  getWindows?: () => WindowLike[];
  /** 受控退出入口，由组合根注入；安装前先完成需要等待的清理 */
  requestControlledShutdown?: RequestControlledShutdown;
  /** 共享 scope，退出时统一注销；缺省时用 ipcMain 参数，再缺省用全局 ipcMain */
  ipc?: IpcScope;
  ipcMain?: IpcScopeMainLike;
};

export function registerAppUpdateIpc(options: RegisterAppUpdateIpcOptions): void {
  const { service, requestControlledShutdown } = options;
  const scope: IpcScope = options.ipc ?? createIpcScope(options.ipcMain ?? undefined);
  const listWindows = options.getWindows ?? (() => BrowserWindow.getAllWindows());

  scope.handle(IPC.APP_UPDATE_GET_STATE, () => service.getState());
  scope.handle(IPC.APP_UPDATE_DOWNLOAD, () => service.download());

  // 安装不能直接触发退出：先经受控退出做完清理，quitAndInstall 作为最后一步执行
  scope.handle(IPC.APP_UPDATE_INSTALL, async () => {
    if (!service.canInstall()) return false;
    if (requestControlledShutdown === undefined) return service.install();
    const finalAction = () => service.install();
    return requestControlledShutdown({ reason: "update-install", finalAction });
  });

  service.onStateChanged((state) => {
    listWindows()
      .filter((win) => !win.isDestroyed())
      .forEach((win) => win.webContents.send(IPC.APP_UPDATE_STATE, state));
  });
}
