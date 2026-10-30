import { createSidebarLayoutStore } from "../chats/sidebar-layout-store";
import { registerSidebarLayoutIpc } from "../chats/sidebar-layout-ipc";
import { SIDEBAR_LAYOUT_IPC } from "../../shared/sidebar-layout";
import { registerDesktopAsrIpc } from "../asr/desktop-asr-ipc";
import { createMainDefaultMemory } from "../memory-context/main-default-memory";
import { registerMemorySettingsIpc } from "../memory-policy/memory-settings-ipc";
import { registerMemoryAutomationSettingsIpc } from "../memory-policy/memory-automation-settings-ipc";
import { registerShadowSettingsIpc } from "../memory-shadow/shadow-settings-ipc";
import { isFromHostDocument } from "../plugin-host/plugin-management-ipc-guard";
import { createBrowserWorkspaceExecutor } from "../browser/browser-workspace-executor";
import { createMainDesktopMemory } from "../memory-context/main-desktop-memory";
import { openDesktopMemoryBackend,desktopMemoryAdmissionMode } from "../memory-context/desktop-memory-backend";
import { getConversationTranscriptStore } from "../orchestrator/conversation-transcript-store";
import { getHarnessRunStore } from "../orchestrator/harness/run-store";
import { getStorageContext } from "../storage/storage-context";
import { app, BrowserWindow, dialog, screen, shell } from "electron";
import * as path from "path";
import * as fs from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { autoUpdater } from "electron-updater";
import { ensureGpuSandboxAcl } from "../startup/gpu-sandbox-acl";
import { getExternalContentPaths } from "../storage/external-content-paths";
import { migrateStagedExternalContent } from "../storage/external-content-migration";
import { logger, LogTag } from "../logging/logger";
import { renderBanner } from "../../shared/banner";
import { IPC } from "../../shared/ipc-channels";
import { isDev } from "../startup/env";
import { loadGeneralSettings, saveGeneralSettings, onGeneralSettingsChanged, } from "../settings/settings-facade";
import { getCurrentAppIconPath, markStartupPhaseReady, reactChatWindow, setGetCurrentAppIconPath, sidebarWindow, settingsWindow, } from "../windows/window-state";
import { getDefaultModelProfile, getCachedSavedModelProfile, listCachedSavedModelProfileIds, loadModelSettings, saveModelSettings, onModelConnectionChanged } from "../settings/model-settings";
import { registerSettingsIpc } from "../settings/settings-ipc";
import { applyGeneralSettings, handleGeneralSettingsChanged, syncVolcanoSearchMcp, } from "../settings/general-settings-lifecycle";
import { registerMemoryUserToolIpc } from "../memory/memory-user-ipc";
import { configureDocumentIndexQueue } from "../rag/document-index-queue";
import { runDocumentIndexJob } from "../rag/document-index-worker";
import { createLlmClient } from "../services/llm/llm-client";
import { createEmbeddingIndexService } from "../services/embedding/embedding-index-service";
import { addL2MemoryVector, deleteUserMemoryVectors, flushRAGStore, flushRAGStoreSync, getEntriesBySource, initRAG, isUserMemoryVectorStoreReady, } from "../rag";
import { getEmbeddingProvider } from "../rag/embedding";
import { toolRegistry } from "../orchestrator/tools/registry/tool-registry";
import { pluginPromptRegistry } from "../../plugins/prompts";
import type { PluginManager } from "../../plugins/manager";
import { setLive2dWorkSignalSender } from "../orchestrator/live2d-work-signal";
import { registerAllTools } from "../orchestrator/tools/registry/tool-registration";
import { LspManager } from "../lsp/manager";
import { initSandbox } from "../orchestrator/sandbox/sandbox-exec";
import { enterPlanDiscussing, exitPlanMode, getPlanState, initPlanPaths, initPlanStateBroadcaster, } from "../orchestrator/plan-mode";
import { initMcpManager, pruneMcpServersByIds } from "../orchestrator/mcp-manager";
import { syncPlaywrightMcp, REMOVED_BUILTIN_MCP_IDS } from "../orchestrator/sync-mcp-builtin";
import { registerAppUpdateIpc } from "../updater/app-update-ipc";
import { createGitHubAppUpdateService, scheduleStartupUpdateCheck } from "../updater/github-app-updater";
import { registerWindowSystemIpc } from "../windows/window-system-ipc";
import { enqueueLLMTask } from "../services/llm/llm-queue";
import { registerPrivilegedSchemes, registerProtocolHandlers, } from "../protocols/bootstrap";
import { memoryStore } from "../memory/memory-store";
import { backupMemoryRagFiles, reconcileMemoryRag } from "../memory/memory-rag-reconciliation";
import { registerChatsIpc } from "../chats/chats-ipc";
import { registerWorkspaceFilesIpc } from "../chats/workspace-files-ipc";
import { createElectronBrowserService } from "../browser/electron-browser-service";
import { createManualBrowserWorkspace } from "../browser/manual-browser-workspace";
import { createBrowserDownloads } from "../browser/browser-downloads";
import { createBrowserToolsHub } from "../browser/browser-tools-hub";
import { createBrowserToolSettingsStore } from "../browser/browser-tools-settings";
import { MANUAL_BROWSER_WORKSPACE_IPC } from "../../shared/manual-browser";
import { createStartupBrowserService } from "../browser/browser-startup-config";
import { registerBrowserHostOwner, registerManualBrowserHostOwner } from "../browser/browser-host-owner";
import { registerBrowserServiceIpc, registerManualBrowserWorkspaceIpc, installBrowserServiceLifecycle } from "../browser/browser-service-ipc";
import { activeChatTargetRegistry } from "../plugin-host/active-chat-target";
import { registerOpenInAppIpc } from "../chats/open-in-app";
import { registerChatUiIpc, getActiveChatSessionId } from "../chats/chat-ui-ipc";
import { createToastWindowController } from "../toast/toast-window";
import { createToastService } from "../toast/toast-service";
import { toastEvents } from "../toast/toast-events";
import { createToastWindowShell } from "../windows/create-toast-window";
import * as chatsStore from "../chats/chats-store";
import { flush as flushTokenUsage } from "../storage/token-usage-store";
import { loadUserProfile } from "../storage/settings-store";
import { getAppIconPath } from "../windows/app-icon";
import { hasActiveConversationRun, isActiveConversationRun, registerAgUiIpc } from "../chat/agui-bridge";
import { updateLocaleContext } from "../startup/locale-context";
import { initSkills, rescanSkills, skillRegistry } from "../skills";
import { createExternalSkillService } from "../skills/external-service";
import { registerExternalSkillsIpc } from "../skills/external-ipc";
import { recoverExternalSkills } from "../skills/external-install";
import { ExternalSkillStateStore } from "../skills/external-state";
import { EXTERNAL_SKILL_REVIEWS } from "../skills/external-reviews";
import type { ExternalHostSession } from "../skills/external-types";
import { createSchedulerSubsystem } from "../scheduler/bootstrap";
import type { SchedulerSubsystem } from "../scheduler/bootstrap";
import { createChannelsSubsystem } from "../channels/bootstrap";
import { createLifecyclePublisher } from "../plugin-host/lifecycle-publisher";
import { createPendingTurnLifecycle } from "../plugin-host/pending-turn-lifecycle";
import { startPluginRuntime } from "../plugin-host/plugin-runtime";
import { createAgentRuntime } from "../orchestrator/agent-runtime";
import { createProactiveLifecycle } from "../proactive/proactive-lifecycle";
import { createSocialContextService } from "../services/social-context/social-context-service";
import { createGitService } from "../code-git/git-service";
import { resolveGitExecutable, type ResolvedGitExecutable } from "../code-git/git-executable";
import { registerCodeGitIpc } from "../code-git/code-git-ipc";
import { installSingleInstanceGuard } from "../startup/single-instance";
import { createWindowManager } from "../windows/window-manager";
import { createTray } from "../windows/tray";
import { ADMISSION_ROOT } from "../memory-online-once/runner";
import { createMainProbeEntry } from "../memory-online-once/main-entry";
import { createSplashWindow } from "../startup/create-splash-window";
import { revealStartupWindows } from "../startup/startup-window-reveal";
import { bootstrapMusicService } from "../music/bootstrap";
import { initializeScreenshotService } from "../screenshot/screenshot-lifecycle";
import { bootstrapConfigGetters } from "../startup/bootstrap-config";
import { bootstrapPermission } from "../permission/bootstrap";
import { registerPopQuizIpc, registerPopQuizTool } from "../orchestrator/pop-quiz";
import { createIpcScope } from "./ipc-scope";
import type { IpcScope } from "./ipc-scope";
import { createShutdownCoordinator } from "./shutdown";
import type { ShutdownCoordinator } from "./shutdown";
import { createStartupReadiness } from "./readiness";
import type { StartupReadiness } from "./readiness";
import { createWindowActivationBroker } from "./window-activation";
import type { WindowActivationBroker } from "./window-activation";
import { prepareBeforeReady } from "./pre-ready";
import { startShell } from "./shell-bootstrap";
import type { ShellResult } from "./shell-bootstrap";
import { startCore } from "./core-bootstrap";
import type { CoreServices, RegisterCoreIpcInput } from "./core-bootstrap";
import type { CoreResult } from "./core-bootstrap";
import { startBackground } from "./background";
import type { BackgroundDependencies } from "./background";
import { installUpdateShutdownFallback, type UpdateLifecycleLike } from "./electron-lifecycle";
import type { ApplicationDependencies } from "./application";

/**
 * 默认依赖装配：真正把各业务子系统接到启动阶段上的胶水层。
 * 只有 index.ts 会引用这里；application.ts 与各 bootstrap 模块看不到具体实现。
 * 本文件里的闭包只负责构造和转发，长期运行的任务必须由对应阶段显式启动。
 */

/** Loading 窗口最短展示毫秒数，从真正 show 的时刻开始算 */
const SPLASH_MIN_MS = 2500;
/** 受控退出的总超时毫秒数 */
const SHUTDOWN_TIMEOUT_MS = 10_000;

type DefaultMemory = ReturnType<typeof createMainDefaultMemory>;
type DesktopMemory = NonNullable<DefaultMemory> | ReturnType<typeof createMainDesktopMemory>;

// 向辅助窗口（聊天、侧栏、设置）逐个广播，已销毁的跳过
function broadcastToAuxWindows(channel: string, payload: unknown): void {
  [reactChatWindow, sidebarWindow, settingsWindow].forEach((win) => {
    if (!win || win.isDestroyed()) return;
    win.webContents.send(channel, payload);
  });
}

async function reconcileUserMemoryIndex(): Promise<void> {
  if (!isUserMemoryVectorStoreReady()) {
    console.warn("[Memory/RAG] reconciliation skipped: vector store is not writable");
    return;
  }
  const outcome = await reconcileMemoryRag({
    getMemories: () => memoryStore.getAllL2(),
    getVectors: () => getEntriesBySource("user_memory"),
    backup: async () => backupMemoryRagFiles(app.getPath("userData")),
    addVector: addL2MemoryVector,
    markSynced: (l2Id, ragId) => memoryStore.markL2SyncStatus(l2Id, "synced", ragId),
    markSyncFailed: (l2Id, error) => memoryStore.markL2SyncStatus(l2Id, "sync_failed", undefined, error),
    deleteVectors: (ids) => deleteUserMemoryVectors(ids),
    warn: (message, error) => console.warn(`[Memory/RAG] ${message}:`, error),
  });
  logger.info(LogTag.RAG, "reconciliation:", outcome);
}

// ---- 计划模式 IPC ----

type PlanSetModePayload = { conversationId?: string; target?: "on" | "off"; workspaceRoot?: string };

function handlePlanSetMode(payload: PlanSetModePayload) {
  const conversationId = payload?.conversationId;
  const target = payload?.target;
  if (!conversationId) return { ok: false, reason: "缺少 conversationId" };
  if (target !== "on" && target !== "off") return { ok: false, reason: "target 必须是 on/off" };

  const current = getPlanState(conversationId);
  if (target === "on") {
    // 已经处于计划模式时不做任何事
    if (current !== "NORMAL") return { ok: true, state: current };
    const entered = enterPlanDiscussing(conversationId, payload.workspaceRoot);
    return entered.ok
      ? { ok: true, state: getPlanState(conversationId) }
      : { ok: false, reason: entered.reason, state: current };
  }

  if (current === "EXECUTING") {
    return { ok: false, reason: "计划执行中，不可手动退出", state: current };
  }
  if (current === "NORMAL") return { ok: true, state: current };
  exitPlanMode(conversationId);
  return { ok: true, state: getPlanState(conversationId) };
}

function handlePlanGetState(payload: { conversationId?: string }) {
  const conversationId = payload?.conversationId;
  return conversationId ? { state: getPlanState(conversationId) } : { state: "NORMAL" as const };
}

// ---- 低成本服务 ----

function buildLowCostServices(shell: ShellResult, defaultMemory: DefaultMemory | null): CoreServices {
  const llm = createLlmClient();
  const embedding = createEmbeddingIndexService();
  const social = createSocialContextService({ llmClient: llm, enqueueLLMTask });
  const proactive = createProactiveLifecycle({ loadGeneralSettings, memoryHost:defaultMemory?.backgroundHost });
  // 主动聊天只做装配，触发器由 background 阶段启动
  proactive.initializeProactiveChatService();

  bootstrapConfigGetters({ loadGeneralSettings });

  // 把语言设置同步到 Locale Context
  const startupSettings = loadGeneralSettings();
  updateLocaleContext({
    uiLocale: startupSettings.language,
    dateLocale: startupSettings.language,
    asrLanguage: startupSettings.asrLanguage,
  });

  // 桌宠“工作中”信号：Agent 调用工具期间为 true
  setLive2dWorkSignalSender((working) => shell.windowManager.sendToPetWindow(IPC.LIVE2D_WORKING_CHANGED, working));

  // Git 可执行文件的探测结果在进程内缓存：成功一次后不再重复探测，
  // 免得启动高峰的偶发超时让 Git 面板误报；失败不缓存，下次重试
  let gitExecutable: ResolvedGitExecutable | null = null;
  const bundledGit = (): string =>
    app.isPackaged
      ? path.join(process.resourcesPath, "mingit", "cmd", "git.exe")
      : path.join(app.getAppPath(), "resources", "mingit", "cmd", "git.exe");
  const git = createGitService({
    getSession: chatsStore.getSession,
    resolveExecutable: async () => {
      gitExecutable ??= await resolveGitExecutable({ systemCommand: "git", bundledPath: bundledGit() });
      return gitExecutable;
    },
  });

  const lsp = new LspManager({ getServerOverrides: () => loadGeneralSettings().lspServerOverrides });

  // 截图服务：热键与原生 helper 的 IPC 在这里接好，预热留给 background
  const settingsForShell = loadGeneralSettings();
  const screenshot = initializeScreenshotService({
    initialHotkey: settingsForShell.screenshotHotkey ?? "Alt+Shift+S",
    getReactChatWindow: () => reactChatWindow,
    capturePetWindow: () => shell.windowManager.capturePetWindow(),
    ipc: shell.ipc,
  });

  const music = bootstrapMusicService({ enabled: settingsForShell.musicEnabled });

  // 更新服务：检查和下载按需触发，安装必须走受控退出
  const update = createGitHubAppUpdateService({ currentVersion: app.getVersion(), isPackaged: app.isPackaged });

  return { llm, social, embedding, proactive, git, lsp, screenshot, music, update };
}

// ---- 提醒中心 ----

function wireToasts(
  input: { ipc: IpcScope; windowManager: unknown },
  activation: WindowActivationBroker,
  shutdown: ShutdownCoordinator,
): void {
  const windowCtl = createToastWindowController({
    createWindow: createToastWindowShell,
    getChatWindow: () => reactChatWindow,
    getDisplayMatching: (bounds) => screen.getDisplayMatching(bounds),
    getCursorScreenPoint: () => screen.getCursorScreenPoint(),
  });
  const service = createToastService({
    bus: toastEvents,
    window: windowCtl,
    activate: (request) => {
      activation.request(request);
    },
    // 音效开关每次弹出时现读，设置修改立刻生效
    isSoundEnabled: () => loadGeneralSettings().toastSoundEnabled,
    // 仅当事件带会话、聊天窗口聚焦且当前会话一致时才抑制通知；
    // 调度任务结果没有会话落点，永不抑制
    shouldSuppressNotify: (event) => {
      if (!event.sessionId) return false;
      const chat = reactChatWindow;
      if (!chat || chat.isDestroyed() || !chat.isFocused()) return false;
      return getActiveChatSessionId() === event.sessionId;
    },
  });
  service.registerIpc(input.ipc);
  // 先建好隐藏窗口并预载页面，首次弹出没有延迟
  windowCtl.preload();
  shutdown.register({
    id: "toast-center",
    phase: "stopLocalResources",
    dispose: async () => {
      service.dispose();
      windowCtl.dispose();
    },
  });
}

// ---- 后台阶段依赖 ----

function buildBackgroundDeps(
  core: CoreResult,
  readiness: StartupReadiness,
  shutdown: ShutdownCoordinator,
  defaultMemory: DefaultMemory | null,
): BackgroundDependencies {
  const { services } = core;
  return {
    core,
    readiness,
    shutdown,
    channels: core.channels,
    scheduler: core.scheduler,
    pruneRemovedMcp: async () => {
      // 一次性清掉已下架的内置 MCP（如托管版 Firecrawl）
      const removedIds = await pruneMcpServersByIds([...REMOVED_BUILTIN_MCP_IDS]);
      if (removedIds.length) {
        console.log("[Firefly] 已清理遗留的已下架内置 MCP:", removedIds.join(", "));
      }
    },
    // Playwright 内置 MCP 默认关闭，由设置项控制
    syncBuiltInMcp: async () => {
      await syncPlaywrightMcp(loadGeneralSettings());
    },
    restoreMcp: (signal) => initMcpManager({ signal }),
    reconcileMemory: async (signal) => {
      if (signal.aborted || defaultMemory) return;
      try {
        await reconcileUserMemoryIndex();
      } catch (err) {
        console.warn("[Memory/RAG] startup reconciliation failed:", err);
        throw err;
      }
    },
    scheduleEmbeddingRefresh: async () => {
      services.embedding.scheduleStartupRefreshes();
    },
    // initReranker 会自行检测模型是否已安装，没装就降级为 none
    initializeReranker: async () => {
      try {
        const { initReranker } = await import("../rag/reranker");
        const { rerankerMode } = loadModelSettings();
        await initReranker(rerankerMode);
        logger.info(LogTag.Reranker, "initialized with mode:", rerankerMode);
      } catch (err) {
        logger.warn(LogTag.Reranker, "startup init failed:", err);
      }
    },
    prewarmScreenshot: async () => {
      await services.screenshot.prewarm();
    },
    scheduleUpdateCheck: async () => ({ dispose: scheduleStartupUpdateCheck(services.update) }),
    startProactiveTrigger: async () => {
      services.proactive.initializeProactiveTrigger();
      return { dispose: () => core.services.proactive.close() };
    },
  };
}

export function createDefaultApplicationDependencies(): ApplicationDependencies {
  // 只有真正拿到单实例锁之后才记为主进程
  let primaryProcess = false;
  const externalHost: ExternalHostSession = { runId: randomUUID(), isPrimaryProcess: () => primaryProcess };
  let externalSkillsIpc: ReturnType<typeof registerExternalSkillsIpc> | undefined;
  let workspaceFiles: ReturnType<typeof registerWorkspaceFilesIpc> | undefined;
  let desktopAsr: ReturnType<typeof registerDesktopAsrIpc> | undefined;
  // Agent Runtime 比插件管理器先构造，这里用一个可后填的引用在运行期转发宿主事件
  let pluginManager: PluginManager | undefined;

  const hasSwitch = (name: string): boolean => app.commandLine?.hasSwitch(name) === true;

  // 仅限显式的诊断启动。开关只启用界面，不会创建或重置额度；
  // 启动期绑定只触碰固定的 E: 盘非密钥准入文件，Profile 查询只读缓存。
  const memoryOnlineEntry = createMainProbeEntry(hasSwitch("firefly-memory-online-once"), {
    root: ADMISSION_ROOT,
    resolveProfile: getCachedSavedModelProfile,
    listProfileIds: listCachedSavedModelProfileIds,
    fetch: (...args) => globalThis.fetch(...args),
    now: Date.now,
    show: (options) => dialog.showMessageBox(options),
  });
  app.once("will-quit", () => memoryOnlineEntry?.cancel());

  const forwardToPlugins = (event: Parameters<PluginManager["publishHostEvent"]>[0], payload: Parameters<PluginManager["publishHostEvent"]>[1]) =>
    pluginManager ? pluginManager.publishHostEvent(event, payload) : Promise.resolve();

  // 插件系统就绪之前发布的事件没人监听，直接丢弃
  const lifecyclePublisher = createLifecyclePublisher({ publish: forwardToPlugins });
  // 桌面轮次协调器：turn:finished 要等到“终态”和“渲染端落盘确认”都满足；
  // 计时器都是 unref 的，退出前统一清理，不会发布任何事件
  const pendingTurnLifecycle = createPendingTurnLifecycle({
    publisher: lifecyclePublisher,
    onAbandon: (runId, reason) => {
      console.warn(`[plugins] 桌面轮次事件放弃发布: runId=${runId} reason=${reason}`);
    },
  });
  app.on("will-quit", () => pendingTurnLifecycle.disposeAll());

  const readiness = createStartupReadiness();
  const activation = createWindowActivationBroker();
  const shutdown = createShutdownCoordinator({
    readiness,
    timeoutMs: SHUTDOWN_TIMEOUT_MS,
    beforeShutdown: () => workspaceFiles?.confirmBeforeShutdown() ?? Promise.resolve(true),
  });

  // ---- 桌面记忆：仅由 Main 在启动时显式开启，渲染端没有开关、凭据、根目录或 actor 令牌 ----
  const memoryAdmissionMode = desktopMemoryAdmissionMode(hasSwitch, getStorageContext().profile.kind);
  const memoryEnabled = hasSwitch("firefly-memory-controlled");
  const memoryProfileId = () => getDefaultModelProfile(loadModelSettings())?.id;
  const controlledMemory = memoryEnabled
    ? createMainDesktopMemory({
        enabled: true,
        getChatWindow: () => reactChatWindow,
        targets: activeChatTargetRegistry,
        getSession: chatsStore.getSession,
        listSessionIds: () => chatsStore.listSessions({ mode: "chat" }).map((session) => session.id),
        isControlledSession: (session) => session.modelProfileId === memoryProfileId(),
        store: getConversationTranscriptStore(getStorageContext().dataRoot),
        openBackend: () =>
          openDesktopMemoryBackend({
            profileId: memoryProfileId,
            ...(memoryAdmissionMode ? { admissionMode: memoryAdmissionMode } : {}),
          }),
      })
    : null;
  const defaultMemory = memoryEnabled
    ? null
    : createMainDefaultMemory({
        getChatWindow: () => reactChatWindow,
        getSettingsWindow: () => settingsWindow,
        targets: activeChatTargetRegistry,
        getSession: chatsStore.getSession,
        getSessionKind: chatsStore.getSessionKind,
        listSessionIds: () => chatsStore.listSessions().map((session) => session.id),
        listProjectBindings: () =>
          chatsStore.listSessions().map((session) => ({
            workspaceRoot: session.workspaceRoot,
            displayName: session.workspaceDisplayName,
          })),
        store: getConversationTranscriptStore(getStorageContext().dataRoot),
        settings: loadModelSettings,
        runReader:{get:runId=>getHarnessRunStore(getStorageContext().dataRoot).get(runId)},
      });
  const desktopMemory: DesktopMemory | null = defaultMemory ?? controlledMemory;

  const releaseMemoryModelRefresh = onModelConnectionChanged(() => defaultMemory?.refreshModels());
  shutdown.register({ id: "memory-model-refresh", phase: "quiesce", dispose: releaseMemoryModelRefresh });
  if (desktopMemory) {
    shutdown.register({ id: "desktop-memory-admission", phase: "quiesce", dispose: () => desktopMemory.quiesce() });
    shutdown.register({ id: "desktop-memory-resources", phase: "stopLocalResources", dispose: () => desktopMemory.close() });
  }

  // ---- 浏览器宿主 ----
  let browserService: ReturnType<typeof createElectronBrowserService> | undefined;
  let manualBrowserService: ReturnType<typeof createManualBrowserWorkspace> | undefined;
  type BrowserHost = {
    window: BrowserWindow;
    binding: ReturnType<typeof registerBrowserHostOwner>;
    manualBinding: ReturnType<typeof registerManualBrowserHostOwner>;
  };
  let browserHost: BrowserHost | undefined;

  // 当前宿主窗口仍然存活，且（若指定了 owner）确实属于它时才返回
  const liveHostFor = (accept: (win: BrowserWindow) => boolean = () => true) => {
    const host = browserHost;
    if (!host) return undefined;
    if (!accept(host.window)) return undefined;
    if (host.window.isDestroyed() || host.window.webContents.isDestroyed()) return undefined;
    return host;
  };

  const getBrowserService = () => {
    if (browserService) return browserService;
    const created = createStartupBrowserService({
      profile: getStorageContext().profile,
      onChanged: (owner, page) => {
        const host = liveHostFor((win) => win === owner.host);
        if (host) host.window.webContents.send(IPC.BROWSER_CHANGED, page);
      },
    });
    browserService = created;
    app.once("will-quit", installBrowserServiceLifecycle(app, created, shutdown, "browser-service"));
    return created;
  };

  const getManualBrowserWorkspace = () => {
    if (manualBrowserService) return manualBrowserService;
    // 窗口级浏览器工具：下载及其设置对整个窗口生效，标签页工具直接作用于标签自己的页面
    const toolSettings = createBrowserToolSettingsStore(
      path.join(getStorageContext().dataRoot, "browser", "tools-settings.json"),
    );
    const sendToBrowserWindow = (channel: string, payload: unknown, only?: unknown) => {
      const host = liveHostFor((win) => only === undefined || win === only);
      if (host) host.window.webContents.send(channel, payload);
    };
    const browserDownloads = createBrowserDownloads({
      getSettings: () => toolSettings.get(),
      defaultDirectory: () => app.getPath("downloads"),
      exists: (candidate) => fs.existsSync(candidate),
      ensureDirectory: (directory) => {
        fs.mkdirSync(directory, { recursive: true });
      },
      openPath: (target) => shell.openPath(target),
      showInFolder: (target) => shell.showItemInFolder(target),
      now: () => Date.now(),
      newId: () => randomUUID(),
      onChange: (downloads) => sendToBrowserWindow(MANUAL_BROWSER_WORKSPACE_IPC.toolsChanged, { kind: "downloads", downloads }),
    });
    shutdown.register({ id: "browser-downloads", phase: "quiesce", dispose: () => browserDownloads.dispose() });

    const toolsHub = createBrowserToolsHub({
      downloads: browserDownloads,
      settings: toolSettings,
      now: () => new Date(),
      emit: (host, change) => sendToBrowserWindow(MANUAL_BROWSER_WORKSPACE_IPC.toolsChanged, change, host),
      dialogs: {
        saveScreenshot: async (host, png, suggestedName) => {
          const picked = await dialog.showSaveDialog(host as BrowserWindow, {
            defaultPath: path.join(app.getPath("pictures"), suggestedName),
            filters: [{ name: "PNG", extensions: ["png"] }],
          });
          if (picked.canceled || !picked.filePath) return false;
          await fs.promises.writeFile(picked.filePath, png);
          return true;
        },
        chooseFolder: async (host) => {
          const picked = await dialog.showOpenDialog(host as BrowserWindow, {
            properties: ["openDirectory", "createDirectory"],
          });
          return picked.canceled ? null : picked.filePaths[0] ?? null;
        },
      },
    });

    const created = createManualBrowserWorkspace({
      tools: toolsHub,
      createService: (onChanged) =>
        createStartupBrowserService({
          profile: getStorageContext().profile,
          onChanged,
          acceptDownload: (_owner, item) => browserDownloads.handle(item),
        }),
      onChanged: (owner, page) => {
        const host = liveHostFor((win) => win === owner.host);
        if (host) host.window.webContents.send(MANUAL_BROWSER_WORKSPACE_IPC.changed, page);
      },
    });
    manualBrowserService = created;
    app.once("will-quit", installBrowserServiceLifecycle(app, created, shutdown, "manual-browser-service"));
    return created;
  };

  const bindBrowserHost = (window: BrowserWindow): void => {
    externalSkillsIpc?.refreshHost();
    browserHost?.binding.dispose();
    browserHost?.manualBinding.dispose();
    const binding = registerBrowserHostOwner({
      host: window,
      profile: getStorageContext().profile,
      targets: activeChatTargetRegistry,
      service: getBrowserService(),
      readSession: chatsStore.getSession,
    });
    const manualBinding = registerManualBrowserHostOwner({
      host: window,
      profile: getStorageContext().profile,
      service: getManualBrowserWorkspace(),
    });
    const current: BrowserHost = { window, binding, manualBinding };
    browserHost = current;
    window.once("closed", () => {
      externalSkillsIpc?.refreshHost();
      binding.dispose();
      manualBinding.dispose();
      if (browserHost === current) browserHost = undefined;
    });
  };

  // 应用图标路径 getter 必须先于 shell 阶段注入：聊天窗口壳和托盘在 shell 阶段创建时就会读取，
  // 等到 core 阶段才注入的话托盘会拿到空路径，显示成 Electron 默认图标。
  // getter 是惰性的，注册时不会读磁盘。
  setGetCurrentAppIconPath(() => getAppIconPath(loadGeneralSettings().uiIcon));

  // ---- core 阶段的 IPC 注册，按分组拆开，调用顺序保持不变 ----

  const registerSkillAndInputIpc = (ipc: IpcScope): void => {
    const externalService = createExternalSkillService({
      storage: getStorageContext(),
      host: externalHost,
      fetch: (...args) => globalThis.fetch(...args),
      now: Date.now,
      diagnose: (diagnostic) => logger.warn(LogTag.Skills, "external-marketplace", diagnostic),
      randomToken: () => randomBytes(32).toString("hex"),
      reviews: EXTERNAL_SKILL_REVIEWS,
      rescan: rescanSkills,
    });
    externalSkillsIpc = registerExternalSkillsIpc({
      ipc,
      getHostWebContents: () => (reactChatWindow && !reactChatWindow.isDestroyed() ? reactChatWindow.webContents : null),
      service: externalService,
    });
    shutdown.register({ id: "external-skills", phase: "quiesce", dispose: () => externalSkillsIpc!.dispose() });
    desktopAsr = registerDesktopAsrIpc({ ipc, getChatContents: () => reactChatWindow?.webContents });
    shutdown.register({ id: "desktop-asr", phase: "quiesce", dispose: () => desktopAsr?.dispose() });
    registerBrowserServiceIpc(ipc, getBrowserService());
    registerManualBrowserWorkspaceIpc(ipc, getManualBrowserWorkspace());
  };

  const registerSettingsRelatedIpc = (input: RegisterCoreIpcInput, shell: ShellResult): void => {
    const { ipc, services } = input;
    // 设置变化后联动窗口、托盘、截图热键和主动服务
    onGeneralSettingsChanged((before, after) =>
      handleGeneralSettingsChanged(before, after, {
        windowManager: shell.windowManager,
        tray: shell.tray,
        screenshotService: services.screenshot,
        proactiveLifecycle: services.proactive,
        broadcastToAuxWindows,
      }),
    );

    const releaseSettingsConnections = registerSettingsIpc({
      ipc,
      windowManager: shell.windowManager,
      getGeneralSettings: loadGeneralSettings,
      saveGeneralSettings,
      getModelSettings: loadModelSettings,
      saveModelSettings: (settingsInput) => {
        const saved = saveModelSettings(settingsInput);
        defaultMemory?.refreshModels();
        return saved;
      },
      proactiveLifecycle: services.proactive,
      reconcileUserMemoryIndex:defaultMemory?async()=>{}:reconcileUserMemoryIndex,
      embeddingIndexService: services.embedding,
      syncVolcanoSearchMcp,
      syncPlaywrightMcp,
    });
    shutdown.register({ id: "model-connection-listener", phase: "quiesce", dispose: releaseSettingsConnections });

    const settingsContents = () => (settingsWindow && !settingsWindow.isDestroyed() ? settingsWindow.webContents : null);
    registerMemorySettingsIpc({ ipc, getSettingsWindow: () => settingsWindow, host:defaultMemory?.settingsHost ?? null, ...(defaultMemory ? { summary: () => defaultMemory.graphSummary() } : {}) });
    registerMemoryAutomationSettingsIpc({
      ipc,
      getSettingsWindow: () => settingsWindow,
      host: defaultMemory?.automationHost ?? null,
    });
    // 影子记忆抽取设置（实验功能，默认关闭）：只接受设置窗口的主框架
    registerShadowSettingsIpc({
      ipc,
      authorize: (event) => isFromHostDocument(event, settingsContents(), "settings"),
      service: async () => (await defaultMemory?.getShadowService()) ?? null,
      chooseExportPath: async (defaultName) => {
        const parent = settingsWindow && !settingsWindow.isDestroyed() ? settingsWindow : undefined;
        const options = {
          title: "导出影子记忆",
          defaultPath: path.join(app.getPath("documents"), defaultName),
          filters: [{ name: "JSON", extensions: ["json"] }],
          properties: ["showOverwriteConfirmation" as const],
        };
        const picked = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
        return picked.canceled ? undefined : picked.filePath;
      },
      writeFile: (filePath, content) => fs.promises.writeFile(filePath, content, "utf8"),
    });
    registerMemoryUserToolIpc({ personalMemoryMode:defaultMemory?"smh":"legacy",
      ipc,
      windowManager: shell.windowManager,
      embeddingIndexService: services.embedding,
    });
  };

  const registerWorkspaceAndRunIpc = (input: RegisterCoreIpcInput): void => {
    const { ipc, runtime, services } = input;
    // 会话存储 IPC（chats-store.initialize 会建好 firefly-chats 目录并载入索引）
    registerChatsIpc(ipc, {
      ...(desktopMemory ? { memory: desktopMemory } : {}),
      llmClient: services.llm,
      isPrimaryModelBusy: hasActiveConversationRun,
    });
    registerSidebarLayoutIpc(ipc, {
      store: createSidebarLayoutStore(getStorageContext(), () => chatsStore.listSessions()),
      getChatContents: () => reactChatWindow?.webContents,
      onChanged: () => {
        if (reactChatWindow && !reactChatWindow.isDestroyed()) {
          reactChatWindow.webContents.send(SIDEBAR_LAYOUT_IPC.changed);
        }
      },
    });
    registerCodeGitIpc({ ipc, service: services.git });
    // 会话工作区的只读文件（右侧文件树与预览）
    workspaceFiles = registerWorkspaceFilesIpc(ipc, { getChatContents: () => reactChatWindow?.webContents });
    // 工作区右上角“打开”菜单：探测本机应用并执行打开
    registerOpenInAppIpc(ipc);

    // AG-UI 事件桥：渲染端 invoke(AGUI_RUN) 后由 FireflyAgent 跑 Agent 循环并透传事件
    registerAgUiIpc(
      runtime.buildOptions,
      (result, latestUserText, context) => runtime.onRunFinished(result, latestUserText, context),
      () => reactChatWindow,
      services.proactive.proactiveConversationLifecycle,
      ipc,
      pendingTurnLifecycle,
      desktopMemory ?? undefined,
    );

    // 应用更新：安装走受控退出；autoUpdater 的兜底路径汇入同一个协调器
    registerAppUpdateIpc({
      ipc,
      service: services.update,
      requestControlledShutdown: (request) => shutdown.requestControlledShutdown(request),
    });
    installUpdateShutdownFallback({
      updater: autoUpdater as unknown as UpdateLifecycleLike,
      coordinator: shutdown,
      finalAction: () => services.update.install(),
    });

    ipc.handle(IPC.PLAN_SET_MODE, (_event, payload: PlanSetModePayload) => handlePlanSetMode(payload));
    ipc.handle(IPC.PLAN_GET_STATE, (_event, payload: { conversationId?: string }) => handlePlanGetState(payload));

    // 权限模块：从磁盘加载并注册权限/选择卡片 IPC（要在 createWindow 之后、任何工具调用之前）
    bootstrapPermission(ipc);
    // pop_quiz 抽查：提交/跳过的 IPC，以及仅 Work 模式可见的工具
    registerPopQuizIpc(ipc);
    registerPopQuizTool();
  };

  return {
    app,
    dialog,
    readiness,
    activation,
    shutdown,

    prepare: () =>
      prepareBeforeReady({
        configureDocumentIndex: () => configureDocumentIndexQueue(runDocumentIndexJob),
        installSingleInstance: (onSecondInstance) => {
          primaryProcess = installSingleInstanceGuard(app, onSecondInstance);
          return primaryProcess;
        },
        registerPrivilegedSchemes,
        ensureGpuSandboxAcl: () =>
          ensureGpuSandboxAcl({
            isPackaged: app.isPackaged,
            exeDir: path.dirname(app.getPath("exe")),
            userDataDir: app.getPath("userData"),
          }),
        activation,
      }),

    startShell: () =>
      startShell({
        readiness,
        activation,
        shutdown,
        // banner 是纯文本，不带颜色和日志前缀，以便和 logger 输出区分
        writeStartupLog: () => {
          process.stdout.write("\n" + renderBanner() + "\n\n");
          logger.info(LogTag.Runtime, "starting Firefly_Agent");
        },
        createIpcScope: () => createIpcScope(),
        onWillQuit: (callback) => {
          app.once("will-quit", callback);
        },
        createSplashWindow: (options) => createSplashWindow({ isDev, onShown: options.onShown }),
        createWindowManager: () =>
          createWindowManager({
            onChatWindowCreated: bindBrowserHost,
            getCurrentAppIconPath,
            isDev,
            loadPetWindowSettingsSlice: loadGeneralSettings,
            persistPetWindowPosition: ({ x, y }) => saveGeneralSettings({ petWindowX: x, petWindowY: y }),
          }),
        createChatShell: (windowManager) => windowManager.createReactChatWindowShell(),
        registerProtocolHandlers,
        registerShellIpc: ({ ipc, windowManager, live2dWindowLifecycle }) => {
          // quit 由这里注入，窗口系统 IPC 不直接依赖 electron app，退出仍走受控链路
          registerWindowSystemIpc({ ipc, windowManager, quit: () => app.quit() });
          registerChatUiIpc({
            ipc,
            live2dWindowLifecycle,
            windowManager,
            onActiveTargetChanged: () => {
              desktopAsr?.cancelAll();
              browserHost?.binding.refresh();
              desktopMemory?.refresh();
            },
          });
        },
        createTray: (input) =>
          createTray({
            togglePetWindow: input.togglePetWindow,
            requestActivation: input.requestActivation,
            quit: () => app.quit(),
            memoryOnlineOnce: memoryOnlineEntry
              ? { run: () => { void memoryOnlineEntry.run(); }, cancel: () => memoryOnlineEntry.cancel() }
              : undefined,
          }),
        flushTokenUsage,
      }),

    startCore: (shell) =>
      startCore({
        minimumSplashMs: SPLASH_MIN_MS,
        markStartupWindowsReady: () => markStartupPhaseReady(),
        shell,
        shutdown,
        activation,
        readiness,

        // NSIS 暂存的安装目录用户内容要合并进 userData，
        // 必须早于任何 prompts/skills 读取（initSkills、prompt 加载）
        migrateStagedExternalContent: () =>
          migrateStagedExternalContent({
            manifestFile: getStorageContext().files.contentManifest,
            allowStagedMigration: getStorageContext().profile.kind === "production",
            isPackaged: app.isPackaged,
            ...getExternalContentPaths(),
          }),
        // 技能系统：扫描双源 skills 并注册 meta-tool
        initSkills: async () => {
          if (!externalHost.isPrimaryProcess()) throw new Error("STATE_INVALID");
          const storage = getStorageContext();
          recoverExternalSkills(storage, new ExternalSkillStateStore(storage, externalHost));
          await initSkills(storage, externalHost);
        },

        createLowCostServices: () => buildLowCostServices(shell, defaultMemory),

        // SRT 沙箱：检测安装状态但不弹 UAC。要早于 registerAllTools，
        // 这样 run_shell 的 workspace_mutation 分支才能用上沙箱；失败不阻塞启动
        initSandbox: () => initSandbox(),

        initPlanMode: () => {
          // 计划模式的路径根：write_plan 与 plan.md 读写都在 userData/plans/<conversationId>/ 下
          initPlanPaths(app.getPath("userData"));
          // 状态每次切换都广播给所有窗口
          initPlanStateBroadcaster((conversationId, state) => {
            const payload = { conversationId, state };
            BrowserWindow.getAllWindows().forEach((win) => win.webContents.send(IPC.PLAN_STATE_CHANGED, payload));
          });
        },

        // 工具集中在这一个入口注册（依赖沙箱、Git、LSP 已就绪）
        registerAllTools: (services) =>
          registerAllTools({
            personalMemoryMode:defaultMemory?"smh":"legacy",
            codeGitService: services.git,
            lspManager: services.lsp,
            browserWorkspace: createBrowserWorkspaceExecutor({
              currentOwner: () => browserHost?.binding.getCurrentOwner() ?? null,
              service: getBrowserService,
              isRunCurrent: isActiveConversationRun,
            }),
          }),

        initRag: async () => {
          const modelSettings = loadModelSettings();
          await initRAG(
            "auto",
            undefined,
            undefined,
            modelSettings.embeddingModel,
            modelSettings.embeddingDimensions,
            { personalMemoryMode:defaultMemory?"smh":"legacy" },
          );
          // RAG 落盘：受控退出时在 flushPersistence 阶段刷盘；
          // Windows 会话结束（断电或强制关机）则走同步紧急落盘兜底
          shutdown.register({
            id: "rag-store",
            phase: "flushPersistence",
            dispose: async () => {
              await flushRAGStore();
            },
          });
          shutdown.registerEmergencyFlush("rag-store", () => flushRAGStoreSync());
          logger.info(LogTag.RAG, "RAG initialized OK");
        },

        createRuntime: (services) =>
          createAgentRuntime({
            ...(controlledMemory ? { sContext: controlledMemory.sContext } : {}),
            ...(defaultMemory ? { defaultMemory:defaultMemory } : {}),
            publishToolFinished: (event) => lifecyclePublisher.publishToolFinished(event),
            publishPluginHostEvent: forwardToPlugins,
            buildPluginPromptContext: (input) => pluginPromptRegistry.build(input),
            socialAtomStore: services.social.store,
            chatsStore,
            socialContextScheduler: services.social.scheduler,
            getEmbeddingProvider,
            getStickerEmbeddingIndex: () => services.embedding.getStickerEmbeddingIndex(),
            skillRegistry,
            toolRegistry,
            loadUserProfile,
            loadGeneralSettings,
            loadModelSettings,
            llmClient: services.llm,
          }),

        createChannels: (runtime) =>
          createChannelsSubsystem({
            agentRuntime: runtime,
            memory:defaultMemory?.channelHost,
            getReactChatWindow: () => reactChatWindow,
            ipc: shell.ipc,
            publishLifecycle: lifecyclePublisher,
          }),

        startPlugins: async (services, scheduler: SchedulerSubsystem, runtime) => {
          pluginManager = await startPluginRuntime({
            llmClient: services.llm,
            ipc: shell.ipc,
            schedulerStore: scheduler.store,
            agentRuntime: runtime,
            // 插件启停后让调度引擎重新归一化逾期任务并重排计时器（不补跑）
            onPluginRunningStateChange: () => scheduler.engine.refreshPluginTasks(),
            // 面板宿主窗口目前就是设置窗口；settingsWindow 是 CJS 的 live-binding，必须在请求时再读
            getPanelHostWebContents: () => settingsWindow?.webContents ?? null,
            getMarketplaceHostWebContents: () => reactChatWindow?.webContents ?? null,
          });
          return pluginManager;
        },

        createScheduler: (runtime) =>
          createSchedulerSubsystem({
            agentRuntime: runtime,
            memoryHost:defaultMemory?.backgroundHost,
            getReactChatWindow: () => reactChatWindow,
            ipc: shell.ipc,
            publishLifecycle: lifecyclePublisher,
            // 插件任务只有所属插件在运行时才可触发，用户任务不受影响
            canRunTask: (task) => !task.ownerPluginId || (pluginManager?.isRunning(task.ownerPluginId) ?? false),
          }),

        registerCoreIpc: (input) => {
          registerSkillAndInputIpc(input.ipc);
          registerSettingsRelatedIpc(input, shell);
          registerWorkspaceAndRunIpc(input);
        },

        loadGeneralSettings,
        applyGeneralSettings: (settings, services) =>
          applyGeneralSettings(settings, {
            windowManager: shell.windowManager,
            tray: shell.tray,
            screenshotService: services.screenshot,
            proactiveLifecycle: services.proactive,
            broadcastToAuxWindows,
          }),
        // 提醒中心：窗口控制器、生命周期服务和事件总线订阅在此汇合
        wireToastCenter: (input) => wireToasts(input, activation, shutdown),
        revealStartupWindows,
      }),

    startBackground: (core) => startBackground(buildBackgroundDeps(core, readiness, shutdown, defaultMemory)),

    logFatal: (error) => {
      console.error("[Firefly] fatal startup error:", error);
      logger.error(LogTag.Runtime, "fatal startup error:", error);
    },
  };
}
