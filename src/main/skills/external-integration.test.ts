vi.mock("../browser/manual-browser-workspace", () => ({ createManualBrowserWorkspace: vi.fn() }));
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import childProcess from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import type { CoreDependencies } from "../application/core-bootstrap";
import type { ShellDependencies } from "../application/shell-bootstrap";
import type { ExternalHostSession, ExternalSkillReview } from "./external-types";
const m = vi.hoisted(() => ({ exposed: new Map<string, any>(), handlers: new Map<string, any>(), event: null as any,
  dangerous: { installerPrepare: vi.fn(), installerCommit: vi.fn(), pluginInstall: vi.fn(), mcpAdd: vi.fn(), connectorCreate: vi.fn(), channelRegister: vi.fn(), permissionSet: vi.fn(), browserGrant: vi.fn() },
  invoke: vi.fn(async (channel: string, payload: unknown): Promise<any> => { const handler = m.handlers.get(channel); if (!handler) throw Error("UNREGISTERED_TEST_IPC:" + channel); return handler(m.event, payload); }),
  storage: null as any, chat: null as any, core: null as CoreDependencies | null, shell: null as ShellDependencies | null, windowOptions: null as any,
  events: [] as string[], reviews: [] as ExternalSkillReview[], hosts: [] as ExternalHostSession[], resources: new Map<string, { phase: string; dispose: () => Promise<void> | void }>(),
  app: { once: vi.fn(), on: vi.fn(), removeListener: vi.fn(), quit: vi.fn(), commandLine: { hasSwitch: () => false, appendSwitch: vi.fn() }, isPackaged: false,
    requestSingleInstanceLock: vi.fn(() => true), getPath: vi.fn((name: string): string => name === "exe" ? "/tmp/firefly-test/app.exe" : "/tmp/firefly-test"), setPath: vi.fn(), setName: vi.fn(), setAppUserModelId: vi.fn(), setAppLogsPath: vi.fn(), getAppPath: () => "/tmp/firefly-test", getVersion: () => "0.0.0-test" },
}));
vi.mock("electron", () => ({ app: m.app, BrowserWindow: { getAllWindows: () => [] }, dialog: {}, screen: {},
  contextBridge: { exposeInMainWorld: (name: string, value: any) => m.exposed.set(name, value) },
  ipcRenderer: { invoke: m.invoke, on: vi.fn(), off: vi.fn(), removeListener: vi.fn(), send: vi.fn() }, webUtils: { getPathForFile: vi.fn() } }));
vi.mock("../../preload/music", () => ({ exposeMusicApi: vi.fn() }));
vi.mock("../../plugins/installer", () => ({ preparePluginZip: m.dangerous.installerPrepare, commitPreparedPlugin: m.dangerous.installerCommit }));
vi.mock("../../plugins/manager", () => ({ PluginManager: class { installZip = m.dangerous.pluginInstall; } }));
vi.mock("../permission", () => ({ setCurrentLevel: m.dangerous.permissionSet }));
vi.mock("../browser/browser-authorization-domain", () => ({ createBrowserAuthorizationDomainRegistry: m.dangerous.browserGrant }));
vi.mock("../channels/manager", () => ({ channelManager: { register: m.dangerous.channelRegister } }));
vi.mock("electron-updater", () => ({ autoUpdater: {} }));
vi.mock("../storage-context", async load => ({ ...await load<typeof import("../storage-context")>(), getStorageContext: () => m.storage }));
vi.mock("../windows/window-state", () => ({ get reactChatWindow() { return m.chat; }, sidebarWindow: null, settingsWindow: null, setGetCurrentAppIconPath: vi.fn(), getCurrentAppIconPath: () => "", markStartupPhaseReady: vi.fn() }));
vi.mock("../skills/external-reviews", () => ({ EXTERNAL_SKILL_REVIEWS: m.reviews }));
vi.mock("../skills", async load => { const real = await load<typeof import("../skills")>(); return { ...real, initSkills: vi.fn(async (storage, host) => { m.events.push("scan"); m.hosts.push(host); return real.initSkills(storage, host); }) }; });
vi.mock("../external-content-paths", async load => ({ ...await load<typeof import("../external-content-paths")>(), getExternalContentPaths: () => ({ installRoot: path.join(m.storage.profile.isolationRoot, "app"), builtinSkillDirectory: path.join(m.storage.profile.isolationRoot, "builtin"), userSkillDirectories: [path.join(m.storage.dataRoot, "skills")], promptDirectories: [] }) }));
vi.mock("../logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, LogTag: { Skills: "skills", Runtime: "runtime" } }));
vi.mock("../skills/skill-tools", () => ({ registerSkillTools: vi.fn() }));
vi.mock("../application/core-bootstrap", () => ({ startCore: vi.fn(async deps => { m.core = deps; return {} }) }));
vi.mock("../application/shell-bootstrap", () => ({ startShell: vi.fn(async deps => { m.shell = deps; return {} }) }));
vi.mock("../application/shutdown", () => ({ createShutdownCoordinator: () => ({ register: (input: any) => m.resources.set(input.id, input), registerEmergencyFlush: vi.fn(), requestControlledShutdown: vi.fn() }) }));
vi.mock("../application/readiness", () => ({ createStartupReadiness: () => ({ transition: vi.fn() }) }));
vi.mock("../application/window-activation", () => ({ createWindowActivationBroker: () => ({ request: vi.fn() }) }));
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
vi.mock("../gpu-sandbox-acl", () => ({ ensureGpuSandboxAcl: vi.fn() }));
vi.mock("../external-content-migration", () => ({ migrateStagedExternalContent: vi.fn() }));
vi.mock("../../shared/banner", () => ({ renderBanner: vi.fn() }));
vi.mock("../env", () => ({ isDev: vi.fn() }));
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
vi.mock("../orchestrator/mcp-manager", () => ({ initMcpManager: vi.fn(), pruneMcpServersByIds: vi.fn(), addMcpServer: m.dangerous.mcpAdd, removeMcpServer: vi.fn(), listMcpServers: vi.fn() }));
vi.mock("../sync-mcp-builtin", () => ({ syncPlaywrightMcp: vi.fn(), REMOVED_BUILTIN_MCP_IDS: vi.fn() }));
vi.mock("../updater/app-update-ipc", () => ({ registerAppUpdateIpc: vi.fn() }));
vi.mock("../updater/github-app-updater", () => ({ createGitHubAppUpdateService: vi.fn(), scheduleStartupUpdateCheck: vi.fn() }));
vi.mock("../windows/window-system-ipc", () => ({ registerWindowSystemIpc: vi.fn() }));
vi.mock("../llm-queue", () => ({ enqueueLLMTask: vi.fn() }));
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
vi.mock("../token-usage-store", () => ({ flush: vi.fn() }));
vi.mock("../settings-store", () => ({ loadUserProfile: vi.fn() }));
vi.mock("../windows/app-icon", () => ({ getAppIconPath: vi.fn() }));
vi.mock("../agui-bridge", () => ({ hasActiveConversationRun: vi.fn(), isActiveConversationRun: vi.fn(), registerAgUiIpc: vi.fn() }));
vi.mock("../locale-context", () => ({ updateLocaleContext: vi.fn() }));
vi.mock("../scheduler/bootstrap", () => ({ createSchedulerSubsystem: vi.fn() }));
vi.mock("../channels/bootstrap", () => ({ createChannelsSubsystem: m.dangerous.connectorCreate }));
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
vi.mock("../application/background", () => ({ startBackground: vi.fn() }));
vi.mock("../application/electron-lifecycle", () => ({ installUpdateShutdownFallback: vi.fn() }));
vi.mock("../orchestrator/sticker-settings", () => ({ getStickerManagerConfig: vi.fn(), setStickerEnabled: vi.fn() }));
vi.mock("../stickers/sticker-storage", () => ({ addUserSticker: vi.fn(), deleteUserSticker: vi.fn() }));
vi.mock("../memory/panel", () => ({ loadImportedDocumentPanelData: vi.fn(), loadMemoryPanelData: vi.fn() }));
vi.mock("../memory/memory-store", () => ({ memoryStore: vi.fn() }));
vi.mock("../memory/obsidian-exporter", () => ({ exportMemoryToObsidianVault: vi.fn(), syncToBoundVault: vi.fn() }));
vi.mock("../memory/obsidian-vault-config", () => ({ loadObsidianVaultConfig: () => ({}), saveObsidianVaultConfig: vi.fn(), unbindVault: vi.fn() }));
vi.mock("../memory/obsidian-importer", () => ({ startVaultWatcher: vi.fn(), stopVaultWatcher: vi.fn() }));
vi.mock("../chats/chats-store", () => ({ getSession: vi.fn(), listSessions: () => [] }));
vi.mock("../orchestrator/tools/registry/tool-registry", () => ({ toolRegistry: { getAll: () => [], register: vi.fn() } }));
import { createDefaultApplicationDependencies } from "../application/default-dependencies";
import { IPC } from "../../shared/ipc-channels";
import type { ExternalResult, ExternalSkillSourceId } from "../../shared/external-skills";
import type { SettingsApi } from "../../renderer/settings/shared/types";
import { isolatedStorageContext, createExternalFixture } from "./testing/external-fixtures";
import { applyElectronPaths, within } from "../runtime-profile";
import { createStorageContext } from "../storage-context";
import * as skills from "./index";
import { AtomicJsonStore } from "../atomic-json-store";
import { ExternalSkillStateStore } from "./external-state";
import { externalSkillId, EXTERNAL_SOURCES } from "./external-policy";
import { digestExternalFiles } from "./external-review";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  // Dispose the real service before removing its injected test root.
  try { await m.resources.get("external-skills")?.dispose(); }
  finally { vi.restoreAllMocks(); vi.unstubAllGlobals(); }
  for (const run of cleanup.splice(0).reverse()) await run();
  for (const skill of skills.skillRegistry.getAll()) skills.skillRegistry.unregister(skill.id);
  m.resources.clear(); m.handlers.clear(); m.events.length = 0; m.hosts.length = 0; m.reviews.length = 0; m.chat = null; m.event = null; vi.clearAllMocks();
});
function value<T>(result: ExternalResult<T>): T {
  expect(result.ok, result.ok ? undefined : result.code).toBe(true);
  if (!result.ok) throw Error(result.code); return result.value;
}
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const gitHash = (bytes: Buffer) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
function contents(id = 1) { return Object.assign(new EventEmitter(), { id, mainFrame: { processId: 10 + id, routingId: 20 + id, detached: false }, isDestroyed: () => false, send: vi.fn() }); }
async function until(check: () => boolean) { for (let i = 0; i < 100 && !check(); i++) await new Promise<void>(resolve => setImmediate(resolve)); expect(check()).toBe(true); }
function treeSnapshot(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  function visit(directory: string) { for (const name of fs.readdirSync(directory)) { const file = path.join(directory, name), stat = fs.lstatSync(file); if (stat.isDirectory()) visit(file); else result[path.relative(root, file)] = stat.isSymbolicLink() ? "SYMLINK:" + fs.readlinkSync(file) : sha256(fs.readFileSync(file)); } }
  visit(root); return result;
}
function mutationAudit(root: string) {
  const paths: string[] = [], descriptors = new Map<number, string>();
  const owned = (location: unknown) => {
    const target = typeof location === "number" ? descriptors.get(location) : location instanceof URL ? location.pathname : String(location);
    expect(target, "Every mutated descriptor must come from an audited open").toBeDefined();
    expect(within(root, target!), "Mutation attempted outside injected test isolation").toBe(true); paths.push(target!);
  };
  for (const name of ["mkdirSync", "writeFileSync", "unlinkSync", "rmdirSync", "rmSync", "chmodSync", "truncateSync"] as const) {
    const original = fs[name] as (...args: any[]) => any;
    vi.spyOn(fs, name).mockImplementation(((...args: any[]) => { owned(args[0]); return original(...args); }) as any);
  }
  for (const name of ["renameSync", "copyFileSync", "cpSync", "linkSync", "symlinkSync"] as const) {
    const original = fs[name] as (...args: any[]) => any;
    vi.spyOn(fs, name).mockImplementation(((...args: any[]) => { owned(args[0]); owned(args[1]); return original(...args); }) as any);
  }
  const open = fs.openSync;
  vi.spyOn(fs, "openSync").mockImplementation(((location: any, flags: any, mode: any) => {
    if (typeof flags === "string" ? /[wa+]/.test(flags) : !!(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC))) owned(location);
    const fd = open(location, flags, mode); descriptors.set(fd, String(location)); return fd;
  }) as typeof fs.openSync);
  return paths;
}
function dangerousSpies() {
  const spies = Object.values(m.dangerous);
  for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"] as const) {
    spies.push(vi.spyOn(childProcess, name).mockImplementation((() => { throw Error("DANGEROUS_EXECUTION_DENIED"); }) as any) as any);
  }
  return () => { for (const spy of spies) expect(spy).not.toHaveBeenCalled(); };
}

async function fixture(sourceId: ExternalSkillSourceId = "anthropic", options: { extra?: Record<string, string>; review?: boolean; externalOrigin?: "url" | "git-subdir" } = {}) {
  const isolated = isolatedStorageContext(); cleanup.push(() => { isolated.dispose(); fs.rmSync(isolated.productionSentinelRoot, { recursive: true, force: true }); }); m.storage = isolated.storage;
  const sentinel = path.join(isolated.productionSentinelRoot, "keep.txt"); fs.writeFileSync(sentinel, "synthetic production sentinel"); const sentinelBefore = treeSnapshot(isolated.productionSentinelRoot);
  // Ordinary Skill regression remains fully synthetic; no bundled/vendor directory is scanned.
  const ordinary = path.join(isolated.root, "builtin", "ordinary"); fs.mkdirSync(ordinary, { recursive: true }); fs.writeFileSync(path.join(ordinary, "SKILL.md"), "---\nname: ordinary\ndescription: Synthetic ordinary.\n---\nordinary instructions\n");
  const example = createExternalFixture(), prefix = sourceId === "openai" ? example.review.path : "skills/synthetic-text", source = EXTERNAL_SOURCES[sourceId], commit = "a".repeat(40), treeSha = "b".repeat(40);
  const payload = new Map(Object.entries({ ...example.expectedFiles, ...options.extra }).map(([relative, text]) => [prefix + "/" + relative, Buffer.from(text)]));
  const files = [...payload].map(([path, bytes]) => ({ path, bytes: bytes.length, blobSha1: gitHash(bytes), sha256: sha256(bytes) }));
  if (options.review !== false) m.reviews.push({ ...example.review, sourceId, path: prefix, contentSha256: digestExternalFiles(files), licenses: [{ path: prefix + "/LICENSE", sha256: sha256(payload.get(prefix + "/LICENSE")!), spdx: "MIT", covers: files.map(file => file.path) }] });
  const catalog = sourceId === "openai" ? { plugins: [{ name: "synthetic", source: { source: "local", path: "./plugins/synthetic" } }, ...(options.externalOrigin ? [{ name: "foreign", source: { source: options.externalOrigin, url: "https://example.invalid/foreign/repository", ...(options.externalOrigin === "git-subdir" ? { path: "nested" } : {}) } }] : [])] }
    : { plugins: [{ name: "synthetic", source: "./", skills: ["./" + prefix], license: "MIT", version: "bundle-9" }] };
  const meta = new Map<string, Buffer>([[source.catalogPath, Buffer.from(JSON.stringify(catalog))]]);
  if (sourceId === "openai") meta.set("plugins/synthetic/.codex-plugin/plugin.json", Buffer.from(JSON.stringify({ name: "synthetic", skills: "./skills", license: "MIT", version: "bundle-9" })));
  const blobs = new Map([...meta, ...payload].map(([, bytes]) => [gitHash(bytes), bytes]));
  const tree = [...meta, ...payload].map(([path, bytes]) => ({ path, type: "blob", mode: "100644", sha: gitHash(bytes), size: bytes.length }));
  const base = "https://api.github.com/repos/" + source.repository;
  const route: typeof globalThis.fetch = async input => {
    const url = String(input);
    if (url === base) return Response.json({ default_branch: "main" });
    if (url === base + "/commits/main") return Response.json({ sha: commit });
    if (url === base + "/git/commits/" + commit) return Response.json({ sha: commit, tree: { sha: treeSha } });
    if (url === base + "/git/trees/" + treeSha + "?recursive=1") return Response.json({ sha: treeSha, tree, truncated: false });
    const bytes = blobs.get(url.slice((base + "/git/blobs/").length));
    if (url.startsWith(base + "/git/blobs/") && bytes) return Response.json({ sha: gitHash(bytes), size: bytes.length, encoding: "base64", content: bytes.toString("base64") });
    throw Error("UNEXPECTED_SYNTHETIC_ROUTE");
  };
  let hook: typeof globalThis.fetch | undefined;
  const transport = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => { const url = String(input); expect(url.startsWith(base)).toBe(true); expect(init?.credentials).toBe("omit"); expect(init?.redirect).toBe("manual"); expect(new Headers(init?.headers).has("authorization")).toBe(false); expect(new Headers(init?.headers).has("cookie")).toBe(false); return (hook ?? route)(input, init); });
  // Real default-dependencies composition uses Main's global fetch; this is a local mock only.
  vi.stubGlobal("fetch", transport);
  m.app.getPath.mockImplementation((name: string) => name === "exe" ? path.join(isolated.root, "app.exe") : isolated.storage.profile[name as "userData"]);
  applyElectronPaths(m.app as any, isolated.storage.profile);
  const deps = createDefaultApplicationDependencies(); deps.prepare(); await deps.startShell(); m.shell!.createWindowManager();
  const chat = contents(); m.chat = { webContents: chat, isDestroyed: () => false }; m.event = { sender: chat, senderFrame: chat.mainFrame };
  const ipc = { handle: (channel: string, handler: any) => m.handlers.set(channel, handler), on: vi.fn(), removeHandler: vi.fn(), dispose: vi.fn() };
  await deps.startCore({ ipc, windowManager: {}, tray: {} } as any); await m.core!.initSkills();
  m.core!.registerCoreIpc({ ipc, runtime: { buildOptions: vi.fn(), onRunFinished: vi.fn() }, services: { screenshot: {}, proactive: {}, embedding: {}, update: {} } } as any);
  await import("../../preload/index"); const settings = m.exposed.get("settings") as SettingsApi; expect(settings.externalSkills).toBeDefined();
  const api = settings.externalSkills!;
  const paths = mutationAudit(isolated.root);
  const id = externalSkillId(sourceId, source.repository, prefix), formal = path.join(isolated.storage.dataRoot, "skills", id), stateFile = path.join(isolated.storage.stateRoot, "external-skills", id + ".json");
  return { ...isolated, id, sourceId, api, settings, chat, files, prefix, payload, tree, formal, stateFile, transport, route, paths, deps,
    stages: () => { const root = path.join(isolated.storage.cacheRoot, "external-skills"); return fs.existsSync(root) ? fs.readdirSync(root) : []; },
    setHook: (next: typeof globalThis.fetch) => { hook = next; },
    preserved: () => { expect(treeSnapshot(isolated.productionSentinelRoot)).toEqual(sentinelBefore); expect(paths.every(file => within(isolated.root, file))).toBe(true); },
  };
}

it.each(["openai", "anthropic"] as const)("no_execution_or_permission_expansion: end_to_end_isolated %s bridge through real Main assembly/fs/registry stays disabled until explicit enable and persists restart", async sourceId => {
  const f = await fixture(sourceId); const checkDangerous = dangerousSpies();
  // Real Main uses the injected global mock transport; unknown routes throw locally.
  // No synthetic response ever falls through to the network.
  const listed = value(await f.api.list(sourceId)); expect(listed.map(skill => skill.id)).toEqual([f.id]);
  const detail = value(await f.api.detail(sourceId, f.id)); expect(detail.review).toBe("unreviewed"); expect(detail.files).toEqual([]); expect(detail.preview?.complete).toBe(false); expect(detail.version).toBeUndefined(); expect(detail.bundle.version).toBe("bundle-9");
  const ready = value(await f.api.prepare(sourceId, f.id)); expect(ready.skill.files).toEqual(f.files); expect(ready.skill.review).toBe("approved"); expect(ready.skill).not.toHaveProperty("preview"); expect(f.stages()).toHaveLength(1);
  expect(value(await f.api.commit(ready.token))).toEqual({ id: f.id, enabled: false, contentSha256: ready.contentSha256 }); expect(f.stages()).toEqual([]);
  for (const [file, bytes] of f.payload) expect(fs.readFileSync(path.join(f.formal, "content", file.slice(f.prefix.length + 1)))).toEqual(bytes);
  expect(skills.listSkillsForUi()).toContainEqual(expect.objectContaining({ id: f.id, enabled: false, tools: [] }));
  expect(skills.skillRegistry.getBody(f.id)).toBeNull(); expect(skills.skillRegistry.getReference(f.id, "guide.md")).toBeNull();
  for (const mode of ["work", "code"] as const) expect(skills.skillRegistry.getEnabledForMode(mode).map(skill => skill.id)).not.toContain(f.id);
  const restartStorage = createStorageContext(f.storage.profile), restartHost = { runId: randomUUID(), isPrimaryProcess: () => true };
  await skills.initSkills(restartStorage, restartHost); expect(skills.skillRegistry.getById(f.id)?.enabled).toBe(false); expect(skills.skillRegistry.getBody(f.id)).toBeNull();
  expect(await f.settings.setSkillEnabled!(f.id, true)).toEqual({ ok: true });
  expect(new ExternalSkillStateStore(restartStorage, restartHost).read(f.id)?.enabled).toBe(true);
  for (const mode of ["work", "code"] as const) expect(skills.skillRegistry.getEnabledForMode(mode).map(skill => skill.id)).toContain(f.id);
  expect(skills.skillRegistry.getBody(f.id)).toContain("Synthetic text"); expect(skills.skillRegistry.getReference(f.id, "guide.md")).toContain("Synthetic guide");
  await skills.initSkills(createStorageContext(f.storage.profile), { ...restartHost, runId: randomUUID() }); expect(skills.skillRegistry.getBody(f.id)).toContain("Synthetic text");
  expect(await f.settings.setSkillEnabled!(f.id, false)).toEqual({ ok: true }); expect(skills.skillRegistry.getBody(f.id)).toBeNull();
  await skills.initSkills(createStorageContext(f.storage.profile), { ...restartHost, runId: randomUUID() }); expect(skills.skillRegistry.getById(f.id)?.enabled).toBe(false);
  expect(skills.skillRegistry.getBody("ordinary")).toBe("ordinary instructions");
  expect(await f.settings.setSkillEnabled!("ordinary", false)).toEqual({ ok: true }); expect(JSON.parse(fs.readFileSync(path.join(f.storage.configRoot, "skills-enabled.json"), "utf8"))).toEqual({ ordinary: false });
  checkDangerous(); f.preserved(); expect(f.paths.length).toBeGreaterThan(0);
});

it("end_to_end_isolated exact static review is required despite explicit Renderer confirmation", async () => {
  const f = await fixture("openai", { review: false }); const check = dangerousSpies();
  expect(value(await f.api.detail("openai", f.id)).blockers).toContain("REVIEW_REQUIRED");
  expect(await f.api.prepare("openai", f.id)).toMatchObject({ ok: false, code: "REVIEW_REQUIRED" });
  expect(await f.api.commit("0".repeat(64))).toMatchObject({ ok: false, code: "TOKEN_INVALID" }); expect(f.stages()).toEqual([]); expect(fs.existsSync(f.formal)).toBe(false); check(); f.preserved();
});
it.each(["url", "git-subdir"] as const)("end_to_end_isolated OpenAI %s external source remains informational and cannot issue preparation", async externalOrigin => {
  const f = await fixture("openai", { externalOrigin }); const check = dangerousSpies();
  const candidate = value(await f.api.list("openai")).find(skill => skill.id !== f.id)!; expect(candidate.review).toBe("blocked");
  expect(value(await f.api.detail("openai", candidate.id)).blockers).toContain("DEPENDENCY_BLOCKED");
  expect(await f.api.prepare("openai", candidate.id)).toMatchObject({ ok: false, code: "DEPENDENCY_BLOCKED" });
  expect(f.transport.mock.calls.every(([url]) => String(url).startsWith("https://api.github.com/repos/openai/plugins"))).toBe(true); expect(f.stages()).toEqual([]); check(); f.preserved();
});
it.each([
  ["script", { "scripts/run.py": "synthetic forbidden script, never execute" }],
  ["nested-reference", { "references/nested/info.md": "unsupported nested text" }],
  ["connector", { "SKILL.md": "---\nname: synthetic-text\ndescription: Synthetic.\n---\nRequires a connector to summarize.\n" }],
  ["binary", { "opaque.bin": "synthetic forbidden binary inventory" }],
] as const)("end_to_end_isolated %s dependency blocks whole import and executes nothing", async (_name, extra) => {
  const f = await fixture("anthropic", { extra }); const check = dangerousSpies();
  const detail = value(await f.api.detail("anthropic", f.id)); expect(detail.review).toBe("unreviewed"); expect(detail.preview?.complete).toBe(false);
  expect(await f.api.prepare("anthropic", f.id)).toMatchObject({ ok: false, code: "DEPENDENCY_BLOCKED" }); expect(f.stages()).toEqual([]); expect(fs.existsSync(f.formal)).toBe(false); check(); f.preserved();
});
it.each(["publish-rename", "state-persist"] as const)("end_to_end_isolated %s failure rolls back real commit without outside writes", async failure => {
  const f = await fixture(); const check = dangerousSpies(); const ready = value(await f.api.prepare("anthropic", f.id));
  if (failure === "publish-rename") { const rename = fs.renameSync; vi.spyOn(fs, "renameSync").mockImplementation((from, to) => { if (String(to) === path.join(f.formal, "content")) throw Error("INJECTED_PUBLISH_FAILURE"); return rename(from, to); }); }
  else { vi.spyOn(AtomicJsonStore.prototype, "write").mockImplementation(() => { throw Error("INJECTED_STATE_FAILURE:" + f.root); }); }
  const result = await f.api.commit(ready.token); expect(result).toMatchObject({ ok: false, code: "STORAGE_FAILED" }); expect(JSON.stringify(result)).not.toContain(f.root);
  expect(fs.existsSync(f.formal)).toBe(false); expect(fs.existsSync(f.stateFile)).toBe(false); expect(f.stages()).toEqual([]); expect(skills.skillRegistry.getById(f.id)).toBeUndefined(); check(); f.preserved();
});
it("end_to_end_isolated enable write failure leaves disabled bytes and registry, then explicit retry succeeds", async () => {
  const f = await fixture(); const check = dangerousSpies(); const ready = value(await f.api.prepare("anthropic", f.id)); value(await f.api.commit(ready.token)); const before = fs.readFileSync(f.stateFile);
  const failing = vi.spyOn(AtomicJsonStore.prototype, "write").mockImplementation(() => { throw Error("INJECTED_ENABLE_FAILURE:" + f.root); });
  const result = await f.settings.setSkillEnabled!(f.id, true); expect(result).toMatchObject({ ok: false }); expect(JSON.stringify(result)).not.toContain(f.root); expect(fs.readFileSync(f.stateFile)).toEqual(before); expect(skills.skillRegistry.getBody(f.id)).toBeNull();
  for (const mode of ["work", "code"] as const) expect(skills.skillRegistry.getEnabledForMode(mode).map(skill => skill.id)).not.toContain(f.id);
  failing.mockRestore(); expect(await f.settings.setSkillEnabled!(f.id, true)).toEqual({ ok: true }); expect(skills.skillRegistry.getBody(f.id)).toContain("Synthetic text"); check(); f.preserved();
});
it("end_to_end_isolated target collision preserves unowned content and never enables it", async () => {
  const f = await fixture(); const check = dangerousSpies(); fs.mkdirSync(f.formal, { recursive: true }); fs.writeFileSync(path.join(f.formal, "keep.txt"), "unowned sentinel"); const before = treeSnapshot(f.formal);
  const ready = value(await f.api.prepare("anthropic", f.id)); expect(await f.api.commit(ready.token)).toMatchObject({ ok: false, code: "TARGET_EXISTS" }); expect(treeSnapshot(f.formal)).toEqual(before); expect(fs.existsSync(f.stateFile)).toBe(false); expect(f.stages()).toEqual([]); check(); f.preserved();
});
it("end_to_end_isolated cancel and refresh revoke review tokens, while duplicate confirmation commits exactly once", async () => {
  const f = await fixture(); const check = dangerousSpies(); let ready = value(await f.api.prepare("anthropic", f.id));
  expect(value(await f.api.cancel())).toEqual({ status: "cancelled" }); expect(f.stages()).toEqual([]); expect(await f.api.commit(ready.token)).toMatchObject({ code: "TOKEN_INVALID" });
  ready = value(await f.api.prepare("anthropic", f.id)); value(await f.api.list("anthropic", true)); expect(await f.api.commit(ready.token)).toMatchObject({ code: "STALE_SNAPSHOT" }); expect(f.stages()).toEqual([]);
  ready = value(await f.api.prepare("anthropic", f.id)); const results = await Promise.all([f.api.commit(ready.token), f.api.commit(ready.token)]); expect(results.filter(result => result.ok)).toHaveLength(1); expect(results.find(result => !result.ok)).toMatchObject({ code: "TOKEN_INVALID" });
  expect(new ExternalSkillStateStore(f.storage).read(f.id)?.enabled).toBe(false); check(); f.preserved();
});
it("end_to_end_isolated main-frame navigation and close revoke preparation before legacy enable", async () => {
  const f = await fixture(); const check = dangerousSpies(); const ready = value(await f.api.prepare("anthropic", f.id));
  f.chat.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true }); expect(f.stages()).toEqual([]); expect(await f.api.commit(ready.token)).toMatchObject({ code: "FORBIDDEN" });
  f.chat.emit("did-navigate-in-page", {}, "file://test#back", true); expect(await f.api.commit(ready.token)).toMatchObject({ code: "STALE_SNAPSHOT" });
  const next = value(await f.api.prepare("anthropic", f.id)); value(await f.api.commit(next.token));
  m.event = { sender: contents(9), senderFrame: f.chat.mainFrame }; expect(await f.settings.setSkillEnabled!(f.id, true)).toMatchObject({ ok: false }); expect(skills.skillRegistry.getBody(f.id)).toBeNull();
  m.event = { sender: f.chat, senderFrame: f.chat.mainFrame }; const window = Object.assign(new EventEmitter(), m.chat); m.windowOptions.onChatWindowCreated(window); m.chat = null; window.emit("closed");
  expect(await f.settings.setSkillEnabled!(f.id, true)).toMatchObject({ ok: false }); expect(skills.skillRegistry.getBody(f.id)).toBeNull(); check(); f.preserved();
});
it("end_to_end_isolated cancel during pre-token transport releases transaction without publication", async () => {
  const f = await fixture(); const check = dangerousSpies(); let entered = false;
  f.setHook(async (_input, init) => { entered = true; return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(Error("SYNTHETIC_CANCEL")), { once: true })); });
  const pending = f.api.prepare("anthropic", f.id); await until(() => entered); expect(value(await f.api.cancel())).toEqual({ status: "cancelled" }); expect(await pending).toMatchObject({ ok: false, code: "CANCELLED" }); expect(f.stages()).toEqual([]); expect(fs.existsSync(f.formal)).toBe(false); check(); f.preserved();
});
it.each(["rate-limit", "redirect", "blob-mismatch"] as const)("end_to_end_isolated %s fails through bridge without fallback or publication", async kind => {
  const f = await fixture(); const check = dangerousSpies();
  f.setHook(async (input, init) => {
    if (kind === "rate-limit") return Response.json({}, { status: 429 });
    if (kind === "redirect") return new Response(null, { status: 302, headers: { location: "https://example.invalid/fallback" } });
    const result = await f.route(input, init); if (String(input).includes("/git/blobs/")) { const blob = await result.json() as Record<string, unknown>; return Response.json({ ...blob, content: Buffer.from("tampered").toString("base64") }); } return result;
  });
  const result = await f.api.prepare("anthropic", f.id); expect(result).toMatchObject({ ok: false, code: kind === "rate-limit" ? "RATE_LIMITED" : kind === "redirect" ? "NETWORK_FAILED" : "BLOB_MISMATCH" });
  expect(f.stages()).toEqual([]); expect(fs.existsSync(f.formal)).toBe(false); check(); f.preserved();
});
it("end_to_end_isolated request timeout is bounded through the real bridge and never publishes", async () => {
  const f = await fixture(); const check = dangerousSpies(); let entered = false;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  f.setHook(async (_input, init) => { entered = true; return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(Error("SYNTHETIC_REQUEST_TIMEOUT")), { once: true })); });
  const pending = f.api.prepare("anthropic", f.id); await until(() => entered); await vi.advanceTimersByTimeAsync(15000);
  expect(await pending).toMatchObject({ ok: false, code: "REQUEST_TIMEOUT", retryable: true }); expect(f.stages()).toEqual([]); expect(fs.existsSync(f.formal)).toBe(false); check(); f.preserved();
});
it.each(["link", "traversal", "oversize"] as const)("end_to_end_isolated unsafe %s inventory is rejected before publication", async kind => {
  const f = await fixture(); const check = dangerousSpies(); const item = f.tree.find(entry => entry.path.endsWith("/SKILL.md"))!;
  if (kind === "link") item.mode = "120000";
  if (kind === "traversal") item.path = "../outside/SKILL.md";
  if (kind === "oversize") item.size = 1048577;
  const result = await f.api.prepare("anthropic", f.id);
  expect(result).toMatchObject({ ok: false, code: kind === "link" ? "TREE_INVALID" : kind === "traversal" ? "PATH_INVALID" : "LIMIT_EXCEEDED" });
  expect(f.stages()).toEqual([]); expect(fs.existsSync(f.formal)).toBe(false); check(); f.preserved();
});
it.each([
  ["unknown-license", { "LICENSE": "Proprietary License\nSynthetic terms; redistribution is forbidden.\n" }],
  ["license-name-only", { "LICENSE": "MIT\n" }],
] as const)("end_to_end_isolated %s cannot be approved by a matching name or confirmation", async (_name, extra) => {
  const f = await fixture("anthropic", { extra }); const check = dangerousSpies();
  expect(value(await f.api.detail("anthropic", f.id))).toMatchObject({ review: "unreviewed", files: [], licenses: [], preview: { complete: false } });
  expect(await f.api.prepare("anthropic", f.id)).toMatchObject({ ok: false, code: "LICENSE_BLOCKED" }); expect(f.stages()).toEqual([]); expect(fs.existsSync(f.formal)).toBe(false); check(); f.preserved();
});
it("end_to_end_isolated staging mkdir failure rolls back its own partial preparation", async () => {
  const f = await fixture(); const check = dangerousSpies(); const mkdir = fs.mkdirSync;
  vi.spyOn(fs, "mkdirSync").mockImplementation(((directory: any, options: any) => { if (String(directory).endsWith(path.sep + "payload")) throw Error("INJECTED_STAGE_FAILURE:" + f.root); return mkdir(directory, options); }) as typeof fs.mkdirSync);
  const result = await f.api.prepare("anthropic", f.id); expect(result).toMatchObject({ ok: false, code: "STORAGE_FAILED" }); expect(JSON.stringify(result)).not.toContain(f.root); expect(f.stages()).toEqual([]); expect(fs.existsSync(f.formal)).toBe(false); check(); f.preserved();
});
it("end_to_end_isolated changed staged digest prevents commit and preserves unexpected bytes instead of broad rollback", async () => {
  const f = await fixture(); const check = dangerousSpies(); const ready = value(await f.api.prepare("anthropic", f.id));
  const staged = path.join(f.storage.cacheRoot, "external-skills", f.stages()[0], "payload", f.id, "SKILL.md"); fs.writeFileSync(staged, "unexpected changed digest");
  expect(await f.api.commit(ready.token)).toMatchObject({ ok: false, code: "ROLLBACK_FAILED" }); expect(fs.readFileSync(staged, "utf8")).toBe("unexpected changed digest"); expect(fs.existsSync(f.formal)).toBe(false); expect(fs.existsSync(f.stateFile)).toBe(false); expect(await f.api.commit(ready.token)).toMatchObject({ code: "TOKEN_INVALID" });
  const resource = m.resources.get("external-skills")!; await expect(resource.dispose()).rejects.toMatchObject({ code: "ROLLBACK_FAILED" }); m.resources.delete("external-skills");
  check(); f.preserved(); // Fixture creator removes only its temporary test root after the asserted terminal failure.
});
