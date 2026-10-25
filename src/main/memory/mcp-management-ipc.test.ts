import { EventEmitter } from "node:events";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC } from "../../shared/ipc-channels";
import type { IpcScope } from "../application/ipc-scope";

const mocks = vi.hoisted(() => ({
  appPath: "", window: null as unknown, confirm: vi.fn(), add: vi.fn(), remove: vi.fn(), list: vi.fn(), setEnabled: vi.fn(), configs: vi.fn(),
}));
vi.mock("electron", () => ({ app: { getAppPath: () => mocks.appPath }, dialog: { showMessageBox: mocks.confirm } }));
vi.mock("../startup/env", () => ({ isDev: false }));
vi.mock("./memory-store", () => ({ memoryStore: {} }));
vi.mock("../storage/settings-store", () => ({ loadUserProfile: vi.fn(), saveUserProfile: vi.fn(), getAvatarPath: vi.fn() }));
vi.mock("../orchestrator/sticker-settings", () => ({ getStickerManagerConfig: vi.fn(), setStickerEnabled: vi.fn() }));
vi.mock("../stickers/sticker-storage", () => ({ addUserSticker: vi.fn(), deleteUserSticker: vi.fn() }));
vi.mock("./panel", () => ({ loadImportedDocumentPanelData: vi.fn(), loadMemoryPanelData: vi.fn() }));
vi.mock("../rag", () => ({ deleteImportedDoc: vi.fn() }));
vi.mock("../orchestrator/mcp-manager", () => ({ addMcpServer: mocks.add, removeMcpServer: mocks.remove, listMcpServers: mocks.list, setMcpServerEnabled: mocks.setEnabled, listMcpServerConfigs: mocks.configs }));
vi.mock("../orchestrator/tools/registry/tool-registry", () => ({ toolRegistry: {} }));
vi.mock("../settings/settings-facade", () => ({ loadGeneralSettings: vi.fn(), saveGeneralSettings: vi.fn() }));
vi.mock("../skills", () => ({ listSkillsForUi: vi.fn(), setSkillEnabled: vi.fn(), skillRegistry: {}, rescanSkills: vi.fn() }));
vi.mock("../windows/window-state", () => ({ reactChatWindow: null, sidebarWindow: null, get settingsWindow() { return mocks.window; }, stickerManagerWindow: null }));
vi.mock("./obsidian-exporter", () => ({ exportMemoryToObsidianVault: vi.fn(), syncToBoundVault: vi.fn() }));
vi.mock("./obsidian-vault-config", () => ({ loadObsidianVaultConfig: vi.fn(), saveObsidianVaultConfig: vi.fn(), unbindVault: vi.fn() }));
vi.mock("./obsidian-importer", () => ({ startVaultWatcher: vi.fn(), stopVaultWatcher: vi.fn() }));

import { registerMemoryUserToolIpc } from "./memory-user-ipc";

function fixture() {
  const url = pathToFileURL(path.join(mocks.appPath, "dist/renderer/settings/index.html")).href;
  const contents = Object.assign(new EventEmitter(), { id: 7, mainFrame: { url }, getURL: () => contents.mainFrame.url, isDestroyed: () => false });
  const window = { webContents: contents, isDestroyed: () => false };
  mocks.window = window;
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ipc: IpcScope = { handle: (channel, handler) => { handlers.set(channel, handler); }, on: vi.fn(), removeHandler: vi.fn(), dispose: vi.fn() };
  registerMemoryUserToolIpc({ windowManager: null, embeddingIndexService: {} as never, ipc, personalMemoryMode: "smh" });
  const event = { sender: contents, senderFrame: contents.mainFrame };
  return { event, contents, window, invoke: (channel: string, payload?: unknown, owner: unknown = event) => Promise.resolve().then(() => handlers.get(channel)!(owner, payload)) };
}
const config = () => ({ id: "public-smoke", name: "Public smoke", transport: "stdio", command: "node", args: ["public-server.js"] });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.appPath = path.resolve("public-firefly-fixture");
  mocks.confirm.mockResolvedValue({ response: 1 });
  mocks.add.mockResolvedValue({ ok: true, toolIds: ["public_tool"] });
  mocks.remove.mockResolvedValue({ ok: true });
  mocks.setEnabled.mockResolvedValue({ ok: true, toolIds: ["public_tool"] });
  mocks.configs.mockReturnValue([{ ...config(), env: { PUBLIC_FIXTURE: "safe" } }]);
  mocks.list.mockReturnValue([{ id: "public-smoke", name: "Public smoke", connected: false, toolCount: 0, toolIds: [] }]);
});

describe("MCP Main management boundary", () => {
  it.each(["foreign", "same-id-foreign", "subframe", "missing-frame", "destroyed", "wrong-page", "window-replaced"])("denies %s before reading configuration, prompting or executing", async kind => {
    const f = fixture();
    let event: unknown = f.event;
    if (kind === "foreign") event = { sender: {}, senderFrame: f.contents.mainFrame };
    if (kind === "same-id-foreign") event = { sender: { ...f.contents }, senderFrame: f.contents.mainFrame };
    if (kind === "subframe") event = { ...f.event, senderFrame: { url: f.contents.mainFrame.url } };
    if (kind === "missing-frame") event = { sender: f.contents };
    if (kind === "destroyed") f.window.isDestroyed = () => true;
    if (kind === "wrong-page") f.contents.mainFrame.url = "https://example.com/settings/";
    if (kind === "window-replaced") mocks.window = { ...f.window, webContents: {} };
    expect(await f.invoke(IPC.MCP_ADD_SERVER, config(), event)).toMatchObject({ ok: false, code: "MCP_FORBIDDEN" });
    expect(await f.invoke(IPC.MCP_REMOVE_SERVER, "public-smoke", event)).toMatchObject({ ok: false, code: "MCP_FORBIDDEN" });
    await expect(f.invoke(IPC.MCP_LIST_SERVERS, undefined, event)).rejects.toThrow("MCP_FORBIDDEN");
    for (const operation of [mocks.confirm, mocks.add, mocks.remove, mocks.list]) expect(operation).not.toHaveBeenCalled();
  });

  it.each([
    null, [], {}, { ...config(), id: "" }, { ...config(), transport: "streamable-http" },
    { ...config(), command: " " }, { ...config(), command: "node\0hidden" },
    { ...config(), args: "not-an-array" }, { ...config(), args: [true] }, { ...config(), args: new Array(2) },
    { ...config(), args: Array(257).fill("arg") }, { ...config(), env: { TOKEN: false } },
    { ...config(), env: { "BAD=KEY": "value" } }, { ...config(), cwd: 3 },
    { ...config(), url: "https://example.com" }, { ...config(), approved: true },
    { ...config(), effectKindOverrides: { tool: "read" } },
    { id: "sse", name: "SSE", transport: "sse", url: "file:///private" },
    { id: "sse", name: "SSE", transport: "sse", url: "https://name:secret@example.com/" },
    { id: "sse", name: "SSE", transport: "sse", url: "https://example.com/", command: "node" },
    { ...config(), name: "x".repeat(257) },
  ])("rejects malformed or privilege-bearing input %# before native confirmation", async input => {
    const f = fixture();
    expect(await f.invoke(IPC.MCP_ADD_SERVER, input)).toMatchObject({ ok: false, code: "MCP_INVALID_REQUEST" });
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.add).not.toHaveBeenCalled();
  });

  it("requires native approval, preserves the snapshot and accepts the current settings fragment", async () => {
    const f = fixture(); f.contents.mainFrame.url += "#plugins";
    const input = { ...config(), env: { PUBLIC_FIXTURE: "safe" } };
    let complete!: (value: { response: number }) => void;
    mocks.confirm.mockReturnValue(new Promise(resolve => { complete = resolve; }));
    const pending = f.invoke(IPC.MCP_ADD_SERVER, input); await vi.waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
    expect(mocks.add).not.toHaveBeenCalled();
    input.args[0] = "mutated.js"; input.env.PUBLIC_FIXTURE = "changed";
    complete({ response: 1 });
    expect(await pending).toEqual({ ok: true, toolIds: ["public_tool"] });
    expect(mocks.add).toHaveBeenCalledWith({ ...config(), env: { PUBLIC_FIXTURE: "safe" } });
    expect(mocks.confirm.mock.calls[0][0]).toBe(f.window);
    expect(mocks.confirm.mock.calls[0][1].detail).toContain("public-server.js");
    expect(mocks.confirm.mock.calls[0][1].detail).not.toContain("PUBLIC_FIXTURE=safe");
  });

  it("canceling native approval does not add or remove configuration", async () => {
    const f = fixture(); mocks.confirm.mockResolvedValue({ response: 0 });
    expect(await f.invoke(IPC.MCP_ADD_SERVER, config())).toMatchObject({ ok: false, code: "MCP_CANCELLED" });
    expect(await f.invoke(IPC.MCP_REMOVE_SERVER, "public-smoke")).toMatchObject({ ok: false, code: "MCP_CANCELLED" });
    expect(mocks.add).not.toHaveBeenCalled(); expect(mocks.remove).not.toHaveBeenCalled();
  });

  it.each(["same-url-navigation", "replacement", "destroyed"])("revokes pending confirmation on %s", async kind => {
    const f = fixture();
    mocks.confirm.mockImplementation(async () => {
      if (kind === "same-url-navigation") f.contents.emit("did-start-navigation", { isMainFrame: true });
      if (kind === "replacement") mocks.window = { ...f.window, webContents: {} };
      if (kind === "destroyed") f.contents.emit("destroyed");
      return { response: 1 };
    });
    expect(await f.invoke(IPC.MCP_ADD_SERVER, config())).toMatchObject({ ok: false, code: "MCP_FORBIDDEN" });
    expect(mocks.add).not.toHaveBeenCalled();
    expect(f.contents.listenerCount("did-start-navigation")).toBe(0);
  });

  it("serializes confirmation per owner without duplicate execution", async () => {
    const f = fixture(); let complete!: (value: { response: number }) => void;
    mocks.confirm.mockReturnValue(new Promise(resolve => { complete = resolve; }));
    const first = f.invoke(IPC.MCP_ADD_SERVER, config()); await vi.waitFor(() => expect(mocks.confirm).toHaveBeenCalled());
    expect(await f.invoke(IPC.MCP_ADD_SERVER, config())).toMatchObject({ ok: false, code: "MCP_BUSY" });
    complete({ response: 1 }); await first; expect(mocks.add).toHaveBeenCalledTimes(1);
  });

  it("returns sanitized failures and never passes transport errors to Renderer", async () => {
    const f = fixture(); mocks.add.mockResolvedValue({ ok: false, error: "TOKEN=synthetic-private-value" });
    const result = await f.invoke(IPC.MCP_ADD_SERVER, config());
    expect(result).toMatchObject({ ok: false, code: "MCP_OPERATION_FAILED" });
    expect(JSON.stringify(result)).not.toContain("synthetic-private-value");
    mocks.remove.mockRejectedValue(new Error("TOKEN=synthetic-private-value"));
    expect(await f.invoke(IPC.MCP_REMOVE_SERVER, "public-smoke")).toMatchObject({ ok: false, code: "MCP_OPERATION_FAILED" });
    mocks.list.mockImplementation(() => { throw new Error("TOKEN=synthetic-private-value"); });
    await expect(f.invoke(IPC.MCP_LIST_SERVERS)).rejects.toThrow("MCP_LIST_FAILED");
  });

  it("preserves safe list reads and protects the built-in MCP management route", async () => {
    const f = fixture();
    expect(await f.invoke(IPC.MCP_LIST_SERVERS)).toHaveLength(1);
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(await f.invoke(IPC.MCP_REMOVE_SERVER, "playwright-mcp")).toMatchObject({ ok: false, code: "MCP_BUILTIN_MANAGED" });
    expect(mocks.remove).not.toHaveBeenCalled();
  });
});

describe("MCP enable and disable boundary", () => {
  const request = (enabled: boolean, id = "public-smoke") => ({ id, enabled });

  it.each(["foreign", "subframe", "wrong-page"])("denies %s before reading configuration, prompting or executing", async kind => {
    const f = fixture();
    let event: unknown = f.event;
    if (kind === "foreign") event = { sender: {}, senderFrame: f.contents.mainFrame };
    if (kind === "subframe") event = { ...f.event, senderFrame: { url: f.contents.mainFrame.url } };
    if (kind === "wrong-page") f.contents.mainFrame.url = "https://example.com/settings/";
    expect(await f.invoke(IPC.MCP_SET_ENABLED, request(true), event)).toMatchObject({ ok: false, code: "MCP_FORBIDDEN" });
    for (const operation of [mocks.confirm, mocks.configs, mocks.setEnabled]) expect(operation).not.toHaveBeenCalled();
  });

  it.each([null, [], {}, { id: "public-smoke" }, { id: "public-smoke", enabled: "yes" }, { id: "", enabled: true }, { id: 3, enabled: true }, { ...request(true), extra: 1 }])(
    "rejects malformed input %# before any prompt", async input => {
      const f = fixture();
      expect(await f.invoke(IPC.MCP_SET_ENABLED, input)).toMatchObject({ ok: false, code: "MCP_INVALID_REQUEST" });
      expect(mocks.confirm).not.toHaveBeenCalled(); expect(mocks.setEnabled).not.toHaveBeenCalled();
    });

  it("leaves the built-in Playwright server to its own toggle", async () => {
    const f = fixture();
    expect(await f.invoke(IPC.MCP_SET_ENABLED, request(false, "playwright-mcp"))).toMatchObject({ ok: false, code: "MCP_BUILTIN_MANAGED" });
    expect(mocks.setEnabled).not.toHaveBeenCalled();
  });

  it("answers an unknown server without prompting", async () => {
    const f = fixture(); mocks.configs.mockReturnValue([]);
    expect(await f.invoke(IPC.MCP_SET_ENABLED, request(true))).toMatchObject({ ok: false, code: "MCP_NOT_FOUND" });
    expect(mocks.confirm).not.toHaveBeenCalled();
  });

  it("starting a server asks for native approval showing what will run, and only then runs it", async () => {
    const f = fixture(); let complete!: (value: { response: number }) => void;
    mocks.confirm.mockReturnValue(new Promise(resolve => { complete = resolve; }));
    const pending = f.invoke(IPC.MCP_SET_ENABLED, request(true)); await vi.waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
    expect(mocks.setEnabled).not.toHaveBeenCalled();
    expect(mocks.confirm.mock.calls[0][1].detail).toContain("public-server.js");
    expect(mocks.confirm.mock.calls[0][1].detail).not.toContain("safe");
    complete({ response: 1 });
    expect(await pending).toEqual({ ok: true, toolIds: ["public_tool"] });
    expect(mocks.setEnabled).toHaveBeenCalledWith("public-smoke", true);
  });

  it("canceling the native approval does not start the server", async () => {
    const f = fixture(); mocks.confirm.mockResolvedValue({ response: 0 });
    expect(await f.invoke(IPC.MCP_SET_ENABLED, request(true))).toMatchObject({ ok: false, code: "MCP_CANCELLED" });
    expect(mocks.setEnabled).not.toHaveBeenCalled();
  });

  it("stopping a server needs no prompt but still runs through the ownership checks", async () => {
    const f = fixture();
    expect(await f.invoke(IPC.MCP_SET_ENABLED, request(false))).toEqual({ ok: true, toolIds: ["public_tool"] });
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.setEnabled).toHaveBeenCalledWith("public-smoke", false);
  });

  it("revokes a pending start when the page navigates away", async () => {
    const f = fixture();
    mocks.confirm.mockImplementation(async () => { f.contents.emit("did-start-navigation", { isMainFrame: true }); return { response: 1 }; });
    expect(await f.invoke(IPC.MCP_SET_ENABLED, request(true))).toMatchObject({ ok: false, code: "MCP_FORBIDDEN" });
    expect(mocks.setEnabled).not.toHaveBeenCalled();
  });

  it("passes only the fixed failure reason to the renderer", async () => {
    const f = fixture();
    mocks.setEnabled.mockResolvedValue({ ok: false, error: "spawn TOKEN=synthetic-private-value ENOENT", reason: "command-not-found" });
    const result = await f.invoke(IPC.MCP_SET_ENABLED, request(true));
    expect(result).toEqual({ ok: false, code: "MCP_OPERATION_FAILED", error: "MCP_OPERATION_FAILED", reason: "command-not-found" });
    expect(JSON.stringify(result)).not.toContain("synthetic-private-value");
    mocks.add.mockResolvedValue({ ok: false, error: "TOKEN=synthetic-private-value", reason: "timeout" });
    expect(await f.invoke(IPC.MCP_ADD_SERVER, config())).toMatchObject({ ok: false, code: "MCP_OPERATION_FAILED", reason: "timeout" });
  });

  it("does not let a thrown error reach the renderer", async () => {
    const f = fixture(); mocks.setEnabled.mockRejectedValue(new Error("TOKEN=synthetic-private-value"));
    const result = await f.invoke(IPC.MCP_SET_ENABLED, request(false));
    expect(result).toMatchObject({ ok: false, code: "MCP_OPERATION_FAILED" });
    expect(JSON.stringify(result)).not.toContain("synthetic-private-value");
  });
});
