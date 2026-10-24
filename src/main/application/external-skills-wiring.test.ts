vi.mock("../browser/manual-browser-workspace", () => ({ createManualBrowserWorkspace: vi.fn() }));
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import type { CoreDependencies } from "./core-bootstrap";
import type { ShellDependencies } from "./shell-bootstrap";
import type { ExternalHostSession, ExternalSkillReview } from "../skills/external-types";
const m = vi.hoisted(() => ({ storage: null as any, chat: null as any, core: null as CoreDependencies | null, shell: null as ShellDependencies | null, windowOptions: null as any,
  events: [] as string[], reviews: [] as ExternalSkillReview[], hosts: [] as ExternalHostSession[], resources: new Map<string, { phase: string; dispose: () => Promise<void> | void }>(),
  app: { once: vi.fn(), on: vi.fn(), removeListener: vi.fn(), quit: vi.fn(), commandLine: { hasSwitch: () => false, appendSwitch: vi.fn() }, isPackaged: false,
    requestSingleInstanceLock: vi.fn(() => true), getPath: vi.fn((name: string): string => name === "exe" ? "/tmp/firefly-test/app.exe" : "/tmp/firefly-test"), setPath: vi.fn(), setName: vi.fn(), setAppUserModelId: vi.fn(), setAppLogsPath: vi.fn(), getAppPath: () => "/tmp/firefly-test", getVersion: () => "0.0.0-test" },
}));
vi.mock("electron", () => ({ app: m.app, BrowserWindow: { getAllWindows: () => [] }, dialog: {}, screen: {} }));
vi.mock("electron-updater", () => ({ autoUpdater: {} }));
vi.mock("../storage/storage-context", async load => ({ ...await load<typeof import("../storage/storage-context")>(), getStorageContext: () => m.storage }));
vi.mock("../windows/window-state", () => ({ get reactChatWindow() { return m.chat; }, sidebarWindow: null, settingsWindow: null, setGetCurrentAppIconPath: vi.fn(), getCurrentAppIconPath: () => "", markStartupPhaseReady: vi.fn() }));
vi.mock("../skills/external-reviews", () => ({ EXTERNAL_SKILL_REVIEWS: m.reviews }));
vi.mock("../skills", async load => { const real = await load<typeof import("../skills")>(); return { ...real, initSkills: vi.fn(async (storage, host) => { m.events.push("scan"); m.hosts.push(host); return real.initSkills(storage, host); }) }; });
vi.mock("../storage/external-content-paths", async load => ({ ...await load<typeof import("../storage/external-content-paths")>(), getExternalContentPaths: () => ({ installRoot: path.join(m.storage.profile.isolationRoot, "app"), builtinSkillDirectory: path.join(m.storage.profile.isolationRoot, "builtin"), userSkillDirectories: [path.join(m.storage.dataRoot, "skills")], promptDirectories: [] }) }));
vi.mock("../logging/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, LogTag: { Skills: "skills", Runtime: "runtime" } }));
vi.mock("../skills/skill-tools", () => ({ registerSkillTools: vi.fn() }));
vi.mock("./core-bootstrap", () => ({ startCore: vi.fn(async deps => { m.core = deps; return {} }) }));
vi.mock("./shell-bootstrap", () => ({ startShell: vi.fn(async deps => { m.shell = deps; return {} }) }));
vi.mock("./shutdown", () => ({ createShutdownCoordinator: () => ({ register: (input: any) => m.resources.set(input.id, input), registerEmergencyFlush: vi.fn(), requestControlledShutdown: vi.fn() }) }));
vi.mock("./readiness", () => ({ createStartupReadiness: () => ({ transition: vi.fn() }) }));
vi.mock("./window-activation", () => ({ createWindowActivationBroker: () => ({ request: vi.fn() }) }));
vi.mock("../windows/window-manager", () => ({ createWindowManager: (options: any) => { m.windowOptions = options; return {} } }));
vi.mock("../memory-context/main-default-memory", () => ({ createMainDefaultMemory: () => null }));
vi.mock("../plugin-host/pending-turn-lifecycle", () => ({ createPendingTurnLifecycle: () => ({ disposeAll: vi.fn() }) }));
vi.mock("../browser/browser-host-owner", () => ({ registerBrowserHostOwner: () => ({ dispose: vi.fn() }), registerManualBrowserHostOwner: () => ({ dispose: vi.fn() }) }));
vi.mock("../asr/desktop-asr-ipc", () => ({ registerDesktopAsrIpc: () => ({ dispose: vi.fn() }) }));
vi.mock("../settings/model-settings", () => ({ getDefaultModelProfile: vi.fn(), getCachedSavedModelProfile: vi.fn(), listCachedSavedModelProfileIds: vi.fn(), loadModelSettings: () => ({}), saveModelSettings: vi.fn(), onModelConnectionChanged: () => () => {} }));
vi.mock("../memory-policy/memory-settings-ipc", () => ({ registerMemorySettingsIpc: vi.fn() }));
vi.mock("../browser/browser-workspace-executor", () => ({ createBrowserWorkspaceExecutor: vi.fn() }));
vi.mock("../memory-context/main-desktop-memory", () => ({ createMainDesktopMemory: vi.fn() }));
vi.mock("../memory-context/desktop-memory-backend", () => ({ openDesktopMemoryBackend: vi.fn(), desktopMemoryAdmissionMode: vi.fn() }));
vi.mock("../orchestrator/conversation-transcript-store", () => ({ getConversationTranscriptStore: vi.fn() }));
vi.mock("../orchestrator/harness/run-store", () => ({ getHarnessRunStore: vi.fn() }));
vi.mock("../startup/gpu-sandbox-acl", () => ({ ensureGpuSandboxAcl: vi.fn() }));
vi.mock("../storage/external-content-migration", () => ({ migrateStagedExternalContent: vi.fn() }));
vi.mock("../../shared/banner", () => ({ renderBanner: vi.fn() }));
vi.mock("../startup/env", () => ({ isDev: vi.fn() }));
vi.mock("../settings/settings-facade", () => ({ loadGeneralSettings: () => ({}), saveGeneralSettings: vi.fn(), onGeneralSettingsChanged: vi.fn() }));
vi.mock("../settings/settings-ipc", () => ({ registerSettingsIpc: vi.fn() }));
vi.mock("../settings/general-settings-lifecycle", () => ({ applyGeneralSettings: vi.fn(), handleGeneralSettingsChanged: vi.fn(), syncVolcanoSearchMcp: vi.fn() }));
vi.mock("../rag/document-index-queue", () => ({ configureDocumentIndexQueue: vi.fn() }));
vi.mock("../rag/document-index-worker", () => ({ runDocumentIndexJob: vi.fn() }));
vi.mock("../services/llm/llm-client", () => ({ createLlmClient: vi.fn() }));
vi.mock("../services/embedding/embedding-index-service", () => ({ createEmbeddingIndexService: vi.fn() }));
vi.mock("../rag", () => ({ addL2MemoryVector: vi.fn(), deleteUserMemoryVectors: vi.fn(), flushRAGStore: vi.fn(), flushRAGStoreSync: vi.fn(), getEntriesBySource: vi.fn(), initRAG: vi.fn(), isUserMemoryVectorStoreReady: vi.fn() }));
vi.mock("../rag/embedding", () => ({ getEmbeddingProvider: vi.fn() }));
vi.mock("../orchestrator/tools/registry/tool-registry", () => ({ toolRegistry: vi.fn() }));
vi.mock("../../plugins/prompts", () => ({ pluginPromptRegistry: vi.fn() }));
vi.mock("../orchestrator/tools/built-in-tools", () => ({}));
vi.mock("../orchestrator/tools/registry/tool-registration", () => ({ registerAllTools: vi.fn() }));
vi.mock("../lsp/manager", () => ({ LspManager: vi.fn() }));
vi.mock("../orchestrator/sandbox/sandbox-exec", () => ({ initSandbox: vi.fn() }));
vi.mock("../orchestrator/plan-mode", () => ({ enterPlanDiscussing: vi.fn(), exitPlanMode: vi.fn(), getPlanState: vi.fn(), initPlanPaths: vi.fn(), initPlanStateBroadcaster: vi.fn() }));
vi.mock("../orchestrator/mcp-manager", () => ({ initMcpManager: vi.fn(), pruneMcpServersByIds: vi.fn() }));
vi.mock("../orchestrator/sync-mcp-builtin", () => ({ syncPlaywrightMcp: vi.fn(), REMOVED_BUILTIN_MCP_IDS: vi.fn() }));
vi.mock("../updater/app-update-ipc", () => ({ registerAppUpdateIpc: vi.fn() }));
vi.mock("../updater/github-app-updater", () => ({ createGitHubAppUpdateService: vi.fn(), scheduleStartupUpdateCheck: vi.fn() }));
vi.mock("../windows/window-system-ipc", () => ({ registerWindowSystemIpc: vi.fn() }));
vi.mock("../services/llm/llm-queue", () => ({ enqueueLLMTask: vi.fn() }));
vi.mock("../protocols/bootstrap", () => ({ registerPrivilegedSchemes: vi.fn(), registerProtocolHandlers: vi.fn() }));
vi.mock("../memory/memory-store", () => ({ memoryStore: vi.fn() }));
vi.mock("../memory/memory-rag-reconciliation", () => ({ backupMemoryRagFiles: vi.fn(), reconcileMemoryRag: vi.fn() }));
vi.mock("../chats/chats-ipc", () => ({ registerChatsIpc: vi.fn() }));
vi.mock("../chats/workspace-files-ipc", () => ({ registerWorkspaceFilesIpc: vi.fn() }));
vi.mock("../browser/electron-browser-service", () => ({ createElectronBrowserService: vi.fn() }));
vi.mock("../browser/browser-startup-config", () => ({ createStartupBrowserService: vi.fn() }));
vi.mock("../browser/browser-service-ipc", () => ({ registerBrowserServiceIpc: vi.fn(), registerManualBrowserWorkspaceIpc: vi.fn(), installBrowserServiceLifecycle: vi.fn() }));
vi.mock("../plugin-host/active-chat-target", () => ({ activeChatTargetRegistry: vi.fn() }));
vi.mock("../chats/open-in-app", () => ({ registerOpenInAppIpc: vi.fn() }));
vi.mock("../chats/chat-ui-ipc", () => ({ registerChatUiIpc: vi.fn(), getActiveChatSessionId: vi.fn() }));
vi.mock("../toast/toast-window", () => ({ createToastWindowController: vi.fn() }));
vi.mock("../toast/toast-service", () => ({ createToastService: vi.fn() }));
vi.mock("../toast/toast-events", () => ({ toastEvents: vi.fn() }));
vi.mock("../windows/create-toast-window", () => ({ createToastWindowShell: vi.fn() }));
vi.mock("../storage/token-usage-store", () => ({ flush: vi.fn() }));
vi.mock("../storage/settings-store", () => ({ loadUserProfile: vi.fn() }));
vi.mock("../windows/app-icon", () => ({ getAppIconPath: vi.fn() }));
vi.mock("../chat/agui-bridge", () => ({ hasActiveConversationRun: vi.fn(), isActiveConversationRun: vi.fn(), registerAgUiIpc: vi.fn() }));
vi.mock("../startup/locale-context", () => ({ updateLocaleContext: vi.fn() }));
vi.mock("../scheduler/bootstrap", () => ({ createSchedulerSubsystem: vi.fn() }));
vi.mock("../channels/bootstrap", () => ({ createChannelsSubsystem: vi.fn() }));
vi.mock("../plugin-host/lifecycle-publisher", () => ({ createLifecyclePublisher: vi.fn() }));
vi.mock("../plugin-host/plugin-runtime", () => ({ startPluginRuntime: vi.fn() }));
vi.mock("../orchestrator/agent-runtime", () => ({ createAgentRuntime: vi.fn() }));
vi.mock("../proactive/proactive-lifecycle", () => ({ createProactiveLifecycle: vi.fn() }));
vi.mock("../services/social-context/social-context-service", () => ({ createSocialContextService: vi.fn() }));
vi.mock("../code-git/git-service", () => ({ createGitService: vi.fn() }));
vi.mock("../code-git/git-executable", () => ({ resolveGitExecutable: vi.fn() }));
vi.mock("../code-git/code-git-ipc", () => ({ registerCodeGitIpc: vi.fn() }));
vi.mock("../windows/tray", () => ({ createTray: vi.fn() }));
vi.mock("../memory-online-once/runner", () => ({ ADMISSION_ROOT: vi.fn() }));
vi.mock("../memory-online-once/main-entry", () => ({ createMainProbeEntry: vi.fn() }));
vi.mock("../startup/create-splash-window", () => ({ createSplashWindow: vi.fn() }));
vi.mock("../startup/startup-window-reveal", () => ({ revealStartupWindows: vi.fn() }));
vi.mock("../music/bootstrap", () => ({ bootstrapMusicService: vi.fn() }));
vi.mock("../screenshot/screenshot-lifecycle", () => ({ initializeScreenshotService: vi.fn() }));
vi.mock("../startup/bootstrap-config", () => ({ bootstrapConfigGetters: vi.fn() }));
vi.mock("../permission/bootstrap", () => ({ bootstrapPermission: vi.fn() }));
vi.mock("../orchestrator/pop-quiz", () => ({ registerPopQuizIpc: vi.fn(), registerPopQuizTool: vi.fn() }));
vi.mock("./background", () => ({ startBackground: vi.fn() }));
vi.mock("./electron-lifecycle", () => ({ installUpdateShutdownFallback: vi.fn() }));
vi.mock("../orchestrator/sticker-settings", () => ({ getStickerManagerConfig: vi.fn(), setStickerEnabled: vi.fn() }));
vi.mock("../stickers/sticker-storage", () => ({ addUserSticker: vi.fn(), deleteUserSticker: vi.fn() }));
vi.mock("../memory/panel", () => ({ loadImportedDocumentPanelData: vi.fn(), loadMemoryPanelData: vi.fn() }));
vi.mock("../memory/memory-store", () => ({ memoryStore: vi.fn() }));
vi.mock("../memory/obsidian-exporter", () => ({ exportMemoryToObsidianVault: vi.fn(), syncToBoundVault: vi.fn() }));
vi.mock("../memory/obsidian-vault-config", () => ({ loadObsidianVaultConfig: () => ({}), saveObsidianVaultConfig: vi.fn(), unbindVault: vi.fn() }));
vi.mock("../memory/obsidian-importer", () => ({ startVaultWatcher: vi.fn(), stopVaultWatcher: vi.fn() }));
vi.mock("../chats/chats-store", () => ({ getSession: vi.fn(), listSessions: () => [] }));
vi.mock("../orchestrator/tools/registry/tool-registry", () => ({ toolRegistry: { getAll: () => [], register: vi.fn() } }));
import { createDefaultApplicationDependencies } from "./default-dependencies";
import { IPC } from "../../shared/ipc-channels";
import { isolatedStorageContext, createExternalFixture } from "../skills/testing/external-fixtures";
import { applyElectronPaths } from "../startup/runtime-profile";
import * as skills from "../skills";
import * as install from "../skills/external-install";
import * as serviceModule from "../skills/external-service";
import { ExternalSkillStateStore } from "../skills/external-state";
import { externalSkillId, EXTERNAL_SOURCES } from "../skills/external-policy";
import { digestExternalFiles } from "../skills/external-review";
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const run of cleanup.splice(0).reverse()) await run(); m.resources.clear(); m.events.length = 0; m.hosts.length = 0; m.reviews.length = 0; m.chat = null; m.app.requestSingleInstanceLock.mockReturnValue(true); });
function contents(id = 1) { return Object.assign(new EventEmitter(), { id, mainFrame: { processId: 10 + id, routingId: 20 + id, detached: false }, isDestroyed: () => false, send: vi.fn() }); }
function value(result: any): any { expect(result.ok, JSON.stringify(result)).toBe(true); return result.value; }
function fixture() {
  const f = isolatedStorageContext(); cleanup.push(() => { f.dispose(); fs.rmSync(f.productionSentinelRoot, { recursive: true, force: true }); }); m.storage = f.storage;
  const example = createExternalFixture(), prefix = example.review.path, commit = example.review.commit, treeSha = "b".repeat(40), repository = EXTERNAL_SOURCES.openai.repository;
  const sha = (bytes: Buffer) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  const payload = new Map(Object.entries(example.expectedFiles).map(([relative, text]) => [prefix + "/" + relative, Buffer.from(text)]));
  const files = [...payload].map(([path, bytes]) => ({ path, bytes: bytes.length, blobSha1: sha(bytes), sha256: createHash("sha256").update(bytes).digest("hex") }));
  m.reviews.push({ ...example.review, contentSha256: digestExternalFiles(files), licenses: [{ path: prefix + "/LICENSE", sha256: files.find(file => file.path.endsWith("/LICENSE"))!.sha256, spdx: "MIT", covers: files.map(file => file.path) }] });
  const meta = new Map([[EXTERNAL_SOURCES.openai.catalogPath, Buffer.from(JSON.stringify({ plugins: [{ name: "synthetic", source: { source: "local", path: "./plugins/synthetic" } }] }))], ["plugins/synthetic/.codex-plugin/plugin.json", Buffer.from(JSON.stringify({ name: "synthetic", skills: "./skills", license: "MIT" }))]]);
  const blobs = new Map([...meta, ...payload].map(([, bytes]) => [sha(bytes), bytes]));
  const tree = [...meta, ...payload].map(([path, bytes]) => ({ path, type: "blob", mode: "100644", sha: sha(bytes), size: bytes.length }));
  const base = "https://api.github.com/repos/" + repository; let hook: typeof globalThis.fetch | undefined;
  const route: typeof globalThis.fetch = async input => { const url = String(input); if (url === base) return Response.json({ default_branch: "main" }); if (url === base + "/commits/main") return Response.json({ sha: commit }); if (url === base + "/git/commits/" + commit) return Response.json({ sha: commit, tree: { sha: treeSha } }); if (url === base + "/git/trees/" + treeSha + "?recursive=1") return Response.json({ sha: treeSha, tree, truncated: false }); const bytes = blobs.get(url.slice((base + "/git/blobs/").length)); if (url.startsWith(base + "/git/blobs/") && bytes) return Response.json({ sha: sha(bytes), size: bytes.length, encoding: "base64", content: bytes.toString("base64") }); return Response.json({}, { status: 404 }); };
  vi.stubGlobal("fetch", vi.fn((input, init) => (hook ?? route)(input, init)));
  return { ...f, id: externalSkillId("openai", repository, prefix), payload, route, setHook: (next: typeof globalThis.fetch) => { hook = next; } };
}
async function wiring(primary = true, prepare = true) {
  const f = fixture(); m.events.push("profile-paths"); m.app.getPath.mockImplementation((name: string) => name === "exe" ? path.join(f.root, "app.exe") : f.storage.profile[name as "userData"]); applyElectronPaths(m.app as any, f.storage.profile);
  m.app.requestSingleInstanceLock.mockImplementation(() => { m.events.push("single-instance"); return primary; });
  const recovery = install.recoverExternalSkills; vi.spyOn(install, "recoverExternalSkills").mockImplementation((storage, state) => { m.events.push("recovery"); recovery(storage, state); });
  const create = serviceModule.createExternalSkillService; let serviceDeps!: Parameters<typeof create>[0]; let service!: ReturnType<typeof create>;
  vi.spyOn(serviceModule, "createExternalSkillService").mockImplementation(deps => { serviceDeps = deps; service = create(deps); cleanup.push(() => service.dispose()); return service; });
  const deps = createDefaultApplicationDependencies(); if (prepare) deps.prepare(); await deps.startShell(); m.shell!.createWindowManager();
  const handlers = new Map<string, any>(), ipc = { handle: (channel: string, handler: any) => handlers.set(channel, handler), on: vi.fn(), removeHandler: vi.fn(), dispose: vi.fn() };
  const chat = contents(); m.chat = { webContents: chat, isDestroyed: () => false }; await deps.startCore({ ipc, windowManager: {}, tray: {} } as any);
  return { ...f, deps, handlers, ipc, chat, service: () => service, serviceDeps: () => serviceDeps, event: () => ({ sender: m.chat.webContents, senderFrame: m.chat.webContents.mainFrame }), invoke: async (channel: string, payload: any) => handlers.get(channel)({ sender: m.chat.webContents, senderFrame: m.chat.webContents.mainFrame }, payload) };
}
function register(f: Awaited<ReturnType<typeof wiring>>) { m.core!.registerCoreIpc({ ipc: f.ipc, runtime: { buildOptions: vi.fn(), onRunFinished: vi.fn() }, services: { screenshot: {}, proactive: {}, embedding: {}, update: {} } } as any); }
it("actual_application_wiring injects initialized profile and same guarded Main host through recovery scan and service", async () => {
  const f = await wiring(); await m.core!.initSkills(); register(f);
  expect([IPC.EXTERNAL_SKILLS_LIST, IPC.EXTERNAL_SKILLS_DETAIL, IPC.EXTERNAL_SKILLS_PREPARE, IPC.EXTERNAL_SKILLS_COMMIT, IPC.EXTERNAL_SKILLS_CANCEL].every(channel => f.handlers.has(channel)), "Actual default-dependencies registerCoreIpc must register external-Skills handlers").toBe(true);
  expect(m.events).toEqual(["profile-paths", "single-instance", "recovery", "scan"]); expect(f.serviceDeps().storage).toBe(f.storage); expect(f.serviceDeps().host).toBe(m.hosts[0]); expect(f.serviceDeps().host.isPrimaryProcess()).toBe(true); expect(f.serviceDeps().host.runId).toMatch(/^[a-f0-9-]{36}$/);
  const prepared = value(await f.invoke(IPC.EXTERNAL_SKILLS_PREPARE, { sourceId: "openai", id: f.id })); expect(value(await f.invoke(IPC.EXTERNAL_SKILLS_COMMIT, { token: prepared.token }))).toMatchObject({ id: f.id, enabled: false });
  expect(skills.listSkillsForUi()).toContainEqual(expect.objectContaining({ id: f.id, enabled: false })); expect(skills.skillRegistry.getBody(f.id)).toBeNull();
  await skills.initSkills(f.storage, f.serviceDeps().host); expect(skills.skillRegistry.getById(f.id)?.enabled).toBe(false); expect(skills.skillRegistry.getBody(f.id)).toBeNull();
  f.chat.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
  expect(await f.invoke(IPC.SKILL_SET_ENABLED, { id: f.id, enabled: true })).toMatchObject({ ok: false });
  expect(new ExternalSkillStateStore(f.storage).read(f.id)?.enabled).toBe(false); f.chat.emit("did-navigate", {}, "file://test");
  expect(await f.invoke(IPC.SKILL_SET_ENABLED, { id: f.id, enabled: true })).toEqual({ ok: true }); expect(skills.skillRegistry.getBody(f.id)).toContain("Synthetic text");
  const restart = serviceModule.createExternalSkillService(f.serviceDeps()); cleanup.push(() => restart.dispose()); expect(new ExternalSkillStateStore(f.storage, f.serviceDeps().host).read(f.id)?.enabled).toBe(true);
  await skills.initSkills(f.storage, f.serviceDeps().host); expect(skills.skillRegistry.getById(f.id)?.enabled).toBe(true); expect(skills.skillRegistry.getBody(f.id)).toContain("Synthetic text");
  const replacement = contents(2); m.chat = { webContents: replacement, isDestroyed: () => false }; m.windowOptions.onChatWindowCreated(Object.assign(new EventEmitter(), m.chat)); value(await f.invoke(IPC.EXTERNAL_SKILLS_LIST, { sourceId: "openai" }));
  expect(await f.handlers.get(IPC.EXTERNAL_SKILLS_LIST)({ sender: f.chat, senderFrame: f.chat.mainFrame }, { sourceId: "openai" })).toMatchObject({ code: "FORBIDDEN" });
  expect(m.resources.get("external-skills")?.phase).toBe("quiesce"); await m.resources.get("external-skills")!.dispose(); expect(replacement.eventNames()).toEqual([]); expect(fs.readdirSync(f.productionSentinelRoot)).toEqual([]);
});
it.each(["secondary", "no-guard"])("actual_application_wiring %s performs no recovery scan or writable service", async mode => {
  const f = await wiring(false, mode !== "no-guard"); await expect(m.core!.initSkills()).rejects.toThrow(); expect(m.events).not.toContain("recovery"); expect(m.events).not.toContain("scan"); register(f); expect(f.serviceDeps().host.isPrimaryProcess()).toBe(false);
  expect(await f.invoke(IPC.EXTERNAL_SKILLS_PREPARE, { sourceId: "openai", id: f.id })).toMatchObject({ ok: false, code: "STATE_INVALID" }); expect(globalThis.fetch).not.toHaveBeenCalled();
});
it("lifecycle_invalidation real IPC refresh aborts old approval and replacement aborts pre-token download immediately", async () => {
  const f = await wiring(); await m.core!.initSkills(); register(f); const prepared = value(await f.invoke(IPC.EXTERNAL_SKILLS_PREPARE, { sourceId: "openai", id: f.id })); value(await f.invoke(IPC.EXTERNAL_SKILLS_LIST, { sourceId: "openai", refresh: true })); expect(await f.invoke(IPC.EXTERNAL_SKILLS_COMMIT, { token: prepared.token })).toMatchObject({ code: "STALE_SNAPSHOT" });
  // Recreate service to clear its bounded immutable cache, then block one fixture request.
  await m.resources.get("external-skills")!.dispose(); register(f); let entered = false, aborted = false;
  f.setHook(async (_input, init) => { entered = true; return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener("abort", () => { aborted = true; reject(Error("fixture cancelled")); }, { once: true })); });
  const pending = f.invoke(IPC.EXTERNAL_SKILLS_PREPARE, { sourceId: "openai", id: f.id }); for (let i = 0; i < 50 && !entered; i++) await new Promise(resolve => setImmediate(resolve)); expect(entered).toBe(true);
  const replacement = contents(2); m.chat = { webContents: replacement, isDestroyed: () => false }; m.windowOptions.onChatWindowCreated(Object.assign(new EventEmitter(), m.chat)); expect(await pending).toMatchObject({ code: "STALE_SNAPSHOT" });
  // Owner invalidation cancels its operation; service teardown also aborts snapshot transport.
  await m.resources.get("external-skills")!.dispose(); expect(aborted).toBe(true); expect(f.chat.eventNames()).toEqual([]);
});

it("actual_application_wiring shutdown quiesce waits for the real committing transaction terminal", async () => {
  const f = await wiring(); await m.core!.initSkills(); register(f); const prepared = value(await f.invoke(IPC.EXTERNAL_SKILLS_PREPARE, { sourceId: "openai", id: f.id }));
  const commit = install.commitExternalSkill; let release!: () => void;
  vi.spyOn(install, "commitExternalSkill").mockImplementation(async input => { await new Promise<void>(resolve => { release = resolve; }); return commit(input); });
  const committing = f.invoke(IPC.EXTERNAL_SKILLS_COMMIT, { token: prepared.token });
  expect(value(await f.invoke(IPC.EXTERNAL_SKILLS_CANCEL, {}))).toEqual({ status: "committing" });
  let completed = false; const disposal = Promise.resolve(m.resources.get("external-skills")!.dispose()).then(() => { completed = true; }); await new Promise(resolve => setImmediate(resolve)); expect(completed).toBe(false);
  release(); expect(value(await committing)).toMatchObject({ id: f.id, enabled: false }); await disposal;
  expect(new ExternalSkillStateStore(f.storage).read(f.id)?.enabled).toBe(false); expect(f.chat.eventNames()).toEqual([]); expect(await f.invoke(IPC.EXTERNAL_SKILLS_LIST, { sourceId: "openai" })).toMatchObject({ code: "FORBIDDEN" });
});
it("actual_application_wiring startup recovers a prior-run residual lock before the real scan while preserving disabled bytes", async () => {
  const f = await wiring(); register(f); const detail = value(await f.invoke(IPC.EXTERNAL_SKILLS_PREPARE, { sourceId: "openai", id: f.id })).skill;
  value(await f.invoke(IPC.EXTERNAL_SKILLS_CANCEL, {}));
  // Match Main publication: read-only declaration hints are not persisted fields.
  const { declaration: _declaration, preview: _preview, selection: _selection, revisions: _revisions,
    compatibilityFormat: _format, dependencyIssues: _issues, ...persistedSkill } = detail;
  const record = { schema: 1 as const, id: f.id, transactionId: randomUUID(), status: "prepared" as const, enabled: false, skill: persistedSkill, contentSha256: digestExternalFiles(detail.files) };
  const previous = new ExternalSkillStateStore(f.storage, { runId: randomUUID(), isPrimaryProcess: () => true });
  const stage = install.stageExternalSkill(f.storage, record, f.payload), stateFile = path.join(f.storage.stateRoot, "external-skills", f.id + ".json");
  const unlink = fs.unlinkSync; const failure = vi.spyOn(fs, "unlinkSync").mockImplementation(file => { if (String(file) === stateFile + ".lock") throw Error("fixture interruption"); return unlink(file); });
  await expect(install.commitExternalSkill({ storage: f.storage, stageRoot: stage.stageRoot, record, state: previous })).rejects.toMatchObject({ code: "ROLLBACK_FAILED" }); failure.mockRestore();
  expect(fs.existsSync(stateFile + ".lock")).toBe(true); const stateBytes = fs.readFileSync(stateFile), contentFile = path.join(f.storage.dataRoot, "skills", f.id, "content", "SKILL.md"), contentBytes = fs.readFileSync(contentFile);
  await m.core!.initSkills(); expect(m.events).toEqual(["profile-paths", "single-instance", "recovery", "scan"]); expect(fs.existsSync(stateFile + ".lock")).toBe(false);
  expect(fs.readFileSync(stateFile)).toEqual(stateBytes); expect(fs.readFileSync(contentFile)).toEqual(contentBytes); expect(skills.skillRegistry.getById(f.id)?.enabled).toBe(false); expect(skills.skillRegistry.getBody(f.id)).toBeNull();
  expect(f.serviceDeps().host).toBe(m.hosts[0]); expect(new ExternalSkillStateStore(f.storage, f.serviceDeps().host).read(f.id)?.status).toBe("committed");
});
it("lifecycle_invalidation closed workbench releases its ready preparation before any next request", async () => {
  const f = await wiring(); await m.core!.initSkills(); register(f); const window = Object.assign(new EventEmitter(), m.chat); m.windowOptions.onChatWindowCreated(window);
  value(await f.invoke(IPC.EXTERNAL_SKILLS_PREPARE, { sourceId: "openai", id: f.id })); const stages = path.join(f.storage.cacheRoot, "external-skills"); expect(fs.readdirSync(stages)).toHaveLength(1);
  m.chat = null; window.emit("closed"); expect(fs.readdirSync(stages)).toEqual([]); expect(f.chat.eventNames()).toEqual([]);
});
