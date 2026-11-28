import type { DesktopAsrApi } from "../shared/desktop-asr";
import { IPC, type ScreenshotInsertPayload } from "../shared/ipc-channels";

export interface ChatMediaIpcRenderer {
    invoke: (channel: string, ...args: unknown[]) => Promise<any>;
    send: (channel: string, ...args: unknown[]) => void;
    on: (channel: string, listener: (event: any, ...args: any[]) => void) => unknown;
    removeListener: (channel: string, listener: (event: any, ...args: any[]) => void) => unknown;
}

export interface WebUtilsPathReader {
    getPathForFile(file: File): string;
}

export function createDesktopAsrApi(ipcRenderer: ChatMediaIpcRenderer): DesktopAsrApi {
    return {
        start: (entityId) => {
            return ipcRenderer.invoke(IPC.DESKTOP_ASR_START, entityId);
        },
        frame: (entityId, pcm) => {
            return ipcRenderer.invoke(IPC.DESKTOP_ASR_FRAME, entityId, pcm);
        },
        stop: (entityId) => {
            return ipcRenderer.invoke(IPC.DESKTOP_ASR_STOP, entityId);
        },
        cancel: (entityId) => {
            return ipcRenderer.invoke(IPC.DESKTOP_ASR_CANCEL, entityId);
        },
    };
}

export function createChatApi(ipcRenderer: ChatMediaIpcRenderer, webUtils: WebUtilsPathReader) {
    return {
        minimize: () => {
            return ipcRenderer.send(IPC.CHAT_MINIMIZE);
        },
        close: () => {
            return ipcRenderer.send(IPC.CHAT_CLOSE);
        },
        toggleMaximize: () => {
            return ipcRenderer.send(IPC.CHAT_TOGGLE_MAXIMIZE);
        },
        isMaximized: () => {
            return ipcRenderer.invoke(IPC.CHAT_IS_MAXIMIZED);
        },
        startWindowDrag: () => {
            return ipcRenderer.send(IPC.CHAT_WINDOW_DRAG_START);
        },
        endWindowDrag: () => {
            return ipcRenderer.send(IPC.CHAT_WINDOW_DRAG_END);
        },
        getEnabledStickers: () => {
            return ipcRenderer.invoke(IPC.STICKERS_GET_ENABLED);
        },
        ingestDroppedFiles: async (selectedFiles: File[]): Promise<unknown[]> => {
            const fileDescriptions: Array<{
                path: string;
                mime: string;
            }> = [];
            for (const selectedFile of selectedFiles) {
                try {
                    const absolutePath = webUtils.getPathForFile(selectedFile);
                    if (absolutePath)
                        fileDescriptions.push({ path: absolutePath, mime: selectedFile.type });
                }
                catch {
                }
            }
            if (fileDescriptions.length === 0)
                return [];
            return ipcRenderer.invoke(IPC.CHAT_INGEST_FILES, fileDescriptions);
        },
        captionImage: (filePath: string, hasAnnotations = false) => {
            return ipcRenderer.invoke(IPC.CHAT_CAPTION_IMAGE, { filePath, hasAnnotations });
        },
        getImagePreview: (filePath: string) => {
            return ipcRenderer.invoke(IPC.CHAT_GET_IMAGE_PREVIEW, { filePath });
        },
        getImageSendStrategy: (conversationKey?: string) => {
            return ipcRenderer.invoke(IPC.CHAT_GET_IMAGE_SEND_STRATEGY, conversationKey ? { sessionId: conversationKey } : undefined);
        },
        getGeneralSettings: () => {
            return ipcRenderer.invoke(IPC.SETTINGS_GET_GENERAL);
        },
        getReasoningState: (message?: {
            sessionId?: string;
        }) => {
            return ipcRenderer.invoke(IPC.CHAT_GET_REASONING_STATE, message);
        },
        setReasoning: (message: {
            sessionId?: string;
            providerKey: string;
            preference: unknown;
        }) => {
            return ipcRenderer.invoke(IPC.CHAT_SET_REASONING, message);
        },
        startScreenshot: () => {
            return ipcRenderer.invoke(IPC.SCREENSHOT_START);
        },
        onScreenshotInsert: (receive: (eventData: ScreenshotInsertPayload) => void) => {
            const forwardEvent = (_ipcEvent: unknown, eventData: ScreenshotInsertPayload) => {
                return receive(eventData);
            };
            ipcRenderer.on(IPC.SCREENSHOT_INSERT, forwardEvent);
            return () => {
                return ipcRenderer.removeListener(IPC.SCREENSHOT_INSERT, forwardEvent);
            };
        },
        saveScreenshotTemp: (base64: string, mime: string) => {
            return ipcRenderer.invoke(IPC.SCREENSHOT_SAVE_TEMP, base64, mime) as Promise<{
                filePath: string;
            }>;
        },
    };
}

export function createChoiceApi(ipcRenderer: ChatMediaIpcRenderer) {
    return {
        resolve: (entityId: string, settingValue: unknown) => {
            return ipcRenderer.invoke(IPC.CHOICE_RESOLVE, typeof settingValue === "string" ? { id: entityId, value: settingValue } : { id: entityId, answer: settingValue });
        },
    };
}
