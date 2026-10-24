import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({ StdioClientTransport: class { async close() {} } }));
vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({ SSEClientTransport: class { async close() {} } }));
vi.mock("../rag/index", () => ({ searchMemory: vi.fn() }));
import { connectMcpServer, disconnectMcpServer, getMcpServerStates } from "./mcp-adapter";
import { toolRegistry } from "./tools/registry/tool-registry";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(Client.prototype, "connect").mockResolvedValue(undefined);
});
afterEach(async () => {
  for (const state of getMcpServerStates()) await disconnectMcpServer(state.id);
  vi.restoreAllMocks();
});

it("rejects conflicting nested schema resources before publishing tools with the real SDK", async () => {
  const $id = "https://example.invalid/nested-resource";
  const tool = (name: string, outputSchema: ListToolsResult["tools"][number]["outputSchema"]) => ({ name, inputSchema: { type: "object" as const }, outputSchema });
  const first = tool("first", { type: "object", definitions: { payload: { $id, type: "object", properties: { count: { type: "integer" } }, required: ["count"] } } });
  const second = tool("second", { type: "object", $id, properties: { count: { type: "string" } }, required: ["count"] });
  vi.spyOn(Client.prototype, "request").mockImplementation(async request => {
    if (request.method === "tools/list") return request.params?.cursor ? { tools: [second] } : { tools: [first], nextCursor: "next" };
    if (request.method === "tools/call") throw Error("Conflicting catalog must not dispatch");
    throw Error("Unexpected offline request");
  });
  await expect(connectMcpServer({ id: "real-sdk", name: "Offline SDK", transport: "stdio", command: "synthetic-never-spawned" })).rejects.toThrow(/conflicting.*schema/i);
  expect(toolRegistry.getById("real-sdk-first")).toBeUndefined();
  expect(toolRegistry.getById("real-sdk-second")).toBeUndefined();
  expect(getMcpServerStates()).toEqual([]);
});

it("preserves valid references to another catalog schema with a distinct resource ID", async () => {
  const first = { name: "source", inputSchema: { type: "object" as const }, outputSchema: { type: "object" as const,
    $id: "https://example.invalid/source-schema", properties: { count: { type: "integer" } }, required: ["count"] } };
  const second = { name: "consumer", inputSchema: { type: "object" as const }, outputSchema: { type: "object" as const,
    $id: "https://example.invalid/consumer-schema", allOf: [{ $ref: "https://example.invalid/source-schema" }] } };
  vi.spyOn(Client.prototype, "request").mockImplementation(async request => {
    if (request.method === "tools/list") return request.params?.cursor ? { tools: [second] } : { tools: [first], nextCursor: "next" };
    if (request.method === "tools/call") return { content: [{ type: "text", text: "valid reference" }], structuredContent: { count: 2 } };
    throw Error("Unexpected offline request");
  });
  await connectMcpServer({ id: "real-sdk-refs", name: "Offline refs", transport: "stdio", command: "synthetic-never-spawned" });
  expect(await toolRegistry.getById("real-sdk-refs-consumer")!.execute({})).toBe("valid reference");
});

it("keeps local anchors in independent anonymous schemas scoped to their own document", async () => {
  const first = { name: "integer", inputSchema: { type: "object" as const }, outputSchema: { type: "object" as const,
    $defs: { value: { $anchor: "payload", type: "integer" } }, properties: { count: { $ref: "#payload" } }, required: ["count"] } };
  const second = { name: "string", inputSchema: { type: "object" as const }, outputSchema: { type: "object" as const,
    $defs: { value: { $anchor: "payload", type: "string" } }, properties: { count: { $ref: "#payload" } }, required: ["count"] } };
  vi.spyOn(Client.prototype, "request").mockImplementation(async request => {
    if (request.method === "tools/list") return request.params?.cursor ? { tools: [second] } : { tools: [first], nextCursor: "next" };
    if (request.method === "tools/call") return { content: [{ type: "text", text: "local reference" }], structuredContent: { count: "valid" } };
    throw Error("Unexpected offline request");
  });
  await connectMcpServer({ id: "real-sdk-local", name: "Offline local refs", transport: "stdio", command: "synthetic-never-spawned" });
  expect(await toolRegistry.getById("real-sdk-local-string")!.execute({})).toBe("local reference");
});
