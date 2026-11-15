import { contextBridge, ipcRenderer, webUtils } from "electron";
import { IPC } from "../shared/ipc-channels";
import type { ExternalSkillsApi } from "../shared/external-skills";
import type { UiFont } from "../shared/ui-font";
import type { QqListenAuthRequirement } from "../shared/qq-listen";
import type { ApprovalRequest, ApprovalSettledPayload } from "../shared/permission-approval";
import type { ReasoningPreference } from "../shared/reasoning";
import { createAguiApi, createChatStoreApi } from "./agui";
import { createFireflyAppearanceApi, createFireflyFontApi, createFireflyThemeApi, createStickerManagerApi } from "./appearance";
import { createManualBrowserApi, createManualBrowserWorkspaceApi } from "./browser";
import { createChatApi, createChoiceApi, createDesktopAsrApi } from "./chat-media";
import { createLive2dWorkApi } from "./live2d-work-api";
import { createMemoryAutomationApi, createMemoryPanelApi, createUserApi } from "./memory-user";
import { createModelConfigApi, createTokenUsageApi } from "./model-config";
import { exposeMusicApi } from "./music";
import { createFireflyApi } from "./pet";
import { createPluginPanelApi, createPluginsApi } from "./plugins";
import { createSchedulerApi, createSchedulerEventsApi } from "./scheduler";
import { createAppUpdateApi, createSidebarApi, createToastApi } from "./window-shell";
import { createCodeGitApi, createOpenInAppApi, createReviewApi, createWorkspaceFilesApi } from "./workspace";
const pageTargetKey = crypto.randomUUID();
contextBridge.exposeInMainWorld("desktopAsr", createDesktopAsrApi(ipcRenderer));
contextBridge.exposeInMainWorld("firefly", createFireflyApi(ipcRenderer));
contextBridge.exposeInMainWorld("appUpdate", createAppUpdateApi(ipcRenderer));
contextBridge.exposeInMainWorld("chat", createChatApi(ipcRenderer, webUtils));
contextBridge.exposeInMainWorld("agui", createAguiApi(ipcRenderer));
contextBridge.exposeInMainWorld("schedulerEvents", createSchedulerEventsApi(ipcRenderer));
contextBridge.exposeInMainWorld("choice", createChoiceApi(ipcRenderer));
contextBridge.exposeInMainWorld("sidebar", createSidebarApi(ipcRenderer));
contextBridge.exposeInMainWorld("toast", createToastApi(ipcRenderer));
contextBridge.exposeInMainWorld("fireflyTheme", createFireflyThemeApi(ipcRenderer));
contextBridge.exposeInMainWorld("fireflyFont", createFireflyFontApi(ipcRenderer));
contextBridge.exposeInMainWorld("fireflyAppearance", createFireflyAppearanceApi(ipcRenderer));
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
            return ipcRenderer.removeListener(IPC.SETTINGS_SWITCH_SECTION, forwardEvent);
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
            return ipcRenderer.removeListener(IPC.CHANNELS_INSTALL_PROGRESS, forwardEvent);
        };
    },
    onChannelsStatusChanged: (receive: (status: unknown) => void) => {
        const forwardEvent = (_ipcEvent: unknown, status: unknown) => {
            return receive(status);
        };
        ipcRenderer.on(IPC.CHANNELS_STATUS_CHANGED, forwardEvent);
        return () => {
            return ipcRenderer.removeListener(IPC.CHANNELS_STATUS_CHANGED, forwardEvent);
        };
    },
    onChannelsWechatQrcode: (receive: (dataUrl: string) => void) => {
        const forwardEvent = (_ipcEvent: unknown, dataUrl: string) => {
            return receive(dataUrl);
        };
        ipcRenderer.on(IPC.CHANNELS_WECHAT_QRCODE, forwardEvent);
        return () => {
            return ipcRenderer.removeListener(IPC.CHANNELS_WECHAT_QRCODE, forwardEvent);
        };
    },
    onChannelsWechatLoginDone: (receive: (message: WechatLoginResult) => void) => {
        const forwardEvent = (_ipcEvent: unknown, message: WechatLoginResult) => {
            return receive(message);
        };
        ipcRenderer.on(IPC.CHANNELS_WECHAT_LOGIN_DONE, forwardEvent);
        return () => {
            return ipcRenderer.removeListener(IPC.CHANNELS_WECHAT_LOGIN_DONE, forwardEvent);
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
contextBridge.exposeInMainWorld("plugins", createPluginsApi(ipcRenderer));
contextBridge.exposeInMainWorld("pluginPanel", createPluginPanelApi(ipcRenderer));
contextBridge.exposeInMainWorld("fireflyScheduler", createSchedulerApi(ipcRenderer));
contextBridge.exposeInMainWorld("stickerManager", createStickerManagerApi(ipcRenderer));
contextBridge.exposeInMainWorld("modelConfig", createModelConfigApi(ipcRenderer));
contextBridge.exposeInMainWorld("manualBrowser", createManualBrowserApi(ipcRenderer));
contextBridge.exposeInMainWorld("manualBrowserWorkspace", createManualBrowserWorkspaceApi(ipcRenderer));
contextBridge.exposeInMainWorld("user", createUserApi(ipcRenderer));
contextBridge.exposeInMainWorld("memoryPanel", createMemoryPanelApi(ipcRenderer));
contextBridge.exposeInMainWorld("memoryAutomation", createMemoryAutomationApi(ipcRenderer));
contextBridge.exposeInMainWorld("live2dWork", createLive2dWorkApi(ipcRenderer));
contextBridge.exposeInMainWorld("chatStore", createChatStoreApi(ipcRenderer, pageTargetKey));
contextBridge.exposeInMainWorld("review", createReviewApi(ipcRenderer));
contextBridge.exposeInMainWorld("workspaceFiles", createWorkspaceFilesApi(ipcRenderer));
contextBridge.exposeInMainWorld("openInApp", createOpenInAppApi(ipcRenderer));
contextBridge.exposeInMainWorld("codeGit", createCodeGitApi(ipcRenderer));
contextBridge.exposeInMainWorld("tokenUsage", createTokenUsageApi(ipcRenderer));
exposeMusicApi();
