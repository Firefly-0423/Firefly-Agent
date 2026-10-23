import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "./tools/registry/tool-registry";
const fixture = vi.hoisted(() => ({
  clients: [] as Array<{ connect: ReturnType<typeof vi.fn>; listTools: ReturnType<typeof vi.fn>; callTool: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; onclose?: () => void }>,
  transports: [] as Array<{ close: ReturnType<typeof vi.fn> }>,
  tools: [] as Array<Record<string, unknown>>,
  registry: new Map<string, ToolDefinition>(),
  connectError: undefined as Error | undefined,
  discoveryError: undefined as Error | undefined,
}));
vi.mock("./tools/registry/tool-registry", () => ({ toolRegistry: {
  getById: (id: string) => fixture.registry.get(id),
  register: (tool: ToolDefinition) => { fixture.registry.set(tool.id, tool); },
  unregister: (id: string) => { fixture.registry.delete(id); },
} }));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({ Client: class {
  connect = vi.fn(async () => { if (fixture.connectError) throw fixture.connectError; });
  listTools = vi.fn(async () => { if (fixture.discoveryError) throw fixture.discoveryError; return { tools: fixture.tools }; });
  callTool = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
  close = vi.fn(async () => { this.onclose?.(); });
  onclose?: () => void;
  constructor() { fixture.clients.push(this); }
} }));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({ StdioClientTransport: class {
  close = vi.fn(async () => {});
  constructor() { fixture.transports.push(this); }
} }));
vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({ SSEClientTransport: class {
  close = vi.fn(async () => {});
  constructor() { fixture.transports.push(this); }
} }));
import { connectMcpServer, disconnectMcpServer, getMcpServerStates, type McpServerConfig } from "./mcp-adapter";
import { ToolExecutionError } from "./tools/registry/tool-execution-error";
import type { ToolContext } from "./tools/registry/tool-context";
const config: McpServerConfig = { id: "unit", name: "Fixture", transport: "stdio", command: "fixture-command" };
const tool = (extra: Record<string, unknown> = {}) => ({ name: "inspect", inputSchema: { type: "object", properties: { path: { type: "string", description: "path" } }, required: ["path"] }, ...extra });
const execute = (args = {}, ctx?: ToolContext) => fixture.registry.get("unit-inspect")!.execute(args, ctx);
beforeEach(() => {
  fixture.clients.length = 0; fixture.transports.length = 0; fixture.registry.clear(); fixture.tools = [tool()];
  fixture.connectError = undefined; fixture.discoveryError = undefined;
  for (const method of ["log", "warn", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(async () => {
  for (const client of fixture.clients) client.close.mockImplementation(async () => { client.onclose?.(); });
  for (const transport of fixture.transports) transport.close.mockResolvedValue(undefined);
  for (const state of getMcpServerStates()) await disconnectMcpServer(state.id);
  fixture.registry.clear(); vi.restoreAllMocks();
});

describe("MCP adapter", () => {
  it.each([
    [{ ...config, command: undefined }, "stdio transport requires command"],
    [{ ...config, transport: "sse", url: undefined }, "sse transport requires url"],
  ] as const)("rejects missing transport configuration %#", async (input, message) => {
    await expect(connectMcpServer(input)).rejects.toThrow(new Error(message));
    expect(getMcpServerStates()).toEqual([]);
  });

  it("registers the discovered tool and exposes defensive state and ID arrays", async () => {
    expect(await connectMcpServer(config)).toEqual(["unit-inspect"]);
    expect(fixture.registry.get("unit-inspect")).toMatchObject({ id: "unit-inspect", name: "[Fixture] inspect", description: "inspect", enabled: true, needsContext: true, effectKind: "unknown", risk: "input-control", inputSchema: tool().inputSchema });
    const states = getMcpServerStates(); states[0].toolIds.length = 0;
    const ids = await connectMcpServer({ ...config, args: [], env: {} }); ids.length = 0;
    expect(getMcpServerStates()).toEqual([{ id: "unit", name: "Fixture", connected: true, toolCount: 1, toolIds: ["unit-inspect"] }]);
    expect(fixture.clients).toHaveLength(1);
  });

  it.each(["connect", "discovery"])("cleans up a failed %s and allows a subsequent connection", async phase => {
    const failure = new Error(`${phase} failed`);
    if (phase === "connect") fixture.connectError = failure; else fixture.discoveryError = failure;
    await expect(connectMcpServer(config)).rejects.toBe(failure);
    expect(getMcpServerStates()).toEqual([]); expect(fixture.registry.size).toBe(0);
    if (phase === "connect") expect(fixture.transports[0].close).toHaveBeenCalledOnce();
    else expect(fixture.clients[0].close).toHaveBeenCalledOnce();
    fixture.connectError = undefined; fixture.discoveryError = undefined;
    expect(await connectMcpServer(config)).toEqual(["unit-inspect"]);
  });

  it("rejects a malformed SSE URL without publishing state", async () => {
    await expect(connectMcpServer({ ...config, transport: "sse", url: "invalid" })).rejects.toMatchObject({ code: "ERR_INVALID_URL" });
    expect(getMcpServerStates()).toEqual([]);
  });

  it.each([
    [undefined, undefined, "unknown", "input-control"],
    [{ readOnlyHint: true }, undefined, "unknown", "input-control"],
    [{ readOnlyHint: true, destructiveHint: true }, undefined, "external_side_effect", "input-control"],
    [{ destructiveHint: true }, "read", "read", "network"],
    [undefined, "verification", "verification", "network"],
    [undefined, "mutation", "mutation", "fs-write"],
    [undefined, "external_side_effect", "external_side_effect", "input-control"],
    [undefined, "invalid", "unknown", "input-control"],
  ])("maps conservative annotation and local override risks %#", async (annotations, override, effectKind, risk) => {
    fixture.tools = [tool({ annotations })];
    await connectMcpServer({ ...config, effectKindOverrides: override === undefined ? undefined : { inspect: override } as never });
    expect(fixture.registry.get("unit-inspect")).toMatchObject({ effectKind, risk });
  });

  it("coalesces identical pending connections and serializes changed connections", async () => {
    const first = connectMcpServer(config), duplicate = connectMcpServer({ ...config });
    expect(await first).toEqual(["unit-inspect"]); expect(await duplicate).toEqual(["unit-inspect"]);
    expect(fixture.clients).toHaveLength(1);
    const old = fixture.clients[0];
    await connectMcpServer({ ...config, args: ["changed"] });
    expect(old.close).toHaveBeenCalledOnce(); expect(fixture.clients).toHaveLength(2);
    expect(await execute()).toBe("ok");
  });

  it("enforces connection ownership and ignores stale-owner disconnects", async () => {
    const owner = {}, other = {};
    await connectMcpServer(config, owner);
    await expect(connectMcpServer(config, other)).rejects.toThrow(new Error("MCP connection ownership conflict"));
    expect(await disconnectMcpServer(config.id, other)).toBe(false);
    expect(getMcpServerStates()[0].connected).toBe(true);
    expect(await disconnectMcpServer(config.id, owner)).toBe(true);
    expect(await disconnectMcpServer(config.id)).toBe(false);
  });

  it("preserves tools owned by another registrar on collision and disconnect", async () => {
    const external = { id: "unit-inspect" } as ToolDefinition;
    fixture.registry.set(external.id, external);
    expect(await connectMcpServer(config)).toEqual([]);
    await disconnectMcpServer(config.id);
    expect(fixture.registry.get(external.id)).toBe(external);
  });

  it("joins text blocks in order and ignores other content types", async () => {
    await connectMcpServer(config);
    fixture.clients[0].callTool.mockResolvedValue({ content: [{ type: "text", text: "first" }, null, { type: "image", data: "x" }, { type: "text", text: 42 }] });
    expect(await execute({ path: "file" })).toBe("first\n42");
    expect(fixture.clients[0].callTool).toHaveBeenCalledWith({ name: "inspect", arguments: { path: "file" } });
    fixture.clients[0].callTool.mockResolvedValue({ content: [{ type: "image", data: "x" }] });
    expect(await execute()).toBe('[{"type":"image","data":"x"}]');
  });

  it("turns a tool-level error result into a non-retryable semantic error", async () => {
    await connectMcpServer(config);
    fixture.clients[0].callTool.mockResolvedValue({ content: [{ type: "text", text: "bad" }], isError: true });
    await expect(execute()).rejects.toBeInstanceOf(ToolExecutionError);
    await expect(execute()).rejects.toMatchObject({ code: "E_MCP_TOOL_FAILED", category: "semantic_failure", retryable: false, effectState: "unknown", message: "E_MCP_TOOL_FAILED: bad" });
  });

  it.each([new Error("offline"), "failure"])("keeps only a content-free reason when a call rejects %#", async (rejection) => {
    await connectMcpServer(config);
    fixture.clients[0].callTool.mockRejectedValue(rejection);
    await expect(execute()).rejects.toBeInstanceOf(ToolExecutionError);
    await expect(execute()).rejects.toMatchObject({ code: "E_MCP_TOOL_FAILED", category: "transient", retryable: false, effectState: "unknown", message: "E_MCP_TOOL_FAILED: transport (failed)" });
  });

  it("rejects required task execution without calling the remote tool", async () => {
    fixture.tools = [tool({ execution: { taskSupport: "required" } })];
    await connectMcpServer(config);
    await expect(execute()).rejects.toMatchObject({ code: "E_MCP_TOOL_FAILED", message: "E_MCP_TOOL_FAILED: MCP task execution required for tool inspect" });
    expect(fixture.clients[0].callTool).not.toHaveBeenCalled();
  });

  it("validates structured output before returning remote content", async () => {
    fixture.tools = [tool({ outputSchema: { type: "object", properties: { count: { type: "number" } }, required: ["count"] } })];
    await connectMcpServer(config);
    fixture.clients[0].callTool.mockResolvedValue({ content: [{ type: "text", text: "valid" }], structuredContent: { count: 1 } });
    expect(await execute()).toBe("valid");
    fixture.clients[0].callTool.mockResolvedValue({ content: [{ type: "text", text: "invalid" }] });
    await expect(execute()).rejects.toMatchObject({ code: "E_MCP_TOOL_FAILED", message: "E_MCP_TOOL_FAILED: MCP tool inspect did not return required structured content" });
  });

  it("passes cancellation separately from arguments and rejects already aborted calls", async () => {
    await connectMcpServer(config);
    const controller = new AbortController(); const ctx = { signal: controller.signal } as ToolContext;
    expect(await execute({ path: "x" }, ctx)).toBe("ok");
    expect(fixture.clients[0].callTool).toHaveBeenCalledWith({ name: "inspect", arguments: { path: "x" } }, undefined, { signal: controller.signal });
    controller.abort();
    await expect(execute({}, ctx)).rejects.toMatchObject({ name: "AbortError" });
    expect(fixture.clients[0].callTool).toHaveBeenCalledTimes(1);
  });

  it("invalidates held tool closures after disconnect or unsolicited close", async () => {
    await connectMcpServer(config); const held = fixture.registry.get("unit-inspect")!;
    fixture.clients[0].onclose?.();
    expect(getMcpServerStates()).toEqual([]); expect(fixture.registry.size).toBe(0);
    await expect(held.execute({})).rejects.toMatchObject({ message: "E_MCP_TOOL_FAILED: MCP connection is no longer owned" });
  });

  it("rejects tool results arriving after the connection was closed", async () => {
    await connectMcpServer(config);
    let complete!: (value: unknown) => void;
    fixture.clients[0].callTool.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const result = execute(); fixture.clients[0].onclose?.();
    complete({ content: [{ type: "text", text: "late" }] });
    await expect(result).rejects.toMatchObject({ code: "E_MCP_TOOL_FAILED", message: "E_MCP_TOOL_FAILED: MCP connection is no longer owned" });
  });

  it("cancels an in-flight request even when the client ignores its signal", async () => {
    await connectMcpServer(config);
    fixture.clients[0].callTool.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const result = execute({}, { signal: controller.signal } as ToolContext);
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
  });

  it("falls back to transport cleanup and retains failed cleanup resources for retry", async () => {
    await connectMcpServer(config);
    fixture.clients[0].close.mockRejectedValue(new Error("client close failed"));
    fixture.transports[0].close.mockRejectedValueOnce(new Error("transport close failed"));
    await expect(disconnectMcpServer(config.id)).rejects.toThrow(new Error("transport close failed"));
    expect(getMcpServerStates()).toEqual([{ id: "unit", name: "Fixture", connected: false, toolCount: 0, toolIds: [] }]);
    expect(await disconnectMcpServer(config.id)).toBe(true);
    expect(fixture.transports[0].close).toHaveBeenCalledTimes(2);
    expect(getMcpServerStates()).toEqual([]);
  });
});
