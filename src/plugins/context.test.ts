import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createContext, PLUGIN_CLEANUP_TIMEOUT_MS, type PluginRuntime } from "./context";
import { createPluginEventBus } from "./events";
import { createPluginPromptRegistry } from "./prompts";
import type { PluginChannelAdapter, PluginTool, PluginCapability } from "./types";

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "plugin-context-contract-")); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); rmSync(directory, { recursive: true, force: true }); });
function host() {
  const tools: string[] = [];
  const channels = new Map<string, (...args: unknown[]) => unknown>();
  const promptRegistry = createPluginPromptRegistry();
  const runtime: PluginRuntime = {
    toolRegistry: {
      register: tool => { tools.push(tool.id); },
      unregister: id => { tools.splice(tools.indexOf(id), 1); return true; },
    },
    channelManager: { has: () => false, register: vi.fn(), startOne: async () => {}, unregister: async () => true },
    registerIpc: (name, handler) => { channels.set(name, handler); }, unregisterIpc: name => { channels.delete(name); }, promptRegistry,
  };
  return { runtime, tools, channels, promptRegistry };
}
const tool = (modes?: unknown): PluginTool => ({
  id: "catalog_lookup", name: "lookup", description: "Look up catalog records", enabled: true,
  ...(modes === undefined ? {} : { modes: modes as never }),
  inputSchema: { type: "object", properties: {}, required: [] }, execute: async () => "Catalog result",
});
const context = (runtime: PluginRuntime = host().runtime, deps?: PluginCapability[]) => createContext("catalog", directory, runtime, createPluginEventBus(), deps);

it("namespaces IPC registration and clears IPC and tools at disposal", async () => {
  const h = host();
  const plugin = context(h.runtime);
  plugin.registerIpc("query", () => "Catalog result");
  expect(h.channels.has("plugin:catalog:query")).toEqual(true);
  plugin.registerTool(tool());
  await plugin.dispose();
  expect(h.tools).toStrictEqual([]);
  expect(h.channels.has("plugin:catalog:query")).toEqual(false);
});

it("rejects retired, unknown and non-array tool modes without registering anything", () => {
  const h = host();
  const plugin = context(h.runtime);
  for (const modes of [["learn"], ["invalid-mode"], "work"]) {
    expect(() => plugin.registerTool(tool(modes))).toThrow("INVALID_TOOL_MODES");
  }
  expect(h.tools).toStrictEqual([]);
});

it("aborts before reverse-ordered asynchronous cleanup and refuses late resource registration", async () => {
  const plugin = context();
  const trace: string[] = [];
  plugin.onDispose(() => { trace.push("earlier:" + plugin.signal.aborted); });
  plugin.onDispose(async () => { await Promise.resolve(); trace.push("later:" + plugin.signal.aborted); });
  expect(plugin.signal.aborted).toEqual(false);
  plugin.beginStop();
  expect(plugin.signal.aborted).toEqual(true);
  expect(() => plugin.onDispose(() => {})).toThrow(/停止后/);
  expect(() => plugin.events.on("host:runtime:ready", () => {})).toThrow(/停止后/);
  expect(() => plugin.registerPromptProvider({ id: "late", provide: () => "" })).toThrow(/停止后/);
  await plugin.dispose();
  expect(trace).toStrictEqual(["later:true", "earlier:true"]);
});

it("continues cleanup and resource release after a callback fails, without rerunning it", async () => {
  const h = host();
  const plugin = context(h.runtime);
  const trace: string[] = [];
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  plugin.registerIpc("query", () => "Catalog result");
  plugin.onDispose(() => { trace.push("retained cleanup"); });
  plugin.onDispose(() => { throw new Error("callback unavailable"); });
  await plugin.dispose(); await plugin.dispose();
  expect(trace).toStrictEqual(["retained cleanup"]);
  expect(h.channels.has("plugin:catalog:query")).toEqual(false);
  expect(warning).toHaveBeenCalledTimes(1);
});

it("shares concurrent disposal and unregisters IPC only once", async () => {
  const h = host();
  const unregister = vi.spyOn(h.runtime, "unregisterIpc");
  const plugin = context(h.runtime);
  let release!: () => void;
  plugin.registerIpc("query", () => "Catalog result");
  plugin.onDispose(() => new Promise<void>(resolve => { release = resolve; }));
  const first = plugin.dispose();
  const second = plugin.dispose();
  expect(second).toBe(first);
  release();
  await Promise.all([first, second]);
  expect(unregister).toHaveBeenCalledTimes(1);
});

it("times out a hung cleanup and still releases callbacks and framework resources", async () => {
  const h = host();
  const plugin = context(h.runtime);
  const trace: number[] = [];
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  plugin.registerIpc("query", () => "Catalog result");
  plugin.onDispose(() => { trace.push(19); });
  plugin.onDispose(() => new Promise<void>(() => {}));
  vi.useFakeTimers();
  const finished = plugin.dispose();
  await vi.advanceTimersByTimeAsync(PLUGIN_CLEANUP_TIMEOUT_MS);
  await finished;
  expect(trace).toStrictEqual([19]);
  expect(h.channels.has("plugin:catalog:query")).toEqual(false);
  expect(warning).toHaveBeenCalledWith("[plugin:catalog] 清理资源时发生 1 个错误",
    [expect.objectContaining({ message: expect.stringContaining("onDispose 清理超时") })]);
});

it("qualifies custom events and removes host subscriptions on disposal", async () => {
  const bus = createPluginEventBus();
  const plugin = createContext("catalog", directory, host().runtime, bus);
  const payloads: unknown[] = [];
  plugin.events.on("host:runtime:ready", payload => { payloads.push(payload); });
  bus.on("plugin:catalog:revision", payload => { payloads.push(payload); });
  await bus.emit("host:runtime:ready", { ready: true });
  await plugin.events.emit("revision", { sequence: 19 });
  await plugin.dispose();
  await bus.emit("host:runtime:ready", { ready: false });
  expect(payloads).toStrictEqual([{ ready: true }, { sequence: 19 }]);
});

it("reports unsubscribe failure without skipping other cleanup", async () => {
  const cleanup = vi.fn();
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const plugin = createContext("catalog", directory, host().runtime, {
    on: () => () => { throw new Error("subscription removal failed"); }, emit: async () => {},
  });
  plugin.events.on("host:runtime:ready", () => {});
  plugin.onDispose(cleanup);
  await plugin.dispose();
  expect(cleanup).toHaveBeenCalledTimes(1);
  expect(warning).toHaveBeenCalledWith("[plugin:catalog] 清理资源时发生 1 个错误",
    [expect.objectContaining({ message: "subscription removal failed" })]);
});

it("owns its prompt providers and removes their content at disposal", async () => {
  const h = host();
  const plugin = context(h.runtime);
  const request = { source: "conversation" as const, mode: "chat" as const, userText: "Review" };
  plugin.registerPromptProvider({ id: "overview", provide: () => "Catalog context" });
  expect(await h.promptRegistry.build(request)).toContain("Catalog context");
  expect(() => plugin.unregisterPromptProvider("unowned")).toThrow(/不属于当前插件/);
  await plugin.dispose();
  expect(await h.promptRegistry.build(request)).toEqual("");
});

it("provides persistent private storage", () => {
  const plugin = context();
  plugin.storage.set("revision", 19);
  expect(plugin.storage.get<number>("revision")).toEqual(19);
});

it("enforces tool ownership prefixes and refuses to replace a host tool", () => {
  expect(() => context().registerTool({ ...tool(), id: "unowned_lookup" })).toThrow(/catalog_/);
  const h = host();
  h.runtime.toolRegistry.getById = () => ({ id: "catalog_lookup" });
  expect(() => context(h.runtime).registerTool(tool())).toThrow(/已被占用/);
  expect(h.tools).toStrictEqual([]);
});

it("rejects a channel ID already occupied by the host", async () => {
  const h = host();
  h.runtime.channelManager.has = () => true;
  await expect(context(h.runtime, ["channels"]).registerChannelAdapter({ id: "wechat" } as PluginChannelAdapter)).rejects.toThrow(/已被占用/);
});

it("injects channel discovery only when the plugin declares that dependency", () => {
  expect(context().deps.channels).toBeUndefined();
  expect(context(host().runtime, ["channels"]).deps.channels?.has("wechat")).toEqual(false);
});

it("injects declared LLM services, forwards inputs and preserves runGoal identity", async () => {
  const h = host();
  const generateText = vi.fn(async () => "Model response");
  const runGoal = vi.fn();
  h.runtime.llm = { generateText, runGoal } as never;
  expect(context(h.runtime).deps.llm).toBeUndefined();
  const plugin = context(h.runtime, ["llm"]);
  expect(await plugin.deps.llm?.generateText([{ role: "user", content: "Review this" }])).toEqual("Model response");
  expect(generateText).toHaveBeenCalledWith([{ role: "user", content: "Review this" }], expect.anything());
  expect(plugin.deps.llm?.runGoal).toBe(runGoal);
});

it("fails immediately when the host cannot satisfy a declared LLM dependency", () => {
  expect(() => context(host().runtime, ["llm"])).toThrow(/宿主未提供已声明的依赖: llm/);
});

it("uses the host service factory with the plugin ID and resource tracker", async () => {
  const h = host();
  const set = vi.fn(async () => {});
  h.runtime.hostServices = { createForPlugin: ({ pluginId, trackResource }) => {
    expect(pluginId).toEqual("catalog");
    expect(trackResource).toBeDefined();
    return { secrets: { get: async () => "Contract value", set, delete: async () => true } };
  } };
  const plugin = context(h.runtime, ["secrets"]);
  expect(plugin.deps.llm).toBeUndefined();
  await plugin.deps.secrets?.set("credential", "Contract value");
  expect(set).toHaveBeenCalledWith("credential", "Contract value");
});

it("waits for channel unregistration before completing disposal", async () => {
  const h = host();
  let release!: () => void;
  let unregistered = false;
  h.runtime.channelManager.unregister = async () => {
    await new Promise<void>(resolve => { release = resolve; });
    unregistered = true; return true;
  };
  const channel: PluginChannelAdapter = {
    id: "contract-channel", displayName: "Contract", capability: {
      text: true, image: false, audio: false, file: false, video: false, markdown: false, card: false, sticker: false, maxTextLength: 120,
    }, start: async () => {}, stop: async () => {}, onMessage: null, send: async () => ({ ok: true }), getStatus: () => ({ enabled: true, phase: "running" }),
  };
  const plugin = context(h.runtime, ["channels"]);
  await plugin.registerChannelAdapter(channel);
  const finished = plugin.dispose();
  expect(finished).toBeInstanceOf(Promise);
  expect(unregistered).toEqual(false);
  release(); await finished;
  expect(unregistered).toEqual(true);
});

it("rejects attempts to unregister unowned tools, IPC routes and channels", async () => {
  const plugin = context(host().runtime, ["channels"]);
  expect(() => plugin.unregisterTool("host_read")).toThrow(/不属于当前插件/);
  expect(() => plugin.unregisterIpc("unregistered")).toThrow(/不属于当前插件/);
  await expect(plugin.unregisterChannelAdapter("wechat")).rejects.toThrow(/不属于当前插件/);
});
