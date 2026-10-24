import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { IPC } from "../../shared/ipc-channels";
import type { IpcScope } from "../application/ipc-scope";

const mocks = vi.hoisted(() => ({
  path: "", memory: { getL0: vi.fn(), getL1: vi.fn(), getAllL2: vi.fn(), getReflectionLogs: vi.fn(), updateL0: vi.fn(), updateL1: vi.fn() },
  open: vi.fn(), exportVault: vi.fn(), syncVault: vi.fn(), loadVault: vi.fn(), saveVault: vi.fn(), unbindVault: vi.fn(), startWatcher: vi.fn(), stopWatcher: vi.fn(),
  deleteDoc: vi.fn(), stickers: vi.fn(), skills: vi.fn(), mcp: vi.fn(), settingsWindow: null as unknown,
}));
vi.mock("electron", () => ({ app: { getAppPath: () => process.cwd() }, dialog: { showOpenDialog: mocks.open } }));
vi.mock("../env", () => ({ isDev: false }));
vi.mock("../memory/memory-store", () => ({ memoryStore: mocks.memory }));
vi.mock("../settings-store", () => ({ getRagStorePath: () => mocks.path, loadUserProfile: vi.fn(), saveUserProfile: vi.fn(), getAvatarPath: vi.fn() }));
vi.mock("../orchestrator/sticker-settings", () => ({ getStickerManagerConfig: mocks.stickers, setStickerEnabled: vi.fn() }));
vi.mock("../stickers/sticker-storage", () => ({ addUserSticker: vi.fn(), deleteUserSticker: vi.fn() }));
vi.mock("../rag", () => ({ deleteImportedDoc: mocks.deleteDoc }));
vi.mock("../orchestrator/mcp-manager", () => ({ addMcpServer: vi.fn(), removeMcpServer: vi.fn(), listMcpServers: mocks.mcp }));
vi.mock("../orchestrator/tools/registry/tool-registry", () => ({ toolRegistry: {} }));
vi.mock("../settings/settings-facade", () => ({ loadGeneralSettings: vi.fn(), saveGeneralSettings: vi.fn() }));
vi.mock("../skills", () => ({ listSkillsForUi: mocks.skills, setSkillEnabled: vi.fn(), skillRegistry: {}, rescanSkills: vi.fn() }));
vi.mock("../windows/window-state", () => ({ reactChatWindow: null, sidebarWindow: null, get settingsWindow() { return mocks.settingsWindow; }, stickerManagerWindow: null }));
vi.mock("../memory/obsidian-exporter", () => ({ exportMemoryToObsidianVault: mocks.exportVault, syncToBoundVault: mocks.syncVault }));
vi.mock("../memory/obsidian-vault-config", () => ({ loadObsidianVaultConfig: mocks.loadVault, saveObsidianVaultConfig: mocks.saveVault, unbindVault: mocks.unbindVault }));
vi.mock("../memory/obsidian-importer", () => ({ startVaultWatcher: mocks.startWatcher, stopVaultWatcher: mocks.stopWatcher }));

import { registerMemoryUserToolIpc } from "../memory/memory-user-ipc";
import { loadImportedDocumentPanelData } from "../memory/panel";

let dir: string;
function register(mode: "legacy" | "smh" = "smh") {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const ipc: IpcScope = { handle: (name, handler) => { handlers.set(name, handler); }, on: vi.fn(), removeHandler: vi.fn(), dispose: vi.fn() };
  registerMemoryUserToolIpc({ windowManager: null, embeddingIndexService: {} as any, ipc, personalMemoryMode: mode });
  const invoke = (channel: string, payload?: unknown, event: unknown = {}) => handlers.get(channel)!(event, payload);
  return Object.assign(invoke, { channels: () => [...handlers.keys()] });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.settingsWindow = null;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-panel-")); mocks.path = path.join(dir, "memory-store.json");
  mocks.open.mockResolvedValue({ canceled: false, filePaths: [dir] });
  for (const read of [mocks.memory.getL0, mocks.memory.getL1]) read.mockResolvedValue({});
  mocks.memory.getAllL2.mockResolvedValue([]); mocks.memory.getReflectionLogs.mockResolvedValue([]);
  mocks.syncVault.mockResolvedValue({ ok: true }); mocks.loadVault.mockReturnValue({ vaultPath: "/old/vault" });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("Main SMH legacy IPC retirement", () => {
  it("registers no personal-memory write, export or Vault channel in either mode, and touches no old data or watcher", async () => {
    for (const mode of ["smh", "legacy"] as const) {
      const channels = register(mode).channels();
      expect(channels.filter((name) => /obsidian|save-l[01]|panel-save/i.test(name))).toEqual([]);
    }
    for (const fn of [...Object.values(mocks.memory), mocks.open, mocks.exportVault, mocks.syncVault, mocks.saveVault, mocks.unbindVault, mocks.startWatcher, mocks.stopWatcher, mocks.loadVault]) expect(fn).not.toHaveBeenCalled();
  });
  it("loads only imported document rows from the mixed RAG file without L0/L1/L2 reads", async () => {
    const mixed = [
      { source: "user_memory", text: "private old fact", createdAt: 99, metadata: { fileName: "private", importId: "secret" } },
      { source: "chat_history", text: "private old history", createdAt: 100 },
      { source: "imported_doc", createdAt: 2, metadata: { fileName: "book.md", importId: "doc-1" } },
      { source: "imported_doc", createdAt: 4, metadata: { fileName: "book.md", importId: "doc-1" } },
      { source: "imported_doc", createdAt: 8, metadata: { fileName: "legacy.md" } },
    ];
    const original = JSON.stringify(mixed); fs.writeFileSync(mocks.path, original);
    const expected = { importedDocs: [
      { importId: null, fileName: "legacy.md", chunkCount: 1, lastImportedAt: 8 },
      { importId: "doc-1", fileName: "book.md", chunkCount: 2, lastImportedAt: 4 },
    ] };
    expect(await register()(IPC.MEMORY_PANEL_GET_DATA)).toEqual(expected);
    expect(await loadImportedDocumentPanelData()).toEqual(expected);
    for (const fn of Object.values(mocks.memory)) expect(fn).not.toHaveBeenCalled();
    expect(fs.readFileSync(mocks.path, "utf8")).toBe(original);
  });
  it("preserves imported documents, sticker and MCP management", async () => {
    mocks.deleteDoc.mockReturnValue(2); mocks.stickers.mockReturnValue([{ id: "smile", enabled: true }]); mocks.mcp.mockReturnValue([{ id: "server" }]);
    const invoke = register();
    expect(await invoke(IPC.MEMORY_PANEL_DELETE_IMPORTED_DOC, { importId: "doc-1", fileName: "book.md" })).toEqual({ ok: true, deleted: 2 });
    expect(mocks.deleteDoc).toHaveBeenCalledWith("doc-1", "book.md");
    expect(await invoke(IPC.STICKERS_GET_CONFIG)).toEqual([{ id: "smile", enabled: true }]);
    const url = pathToFileURL(path.join(process.cwd(), "dist/renderer/settings/index.html")).href;
    const sender = { mainFrame: { url }, getURL: () => url, isDestroyed: () => false };
    mocks.settingsWindow = { webContents: sender, isDestroyed: () => false };
    expect(await invoke(IPC.MCP_LIST_SERVERS, undefined, { sender, senderFrame: sender.mainFrame })).toEqual([{ id: "server" }]);
  });
});
