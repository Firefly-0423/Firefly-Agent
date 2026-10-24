import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC } from "../../shared/ipc-channels";
import type { SettingsIpcDependencies } from "./settings-ipc";
import type { GeneralSettings } from "./general-settings";
const fixture = vi.hoisted(() => ({
  dir: "", changed: undefined as undefined | ((snapshot: unknown) => void), unsubscribe: vi.fn(),
  open: vi.fn(), switchModel: vi.fn(), initReranker: vi.fn(), rerankerStatus: vi.fn(),
  fetchModels: vi.fn(), testConnection: vi.fn(), publicConfig: vi.fn((settings?: { model?: string }) => ({ model: settings?.model ?? "public-default" })),
  assertModel: vi.fn(), assertGeneral: vi.fn(), saveProfile: vi.fn(), setDefault: vi.fn(), timeoutGet: vi.fn(), timeoutSave: vi.fn(),
}));
vi.mock("electron", () => ({ app: { getPath: () => fixture.dir, getAppPath: () => process.cwd() }, dialog: { showOpenDialog: fixture.open } }));
vi.mock("../startup/env", () => ({ isDev: true }));
vi.mock("./model-settings", () => ({
  getPublicModelConfig: fixture.publicConfig,
  listSavedModelProfiles: (settings: { modelProfiles?: unknown[] }) => settings.modelProfiles ?? [],
  onModelConnectionChanged: (callback: typeof fixture.changed) => { fixture.changed = callback; return fixture.unsubscribe; },
  getModelConnectionSnapshot: () => ({ connected: true }), testModelConnection: fixture.testConnection,
  saveModelProfile: fixture.saveProfile, setDefaultModelProfile: fixture.setDefault, assertModelSettingsReadable: fixture.assertModel,
  normalizeModelSettings: vi.fn(), saveModelSettings: vi.fn(),
}));
vi.mock("./settings-facade", () => ({ assertGeneralSettingsReadable: fixture.assertGeneral }));
vi.mock("./agent-model-routing", () => ({ getAgentRoutingView: (s: unknown) => s, updateAgentRouting: (_s: unknown, input: unknown) => input }));
vi.mock("../rag", () => ({ switchEmbeddingModel: fixture.switchModel }));
vi.mock("../rag/reranker", () => ({ initReranker: fixture.initReranker, getRerankerInstallStatus: fixture.rerankerStatus }));
vi.mock("../orchestrator/vendors/test-connection", () => ({ testVendorConnection: vi.fn() }));
vi.mock("./fetch-vendor-models", () => ({ fetchVendorModels: fixture.fetchModels }));
vi.mock("./timeout-manager", () => ({ getTimeoutSettings: fixture.timeoutGet, saveTimeoutSettings: fixture.timeoutSave }));
import { registerSettingsIpc } from "./settings-ipc";
import * as windows from "../windows/window-state";
import { DEFAULT_UI_FONT } from "../../shared/ui-font";

type Handler = (...args: any[]) => any;
let handlers: Map<string, Handler>, listeners: Map<string, Handler>;
let general: GeneralSettings;
let model: { model: string; modelProfiles: Array<{ id: string; provider: string; model: string }>; defaultModelProfileId?: string };
let deps: SettingsIpcDependencies;
function host(page: string) {
  return { isDestroyed: vi.fn(() => false), webContents: { id: 7, isDestroyed: vi.fn(() => false), mainFrame: { url: `http://localhost:5173/${page}/` }, send: vi.fn() } };
}
let settingsHost: ReturnType<typeof host>, chatHost: ReturnType<typeof host>, deadHost: ReturnType<typeof host>;
const event = () => ({ sender: settingsHost.webContents, senderFrame: settingsHost.webContents.mainFrame });
const invoke = (channel: string, input?: unknown, sender = event()) => handlers.get(channel)!(sender, input);
beforeEach(() => {
  vi.clearAllMocks();
  fixture.dir = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-settings-unit-"));
  handlers = new Map(); listeners = new Map();
  general = { uiFont: DEFAULT_UI_FONT, uiColors: { accent: "blue" }, uiTheme: "dark", petVisible: true, petZoom: 1 } as unknown as GeneralSettings;
  model = { model: "fixture-model", modelProfiles: [{ id: "first", provider: "openai", model: "gpt-4o" }, { id: "second", provider: "openai", model: "gpt-4o" }], defaultModelProfileId: "first" };
  settingsHost = host("settings"); chatHost = host("react"); deadHost = host("sidebar"); deadHost.isDestroyed.mockReturnValue(true);
  windows.setSettingsWindow(settingsHost as never); windows.setReactChatWindow(chatHost as never); windows.setSidebarWindow(deadHost as never);
  deps = {
    ipc: { handle: (channel: string, fn: Handler) => { handlers.set(channel, fn); }, on: (channel: string, fn: Handler) => { listeners.set(channel, fn); } },
    windowManager: null,
    getGeneralSettings: () => general,
    saveGeneralSettings: vi.fn(patch => { general = { ...general, ...patch }; return general; }),
    getModelSettings: () => model,
    saveModelSettings: vi.fn(patch => { model = { ...model, ...patch } as typeof model; return model; }),
    proactiveLifecycle: { getProactiveChatService: () => null },
    reconcileUserMemoryIndex: vi.fn(async () => {}),
    embeddingIndexService: { invalidateStickerEmbeddingIndex: vi.fn(), refreshStickerEmbeddingIndex: vi.fn() },
    syncVolcanoSearchMcp: vi.fn(async () => {}), syncPlaywrightMcp: vi.fn(async () => {}),
  } as unknown as SettingsIpcDependencies;
  fixture.switchModel.mockResolvedValue({ ok: true, clearedEntries: 2 }); fixture.initReranker.mockResolvedValue(undefined);
  registerSettingsIpc(deps);
});
afterEach(() => {
  windows.setSettingsWindow(null); windows.setReactChatWindow(null); windows.setSidebarWindow(null);
  fs.rmSync(fixture.dir, { recursive: true, force: true }); vi.restoreAllMocks();
});

describe("settings IPC", () => {
  it("returns model, profile, routing, UI and connection views with read guards", () => {
    expect(invoke(IPC.SETTINGS_GET_CONFIG)).toBe(model);
    expect(invoke(IPC.SETTINGS_MODEL_PROFILES_LIST)).toMatchObject({ defaultModelProfileId: "first", profiles: [{ id: "first", multimodal: true }, { id: "second", multimodal: true }] });
    expect(invoke(IPC.SETTINGS_AGENT_ROUTING_GET)).toBe(model);
    expect(invoke(IPC.UI_COLORS_GET)).toBe(general.uiColors); expect(invoke(IPC.UI_THEME_GET)).toBe("dark"); expect(invoke(IPC.UI_FONT_GET)).toEqual(DEFAULT_UI_FONT);
    expect(invoke(IPC.MODEL_CONFIG_GET)).toEqual({ model: "public-default" });
    expect(invoke(IPC.MODEL_CONNECTION_GET)).toEqual({ connected: true });
    expect(fixture.assertModel).toHaveBeenCalledTimes(5);
  });

  it("returns the connection unsubscribe callback and broadcasts only to living windows", () => {
    expect(registerSettingsIpc(deps)).toBe(fixture.unsubscribe);
    fixture.changed!({ status: "connected" });
    expect(settingsHost.webContents.send.mock.calls).toEqual([[IPC.MODEL_CONNECTION_CHANGED, { status: "connected" }], [IPC.MODEL_CONFIG_CHANGED, { model: "fixture-model" }]]);
    expect(chatHost.webContents.send).toHaveBeenCalledTimes(2); expect(deadHost.webContents.send).not.toHaveBeenCalled();
  });

  it("deletes the default profile by falling back to the first remaining profile and ignores invalid IDs", () => {
    expect(invoke(IPC.SETTINGS_MODEL_PROFILE_DELETE, 1)).toBeNull();
    expect(invoke(IPC.SETTINGS_MODEL_PROFILE_SET_DEFAULT, null)).toBeNull();
    expect(invoke(IPC.SETTINGS_MODEL_PROFILE_DELETE, "first")).toMatchObject({ profiles: [{ id: "second" }], defaultModelProfileId: "second" });
    expect(invoke(IPC.SETTINGS_MODEL_PROFILE_DELETE, "second")).toEqual({ profiles: [], defaultModelProfileId: undefined });
  });

  it("preserves the default when deleting a different profile and broadcasts saved config", () => {
    invoke(IPC.SETTINGS_MODEL_PROFILE_DELETE, "second");
    expect(model.defaultModelProfileId).toBe("first");
    expect(invoke(IPC.SETTINGS_SAVE_CONFIG, { model: "changed" })).toMatchObject({ model: "changed" });
    expect(settingsHost.webContents.send).toHaveBeenLastCalledWith(IPC.MODEL_CONFIG_CHANGED, { model: "changed" });
  });

  it("broadcasts newly added default profiles but not other profile edits", () => {
    fixture.saveProfile.mockReturnValue({ added: false, settings: model });
    expect(invoke(IPC.SETTINGS_MODEL_PROFILE_SAVE, {})).toMatchObject({ added: false });
    expect(settingsHost.webContents.send).not.toHaveBeenCalled();
    model.defaultModelProfileId = "second";
    fixture.saveProfile.mockReturnValue({ added: true, settings: model }); invoke(IPC.SETTINGS_MODEL_PROFILE_SAVE, {});
    expect(settingsHost.webContents.send).toHaveBeenCalledOnce();
    fixture.setDefault.mockReturnValue(model);
    expect(invoke(IPC.SETTINGS_MODEL_PROFILE_SET_DEFAULT, "second")).toMatchObject({ defaultModelProfileId: "second" });
  });

  it("routes and persists routing updates through the dependency", () => {
    const patch = { model: "routed" };
    expect(invoke(IPC.SETTINGS_AGENT_ROUTING_UPDATE, patch)).toMatchObject(patch);
    expect(deps.saveModelSettings).toHaveBeenCalledWith(patch);
  });

  it("reads general settings only for an owned host document", () => {
    expect(invoke(IPC.SETTINGS_GET_GENERAL)).toBe(general);
    expect(fixture.assertGeneral).toHaveBeenCalledOnce();
    const foreign = host("settings");
    expect(() => invoke(IPC.SETTINGS_GET_GENERAL, undefined, { sender: foreign.webContents, senderFrame: foreign.webContents.mainFrame })).toThrow(new Error("GENERAL_SETTINGS_FORBIDDEN"));
  });

  it.each([null, [], "bad", 1])("rejects malformed general settings %# before side effects", async input => {
    await expect(invoke(IPC.SETTINGS_SAVE_GENERAL, input)).rejects.toThrow(new Error("GENERAL_SETTINGS_INVALID"));
    expect(deps.saveGeneralSettings).not.toHaveBeenCalled();
  });

  it("rejects plugin patches and unowned frames before persistence", async () => {
    await expect(invoke(IPC.SETTINGS_SAVE_GENERAL, { plugins: {} })).rejects.toThrow(new Error("GENERAL_SETTINGS_PLUGINS_FORBIDDEN"));
    await expect(invoke(IPC.SETTINGS_SAVE_GENERAL, {}, { ...event(), senderFrame: { url: "http://localhost:5173/settings/" } })).rejects.toThrow(new Error("GENERAL_SETTINGS_FORBIDDEN"));
    expect(deps.saveGeneralSettings).not.toHaveBeenCalled();
  });

  it("runs only the lifecycle actions selected by saved general settings", async () => {
    const invalidate = vi.fn(); deps.proactiveLifecycle.getProactiveChatService = () => ({ invalidate });
    await invoke(IPC.SETTINGS_SAVE_GENERAL, { language: "en" });
    expect(deps.syncVolcanoSearchMcp).not.toHaveBeenCalled(); expect(deps.syncPlaywrightMcp).not.toHaveBeenCalled(); expect(invalidate).not.toHaveBeenCalled();
    const patch = { searchEngine: "fixture", playwrightMcpEnabled: true, proactiveChatMode: "fixture" };
    const saved = await invoke(IPC.SETTINGS_SAVE_GENERAL, patch);
    expect(deps.syncVolcanoSearchMcp).toHaveBeenCalledWith(saved); expect(deps.syncPlaywrightMcp).toHaveBeenCalledWith(saved); expect(invalidate).toHaveBeenCalledOnce();
  });

  it("uses a late window manager and coerces pet preferences", () => {
    const manager = { setPetWindowAlwaysOnTop: vi.fn(), applyPetWindowZoom: vi.fn() }; (deps as { windowManager: unknown }).windowManager = manager;
    listeners.get(IPC.SETTINGS_SET_PET_ALWAYS_ON_TOP)!(null, 1);
    listeners.get(IPC.SETTINGS_SET_PET_VISIBLE)!(null, 0);
    listeners.get(IPC.SETTINGS_SET_PET_ZOOM)!(null, "1.5");
    expect(general).toMatchObject({ petAlwaysOnTop: true, petVisible: false, petZoom: 1.5 });
    expect(manager.setPetWindowAlwaysOnTop).toHaveBeenCalledWith(true); expect(manager.applyPetWindowZoom).toHaveBeenCalledWith(1.5);
  });

  it("passes timeout settings through and returns font-picker cancellation or the first path", async () => {
    fixture.timeoutGet.mockReturnValue({ test: 10 }); fixture.timeoutSave.mockReturnValue({ test: 20 });
    expect(invoke(IPC.SETTINGS_GET_TIMEOUT_SETTINGS)).toEqual({ test: 10 });
    expect(invoke(IPC.SETTINGS_SAVE_TIMEOUT_SETTINGS, { test: 20 })).toEqual({ test: 20 });
    fixture.open.mockResolvedValue({ canceled: true, filePaths: ["ignored"] }); expect(await invoke(IPC.SETTINGS_PICK_UI_FONT)).toBeNull();
    fixture.open.mockResolvedValue({ canceled: false, filePaths: [] }); expect(await invoke(IPC.SETTINGS_PICK_UI_FONT)).toBeNull();
    fixture.open.mockResolvedValue({ canceled: false, filePaths: ["first.ttf", "second.otf"] }); expect(await invoke(IPC.SETTINGS_PICK_UI_FONT)).toBe("first.ttf");
  });

  it.each([[undefined, "未选择字体文件"], [1, "未选择字体文件"], ["", "未选择字体文件"], ["font.woff", "仅支持 .ttf 或 .otf 字体文件"]])("rejects invalid font input %#", (input, message) => {
    expect(() => invoke(IPC.SETTINGS_IMPORT_UI_FONT, input)).toThrow(new Error(message as string));
    expect(deps.saveGeneralSettings).not.toHaveBeenCalled();
  });

  it.each([0, 50 * 1024 * 1024 + 1])("rejects invalid font size %s", size => {
    const source = path.join(fixture.dir, "font.ttf");
    fs.writeFileSync(source, ""); fs.truncateSync(source, size);
    expect(() => invoke(IPC.SETTINGS_IMPORT_UI_FONT, source)).toThrow(new Error("字体文件无效或超过 50 MB"));
  });

  it("rejects a directory masquerading as a font and reports missing-file errors", () => {
    const source = path.join(fixture.dir, "directory.ttf"); fs.mkdirSync(source);
    expect(() => invoke(IPC.SETTINGS_IMPORT_UI_FONT, source)).toThrow(new Error("字体文件无效或超过 50 MB"));
    expect(() => invoke(IPC.SETTINGS_IMPORT_UI_FONT, path.join(fixture.dir, "missing.ttf"))).toThrow(expect.objectContaining({ code: "ENOENT" }));
  });

  it("accepts exactly 50 MB and limits custom font names to eighty characters", () => {
    const source = path.join(fixture.dir, `${"n".repeat(81)}.ttf`);
    fs.writeFileSync(source, ""); fs.truncateSync(source, 50 * 1024 * 1024);
    const imported = invoke(IPC.SETTINGS_IMPORT_UI_FONT, source);
    expect(imported.displayName).toBe("n".repeat(80));
    expect(fs.statSync(path.join(fixture.dir, "ui-fonts", imported.fileName)).size).toBe(50 * 1024 * 1024);
  });

  it("does not delete unsupported previous font paths during reset", () => {
    const protectedFile = path.join(fixture.dir, "keep.ttf"); fs.writeFileSync(protectedFile, "keep");
    general.uiFont = { kind: "custom", fileName: "../keep.ttf", displayName: "unsafe" };
    expect(invoke(IPC.SETTINGS_RESET_UI_FONT)).toEqual(DEFAULT_UI_FONT);
    expect(fs.readFileSync(protectedFile, "utf8")).toBe("keep");
  });

  it("imports supported fonts, derives a readable name, replaces old fonts and resets", () => {
    const source = path.join(fixture.dir, "Readable_Font-Name.OTF"); fs.writeFileSync(source, "font-data");
    const first = invoke(IPC.SETTINGS_IMPORT_UI_FONT, source);
    expect(first).toMatchObject({ kind: "custom", displayName: "Readable Font Name", fileName: expect.stringMatching(/^custom-.+\.otf$/) });
    expect(fs.readFileSync(path.join(fixture.dir, "ui-fonts", first.fileName), "utf8")).toBe("font-data");
    const second = invoke(IPC.SETTINGS_IMPORT_UI_FONT, source);
    expect(fs.existsSync(path.join(fixture.dir, "ui-fonts", first.fileName))).toBe(false);
    expect(invoke(IPC.SETTINGS_RESET_UI_FONT)).toEqual(DEFAULT_UI_FONT);
    expect(fs.existsSync(path.join(fixture.dir, "ui-fonts", second.fileName))).toBe(false);
    expect(invoke(IPC.SETTINGS_RESET_UI_FONT)).toEqual(DEFAULT_UI_FONT);
  });

  it("guards model network operations against child frames and navigated documents", async () => {
    await expect(invoke(IPC.SETTINGS_FETCH_MODELS, {}, { ...event(), senderFrame: { ...settingsHost.webContents.mainFrame } })).rejects.toThrow(new Error("MODEL_CONNECTION_FORBIDDEN"));
    settingsHost.webContents.mainFrame.url = "https://fixture.invalid/";
    await expect(invoke(IPC.SETTINGS_TEST_CONNECTION, {})).rejects.toThrow(new Error("MODEL_CONNECTION_FORBIDDEN"));
    expect(fixture.fetchModels).not.toHaveBeenCalled(); expect(fixture.testConnection).not.toHaveBeenCalled();
  });

  it("allows URL fragments, sanitizes fetch-model input and delegates connection tests", async () => {
    settingsHost.webContents.mainFrame.url += "#models";
    expect(await invoke(IPC.SETTINGS_FETCH_MODELS, null)).toEqual({ ok: false, error: "MISSING_BASE_URL" });
    fixture.fetchModels.mockResolvedValue({ ok: true, models: [] });
    expect(await invoke(IPC.SETTINGS_FETCH_MODELS, { provider: 1, baseUrl: false, apiKey: {}, explicitTransport: "bad" })).toEqual({ ok: true, models: [] });
    expect(fixture.fetchModels).toHaveBeenCalledWith({ provider: "", baseUrl: "", apiKey: "", explicitTransport: undefined });
    await invoke(IPC.SETTINGS_FETCH_MODELS, { provider: "openai", baseUrl: "https://fixture.invalid", apiKey: "fixture", explicitTransport: "responses" });
    expect(fixture.fetchModels).toHaveBeenLastCalledWith({ provider: "openai", baseUrl: "https://fixture.invalid", apiKey: "fixture", explicitTransport: "responses" });
    fixture.testConnection.mockResolvedValue({ ok: true }); expect(await invoke(IPC.SETTINGS_TEST_CONNECTION, { model: "fixture" })).toEqual({ ok: true });
    expect(invoke(IPC.SETTINGS_RESOLVE_INPUT_MODALITIES, null)).toMatchObject({ image: false });
    expect(invoke(IPC.SETTINGS_RESOLVE_INPUT_MODALITIES, { provider: "openai", model: "gpt-4o" })).toMatchObject({ image: true });
  });

  it("reconciles a successful embedding switch before saving and refreshing the sticker index", async () => {
    const order: string[] = [];
    vi.mocked(deps.reconcileUserMemoryIndex).mockImplementation(async () => { order.push("reconcile"); });
    vi.mocked(deps.saveModelSettings).mockImplementation(patch => { order.push("save"); return { ...model, ...patch } as never; });
    vi.mocked(deps.embeddingIndexService.invalidateStickerEmbeddingIndex).mockImplementation(() => { order.push("invalidate"); });
    expect(await invoke(IPC.EMBEDDING_SET_MODEL, "bgem3")).toEqual({ ok: true, clearedEntries: 2 });
    expect(order).toEqual(["reconcile", "save", "invalidate"]);
    expect(deps.embeddingIndexService.refreshStickerEmbeddingIndex).toHaveBeenCalledWith("embedding-model-switch");
  });

  it("returns failed embedding results unchanged and normalizes thrown errors", async () => {
    fixture.switchModel.mockResolvedValueOnce({ ok: false, clearedEntries: 0 });
    expect(await invoke(IPC.EMBEDDING_SET_MODEL, "bad")).toEqual({ ok: false, clearedEntries: 0 });
    expect(deps.reconcileUserMemoryIndex).not.toHaveBeenCalled();
    fixture.switchModel.mockRejectedValueOnce(new Error("failed"));
    expect(await invoke(IPC.EMBEDDING_SET_MODEL, "bgem3")).toEqual({ ok: false, clearedEntries: 0, error: "failed" });
    fixture.switchModel.mockRejectedValueOnce("plain failure");
    expect(await invoke(IPC.EMBEDDING_SET_MODEL, "bgem3")).toMatchObject({ error: "plain failure" });
  });

  it("saves reranker mode, initializes it and returns status", async () => {
    expect(await invoke(IPC.RERANKER_SET_MODE, "none")).toBe(true);
    expect(model).toMatchObject({ rerankerMode: "none" }); expect(fixture.initReranker).toHaveBeenCalledWith("none");
    fixture.rerankerStatus.mockReturnValue({ installed: true }); expect(invoke(IPC.RERANKER_GET_STATUS)).toEqual({ installed: true });
  });
});
