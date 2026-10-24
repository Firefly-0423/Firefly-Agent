import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC } from "../../shared/ipc-channels";

const m = vi.hoisted(() => {
  const state: any = {
    root: "C:/firefly-user-data",
    generalSettings: { plugins: { alpha: true } },
    modelSettings: { profile: "model" },
    overview: { plugins: [], issues: [] },
    panelDirs: {} as Record<string, string | null>,
    managementHost: null as any,
    panelHost: null as any,
    marketplaceHost: null as any,
    fromHost: true,
    guard: null as any,
    hostConfig: null as any,
    marketConfig: null as any,
    marketIpcArgs: null as any,
    panelProtocol: null as any,
    saveGeneralSettings: vi.fn(),
    generate: vi.fn(),
    createAgentRunner: vi.fn(),
    enqueue: vi.fn(),
    resolveProfile: vi.fn(() => "resolved-profile"),
    loadGeneralSettings: vi.fn(() => state.generalSettings),
    dialogOpen: vi.fn(async () => ({ canceled: false, filePaths: ["C:/downloads/plugin.zip"] })),
    dialogMessage: vi.fn(async () => ({ response: 1 })),
    hostServices: { kind: "host-services" },
    market: { kind: "market" },
    router: {
      register: vi.fn(),
      unregister: vi.fn(),
      invokeRegistered: vi.fn(() => "invoked"),
      dispatch: vi.fn(async () => ({ ok: true, data: "dispatched" })),
    },
  };
  state.PluginVersionStore = class {
    constructor(public root: string) {}
  };
  state.PluginManager = class {
    options: any;
    start = vi.fn(async () => {
      if (state.failStart) throw new Error("PLUGIN_START_FAILED");
    });
    overview = vi.fn(() => state.overview);
    onRunningStateChange = vi.fn();
    getSettingsPanelDir = vi.fn((id: string) => state.panelDirs[id] ?? null);
    installZip = vi.fn(async (zipPath: string, options: unknown) => ({ zipPath, options }));
    constructor(options: unknown) {
      this.options = options;
      state.manager = this;
    }
  };
  return state;
});

vi.mock("electron", () => ({
  app: { getPath: (name: string) => (name === "userData" ? m.root : path.join(m.root, name)) },
  dialog: { showOpenDialog: (...args: unknown[]) => m.dialogOpen(...args), showMessageBox: (...args: unknown[]) => m.dialogMessage(...args) },
  safeStorage: { kind: "safe-storage" },
}));
vi.mock("../channels/manager", () => ({
  channelManager: {
    has: vi.fn((id: string) => id === "known"),
    register: vi.fn(),
    unregister: vi.fn(),
    startOne: vi.fn(),
  },
}));
vi.mock("../chats/chats-store", () => ({ getSession: vi.fn(), listSessions: vi.fn(() => []) }));
vi.mock("../orchestrator/tools/registry/tool-registry", () => ({
  toolRegistry: { register: vi.fn(), unregister: vi.fn(), getById: vi.fn((id: string) => ({ id })) },
}));
vi.mock("../settings/settings-facade", () => ({
  loadGeneralSettings: () => m.loadGeneralSettings(),
  saveGeneralSettings: (...args: unknown[]) => m.saveGeneralSettings(...args),
}));
vi.mock("../settings/model-settings", () => ({
  loadModelSettings: () => m.modelSettings,
  resolveModelSettingsProfile: (...args: unknown[]) => m.resolveProfile(...args),
}));
vi.mock("./plugin-llm", () => ({ pluginGenerateText: (...args: unknown[]) => m.generate(...args) }));
vi.mock("./plugin-agent", () => ({ createPluginAgentRunner: (...args: unknown[]) => m.createAgentRunner(...args) }));
vi.mock("./host-services", () => ({
  createHostServiceFactory: vi.fn((config: unknown) => {
    m.hostConfig = config;
    return m.hostServices;
  }),
}));
vi.mock("../plugin-panel/plugin-panel-protocol", () => ({
  installPluginPanelProtocol: vi.fn((resolve: unknown) => {
    m.panelProtocol = resolve;
  }),
}));
vi.mock("../../plugins/ipc-router", () => ({ createPluginIpcRouter: () => m.router }));
vi.mock("../../plugins/manager", () => ({ PluginManager: m.PluginManager }));
vi.mock("../../plugins/version-store", () => ({ PluginVersionStore: m.PluginVersionStore }));
vi.mock("../../plugins/prompts", () => ({ pluginPromptRegistry: { build: vi.fn() } }));
vi.mock("./plugin-marketplace", () => ({
  MARKET_REGISTRY_URLS: ["https://registry.example/index.json"],
  MARKET_ZIP_URL_PREFIXES: ["https://cdn.example/"],
  createPluginMarketplaceService: vi.fn((config: unknown) => {
    m.marketConfig = config;
    return m.market;
  }),
}));
vi.mock("./plugin-marketplace-ipc", () => ({
  registerPluginMarketplaceIpc: vi.fn((args: unknown) => {
    m.marketIpcArgs = args;
  }),
}));
vi.mock("./plugin-management-ipc-guard", () => ({
  isFromHostDocument: vi.fn((...args: unknown[]) => {
    m.hostDocumentArgs = args;
    return m.fromHost;
  }),
  guardPluginIpcHandler: vi.fn((channel: string, hosts: unknown, invoke: (args: unknown[]) => unknown) => {
    m.guard = { channel, hosts, invoke };
    return (_event: unknown, ...args: unknown[]) => invoke(args);
  }),
}));
vi.mock("../services/llm/llm-queue", () => ({ enqueueLLMTask: m.enqueue }));

import { startPluginRuntime } from "./plugin-runtime";

const APP_DATA = "C:/firefly-user-data";

function fakeHost(name: string, destroyed = false) {
  return { name, destroyed, isDestroyed() { return this.destroyed; }, send: vi.fn() };
}

function makeIpc() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    handlers,
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler)),
    removeHandler: vi.fn(),
    on: vi.fn(),
    dispose: vi.fn(),
  };
}

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    llmClient: { name: "llm-client" },
    ipc: makeIpc(),
    agentRuntime: { buildOptions: vi.fn() },
    schedulerStore: { deleteTasksByOwner: vi.fn(() => 2) },
    getPanelHostWebContents: () => m.panelHost,
    getMarketplaceHostWebContents: () => m.marketplaceHost,
    ...overrides,
  } as any;
}

let deps: ReturnType<typeof makeDeps>;

beforeEach(() => {
  vi.clearAllMocks();
  m.root = APP_DATA;
  m.generalSettings = { plugins: { alpha: true } };
  m.modelSettings = { profile: "model" };
  m.overview = { plugins: [], issues: [] };
  m.panelDirs = {};
  m.managementHost = null;
  m.panelHost = null;
  m.marketplaceHost = null;
  m.fromHost = true;
  m.guard = null;
  m.hostConfig = null;
  m.marketConfig = null;
  m.marketIpcArgs = null;
  m.panelProtocol = null;
  m.hostDocumentArgs = null;
  m.dialogOpen.mockResolvedValue({ canceled: false, filePaths: ["C:/downloads/plugin.zip"] });
  m.dialogMessage.mockResolvedValue({ response: 1 });
  m.router.register.mockClear();
  m.router.unregister.mockClear();
  m.router.dispatch.mockResolvedValue({ ok: true, data: "dispatched" });
  m.failStart = false;
  deps = makeDeps();
});

describe("startPluginRuntime composition", () => {
  it("creates the manager with user roots, storage and the embedded router", async () => {
    const manager = await startPluginRuntime(deps);
    expect(manager).toBe(m.manager);
    expect(manager.start).toHaveBeenCalledTimes(1);
    expect(m.manager.options.versionStore.root).toBe(path.join(APP_DATA, "plugins"));
    expect(m.manager.options.scanRoots).toEqual([
      { path: expect.stringMatching(/[\\/]plugins$/), source: "builtin" },
      { path: path.join(APP_DATA, "plugins"), source: "user" },
    ]);
    expect(m.manager.options.storageRoot).toBe(path.join(APP_DATA, "plugin-data"));
    expect(m.manager.options.runtime.hostServices).toBe(m.hostServices);
    expect(m.marketIpcArgs.market).toBe(m.market);
  });

  it("loads and saves the enabled map through general settings", async () => {
    await startPluginRuntime(deps);
    expect(m.manager.options.loadEnabledMap()).toBe(m.generalSettings.plugins);
    m.manager.options.saveEnabledMap({ beta: false });
    expect(m.saveGeneralSettings).toHaveBeenCalledWith({ plugins: { beta: false } });
  });

  it("deletes a plugin's scheduled tasks through the scheduler store during cleanup", async () => {
    await startPluginRuntime(deps);
    await m.manager.options.cleanupPersistentResources("alpha");
    expect(deps.schedulerStore.deleteTasksByOwner).toHaveBeenCalledWith("alpha");
  });

  it("wires the running-state callback only when provided", async () => {
    const first = (await startPluginRuntime(deps)) as any;
    expect(first.onRunningStateChange).not.toHaveBeenCalled();
    const callback = vi.fn();
    const second = (await startPluginRuntime({ ...deps, onPluginRunningStateChange: callback })) as any;
    expect(second.onRunningStateChange).toHaveBeenCalledWith(callback);
  });
});

describe("state notification", () => {
  it("sends the overview to both live hosts", async () => {
    m.marketplaceHost = fakeHost("management");
    m.panelHost = fakeHost("panel");
    await startPluginRuntime(deps);
    m.manager.options.onListChanged();
    expect(m.manager.overview).toHaveBeenCalled();
    expect(m.marketplaceHost.send).toHaveBeenCalledWith(IPC.PLUGINS_CHANGED, m.overview);
    expect(m.panelHost.send).toHaveBeenCalledWith(IPC.PLUGINS_CHANGED, m.overview);
  });

  it("deduplicates one host used for both roles and skips destroyed or missing hosts", async () => {
    const shared = fakeHost("shared");
    m.marketplaceHost = shared;
    m.panelHost = shared;
    await startPluginRuntime(deps);
    m.manager.options.onListChanged();
    expect(shared.send).toHaveBeenCalledTimes(1);
    const destroyed = fakeHost("destroyed", true);
    m.marketplaceHost = destroyed;
    m.panelHost = null;
    m.manager.options.onListChanged();
    expect(shared.send).toHaveBeenCalledTimes(1);
    expect(destroyed.send).not.toHaveBeenCalled();
  });

  it("logs and continues when a host send throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const host = fakeHost("broken");
    host.send.mockImplementation(() => {
      throw new Error("renderer gone");
    });
    m.marketplaceHost = host;
    await startPluginRuntime(deps);
    expect(() => m.manager.options.onListChanged()).not.toThrow();
    expect(warn).toHaveBeenCalledWith("[plugins] state notification failed", expect.any(Error));
  });
});

describe("runtime host ports", () => {
  it("adapts the host tool registry", async () => {
    await startPluginRuntime(deps);
    const registry = m.manager.options.runtime.toolRegistry;
    registry.register({ id: "tool-a" });
    registry.unregister("tool-a");
    expect(registry.getById("tool-a")).toEqual({ id: "tool-a" });
    const { toolRegistry } = await import("../orchestrator/tools/registry/tool-registry");
    expect(toolRegistry.register).toHaveBeenCalledWith({ id: "tool-a" });
    expect(toolRegistry.unregister).toHaveBeenCalledWith("tool-a");
  });

  it("adapts the host channel manager", async () => {
    await startPluginRuntime(deps);
    const channels = m.manager.options.runtime.channelManager;
    expect(channels.has("known")).toBe(true);
    expect(channels.has("unknown")).toBe(false);
    const adapter = { id: "adapter" };
    channels.register(adapter);
    channels.unregister("slack");
    await channels.startOne("slack");
    const { channelManager } = await import("../channels/manager");
    expect(channelManager.register).toHaveBeenCalledWith(adapter);
    expect(channelManager.unregister).toHaveBeenCalledWith("slack");
    expect(channelManager.startOne).toHaveBeenCalledWith("slack");
  });

  it("registers and unregisters plugin channels on both the router and ipc scope", async () => {
    await startPluginRuntime(deps);
    const handler = vi.fn();
    m.manager.options.runtime.registerIpc("plugin:alpha:run", handler);
    expect(m.router.register).toHaveBeenCalledWith("plugin:alpha:run", handler);
    expect(deps.ipc.handle).toHaveBeenCalledWith("plugin:alpha:run", expect.any(Function));
    const guarded = deps.ipc.handlers.get("plugin:alpha:run")!;
    expect(guarded({ sender: "event" }, { input: 1 })).toBe("invoked");
    expect(m.router.invokeRegistered).toHaveBeenCalledWith("plugin:alpha:run", [{ input: 1 }]);
    expect(m.guard.hosts.getManagementHost()).toBeNull();
    expect(m.guard.hosts.getPanelHost()).toBeNull();

    m.manager.options.runtime.unregisterIpc("plugin:alpha:run");
    expect(m.router.unregister).toHaveBeenCalledWith("plugin:alpha:run");
    expect(deps.ipc.removeHandler).toHaveBeenCalledWith("plugin:alpha:run");
  });

  it("exposes the prompt registry directly", async () => {
    await startPluginRuntime(deps);
    const { pluginPromptRegistry } = await import("../../plugins/prompts");
    expect(m.manager.options.runtime.promptRegistry).toBe(pluginPromptRegistry);
  });
});

describe("host service factory", () => {
  it("injects the plugin data root, storage, readers and scheduler", async () => {
    await startPluginRuntime(deps);
    expect(m.hostConfig).toMatchObject({
      pluginDataRoot: path.join(APP_DATA, "plugin-data"),
      storage: { kind: "safe-storage" },
      schedulerStore: deps.schedulerStore,
    });
    const chatsStore = await import("../chats/chats-store");
    expect(m.hostConfig.chatsReader).toBe(chatsStore);
    expect(m.hostConfig.channelManager.has("known")).toBe(true);
  });

  it("resolves the model profile before generating text", async () => {
    await startPluginRuntime(deps);
    const messages = [{ role: "user", content: "hi" }];
    await m.hostConfig.llm.generateText(messages, { maxTokens: 5 });
    expect(m.resolveProfile).toHaveBeenCalledWith(m.modelSettings);
    expect(m.generate).toHaveBeenCalledWith(messages, "resolved-profile", deps.llmClient, m.enqueue, { maxTokens: 5 });
  });

  it("creates a plugin agent runner bound to the plugin signal and app data root", async () => {
    await startPluginRuntime(deps);
    const signal = new AbortController().signal;
    await m.hostConfig.createAgentRunner({ pluginId: "alpha", signal });
    expect(m.createAgentRunner).toHaveBeenCalledWith({
      pluginId: "alpha",
      pluginSignal: signal,
      userDataPath: APP_DATA,
      agentRuntime: deps.agentRuntime,
    });
  });
});

describe("ZIP import and marketplace", () => {
  it("returns the selected ZIP path", async () => {
    await startPluginRuntime(deps);
    await expect(m.manager.options.selectPluginZip()).resolves.toBe("C:/downloads/plugin.zip");
    expect(m.dialogOpen).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "导入流萤插件",
        properties: ["openFile"],
        filters: [{ name: "流萤插件包", extensions: ["zip"] }],
      }),
    );
  });

  it("returns undefined when ZIP selection is cancelled", async () => {
    m.dialogOpen.mockResolvedValue({ canceled: true, filePaths: [] });
    await startPluginRuntime(deps);
    await expect(m.manager.options.selectPluginZip()).resolves.toBeUndefined();
  });

  it("confirms replacement with the exact name, id and version", async () => {
    await startPluginRuntime(deps);
    await expect(
      m.manager.options.confirmPluginReplace({ id: "alpha", name: "Alpha", version: "1.2.3" }),
    ).resolves.toBe(true);
    const [options] = m.dialogMessage.mock.calls[0]!;
    expect(options).toMatchObject({
      type: "warning",
      title: "替换已有插件",
      message: "用户插件 Alpha（alpha）已经存在。",
      detail: "是否用 ZIP 中的 1.2.3 版本替换现有程序？插件私有数据将保留。",
      buttons: ["取消", "替换"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
  });

  it("explains a source change from the bundled directory or a local ZIP", async () => {
    await startPluginRuntime(deps);
    await m.manager.options.confirmPluginReplace({
      id: "alpha",
      name: "Alpha",
      version: "2.0.0",
      sourceChange: { from: { kind: "bundled" }, to: { sourceId: "official" } },
    });
    let detail = m.dialogMessage.mock.calls[0]![0].detail as string;
    expect(detail).toContain("来源将从随附离线目录更改为在线目录：official");
    expect(detail).toContain("本次确认同时授权该插件的来源变更。");

    await m.manager.options.confirmPluginReplace({
      id: "alpha",
      name: "Alpha",
      version: "2.0.0",
      sourceChange: { from: { kind: "local-zip" }, to: { sourceId: "official" } },
    });
    detail = m.dialogMessage.mock.calls[1]![0].detail as string;
    expect(detail).toContain("来源将从本地 ZIP更改为在线目录：official");
  });

  it("returns false when the replacement dialog is declined", async () => {
    m.dialogMessage.mockResolvedValue({ response: 0 });
    await startPluginRuntime(deps);
    await expect(m.manager.options.confirmPluginReplace({ id: "a", name: "A", version: "1" })).resolves.toBe(false);
  });

  it("creates the marketplace service and forwards installs to the manager", async () => {
    await startPluginRuntime(deps);
    expect(m.marketConfig.registryUrls).toEqual(["https://registry.example/index.json"]);
    expect(m.marketConfig.zipUrlPrefixes).toEqual(["https://cdn.example/"]);
    expect(m.marketConfig.cacheDir).toBe(path.join(APP_DATA, "plugin-market-cache"));
    expect(m.marketConfig.bundledDir).toMatch(/plugin-marketplace$/);
    await expect(m.marketConfig.installZip("C:/p.zip", { mode: "replace" })).resolves.toEqual({
      zipPath: "C:/p.zip",
      options: { mode: "replace" },
    });
    expect(m.manager.installZip).toHaveBeenCalledWith("C:/p.zip", { mode: "replace" });
  });

  it("registers marketplace IPC with a live ownership getter", async () => {
    m.marketplaceHost = fakeHost("marketplace");
    await startPluginRuntime(deps);
    expect(m.marketIpcArgs.ipc).toBe(deps.ipc);
    expect(m.marketIpcArgs.getHostWebContents()).toBe(m.marketplaceHost);
    m.marketplaceHost = null;
    expect(m.marketIpcArgs.getHostWebContents()).toBeNull();
  });
});

describe("settings panel bridge and protocol", () => {
  it("rejects malformed panel invocations before checking ownership", async () => {
    await startPluginRuntime(deps);
    const invoke = deps.ipc.handlers.get(IPC.PLUGINS_PANEL_INVOKE)!;
    expect(invoke({}, 1, "run", [])).toEqual({ ok: false, error: "面板调用参数格式非法" });
    expect(invoke({}, "alpha", 2, [])).toEqual({ ok: false, error: "面板调用参数格式非法" });
    expect(invoke({}, "alpha", "run", {})).toEqual({ ok: false, error: "面板调用参数格式非法" });
  });

  it("rejects an untrusted panel document", async () => {
    m.panelHost = fakeHost("panel");
    m.fromHost = false;
    await startPluginRuntime(deps);
    const invoke = deps.ipc.handlers.get(IPC.PLUGINS_PANEL_INVOKE)!;
    const event = { sender: "panel" };
    expect(invoke(event, "alpha", "run", [])).toEqual({
      ok: false,
      error: "面板调用来源窗口不受信任",
    });
    expect(m.hostDocumentArgs).toEqual([event, m.panelHost, "settings"]);
  });

  it("rejects a plugin whose settings panel is not running", async () => {
    await startPluginRuntime(deps);
    m.panelDirs.alpha = null;
    const invoke = deps.ipc.handlers.get(IPC.PLUGINS_PANEL_INVOKE)!;
    expect(invoke({}, "alpha", "run", [])).toEqual({ ok: false, error: "插件面板未运行" });
    expect(m.router.dispatch).not.toHaveBeenCalled();
  });

  it("dispatches an authorized panel call through the shared router", async () => {
    await startPluginRuntime(deps);
    m.panelDirs.alpha = "C:/plugins/alpha/panel";
    const invoke = deps.ipc.handlers.get(IPC.PLUGINS_PANEL_INVOKE)!;
    await expect(invoke({}, "alpha", "run", [1])).resolves.toEqual({ ok: true, data: "dispatched" });
    expect(m.router.dispatch).toHaveBeenCalledWith({ pluginId: "alpha", channel: "run", args: [1], caller: "panel" });
  });

  it("installs the panel protocol backed by live panel directories", async () => {
    await startPluginRuntime(deps);
    m.panelDirs.alpha = "C:/plugins/alpha/panel";
    expect(m.panelProtocol("alpha")).toBe("C:/plugins/alpha/panel");
    expect(m.panelProtocol("beta")).toBeNull();
  });
});

describe("startup failure", () => {
  it("propagates a manager start failure", async () => {
    m.failStart = true;
    await expect(startPluginRuntime(deps)).rejects.toThrow("PLUGIN_START_FAILED");
  });
});
