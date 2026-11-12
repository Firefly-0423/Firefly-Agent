// 主进程 IPC 注册范围：集中记录 handle/on 的注册，dispose 时一并撤销。
// 规则：同一范围内 handle 同一通道只能注册一次；dispose 可重复调用，
// 撤销顺序与注册顺序相反（只影响撤销，与退出清理无关）。

import { ipcMain } from "electron";

export interface IpcScope {
  dispose(): void;
  on(channel: string, listener: (...args: any[]) => void): void;
  removeHandler(channel: string): void;
  handle(channel: string, listener: (...args: any[]) => unknown): void;
}

export interface IpcScopeMainLike {
  removeListener(channel: string, listener: (...args: any[]) => void): unknown;
  removeHandler(channel: string): unknown;
  on(channel: string, listener: (...args: any[]) => void): unknown;
  handle(channel: string, listener: (...args: any[]) => unknown): unknown;
}

type Listener = (...args: any[]) => void;
type TrackedRegistration =
  | { kind: "on"; channel: string; listener: Listener }
  | { kind: "handle"; channel: string; listener: (...args: any[]) => unknown };

export function createIpcScope(main: IpcScopeMainLike = ipcMain as IpcScopeMainLike): IpcScope {
  let closed = false;
  const trackedList: TrackedRegistration[] = [];
  const usedHandleChannels = new Set<string>();

  const requireOpen = (): void => {
    if (!closed) return;
    throw new Error("IPC scope already disposed");
  };

  const undo = (entry: TrackedRegistration): void => {
    try {
      if (entry.kind === "handle") {
        main.removeHandler(entry.channel);
      } else {
        main.removeListener(entry.channel, entry.listener);
      }
    } catch (error) {
      console.error(`[IpcScope] dispose failed for ${entry.kind} ${entry.channel}:`, error);
    }
  };

  return {
    handle(channel, listener) {
      requireOpen();
      if (usedHandleChannels.has(channel)) {
        throw new Error(`IPC channel already registered: ${channel}`);
      }
      usedHandleChannels.add(channel);
      trackedList.push({ kind: "handle", channel, listener });
      main.handle(channel, listener);
    },

    removeHandler(channel) {
      requireOpen();
      if (!usedHandleChannels.delete(channel)) return;
      const pos = trackedList.findIndex((e) => e.channel === channel && e.kind === "handle");
      if (pos !== -1) trackedList.splice(pos, 1);
      main.removeHandler(channel);
    },

    on(channel, listener) {
      requireOpen();
      trackedList.push({ kind: "on", channel, listener });
      main.on(channel, listener);
    },

    dispose() {
      if (closed) return;
      closed = true;
      trackedList.reverse().forEach(undo);
      trackedList.length = 0;
      usedHandleChannels.clear();
    },
  };
}
