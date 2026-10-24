import { contextBridge, ipcRenderer, webUtils } from "electron";
import { IPC } from "../shared/ipc-channels";
import type { ScreenshotInsertPayload } from "../shared/ipc-channels";
import { MANUAL_BROWSER_WORKSPACE_IPC, type ManualBrowserWorkspaceApi } from "../shared/manual-browser";
import { SIDEBAR_LAYOUT_IPC, type SidebarMutation } from "../shared/sidebar-layout";
import type { ExternalSkillsApi } from "../shared/external-skills";
import type { DesktopAsrApi } from "../shared/desktop-asr";
import type { MemoryPanelAction, MemoryPanelOutcome, MemoryPanelSourceAudit, MemoryPanelState, } from "../shared/memory-panel-contracts";
import type { MemoryAutomationPanelApi } from "../shared/memory-automation-contracts";
import type { UiColors } from "../shared/ui-colors";
import type { UiTheme } from "../shared/ui-theme";
import type { UiFont } from "../shared/ui-font";
import type { BrowserAvailabilityApi } from "../shared/browser-availability";
import type { ModelConnectionSnapshot } from "../shared/model-connection-types";
import type { QqListenAuthRequirement } from "../shared/qq-listen";
import type { ApprovalRequest, ApprovalSettledPayload } from "../shared/permission-approval";
import type { PluginPanelApi } from "../shared/plugin-management";
import type { ReasoningPreference } from "../shared/reasoning";
import type { AguiRunAck } from "../shared/run-terminal";
import type { ReviewSnapshot, ReviewRestoreOutcome } from "../shared/review-types";
import type { WorkspaceListResult, WorkspaceReadResult, WorkspaceSaveResult } from "../shared/workspace-files-types";
import type { OpenInAppListResult, OpenInAppOpenResult } from "../shared/open-in-app-types";
import { normalizeChatAppearance, type ChatAppearanceSettings } from "../shared/chat-appearance";
import type { AppUpdateApi, AppUpdateState } from "../shared/app-update";
import type { ConversationMode } from "../shared/chat-types";
import type { ToastItem, ToastPushPayload } from "../shared/toast-types";
import { createLive2dWorkApi } from "./live2d-work-api";
import { exposeMusicApi } from "./music";
const pageTargetKey = crypto.randomUUID();
type ChatModeName = "chat" | "work" | "code";
type PluginOverview = import("../shared/plugin-management").PluginOverview;
const fireflyApi = {
    minimize: () => {
        return ipcRenderer.send(IPC.WINDOW_MINIMIZE);
    },
    setInteractive: (interactive: boolean) => {
        return ipcRenderer.invoke(IPC.WINDOW_SET_INTERACTIVE, interactive);
    },
    moveTo: (x: number, y: number) => {
        return ipcRenderer.send(IPC.WINDOW_MOVE_TO, x, y);
    },
    setDragging: (isDragging: boolean) => {
        return ipcRenderer.send(IPC.WINDOW_SET_DRAGGING, isDragging);
    },
    getCursorPosition: () => {
        return ipcRenderer.invoke(IPC.WINDOW_GET_CURSOR_POSITION);
    },
    onPetZoom: (receive: (zoom: number) => void) => {
        const forwardEvent = (_ipcEvent: unknown, zoom: number) => {
            return receive(zoom);
        };
        ipcRenderer.on(IPC.PET_ZOOM, forwardEvent);
        return () => {
            return ipcRenderer.off(IPC.PET_ZOOM, forwardEvent);
        };
    },
    onPetVisibilityChanged: (receive: (visible: boolean) => void) => {
        const forwardEvent = (_ipcEvent: unknown, visible: boolean) => {
            return receive(visible);
        };
        ipcRenderer.on(IPC.PET_VISIBILITY_CHANGED, forwardEvent);
        return () => {
            return ipcRenderer.off(IPC.PET_VISIBILITY_CHANGED, forwardEvent);
        };
    },
};
const appUpdateApi: AppUpdateApi = {
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
            return ipcRenderer.off(IPC.APP_UPDATE_STATE, forwardEvent);
        };
    },
};
const desktopAsrApi: DesktopAsrApi = {
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
contextBridge.exposeInMainWorld("desktopAsr", desktopAsrApi);
const chatApi = {
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
contextBridge.exposeInMainWorld("firefly", fireflyApi);
contextBridge.exposeInMainWorld("appUpdate", appUpdateApi);
contextBridge.exposeInMainWorld("chat", chatApi);
const aguiApi = {
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
            return ipcRenderer.off(IPC.AGUI_EVENT, forwardEvent);
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
    getInterruptedRun: (conversationKey: string) => {
        return ipcRenderer.invoke(IPC.HARNESS_GET_INTERRUPTED_RUN, conversationKey) as Promise<{
            runId: string;
            rounds: number;
            todoCount: number;
            updatedAt: number;
        } | null>;
    },
};
contextBridge.exposeInMainWorld("agui", aguiApi);
const schedulerEventsApi = {
    onEvent: (receive: (eventData: unknown) => void) => {
        const forwardEvent = (_ipcEvent: unknown, eventData: unknown) => {
            try {
                receive(eventData);
            }
            catch (listenerFailure) {
                console.error("[Preload] scheduler listener抛错:", listenerFailure);
            }
        };
        ipcRenderer.on(IPC.SCHEDULER_EVENT, forwardEvent);
        return () => {
            return ipcRenderer.off(IPC.SCHEDULER_EVENT, forwardEvent);
        };
    },
};
contextBridge.exposeInMainWorld("schedulerEvents", schedulerEventsApi);
const choiceApi = {
    resolve: (entityId: string, settingValue: unknown) => {
        return ipcRenderer.invoke(IPC.CHOICE_RESOLVE, typeof settingValue === "string" ? { id: entityId, value: settingValue } : { id: entityId, answer: settingValue });
    },
};
contextBridge.exposeInMainWorld("choice", choiceApi);
const sidebarApi = {
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
contextBridge.exposeInMainWorld("sidebar", sidebarApi);
const toastApi: import("../shared/toast-types").ToastRendererApi = {
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
contextBridge.exposeInMainWorld("toast", toastApi);
const fireflyThemeApi = {
    getColors: () => {
        return ipcRenderer.invoke(IPC.UI_COLORS_GET) as Promise<UiColors>;
    },
    onColorsChanged: (receive: (colors: UiColors) => void) => {
        const forwardEvent = (_ipcEvent: unknown, colors: UiColors) => {
            return receive(colors);
        };
        ipcRenderer.on(IPC.UI_COLORS_CHANGED, forwardEvent);
        return () => {
            return ipcRenderer.removeListener(IPC.UI_COLORS_CHANGED, forwardEvent);
        };
    },
    get: () => {
        return ipcRenderer.invoke(IPC.UI_THEME_GET) as Promise<UiTheme>;
    },
    onChanged: (receive: (theme: UiTheme) => void) => {
        const forwardEvent = (_ipcEvent: unknown, theme: UiTheme) => {
            return receive(theme);
        };
        ipcRenderer.on(IPC.UI_THEME_CHANGED, forwardEvent);
        return () => {
            return ipcRenderer.off(IPC.UI_THEME_CHANGED, forwardEvent);
        };
    },
};
contextBridge.exposeInMainWorld("fireflyTheme", fireflyThemeApi);
const fireflyFontApi = {
    get: () => {
        return ipcRenderer.invoke(IPC.UI_FONT_GET) as Promise<UiFont>;
    },
    onChanged: (receive: (font: UiFont) => void) => {
        const forwardEvent = (_ipcEvent: unknown, font: UiFont) => {
            return receive(font);
        };
        ipcRenderer.on(IPC.UI_FONT_CHANGED, forwardEvent);
        return () => {
            return ipcRenderer.off(IPC.UI_FONT_CHANGED, forwardEvent);
        };
    },
};
contextBridge.exposeInMainWorld("fireflyFont", fireflyFontApi);
const fireflyAppearanceApi = {
    get: async () => {
        return normalizeChatAppearance(await ipcRenderer.invoke(IPC.SETTINGS_GET_GENERAL));
    },
    onChanged: (receive: (settings: ChatAppearanceSettings) => void) => {
        const forwardEvent = (_ipcEvent: Electron.IpcRendererEvent, message: unknown) => {
            receive(normalizeChatAppearance(message));
        };
        ipcRenderer.on(IPC.CHAT_TYPOGRAPHY_CHANGED, forwardEvent);
        return () => {
            ipcRenderer.off(IPC.CHAT_TYPOGRAPHY_CHANGED, forwardEvent);
        };
    },
};
contextBridge.exposeInMainWorld("fireflyAppearance", fireflyAppearanceApi);
type WireTransport = "openai" | "anthropic" | "responses";
type WechatLoginResult = {
    ok: boolean;
    botId?: string;
    error?: string;
};
type ChannelInstallProgress = {
    channel: string;
    phase: string;
    pct: number;
};
type PlanStateChange = {
    conversationId: string;
    state: string;
};
const settingsApi = {
    minimize: () => {
        return ipcRenderer.send(IPC.SETTINGS_MINIMIZE);
    },
    close: () => {
        return ipcRenderer.send(IPC.SETTINGS_CLOSE);
    },
    getConfig: () => {
        return ipcRenderer.invoke(IPC.SETTINGS_GET_CONFIG);
    },
    saveConfig: (settings: unknown) => {
        return ipcRenderer.invoke(IPC.SETTINGS_SAVE_CONFIG, settings);
    },
    listModelProfiles: () => {
        return ipcRenderer.invoke(IPC.SETTINGS_MODEL_PROFILES_LIST);
    },
    getAgentRouting: () => {
        return ipcRenderer.invoke(IPC.SETTINGS_AGENT_ROUTING_GET);
    },
    updateAgentRouting: (request: unknown) => {
        return ipcRenderer.invoke(IPC.SETTINGS_AGENT_ROUTING_UPDATE, request);
    },
    saveModelProfile: (modelProfile: unknown) => {
        return ipcRenderer.invoke(IPC.SETTINGS_MODEL_PROFILE_SAVE, modelProfile);
    },
    deleteModelProfile: (entityId: string) => {
        return ipcRenderer.invoke(IPC.SETTINGS_MODEL_PROFILE_DELETE, entityId);
    },
    setDefaultModelProfile: (entityId: string) => {
        return ipcRenderer.invoke(IPC.SETTINGS_MODEL_PROFILE_SET_DEFAULT, entityId);
    },
    fetchModels: (request: {
        provider: string;
        baseUrl: string;
        apiKey: string;
        explicitTransport?: WireTransport;
    }) => {
        return ipcRenderer.invoke(IPC.SETTINGS_FETCH_MODELS, request);
    },
    resolveInputModalities: (request: {
        provider: string;
        model: string;
        inputModalities?: Array<"text" | "image">;
        inputModalitiesSource?: "vendor-api" | "user";
    }) => {
        return ipcRenderer.invoke(IPC.SETTINGS_RESOLVE_INPUT_MODALITIES, request);
    },
    testConnection: (settings: {
        provider: string;
        baseUrl: string;
        model: string;
        apiKey: string;
        explicitTransport?: WireTransport;
        reasoning?: ReasoningPreference;
    }) => {
        return ipcRenderer.invoke(IPC.SETTINGS_TEST_CONNECTION, settings);
    },
    onSwitchSection: (receive: (section: string) => void) => {
        const forwardEvent = (_ipcEvent: unknown, section: string) => {
            return receive(section);
        };
        ipcRenderer.on(IPC.SETTINGS_SWITCH_SECTION, forwardEvent);
        return () => {
            return ipcRenderer.off(IPC.SETTINGS_SWITCH_SECTION, forwardEvent);
        };
    },
    getGeneral: () => {
        return ipcRenderer.invoke(IPC.SETTINGS_GET_GENERAL);
    },
    saveGeneral: (settings: unknown) => {
        return ipcRenderer.invoke(IPC.SETTINGS_SAVE_GENERAL, settings);
    },
    getTimeoutSettings: () => {
        return ipcRenderer.invoke(IPC.SETTINGS_GET_TIMEOUT_SETTINGS);
    },
    saveTimeoutSettings: (settings: unknown) => {
        return ipcRenderer.invoke(IPC.SETTINGS_SAVE_TIMEOUT_SETTINGS, settings);
    },
    pickUiFont: () => {
        return ipcRenderer.invoke(IPC.SETTINGS_PICK_UI_FONT) as Promise<string | null>;
    },
    importUiFont: (sourcePath: string) => {
        return ipcRenderer.invoke(IPC.SETTINGS_IMPORT_UI_FONT, sourcePath) as Promise<UiFont>;
    },
    resetUiFont: () => {
        return ipcRenderer.invoke(IPC.SETTINGS_RESET_UI_FONT) as Promise<UiFont>;
    },
    setPetAlwaysOnTop: (settingValue: boolean) => {
        return ipcRenderer.send(IPC.SETTINGS_SET_PET_ALWAYS_ON_TOP, settingValue);
    },
    setPetVisible: (settingValue: boolean) => {
        return ipcRenderer.send(IPC.SETTINGS_SET_PET_VISIBLE, settingValue);
    },
    setPetZoom: (settingValue: number) => {
        return ipcRenderer.send(IPC.SETTINGS_SET_PET_ZOOM, settingValue);
    },
    openStickerManager: () => {
        return ipcRenderer.invoke(IPC.SETTINGS_OPEN_STICKER_MANAGER);
    },
    stickerPickFile: () => {
        return ipcRenderer.invoke(IPC.STICKERS_PICK_FILE);
    },
    stickerAdd: (message: {
        sourcePath: string;
        id: string;
        description: string;
        phrases: string[];
    }) => {
        return ipcRenderer.invoke(IPC.STICKERS_ADD, message);
    },
    embeddingSetModel: (model: string) => {
        return ipcRenderer.invoke(IPC.EMBEDDING_SET_MODEL, model);
    },
    rerankerSetMode: (conversationMode: string) => {
        return ipcRenderer.invoke(IPC.RERANKER_SET_MODE, conversationMode);
    },
    getRerankerStatus: (): Promise<{
        light: boolean;
        standard: boolean;
    }> => {
        return ipcRenderer.invoke(IPC.RERANKER_GET_STATUS);
    },
    getToolCatalog: () => {
        return ipcRenderer.invoke(IPC.TOOL_GET_CATALOG);
    },
    getToolModeOverrides: () => {
        return ipcRenderer.invoke(IPC.TOOL_GET_MODE_OVERRIDES);
    },
    setToolModeOverride: (toolId: string, conversationMode: string, active: boolean) => {
        return ipcRenderer.invoke(IPC.TOOL_SET_MODE_OVERRIDE, { toolId, mode: conversationMode, enabled: active });
    },
    externalSkills: {
        list: (sourceId, refresh = false) => {
            return ipcRenderer.invoke(IPC.EXTERNAL_SKILLS_LIST, { sourceId, refresh });
        },
        detail: (sourceId, entityId, selection) => {
            return ipcRenderer.invoke(IPC.EXTERNAL_SKILLS_DETAIL, {
                sourceId,
                id: entityId,
                ...(selection === undefined ? {} : { selection }),
            });
        },
        prepare: (sourceId, entityId, selection) => {
            return ipcRenderer.invoke(IPC.EXTERNAL_SKILLS_PREPARE, {
                sourceId,
                id: entityId,
                ...(selection === undefined ? {} : { selection }),
            });
        },
        commit: (token) => {
            return ipcRenderer.invoke(IPC.EXTERNAL_SKILLS_COMMIT, { token });
        },
        cancel: () => {
            return ipcRenderer.invoke(IPC.EXTERNAL_SKILLS_CANCEL, {});
        },
    } satisfies ExternalSkillsApi,
    setSkillEnabled: (entityId: string, active: boolean) => {
        return ipcRenderer.invoke(IPC.SKILL_SET_ENABLED, { id: entityId, enabled: active });
    },
    getSkillCatalog: () => {
        return ipcRenderer.invoke(IPC.SKILL_GET_CATALOG);
    },
    rescanSkills: () => {
        return ipcRenderer.invoke(IPC.SKILL_RESCAN);
    },
    translateSkillDescriptions: () => {
        return ipcRenderer.invoke(IPC.SKILL_TRANSLATE_DESCRIPTIONS);
    },
    getSkillModeOverrides: () => {
        return ipcRenderer.invoke(IPC.SKILL_GET_MODE_OVERRIDES);
    },
    setSkillModeOverride: (skillId: string, conversationMode: string, active: boolean) => {
        return ipcRenderer.invoke(IPC.SKILL_SET_MODE_OVERRIDE, { skillId, mode: conversationMode, enabled: active });
    },
    addMcpServer: (settings: unknown) => {
        return ipcRenderer.invoke(IPC.MCP_ADD_SERVER, settings);
    },
    removeMcpServer: (serverId: string) => {
        return ipcRenderer.invoke(IPC.MCP_REMOVE_SERVER, serverId);
    },
    listMcpServers: () => {
        return ipcRenderer.invoke(IPC.MCP_LIST_SERVERS);
    },
    setMcpServerEnabled: (serverId: string, active: boolean) => {
        return ipcRenderer.invoke(IPC.MCP_SET_ENABLED, { id: serverId, enabled: active });
    },
    channelsGetConfig: () => {
        return ipcRenderer.invoke(IPC.CHANNELS_GET_CONFIG);
    },
    channelsSaveConfig: (patch: unknown) => {
        return ipcRenderer.invoke(IPC.CHANNELS_SAVE_CONFIG, patch);
    },
    channelsGetStatus: () => {
        return ipcRenderer.invoke(IPC.CHANNELS_GET_STATUS);
    },
    channelsRestart: () => {
        return ipcRenderer.invoke(IPC.CHANNELS_RESTART);
    },
    channelsSenderResolve: (message: {
        channel: string;
        senderId: string;
        action: "approve" | "dismiss";
    }) => {
        return ipcRenderer.invoke(IPC.CHANNELS_SENDER_RESOLVE, message);
    },
    channelsWechatLoginStart: () => {
        return ipcRenderer.invoke(IPC.CHANNELS_WECHAT_LOGIN_START);
    },
    channelsQqTestConnection: () => {
        return ipcRenderer.invoke(IPC.CHANNELS_QQ_TEST_CONNECTION);
    },
    channelsQqResolveAuthRequirement: (request: {
        listenMode: string;
        customHost?: string;
    }) => {
        return ipcRenderer.invoke(IPC.CHANNELS_QQ_RESOLVE_AUTH_REQUIREMENT, request) as Promise<QqListenAuthRequirement>;
    },
    channelsQqBotTestConnection: () => {
        return ipcRenderer.invoke(IPC.CHANNELS_QQBOT_TEST_CONNECTION);
    },
    channelsLogGet: (limit?: number) => {
        return ipcRenderer.invoke(IPC.CHANNELS_LOG_GET, limit ?? 100);
    },
    channelsLogClear: () => {
        return ipcRenderer.invoke(IPC.CHANNELS_LOG_CLEAR);
    },
    channelsContextBindingsGet: () => {
        return ipcRenderer.invoke(IPC.CHANNELS_CONTEXT_BINDINGS_GET);
    },
    channelsContextBind: (message: {
        sessionId: string;
        conversationId: string;
    }) => {
        return ipcRenderer.invoke(IPC.CHANNELS_CONTEXT_BIND, message);
    },
    channelsContextUnbind: (conversationKey: string) => {
        return ipcRenderer.invoke(IPC.CHANNELS_CONTEXT_UNBIND, conversationKey);
    },
    onChannelsInstallProgress: (receive: (p: ChannelInstallProgress) => void) => {
        const forwardEvent = (_ipcEvent: unknown, progress: ChannelInstallProgress) => {
            return receive(progress);
        };
        ipcRenderer.on(IPC.CHANNELS_INSTALL_PROGRESS, forwardEvent);
        return () => {
            return ipcRenderer.off(IPC.CHANNELS_INSTALL_PROGRESS, forwardEvent);
        };
    },
    onChannelsStatusChanged: (receive: (status: unknown) => void) => {
        const forwardEvent = (_ipcEvent: unknown, status: unknown) => {
            return receive(status);
        };
        ipcRenderer.on(IPC.CHANNELS_STATUS_CHANGED, forwardEvent);
        return () => {
            return ipcRenderer.off(IPC.CHANNELS_STATUS_CHANGED, forwardEvent);
        };
    },
    onChannelsWechatQrcode: (receive: (dataUrl: string) => void) => {
        const forwardEvent = (_ipcEvent: unknown, dataUrl: string) => {
            return receive(dataUrl);
        };
        ipcRenderer.on(IPC.CHANNELS_WECHAT_QRCODE, forwardEvent);
        return () => {
            return ipcRenderer.off(IPC.CHANNELS_WECHAT_QRCODE, forwardEvent);
        };
    },
    onChannelsWechatLoginDone: (receive: (message: WechatLoginResult) => void) => {
        const forwardEvent = (_ipcEvent: unknown, message: WechatLoginResult) => {
            return receive(message);
        };
        ipcRenderer.on(IPC.CHANNELS_WECHAT_LOGIN_DONE, forwardEvent);
        return () => {
            return ipcRenderer.off(IPC.CHANNELS_WECHAT_LOGIN_DONE, forwardEvent);
        };
    },
    getPermissionLevel: () => {
        return ipcRenderer.invoke(IPC.PERMISSION_GET_LEVEL);
    },
    setPermissionLevel: (level: string) => {
        return ipcRenderer.invoke(IPC.PERMISSION_SET_LEVEL, level);
    },
    setPlanMode: (message: {
        conversationId: string;
        target: "on" | "off";
        workspaceRoot?: string;
    }) => {
        return ipcRenderer.invoke(IPC.PLAN_SET_MODE, message);
    },
    getPlanState: (conversationId: string) => {
        return ipcRenderer.invoke(IPC.PLAN_GET_STATE, { conversationId });
    },
    onPlanStateChanged: (receive: (message: PlanStateChange) => void) => {
        const forwardEvent = (_ipcEvent: Electron.IpcRendererEvent, message: PlanStateChange) => {
            return receive(message);
        };
        ipcRenderer.on(IPC.PLAN_STATE_CHANGED, forwardEvent);
        return () => {
            return ipcRenderer.removeListener(IPC.PLAN_STATE_CHANGED, forwardEvent);
        };
    },
    onPermissionApprovalRequest: (receive: (req: ApprovalRequest) => void): (() => void) => {
        const forwardEvent = (_ipcEvent: Electron.IpcRendererEvent, req: Parameters<typeof receive>[0]) => {
            return receive(req);
        };
        ipcRenderer.on(IPC.PERMISSION_APPROVAL_REQUEST, forwardEvent);
        return () => {
            return ipcRenderer.removeListener(IPC.PERMISSION_APPROVAL_REQUEST, forwardEvent);
        };
    },
    resolvePermissionApproval: (entityId: string, allowed: boolean): Promise<{
        ok: boolean;
    }> => {
        return ipcRenderer.invoke(IPC.PERMISSION_APPROVAL_RESOLVE, { id: entityId, allowed });
    },
    onPermissionApprovalSettled: (receive: (settlement: ApprovalSettledPayload) => void): (() => void) => {
        const forwardEvent = (_ipcEvent: Electron.IpcRendererEvent, settlement: Parameters<typeof receive>[0]) => {
            return receive(settlement);
        };
        ipcRenderer.on(IPC.PERMISSION_APPROVAL_SETTLED, forwardEvent);
        return () => {
            return ipcRenderer.removeListener(IPC.PERMISSION_APPROVAL_SETTLED, forwardEvent);
        };
    },
    onPopQuizRequest: (receive: (card: {
        quizId: string;
        runId: string;
        intro: string;
        questions: unknown[];
    }) => void): (() => void) => {
        const forwardEvent = (_ipcEvent: Electron.IpcRendererEvent, card: Parameters<typeof receive>[0]) => {
            return receive(card);
        };
        ipcRenderer.on(IPC.POP_QUIZ_REQUEST, forwardEvent);
        return () => {
            return ipcRenderer.removeListener(IPC.POP_QUIZ_REQUEST, forwardEvent);
        };
    },
    resolvePopQuiz: (submission: unknown): Promise<{
        ok: boolean;
        error?: string;
        graded?: unknown[];
    }> => {
        return ipcRenderer.invoke(IPC.POP_QUIZ_RESOLVE, submission);
    },
    skipPopQuiz: (quizId: string): Promise<{
        ok: boolean;
        error?: string;
    }> => {
        return ipcRenderer.invoke(IPC.POP_QUIZ_SKIP, { quizId });
    },
    onPopQuizSettled: (receive: (settlement: {
        quizId: string;
        runId?: string;
        reason: "submitted" | "skipped" | "cancelled";
    }) => void): (() => void) => {
        const forwardEvent = (_ipcEvent: Electron.IpcRendererEvent, settlement: Parameters<typeof receive>[0]) => {
            return receive(settlement);
        };
        ipcRenderer.on(IPC.POP_QUIZ_SETTLED, forwardEvent);
        return () => {
            return ipcRenderer.removeListener(IPC.POP_QUIZ_SETTLED, forwardEvent);
        };
    },
    beginScreenshotHotkeyCapture: () => {
        return ipcRenderer.invoke(IPC.SCREENSHOT_HOTKEY_CAPTURE_START);
    },
    endScreenshotHotkeyCapture: () => {
        return ipcRenderer.invoke(IPC.SCREENSHOT_HOTKEY_CAPTURE_END);
    },
};
contextBridge.exposeInMainWorld("settings", settingsApi);
const pluginsApi = {
    onChanged: (receive: (overview: PluginOverview) => void) => {
        const forwardEvent = (_ipcEvent: Electron.IpcRendererEvent, overview: PluginOverview) => {
            return receive(overview);
        };
        ipcRenderer.on(IPC.PLUGINS_CHANGED, forwardEvent);
        return () => {
            return ipcRenderer.off(IPC.PLUGINS_CHANGED, forwardEvent);
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
contextBridge.exposeInMainWorld("plugins", pluginsApi);
const pluginPanelApi: PluginPanelApi = {
    invoke: (pluginId, channelName, values) => {
        return ipcRenderer.invoke(IPC.PLUGINS_PANEL_INVOKE, pluginId, channelName, values);
    },
};
contextBridge.exposeInMainWorld("pluginPanel", pluginPanelApi);
const schedulerApi = {
    list: () => {
        return ipcRenderer.invoke(IPC.SCHEDULER_LIST);
    },
    add: (request: unknown) => {
        return ipcRenderer.invoke(IPC.SCHEDULER_ADD, request);
    },
    update: (entityId: string, patch: unknown) => {
        return ipcRenderer.invoke(IPC.SCHEDULER_UPDATE, entityId, patch);
    },
    delete: (entityId: string) => {
        return ipcRenderer.invoke(IPC.SCHEDULER_DELETE, entityId);
    },
    toggle: (entityId: string, active: boolean) => {
        return ipcRenderer.invoke(IPC.SCHEDULER_TOGGLE, entityId, active);
    },
    fireNow: (entityId: string) => {
        return ipcRenderer.invoke(IPC.SCHEDULER_FIRE_NOW, entityId);
    },
    getHistory: (taskId: string, limit?: number) => {
        return ipcRenderer.invoke(IPC.SCHEDULER_GET_HISTORY, taskId, limit);
    },
    getTools: () => {
        return ipcRenderer.invoke(IPC.SCHEDULER_GET_TOOLS);
    },
};
contextBridge.exposeInMainWorld("fireflyScheduler", schedulerApi);
const stickerManagerApi = {
    minimize: () => {
        return ipcRenderer.send(IPC.STICKERS_MINIMIZE);
    },
    close: () => {
        return ipcRenderer.send(IPC.STICKERS_CLOSE);
    },
    getConfig: () => {
        return ipcRenderer.invoke(IPC.STICKERS_GET_CONFIG);
    },
    setEnabled: (entityId: string, active: boolean) => {
        return ipcRenderer.invoke(IPC.STICKERS_SET_ENABLED, { id: entityId, enabled: active });
    },
};
contextBridge.exposeInMainWorld("stickerManager", stickerManagerApi);
const modelConfigApi = {
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
contextBridge.exposeInMainWorld("modelConfig", modelConfigApi);
const withTab = (tabId: string | undefined) => {
    return (tabId === undefined ? {} : { tabId });
};
const manualBrowser: BrowserAvailabilityApi = {
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
contextBridge.exposeInMainWorld("manualBrowser", manualBrowser);
const browserWorkspaceCommand = (message: object) => {
    return ipcRenderer.invoke(MANUAL_BROWSER_WORKSPACE_IPC.command, message);
};
const manualBrowserWorkspace: ManualBrowserWorkspaceApi = {
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
contextBridge.exposeInMainWorld("manualBrowserWorkspace", manualBrowserWorkspace);
const userApi = {
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
            return ipcRenderer.off(IPC.USER_PROFILE_CHANGED, forwardEvent);
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
            return ipcRenderer.off(IPC.USER_AVATAR_CHANGED, forwardEvent);
        };
    },
};
const memoryPanelApi = {
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
contextBridge.exposeInMainWorld("user", userApi);
contextBridge.exposeInMainWorld("memoryPanel", memoryPanelApi);
const memoryAutomationApi: MemoryAutomationPanelApi = {
    state: () => {
        return ipcRenderer.invoke(IPC.MEMORY_AUTOMATION_STATE);
    },
    configure: (request) => {
        return ipcRenderer.invoke(IPC.MEMORY_AUTOMATION_CONFIGURE, request);
    },
};
contextBridge.exposeInMainWorld("memoryAutomation", memoryAutomationApi);
contextBridge.exposeInMainWorld("live2dWork", createLive2dWorkApi(ipcRenderer));
const chatStoreApi = {
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
    onChanged: (receive: () => void) => {
        const forwardEvent = () => {
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
contextBridge.exposeInMainWorld("chatStore", chatStoreApi);
const reviewApi = {
    get: (runId: string) => {
        return ipcRenderer.invoke(IPC.REVIEW_GET, runId) as Promise<ReviewSnapshot | null>;
    },
    restore: (runId: string) => {
        return ipcRenderer.invoke(IPC.REVIEW_RESTORE, runId) as Promise<ReviewRestoreOutcome>;
    },
};
contextBridge.exposeInMainWorld("review", reviewApi);
const workspaceFilesApi = {
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
contextBridge.exposeInMainWorld("workspaceFiles", workspaceFilesApi);
const openInAppApi = {
    listApps: (conversationKey: string) => {
        return ipcRenderer.invoke(IPC.WORKSPACE_OPEN_IN_LIST_APPS, { sessionId: conversationKey }) as Promise<OpenInAppListResult>;
    },
    open: (conversationKey: string, appId: string) => {
        return ipcRenderer.invoke(IPC.WORKSPACE_OPEN_IN, { sessionId: conversationKey, appId }) as Promise<OpenInAppOpenResult>;
    },
};
contextBridge.exposeInMainWorld("openInApp", openInAppApi);
const codeGitApi = {
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
contextBridge.exposeInMainWorld("codeGit", codeGitApi);
const tokenUsageApi = {
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
contextBridge.exposeInMainWorld("tokenUsage", tokenUsageApi);
exposeMusicApi();
