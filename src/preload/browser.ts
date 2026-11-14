import type {} from "electron";
import type { BrowserAvailabilityApi } from "../shared/browser-availability";
import { IPC } from "../shared/ipc-channels";
import { MANUAL_BROWSER_WORKSPACE_IPC, type ManualBrowserWorkspaceApi } from "../shared/manual-browser";

export interface BrowserIpcRenderer {
    invoke: (channel: string, ...args: unknown[]) => Promise<any>;
    on: (channel: string, listener: (event: any, ...args: any[]) => void) => unknown;
    removeListener: (channel: string, listener: (event: any, ...args: any[]) => void) => unknown;
}

const withTab = (tabId: string | undefined) => {
    return (tabId === undefined ? {} : { tabId });
};

export function createManualBrowserApi(ipcRenderer: BrowserIpcRenderer): BrowserAvailabilityApi {
    return {
        getPermission: () => {
            return ipcRenderer.invoke(IPC.BROWSER_PERMISSION, { kind: "get" });
        },
        requestPermission: (scope) => {
            return ipcRenderer.invoke(IPC.BROWSER_PERMISSION, { kind: "request", scope });
        },
        revokePermission: (conversationId) => {
            return ipcRenderer.invoke(IPC.BROWSER_PERMISSION, {
                kind: "revoke",
                ...(conversationId === undefined ? {} : { conversationId }),
            });
        },
        getAvailability: () => {
            return ipcRenderer.invoke(IPC.BROWSER_AVAILABILITY);
        },
        execute: (command) => {
            return ipcRenderer.invoke(IPC.BROWSER_COMMAND, command);
        },
        onChanged: (receive) => {
            const forwardEvent = (_ipcEvent: Electron.IpcRendererEvent, page: import("../shared/manual-browser").BrowserPageDto) => {
                return receive(page);
            };
            ipcRenderer.on(IPC.BROWSER_CHANGED, forwardEvent);
            return () => {
                return ipcRenderer.removeListener(IPC.BROWSER_CHANGED, forwardEvent);
            };
        },
    };
}

export function createManualBrowserWorkspaceApi(ipcRenderer: BrowserIpcRenderer): ManualBrowserWorkspaceApi {
    const browserWorkspaceCommand = (message: object) => {
        return ipcRenderer.invoke(MANUAL_BROWSER_WORKSPACE_IPC.command, message);
    };
    return {
        getAvailability: () => {
            return ipcRenderer.invoke(MANUAL_BROWSER_WORKSPACE_IPC.availability);
        },
        getPermission: (tabId) => {
            return ipcRenderer.invoke(MANUAL_BROWSER_WORKSPACE_IPC.permission, { kind: "get", ...withTab(tabId) });
        },
        requestPermission: (scope, tabId) => {
            return ipcRenderer.invoke(MANUAL_BROWSER_WORKSPACE_IPC.permission, { kind: "request", scope, ...withTab(tabId) });
        },
        revokePermission: (workspaceId, tabId) => {
            return ipcRenderer.invoke(MANUAL_BROWSER_WORKSPACE_IPC.permission, { kind: "revoke", workspaceId, ...withTab(tabId) });
        },
        getTabs: () => {
            return browserWorkspaceCommand({ kind: "tabs" });
        },
        newTab: () => {
            return browserWorkspaceCommand({ kind: "new-tab" });
        },
        selectTab: (tabId) => {
            return browserWorkspaceCommand({ kind: "select-tab", tabId });
        },
        closeTab: (tabId) => {
            return browserWorkspaceCommand({ kind: "close-tab", tabId });
        },
        execute: (command, tabId) => {
            return browserWorkspaceCommand({ ...command, ...withTab(tabId) });
        },
        onChanged: (receive) => {
            const forwardEvent = (_ipcEvent: Electron.IpcRendererEvent, page: import("../shared/manual-browser").BrowserWorkspacePageDto) => {
                return receive(page);
            };
            ipcRenderer.on(MANUAL_BROWSER_WORKSPACE_IPC.changed, forwardEvent);
            return () => {
                return ipcRenderer.removeListener(MANUAL_BROWSER_WORKSPACE_IPC.changed, forwardEvent);
            };
        },
        tool: (request, tabId) => {
            return browserWorkspaceCommand({ kind: "tool", request, ...withTab(tabId) });
        },
        onToolsChanged: (receive) => {
            const forwardEvent = (_ipcEvent: Electron.IpcRendererEvent, change: import("../shared/browser-tools").BrowserToolsChange) => {
                return receive(change);
            };
            ipcRenderer.on(MANUAL_BROWSER_WORKSPACE_IPC.toolsChanged, forwardEvent);
            return () => {
                return ipcRenderer.removeListener(MANUAL_BROWSER_WORKSPACE_IPC.toolsChanged, forwardEvent);
            };
        },
    };
}
