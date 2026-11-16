import type { AppUpdateApi, AppUpdateState } from "../shared/app-update";
import { IPC } from "../shared/ipc-channels";
import type { ToastItem, ToastPushPayload, ToastRendererApi } from "../shared/toast-types";

export interface WindowShellIpcRenderer {
    invoke: (channel: string, ...args: unknown[]) => Promise<any>;
    send: (channel: string, ...args: unknown[]) => void;
    on: (channel: string, listener: (event: any, ...args: any[]) => void) => unknown;
    removeListener: (channel: string, listener: (event: any, ...args: any[]) => void) => unknown;
}

export function createAppUpdateApi(ipcRenderer: WindowShellIpcRenderer): AppUpdateApi {
    return {
        getState: () => {
            return ipcRenderer.invoke(IPC.APP_UPDATE_GET_STATE);
        },
        download: () => {
            return ipcRenderer.invoke(IPC.APP_UPDATE_DOWNLOAD);
        },
        install: () => {
            return ipcRenderer.invoke(IPC.APP_UPDATE_INSTALL);
        },
        onStateChanged: (receive: (snapshot: AppUpdateState) => void) => {
            const forwardEvent = (_ipcEvent: unknown, snapshot: AppUpdateState) => {
                return receive(snapshot);
            };
            ipcRenderer.on(IPC.APP_UPDATE_STATE, forwardEvent);
            return () => {
                return ipcRenderer.removeListener(IPC.APP_UPDATE_STATE, forwardEvent);
            };
        },
    };
}

export function createSidebarApi(ipcRenderer: WindowShellIpcRenderer) {
    return {
        minimize: () => {
            return ipcRenderer.send(IPC.SIDEBAR_MINIMIZE);
        },
        close: () => {
            return ipcRenderer.send(IPC.SIDEBAR_CLOSE);
        },
        toggleAlwaysOnTop: () => {
            return ipcRenderer.invoke(IPC.SIDEBAR_TOGGLE_ALWAYS_ON_TOP);
        },
        openSettings: (section?: string) => {
            return ipcRenderer.send(IPC.SIDEBAR_OPEN_SETTINGS, section);
        },
    };
}

export function createToastApi(ipcRenderer: WindowShellIpcRenderer): ToastRendererApi {
    return {
        getAll: () => {
            return ipcRenderer.invoke(IPC.TOAST_GET_ALL) as Promise<ToastItem[]>;
        },
        clicked: (entityId: string) => {
            return ipcRenderer.send(IPC.TOAST_CLICKED, entityId);
        },
        dismissed: (entityId: string) => {
            return ipcRenderer.send(IPC.TOAST_DISMISSED, entityId);
        },
        reportHeight: (height: number) => {
            return ipcRenderer.send(IPC.TOAST_RESIZE, height);
        },
        resolveApproval: (approvalId: string, allowed: boolean) => {
            return ipcRenderer.invoke(IPC.PERMISSION_APPROVAL_RESOLVE, { id: approvalId, allowed }) as Promise<{ ok: boolean }>;
        },
        onPush: (receive: (message: ToastPushPayload) => void) => {
            const forwardEvent = (_ipcEvent: unknown, message: ToastPushPayload) => {
                return receive(message);
            };
            ipcRenderer.on(IPC.TOAST_PUSH, forwardEvent);
            return () => {
                return ipcRenderer.removeListener(IPC.TOAST_PUSH, forwardEvent);
            };
        },
        onRemove: (receive: (entityId: string) => void) => {
            const forwardEvent = (_ipcEvent: unknown, entityId: string) => {
                return receive(entityId);
            };
            ipcRenderer.on(IPC.TOAST_REMOVE, forwardEvent);
            return () => {
                return ipcRenderer.removeListener(IPC.TOAST_REMOVE, forwardEvent);
            };
        },
    };
}
