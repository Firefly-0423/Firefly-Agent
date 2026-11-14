import type {} from "electron";
import { IPC } from "../shared/ipc-channels";
import type { MemoryAutomationPanelApi } from "../shared/memory-automation-contracts";
import type { MemoryPanelAction, MemoryPanelOutcome, MemoryPanelSourceAudit, MemoryPanelState } from "../shared/memory-panel-contracts";

export interface MemoryUserIpcRenderer {
    invoke: (channel: string, ...args: unknown[]) => Promise<any>;
    on: (channel: string, listener: (event: any, ...args: any[]) => void) => unknown;
    removeListener: (channel: string, listener: (event: any, ...args: any[]) => void) => unknown;
}

export function createUserApi(ipcRenderer: MemoryUserIpcRenderer) {
    return {
        getProfile: () => {
            return ipcRenderer.invoke(IPC.USER_GET_PROFILE);
        },
        saveProfile: (modelProfile: unknown) => {
            return ipcRenderer.invoke(IPC.USER_SAVE_PROFILE, modelProfile);
        },
        onProfileChanged: (receive: (modelProfile: unknown) => void) => {
            const forwardEvent = (_ipcEvent: Electron.IpcRendererEvent, modelProfile: unknown) => {
                return receive(modelProfile);
            };
            ipcRenderer.on(IPC.USER_PROFILE_CHANGED, forwardEvent);
            return () => {
                return ipcRenderer.removeListener(IPC.USER_PROFILE_CHANGED, forwardEvent);
            };
        },
        uploadAvatar: () => {
            return ipcRenderer.invoke(IPC.USER_UPLOAD_AVATAR);
        },
        getAvatar: () => {
            return ipcRenderer.invoke(IPC.USER_GET_AVATAR);
        },
        onAvatarChanged: (receive: () => void) => {
            const forwardEvent = (_ipcEvent: Electron.IpcRendererEvent) => {
                return receive();
            };
            ipcRenderer.on(IPC.USER_AVATAR_CHANGED, forwardEvent);
            return () => {
                return ipcRenderer.removeListener(IPC.USER_AVATAR_CHANGED, forwardEvent);
            };
        },
    };
}

export function createMemoryPanelApi(ipcRenderer: MemoryUserIpcRenderer) {
    return {
        getState: (): Promise<MemoryPanelState> => {
            return ipcRenderer.invoke(IPC.MEMORY_PANEL_GET_STATE);
        },
        applyAction: (action: MemoryPanelAction): Promise<MemoryPanelOutcome> => {
            return ipcRenderer.invoke(IPC.MEMORY_PANEL_APPLY_ACTION, action);
        },
        auditSource: (factId: string): Promise<MemoryPanelSourceAudit> => {
            return ipcRenderer.invoke(IPC.MEMORY_PANEL_AUDIT_SOURCE, factId);
        },
        getData: () => {
            return ipcRenderer.invoke(IPC.MEMORY_PANEL_GET_DATA);
        },
        deleteImportedDoc: (importId: string, fileName?: string) => {
            return ipcRenderer.invoke(IPC.MEMORY_PANEL_DELETE_IMPORTED_DOC, { importId, fileName });
        },
        shadowState: () => {
            return ipcRenderer.invoke(IPC.MEMORY_SHADOW_STATE);
        },
        shadowConfigure: (request: {
            enabled: boolean;
            dailyCap: number;
            expectedRevision: number;
        }) => {
            return ipcRenderer.invoke(IPC.MEMORY_SHADOW_CONFIGURE, request);
        },
        shadowExport: () => {
            return ipcRenderer.invoke(IPC.MEMORY_SHADOW_EXPORT);
        },
        shadowClear: () => {
            return ipcRenderer.invoke(IPC.MEMORY_SHADOW_CLEAR);
        },
    };
}

export function createMemoryAutomationApi(ipcRenderer: MemoryUserIpcRenderer): MemoryAutomationPanelApi {
    return {
        state: () => {
            return ipcRenderer.invoke(IPC.MEMORY_AUTOMATION_STATE);
        },
        configure: (request) => {
            return ipcRenderer.invoke(IPC.MEMORY_AUTOMATION_CONFIGURE, request);
        },
    };
}
