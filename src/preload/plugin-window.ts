import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "../shared/ipc-channels";

type PluginWindowMessageListener = (msg: unknown) => void;

export interface PluginWindowIpcRenderer {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  send: (channel: string, ...args: unknown[]) => void;
  on: (channel: string, listener: (event: unknown, ...args: unknown[]) => void) => unknown;
  removeListener: (channel: string, listener: (event: unknown, ...args: unknown[]) => void) => unknown;
}

export interface FireflyPluginWindowApi {
  getState(): Promise<unknown>;
  invoke(method: string, params?: unknown): Promise<unknown>;
  onMessage(listener: PluginWindowMessageListener): () => void;
  close(): Promise<void>;
}

/**
 * Isolated preload bridge (`window.fireflyPlugin`) for v2 plugin UI windows.
 * Only exposes methods scoped by the main process to this window's owning plugin.
 */
export function createFireflyPluginWindowApi(ipcRenderer: PluginWindowIpcRenderer): FireflyPluginWindowApi {
  let readySent = false;
  return {
    getState: () => ipcRenderer.invoke(IPC.PLUGIN_WINDOW_GET_STATE),
    invoke: (method: string, params?: unknown) => {
      if (typeof method !== "string" || method.trim().length === 0) {
        return Promise.reject(new Error("method must be a non-empty string"));
      }
      return ipcRenderer.invoke(IPC.PLUGIN_WINDOW_INVOKE, { method, params });
    },
    onMessage: (listener: PluginWindowMessageListener) => {
      if (typeof listener !== "function") {
        return () => {};
      }
      const forward = (_event: unknown, msg: unknown) => {
        listener(msg);
      };
      ipcRenderer.on(IPC.PLUGIN_WINDOW_MESSAGE, forward);
      if (!readySent) {
        readySent = true;
        ipcRenderer.send(IPC.PLUGIN_WINDOW_READY);
      }
      return () => {
        ipcRenderer.removeListener(IPC.PLUGIN_WINDOW_MESSAGE, forward);
      };
    },
    close: async () => {
      await ipcRenderer.invoke(IPC.PLUGIN_WINDOW_CLOSE);
    },
  };
}

contextBridge.exposeInMainWorld("fireflyPlugin", createFireflyPluginWindowApi(ipcRenderer));
