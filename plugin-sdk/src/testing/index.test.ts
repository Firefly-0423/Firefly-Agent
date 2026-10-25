import { expect, it } from "vitest";
import { createMockPluginContext, assertPluginTool, assertValidManifest } from "./index";
import type { PluginTool } from "../api";

const tool = (overrides: Partial<PluginTool> = {}): PluginTool => ({
  enabled: true, id: "contract-addon_lookup", name: "lookup", description: "Look up a catalog entry",
  inputSchema: { type: "object", properties: {} }, execute: async () => "found", ...overrides,
});
const manifest = {
  apiVersion: 1, id: "contract-addon", name: "Catalog contract", version: "2.3.4",
  description: "Catalog lookup fixture", author: "Contract suite", entry: "entry.cjs",
};

it("records registered resources, emitted events and removable subscriptions", async () => {
  const context = createMockPluginContext({ pluginId: "contract-addon" });
  context.registerTool(tool());
  context.registerPromptProvider({ id: "catalog", provide: () => "Catalog available" });
  context.registerIpc("lookup", () => "entry found");
  const cancel = context.events.on("host:turn:finished", () => {});
  await context.events.emit("catalog-changed", { revision: 4 });
  expect(context.tools).toHaveLength(1);
  expect(context.promptProviders[0]?.id).toEqual("catalog");
  expect(context.ipcChannels.get("lookup")?.()).toEqual("entry found");
  expect(context.subscriptions.map(record => record.event)).toStrictEqual(["host:turn:finished"]);
  expect(context.emittedEvents).toStrictEqual([{ payload: { revision: 4 }, event: "catalog-changed" }]);
  cancel();
  expect(context.subscriptions).toHaveLength(0);
});

it("provides isolated memory storage and the documented mock root", () => {
  const context = createMockPluginContext();
  context.storage.set("revision", 19);
  expect(context.storage.get<number>("revision")).toEqual(19);
  expect(context.storage.get("unwritten")).toBeUndefined();
  expect(context.storage.rootDir()).toEqual("/mock/plugin-data");
});

it("rejects unregister requests for resources the context never registered", () => {
  const context = createMockPluginContext({ pluginId: "contract-addon" });
  expect(() => context.unregisterIpc("unregistered")).toThrow();
  expect(() => context.unregisterPromptProvider("unregistered")).toThrow();
  expect(() => context.unregisterTool("contract-addon_unregistered")).toThrow();
});

it("aborts on disposal and cleans up in reverse registration order", async () => {
  const context = createMockPluginContext();
  const trace: string[] = [];
  context.onDispose(() => { trace.push("opened first"); });
  context.onDispose(() => { trace.push("opened last"); });
  await context.dispose();
  expect(trace).toStrictEqual(["opened last", "opened first"]);
  expect(context.signal.aborted).toEqual(true);
  expect(() => context.registerTool(tool())).toThrow("插件停止后");
});

it("runs remaining cleanup after a failure and makes repeated disposal harmless", async () => {
  const context = createMockPluginContext();
  const trace: number[] = [];
  context.onDispose(() => { trace.push(1); });
  context.onDispose(() => { trace.push(2); throw new Error("cleanup unavailable"); });
  context.onDispose(() => { trace.push(3); });
  await expect(context.dispose()).rejects.toThrow("清理回调抛出 1 个错误");
  await expect(context.dispose()).resolves.toBeUndefined();
  expect(trace).toStrictEqual([3, 2, 1]);
});

it("exposes supplied host dependencies while leaving unspecified capabilities absent", () => {
  const context = createMockPluginContext({
    deps: { secrets: { get: async () => "fixture", set: async () => {}, delete: async () => true } },
  });
  expect(context.deps.secrets).toBeDefined();
  expect(context.deps.llm).toBeUndefined();
});

it("accepts a valid tool and reports every violated tool contract in order", () => {
  expect(() => assertPluginTool(tool(), "contract-addon")).not.toThrow();
  const invalid = tool({ id: "unowned", name: "", description: "", inputSchema: { type: "array" as never, properties: {} }, execute: undefined as never });
  expect(() => assertPluginTool(invalid, "contract-addon")).toThrow(/开头.*name.*description.*inputSchema.*execute/s);
});

it("validates manifest requirements and rejects unsupported dependencies", () => {
  expect(() => assertValidManifest(manifest)).not.toThrow();
  expect(() => assertValidManifest({ ...manifest, entry: undefined })).toThrow();
  expect(() => assertValidManifest({ ...manifest, deps: ["unsupported-host-service"] })).toThrow();
});
