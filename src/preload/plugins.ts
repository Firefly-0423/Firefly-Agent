import type {} from "electron";
import { IPC } from "../shared/ipc-channels";
import type {
    PluginOverview,
    PluginPanelApi,
    PluginV2BorrowingEntry,
    PluginV2ConfirmRequest,
    PluginV2ConfirmSettled,
} from "../shared/plugin-management";

export interface PluginsIpcRenderer {
    invoke: (channel: string, ...args: unknown[]) => Promise<any>;
    on: (channel: string, listener: (event: any, ...args: any[]) => void) => unknown;
    removeListener: (channel: string, listener: (event: any, ...args: any[]) => void) => unknown;
}

function forwardPayload<T>(receive: (payload: T) => void) {
    return (_ipcEvent: Electron.IpcRendererEvent, payload: T) => receive(payload);
}

export function createPluginsApi(ipcRenderer: PluginsIpcRenderer) {
    return {
        onChanged: (receive: (overview: PluginOverview) => void) => {
            const forwardEvent = forwardPayload(receive);
            ipcRenderer.on(IPC.PLUGINS_CHANGED, forwardEvent);
            return () => ipcRenderer.removeListener(IPC.PLUGINS_CHANGED, forwardEvent);
        },
        onV2BorrowingChanged: (receive: (payload: { entries: PluginV2BorrowingEntry[] }) => void) => {
            const forwardEvent = forwardPayload(receive);
            ipcRenderer.on(IPC.PLUGINS_V2_BORROWING_CHANGED, forwardEvent);
            return () => ipcRenderer.removeListener(IPC.PLUGINS_V2_BORROWING_CHANGED, forwardEvent);
        },
        getV2Borrowing: () => {
            return ipcRenderer.invoke(IPC.PLUGINS_V2_BORROWING_GET) as Promise<{ entries: PluginV2BorrowingEntry[] }>;
        },
        stopV2Borrowing: (filter?: { id?: string; pluginId?: string }) => {
            return ipcRenderer.invoke(IPC.PLUGINS_V2_BORROWING_STOP, filter) as Promise<{ ok: boolean; stopped: number }>;
        },
        onV2ConfirmRequest: (receive: (request: PluginV2ConfirmRequest) => void) => {
            const forwardEvent = forwardPayload(receive);
            ipcRenderer.on(IPC.PLUGINS_V2_CONFIRM_REQUEST, forwardEvent);
            return () => ipcRenderer.removeListener(IPC.PLUGINS_V2_CONFIRM_REQUEST, forwardEvent);
        },
        getV2Confirms: () => {
            return ipcRenderer.invoke(IPC.PLUGINS_V2_CONFIRM_GET) as Promise<{ requests: PluginV2ConfirmRequest[] }>;
        },
        resolveV2Confirm: (id: string, allowed: boolean) => {
            return ipcRenderer.invoke(IPC.PLUGINS_V2_CONFIRM_RESOLVE, { id, allowed }) as Promise<{ ok: boolean }>;
        },
        onV2ConfirmSettled: (receive: (settled: PluginV2ConfirmSettled) => void) => {
            const forwardEvent = forwardPayload(receive);
            ipcRenderer.on(IPC.PLUGINS_V2_CONFIRM_SETTLED, forwardEvent);
            return () => ipcRenderer.removeListener(IPC.PLUGINS_V2_CONFIRM_SETTLED, forwardEvent);
        },
        list: () => {
            return ipcRenderer.invoke(IPC.PLUGINS_LIST);
        },
        setEnabled: (entityId: string, active: boolean) => {
            return ipcRenderer.invoke(IPC.PLUGINS_SET_ENABLED, entityId, active);
        },
        open: (entityId: string) => {
            return ipcRenderer.invoke(IPC.PLUGINS_OPEN, entityId);
        },
        rescan: () => {
            return ipcRenderer.invoke(IPC.PLUGINS_RESCAN);
        },
        importZip: () => {
            return ipcRenderer.invoke(IPC.PLUGINS_IMPORT_ZIP);
        },
        uninstall: (entityId: string) => {
            return ipcRenderer.invoke(IPC.PLUGINS_UNINSTALL, entityId);
        },
        marketList: (preferred?: string) => {
            return ipcRenderer.invoke(IPC.PLUGINS_MARKET_LIST, preferred);
        },
        marketInstall: (entityId: string) => {
            return ipcRenderer.invoke(IPC.PLUGINS_MARKET_INSTALL, entityId);
        },
    };
}

export function createPluginPanelApi(ipcRenderer: PluginsIpcRenderer): PluginPanelApi {
    return {
        invoke: (pluginId, channelName, values) => {
            return ipcRenderer.invoke(IPC.PLUGINS_PANEL_INVOKE, pluginId, channelName, values);
        },
    };
}
