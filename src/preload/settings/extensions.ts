import { IPC } from "../../shared/ipc-channels";
import type { ExternalSkillsApi } from "../../shared/external-skills";

/** window.settings 的贴纸、嵌入与重排、工具、外部技能、技能与 MCP 方法。 */
export function createSettingsExtensionMethods(ipcRenderer: Electron.IpcRenderer) {
    return {
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
    };
}
