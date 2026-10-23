import { afterEach, expect, it, vi } from "vitest";
import { createPluginPromptRegistry, MAX_PLUGIN_PROMPT_CHARS, MAX_PLUGIN_PROMPT_TOTAL_CHARS, PLUGIN_PROMPT_PROVIDER_TIMEOUT_MS } from "./prompts";
import type { PluginPromptBuildInput, PluginPromptSource } from "./types";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const signal = () => new AbortController().signal;
const input = (source: PluginPromptBuildInput["source"] = "conversation", mode: PluginPromptBuildInput["mode"] = "chat"): PluginPromptBuildInput => ({ source, mode, userText: "Review" });

it("rejects retired prompt sources and modes at registration", () => {
  const registry = createPluginPromptRegistry();
  expect(() => registry.register("obsolete", { id: "history", sources: ["moments-post"] as never, provide: () => "Excluded" }, signal())).toThrow(/sources/);
  expect(() => registry.register("obsolete", { id: "study", modes: ["learn"], provide: () => "Excluded" } as never, signal())).toThrow("modes 含未知模式");
});

it("filters by mode while keeping namespaced provider content exact", async () => {
  const registry = createPluginPromptRegistry();
  registry.register("catalog", { id: "overview", modes: ["chat"], provide: ({ userText }) => "Catalog:" + userText }, signal());
  registry.register("planner", { id: "overview", modes: ["work"], provide: async ({ source }) => "Planner:" + source }, signal());
  expect(await registry.build(input())).toEqual("[插件上下文：plugin:catalog:overview]\nCatalog:Review");
  expect(await registry.build(input("scheduler", "work"))).toEqual("[插件上下文：plugin:planner:overview]\nPlanner:scheduler");
});

it("rejects duplicate or unsafe short IDs but permits the same ID under another owner", () => {
  const registry = createPluginPromptRegistry();
  const provider = { id: "overview", provide: () => "Catalog ready" };
  registry.register("catalog", provider, signal());
  expect(() => registry.register("catalog", provider, signal())).toThrow(/已注册/);
  expect(() => registry.register("planner", provider, signal())).not.toThrow();
  expect(() => registry.register("catalog", { ...provider, id: "../escape" }, signal())).toThrow(/非法/);
});

it("omits a failed provider and logs it once while preserving successful content", async () => {
  const registry = createPluginPromptRegistry();
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  registry.register("unavailable", { id: "overview", provide: () => { throw new Error("catalog unavailable"); } }, signal());
  registry.register("available", { id: "overview", provide: () => "Catalog retained" }, signal());
  const text = await registry.build(input());
  expect(text).toContain("Catalog retained");
  expect(text).not.toContain("unavailable:overview]");
  expect(warning).toHaveBeenCalledTimes(1);
});

it("times out a hung provider without blocking an available provider", async () => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const registry = createPluginPromptRegistry();
  registry.register("blocked", { id: "overview", provide: () => new Promise<string>(() => {}) }, signal());
  registry.register("available", { id: "overview", provide: () => "Available context" }, signal());
  const building = registry.build(input());
  await vi.advanceTimersByTimeAsync(PLUGIN_PROMPT_PROVIDER_TIMEOUT_MS);
  await expect(building).resolves.toContain("Available context");
});

it("honors owner cancellation, explicit removal and the per-provider character budget", async () => {
  const registry = createPluginPromptRegistry();
  const owner = new AbortController();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  registry.register("catalog", { id: "long", provide: () => "q".repeat(MAX_PLUGIN_PROMPT_CHARS + 23) }, owner.signal);
  registry.register("planner", { id: "overview", provide: () => "Removed context" }, signal());
  expect(registry.unregister("unrelated", "overview")).toEqual(false);
  expect(registry.unregister("planner", "overview")).toEqual(true);
  const text = await registry.build(input());
  expect(text).toContain("q".repeat(MAX_PLUGIN_PROMPT_CHARS));
  expect(text).not.toContain("Removed context");
  owner.abort();
  expect(await registry.build(input())).toEqual("");
});

it("counts headings and separators in the total context budget", async () => {
  const registry = createPluginPromptRegistry();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  for (const id of ["primary", "secondary", "tertiary"]) registry.register("catalog", { id, provide: () => "q".repeat(MAX_PLUGIN_PROMPT_CHARS) }, signal());
  const text = await registry.build(input());
  expect(text.length).toEqual(MAX_PLUGIN_PROMPT_TOTAL_CHARS);
  expect(text).toContain("plugin:catalog:primary");
  expect(text).toContain("plugin:catalog:secondary");
  expect(text).not.toContain("plugin:catalog:tertiary");
});

it("keeps undeclared sources limited to conversation and scheduler", async () => {
  const registry = createPluginPromptRegistry();
  registry.register("catalog", { id: "legacy", provide: () => "Legacy context" }, signal());
  expect(await registry.build(input("plugin-agent", "work"))).toEqual("");
  for (const source of ["scheduler", "conversation"] as const) {
    expect(await registry.build(input(source))).toEqual("[插件上下文：plugin:catalog:legacy]\nLegacy context");
  }
});

it("applies both explicit source and mode selection to plugin-agent", async () => {
  const registry = createPluginPromptRegistry();
  registry.register("planner", { id: "goal", sources: ["plugin-agent"], modes: ["work"],
    provide: ({ source, mode, userText }) => `${source}|${mode}|${userText}` }, signal());
  registry.register("catalog", { id: "chat", sources: ["conversation"], provide: () => "Chat context" }, signal());
  expect(await registry.build(input("plugin-agent", "work"))).toEqual("[插件上下文：plugin:planner:goal]\nplugin-agent|work|Review");
  expect(await registry.build(input("plugin-agent", "code"))).toEqual("");
  expect(await registry.build(input())).toEqual("[插件上下文：plugin:catalog:chat]\nChat context");
});

it("filters mode consistently for providers declaring multiple sources", async () => {
  const registry = createPluginPromptRegistry();
  registry.register("catalog", { id: "mixed", sources: ["conversation", "plugin-agent"], modes: ["chat"], provide: ({ source }) => "Mixed:" + source }, signal());
  expect(await registry.build(input("conversation", "work"))).toEqual("");
  expect(await registry.build(input("plugin-agent", "work"))).toEqual("");
  expect(await registry.build(input())).toEqual("[插件上下文：plugin:catalog:mixed]\nMixed:conversation");
});

it("rejects every malformed source declaration without reserving its provider ID", async () => {
  const registry = createPluginPromptRegistry();
  for (const sources of [false, 0, "plugin-agent", [], ["unknown-source"], ["moments-post"]]) {
    expect(() => registry.register("catalog", { id: "validated", sources: sources as PluginPromptSource[], provide: () => "Excluded" }, signal())).toThrow(/sources/);
  }
  registry.register("catalog", { id: "validated", sources: ["plugin-agent"], provide: () => "Validated context" }, signal());
  expect(await registry.build(input("plugin-agent", "work"))).toEqual("[插件上下文：plugin:catalog:validated]\nValidated context");
});
