import { beforeEach, afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PluginManager, PLUGIN_ACTIVATION_TIMEOUT_MS, type PluginManagerOptions } from "./manager";
import { PLUGIN_CLEANUP_TIMEOUT_MS, type PluginRuntime } from "./context";
import { createPluginPromptRegistry } from "./prompts";
import * as installer from "./installer";

let directory: string;
const managers: PluginManager[] = [];
beforeEach(() => { directory = fs.mkdtempSync(join(tmpdir(), "plugin-manager-contract-")); });
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.stop();
  vi.useRealTimers(); vi.restoreAllMocks();
  fs.rmSync(directory, { recursive: true, force: true });
});
const manifest = (id: string, version = "2.4.6") => ({
  id, version, apiVersion: 1 as const, name: id, description: "Lifecycle contract fixture",
  author: "Contract suite", entry: "entry.cjs", defaultEnabled: true,
});
function writePlugin(id = "catalog", code?: string, changes: Record<string, unknown> = {}, root = join(directory, "programs")) {
  const target = join(root, id);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(join(target, "manifest.json"), JSON.stringify({ ...manifest(id), ...changes }));
  fs.writeFileSync(join(target, "entry.cjs"), code ?? `module.exports = {
    open() { return 'catalog opened'; },
    register(context) {
      context.registerIpc('query', () => 'catalog revision one');
      context.registerTool({ id: '${id}_lookup', name: 'lookup', description: 'Query catalog', enabled: true,
        inputSchema: { type: 'object', properties: {}, required: [] }, execute: async () => 'catalog entry' });
    }, unregister() { return undefined; }
  };`);
  return target;
}
function harness(overrides: Partial<PluginManagerOptions> = {}) {
  const target = writePlugin();
  const tools: string[] = [];
  const ipc = new Map<string, (...args: any[]) => any>();
  const promptRegistry = createPluginPromptRegistry();
  let preferences: Record<string, boolean> = {};
  const runtime: PluginRuntime = {
    toolRegistry: {
      register: tool => { tools.push(tool.id); },
      unregister: id => { const index = tools.indexOf(id); if (index >= 0) tools.splice(index, 1); return true; },
    },
    channelManager: { has: () => false, register: () => {}, startOne: async () => {}, unregister: async () => true },
    registerIpc: (name, handler) => { ipc.set(name, handler); }, unregisterIpc: name => { ipc.delete(name); }, promptRegistry,
  };
  const options: PluginManagerOptions = {
    runtime, scanRoots: [{ path: join(directory, "programs"), source: "builtin" }], storageRoot: join(directory, "data"),
    loadEnabledMap: () => ({ ...preferences }), saveEnabledMap: values => { preferences = { ...values }; }, ...overrides,
  };
  const manager = new PluginManager(options);
  managers.push(manager);
  return { target, tools, ipc, options, manager, promptRegistry, preferences: () => preferences };
}
function replace(code: string) { fs.writeFileSync(join(directory, "programs", "catalog", "entry.cjs"), code); }
function sharedFixture(code: string) {
  const bridge = join(directory, "fixture-bridge.cjs");
  fs.writeFileSync(bridge, code);
  return { path: JSON.stringify(bridge), state: require(bridge) };
}
function pendingRegistration(h: ReturnType<typeof harness>) {
  replace(`module.exports = { async register(context) {
    let release, finish;
    const gate = new Promise(done => { release = done; });
    const settled = new Promise(done => { finish = done; });
    context.registerIpc('pause', () => ({ signal: context.signal, release, settled }));
    await gate;
    try { context.registerIpc('late', () => 'stale instance'); } finally { finish(); }
  } };`);
  return () => h.ipc.get("plugin:catalog:pause")!() as { signal: AbortSignal; release: () => void; settled: Promise<void> };
}

it("starts bundled defaults and publishes management IPC with a running plugin overview", async () => {
  const h = harness();
  await h.manager.start();
  expect(h.manager.list().map(plugin => plugin.id)).toStrictEqual(["catalog"]);
  expect(h.manager.list()[0].enabled).toEqual(true);
  for (const channel of ["plugins:list", "plugins:rescan", "plugins:import-zip", "plugins:uninstall", "plugins:set-enabled", "plugin:catalog:query"]) {
    expect(h.ipc.has(channel)).toEqual(true);
  }
  expect(h.ipc.get("plugins:list")!()).toMatchObject({ issues: [], plugins: [expect.objectContaining({ id: "catalog", status: "running" })] });
});

it("delivers ordinary host events only while the subscriber is enabled", async () => {
  const h = harness();
  const bridge = sharedFixture("module.exports = { phases: [] };");
  replace(`const state = require(${bridge.path}); module.exports = { register(context) {
    context.events.on('host:runtime:ready', payload => { state.phases.push(payload.phase); });
  } };`);
  await h.manager.start();
  await h.manager.publishHostEvent("runtime:ready", { phase: "interactive" });
  expect(bridge.state.phases).toStrictEqual(["interactive"]);
  await h.manager.setEnabled("catalog", false);
  await h.manager.publishHostEvent("runtime:ready", { phase: "background" });
  expect(bridge.state.phases).toStrictEqual(["interactive"]);
});

it("does not await an ordinary subscriber's pending promise", async () => {
  const h = harness();
  const bridge = sharedFixture("module.exports = { entered: false };");
  replace(`const state = require(${bridge.path}); module.exports = { register(context) {
    context.events.on('host:runtime:ready', () => { state.entered = true; return new Promise(done => { state.release = done; }); });
  } };`);
  await h.manager.start();
  await h.manager.publishHostEvent("runtime:ready", { phase: "interactive" });
  expect(bridge.state.entered).toEqual(true);
  bridge.state.release();
});

it("publishes ready and stopping barriers while plugin subscriptions still exist", async () => {
  const h = harness();
  const bridge = sharedFixture("module.exports = { lifecycle: [] };");
  replace(`const state = require(${bridge.path}); module.exports = { register(context) {
    context.events.on('host:plugins:ready', () => { state.lifecycle.push('ready'); });
    context.events.on('host:plugins:stopping', () => { state.lifecycle.push('stopping'); });
  } };`);
  await h.manager.start(); await h.manager.stop();
  expect(bridge.state.lifecycle).toStrictEqual(["ready", "stopping"]);
});

it("opens only a running plugin that supports an open entry point", async () => {
  const h = harness();
  await h.manager.start();
  expect(h.manager.list()[0].canOpen).toEqual(true);
  expect(h.ipc.has("plugins:open")).toEqual(true);
  await expect(h.ipc.get("plugins:open")!("catalog")).resolves.toStrictEqual({ ok: true });
  await h.manager.setEnabled("catalog", false);
  await expect(h.ipc.get("plugins:open")!("catalog")).resolves.toMatchObject({ ok: false });
});

it("honors disabled preferences and serializes concurrent enable requests", async () => {
  const h = harness({ loadEnabledMap: () => ({ catalog: false }) });
  await h.manager.start();
  expect(h.manager.list()[0].enabled).toEqual(false);
  expect(h.ipc.has("plugin:catalog:query")).toEqual(false);
  const results = await Promise.all([h.manager.setEnabled("catalog", true), h.manager.setEnabled("catalog", true)]);
  expect(results.map(result => result.ok)).toStrictEqual([true, true]);
  expect(h.tools).toStrictEqual(["catalog_lookup"]);
});

it("persists disable, releases resources and can activate the same plugin again", async () => {
  const h = harness();
  await h.manager.start();
  expect(h.tools).toContain("catalog_lookup");
  expect((await h.manager.setEnabled("catalog", false)).ok).toEqual(true);
  expect(h.manager.list()[0].enabled).toEqual(false);
  expect(h.ipc.has("plugin:catalog:query")).toEqual(false);
  expect(h.tools).toStrictEqual([]);
  expect(h.preferences().catalog).toEqual(false);
  expect((await h.manager.setEnabled("catalog", true)).ok).toEqual(true);
  expect(h.ipc.has("plugin:catalog:query")).toEqual(true);
  expect(h.tools).toContain("catalog_lookup");
});

it.each([true, false])("retains configured state %s when preference persistence fails", async previous => {
  const h = harness({ loadEnabledMap: () => ({ catalog: previous }), saveEnabledMap: () => { throw new Error("preferences volume full"); } });
  await h.manager.start();
  expect(await h.manager.setEnabled("catalog", !previous)).toMatchObject({ ok: false });
  expect(h.manager.list()[0]).toMatchObject({ configuredEnabled: previous, enabled: previous });
  await h.manager.rescan();
  expect(h.manager.list()[0]).toMatchObject({ configuredEnabled: previous, enabled: previous });
  expect(h.tools.includes("catalog_lookup")).toEqual(previous);
});

it("keeps one record for duplicate identities and rejects enable of an unknown identity", async () => {
  const h = harness();
  writePlugin("catalog-copy", undefined, { id: "catalog" });
  await h.manager.start();
  expect(h.manager.list()).toHaveLength(1);
  expect((await h.manager.setEnabled("unregistered", true)).ok).toEqual(false);
});

it("removes all plugin resources and management IPC on shutdown", async () => {
  const h = harness();
  await h.manager.start(); await h.manager.stop();
  expect(h.manager.list()).toStrictEqual([]);
  expect(h.tools).toStrictEqual([]);
  expect(h.ipc.size).toEqual(0);
});

it.each(["throw", "timeout"] as const)("finishes disabling when unregister ends with %s", async failure => {
  const h = harness();
  replace(`module.exports = { register(context) { context.registerIpc('query', () => 'registered'); },
    unregister() { ${failure === "throw" ? "throw new Error('unregister unavailable');" : "return new Promise(() => {});"} }
  };`);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await h.manager.start();
  if (failure === "timeout") vi.useFakeTimers();
  const disabling = h.manager.setEnabled("catalog", false);
  if (failure === "timeout") await vi.advanceTimersByTimeAsync(PLUGIN_CLEANUP_TIMEOUT_MS);
  expect(await disabling).toStrictEqual({ ok: true });
  expect(h.manager.list()[0].enabled).toEqual(false);
  expect(h.ipc.has("plugin:catalog:query")).toEqual(false);
  expect(h.preferences().catalog).toEqual(false);
  if (failure === "timeout") expect(warn).toHaveBeenCalledWith(
    "[plugins] 插件 catalog unregister 失败，继续释放框架资源",
    expect.objectContaining({ message: expect.stringContaining("unregister 清理超时") }));
});

it("aborts before unregister, executes onDispose and removes contributed prompts", async () => {
  const h = harness();
  const bridge = sharedFixture("module.exports = { aborted: false, cleaned: false };");
  replace(`const state = require(${bridge.path}); let context;
    module.exports = {
      register(value) { context = value; value.onDispose(() => { state.cleaned = true; });
        value.registerPromptProvider({ id: 'overview', provide: ({ userText }) => 'Catalog sees: ' + userText }); },
      unregister() { state.aborted = context.signal.aborted; }
    };`);
  const input = { source: "conversation" as const, mode: "chat" as const, userText: "Review" };
  await h.manager.start();
  expect(await h.promptRegistry.build(input)).toContain("Catalog sees: Review");
  await h.manager.setEnabled("catalog", false);
  expect(bridge.state.aborted).toEqual(true);
  expect(bridge.state.cleaned).toEqual(true);
  expect(await h.promptRegistry.build(input)).toEqual("");
});

it("retains desired enablement after registration failure and retries corrected source", async () => {
  const h = harness();
  replace("module.exports = { register() { throw new Error('catalog registration rejected'); } };");
  await h.manager.start();
  expect(h.manager.list()[0].enabled).toEqual(false);
  expect(h.manager.list()[0]).toMatchObject({ configuredEnabled: true, status: "failed", error: "catalog registration rejected" });
  replace("module.exports = { register(context) { context.registerIpc('query', () => 'corrected'); } };");
  expect((await h.manager.setEnabled("catalog", true)).ok).toEqual(true);
  expect(h.manager.list()[0].enabled).toEqual(true);
  expect(h.ipc.has("plugin:catalog:query")).toEqual(true);
});

it("calls unregister with an aborted signal when partial registration must roll back", async () => {
  const h = harness();
  const bridge = sharedFixture("module.exports = { aborted: false };");
  replace(`const state = require(${bridge.path}); let context;
    module.exports = {
      register(value) { context = value; value.registerIpc('partial', () => 'uncommitted'); throw new Error('catalog partial failure'); },
      unregister() { state.aborted = context.signal.aborted; }
    };`);
  await h.manager.start();
  expect(bridge.state.aborted).toEqual(true);
  expect(h.ipc.has("plugin:catalog:partial")).toEqual(false);
  expect(h.manager.list()[0]).toMatchObject({ configuredEnabled: true, enabled: false, status: "failed", error: "catalog partial failure" });
});

it.each(["timeout", "disable", "stop"] as const)("interrupts pending registration via %s and rejects its late resource claims", async operation => {
  const h = harness();
  const control = pendingRegistration(h);
  if (operation === "timeout") writePlugin("healthy-addon");
  vi.useFakeTimers();
  const changes: boolean[] = [];
  h.manager.onRunningStateChange((id, running) => { if (id === "catalog") changes.push(running); });
  let started = false;
  const starting = h.manager.start().then(() => { started = true; });
  await vi.advanceTimersByTimeAsync(0);
  const paused = control();
  let finished = operation === "timeout";
  const stopping = operation === "timeout" ? Promise.resolve() :
    (operation === "disable" ? h.manager.setEnabled("catalog", false) : h.manager.stop()).then(() => { finished = true; });
  if (operation !== "timeout") expect(paused.signal.aborted).toEqual(true);
  await vi.advanceTimersByTimeAsync(operation === "timeout" ? PLUGIN_ACTIVATION_TIMEOUT_MS : 0);
  expect(started).toEqual(true);
  expect(finished).toEqual(true);
  await Promise.all([starting, stopping]);
  expect(paused.signal.aborted).toEqual(true);
  expect(h.manager.isRunning("catalog")).toEqual(false);
  expect(h.ipc.has("plugin:catalog:pause")).toEqual(false);
  if (operation === "timeout") {
    expect(h.manager.list().find(plugin => plugin.id === "catalog")).toMatchObject({ configuredEnabled: true, status: "failed", error: expect.stringContaining("激活超时") });
    expect(h.manager.isRunning("healthy-addon")).toEqual(true);
  } else if (operation === "disable") {
    expect(h.manager.list()[0].status).toEqual("disabled");
    expect(h.preferences().catalog).toEqual(false);
  } else {
    expect(h.manager.list()).toStrictEqual([]);
    expect(h.ipc.size).toEqual(0);
  }
  paused.release(); await paused.settled;
  await vi.advanceTimersByTimeAsync(0);
  expect(h.manager.isRunning("catalog")).toEqual(false);
  expect(h.ipc.has("plugin:catalog:late")).toEqual(false);
  expect(changes).toStrictEqual([]);
});

it.each(["timeout", "disable", "stop"] as const)("interrupts a top-level ESM await through %s without calling late register", async operation => {
  const h = harness();
  const bridge = sharedFixture(`const state = { registered: false };
    state.entered = new Promise(done => { state.enter = done; });
    state.gate = new Promise(done => { state.release = done; });
    state.loaded = new Promise(done => { state.complete = done; });
    module.exports = state;`);
  fs.writeFileSync(join(h.target, "manifest.json"), JSON.stringify({ ...manifest("catalog"), entry: "entry.mjs" }));
  fs.writeFileSync(join(h.target, "entry.mjs"), `import state from "../../fixture-bridge.cjs";
    state.enter(); await state.gate; state.complete();
    export default { register(context) { state.registered = true; context.registerIpc('late', () => 'late import'); } };`);
  vi.useFakeTimers();
  let started = false;
  const starting = h.manager.start().then(() => { started = true; });
  await bridge.state.entered;
  let finished = operation === "timeout";
  const stopping = operation === "timeout" ? Promise.resolve() :
    (operation === "disable" ? h.manager.setEnabled("catalog", false) : h.manager.stop()).then(() => { finished = true; });
  await vi.advanceTimersByTimeAsync(operation === "timeout" ? PLUGIN_ACTIVATION_TIMEOUT_MS : 0);
  expect(started).toEqual(true);
  expect(finished).toEqual(true);
  await Promise.all([starting, stopping]);
  bridge.state.release(); await bridge.state.loaded;
  await vi.advanceTimersByTimeAsync(0);
  expect(bridge.state.registered).toEqual(false);
  expect(h.manager.isRunning("catalog")).toEqual(false);
  expect(h.ipc.has("plugin:catalog:late")).toEqual(false);
});

it("serializes reenable after cancellation and protects the replacement instance from late cleanup", async () => {
  const h = harness({ loadEnabledMap: () => ({ catalog: false }) });
  const control = pendingRegistration(h);
  vi.useFakeTimers();
  await h.manager.start();
  const enabling = h.manager.setEnabled("catalog", true);
  await vi.advanceTimersByTimeAsync(0);
  const paused = control();
  const disabling = h.manager.setEnabled("catalog", false);
  replace("module.exports = { async register(context) { await Promise.resolve(); context.registerIpc('late', () => 'replacement catalog'); } };");
  const replacement = h.manager.setEnabled("catalog", true);
  expect((await enabling).ok).toEqual(false);
  expect(await disabling).toStrictEqual({ ok: true });
  expect(await replacement).toStrictEqual({ ok: true });
  paused.release(); await paused.settled; await vi.advanceTimersByTimeAsync(0);
  expect(h.manager.isRunning("catalog")).toEqual(true);
  expect(h.preferences().catalog).toEqual(true);
  expect(h.ipc.get("plugin:catalog:late")!()).toEqual("replacement catalog");
  expect(vi.getTimerCount()).toEqual(0);
});

it("keeps first-discovered user plugins disabled despite author defaults", async () => {
  const h = harness();
  h.options.scanRoots[0].source = "user";
  await h.manager.start();
  expect(h.manager.list()[0]).toMatchObject({ source: "user", configuredEnabled: false, status: "disabled" });
  expect(h.tools).toStrictEqual([]);
});

function preparedPackage(userRoot: string, version = "2.4.6") {
  fs.mkdirSync(userRoot, { recursive: true });
  const stagingDir = join(directory, "prepared-" + version);
  const pluginDir = writePlugin("imported-catalog", "module.exports = { register(context) { context.log('Imported catalog'); } };", { version }, stagingDir);
  return { stagingDir, pluginDir, manifest: manifest("imported-catalog", version) };
}

it("imports through management IPC, rescans and leaves the new user plugin disabled", async () => {
  const h = harness();
  const userRoot = join(directory, "user-programs");
  h.options.scanRoots.push({ path: userRoot, source: "user" });
  h.options.selectPluginZip = async () => join(directory, "selected.zip");
  vi.spyOn(installer, "preparePluginZip").mockResolvedValue(preparedPackage(userRoot));
  await h.manager.start();
  expect(await h.ipc.get("plugins:import-zip")!()).toMatchObject({ ok: true, plugin: { id: "imported-catalog" } });
  expect(h.manager.list()).toContainEqual(expect.objectContaining({ id: "imported-catalog", source: "user", configuredEnabled: false, status: "disabled" }));
  expect(h.tools).not.toContain("imported-catalog_lookup");
});

it("uninstalls user programs, cleans owned persistent resources and preserves private data", async () => {
  const cleaned: string[] = [];
  const h = harness({ loadEnabledMap: () => ({ catalog: true }), cleanupPersistentResources: async id => { cleaned.push(id); } });
  h.options.scanRoots[0].source = "user";
  const data = join(h.options.storageRoot, "catalog");
  fs.mkdirSync(data, { recursive: true }); fs.writeFileSync(join(data, "preferences.json"), "{}");
  await h.manager.start();
  expect(h.tools).toContain("catalog_lookup");
  expect((await h.manager.uninstall("catalog")).ok).toEqual(true);
  expect(cleaned).toStrictEqual(["catalog"]);
  expect(fs.existsSync(h.target)).toEqual(false);
  expect(fs.existsSync(data)).toEqual(true);
  expect(h.tools).toStrictEqual([]);
  expect(h.ipc.has("plugin:catalog:query")).toEqual(false);
  expect(h.preferences()).toStrictEqual({});
  expect(h.manager.list()).toStrictEqual([]);
});

it("retains the user program when owned persistent resource cleanup fails", async () => {
  const h = harness({ loadEnabledMap: () => ({ catalog: true }), cleanupPersistentResources: async () => { throw new Error("scheduled task locked"); } });
  h.options.scanRoots[0].source = "user";
  await h.manager.start();
  const result = await h.manager.uninstall("catalog");
  expect(result.ok).toEqual(false);
  expect(result.error).toContain("卸载插件失败（目录未删除）");
  expect(fs.existsSync(h.target)).toEqual(true);
  expect(h.manager.list()).toContainEqual(expect.objectContaining({ id: "catalog" }));
});

it("refuses to uninstall a bundled plugin", async () => {
  const h = harness(); await h.manager.start();
  expect(await h.manager.uninstall("catalog")).toStrictEqual({ error: "内置插件不能卸载: catalog", ok: false });
  expect(fs.existsSync(h.target)).toEqual(true);
  expect(h.manager.list()).toHaveLength(1);
});

it("refuses deletion when a user record no longer belongs to a configured root", async () => {
  const h = harness({ loadEnabledMap: () => ({ catalog: true }) });
  h.options.scanRoots[0].source = "user"; await h.manager.start();
  h.options.scanRoots = [{ path: join(directory, "replacement-root"), source: "user" }];
  const result = await h.manager.uninstall("catalog");
  expect(result.ok).toEqual(false);
  expect(result.error).toContain("拒绝卸载不安全的插件路径");
  expect(fs.existsSync(h.target)).toEqual(true);
  expect(h.tools).toContain("catalog_lookup");
});

it("does not delete the user program when removing its enabled preference cannot persist", async () => {
  const h = harness({ loadEnabledMap: () => ({ catalog: true }), saveEnabledMap: () => { throw new Error("preferences read only"); } });
  h.options.scanRoots[0].source = "user"; await h.manager.start();
  const result = await h.manager.uninstall("catalog");
  expect(result.ok).toEqual(false);
  expect(result.error).toContain("清理插件启停记录失败，未删除目录");
  expect(fs.existsSync(h.target)).toEqual(true);
  expect(h.tools).toStrictEqual([]);
});

it("reloads changed active source on rescan and releases a plugin whose directory disappeared", async () => {
  const h = harness(); await h.manager.start();
  expect(h.ipc.get("plugin:catalog:query")!()).toEqual("catalog revision one");
  writePlugin("catalog", `module.exports = { register(context) {
    context.registerIpc('query', () => 'catalog revision two');
    context.registerTool({ id: 'catalog_lookup', name: 'lookup', description: 'Query catalog', enabled: true,
      inputSchema: { type: 'object', properties: {}, required: [] }, execute: async () => 'catalog entry' });
  } };`);
  await h.manager.rescan();
  expect(h.ipc.get("plugin:catalog:query")!()).toEqual("catalog revision two");
  expect(h.tools).toStrictEqual(["catalog_lookup"]);
  fs.rmSync(h.target, { recursive: true, force: true });
  await h.manager.rescan();
  expect(h.manager.list()).toStrictEqual([]);
  expect(h.tools).toStrictEqual([]);
  expect(h.ipc.has("plugin:catalog:query")).toEqual(false);
});

it("keeps startup available and reports a root that is not a directory", async () => {
  const h = harness();
  const badRoot = join(directory, "programs.txt"); fs.writeFileSync(badRoot, "Not a directory");
  h.options.scanRoots = [{ path: badRoot, source: "user" }];
  await expect(h.manager.start()).resolves.toBeUndefined();
  expect(h.manager.overview().plugins).toStrictEqual([]);
  expect(h.manager.overview().issues[0]?.message).toMatch(/无法扫描插件目录/);
});

it("does not expose a declared panel after registration failure", async () => {
  const h = harness();
  writePlugin("catalog", "module.exports = { register() { throw new Error('panel activation rejected'); } };", { settingsPanel: "preferences.html" });
  fs.writeFileSync(join(h.target, "preferences.html"), "<p>Catalog preferences</p>");
  await h.manager.start();
  expect(h.manager.list().find(plugin => plugin.id === "catalog")).toMatchObject({ configuredEnabled: true, status: "failed" });
  expect(h.manager.getSettingsPanelDir("catalog")).toBeUndefined();
  expect(h.manager.list()[0].settingsPanel).toBeUndefined();
});

it("exposes settings panels only for running plugins with a valid panel declaration", async () => {
  const h = harness();
  const panel = writePlugin("panel-addon", "module.exports = { register(context) { context.log('Panel ready'); } };", { settingsPanel: "preferences.html" });
  fs.writeFileSync(join(panel, "preferences.html"), "<p>Contract panel</p>");
  await h.manager.start();
  expect(h.manager.getSettingsPanelDir("catalog")).toBeUndefined();
  expect(h.manager.getSettingsPanelDir("panel-addon")).toEqual(panel);
  expect(h.manager.getSettingsPanelDir("unregistered")).toBeUndefined();
  await h.manager.setEnabled("panel-addon", false);
  expect(h.manager.getSettingsPanelDir("panel-addon")).toBeUndefined();
});

it("records market origin, clears it on local replacement and deletes it on uninstall", async () => {
  const h = harness();
  const userRoot = join(directory, "user-programs");
  h.options.scanRoots.push({ path: userRoot, source: "user" });
  h.options.confirmPluginReplace = async () => true;
  const prepare = vi.spyOn(installer, "preparePluginZip");
  prepare.mockResolvedValueOnce(preparedPackage(userRoot));
  await h.manager.start();
  const first = await h.manager.installZip(join(directory, "market.zip"), { origin: "market", expectedIdentity: { id: "imported-catalog", version: "2.4.6" } });
  expect(first.ok).toEqual(true);
  expect(h.manager.list().find(plugin => plugin.id === "imported-catalog")?.origin).toEqual("market");
  prepare.mockResolvedValueOnce(preparedPackage(userRoot, "3.0.0"));
  expect((await h.manager.installZip(join(directory, "local.zip"))).ok).toEqual(true);
  expect(h.manager.list().find(plugin => plugin.id === "imported-catalog")?.origin).toEqual("local");
  prepare.mockResolvedValueOnce(preparedPackage(userRoot, "4.0.0"));
  await h.manager.installZip(join(directory, "market-again.zip"), { origin: "market" });
  expect((await h.manager.uninstall("imported-catalog")).ok).toEqual(true);
  expect(installer.readHostMetadataSync(userRoot, "imported-catalog")).toBeUndefined();
});
