import type {} from "electron";
import { IPC } from "../shared/ipc-channels";
import type { OpenInAppListResult, OpenInAppOpenResult } from "../shared/open-in-app-types";
import type { ReviewRestoreOutcome, ReviewSnapshot } from "../shared/review-types";
import type { WorkspaceListResult, WorkspaceReadResult, WorkspaceSaveResult } from "../shared/workspace-files-types";

export interface WorkspaceIpcRenderer {
    invoke: (channel: string, ...args: unknown[]) => Promise<any>;
    on: (channel: string, listener: (event: any, ...args: any[]) => void) => unknown;
    removeListener: (channel: string, listener: (event: any, ...args: any[]) => void) => unknown;
}

export function createReviewApi(ipcRenderer: WorkspaceIpcRenderer) {
    return {
        get: (runId: string) => {
            return ipcRenderer.invoke(IPC.REVIEW_GET, runId) as Promise<ReviewSnapshot | null>;
        },
        restore: (runId: string) => {
            return ipcRenderer.invoke(IPC.REVIEW_RESTORE, runId) as Promise<ReviewRestoreOutcome>;
        },
    };
}

export function createWorkspaceFilesApi(ipcRenderer: WorkspaceIpcRenderer) {
    return {
        list: (conversationKey: string, relPath: string) => {
            return ipcRenderer.invoke(IPC.WORKSPACE_FILES_LIST, { sessionId: conversationKey, relPath }) as Promise<WorkspaceListResult>;
        },
        read: (conversationKey: string, relPath: string) => {
            return ipcRenderer.invoke(IPC.WORKSPACE_FILES_READ, { sessionId: conversationKey, relPath }) as Promise<WorkspaceReadResult>;
        },
        save: (conversationKey: string, relPath: string, content: string, editVersion: string) => {
            return ipcRenderer.invoke(IPC.WORKSPACE_FILES_SAVE, {
                sessionId: conversationKey,
                relPath,
                content,
                editVersion,
            }) as Promise<WorkspaceSaveResult>;
        },
    };
}

export function createOpenInAppApi(ipcRenderer: WorkspaceIpcRenderer) {
    return {
        listApps: (conversationKey: string) => {
            return ipcRenderer.invoke(IPC.WORKSPACE_OPEN_IN_LIST_APPS, { sessionId: conversationKey }) as Promise<OpenInAppListResult>;
        },
        open: (conversationKey: string, appId: string) => {
            return ipcRenderer.invoke(IPC.WORKSPACE_OPEN_IN, { sessionId: conversationKey, appId }) as Promise<OpenInAppOpenResult>;
        },
    };
}

export function createCodeGitApi(ipcRenderer: WorkspaceIpcRenderer) {
    return {
        getStatus: (conversationKey: string) => {
            return ipcRenderer.invoke(IPC.CODE_GIT_STATUS, conversationKey);
        },
        watch: (conversationKey: string) => {
            return ipcRenderer.invoke(IPC.CODE_GIT_WATCH, conversationKey);
        },
        unwatch: (conversationKey: string) => {
            return ipcRenderer.invoke(IPC.CODE_GIT_UNWATCH, conversationKey);
        },
        switchBranch: (conversationKey: string, branch: string, create = false) => {
            return ipcRenderer.invoke(IPC.CODE_GIT_SWITCH_BRANCH, { sessionId: conversationKey, branch, create });
        },
        commit: (conversationKey: string, message: string, paths: string[]) => {
            return ipcRenderer.invoke(IPC.CODE_GIT_COMMIT, { sessionId: conversationKey, message, paths });
        },
        push: (conversationKey: string) => {
            return ipcRenderer.invoke(IPC.CODE_GIT_PUSH, conversationKey);
        },
        onChanged: (receive: (message: {
            sessionId: string;
        }) => void) => {
            const forwardEvent = (_ipcEvent: Electron.IpcRendererEvent, message: {
                sessionId: string;
            }) => {
                return receive(message);
            };
            ipcRenderer.on(IPC.CODE_GIT_CHANGED, forwardEvent);
            return () => {
                return ipcRenderer.removeListener(IPC.CODE_GIT_CHANGED, forwardEvent);
            };
        },
    };
}
