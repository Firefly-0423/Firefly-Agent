import type { RunStatusItem, RunStatusRequest } from "../shared/run-status";
import type {} from "electron";
import type { ConversationMode } from "../shared/chat-types";
import { IPC } from "../shared/ipc-channels";
import type { AguiRunAck } from "../shared/run-terminal";
import { SIDEBAR_LAYOUT_IPC, type SidebarMutation } from "../shared/sidebar-layout";

export interface AguiIpcRenderer {
    invoke: (channel: string, ...args: unknown[]) => Promise<any>;
    send: (channel: string, ...args: unknown[]) => void;
    on: (channel: string, listener: (event: any, ...args: any[]) => void) => unknown;
    removeListener: (channel: string, listener: (event: any, ...args: any[]) => void) => unknown;
}

type ChatModeName = "chat" | "work" | "code";

export function createAguiApi(ipcRenderer: AguiIpcRenderer) {
    return {
        run: (request: {
            messages: unknown[];
            userTurnId?: string;
            assistantTurnId?: string;
            executionMode?: ChatModeName;
            sessionId?: string;
            attachments?: {
                name: string;
                text: string;
            }[];
            imageAttachments?: {
                name: string;
                filePath: string;
                mime?: string;
            }[];
            recoveryContext?: string;
            resumeFromRunId?: string;
            takeoverFromRunId?: string;
            transcriptRewind?: {
                anchorUserTurnId: string;
                disposition: "keep_user" | "replace_user";
            };
        }) => {
            return ipcRenderer.invoke(IPC.AGUI_RUN, request) as Promise<AguiRunAck>;
        },
        onEvent: (receive: (eventData: unknown) => void) => {
            const forwardEvent = (_ipcEvent: unknown, eventData: unknown) => {
                try {
                    receive(eventData);
                }
                catch (listenerFailure) {
                    console.error("[Preload] listener抛错:", listenerFailure);
                }
            };
            ipcRenderer.on(IPC.AGUI_EVENT, forwardEvent);
            return () => {
                return ipcRenderer.removeListener(IPC.AGUI_EVENT, forwardEvent);
            };
        },
        cancel: (runId?: string) => {
            return ipcRenderer.invoke(IPC.AGUI_CANCEL, runId);
        },
        reportRunPersisted: (message: {
            runId: string;
            finalMessageId?: string;
        }) => {
            ipcRenderer.send(IPC.AGUI_RUN_PERSISTED, message);
        },
        getRunStatus: (request: RunStatusRequest): Promise<RunStatusItem[]> => ipcRenderer.invoke(IPC.AGUI_RUN_STATUS, request),
        getInterruptedRun: (conversationKey: string) => {
            return ipcRenderer.invoke(IPC.AGENT_RUN_GET_INTERRUPTED, conversationKey) as Promise<{
                runId: string;
                rounds: number;
                todoCount: number;
                updatedAt: number;
            } | null>;
        },
    };
}

export function createChatStoreApi(ipcRenderer: AguiIpcRenderer, pageTargetKey: string) {
    return {
        sidebarLayout: {
            get: () => {
                return ipcRenderer.invoke(SIDEBAR_LAYOUT_IPC.get);
            },
            mutate: (request: SidebarMutation) => {
                return ipcRenderer.invoke(SIDEBAR_LAYOUT_IPC.mutate, request);
            },
            onChanged: (receive: () => void) => {
                const forwardEvent = () => {
                    return receive();
                };
                ipcRenderer.on(SIDEBAR_LAYOUT_IPC.changed, forwardEvent);
                return () => {
                    ipcRenderer.removeListener(SIDEBAR_LAYOUT_IPC.changed, forwardEvent);
                };
            },
        },
        list: (query?: {
            mode?: ChatModeName;
        }) => {
            return ipcRenderer.invoke(IPC.CHATS_LIST, query);
        },
        get: (entityId: string) => {
            return ipcRenderer.invoke(IPC.CHATS_GET, entityId);
        },
        exportWorkMarkdown: (entityId: string) => {
            return ipcRenderer.invoke(IPC.CHATS_EXPORT_WORK_MARKDOWN, entityId);
        },
        create: (message?: {
            title?: string;
            identityId?: string | null;
            mode?: ChatModeName;
            temporary?: boolean;
        }) => {
            return ipcRenderer.invoke(IPC.CHATS_CREATE, message ?? {});
        },
        append: (entityId: string, message: unknown) => {
            return ipcRenderer.invoke(IPC.CHATS_APPEND, { id: entityId, message });
        },
        upsert: (entityId: string, message: unknown) => {
            return ipcRenderer.invoke(IPC.CHATS_UPSERT, { id: entityId, message });
        },
        replaceTail: (entityId: string, startIndex: number, messages: unknown[]) => {
            return ipcRenderer.invoke(IPC.CHATS_REPLACE_TAIL, { id: entityId, startIndex, messages });
        },
        compactConversation: (conversationKey: string) => {
            return ipcRenderer.invoke(IPC.CHATS_COMPACT, { sessionId: conversationKey }) as Promise<{
                ok: boolean;
                error?: string;
                before?: number;
                after?: number;
            }>;
        },
        rename: (entityId: string, title: string) => {
            return ipcRenderer.invoke(IPC.CHATS_RENAME, { id: entityId, title });
        },
        delete: (entityId: string) => {
            return ipcRenderer.invoke(IPC.CHATS_DELETE, entityId);
        },
        pendingEnqueue: (entityId: string, entry: unknown) => {
            return ipcRenderer.invoke(IPC.CHATS_PENDING_ENQUEUE, { sessionId: entityId, entry });
        },
        pendingList: (entityId: string) => {
            return ipcRenderer.invoke(IPC.CHATS_PENDING_LIST, entityId);
        },
        pendingRemove: (entityId: string, messageId: string) => {
            return ipcRenderer.invoke(IPC.CHATS_PENDING_REMOVE, { sessionId: entityId, messageId });
        },
        pendingClaim: (entityId: string) => {
            return ipcRenderer.invoke(IPC.CHATS_PENDING_CLAIM, entityId);
        },
        pendingCompleteDispatch: (entityId: string, messageId: string) => {
            return ipcRenderer.invoke(IPC.CHATS_PENDING_COMPLETE_DISPATCH, { sessionId: entityId, messageId });
        },
        pendingEdit: (entityId: string, messageId: string, update: {
            rawContent: string;
            visibleContent: string;
            userSticker?: string;
        }) => {
            return ipcRenderer.invoke(IPC.CHATS_PENDING_EDIT, {
                sessionId: entityId,
                messageId,
                rawContent: update.rawContent,
                visibleContent: update.visibleContent,
                ...(update.userSticker !== undefined ? { userSticker: update.userSticker } : {}),
            });
        },
        pendingUnmark: (entityId: string, messageId: string) => ipcRenderer.invoke(IPC.CHATS_PENDING_UNMARK, { sessionId: entityId, messageId }),
        pendingAdjust: (entityId: string, messageId: string) => {
            return ipcRenderer.invoke(IPC.CHATS_PENDING_ADJUST, { sessionId: entityId, messageId });
        },
        setPinned: (entityId: string, pinned: boolean) => {
            return ipcRenderer.invoke(IPC.CHATS_SET_PINNED, { id: entityId, pinned });
        },
        setModelProfile: (entityId: string, modelProfileId?: string) => {
            return ipcRenderer.invoke(IPC.CHATS_SET_MODEL_PROFILE, { id: entityId, modelProfileId });
        },
        openWorkspace: (workspaceRoot: string) => {
            return ipcRenderer.invoke(IPC.CHATS_OPEN_WORKSPACE, workspaceRoot);
        },
        setActiveSession: (conversationKey: string | null, conversationMode?: ConversationMode) => {
            return ipcRenderer.invoke(IPC.CHATS_SET_ACTIVE_SESSION, conversationKey ? { sessionId: conversationKey, mode: conversationMode, rendererTargetId: pageTargetKey } : null);
        },
        onChanged: (receive: (notice?: import("../shared/chat-types").RunInsertionChanged) => void) => {
            const forwardEvent = (_event: unknown, notice?: import("../shared/chat-types").RunInsertionChanged) => {
                const sessionId = notice?.runInsertionSessionId;
                if (typeof sessionId === "string" && sessionId.trim()) return receive({ runInsertionSessionId: sessionId });
                return receive();
            };
            ipcRenderer.on(IPC.CHATS_CHANGED, forwardEvent);
            return () => {
                return ipcRenderer.removeListener(IPC.CHATS_CHANGED, forwardEvent);
            };
        },
        setWorkspace: (conversationKey: string, workspaceRoot: string) => {
            return ipcRenderer.invoke(IPC.CHATS_SET_WORKSPACE, { sessionId: conversationKey, workspaceRoot });
        },
        pickWorkspaceFolder: () => {
            return ipcRenderer.invoke(IPC.CHATS_PICK_WORKSPACE_FOLDER);
        },
        openInReactChatWindow: (conversationKey: string) => {
            return ipcRenderer.invoke(IPC.CHATS_OPEN_IN_REACT_WINDOW, conversationKey);
        },
        onReactSwitchSession: (receive: (conversationKey: string) => void) => {
            const forwardEvent = (_ipcEvent: Electron.IpcRendererEvent, conversationKey: string) => {
                return receive(conversationKey);
            };
            ipcRenderer.on(IPC.CHATS_REACT_SWITCH_SESSION, forwardEvent);
            return () => {
                return ipcRenderer.removeListener(IPC.CHATS_REACT_SWITCH_SESSION, forwardEvent);
            };
        },
        notifyReactReady: () => {
            return ipcRenderer.send(IPC.CHATS_REACT_READY);
        },
    };
}
