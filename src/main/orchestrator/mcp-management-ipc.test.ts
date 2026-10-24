import { EventEmitter } from "node:events";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC } from "../../shared/ipc-channels";

const m = vi.hoisted(() => {
  const state: any = {
    isDev: false,
    appPath: "C:/firefly-app",
    dialogResponse: 1 as number,
    dialogImpl: null as null | (() => Promise<{ response: number }>),
    dialogCalls: [] as unknown[][],
    window: null as any,
    add: vi.fn(),
    remove: vi.fn(),
    setEnabled: vi.fn(),
    listConfigs: vi.fn(),
    listServers: vi.fn(),
  };
  state.showMessageBox = vi.fn(async (...args: unknown[]) => {
    state.dialogCalls.push(args);
    return state.dialogImpl ? state.dialogImpl() : { response: state.dialogResponse };
  });
  return state;
});

vi.mock("electron", () => ({
  app: { getAppPath: () => m.appPath },
  dialog: { showMessageBox: m.showMessageBox },
}));
vi.mock("../env", () => ({
  get isDev() {
    return m.isDev;
  },
}));
vi.mock("./mcp-manager", () => ({
  addMcpServer: (...args: unknown[]) => m.add(...args),
  removeMcpServer: (...args: unknown[]) => m.remove(...args),
  setMcpServerEnabled: (...args: unknown[]) => m.setEnabled(...args),
  listMcpServerConfigs: () => m.listConfigs(),
  listMcpServers: () => m.listServers(),
}));

import { registerMcpManagementIpc } from "./mcp-management-ipc";

class FakeWebContents extends EventEmitter {
  mainFrame: { url: string };
  destroyed = false;
  readonly sent: unknown[][] = [];
  constructor(public currentUrl: string) {
    super();
    this.mainFrame = { url: currentUrl };
  }
  isDestroyed() {
    return this.destroyed;
  }
  getURL() {
    return this.currentUrl;
  }
  send(...args: unknown[]) {
    this.sent.push(args);
  }
}

function expectedUrl() {
  return m.isDev
    ? "http://localhost:5173/settings/"
    : pathToFileURL(path.join(m.appPath, "dist", "renderer", "settings", "index.html")).href;
}

function makeWindow(url = expectedUrl()) {
  const webContents = new FakeWebContents(url);
  return { webContents, windowDestroyed: false, isDestroyed() { return this.windowDestroyed; } };
}

function eventFor(win: ReturnType<typeof makeWindow>, frame: unknown = win.webContents.mainFrame) {
  return { sender: win.webContents, senderFrame: frame } as never;
}

type Handler = (event: never, ...args: unknown[]) => unknown;

function register() {
  const handlers = new Map<string, Handler>();
  registerMcpManagementIpc({
    ipc: { handle: (channel: string, listener: Handler) => void handlers.set(channel, listener) } as never,
    getSettingsWindow: () => m.window,
  });
  return handlers;
}

const validStdio = (overrides: Record<string, unknown> = {}) => ({
  id: "server-1",
  name: "My Server",
  transport: "stdio",
  command: "node",
  ...overrides,
});

const validSse = (overrides: Record<string, unknown> = {}) => ({
  id: "server-1",
  name: "My Server",
  transport: "sse",
  url: "https://example.com/mcp?token=1",
  ...overrides,
});

let handlers: ReturnType<typeof register>;

beforeEach(() => {
  vi.clearAllMocks();
  m.isDev = false;
  m.appPath = "C:/firefly-app";
  m.dialogResponse = 1;
  m.dialogImpl = null;
  m.dialogCalls = [];
  m.window = makeWindow();
  m.add.mockResolvedValue({ ok: true, toolIds: ["tool-a"] });
  m.remove.mockResolvedValue({ ok: true });
  m.setEnabled.mockResolvedValue({ ok: true, toolIds: ["tool-b"] });
  m.listConfigs.mockReturnValue([{ id: "saved", name: "Saved", transport: "stdio", command: "node" }]);
  m.listServers.mockReturnValue([{ id: "saved", name: "Saved", connected: false }]);
  handlers = register();
});

const add = (input: unknown, event = eventFor(m.window)) => handlers.get(IPC.MCP_ADD_SERVER)!(event, input);
const remove = (input: unknown, event = eventFor(m.window)) => handlers.get(IPC.MCP_REMOVE_SERVER)!(event, input);
const setEnabled = (input: unknown, event = eventFor(m.window)) => handlers.get(IPC.MCP_SET_ENABLED)!(event, input);
const list = (event = eventFor(m.window)) => handlers.get(IPC.MCP_LIST_SERVERS)!(event);

describe("owner verification", () => {
  it.each([
    ["no settings window", (win: ReturnType<typeof makeWindow>, event: { sender?: unknown }) => {
      m.window = null;
      void win;
      void event;
    }],
    ["a destroyed window", (win: ReturnType<typeof makeWindow>) => { win.windowDestroyed = true; }],
    ["a destroyed web contents", (win: ReturnType<typeof makeWindow>) => { win.webContents.destroyed = true; }],
    ["a different sender", (_win: ReturnType<typeof makeWindow>, event: { sender?: unknown }) => {
      event.sender = new FakeWebContents(expectedUrl());
    }],
  ])("denies mutations with %s", (_label, setup) => {
    const win = makeWindow();
    m.window = win;
    const event = eventFor(win) as { sender?: unknown };
    setup(win, event);
    expect(add(validStdio(), event as never)).toEqual({
      ok: false,
      code: "MCP_FORBIDDEN",
      error: "MCP_FORBIDDEN",
    });
  });

  it("denies when the sender frame is not the window main frame", () => {
    expect(add(validStdio(), eventFor(m.window, { url: expectedUrl() }))).toMatchObject({ code: "MCP_FORBIDDEN" });
  });

  it("denies when the sender frame is missing or the URL is not a URL", () => {
    expect(add(validStdio(), eventFor(m.window, null))).toMatchObject({ code: "MCP_FORBIDDEN" });
    m.window.webContents.mainFrame.url = "not a url";
    expect(add(validStdio())).toMatchObject({ code: "MCP_FORBIDDEN" });
  });

  it("requires the exact settings document URL and ignores hash fragments", () => {
    m.window = makeWindow("https://evil.example/settings/");
    expect(() => list()).toThrow("MCP_FORBIDDEN");
    m.window = makeWindow(expectedUrl() + "#section");
    expect(list()).toEqual([{ id: "saved", name: "Saved", connected: false }]);
  });

  it("accepts the Vite settings URL only in development", () => {
    m.isDev = true;
    m.window = makeWindow("http://localhost:5173/settings/");
    expect(list()).toEqual([{ id: "saved", name: "Saved", connected: false }]);
    m.window = makeWindow(pathToFileURL(path.join(m.appPath, "dist", "renderer", "settings", "index.html")).href);
    expect(() => list()).toThrow("MCP_FORBIDDEN");
    m.isDev = false;
    m.window = makeWindow("http://localhost:5173/settings/");
    expect(() => list()).toThrow("MCP_FORBIDDEN");
  });
});

describe("MCP_ADD_SERVER validation", () => {
  it.each([
    ["null", null],
    ["an array", []],
    ["a primitive", "server"],
    ["an unknown key", { ...validStdio(), extra: true }],
    ["a blank id", { ...validStdio(), id: "   " }],
    ["an oversized id", { ...validStdio(), id: "x".repeat(129) }],
    ["an id with a NUL", { ...validStdio(), id: "a\0b" }],
    ["a blank name", { ...validStdio(), name: "" }],
    ["an oversized name", { ...validStdio(), name: "x".repeat(257) }],
    ["an unknown transport", { ...validStdio(), transport: "ws" }],
    ["stdio without a command", { ...validStdio(), command: undefined }],
    ["stdio with a blank command", { ...validStdio(), command: "  " }],
    ["stdio with a URL", { ...validStdio(), url: "https://example.com" }],
    ["stdio with a non-array args", { ...validStdio(), args: "node" }],
    ["stdio with too many args", { ...validStdio(), args: Array.from({ length: 257 }, () => "x") }],
    ["stdio with a non-string arg", { ...validStdio(), args: ["a", 1] }],
    ["stdio with an oversized arg", { ...validStdio(), args: ["x".repeat(8193)] }],
    ["stdio with an arg containing NUL", { ...validStdio(), args: ["a\0b"] }],
    ["stdio with a blank cwd", { ...validStdio(), cwd: " " }],
    ["stdio with a non-record env", { ...validStdio(), env: [] }],
    ["stdio with a blank env key", { ...validStdio(), env: { " ": "v" } }],
    ["stdio with an env key containing equals", { ...validStdio(), env: { "A=B": "v" } }],
    ["stdio with more than 128 env entries", { ...validStdio(), env: Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`K${i}`, "v"])) }],
    ["sse without a URL", { ...validSse(), url: undefined }],
    ["sse with an invalid URL", { ...validSse(), url: "not a url" }],
    ["sse with a non-http protocol", { ...validSse(), url: "ftp://example.com/mcp" }],
    ["sse with credentials", { ...validSse(), url: "https://user:pass@example.com/mcp" }],
    ["sse with a hash", { ...validSse(), url: "https://example.com/mcp#frag" }],
    ["sse with a command", { ...validSse(), command: "node" }],
    ["sse with args", { ...validSse(), args: [] }],
    ["sse with env", { ...validSse(), env: {} }],
    ["sse with cwd", { ...validSse(), cwd: "C:/work" }],
  ])("rejects %s", (_label, input) => {
    expect(add(input)).toEqual({ ok: false, code: "MCP_INVALID_REQUEST", error: "MCP_INVALID_REQUEST" });
    expect(m.add).not.toHaveBeenCalled();
    expect(m.showMessageBox).not.toHaveBeenCalled();
  });

  it("rejects an object with an accessor property", () => {
    const input = { ...validStdio() };
    Object.defineProperty(input, "name", { get: () => "Server", enumerable: true });
    expect(add(input)).toMatchObject({ code: "MCP_INVALID_REQUEST" });
  });

  it("rejects a configuration whose serialized form exceeds 64 KiB", () => {
    expect(add(validStdio({ args: Array.from({ length: 9 }, () => "x".repeat(8192)) }))).toMatchObject({
      code: "MCP_INVALID_REQUEST",
    });
  });

  it("accepts the exact field boundaries and blank args/env values", async () => {
    const input = validStdio({
      id: "i".repeat(128),
      name: "n".repeat(256),
      command: "c".repeat(8192),
      args: ["", "  ", "x".repeat(8192)],
      cwd: "C:/work",
      env: { KEY: "", OTHER: " " },
    });
    await expect(add(input)).resolves.toEqual({ ok: true, toolIds: ["tool-a"] });
    expect(m.add).toHaveBeenCalledWith({
      id: "i".repeat(128),
      name: "n".repeat(256),
      transport: "stdio",
      command: "c".repeat(8192),
      args: ["", "  ", "x".repeat(8192)],
      cwd: "C:/work",
      env: { KEY: "", OTHER: " " },
    });
  });

  it("refuses the built-in Playwright server before prompting", () => {
    expect(add(validStdio({ id: "playwright-mcp" }))).toMatchObject({ code: "MCP_BUILTIN_MANAGED" });
    expect(m.showMessageBox).not.toHaveBeenCalled();
    expect(m.add).not.toHaveBeenCalled();
  });

  it("confirms and adds a stdio server, summarizing program, args, cwd and env names", async () => {
    const result = await add(validStdio({ args: ["serve", "--flag"], cwd: "C:/work", env: { TOKEN: "secret" } }));
    expect(result).toEqual({ ok: true, toolIds: ["tool-a"] });
    expect(m.showMessageBox).toHaveBeenCalledWith(
      m.window,
      expect.objectContaining({
        type: "warning",
        title: "Firefly · MCP",
        message: '添加并连接 MCP："My Server"',
        buttons: ["取消", "继续"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      }),
    );
    const detail = (m.showMessageBox.mock.calls[0]![1] as { detail: string }).detail;
    expect(detail).toContain("程序：\"node\"");
    expect(detail).toContain("参数：[\"serve\",\"--flag\"]");
    expect(detail).toContain("工作目录：\"C:/work\"");
    expect(detail).toContain("环境变量名称：[\"TOKEN\"]");
    expect(detail).not.toContain("secret");
    expect(m.add).toHaveBeenCalledWith(validStdio({ args: ["serve", "--flag"], cwd: "C:/work", env: { TOKEN: "secret" } }));
  });

  it("uses default args, cwd and env in the summary when omitted", async () => {
    await add(validStdio());
    const detail = (m.showMessageBox.mock.calls[0]![1] as { detail: string }).detail;
    expect(detail).toContain("参数：[]");
    expect(detail).toContain("工作目录：\"默认\"");
    expect(detail).toContain("环境变量名称：[]");
    expect(m.add).toHaveBeenCalledWith(validStdio());
  });

  it("summarizes an SSE endpoint by origin and pathname only", async () => {
    await add(validSse());
    const detail = (m.showMessageBox.mock.calls[0]![1] as { detail: string }).detail;
    expect(detail).toContain("地址：https://example.com/mcp");
    expect(detail).not.toContain("token=1");
    expect(m.add).toHaveBeenCalledWith(validSse());
  });

  it("returns cancellation without running the operation", async () => {
    m.dialogResponse = 0;
    await expect(add(validStdio())).resolves.toEqual({ ok: false, code: "MCP_CANCELLED", error: "MCP_CANCELLED" });
    expect(m.add).not.toHaveBeenCalled();
  });

  it("propagates an operation failure and its fixed reason", async () => {
    m.add.mockResolvedValue({ ok: false, reason: "spawn_failed" });
    await expect(add(validStdio())).resolves.toEqual({
      ok: false,
      code: "MCP_OPERATION_FAILED",
      error: "MCP_OPERATION_FAILED",
      reason: "spawn_failed",
    });
  });

  it("returns a failure without a reason when the operation throws", async () => {
    m.add.mockRejectedValue(new Error("boom"));
    const result = await add(validStdio());
    expect(result).toEqual({ ok: false, code: "MCP_OPERATION_FAILED", error: "MCP_OPERATION_FAILED" });
    expect(result).not.toHaveProperty("reason");
  });

  it("reports a busy window while a previous mutation is still awaiting confirmation", async () => {
    let approve!: (value: { response: number }) => void;
    m.dialogImpl = () => new Promise(resolve => (approve = resolve));
    const first = add(validStdio());
    await expect(add(validStdio({ id: "server-2" }))).resolves.toEqual({
      ok: false,
      code: "MCP_BUSY",
      error: "MCP_BUSY",
    });
    approve({ response: 0 });
    await expect(first).resolves.toMatchObject({ code: "MCP_CANCELLED" });
  });

  it.each([
    ["a main-frame navigation", "did-start-navigation", { isMainFrame: true }],
    ["a renderer crash", "render-process-gone", {}],
    ["the web contents being destroyed", "destroyed", {}],
  ])("revokes the grant after %s", async (_label, name, payload) => {
    m.dialogImpl = async () => {
      m.window.webContents.emit(name, payload);
      return { response: 1 };
    };
    await expect(add(validStdio())).resolves.toEqual({ ok: false, code: "MCP_FORBIDDEN", error: "MCP_FORBIDDEN" });
    expect(m.add).not.toHaveBeenCalled();
  });

  it("does not revoke on a subframe navigation", async () => {
    m.dialogImpl = async () => {
      m.window.webContents.emit("did-start-navigation", { isMainFrame: false });
      return { response: 1 };
    };
    await expect(add(validStdio())).resolves.toEqual({ ok: true, toolIds: ["tool-a"] });
  });

  it("revokes when the settings window changes while the dialog is open", async () => {
    m.dialogImpl = async () => {
      m.window = makeWindow();
      return { response: 1 };
    };
    await expect(add(validStdio())).resolves.toMatchObject({ code: "MCP_FORBIDDEN" });
    expect(m.add).not.toHaveBeenCalled();
  });
});

describe("MCP_REMOVE_SERVER", () => {
  it.each([[""], ["   "], ["x".repeat(129)], ["a\0b"], [42], [null]])("rejects invalid id %j", input => {
    expect(remove(input)).toMatchObject({ code: "MCP_INVALID_REQUEST" });
    expect(m.remove).not.toHaveBeenCalled();
  });

  it("refuses the built-in Playwright server", () => {
    expect(remove("playwright-mcp")).toMatchObject({ code: "MCP_BUILTIN_MANAGED" });
    expect(m.showMessageBox).not.toHaveBeenCalled();
  });

  it("confirms removal and forwards the id", async () => {
    await expect(remove("saved")).resolves.toEqual({ ok: true });
    expect(m.showMessageBox).toHaveBeenCalledWith(
      m.window,
      expect.objectContaining({
        message: '移除并断开 MCP："saved"',
        detail: expect.stringContaining("移除后不会再按这份配置自动连接。"),
      }),
    );
    expect(m.remove).toHaveBeenCalledWith("saved");
  });

  it("returns cancellation without removing", async () => {
    m.dialogResponse = 0;
    await expect(remove("saved")).resolves.toMatchObject({ code: "MCP_CANCELLED" });
    expect(m.remove).not.toHaveBeenCalled();
  });
});

describe("MCP_SET_ENABLED", () => {
  it.each([
    ["null", null],
    ["a missing enabled flag", { id: "saved" }],
    ["an extra key", { id: "saved", enabled: true, extra: 1 }],
    ["a blank id", { id: " ", enabled: true }],
    ["a non-boolean enabled", { id: "saved", enabled: "yes" }],
  ])("rejects %s", (_label, input) => {
    expect(setEnabled(input)).toMatchObject({ code: "MCP_INVALID_REQUEST" });
  });

  it("refuses the built-in Playwright server", () => {
    expect(setEnabled({ id: "playwright-mcp", enabled: false })).toMatchObject({ code: "MCP_BUILTIN_MANAGED" });
  });

  it("returns MCP_OPERATION_FAILED when stored configuration cannot be read", () => {
    m.listConfigs.mockImplementation(() => {
      throw new Error("disk");
    });
    expect(setEnabled({ id: "saved", enabled: false })).toMatchObject({ code: "MCP_OPERATION_FAILED" });
    expect(m.setEnabled).not.toHaveBeenCalled();
  });

  it("returns MCP_NOT_FOUND for an unknown id without prompting", () => {
    m.listConfigs.mockReturnValue([]);
    expect(setEnabled({ id: "missing", enabled: true })).toEqual({
      ok: false,
      code: "MCP_NOT_FOUND",
      error: "MCP_NOT_FOUND",
    });
    expect(m.showMessageBox).not.toHaveBeenCalled();
  });

  it("confirms enabling with the stored command and returns new tool ids", async () => {
    await expect(setEnabled({ id: "saved", enabled: true })).resolves.toEqual({ ok: true, toolIds: ["tool-b"] });
    expect(m.showMessageBox).toHaveBeenCalledWith(
      m.window,
      expect.objectContaining({
        message: '启用并连接 MCP："Saved"',
        detail: expect.stringContaining("程序：\"node\""),
      }),
    );
    expect(m.setEnabled).toHaveBeenCalledWith("saved", true);
  });

  it("disables without confirmation", async () => {
    m.setEnabled.mockResolvedValue({ ok: true });
    await expect(setEnabled({ id: "saved", enabled: false })).resolves.toEqual({ ok: true });
    expect(m.showMessageBox).not.toHaveBeenCalled();
    expect(m.setEnabled).toHaveBeenCalledWith("saved", false);
  });

  it("describes SSE configuration in the enable confirmation", async () => {
    m.listConfigs.mockReturnValue([{ id: "saved", name: "Saved", transport: "sse", url: "https://example.com/mcp?a=1" }]);
    await setEnabled({ id: "saved", enabled: true });
    expect((m.showMessageBox.mock.calls[0]![1] as { detail: string }).detail).toContain("地址：https://example.com/mcp");
  });

  it("returns cancellation when enabling is not approved", async () => {
    m.dialogResponse = 0;
    await expect(setEnabled({ id: "saved", enabled: true })).resolves.toMatchObject({ code: "MCP_CANCELLED" });
    expect(m.setEnabled).not.toHaveBeenCalled();
  });

  it("propagates an operation failure reason for enable", async () => {
    m.setEnabled.mockResolvedValue({ ok: false, reason: "timeout" });
    await expect(setEnabled({ id: "saved", enabled: true })).resolves.toEqual({
      ok: false,
      code: "MCP_OPERATION_FAILED",
      error: "MCP_OPERATION_FAILED",
      reason: "timeout",
    });
  });
});

describe("MCP_LIST_SERVERS", () => {
  it("returns the manager's list", () => {
    const value = list();
    expect(value).toEqual([{ id: "saved", name: "Saved", connected: false }]);
  });

  it("throws MCP_LIST_FAILED when the manager fails", () => {
    m.listServers.mockImplementation(() => {
      throw new Error("disk");
    });
    expect(() => list()).toThrow("MCP_LIST_FAILED");
  });

  it("throws MCP_FORBIDDEN without a trusted owner", () => {
    const event = eventFor(m.window);
    m.window = null;
    expect(() => list(event)).toThrow("MCP_FORBIDDEN");
  });
});
