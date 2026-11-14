import { IPC } from "../../shared/ipc-channels";
import type { ReasoningPreference } from "../../shared/reasoning";
import type { UiFont } from "../../shared/ui-font";

type WireTransport = "openai" | "anthropic" | "responses";

/** window.settings 的配置、模型档案、模型列表、通用设置、超时、字体与桌宠方法。 */
export function createSettingsCoreMethods(ipcRenderer: Electron.IpcRenderer) {
    return {
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
    };
}
