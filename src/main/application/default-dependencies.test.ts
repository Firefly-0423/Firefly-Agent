import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => {
  const state: any = {
    storage: {
      profile: { kind: "test", isolationRoot: "C:/isolation" },
      dataRoot: "C:/data",
      files: { contentManifest: "C:/data/content-manifest.json", mcp: "C:/data/mcp.json" },
    },
    generalSettings: {
      language: "zh-CN",
      asrLanguage: "zh-CN",
      uiIcon: "default",
      screenshotHotkey: "Alt+Shift+S",
      musicEnabled: false,
      toastSoundEnabled: true,
      plugins: {},
    },
    modelSettings: {},
    chatWindow: null as any,
    settingsWindow: null as any,
    iconPathFn: null as any,
    modelChangedCb: null as any,
    resources: new Map<string, any>(),
    lockResult: true,
    onlineEntry: undefined as any,
    defaultMemory: null as any,
    controlledMemory: null as any,
    admissionMode: undefined as any,
    vectorReady: false,
  };
  state.app = {
    isPackaged: false,
    on: vi.fn(),
    once: vi.fn(),
    quit: vi.fn(),
    getPath: vi.fn((name: string) => `C:/app/${name}`),
    getAppPath: vi.fn(() => "C:/app"),
    getVersion: vi.fn(() => "1.2.3"),
    commandLine: { hasSwitch: vi.fn(() => false) },
  };
  state.dialog = { showMessageBox: vi.fn(), showSaveDialog: vi.fn(), showOpenDialog: vi.fn() };
  state.screen = { getDisplayMatching: vi.fn(), getCursorScreenPoint: vi.fn() };
  state.shell = { openPath: vi.fn(), showItemInFolder: vi.fn() };
  state.autoUpdater = {};
  state.readiness = { phase: "readiness" };
  state.activation = { phase: "activation" };
  state.shutdown = {
    register: vi.fn((resource: any) => state.resources.set(resource.id, resource)),
    registerEmergencyFlush: vi.fn(),
    requestControlledShutdown: vi.fn(),
  };
  state.ipcScope = { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn(), dispose: vi.fn() };
  state.lifecyclePublisher = { publishToolFinished: vi.fn(async () => {}) };
  state.pendingLifecycle = { disposeAll: vi.fn() };
  state.transcriptStore = { kind: "transcript-store" };
  state.windowManager = { kind: "window-manager" };
  state.tray = { kind: "tray" };
  state.llmClient = { kind: "llm" };
  state.embedding = { getStickerEmbeddingIndex: vi.fn(), scheduleStartupRefreshes: vi.fn() };
  state.social = { scheduler: { kind: "scheduler" }, store: { kind: "social-store" } };
  state.proactive = {
    initializeProactiveChatService: vi.fn(),
    initializeProactiveTrigger: vi.fn(),
    close: vi.fn(),
    proactiveConversationLifecycle: { kind: "proactive-lifecycle" },
  };
  state.agentRuntime = { kind: "agent-runtime", buildOptions: vi.fn(), onRunFinished: vi.fn() };
  state.pluginManager = { kind: "plugin-manager", publishHostEvent: vi.fn(), isRunning: vi.fn() };
  state.scheduler = { store: {}, engine: { refreshPluginTasks: vi.fn() } };
  state.channels = { kind: "channels" };
  state.browserService = { kind: "browser-service" };
  state.desktopAsr = { dispose: vi.fn(), cancelAll: vi.fn() };
  state.externalSkillsIpc = { dispose: vi.fn(), refreshHost: vi.fn() };
  state.workspaceFiles = { confirmBeforeShutdown: vi.fn(async () => true) };
  state.screenshot = { prewarm: vi.fn() };
  state.update = { install: vi.fn() };
  state.settingsDispose = vi.fn();
  state.shellResult = { windowManager: state.windowManager, ipc: state.ipcScope, tray: state.tray };
  state.coreResult = { services: { screenshot: state.screenshot, proactive: state.proactive, embedding: state.embedding, update: state.update }, channels: state.channels, scheduler: state.scheduler, shell: state.shellResult };
  state.backgroundResult = { kind: "background" };
  state.prepareDeps = null as any;
  state.shellDeps = null as any;
  state.coreDeps = null as any;
  state.backgroundDeps = null as any;
  state.publisherOpts = null as any;
  state.pendingOpts = null as any;
  return state;
});

vi.mock("electron", () => ({
  app: m.app,
  BrowserWindow: { getAllWindows: () => [] },
  dialog: m.dialog,
  screen: m.screen,
  shell: m.shell,
}));
vi.mock("electron-updater", () => ({ autoUpdater: m.autoUpdater }));

// --- storage / memory ---
vi.mock("../storage/storage-context", () => ({ getStorageContext: () => m.storage }));
vi.mock("../memory-context/main-default-memory", () => ({
  createMainDefaultMemory: vi.fn((options: unknown) => {
    m.defaultMemoryOptions = options;
    return m.defaultMemory;
  }),
}));
vi.mock("../memory-context/main-desktop-memory", () => ({
  createMainDesktopMemory: vi.fn((options: unknown) => {
    m.controlledMemoryOptions = options;
    return m.controlledMemory;
  }),
}));
vi.mock("../memory-context/desktop-memory-backend", () => ({
  openDesktopMemoryBackend: vi.fn((options: unknown) => ({ options })),
  desktopMemoryAdmissionMode: vi.fn(() => m.admissionMode),
}));
vi.mock("../orchestrator/conversation-transcript-store", () => ({ getConversationTranscriptStore: vi.fn(() => m.transcriptStore) }));
vi.mock("../orchestrator/harness/run-store", () => ({ getHarnessRunStore: vi.fn(() => ({ get: vi.fn() })) }));
vi.mock("../memory/memory-store", () => ({
  memoryStore: { getAllL2: vi.fn(() => []), markL2SyncStatus: vi.fn() },
}));
vi.mock("../memory/memory-rag-reconciliation", () => ({
  backupMemoryRagFiles: vi.fn(),
  reconcileMemoryRag: vi.fn(async () => ({ reconciled: 0 })),
}));
vi.mock("../memory/memory-user-ipc", () => ({ registerMemoryUserToolIpc: vi.fn() }));
vi.mock("../memory-policy/memory-settings-ipc", () => ({ registerMemorySettingsIpc: vi.fn() }));
vi.mock("../memory-policy/memory-automation-settings-ipc", () => ({ registerMemoryAutomationSettingsIpc: vi.fn() }));
vi.mock("../memory-shadow/shadow-settings-ipc", () => ({ registerShadowSettingsIpc: vi.fn() }));

// --- app shell / windows / settings ---
vi.mock("../windows/window-state", () => ({
  get reactChatWindow() {
    return m.chatWindow;
  },
  get sidebarWindow() {
    return null;
  },
  get settingsWindow() {
    return m.settingsWindow;
  },
  getCurrentAppIconPath: vi.fn(() => ""),
  markStartupPhaseReady: vi.fn(),
  setGetCurrentAppIconPath: vi.fn((fn: unknown) => {
    m.iconPathFn = fn;
  }),
}));
vi.mock("../windows/app-icon", () => ({ getAppIconPath: vi.fn(() => "app-icon") }));
vi.mock("../startup/env", () => ({ isDev: false }));
vi.mock("../logging/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  LogTag: { Runtime: "runtime", RAG: "rag", Skills: "skills", Reranker: "reranker" },
}));
vi.mock("../../shared/banner", () => ({ renderBanner: () => "BANNER" }));
vi.mock("../../shared/ipc-channels", () => ({
  IPC: new Proxy({}, { get: (_target, key) => String(key) }),
}));
vi.mock("../../shared/sidebar-layout", () => ({ SIDEBAR_LAYOUT_IPC: { changed: "sidebar:changed" } }));
vi.mock("../../shared/manual-browser", () => ({
  MANUAL_BROWSER_WORKSPACE_IPC: { toolsChanged: "manual:tools", changed: "manual:changed" },
}));
vi.mock("../settings/settings-facade", () => ({
  loadGeneralSettings: vi.fn(() => m.generalSettings),
  saveGeneralSettings: vi.fn(),
  onGeneralSettingsChanged: vi.fn(),
}));
vi.mock("../settings/model-settings", () => ({
  getDefaultModelProfile: vi.fn(() => undefined),
  getCachedSavedModelProfile: vi.fn(),
  listCachedSavedModelProfileIds: vi.fn(() => []),
  loadModelSettings: vi.fn(() => m.modelSettings),
  saveModelSettings: vi.fn(),
  onModelConnectionChanged: vi.fn((callback: unknown) => {
    m.modelChangedCb = callback;
    return m.settingsDispose;
  }),
}));
vi.mock("../settings/settings-ipc", () => ({ registerSettingsIpc: vi.fn(() => m.settingsDispose) }));
vi.mock("../settings/general-settings-lifecycle", () => ({
  applyGeneralSettings: vi.fn(),
  handleGeneralSettingsChanged: vi.fn(),
  syncVolcanoSearchMcp: vi.fn(),
}));
vi.mock("../storage/settings-store", () => ({ loadUserProfile: vi.fn(() => ({})) }));
vi.mock("../startup/locale-context", () => ({ updateLocaleContext: vi.fn() }));
vi.mock("../startup/single-instance", () => ({ installSingleInstanceGuard: vi.fn(() => m.lockResult) }));
vi.mock("../windows/tray", () => ({ createTray: vi.fn(() => m.tray) }));
vi.mock("../windows/window-manager", () => ({ createWindowManager: vi.fn(() => m.windowManager) }));
vi.mock("../windows/window-system-ipc", () => ({ registerWindowSystemIpc: vi.fn() }));
vi.mock("../windows/create-toast-window", () => ({ createToastWindowShell: vi.fn() }));
vi.mock("../toast/toast-window", () => ({
  createToastWindowController: vi.fn(() => ({ preload: vi.fn(), dispose: vi.fn() })),
}));
vi.mock("../toast/toast-service", () => ({
  createToastService: vi.fn(() => ({ registerIpc: vi.fn(), dispose: vi.fn() })),
}));
vi.mock("../toast/toast-events", () => ({ toastEvents: {} }));
vi.mock("../startup/create-splash-window", () => ({ createSplashWindow: vi.fn(() => ({})) }));
vi.mock("../startup/startup-window-reveal", () => ({ revealStartupWindows: vi.fn() }));
vi.mock("../startup/bootstrap-config", () => ({ bootstrapConfigGetters: vi.fn() }));

// --- startup phases ---
vi.mock("./pre-ready", () => ({
  prepareBeforeReady: vi.fn(async (deps: unknown) => {
    m.prepareDeps = deps;
    return "prepared";
  }),
}));
vi.mock("./shell-bootstrap", () => ({
  startShell: vi.fn(async (deps: unknown) => {
    m.shellDeps = deps;
    return m.shellResult;
  }),
}));
vi.mock("./core-bootstrap", () => ({
  startCore: vi.fn(async (deps: unknown) => {
    m.coreDeps = deps;
    return m.coreResult;
  }),
}));
vi.mock("./background", () => ({
  startBackground: vi.fn(async (deps: unknown) => {
    m.backgroundDeps = deps;
    return m.backgroundResult;
  }),
}));
vi.mock("./ipc-scope", () => ({ createIpcScope: vi.fn(() => m.ipcScope) }));
vi.mock("./readiness", () => ({ createStartupReadiness: vi.fn(() => m.readiness) }));
vi.mock("./window-activation", () => ({ createWindowActivationBroker: vi.fn(() => m.activation) }));
vi.mock("./shutdown", () => ({
  createShutdownCoordinator: vi.fn((options: unknown) => {
    m.shutdownOptions = options;
    return m.shutdown;
  }),
}));
vi.mock("./electron-lifecycle", () => ({ installUpdateShutdownFallback: vi.fn() }));

// --- skills / plugins / schedulers ---
vi.mock("../skills", () => ({
  initSkills: vi.fn(async () => {}),
  rescanSkills: vi.fn(),
  skillRegistry: {},
}));
vi.mock("../skills/external-service", () => ({ createExternalSkillService: vi.fn(() => ({})) }));
vi.mock("../skills/external-ipc", () => ({
  registerExternalSkillsIpc: vi.fn(() => m.externalSkillsIpc),
}));
vi.mock("../skills/external-install", () => ({ recoverExternalSkills: vi.fn() }));
vi.mock("../skills/external-state", () => ({ ExternalSkillStateStore: class {} }));
vi.mock("../skills/external-reviews", () => ({ EXTERNAL_SKILL_REVIEWS: [] }));
vi.mock("../plugin-host/active-chat-target", () => ({ activeChatTargetRegistry: {} }));
vi.mock("../plugin-host/lifecycle-publisher", () => ({
  createLifecyclePublisher: vi.fn((options: unknown) => {
    m.publisherOpts = options;
    return m.lifecyclePublisher;
  }),
}));
vi.mock("../plugin-host/pending-turn-lifecycle", () => ({
  createPendingTurnLifecycle: vi.fn((options: unknown) => {
    m.pendingOpts = options;
    return m.pendingLifecycle;
  }),
}));
vi.mock("../plugin-host/plugin-runtime", () => ({ startPluginRuntime: vi.fn(async () => m.pluginManager) }));
vi.mock("../scheduler/bootstrap", () => ({ createSchedulerSubsystem: vi.fn(() => m.scheduler) }));
vi.mock("../channels/bootstrap", () => ({ createChannelsSubsystem: vi.fn(() => m.channels) }));
vi.mock("../orchestrator/agent-runtime", () => ({
  createAgentRuntime: vi.fn((options: unknown) => {
    m.agentRuntimeOptions = options;
    return m.agentRuntime;
  }),
}));
vi.mock("../proactive/proactive-lifecycle", () => ({
  createProactiveLifecycle: vi.fn(() => m.proactive),
}));
vi.mock("../services/social-context/social-context-service", () => ({ createSocialContextService: vi.fn(() => m.social) }));

// --- tools / rag / llm ---
vi.mock("../rag/document-index-queue", () => ({ configureDocumentIndexQueue: vi.fn() }));
vi.mock("../rag/document-index-worker", () => ({ runDocumentIndexJob: vi.fn() }));
vi.mock("../services/llm/llm-client", () => ({ createLlmClient: vi.fn(() => m.llmClient) }));
vi.mock("../services/embedding/embedding-index-service", () => ({ createEmbeddingIndexService: vi.fn(() => m.embedding) }));
vi.mock("../rag", () => ({
  addL2MemoryVector: vi.fn(),
  deleteUserMemoryVectors: vi.fn(),
  flushRAGStore: vi.fn(),
  flushRAGStoreSync: vi.fn(),
  getEntriesBySource: vi.fn(() => []),
  initRAG: vi.fn(),
  isUserMemoryVectorStoreReady: vi.fn(() => m.vectorReady),
}));
vi.mock("../rag/embedding", () => ({ getEmbeddingProvider: vi.fn() }));
vi.mock("../orchestrator/tools/registry/tool-registry", () => ({
  toolRegistry: { register: vi.fn(), unregister: vi.fn(), getById: vi.fn(), getAll: vi.fn(() => []) },
}));
vi.mock("../orchestrator/tools/registry/tool-registration", () => ({ registerAllTools: vi.fn() }));
vi.mock("../../plugins/prompts", () => ({ pluginPromptRegistry: { build: vi.fn() } }));
vi.mock("../orchestrator/live2d-work-signal", () => ({ setLive2dWorkSignalSender: vi.fn() }));
vi.mock("../lsp/manager", () => ({ LspManager: class {} }));
vi.mock("../orchestrator/sandbox/sandbox-exec", () => ({ initSandbox: vi.fn() }));
vi.mock("../orchestrator/plan-mode", () => ({
  enterPlanDiscussing: vi.fn(),
  exitPlanMode: vi.fn(),
  getPlanState: vi.fn(() => "NORMAL"),
  initPlanPaths: vi.fn(),
  initPlanStateBroadcaster: vi.fn(),
}));
vi.mock("../orchestrator/mcp-manager", () => ({
  initMcpManager: vi.fn(async () => {}),
  pruneMcpServersByIds: vi.fn(async () => ["removed-a"]),
}));
vi.mock("../orchestrator/sync-mcp-builtin", () => ({ syncPlaywrightMcp: vi.fn(async () => {}), REMOVED_BUILTIN_MCP_IDS: ["removed-a"] }));
vi.mock("../services/llm/llm-queue", () => ({ enqueueLLMTask: vi.fn() }));
vi.mock("../orchestrator/pop-quiz", () => ({ registerPopQuizIpc: vi.fn(), registerPopQuizTool: vi.fn() }));
vi.mock("../permission/bootstrap", () => ({ bootstrapPermission: vi.fn() }));

// --- I/O services / updates / protocols ---
vi.mock("../startup/gpu-sandbox-acl", () => ({ ensureGpuSandboxAcl: vi.fn() }));
vi.mock("../storage/external-content-paths", () => ({
  getExternalContentPaths: () => ({ installRoot: "", builtinSkillDirectory: "", userSkillDirectories: [], promptDirectories: [] }),
}));
vi.mock("../storage/external-content-migration", () => ({ migrateStagedExternalContent: vi.fn() }));
vi.mock("../updater/app-update-ipc", () => ({ registerAppUpdateIpc: vi.fn() }));
vi.mock("../updater/github-app-updater", () => ({
  createGitHubAppUpdateService: vi.fn(() => m.update),
  scheduleStartupUpdateCheck: vi.fn(() => vi.fn()),
}));
vi.mock("../protocols/bootstrap", () => ({ registerPrivilegedSchemes: vi.fn(), registerProtocolHandlers: vi.fn() }));
vi.mock("../memory-online-once/runner", () => ({ ADMISSION_ROOT: "E:/admission" }));
vi.mock("../memory-online-once/main-entry", () => ({ createMainProbeEntry: vi.fn(() => m.onlineEntry) }));
vi.mock("../music/bootstrap", () => ({ bootstrapMusicService: vi.fn(() => ({})) }));
vi.mock("../screenshot/screenshot-lifecycle", () => ({ initializeScreenshotService: vi.fn(() => m.screenshot) }));
vi.mock("../code-git/git-service", () => ({ createGitService: vi.fn(() => ({})) }));
vi.mock("../code-git/git-executable", () => ({ resolveGitExecutable: vi.fn(async () => ({})) }));
vi.mock("../code-git/code-git-ipc", () => ({ registerCodeGitIpc: vi.fn() }));

// --- chats / browser / asr ---
vi.mock("../chats/sidebar-layout-store", () => ({ createSidebarLayoutStore: vi.fn(() => ({})) }));
vi.mock("../chats/sidebar-layout-ipc", () => ({ registerSidebarLayoutIpc: vi.fn() }));
vi.mock("../chats/chats-ipc", () => ({ registerChatsIpc: vi.fn() }));
vi.mock("../chats/chats-store", () => ({ getSession: vi.fn(), listSessions: vi.fn(() => []) }));
vi.mock("../chats/workspace-files-ipc", () => ({ registerWorkspaceFilesIpc: vi.fn(() => m.workspaceFiles) }));
vi.mock("../chats/open-in-app", () => ({ registerOpenInAppIpc: vi.fn() }));
vi.mock("../chats/chat-ui-ipc", () => ({ registerChatUiIpc: vi.fn(), getActiveChatSessionId: vi.fn() }));
vi.mock("../browser/browser-workspace-executor", () => ({ createBrowserWorkspaceExecutor: vi.fn() }));
vi.mock("../browser/electron-browser-service", () => ({ createElectronBrowserService: vi.fn(() => ({})) }));
vi.mock("../browser/manual-browser-workspace", () => ({ createManualBrowserWorkspace: vi.fn(() => ({})) }));
vi.mock("../browser/browser-downloads", () => ({
  createBrowserDownloads: vi.fn(() => ({ dispose: vi.fn(), handle: vi.fn() })),
}));
vi.mock("../browser/browser-tools-hub", () => ({ createBrowserToolsHub: vi.fn(() => ({})) }));
vi.mock("../browser/browser-tools-settings", () => ({ createBrowserToolSettingsStore: vi.fn(() => ({ get: vi.fn() })) }));
vi.mock("../browser/browser-startup-config", () => ({ createStartupBrowserService: vi.fn(() => m.browserService) }));
vi.mock("../browser/browser-host-owner", () => ({
  registerBrowserHostOwner: vi.fn(() => ({ dispose: vi.fn(), refresh: vi.fn(), getCurrentOwner: vi.fn() })),
  registerManualBrowserHostOwner: vi.fn(() => ({ dispose: vi.fn() })),
}));
vi.mock("../browser/browser-service-ipc", () => ({
  registerBrowserServiceIpc: vi.fn(),
  registerManualBrowserWorkspaceIpc: vi.fn(),
  installBrowserServiceLifecycle: vi.fn(() => vi.fn()),
}));
vi.mock("../asr/desktop-asr-ipc", () => ({ registerDesktopAsrIpc: vi.fn(() => m.desktopAsr) }));
vi.mock("../chat/agui-bridge", () => ({
  hasActiveConversationRun: vi.fn(() => false),
  isActiveConversationRun: vi.fn(() => false),
  registerAgUiIpc: vi.fn(),
}));

import { createDefaultApplicationDependencies } from "./default-dependencies";

function createDeps() {
  return createDefaultApplicationDependencies();
}

function device() {
  return { isDestroyed: () => false, webContents: { send: vi.fn(), isDestroyed: () => false } };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.storage.profile = { kind: "test", isolationRoot: "C:/isolation" };
  m.generalSettings = {
    language: "zh-CN",
    asrLanguage: "zh-CN",
    uiIcon: "default",
    screenshotHotkey: "Alt+Shift+S",
    musicEnabled: false,
    toastSoundEnabled: true,
    plugins: {},
  };
  m.modelSettings = {};
  m.chatWindow = device();
  m.settingsWindow = device();
  m.lockResult = true;
  m.onlineEntry = undefined;
  m.admissionMode = undefined;
  m.vectorReady = false;
  m.resources.clear();
  m.prepareDeps = null;
  m.shellDeps = null;
  m.coreDeps = null;
  m.backgroundDeps = null;
  m.publisherOpts = null;
  m.pendingOpts = null;
  m.defaultMemoryOptions = undefined;
  m.controlledMemoryOptions = undefined;
  m.agentRuntimeOptions = undefined;
  m.app.commandLine.hasSwitch.mockImplementation(() => false);
  m.defaultMemory = {
    refreshModels: vi.fn(),
    quiesce: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    getShadowService: vi.fn(async () => null),
    backgroundHost: {},
    settingsHost: {},
    automationHost: {},
    channelHost: {},
  };
  m.controlledMemory = {
    refreshModels: vi.fn(),
    quiesce: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    sContext: {},
  };
  m.settingsWindow.webContents = { send: vi.fn(), isDestroyed: () => false };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("composition root", () => {
  it("returns the Electron handles and shared coordination objects", () => {
    const deps = createDeps();
    expect(deps.app).toBe(m.app);
    expect(deps.dialog).toBe(m.dialog);
    expect(deps.readiness).toBe(m.readiness);
    expect(deps.activation).toBe(m.activation);
    expect(deps.shutdown).toBe(m.shutdown);
    expect(typeof deps.prepare).toBe("function");
    expect(typeof deps.startShell).toBe("function");
    expect(typeof deps.startCore).toBe("function");
    expect(typeof deps.startBackground).toBe("function");
    expect(typeof deps.logFatal).toBe("function");
    expect(m.app.once).toHaveBeenCalledWith("will-quit", expect.any(Function));
    expect(m.app.on).toHaveBeenCalledWith("will-quit", expect.any(Function));
  });

  it("composes the default memory backend and registers its shutdown resources", () => {
    const deps = createDeps();
    expect(m.defaultMemoryOptions.getChatWindow()).toBe(m.chatWindow);
    expect(m.defaultMemoryOptions.getSettingsWindow()).toBe(m.settingsWindow);
    expect(m.defaultMemoryOptions.settings).toBeDefined();
    expect(m.controlledMemoryOptions).toBeUndefined();
    expect(m.resources.get("memory-model-refresh")).toBeDefined();
    expect(m.resources.get("desktop-memory-admission")).toMatchObject({ phase: "quiesce" });
    expect(m.resources.get("desktop-memory-resources")).toMatchObject({ phase: "stopLocalResources" });
    expect(m.modelChangedCb).toEqual(expect.any(Function));
    m.modelChangedCb();
    expect(m.defaultMemory.refreshModels).toHaveBeenCalledTimes(1);
    expect(deps).toBeDefined();
  });

  it("uses the controlled memory backend when the explicit switch is present", () => {
    m.app.commandLine.hasSwitch.mockImplementation((name: string) => name === "firefly-memory-controlled");
    m.admissionMode = "bounded";
    createDeps();
    expect(m.defaultMemoryOptions).toBeUndefined();
    expect(m.controlledMemoryOptions).toMatchObject({ enabled: true, getChatWindow: expect.any(Function) });
    expect(m.controlledMemoryOptions.openBackend()).toMatchObject({ options: expect.objectContaining({ admissionMode: "bounded" }) });
    expect(m.resources.get("desktop-memory-admission")).toBeDefined();
  });

  it("applies the lazy tray icon getter from general settings", () => {
    createDeps();
    expect(m.iconPathFn()).toBe("app-icon");
  });

  it("logs fatal startup failures through both console and the logger", async () => {
    const { logger } = await import("../logging/logger");
    const error = new Error("fatal");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    createDeps().logFatal(error);
    expect(consoleError).toHaveBeenCalledWith("[Firefly] fatal startup error:", error);
    expect(logger.error).toHaveBeenCalledWith("runtime", "fatal startup error:", error);
  });
});

describe("prepare phase", () => {
  it("wires document indexing, privileged schemes, GPU ACL and activation", async () => {
    const deps = createDeps();
    await expect(deps.prepare()).resolves.toBe("prepared");
    const { configureDocumentIndexQueue } = await import("../rag/document-index-queue");
    const { runDocumentIndexJob } = await import("../rag/document-index-worker");
    const { registerPrivilegedSchemes } = await import("../protocols/bootstrap");
    const { ensureGpuSandboxAcl } = await import("../startup/gpu-sandbox-acl");
    m.prepareDeps.configureDocumentIndex();
    expect(configureDocumentIndexQueue).toHaveBeenCalledWith(runDocumentIndexJob);
    expect(m.prepareDeps.registerPrivilegedSchemes).toBe(registerPrivilegedSchemes);
    expect(m.prepareDeps.activation).toBe(m.activation);
    m.prepareDeps.ensureGpuSandboxAcl();
    expect(ensureGpuSandboxAcl).toHaveBeenCalledWith({
      isPackaged: false,
      exeDir: path.dirname("C:/app/exe"),
      userDataDir: "C:/app/userData",
    });
  });

  it("installs the single-instance guard and exposes its acquisition result", async () => {
    const { installSingleInstanceGuard } = await import("../startup/single-instance");
    const deps = createDeps();
    await deps.prepare();
    const callback = vi.fn();
    expect(m.prepareDeps.installSingleInstance(callback)).toBe(true);
    expect(installSingleInstanceGuard).toHaveBeenCalledWith(m.app, callback);
    m.lockResult = false;
    expect(m.prepareDeps.installSingleInstance(callback)).toBe(false);
  });
});

describe("shell phase", () => {
  it("delegates shell creation with the shared coordinators", async () => {
    const deps = createDeps();
    await expect(deps.startShell()).resolves.toBe(m.shellResult);
    expect(m.shellDeps.readiness).toBe(m.readiness);
    expect(m.shellDeps.activation).toBe(m.activation);
    expect(m.shellDeps.shutdown).toBe(m.shutdown);
    expect(m.shellDeps.createIpcScope()).toBe(m.ipcScope);
    expect(m.shellDeps.flushTokenUsage).toBeDefined();
  });

  it("writes the banner and start log without ANSI decoration", async () => {
    const { logger } = await import("../logging/logger");
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const deps = createDeps();
    await deps.startShell();
    m.shellDeps.writeStartupLog();
    expect(write).toHaveBeenCalledWith("\nBANNER\n\n");
    expect(logger.info).toHaveBeenCalledWith("runtime", "starting Firefly_Agent");
  });

  it("passes the dev flag and onShown callback into the splash factory", async () => {
    const { createSplashWindow } = await import("../startup/create-splash-window");
    const deps = createDeps();
    await deps.startShell();
    const onShown = vi.fn();
    m.shellDeps.createSplashWindow({ onShown });
    expect(createSplashWindow).toHaveBeenCalledWith({ isDev: false, onShown });
  });

  it("registers a quit-capable tray and forwards the token flush", async () => {
    const { createTray } = await import("../windows/tray");
    const deps = createDeps();
    await deps.startShell();
    const tray = m.shellDeps.createTray({ togglePetWindow: vi.fn(), requestActivation: vi.fn() });
    expect(tray).toBe(m.tray);
    const options = (createTray as unknown as { mock: { calls: any[][] } }).mock.calls.at(-1)![0];
    expect(options.memoryOnlineOnce).toBeUndefined();
    options.quit();
    expect(m.app.quit).toHaveBeenCalled();
  });

  it("wires will-quit callbacks through app.once", async () => {
    const deps = createDeps();
    await deps.startShell();
    const callback = vi.fn();
    m.shellDeps.onWillQuit(callback);
    expect(m.app.once).toHaveBeenCalledWith("will-quit", callback);
  });
});

describe("core phase", () => {
  it("delegates core startup and exposes the splash minimum", async () => {
    const deps = createDeps();
    await expect(deps.startCore(m.shellResult)).resolves.toBe(m.coreResult);
    expect(m.coreDeps.shell).toBe(m.shellResult);
    expect(m.coreDeps.minimumSplashMs).toBe(2500);
    const { markStartupPhaseReady } = await import("../windows/window-state");
    m.coreDeps.markStartupWindowsReady();
    expect(markStartupPhaseReady).toHaveBeenCalled();
  });

  it("requires a primary process before initializing skills", async () => {
    const deps = createDeps();
    await deps.prepare();
    await deps.startShell();
    await deps.startCore(m.shellResult);
    m.lockResult = false;
    await m.prepareDeps.installSingleInstance(vi.fn());
    await expect(m.coreDeps.initSkills()).rejects.toThrow("STATE_INVALID");
  });

  it("assembles low-cost services and locale/bootstrap configuration", async () => {
    const deps = createDeps();
    await deps.startShell();
    await deps.startCore(m.shellResult);
    const services = m.coreDeps.createLowCostServices();
    expect(services).toMatchObject({
      llm: m.llmClient,
      social: m.social,
      embedding: m.embedding,
      proactive: m.proactive,
      update: m.update,
    });
    expect(services.git).toBeDefined();
    expect(services.lsp).toBeDefined();
    expect(services.screenshot).toBe(m.screenshot);
    const { bootstrapConfigGetters } = await import("../startup/bootstrap-config");
    const { updateLocaleContext } = await import("../startup/locale-context");
    const { setLive2dWorkSignalSender } = await import("../orchestrator/live2d-work-signal");
    expect(bootstrapConfigGetters).toHaveBeenCalled();
    expect(updateLocaleContext).toHaveBeenCalledWith({ uiLocale: "zh-CN", dateLocale: "zh-CN", asrLanguage: "zh-CN" });
    expect(setLive2dWorkSignalSender).toHaveBeenCalledWith(expect.any(Function));
  });

  it("creates the agent runtime with the selected memory backend", async () => {
    const deps = createDeps();
    await deps.startShell();
    await deps.startCore(m.shellResult);
    const runtime = m.coreDeps.createRuntime({ llm: m.llmClient, embedding: m.embedding, social: m.social });
    expect(runtime).toBe(m.agentRuntime);
    expect(m.agentRuntimeOptions.llmClient).toBe(m.llmClient);
    expect(m.agentRuntimeOptions.defaultMemory).toBe(m.defaultMemory);
    expect(m.agentRuntimeOptions.loadModelSettings).toBeDefined();
    expect(m.agentRuntimeOptions.buildPluginPromptContext).toEqual(expect.any(Function));
  });

  it("initializes RAG and registers flush resources", async () => {
    const { initRAG } = await import("../rag");
    const deps = createDeps();
    await deps.startShell();
    await deps.startCore(m.shellResult);
    await m.coreDeps.initRag();
    expect(initRAG).toHaveBeenCalledWith(
      "auto",
      undefined,
      undefined,
      undefined,
      undefined,
      { personalMemoryMode: "smh" },
    );
    expect(m.resources.get("rag-store")).toMatchObject({ phase: "flushPersistence" });
    expect(m.shutdown.registerEmergencyFlush).toHaveBeenCalledWith("rag-store", expect.any(Function));
  });
});

describe("background phase", () => {
  it("prunes removed built-in MCP servers and logs the removals", async () => {
    const { pruneMcpServersByIds } = await import("../orchestrator/mcp-manager");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const deps = createDeps();
    await deps.startShell();
    await deps.startCore(m.shellResult);
    await deps.startBackground(m.coreResult);
    await m.backgroundDeps.pruneRemovedMcp();
    expect(pruneMcpServersByIds).toHaveBeenCalledWith(["removed-a"]);
    expect(log).toHaveBeenCalledWith("[Firefly] 已清理遗留的已下架内置 MCP:", "removed-a");
  });

  it("syncs and restores MCP configuration", async () => {
    const { syncPlaywrightMcp } = await import("../orchestrator/sync-mcp-builtin");
    const { initMcpManager } = await import("../orchestrator/mcp-manager");
    const deps = createDeps();
    await deps.startShell();
    await deps.startCore(m.shellResult);
    await deps.startBackground(m.coreResult);
    await m.backgroundDeps.syncBuiltInMcp();
    expect(syncPlaywrightMcp).toHaveBeenCalledWith(m.generalSettings);
    const signal = new AbortController().signal;
    m.backgroundDeps.restoreMcp(signal);
    expect(initMcpManager).toHaveBeenCalledWith({ signal });
  });

  it("skips memory reconciliation when aborted or a personal-memory backend is active", async () => {
    const { reconcileMemoryRag } = await import("../memory/memory-rag-reconciliation");
    const deps = createDeps();
    await deps.startShell();
    await deps.startCore(m.shellResult);
    await deps.startBackground(m.coreResult);
    const controller = new AbortController();
    controller.abort();
    await m.backgroundDeps.reconcileMemory(controller.signal);
    expect(reconcileMemoryRag).not.toHaveBeenCalled();
    await m.backgroundDeps.reconcileMemory(new AbortController().signal);
    expect(reconcileMemoryRag).not.toHaveBeenCalled();
  });

  it("reconciles user memory when the legacy backend is active", async () => {
    m.defaultMemory = null;
    m.vectorReady = true;
    const { reconcileMemoryRag } = await import("../memory/memory-rag-reconciliation");
    const deps = createDeps();
    await deps.startShell();
    await deps.startCore(m.shellResult);
    await deps.startBackground(m.coreResult);
    reconcileMemoryRag.mockResolvedValue({ reconciled: 1 });
    await m.backgroundDeps.reconcileMemory(new AbortController().signal);
    expect(reconcileMemoryRag).toHaveBeenCalledWith(expect.objectContaining({ addVector: expect.any(Function) }));
  });

  it("wires update checks and proactive lifecycle disposal", async () => {
    const { scheduleStartupUpdateCheck } = await import("../updater/github-app-updater");
    const disposeUpdate = vi.fn();
    scheduleStartupUpdateCheck.mockReturnValue(disposeUpdate);
    const deps = createDeps();
    await deps.startShell();
    await deps.startCore(m.shellResult);
    await deps.startBackground(m.coreResult);
    await expect(m.backgroundDeps.scheduleUpdateCheck()).resolves.toEqual({ dispose: disposeUpdate });
    const proactive = await m.backgroundDeps.startProactiveTrigger();
    expect(m.proactive.initializeProactiveTrigger).toHaveBeenCalled();
    proactive.dispose();
    expect(m.proactive.close).toHaveBeenCalled();
  });
});
