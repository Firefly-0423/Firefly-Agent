import type {} from "electron";
import { IPC } from "../shared/ipc-channels";
import type { ModelConnectionSnapshot } from "../shared/model-connection-types";

export interface ModelConfigIpcRenderer {
    invoke: (channel: string, ...args: unknown[]) => Promise<any>;
    on: (channel: string, listener: (event: any, ...args: any[]) => void) => unknown;
    removeListener: (channel: string, listener: (event: any, ...args: any[]) => void) => unknown;
}

export function createModelConfigApi(ipcRenderer: ModelConfigIpcRenderer) {
    return {
        getConnectionSnapshot: (): Promise<ModelConnectionSnapshot> => {
            return ipcRenderer.invoke(IPC.MODEL_CONNECTION_GET);
        },
        onConnectionChanged: (receive: (snapshot: ModelConnectionSnapshot) => void) => {
            const forwardEvent = (_ipcEvent: Electron.IpcRendererEvent, snapshot: ModelConnectionSnapshot) => {
                return receive(snapshot);
            };
            ipcRenderer.on(IPC.MODEL_CONNECTION_CHANGED, forwardEvent);
            return () => {
                return ipcRenderer.removeListener(IPC.MODEL_CONNECTION_CHANGED, forwardEvent);
            };
        },
        get: () => {
            return ipcRenderer.invoke(IPC.MODEL_CONFIG_GET);
        },
        getModelInstallStatus: () => {
            return ipcRenderer.invoke(IPC.MODEL_GET_INSTALL_STATUS);
        },
        onChanged: (receive: (settings: unknown) => void) => {
            const forwardEvent = (_ipcEvent: Electron.IpcRendererEvent, settings: unknown) => {
                return receive(settings);
            };
            ipcRenderer.on(IPC.MODEL_CONFIG_CHANGED, forwardEvent);
            return () => {
                return ipcRenderer.removeListener(IPC.MODEL_CONFIG_CHANGED, forwardEvent);
            };
        },
    };
}

export function createTokenUsageApi(ipcRenderer: ModelConfigIpcRenderer) {
    return {
        get: (days: number) => {
            return ipcRenderer.invoke(IPC.TOKEN_USAGE_GET, days);
        },
        clear: () => {
            return ipcRenderer.invoke(IPC.TOKEN_USAGE_CLEAR) as Promise<void>;
        },
        history: (days: number) => {
            return ipcRenderer.invoke(IPC.TOKEN_USAGE_HISTORY, days);
        },
        sessionStats: (conversationKey: string) => {
            return ipcRenderer.invoke(IPC.TOKEN_USAGE_SESSION_STATS, conversationKey);
        },
    };
}
