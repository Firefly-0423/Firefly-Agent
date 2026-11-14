import type {} from "electron";
import { normalizeChatDisplay, type ChatDisplaySettings } from "../shared/chat-appearance";
import { IPC } from "../shared/ipc-channels";
import type { UiColors } from "../shared/ui-colors";
import type { UiFont } from "../shared/ui-font";
import type { UiTheme } from "../shared/ui-theme";

export interface AppearanceIpcRenderer {
    invoke: (channel: string, ...args: unknown[]) => Promise<any>;
    send: (channel: string, ...args: unknown[]) => void;
    on: (channel: string, listener: (event: any, ...args: any[]) => void) => unknown;
    removeListener: (channel: string, listener: (event: any, ...args: any[]) => void) => unknown;
}

export function createFireflyThemeApi(ipcRenderer: AppearanceIpcRenderer) {
    return {
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
                return ipcRenderer.removeListener(IPC.UI_THEME_CHANGED, forwardEvent);
            };
        },
    };
}

export function createFireflyFontApi(ipcRenderer: AppearanceIpcRenderer) {
    return {
        get: () => {
            return ipcRenderer.invoke(IPC.UI_FONT_GET) as Promise<UiFont>;
        },
        onChanged: (receive: (font: UiFont) => void) => {
            const forwardEvent = (_ipcEvent: unknown, font: UiFont) => {
                return receive(font);
            };
            ipcRenderer.on(IPC.UI_FONT_CHANGED, forwardEvent);
            return () => {
                return ipcRenderer.removeListener(IPC.UI_FONT_CHANGED, forwardEvent);
            };
        },
    };
}

export function createFireflyAppearanceApi(ipcRenderer: AppearanceIpcRenderer) {
    return {
        get: async () => {
            return normalizeChatDisplay(await ipcRenderer.invoke(IPC.SETTINGS_GET_GENERAL));
        },
        onChanged: (receive: (settings: ChatDisplaySettings) => void) => {
            const forwardEvent = (_ipcEvent: Electron.IpcRendererEvent, message: unknown) => {
                receive(normalizeChatDisplay(message));
            };
            ipcRenderer.on(IPC.CHAT_TYPOGRAPHY_CHANGED, forwardEvent);
            return () => {
                ipcRenderer.removeListener(IPC.CHAT_TYPOGRAPHY_CHANGED, forwardEvent);
            };
        },
    };
}

export function createStickerManagerApi(ipcRenderer: AppearanceIpcRenderer) {
    return {
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
}
