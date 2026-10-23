// 桌宠“工作中”信号的 preload 暴露：订阅主进程 → 桌宠窗口的 LIVE2D_WORKING_CHANGED。
// 与 contextBridge 解耦，便于用假的 ipcRenderer 单测。

import { IPC } from "../shared/ipc-channels";

export interface Live2dWorkIpcRenderer {
  on: (channel: string, listener: (event: unknown, working: unknown) => void) => unknown;
  removeListener: (channel: string, listener: (event: unknown, working: unknown) => void) => unknown;
  invoke: (channel: string) => Promise<unknown>;
}

export interface Live2dWorkApi {
  /** 订阅“工作中”状态变化；返回取消订阅函数。 */
  onChanged: (callback: (working: boolean) => void) => () => void;
  /** 读取当前是否处于工作中（初始快照）；读取失败按“不在工作”处理。 */
  getWorking: () => Promise<boolean>;
}

export function createLive2dWorkApi(ipcRenderer: Live2dWorkIpcRenderer): Live2dWorkApi {
  return {
    onChanged: (callback) => {
      const listener = (_event: unknown, working: unknown) => callback(working === true);
      ipcRenderer.on(IPC.LIVE2D_WORKING_CHANGED, listener);
      return () => {
        ipcRenderer.removeListener(IPC.LIVE2D_WORKING_CHANGED, listener);
      };
    },
    getWorking: async () => {
      try {
        return (await ipcRenderer.invoke(IPC.LIVE2D_GET_WORKING)) === true;
      } catch {
        return false;
      }
    },
  };
}
