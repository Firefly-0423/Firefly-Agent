import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC } from "../../shared/ipc-channels";
import type { IpcScope } from "../application/ipc-scope";
import type { DispatchFn } from "./manager";

const mocks = vi.hoisted(() => ({
  ipcHandlers: new Map<string, (...args: any[]) => any>(),
  registered: [] as any[],
  windows: [] as any[],
  focused: null as any,
  wx: null as any,
  qq: null as any,
  qqbot: null as any,
  manager: {
    setDispatcher: vi.fn(),
    register: vi.fn((adapter: any) => mocks.registered.push(adapter)),
    startAll: vi.fn(async () => undefined),
    stopAll: vi.fn(async () => undefined),
    getAllStatus: vi.fn(() => ({})),
  },
  loadSettings: vi.fn(),
  saveSettings: vi.fn(),
  startInbound: vi.fn(),
  stopInbound: vi.fn(),
  reloadLog: vi.fn(),
  getRecentLog: vi.fn(() => []),
  clearLog: vi.fn(),
  pendingSenders: { list: vi.fn(() => []), onChange: vi.fn(), remove: vi.fn() },
  resolvePendingSender: vi.fn(),
  withPendingSenders: vi.fn((status: any) => status),
  resolveQqAuth: vi.fn(() => true),
  fetchQrCode: vi.fn(),
  createQrDataUrl: vi.fn(),
  bind: vi.fn(),
  snapshot: vi.fn(),
  unbind: vi.fn(),
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    getFocusedWindow: () => mocks.focused,
    getAllWindows: () => mocks.windows,
  },
}));
vi.mock("../application/ipc-scope", () => ({
  createIpcScope: vi.fn(() => ({
    handle: (channel: string, listener: (...args: any[]) => any) => mocks.ipcHandlers.set(channel, listener),
    removeHandler: vi.fn(),
    on: vi.fn(),
    dispose: vi.fn(),
  })),
}));
vi.mock("./settings-store", () => ({ loadChannelsSettings: mocks.loadSettings, saveChannelsSettings: mocks.saveSettings }));
vi.mock("./manager", () => ({ channelManager: mocks.manager }));
vi.mock("./conversation-binding-store", () => ({ getChannelConversationBindingStore: () => ({ store: true }) }));
vi.mock("../chats/chats-store", () => ({ listSessions: vi.fn(() => [{ id: "session-1" }]), getSession: vi.fn(() => ({ id: "session-1" })) }));
vi.mock("./conversation-binding-api", () => ({
  bindContextConversation: mocks.bind,
  getContextBindingSnapshot: mocks.snapshot,
  unbindContextConversation: mocks.unbind,
}));
vi.mock("./inbound-server", () => ({ startInboundServer: mocks.startInbound, stopInboundServer: mocks.stopInbound }));
vi.mock("./adapters/feishu", () => ({ FeishuAdapter: class { id = "feishu"; } }));
vi.mock("./adapters/wechat/ilink-bot-adapter", () => ({
  ILinkBotAdapter: class {
    id = "wechat";
    login = vi.fn(async () => ({ ilinkBotId: "bot-1" }));
    stop = vi.fn(async () => undefined);
    start = vi.fn(async () => undefined);
    constructor() { mocks.wx = this; }
  },
}));
vi.mock("./adapters/qq/napcat-adapter", () => ({
  NapCatAdapter: class {
    id = "qq";
    testConnection = vi.fn(async () => ({ ok: true }));
    constructor() { mocks.qq = this; }
  },
}));
vi.mock("./adapters/qq/onebot-reverse-ws", () => ({ resolveQqListenAuthRequirement: mocks.resolveQqAuth }));
vi.mock("./adapters/qqbot/qqbot-adapter", () => ({
  QqBotAdapter: class {
    id = "qqbot";
    testConnection = vi.fn(async () => ({ ok: true }));
    constructor() { mocks.qqbot = this; }
  },
}));
vi.mock("./message-log", () => ({ getRecentLog: mocks.getRecentLog, clearLog: mocks.clearLog, reloadLogFromDisk: mocks.reloadLog }));
vi.mock("../logging/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, LogTag: { Channels: "channels", InboundServer: "inbound" } }));
vi.mock("./sender-gate", () => ({ pendingSenders: mocks.pendingSenders }));
vi.mock("./sender-approval", () => ({
  resolvePendingSender: mocks.resolvePendingSender,
  withPendingSenders: mocks.withPendingSenders,
}));
vi.mock("./adapters/wechat/ilink-protocol-client", () => ({ fetchQrCode: mocks.fetchQrCode }));
vi.mock("./adapters/wechat/qr", () => ({ createQrDataUrl: mocks.createQrDataUrl }));

function fakeIpc(): IpcScope {
  return {
    handle: (channel, listener) => { mocks.ipcHandlers.set(channel, listener); },
    removeHandler: vi.fn(),
    on: vi.fn(),
    dispose: vi.fn(),
  } as IpcScope;
}

async function loadModule() {
  vi.resetModules();
  return import("./init");
}

async function setup(options: { initialize?: boolean } = {}) {
  const init = await loadModule();
  if (options.initialize !== false) {
    init.initializeChannels({ ipc: fakeIpc(), handleIncoming: async () => null, reloadDispatcherSettings: vi.fn() });
  }
  return init;
}

function handler(channel: string): (...args: any[]) => any {
  const value = mocks.ipcHandlers.get(channel);
  if (!value) throw new Error(`IPC handler missing: ${channel}`);
  return value;
}

function windowWithSend(send = vi.fn(), destroyed = false) {
  return { isDestroyed: () => destroyed, webContents: { send } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.ipcHandlers.clear();
  mocks.registered.length = 0;
  mocks.windows = [];
  mocks.focused = null;
  mocks.wx = mocks.qq = mocks.qqbot = null;
  mocks.loadSettings.mockReturnValue({
    inboundPort: 1,
    sharedSecret: "secret",
    qq: { accessToken: "qq-token", listenMode: "reverse" },
    qqbot: { appSecret: "qqbot-secret", appId: "app" },
    wechat: { enabled: true },
    feishu: { enabled: false },
  });
  mocks.manager.getAllStatus.mockReturnValue({ wechat: { enabled: true, phase: "running" } });
  mocks.withPendingSenders.mockImplementation((status: any) => ({ ...status, pending: [] }));
  mocks.startInbound.mockResolvedValue({ port: 4567 });
  mocks.stopInbound.mockResolvedValue(undefined);
  mocks.fetchQrCode.mockResolvedValue({ qrcode: "ticket-1", qrcode_img_content: "https://liteapp.test/q/1" });
  mocks.createQrDataUrl.mockResolvedValue("data:image/png;base64,AAA");
  mocks.resolvePendingSender.mockReturnValue({ ok: true });
  mocks.getRecentLog.mockReturnValue([]);
  mocks.bind.mockReturnValue({ ok: true });
  mocks.snapshot.mockReturnValue({ bindings: [] });
  mocks.unbind.mockReturnValue({ ok: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("initializeChannels", () => {
  it("registers adapters, IPC and the pending-sender listener exactly once", async () => {
    const init = await setup();
    init.initializeChannels({ ipc: fakeIpc(), handleIncoming: async () => null, reloadDispatcherSettings: vi.fn() });

    expect(mocks.reloadLog).toHaveBeenCalledTimes(1);
    expect(mocks.manager.setDispatcher).toHaveBeenCalledTimes(1);
    expect(mocks.registered.map((adapter) => adapter.id)).toEqual(["feishu", "wechat", "qq", "qqbot"]);
    expect(mocks.pendingSenders.onChange).toHaveBeenCalledTimes(1);
    expect(mocks.ipcHandlers.size).toBeGreaterThanOrEqual(10);
  });

  it("wraps incoming dispatch with conversation lifecycle hooks, including on failure", async () => {
    const init = await loadModule();
    const calls: string[] = [];
    init.setChannelsConversationLifecycle({
      onUserMessage: () => calls.push("user"),
      onConversationStarted: () => calls.push("started"),
      onConversationEnded: () => calls.push("ended"),
    });
    const handleIncoming = vi.fn(async () => {
      calls.push("incoming");
      return "reply";
    });
    init.initializeChannels({ ipc: fakeIpc(), handleIncoming: handleIncoming as unknown as DispatchFn, reloadDispatcherSettings: vi.fn() });

    const dispatch = mocks.manager.setDispatcher.mock.calls[0][0] as (message: unknown, ingress: unknown) => Promise<unknown>;
    await expect(dispatch({ channel: "qq" }, { capability: true })).resolves.toBe("reply");
    expect(calls).toEqual(["user", "started", "incoming", "ended"]);
    expect(handleIncoming).toHaveBeenCalledWith({ channel: "qq" }, { capability: true });

    calls.length = 0;
    handleIncoming.mockRejectedValueOnce(new Error("dispatch failed"));
    await expect(dispatch({}, {})).rejects.toThrow("dispatch failed");
    expect(calls).toEqual(["user", "started", "ended"]);
  });

  it("returns a public config with secrets masked but presence flags kept", async () => {
    await setup();
    const config = handler(IPC.CHANNELS_GET_CONFIG)();
    expect(config.qq).toMatchObject({ accessToken: undefined, hasAccessToken: true, listenMode: "reverse" });
    expect(config.qqbot).toMatchObject({ appSecret: undefined, hasAppSecret: true, appId: "app" });
    expect(config.sharedSecret).toBe("secret");
  });

  it("saves config patches, reloads the dispatcher and returns the masked view", async () => {
    const init = await loadModule();
    const reloadDispatcherSettings = vi.fn();
    init.initializeChannels({ ipc: fakeIpc(), handleIncoming: async () => null, reloadDispatcherSettings });
    const patch = { wechat: { enabled: false } };
    const result = handler(IPC.CHANNELS_SAVE_CONFIG)(null, patch);
    expect(mocks.saveSettings).toHaveBeenCalledWith(patch);
    expect(reloadDispatcherSettings).toHaveBeenCalledTimes(1);
    expect(result.qq.hasAccessToken).toBe(true);
  });

  it("resolves sender approval through the settings-backed registry and broadcasts", async () => {
    const send = vi.fn();
    mocks.windows = [windowWithSend(send)];
    await setup();
    mocks.resolvePendingSender.mockReturnValueOnce({ ok: false, error: "not pending" });
    expect(handler(IPC.CHANNELS_SENDER_RESOLVE)(null, { channel: "wechat", senderId: "u" })).toEqual({ ok: false, error: "not pending" });
    expect(mocks.resolvePendingSender).toHaveBeenCalledWith(
      { channel: "wechat", senderId: "u" },
      { registry: mocks.pendingSenders, load: mocks.loadSettings, save: mocks.saveSettings },
    );
    expect(send).toHaveBeenCalledWith(IPC.CHANNELS_STATUS_CHANGED, expect.anything());
  });

  it("forwards the QQ listen-auth precheck payload, defaulting to an empty object", async () => {
    await setup();
    const resolve = handler(IPC.CHANNELS_QQ_RESOLVE_AUTH_REQUIREMENT);
    mocks.resolveQqAuth.mockReturnValue(true);
    expect(resolve(null, undefined)).toBe(true);
    expect(mocks.resolveQqAuth).toHaveBeenLastCalledWith({});
    resolve(null, { listenMode: "custom", customHost: "0.0.0.0" });
    expect(mocks.resolveQqAuth).toHaveBeenLastCalledWith({ listenMode: "custom", customHost: "0.0.0.0" });
  });

  it("restarts adapters in stop-then-start order", async () => {
    await setup();
    const order: string[] = [];
    mocks.manager.stopAll.mockImplementationOnce(async () => { order.push("stop"); });
    mocks.manager.startAll.mockImplementationOnce(async () => { order.push("start"); });
    await expect(handler(IPC.CHANNELS_RESTART)()).resolves.toEqual({ ok: true });
    expect(order).toEqual(["stop", "start"]);
  });

  it("starts WeChat QR login, pushes the image and reports the background login result", async () => {
    const send = vi.fn();
    mocks.focused = windowWithSend(send);
    await setup();

    await expect(handler(IPC.CHANNELS_WECHAT_LOGIN_START)()).resolves.toEqual({ ok: true, hint: "请扫描二维码" });
    expect(mocks.createQrDataUrl).toHaveBeenCalledWith("https://liteapp.test/q/1", 256);
    expect(send).toHaveBeenCalledWith(IPC.CHANNELS_WECHAT_QRCODE, "data:image/png;base64,AAA");
    await vi.waitFor(() => expect(mocks.wx.start).toHaveBeenCalledTimes(1));
    expect(mocks.wx.login).toHaveBeenCalledWith("ticket-1");
    expect(mocks.wx.stop).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(IPC.CHANNELS_WECHAT_LOGIN_DONE, { ok: true, botId: "bot-1" });
  });

  it("reports QR generation failures and background login failures without throwing", async () => {
    const send = vi.fn();
    mocks.focused = null;
    mocks.windows = [windowWithSend(send)];
    await setup();

    mocks.fetchQrCode.mockRejectedValueOnce(new Error("network"));
    expect(await handler(IPC.CHANNELS_WECHAT_LOGIN_START)()).toEqual({ ok: false, error: "Error: network" });

    mocks.wx.login.mockRejectedValueOnce(new Error("scan expired"));
    await handler(IPC.CHANNELS_WECHAT_LOGIN_START)();
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(IPC.CHANNELS_WECHAT_LOGIN_DONE, { ok: false, error: "Error: scan expired" }));
    expect(mocks.wx.start).not.toHaveBeenCalled();
  });

  it("delegates QQ and QQ Bot test connections to their adapters", async () => {
    await setup();
    mocks.qq.testConnection.mockResolvedValueOnce({ ok: true, latencyMs: 12 });
    expect(await handler(IPC.CHANNELS_QQ_TEST_CONNECTION)()).toEqual({ ok: true, latencyMs: 12 });
    mocks.qqbot.testConnection.mockResolvedValueOnce({ ok: false, error: "offline" });
    expect(await handler(IPC.CHANNELS_QQBOT_TEST_CONNECTION)()).toEqual({ ok: false, error: "offline" });
  });

  it("normalizes the message-log limit and clears the log", async () => {
    await setup();
    handler(IPC.CHANNELS_LOG_GET)(null, 50);
    expect(mocks.getRecentLog).toHaveBeenLastCalledWith(50);
    for (const value of [0, -1, "20", null]) {
      handler(IPC.CHANNELS_LOG_GET)(null, value);
      expect(mocks.getRecentLog).toHaveBeenLastCalledWith(100);
    }
    expect(handler(IPC.CHANNELS_LOG_CLEAR)()).toEqual({ ok: true });
    expect(mocks.clearLog).toHaveBeenCalledTimes(1);
  });

  it("exposes context binding snapshot, bind and unbind handlers", async () => {
    await setup();
    expect(handler(IPC.CHANNELS_CONTEXT_BINDINGS_GET)()).toEqual({ bindings: [] });
    expect(mocks.snapshot).toHaveBeenCalledWith({ store: true }, [{ id: "session-1" }]);

    expect(handler(IPC.CHANNELS_CONTEXT_BIND)(null, { sessionId: "session-1" })).toEqual({ ok: true });
    const [, payload, validate] = mocks.bind.mock.calls[0];
    expect(payload).toEqual({ sessionId: "session-1" });
    expect(validate("session-1")).toBe(true);

    expect(handler(IPC.CHANNELS_CONTEXT_UNBIND)(null, "session-1")).toEqual({ ok: true });
    expect(mocks.unbind).toHaveBeenCalledWith({ store: true }, "session-1");
  });
});

describe("broadcasts", () => {
  it("broadcasts status only to live windows and survives one failing send", async () => {
    const init = await setup();
    const first = vi.fn();
    const second = vi.fn(() => { throw new Error("webContents gone"); });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.windows = [windowWithSend(first), windowWithSend(second), windowWithSend(vi.fn(), true)];
    init.broadcastChannelsStatus();
    expect(first).toHaveBeenCalledWith(IPC.CHANNELS_STATUS_CHANGED, expect.objectContaining({ pending: [] }));
    expect(second).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("[ChannelsInit]", "广播失败:", expect.any(Error));
    warn.mockRestore();
  });

  it("broadcasts install progress and skips destroyed or failing windows", async () => {
    const init = await setup();
    const send = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.windows = [windowWithSend(send), windowWithSend(vi.fn(() => { throw new Error("closed"); })), windowWithSend(vi.fn(), true)];
    const progress = { channel: "qq", phase: "download", pct: 42 };
    init.broadcastChannelsInstallProgress(progress);
    expect(send).toHaveBeenCalledWith(IPC.CHANNELS_INSTALL_PROGRESS, progress);
    expect(warn).toHaveBeenCalledWith("[ChannelsInit]", "广播安装进度失败:", expect.any(Error));
    warn.mockRestore();
  });
});

describe("startChannels / shutdownChannels", () => {
  it("rejects an already-aborted signal before any side effect", async () => {
    const init = await setup();
    const controller = new AbortController();
    const reason = new Error("aborted early");
    controller.abort(reason);
    await expect(init.startChannels(controller.signal)).rejects.toBe(reason);
    expect(mocks.startInbound).not.toHaveBeenCalled();
    expect(mocks.manager.startAll).not.toHaveBeenCalled();
  });

  it("starts the inbound server and all adapters once, then broadcasts status", async () => {
    const send = vi.fn();
    mocks.windows = [windowWithSend(send)];
    const init = await setup();
    await init.startChannels();
    expect(mocks.startInbound).toHaveBeenCalledTimes(1);
    expect(mocks.manager.startAll).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(IPC.CHANNELS_STATUS_CHANGED, expect.anything());

    await init.startChannels();
    expect(mocks.startInbound).toHaveBeenCalledTimes(1);
    expect(mocks.manager.startAll).toHaveBeenCalledTimes(1);
  });

  it("keeps starting adapters when the inbound server fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.startInbound.mockRejectedValueOnce(new Error("port busy"));
    const init = await setup();
    await init.startChannels();
    expect(error).toHaveBeenCalledWith("[ChannelsInit]", "入站 server 启动失败:", expect.any(Error));
    expect(mocks.manager.startAll).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  it("stops the inbound server and aborts if the signal fires while it starts", async () => {
    const init = await setup();
    const controller = new AbortController();
    const reason = new Error("shutdown during start");
    mocks.startInbound.mockImplementationOnce(async () => {
      controller.abort(reason);
      return { port: 1 };
    });
    await expect(init.startChannels(controller.signal)).rejects.toBe(reason);
    expect(mocks.stopInbound).toHaveBeenCalledTimes(1);
    expect(mocks.manager.startAll).not.toHaveBeenCalled();
  });

  it("stops adapters and the server and allows a later start to run again", async () => {
    const init = await setup();
    await init.startChannels();
    await init.shutdownChannels();
    expect(mocks.manager.stopAll).toHaveBeenCalledTimes(1);
    expect(mocks.stopInbound).toHaveBeenCalledTimes(1);

    await init.startChannels();
    expect(mocks.manager.startAll).toHaveBeenCalledTimes(2);
    expect(mocks.startInbound).toHaveBeenCalledTimes(2);
  });
});
