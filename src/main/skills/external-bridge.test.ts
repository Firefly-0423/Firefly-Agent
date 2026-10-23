import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { IPC } from "../../shared/ipc-channels";
import type { SettingsApi } from "../../renderer/settings/shared/types";
const m = vi.hoisted(() => ({ exposed: new Map<string, any>(), invoke: vi.fn(async () => ({ ok: true })), setEnabled: vi.fn(), chat: null as any }));
vi.mock("electron", () => ({ contextBridge: { exposeInMainWorld: (name: string, value: any) => m.exposed.set(name, value) }, ipcRenderer: { invoke: m.invoke, on: vi.fn(), removeListener: vi.fn(), send: vi.fn() }, webUtils: { getPathForFile: vi.fn() }, dialog: {} }));
vi.mock("../../preload/music", () => ({ exposeMusicApi: vi.fn() }));
vi.mock("../skills", () => ({ listSkillsForUi: vi.fn(), setSkillEnabled: m.setEnabled, skillRegistry: { getById: () => ({ id: "external-openai-test" }) }, rescanSkills: vi.fn() }));
vi.mock("../windows/window-state", () => ({ get reactChatWindow() { return m.chat; }, sidebarWindow: null, settingsWindow: null, stickerManagerWindow: null }));
vi.mock("../orchestrator/sticker-settings", () => ({ getStickerManagerConfig: vi.fn(), setStickerEnabled: vi.fn() }));
vi.mock("../stickers/sticker-storage", () => ({ addUserSticker: vi.fn(), deleteUserSticker: vi.fn() }));
vi.mock("../memory/panel", () => ({ loadImportedDocumentPanelData: vi.fn(), loadMemoryPanelData: vi.fn() }));
vi.mock("../rag", () => ({ deleteImportedDoc: vi.fn() }));
vi.mock("../settings-store", () => ({ loadUserProfile: vi.fn(), saveUserProfile: vi.fn(), getAvatarPath: vi.fn() }));
vi.mock("../orchestrator/mcp-manager", () => ({ addMcpServer: vi.fn(), removeMcpServer: vi.fn(), listMcpServers: vi.fn() }));
vi.mock("../orchestrator/tools/registry/tool-registry", () => ({ toolRegistry: vi.fn() }));
vi.mock("../settings/settings-facade", () => ({ loadGeneralSettings: vi.fn(), saveGeneralSettings: vi.fn() }));
vi.mock("../memory/memory-store", () => ({ memoryStore: vi.fn() }));
vi.mock("../memory/obsidian-exporter", () => ({ exportMemoryToObsidianVault: vi.fn(), syncToBoundVault: vi.fn() }));
vi.mock("../memory/obsidian-vault-config", () => ({ loadObsidianVaultConfig: () => ({}), saveObsidianVaultConfig: vi.fn(), unbindVault: vi.fn() }));
vi.mock("../memory/obsidian-importer", () => ({ startVaultWatcher: vi.fn(), stopVaultWatcher: vi.fn() }));
import { registerMemoryUserToolIpc } from "../memory/memory-user-ipc";
afterEach(() => { vi.clearAllMocks(); m.chat = null; });
it("preload_bridge exposes five DTO-only methods and reuses explicit enabled bridge", async () => {
  await import("../../preload/index"); const settings = m.exposed.get("settings") as SettingsApi;
  expect(settings.externalSkills, "Preload must expose fixed external-Skills DTO API").toBeDefined(); const api = settings.externalSkills!;
  await api.list("openai"); await api.list("anthropic", true); await api.detail("openai", "candidate"); await api.prepare("anthropic", "candidate"); await api.commit("a".repeat(64)); await api.cancel();
  expect(m.invoke.mock.calls).toEqual([["external-skills:list", { sourceId: "openai", refresh: false }], ["external-skills:list", { sourceId: "anthropic", refresh: true }], ["external-skills:detail", { sourceId: "openai", id: "candidate" }], ["external-skills:prepare", { sourceId: "anthropic", id: "candidate" }], ["external-skills:commit", { token: "a".repeat(64) }], ["external-skills:cancel", {}]]);
  m.invoke.mockClear(); await settings.setSkillEnabled!("external-openai-test", true); expect(m.invoke).toHaveBeenCalledExactlyOnceWith(IPC.SKILL_SET_ENABLED, { id: "external-openai-test", enabled: true }); expect(Object.keys(api).sort()).toEqual(["cancel", "commit", "detail", "list", "prepare"]);
});
function host() { return Object.assign(new EventEmitter(), { id: 4, mainFrame: { processId: 5, routingId: 6, detached: false }, isDestroyed: () => false }); }
it("preload forwards an explicit fixed revision assertion without adding approval data", async () => {
  await import("../../preload/index"); const api = (m.exposed.get("settings") as SettingsApi).externalSkills!;
  const selection = { kind: "reviewed", commit: "a".repeat(40) };
  await Reflect.apply(api.detail, api, ["openai", "candidate", selection]);
  await Reflect.apply(api.prepare, api, ["openai", "candidate", selection]);
  expect(m.invoke.mock.calls).toEqual([["external-skills:detail", { sourceId: "openai", id: "candidate", selection }], ["external-skills:prepare", { sourceId: "openai", id: "candidate", selection }]]);
});
function enabledHandler() { const handlers = new Map<string, any>(); registerMemoryUserToolIpc({ ipc: { handle: (c, h) => handlers.set(c, h), on: vi.fn(), removeHandler: vi.fn(), dispose: vi.fn() }, windowManager: null, embeddingIndexService: {} as any }); return handlers.get(IPC.SKILL_SET_ENABLED); }
it.each(["missing", "other-window", "subframe", "old-frame", "extra-field"])("preload_bridge legacy enable rejects external %s without activation", async kind => {
  const chat = host(); m.chat = { isDestroyed: () => false, webContents: chat }; let event: any = { sender: chat, senderFrame: chat.mainFrame }; let payload: any = { id: "external-openai-test", enabled: true };
  if (kind === "missing") event = {}; if (kind === "other-window") event = { sender: host(), senderFrame: chat.mainFrame }; if (kind === "subframe") event.senderFrame = { processId: 5, routingId: 7 }; if (kind === "old-frame") { event.senderFrame = chat.mainFrame; chat.mainFrame = { processId: 8, routingId: 9, detached: false }; } if (kind === "extra-field") payload.path = "/untrusted";
  expect(await enabledHandler()(event, payload)).toMatchObject({ ok: false }); expect(m.setEnabled).not.toHaveBeenCalled();
});
it("preload_bridge explicit external enable permits current trusted main frame", async () => { const chat = host(); m.chat = { isDestroyed: () => false, webContents: chat }; expect(await enabledHandler()({ sender: chat, senderFrame: chat.mainFrame }, { id: "external-openai-test", enabled: true })).toEqual({ ok: true }); expect(m.setEnabled).toHaveBeenCalledExactlyOnceWith("external-openai-test", true); });
