import { IPC } from "../../shared/ipc-channels";
import type { QqListenAuthRequirement } from "../../shared/qq-listen";

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

/** window.settings 的外部渠道：配置、状态、登录、连接测试、日志、上下文绑定与事件。 */
export function createSettingsChannelMethods(ipcRenderer: Electron.IpcRenderer) {
    return {
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
    };
}
