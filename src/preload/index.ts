import { contextBridge, ipcRenderer, webUtils } from "electron";
import { IPC } from "../shared/ipc-channels";
import type { UiFont } from "../shared/ui-font";
import type { QqListenAuthRequirement } from "../shared/qq-listen";
import type { ApprovalRequest, ApprovalSettledPayload } from "../shared/permission-approval";
import { createAguiApi, createChatStoreApi } from "./agui";
import { createFireflyAppearanceApi, createFireflyFontApi, createFireflyThemeApi, createStickerManagerApi } from "./appearance";
import { createManualBrowserApi, createManualBrowserWorkspaceApi } from "./browser";
import { createChatApi, createChoiceApi, createDesktopAsrApi } from "./chat-media";
import { createLive2dWorkApi } from "./live2d-work-api";
import { createSettingsCoreMethods } from "./settings/core";
import { createSettingsExtensionMethods } from "./settings/extensions";
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
    ...createSettingsCoreMethods(ipcRenderer),
    ...createSettingsExtensionMethods(ipcRenderer),
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
