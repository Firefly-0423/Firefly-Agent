import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  reactChatWindow: null as unknown,
  sidebarWindow: null as unknown,
  settingsWindow: null as unknown,
  stickerManagerWindow: null as unknown,
  windowManager: null as unknown,
}));

const mocks = vi.hoisted(() => ({
  showOpenDialog: vi.fn(),
  cachedZhMap: vi.fn(),
  parseTranslation: vi.fn(),
  translateMissing: vi.fn(),
  translationMessages: vi.fn(),
  createLlmClient: vi.fn(),
  chatNonStream: vi.fn(),
  loadModelSettings: vi.fn(),
  resolveModelSettingsProfile: vi.fn(),
  isTrustedExternalMainFrame: vi.fn(),
  isExternalSkillId: vi.fn(),
  getStickerManagerConfig: vi.fn(),
  setStickerEnabled: vi.fn(),
  addUserSticker: vi.fn(),
  loadImportedDocumentPanelData: vi.fn(),
  loadMemoryPanelData: vi.fn(),
  deleteImportedDoc: vi.fn(),
  loadUserProfile: vi.fn(),
  saveUserProfile: vi.fn(),
  getAvatarPath: vi.fn(),
  registerMcpManagementIpc: vi.fn(),
  getAllTools: vi.fn(),
  loadGeneralSettings: vi.fn(),
  saveGeneralSettings: vi.fn(),
  setSkillEnabled: vi.fn(),
  skillGetById: vi.fn(),
  skillGetAll: vi.fn(),
  rescanSkills: vi.fn(),
  invalidateStickerEmbeddingIndex: vi.fn(),
  refreshStickerEmbeddingIndex: vi.fn(),
}));

vi.mock("electron", () => ({
  dialog: { showOpenDialog: mocks.showOpenDialog },
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn(), removeListener: vi.fn() },
}));
vi.mock("../skills/skill-description-zh", () => ({
  cachedZhMap: mocks.cachedZhMap,
  parseTranslation: mocks.parseTranslation,
  translateMissing: mocks.translateMissing,
  translationMessages: mocks.translationMessages,
}));
vi.mock("../services/llm/llm-client", () => ({ createLlmClient: mocks.createLlmClient }));
vi.mock("../settings/model-settings", () => ({
  loadModelSettings: mocks.loadModelSettings,
  resolveModelSettingsProfile: mocks.resolveModelSettingsProfile,
}));
vi.mock("../skills/external-ipc", () => ({ isTrustedExternalMainFrame: mocks.isTrustedExternalMainFrame }));
vi.mock("../skills/skill-scanner", () => ({ isExternalSkillId: mocks.isExternalSkillId }));
vi.mock("../orchestrator/sticker-settings", () => ({
  getStickerManagerConfig: mocks.getStickerManagerConfig,
  setStickerEnabled: mocks.setStickerEnabled,
}));
vi.mock("../stickers/sticker-storage", () => ({ addUserSticker: mocks.addUserSticker }));
vi.mock("./panel", () => ({
  loadImportedDocumentPanelData: mocks.loadImportedDocumentPanelData,
  loadMemoryPanelData: mocks.loadMemoryPanelData,
}));
vi.mock("../rag", () => ({ deleteImportedDoc: mocks.deleteImportedDoc }));
vi.mock("../settings-store", () => ({
  loadUserProfile: mocks.loadUserProfile,
  saveUserProfile: mocks.saveUserProfile,
  getAvatarPath: mocks.getAvatarPath,
}));
vi.mock("../orchestrator/mcp-management-ipc", () => ({ registerMcpManagementIpc: mocks.registerMcpManagementIpc }));
vi.mock("../orchestrator/tools/registry/tool-registry", () => ({ toolRegistry: { getAllTools: mocks.getAllTools } }));
vi.mock("../settings/settings-facade", () => ({
  loadGeneralSettings: mocks.loadGeneralSettings,
  saveGeneralSettings: mocks.saveGeneralSettings,
}));
vi.mock("../skills", () => ({
  setSkillEnabled: mocks.setSkillEnabled,
  skillRegistry: { getById: mocks.skillGetById, getAll: mocks.skillGetAll },
  rescanSkills: mocks.rescanSkills,
}));
vi.mock("../windows/window-state", () => ({
  get reactChatWindow() { return state.reactChatWindow; },
  get sidebarWindow() { return state.sidebarWindow; },
  get settingsWindow() { return state.settingsWindow; },
  get stickerManagerWindow() { return state.stickerManagerWindow; },
}));

import { IPC } from "../../shared/ipc-channels";
import type { IpcScope } from "../application/ipc-scope";
import { registerMemoryUserToolIpc } from "./memory-user-ipc";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-memory-user-ipc-"));
  tempDirs.push(dir);
  return dir;
}

interface FakeWindow {
  webContents: { send: ReturnType<typeof vi.fn> };
  isDestroyed: () => boolean;
}

function fakeWindow(): FakeWindow {
  return { webContents: { send: vi.fn() }, isDestroyed: () => false };
}

function fixture(options: { personalMemoryMode?: "legacy" | "smh" } = {}) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const ipc = {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => { handlers.set(channel, handler); }),
    on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => { listeners.set(channel, listener); }),
    removeHandler: vi.fn(),
    dispose: vi.fn(),
  } as unknown as IpcScope;
  registerMemoryUserToolIpc({
    get windowManager() { return state.windowManager as never; },
    embeddingIndexService: {
      invalidateStickerEmbeddingIndex: mocks.invalidateStickerEmbeddingIndex,
      refreshStickerEmbeddingIndex: mocks.refreshStickerEmbeddingIndex,
    } as never,
    ipc,
    personalMemoryMode: options.personalMemoryMode,
  });
  const invoke = (channel: string, payload?: unknown, event: unknown = {}) =>
    Promise.resolve().then(() => handlers.get(channel)!(event, payload));
  const emit = (channel: string, ...args: unknown[]) => listeners.get(channel)!(...args);
  return { ipc, handlers, listeners, invoke, emit };
}

const stickerConfig = [
  { id: "happy", src: "happy.png", enabled: true, builtIn: true },
  { id: "sad", src: "sad.png", enabled: false, builtIn: false },
];

beforeEach(() => {
  vi.clearAllMocks();
  state.reactChatWindow = null;
  state.sidebarWindow = null;
  state.settingsWindow = null;
  state.stickerManagerWindow = null;
  state.windowManager = null;
  mocks.getStickerManagerConfig.mockReturnValue(stickerConfig);
  mocks.addUserSticker.mockResolvedValue(undefined);
  mocks.loadMemoryPanelData.mockResolvedValue({ l0: {}, l1: {}, l2: [], importedDocs: [], reflections: [] });
  mocks.loadImportedDocumentPanelData.mockResolvedValue({ importedDocs: [] });
  mocks.deleteImportedDoc.mockReturnValue(2);
  mocks.loadUserProfile.mockReturnValue({ nickname: "小王" });
  mocks.saveUserProfile.mockImplementation((profile: Record<string, unknown>) => ({ nickname: "小王", ...profile }));
  mocks.getAvatarPath.mockReturnValue(path.join(tempDir(), "avatar.png"));
  mocks.loadGeneralSettings.mockReturnValue({ toolModeOverrides: {}, skillModeOverrides: {} });
  mocks.getAllTools.mockReturnValue([]);
  mocks.skillGetAll.mockReturnValue([]);
  mocks.cachedZhMap.mockReturnValue({});
  mocks.isExternalSkillId.mockImplementation((id: string) => id.startsWith("external-"));
  mocks.isTrustedExternalMainFrame.mockReturnValue(false);
  mocks.rescanSkills.mockReturnValue(3);
  mocks.setSkillEnabled.mockReturnValue(undefined);
  mocks.createLlmClient.mockReturnValue({ chatNonStream: mocks.chatNonStream });
  mocks.loadModelSettings.mockReturnValue({ raw: true });
  mocks.resolveModelSettingsProfile.mockReturnValue({ resolved: true });
  mocks.translationMessages.mockReturnValue([{ role: "user", content: "batch" }]);
  mocks.chatNonStream.mockResolvedValue({ text: "reply-text" });
  mocks.parseTranslation.mockReturnValue({ s1: "中文" });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("IPC registration", () => {
  it("registers every memory/user/sticker/skill handler on the supplied scope", () => {
    const f = fixture();
    const channels = [
      IPC.SETTINGS_OPEN_STICKER_MANAGER,
      IPC.STICKERS_GET_CONFIG,
      IPC.STICKERS_SET_ENABLED,
      IPC.STICKERS_PICK_FILE,
      IPC.STICKERS_ADD,
      IPC.STICKERS_GET_ENABLED,
      IPC.USER_GET_AVATAR,
      IPC.MEMORY_PANEL_GET_DATA,
      IPC.MEMORY_PANEL_DELETE_IMPORTED_DOC,
      IPC.USER_GET_PROFILE,
      IPC.USER_SAVE_PROFILE,
      IPC.USER_UPLOAD_AVATAR,
      IPC.TOOL_GET_CATALOG,
      IPC.TOOL_GET_MODE_OVERRIDES,
      IPC.TOOL_SET_MODE_OVERRIDE,
      IPC.SKILL_SET_ENABLED,
      IPC.SKILL_GET_CATALOG,
      IPC.SKILL_TRANSLATE_DESCRIPTIONS,
      IPC.SKILL_RESCAN,
      IPC.SKILL_GET_MODE_OVERRIDES,
      IPC.SKILL_SET_MODE_OVERRIDE,
    ];
    for (const channel of channels) expect(f.handlers.has(channel)).toBe(true);
    expect(f.listeners.has(IPC.STICKERS_MINIMIZE)).toBe(true);
    expect(f.listeners.has(IPC.STICKERS_CLOSE)).toBe(true);
    expect(mocks.registerMcpManagementIpc).toHaveBeenCalledTimes(1);
  });

  it("gives MCP management the same scope and a live settings-window getter", () => {
    const f = fixture();
    const { ipc, getSettingsWindow } = mocks.registerMcpManagementIpc.mock.calls[0][0];
    expect(ipc).toBe(f.ipc);
    expect(getSettingsWindow()).toBeNull();
    const settings = fakeWindow();
    state.settingsWindow = settings;
    expect(getSettingsWindow()).toBe(settings);
  });
});

describe("sticker manager window and settings", () => {
  it("reads windowManager lazily so a later assignment works", async () => {
    const f = fixture();
    await expect(f.invoke(IPC.SETTINGS_OPEN_STICKER_MANAGER)).resolves.toBeUndefined();

    const createStickerManagerWindow = vi.fn(() => ({ opened: true }));
    state.windowManager = { createStickerManagerWindow };
    await expect(f.invoke(IPC.SETTINGS_OPEN_STICKER_MANAGER)).resolves.toEqual({ opened: true });
    expect(createStickerManagerWindow).toHaveBeenCalledTimes(1);
  });

  it("minimizes and closes the sticker manager window when present", () => {
    const f = fixture();
    expect(() => f.emit(IPC.STICKERS_MINIMIZE)).not.toThrow();
    expect(() => f.emit(IPC.STICKERS_CLOSE)).not.toThrow();

    const minimize = vi.fn();
    const close = vi.fn();
    state.stickerManagerWindow = { minimize, close };
    f.emit(IPC.STICKERS_MINIMIZE);
    f.emit(IPC.STICKERS_CLOSE);
    expect(minimize).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("returns the sticker configuration", async () => {
    const f = fixture();
    await expect(f.invoke(IPC.STICKERS_GET_CONFIG)).resolves.toBe(stickerConfig);
  });

  it("sets a sticker's enabled flag and returns the fresh configuration", async () => {
    const f = fixture();
    await expect(f.invoke(IPC.STICKERS_SET_ENABLED, { id: "sad", enabled: true })).resolves.toBe(stickerConfig);
    expect(mocks.setStickerEnabled).toHaveBeenCalledWith("sad", true);
  });

  it("coerces a truthy non-boolean enabled value", async () => {
    const f = fixture();
    await f.invoke(IPC.STICKERS_SET_ENABLED, { id: "sad", enabled: "yes" });
    expect(mocks.setStickerEnabled).toHaveBeenCalledWith("sad", true);
  });

  it.each([null, undefined, {}, { id: "" }, { id: 3, enabled: true }])(
    "ignores an invalid sticker toggle payload %#",
    async payload => {
      const f = fixture();
      await expect(f.invoke(IPC.STICKERS_SET_ENABLED, payload)).resolves.toBe(stickerConfig);
      expect(mocks.setStickerEnabled).not.toHaveBeenCalled();
    },
  );

  it("returns the picked sticker file or null when canceled", async () => {
    const f = fixture();
    mocks.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    await expect(f.invoke(IPC.STICKERS_PICK_FILE)).resolves.toBeNull();
    expect(mocks.showOpenDialog).toHaveBeenCalledWith({
      properties: ["openFile"],
      filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }],
    });

    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ["C:/stickers/new.png"] });
    await expect(f.invoke(IPC.STICKERS_PICK_FILE)).resolves.toBe("C:/stickers/new.png");
  });

  it("adds a sticker, refreshes the embedding index and returns the configuration", async () => {
    const f = fixture();
    const payload = { sourcePath: "C:/tmp/a.png", id: "new", description: "开心", phrases: ["哈哈"] };

    await expect(f.invoke(IPC.STICKERS_ADD, payload)).resolves.toBe(stickerConfig);

    expect(mocks.addUserSticker).toHaveBeenCalledWith("C:/tmp/a.png", "new", "开心", ["哈哈"]);
    expect(mocks.invalidateStickerEmbeddingIndex).toHaveBeenCalledTimes(1);
    expect(mocks.refreshStickerEmbeddingIndex).toHaveBeenCalledWith("user-sticker-add");
  });

  it("rethrows sticker-add failures without refreshing the index", async () => {
    const f = fixture();
    const failure = new Error("copy failed");
    mocks.addUserSticker.mockRejectedValue(failure);

    await expect(f.invoke(IPC.STICKERS_ADD, { sourcePath: "a", id: "b", description: "", phrases: [] }))
      .rejects.toBe(failure);
    expect(mocks.invalidateStickerEmbeddingIndex).not.toHaveBeenCalled();
    expect(mocks.refreshStickerEmbeddingIndex).not.toHaveBeenCalled();
  });

  it("returns only enabled stickers", async () => {
    const f = fixture();
    await expect(f.invoke(IPC.STICKERS_GET_ENABLED)).resolves.toEqual([stickerConfig[0]]);
  });
});

describe("user avatar and profile", () => {
  it("returns null when no avatar file exists", async () => {
    const f = fixture();
    mocks.getAvatarPath.mockReturnValue(path.join(tempDir(), "missing.png"));
    await expect(f.invoke(IPC.USER_GET_AVATAR)).resolves.toBeNull();
  });

  it.each([
    [".png", "image/png"],
    [".jpg", "image/jpeg"],
    [".jpeg", "image/jpeg"],
    [".JPEG", "image/jpeg"],
    [".webp", "image/webp"],
    [".bmp", "image/png"],
    ["", "image/png"],
  ])("encodes a %s avatar as %s", async (extension, mime) => {
    const f = fixture();
    const file = path.join(tempDir(), `avatar${extension}`);
    fs.writeFileSync(file, "hi");
    mocks.getAvatarPath.mockReturnValue(file);
    await expect(f.invoke(IPC.USER_GET_AVATAR)).resolves.toBe(`data:${mime};base64,aGk=`);
  });

  it("returns the stored user profile", async () => {
    const f = fixture();
    await expect(f.invoke(IPC.USER_GET_PROFILE)).resolves.toEqual({ nickname: "小王" });
  });

  it("saves the profile and broadcasts it to every live auxiliary window", async () => {
    const f = fixture();
    const react = fakeWindow();
    const sidebar = fakeWindow();
    const settings = fakeWindow();
    const destroyed = fakeWindow();
    destroyed.isDestroyed = () => true;
    state.reactChatWindow = react;
    state.sidebarWindow = sidebar;
    state.settingsWindow = settings;
    const saved = { nickname: "小王", callPreference: "小王" };
    mocks.saveUserProfile.mockReturnValue(saved);

    await expect(f.invoke(IPC.USER_SAVE_PROFILE, { callPreference: "小王" })).resolves.toBe(saved);

    expect(mocks.saveUserProfile).toHaveBeenCalledWith({ callPreference: "小王" });
    for (const window of [react, sidebar, settings]) {
      expect(window.webContents.send).toHaveBeenCalledWith(IPC.USER_PROFILE_CHANGED, saved);
    }
    expect(destroyed.webContents.send).not.toHaveBeenCalled();
  });

  it("skips null and destroyed auxiliary windows when broadcasting", async () => {
    const f = fixture();
    const destroyed = fakeWindow();
    destroyed.isDestroyed = () => true;
    state.reactChatWindow = destroyed;
    state.sidebarWindow = null;
    state.settingsWindow = null;

    await expect(f.invoke(IPC.USER_SAVE_PROFILE, { nickname: "x" })).resolves.toEqual({ nickname: "x" });
    expect(destroyed.webContents.send).not.toHaveBeenCalled();
  });

  it("returns null and does not copy when avatar upload is canceled", async () => {
    const f = fixture();
    mocks.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: ["C:/x.png"] });
    await expect(f.invoke(IPC.USER_UPLOAD_AVATAR)).resolves.toBeNull();
    expect(mocks.saveUserProfile).not.toHaveBeenCalled();

    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [] });
    await expect(f.invoke(IPC.USER_UPLOAD_AVATAR)).resolves.toBeNull();
    expect(mocks.saveUserProfile).not.toHaveBeenCalled();
  });

  it("copies the picked avatar, saves the path and broadcasts the change", async () => {
    const f = fixture();
    const dir = tempDir();
    const source = path.join(dir, "picked.png");
    const destination = path.join(dir, "profile", "avatar.png");
    fs.writeFileSync(source, "image-bytes");
    mocks.getAvatarPath.mockReturnValue(destination);
    const profile = { nickname: "小王", avatarPath: destination };
    mocks.saveUserProfile.mockReturnValue(profile);
    const settings = fakeWindow();
    state.settingsWindow = settings;

    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [source] });
    await expect(f.invoke(IPC.USER_UPLOAD_AVATAR)).resolves.toEqual({ avatarPath: destination, profile });

    expect(fs.readFileSync(destination, "utf8")).toBe("image-bytes");
    expect(mocks.saveUserProfile).toHaveBeenCalledWith({ avatarPath: destination });
    expect(settings.webContents.send).toHaveBeenCalledWith(IPC.USER_AVATAR_CHANGED, null);
  });
});

describe("memory panel", () => {
  it("uses the legacy memory panel by default", async () => {
    const f = fixture();
    const data = { l0: {}, l1: {}, l2: [], importedDocs: [], reflections: [] };
    mocks.loadMemoryPanelData.mockResolvedValue(data);
    await expect(f.invoke(IPC.MEMORY_PANEL_GET_DATA)).resolves.toBe(data);
    expect(mocks.loadImportedDocumentPanelData).not.toHaveBeenCalled();
  });

  it("uses the imported-document panel when personal memory is retired", async () => {
    const f = fixture({ personalMemoryMode: "smh" });
    const data = { importedDocs: [{ importId: "1", fileName: "a.md", chunkCount: 2, lastImportedAt: 10 }] };
    mocks.loadImportedDocumentPanelData.mockResolvedValue(data);

    await expect(f.invoke(IPC.MEMORY_PANEL_GET_DATA)).resolves.toBe(data);
    expect(mocks.loadMemoryPanelData).not.toHaveBeenCalled();
  });

  it("deletes an imported document and reports the deleted count", async () => {
    const f = fixture();
    await expect(f.invoke(IPC.MEMORY_PANEL_DELETE_IMPORTED_DOC, { importId: "doc-1", fileName: "a.md" }))
      .resolves.toEqual({ ok: true, deleted: 2 });
    expect(mocks.deleteImportedDoc).toHaveBeenCalledWith("doc-1", "a.md");
  });
});

describe("tool catalog and mode overrides", () => {
  it("exposes only serializable catalog fields and defaults optional ones", async () => {
    const f = fixture();
    mocks.getAllTools.mockReturnValue([
      { id: "t1", name: "T1", description: "d1", enabled: true },
      { id: "t2", name: "T2", description: "d2", enabled: false, modes: ["chat"], chatBuiltin: true, deprecated: "use t1", execute: vi.fn(), inputSchema: {} },
    ]);

    await expect(f.invoke(IPC.TOOL_GET_CATALOG)).resolves.toEqual([
      { id: "t1", name: "T1", description: "d1", enabled: true, modes: null, chatBuiltin: false, deprecated: null },
      { id: "t2", name: "T2", description: "d2", enabled: false, modes: ["chat"], chatBuiltin: true, deprecated: "use t1" },
    ]);
  });

  it("returns saved tool mode overrides", async () => {
    const f = fixture();
    const overrides = { t1: { chat: false } };
    mocks.loadGeneralSettings.mockReturnValue({ toolModeOverrides: overrides, skillModeOverrides: {} });
    await expect(f.invoke(IPC.TOOL_GET_MODE_OVERRIDES)).resolves.toBe(overrides);
  });

  it.each([
    [{}, "missing toolId or mode"],
    [{ toolId: "t1" }, "missing toolId or mode"],
    [{ mode: "chat" }, "missing toolId or mode"],
    [{ toolId: "t1", mode: "unknown" }, "invalid mode"],
  ])("rejects an invalid tool override %j", async (payload, error) => {
    const f = fixture();
    await expect(f.invoke(IPC.TOOL_SET_MODE_OVERRIDE, payload)).resolves.toEqual({ ok: false, error });
    expect(mocks.saveGeneralSettings).not.toHaveBeenCalled();
  });

  it("merges a tool override into the existing per-tool record", async () => {
    const f = fixture();
    mocks.loadGeneralSettings.mockReturnValue({
      toolModeOverrides: { t1: { chat: false } },
      skillModeOverrides: {},
    });

    await expect(f.invoke(IPC.TOOL_SET_MODE_OVERRIDE, { toolId: "t1", mode: "work", enabled: false }))
      .resolves.toEqual({ ok: true });
    expect(mocks.saveGeneralSettings).toHaveBeenCalledWith({
      toolModeOverrides: { t1: { chat: false, work: false } },
    });
  });

  it("treats an omitted enabled flag as enabling the tool", async () => {
    const f = fixture();
    mocks.loadGeneralSettings.mockReturnValue({
      toolModeOverrides: { t2: { chat: false } },
      skillModeOverrides: {},
    });

    await f.invoke(IPC.TOOL_SET_MODE_OVERRIDE, { toolId: "t2", mode: "code" });

    expect(mocks.saveGeneralSettings).toHaveBeenCalledWith({
      toolModeOverrides: { t2: { chat: false, code: true } },
    });
  });
});

describe("skill enable", () => {
  it.each([
    null,
    undefined,
    [],
    "payload",
    {},
    { id: "s1" },
    { id: "s1", enabled: "yes" },
    { id: "", enabled: true },
    { id: 3, enabled: true },
  ])("rejects an invalid skill enable payload %#", async payload => {
    const f = fixture();
    await expect(f.invoke(IPC.SKILL_SET_ENABLED, payload)).resolves.toEqual({
      ok: false,
      error: "Invalid Skill enable request.",
    });
    expect(mocks.setSkillEnabled).not.toHaveBeenCalled();
  });

  it("rejects an unknown skill id", async () => {
    const f = fixture();
    mocks.skillGetById.mockReturnValue(undefined);
    await expect(f.invoke(IPC.SKILL_SET_ENABLED, { id: "missing", enabled: true })).resolves.toEqual({
      ok: false,
      error: "Invalid Skill enable request.",
    });
    expect(mocks.setSkillEnabled).not.toHaveBeenCalled();
  });

  it("enables a known skill without trusting any external context", async () => {
    const f = fixture();
    mocks.skillGetById.mockReturnValue({ id: "s1" });
    await expect(f.invoke(IPC.SKILL_SET_ENABLED, { id: "s1", enabled: false })).resolves.toEqual({ ok: true });
    expect(mocks.setSkillEnabled).toHaveBeenCalledWith("s1", false);
    expect(mocks.isTrustedExternalMainFrame).not.toHaveBeenCalled();
  });

  it("reports a save/verify failure without leaking the error", async () => {
    const f = fixture();
    mocks.skillGetById.mockReturnValue({ id: "s1" });
    mocks.setSkillEnabled.mockImplementation(() => { throw new Error("disk full: /secret/path"); });
    await expect(f.invoke(IPC.SKILL_SET_ENABLED, { id: "s1", enabled: true })).resolves.toEqual({
      ok: false,
      error: "Skill state could not be saved or verified. Refresh before trying again.",
    });
  });

  it("rejects an external skill from an untrusted frame", async () => {
    const f = fixture();
    const react = fakeWindow();
    state.reactChatWindow = react;
    mocks.skillGetById.mockReturnValue({ id: "external-openai-one" });
    mocks.isTrustedExternalMainFrame.mockReturnValue(false);
    const event = { trusted: false };

    await expect(f.invoke(IPC.SKILL_SET_ENABLED, { id: "external-openai-one", enabled: true }, event)).resolves.toEqual({
      ok: false,
      error: "External Skill enable request is not permitted.",
    });
    expect(mocks.isTrustedExternalMainFrame).toHaveBeenCalledWith(event, react.webContents);
    expect(mocks.setSkillEnabled).not.toHaveBeenCalled();
  });

  it("rejects privilege-bearing extra keys on an external skill even when the frame is trusted", async () => {
    const f = fixture();
    state.reactChatWindow = null;
    mocks.skillGetById.mockReturnValue({ id: "external-openai-one" });
    mocks.isTrustedExternalMainFrame.mockReturnValue(true);

    await expect(f.invoke(IPC.SKILL_SET_ENABLED, { id: "external-openai-one", enabled: true, approved: true })).resolves.toEqual({
      ok: false,
      error: "External Skill enable request is not permitted.",
    });
    expect(mocks.isTrustedExternalMainFrame).not.toHaveBeenCalled();
    expect(mocks.setSkillEnabled).not.toHaveBeenCalled();
  });

  it("enables a trusted external skill with only id and enabled", async () => {
    const f = fixture();
    mocks.skillGetById.mockReturnValue({ id: "external-openai-one" });
    mocks.isTrustedExternalMainFrame.mockReturnValue(true);
    await expect(f.invoke(IPC.SKILL_SET_ENABLED, { id: "external-openai-one", enabled: true })).resolves.toEqual({ ok: true });
    expect(mocks.setSkillEnabled).toHaveBeenCalledWith("external-openai-one", true);
  });
});

describe("skill catalog, translation and rescan", () => {
  it("hides internal skills and exposes the serializable catalog with Chinese descriptions", async () => {
    const f = fixture();
    const visible = {
      id: "s1",
      name: "Skill 1",
      description: "does things",
      enabled: true,
      source: "builtin",
      modes: ["work", "code"],
      version: "1.0.0",
      references: ["ref.md"],
      external: { status: "ready" },
    };
    const hidden = { ...visible, id: "hidden", hiddenFromUi: true };
    mocks.skillGetAll.mockReturnValue([visible, hidden]);
    mocks.cachedZhMap.mockReturnValue({ s1: "做事情" });

    await expect(f.invoke(IPC.SKILL_GET_CATALOG)).resolves.toEqual([{
      descriptionZh: "做事情",
      id: "s1",
      name: "Skill 1",
      description: "does things",
      enabled: true,
      source: "builtin",
      modes: ["work", "code"],
      version: "1.0.0",
      references: ["ref.md"],
      external: { status: "ready" },
    }]);
    expect(mocks.cachedZhMap).toHaveBeenCalledWith([visible]);
  });

  it("uses null modes when a skill does not declare any", async () => {
    const f = fixture();
    mocks.skillGetAll.mockReturnValue([
      { id: "s1", name: "Skill", description: "d", enabled: false, source: "user", references: [] },
    ]);
    const [entry] = await f.invoke(IPC.SKILL_GET_CATALOG) as Array<Record<string, unknown>>;
    expect(entry.modes).toBeNull();
    expect(entry.descriptionZh).toBeUndefined();
  });

  it("translates only visible skills and returns the translated map", async () => {
    const f = fixture();
    const visible = { id: "s1", description: "English description" };
    mocks.skillGetAll.mockReturnValue([visible, { id: "hidden", description: "x", hiddenFromUi: true }]);
    mocks.translateMissing.mockImplementation(async (_skills: unknown, translate: (batch: unknown[]) => Promise<Record<string, string>>) =>
      translate([{ id: "s1", description: "English description" }]));

    await expect(f.invoke(IPC.SKILL_TRANSLATE_DESCRIPTIONS)).resolves.toEqual({
      ok: true,
      translated: { s1: "中文" },
    });

    expect(mocks.translateMissing).toHaveBeenCalledWith(
      [{ id: "s1", description: "English description" }],
      expect.any(Function),
    );
    expect(mocks.loadModelSettings).toHaveBeenCalledTimes(1);
    expect(mocks.resolveModelSettingsProfile).toHaveBeenCalledWith({ raw: true });
    expect(mocks.translationMessages).toHaveBeenCalledWith([{ id: "s1", description: "English description" }]);
    expect(mocks.chatNonStream).toHaveBeenCalledWith(
      { resolved: true },
      [{ role: "user", content: "batch" }],
      0,
      90_000,
      "skill-description-zh",
    );
    expect(mocks.parseTranslation).toHaveBeenCalledWith("reply-text", [{ id: "s1", description: "English description" }]);
  });

  it("returns the cached map and the error message when translation fails", async () => {
    const f = fixture();
    const visible = { id: "s1", description: "English" };
    mocks.skillGetAll.mockReturnValue([visible]);
    mocks.cachedZhMap.mockReturnValue({ s1: "旧翻译" });
    mocks.translateMissing.mockRejectedValue(new Error("model unavailable"));

    await expect(f.invoke(IPC.SKILL_TRANSLATE_DESCRIPTIONS)).resolves.toEqual({
      ok: false,
      error: "model unavailable",
      translated: { s1: "旧翻译" },
    });
    expect(mocks.cachedZhMap).toHaveBeenCalledWith([{ id: "s1", description: "English" }]);
  });

  it("stringifies a non-Error translation failure", async () => {
    const f = fixture();
    mocks.translateMissing.mockRejectedValue("plain failure");
    await expect(f.invoke(IPC.SKILL_TRANSLATE_DESCRIPTIONS)).resolves.toEqual({
      ok: false,
      error: "plain failure",
      translated: {},
    });
  });

  it("rescans skills and reports the count", async () => {
    const f = fixture();
    mocks.rescanSkills.mockReturnValue(7);
    await expect(f.invoke(IPC.SKILL_RESCAN)).resolves.toEqual({ ok: true, count: 7 });
  });
});

describe("skill mode overrides", () => {
  it("returns saved skill mode overrides", async () => {
    const f = fixture();
    const overrides = { s1: { work: false } };
    mocks.loadGeneralSettings.mockReturnValue({ toolModeOverrides: {}, skillModeOverrides: overrides });
    await expect(f.invoke(IPC.SKILL_GET_MODE_OVERRIDES)).resolves.toBe(overrides);
  });

  it.each([
    [{}, "missing skillId or mode"],
    [{ skillId: "s1" }, "missing skillId or mode"],
    [{ mode: "work" }, "missing skillId or mode"],
    [{ skillId: "s1", mode: "chat" }, "invalid mode"],
  ])("rejects an invalid skill override %j", async (payload, error) => {
    const f = fixture();
    await expect(f.invoke(IPC.SKILL_SET_MODE_OVERRIDE, payload)).resolves.toEqual({ ok: false, error });
    expect(mocks.saveGeneralSettings).not.toHaveBeenCalled();
  });

  it("merges a skill override and defaults an omitted enabled flag to true", async () => {
    const f = fixture();
    mocks.loadGeneralSettings.mockReturnValue({
      toolModeOverrides: {},
      skillModeOverrides: { s1: { work: false } },
    });

    await expect(f.invoke(IPC.SKILL_SET_MODE_OVERRIDE, { skillId: "s1", mode: "code" })).resolves.toEqual({ ok: true });

    expect(mocks.saveGeneralSettings).toHaveBeenCalledWith({
      skillModeOverrides: { s1: { work: false, code: true } },
    });
  });

  it("records an explicit disable", async () => {
    const f = fixture();
    await f.invoke(IPC.SKILL_SET_MODE_OVERRIDE, { skillId: "s2", mode: "work", enabled: false });
    expect(mocks.saveGeneralSettings).toHaveBeenCalledWith({
      skillModeOverrides: { s2: { work: false } },
    });
  });
});
