import * as fs from "fs";
import * as path from "path";
import { dialog } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import { IPC } from "../../shared/ipc-channels";
import type { ConversationMode } from "../../shared/chat-types";
import { createIpcScope, type IpcScope } from "../application/ipc-scope";
import { getStickerManagerConfig, setStickerEnabled } from "../orchestrator/sticker-settings";
import { addUserSticker } from "../stickers/sticker-storage";
import { registerMcpManagementIpc } from "../orchestrator/mcp-management-ipc";
import { toolRegistry } from "../orchestrator/tools/registry/tool-registry";
import { loadGeneralSettings, saveGeneralSettings } from "../settings/settings-facade";
import { loadModelSettings, resolveModelSettingsProfile } from "../settings/model-settings";
import { createLlmClient } from "../services/llm/llm-client";
import { cachedZhMap, parseTranslation, translateMissing, translationMessages } from "../skills/skill-description-zh";
import { isTrustedExternalMainFrame } from "../skills/external-ipc";
import { isExternalSkillId } from "../skills/skill-scanner";
import { setSkillEnabled, skillRegistry, rescanSkills } from "../skills";
import type { SkillMode } from "../skills/types";
import { loadUserProfile, saveUserProfile, getAvatarPath } from "../storage/settings-store";
import { deleteImportedDoc } from "../rag";
import { loadImportedDocumentPanelData, loadMemoryPanelData } from "./panel";
import type { WindowManager } from "../windows/window-manager";
import { stickerManagerWindow, settingsWindow, sidebarWindow, reactChatWindow } from "../windows/window-state";
import type { EmbeddingIndexService } from "../services/embedding/embedding-index-service";

export type MemoryUserToolIpcDependencies = {
  /** 传入共享 scope 以便退出时统一注销；缺省时使用独立 scope。 */
  ipc?: IpcScope;
  /** Main 装配决定，Renderer payload 不能启用旧个人记忆。 */
  personalMemoryMode?: "legacy" | "smh";
  embeddingIndexService: EmbeddingIndexService;
  get windowManager(): WindowManager | null;
};

/** 向仍存活的辅助窗口广播同一条消息 */
function broadcastToAuxWindows(channel: string, payload: unknown): void {
  [reactChatWindow, sidebarWindow, settingsWindow]
    .filter((win) => win && !win.isDestroyed())
    .forEach((win) => win!.webContents.send(channel, payload));
}

const AVATAR_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

const STICKER_FILE_FILTERS = [{ name: "图片", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }];
const AVATAR_FILE_FILTERS = [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "bmp"] }];

/** 把某个 id 在指定模式下的开关合并进覆盖层，返回新对象（不改入参） */
function withModeOverride<M extends string>(
  before: Record<string, Partial<Record<M, boolean>>>,
  id: string,
  mode: M,
  enabled: boolean,
): Record<string, Partial<Record<M, boolean>>> {
  const next = { ...before };
  next[id] = { ...(next[id] ?? {}), [mode]: enabled } as Partial<Record<M, boolean>>;
  return next;
}

export function registerMemoryUserToolIpc(deps: MemoryUserToolIpcDependencies): void {
  const ipc = deps.ipc ?? createIpcScope();
  const personalMemoryRetired = deps.personalMemoryMode === "smh";
  const { embeddingIndexService } = deps;
  // 注意：windowManager 不能解构，必须每次通过 deps.windowManager 读取 getter。
  // 本函数在模块加载阶段调用，此时 windowManager 还是 null，解构会把 null 固化下来，
  // 之后的 ?. 就永远短路（表情包管理窗口打不开）。

  // ───── 处理函数（注册顺序见下方） ─────

  const openStickerManager = async () => {
    console.log("[stickers] open sticker manager requested");
    return deps.windowManager?.createStickerManagerWindow();
  };

  const minimizeStickerManager = () => {
    stickerManagerWindow?.minimize();
  };

  const closeStickerManager = () => {
    stickerManagerWindow?.close();
  };

  const setStickerSwitch = (_event: unknown, payload: unknown) => {
    const record = payload as { id?: unknown; enabled?: unknown };
    const id = typeof record?.id === "string" ? record.id : null;
    if (id) setStickerEnabled(id, Boolean(record.enabled));
    return getStickerManagerConfig();
  };

  const pickStickerFile = async () => {
    const picked = await dialog.showOpenDialog({ properties: ["openFile"], filters: STICKER_FILE_FILTERS });
    return picked.canceled ? null : picked.filePaths[0];
  };

  const addSticker = async (_event: unknown, payload: unknown) => {
    type NewSticker = { phrases: string[]; description: string; id: string; sourcePath: string };
    const { sourcePath, id, description, phrases } = payload as NewSticker;
    const refreshIndex = () => {
      embeddingIndexService.invalidateStickerEmbeddingIndex();
      embeddingIndexService.refreshStickerEmbeddingIndex("user-sticker-add");
    };
    try {
      await addUserSticker(sourcePath, id, description, phrases);
      refreshIndex();
    } catch (err) {
      // 入库或刷新索引任一步失败都要记录并继续向上抛
      console.error("[stickers] add failed:", err);
      throw err;
    }
    return getStickerManagerConfig();
  };

  const readAvatarDataUrl = () => {
    const file = getAvatarPath();
    if (!fs.existsSync(file)) return null;
    const bytes = fs.readFileSync(file);
    const mime = AVATAR_MIME_BY_EXT[path.extname(file).toLowerCase()] ?? "image/png";
    return "data:" + mime + ";base64," + bytes.toString("base64");
  };

  const getPanelData = () => {
    if (personalMemoryRetired) return loadImportedDocumentPanelData();
    return loadMemoryPanelData();
  };

  const deleteImportedDocument = (_event: unknown, payload: { importId: string; fileName?: string }) => ({
    ok: true,
    deleted: deleteImportedDoc(payload.importId, payload.fileName),
  });

  const saveProfile = (_event: unknown, profile: Partial<{ avatarPath?: string } & Record<string, unknown>>) => {
    const saved = saveUserProfile(profile);
    broadcastToAuxWindows(IPC.USER_PROFILE_CHANGED, saved);
    return saved;
  };

  const uploadAvatar = async () => {
    const picked = await dialog.showOpenDialog({ properties: ["openFile"], filters: AVATAR_FILE_FILTERS });
    if (picked.canceled || picked.filePaths.length === 0) return null;
    const avatarPath = getAvatarPath();
    fs.mkdirSync(path.dirname(avatarPath), { recursive: true });
    fs.copyFileSync(picked.filePaths[0], avatarPath);
    const profile = saveUserProfile({ avatarPath });
    broadcastToAuxWindows(IPC.USER_AVATAR_CHANGED, null);
    return { avatarPath, profile };
  };

  // 目录只暴露可序列化字段（不含 execute / zod schema），供工具页展示
  const listToolCatalog = () => {
    const entries = toolRegistry.getAllTools();
    return entries.map(({ id, name, description, enabled, modes, chatBuiltin, deprecated }) => ({
      id,
      name,
      description,
      enabled,
      modes: modes ?? null,
      chatBuiltin: chatBuiltin === true,
      deprecated: deprecated ?? null,
    }));
  };

  const setToolModeOverride = (_event: unknown, payload: unknown) => {
    const p = payload as { toolId?: string; mode?: string; enabled?: boolean };
    if (!p.toolId || !p.mode) return { ok: false, error: "missing toolId or mode" };
    if (!["chat", "work", "code"].includes(p.mode)) return { ok: false, error: "invalid mode" };
    const mode = p.mode as ConversationMode;
    const enabled = p.enabled !== false;
    saveGeneralSettings({ toolModeOverrides: withModeOverride(loadGeneralSettings().toolModeOverrides, p.toolId, mode, enabled) });
    console.log(`[Tool] override ${p.toolId}@${mode}=${enabled}`);
    return { ok: true };
  };

  const toggleSkill = (event: IpcMainInvokeEvent, payload: unknown) => {
    const invalid = { ok: false, error: "Invalid Skill enable request." };
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return invalid;
    const p = payload as { id?: unknown; enabled?: unknown };
    if (typeof p.id !== "string" || !p.id || typeof p.enabled !== "boolean" || !skillRegistry.getById(p.id)) return invalid;
    if (isExternalSkillId(p.id)) {
      const hasExtraKeys = Reflect.ownKeys(payload).some((key) => key !== "id" && key !== "enabled");
      const chatContents = reactChatWindow && !reactChatWindow.isDestroyed() ? reactChatWindow.webContents : null;
      if (hasExtraKeys || !isTrustedExternalMainFrame(event, chatContents)) {
        return { ok: false, error: "External Skill enable request is not permitted." };
      }
    }
    try {
      setSkillEnabled(p.id, p.enabled);
      return { ok: true };
    } catch {
      return { ok: false, error: "Skill state could not be saved or verified. Refresh before trying again." };
    }
  };

  // 目录只暴露可序列化字段；hiddenFromUi 的技能（如角色语气校准）不在设置面板显示
  const listSkillCatalog = () => {
    const visible = skillRegistry.getAll().filter((s) => !s.hiddenFromUi);
    const zh = cachedZhMap(visible);
    return visible.map((skill) => {
      const { id, name, description, enabled, source, version, references, external } = skill;
      return {
        descriptionZh: zh[id],
        id,
        name,
        description,
        enabled,
        source,
        modes: skill.modes ?? null,
        version,
        references,
        external,
      };
    });
  };

  // 技能页打开时，把还没有中文的描述交给默认模型翻一次，存在本机（不改技能文件），返回所有已知中文描述
  const translateSkillDescriptions = async () => {
    const visible = skillRegistry.getAll()
      .filter((s) => !s.hiddenFromUi)
      .map((s) => ({ id: s.id, description: s.description }));
    try {
      const settings = resolveModelSettingsProfile(loadModelSettings());
      const client = createLlmClient();
      const translated = await translateMissing(visible, async (batch) => {
        const reply = await client.chatNonStream(settings, translationMessages(batch), 0, 90_000, "skill-description-zh");
        return parseTranslation(reply.text, batch);
      });
      return { ok: true, translated };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error), translated: cachedZhMap(visible) };
    }
  };

  const setSkillModeOverride = (_event: unknown, payload: unknown) => {
    const p = payload as { skillId?: string; mode?: string; enabled?: boolean };
    if (!p.skillId || !p.mode) return { ok: false, error: "missing skillId or mode" };
    if (!["work", "code"].includes(p.mode)) return { ok: false, error: "invalid mode" };
    const mode = p.mode as SkillMode;
    const enabled = p.enabled !== false;
    saveGeneralSettings({ skillModeOverrides: withModeOverride(loadGeneralSettings().skillModeOverrides, p.skillId, mode, enabled) });
    console.log(`[Skill] override ${p.skillId}@${mode}=${enabled}`);
    return { ok: true };
  };

  // ───── 注册（顺序与历史保持一致） ─────

  ipc.handle(IPC.SETTINGS_OPEN_STICKER_MANAGER, openStickerManager);
  ipc.on(IPC.STICKERS_MINIMIZE, minimizeStickerManager);
  ipc.on(IPC.STICKERS_CLOSE, closeStickerManager);
  ipc.handle(IPC.STICKERS_GET_CONFIG, () => getStickerManagerConfig());
  ipc.handle(IPC.STICKERS_SET_ENABLED, setStickerSwitch);
  ipc.handle(IPC.STICKERS_PICK_FILE, pickStickerFile);
  ipc.handle(IPC.STICKERS_ADD, addSticker);
  ipc.handle(IPC.STICKERS_GET_ENABLED, () => getStickerManagerConfig().filter((s) => s.enabled));

  ipc.handle(IPC.USER_GET_AVATAR, readAvatarDataUrl);

  ipc.handle(IPC.MEMORY_PANEL_GET_DATA, getPanelData);
  ipc.handle(IPC.MEMORY_PANEL_DELETE_IMPORTED_DOC, deleteImportedDocument);

  ipc.handle(IPC.USER_GET_PROFILE, () => loadUserProfile());
  ipc.handle(IPC.USER_SAVE_PROFILE, saveProfile);
  ipc.handle(IPC.USER_UPLOAD_AVATAR, uploadAvatar);

  registerMcpManagementIpc({ ipc, getSettingsWindow: () => settingsWindow });

  ipc.handle(IPC.TOOL_GET_CATALOG, listToolCatalog);
  // 覆盖层存在 general-settings.toolModeOverrides，优先于工具自己声明的 modes
  ipc.handle(IPC.TOOL_GET_MODE_OVERRIDES, () => loadGeneralSettings().toolModeOverrides);
  ipc.handle(IPC.TOOL_SET_MODE_OVERRIDE, setToolModeOverride);

  ipc.handle(IPC.SKILL_SET_ENABLED, toggleSkill);
  ipc.handle(IPC.SKILL_GET_CATALOG, listSkillCatalog);
  ipc.handle(IPC.SKILL_TRANSLATE_DESCRIPTIONS, translateSkillDescriptions);
  // 重新扫描用户 skills 目录：安装或删除 skill 后无需重启即可刷新界面
  ipc.handle(IPC.SKILL_RESCAN, () => ({ ok: true, count: rescanSkills() }));
  // 覆盖层存在 general-settings.skillModeOverrides，优先于 skill 自己声明的 modes
  ipc.handle(IPC.SKILL_GET_MODE_OVERRIDES, () => loadGeneralSettings().skillModeOverrides);
  ipc.handle(IPC.SKILL_SET_MODE_OVERRIDE, setSkillModeOverride);
}
