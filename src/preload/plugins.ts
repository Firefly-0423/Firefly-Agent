import type {} from "electron";
import { IPC } from "../shared/ipc-channels";
import type { PluginOverview, PluginPanelApi } from "../shared/plugin-management";

export interface PluginsIpcRenderer {
    invoke: (channel: string, ...args: unknown[]) => Promise<any>;
    on: (channel: string, listener: (event: any, ...args: any[]) => void) => unknown;
    removeListener: (channel: string, listener: (event: any, ...args: any[]) => void) => unknown;
}

export function createPluginsApi(ipcRenderer: PluginsIpcRenderer) {
    return {
        onChanged: (receive: (overview: PluginOverview) => void) => {
            const forwardEvent = (_ipcEvent: Electron.IpcRendererEvent, overview: PluginOverview) => {
                return receive(overview);
            };
            ipcRenderer.on(IPC.PLUGINS_CHANGED, forwardEvent);
            return () => {
                return ipcRenderer.removeListener(IPC.PLUGINS_CHANGED, forwardEvent);
            };
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
