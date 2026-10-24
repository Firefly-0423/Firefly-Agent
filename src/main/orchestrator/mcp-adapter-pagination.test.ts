import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

type Tool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];
type Page = { tools: Tool[]; nextCursor?: string };
const fixture = vi.hoisted(() => ({
  clients: [] as Array<{ listTools: ReturnType<typeof vi.fn>; callTool: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>; onclose?: () => void }>,
  list: undefined as ((params?: { cursor?: string }) => Promise<Page>) | undefined,
}));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({ Client: class {
  onclose?: () => void;
  connect = vi.fn(async () => {});
  listTools = vi.fn(fixture.list);
  callTool = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
  close = vi.fn(async () => { this.onclose?.(); });
  constructor() { fixture.clients.push(this); }
} }));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({ StdioClientTransport: class { close = vi.fn(async () => {}); } }));
vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({ SSEClientTransport: class { close = vi.fn(async () => {}); } }));
vi.mock("../rag/index", () => ({ searchMemory: vi.fn() }));

import { connectMcpServer, disconnectMcpServer, getMcpServerStates } from "./mcp-adapter";
import { toolRegistry } from "./tools/registry/tool-registry";

const config = { id: "pages", name: "Pages", transport: "stdio" as const, command: "synthetic-never-spawned" };
const tool = (name: string, extra: Partial<Tool> = {}): Tool => ({ name, inputSchema: { type: "object", properties: {} }, ...extra });
const schema: NonNullable<Tool["outputSchema"]> = { type: "object", properties: { count: { type: "integer" } }, required: ["count"] };
function pages(first: Tool[] = [tool("first")], second: Tool[] = [tool("second")]) {
  fixture.list = async (params) => params?.cursor === "next" ? { tools: second } : { tools: first, nextCursor: "next" };
}
function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function settleMicrotasks() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function expectUnpublished() {
  expect(toolRegistry.getAllTools().filter(t => t.id.startsWith("pages-"))).toEqual([]);
  expect(getMcpServerStates()).toEqual([]);
  expect(fixture.clients[0].close).toHaveBeenCalledOnce();
}

describe("complete bounded MCP discovery", () => {
  beforeEach(() => {
    fixture.clients = [];
    fixture.list = async () => ({ tools: [tool("first")] });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(async () => {
    vi.useRealTimers();
    for (const state of getMcpServerStates()) await disconnectMcpServer(state.id);
    for (const entry of toolRegistry.getAllTools()) toolRegistry.unregister(entry.id);
    vi.restoreAllMocks();
  });

  it("registers every page only after discovery, with cursor/options separate from arguments", async () => {
    const last = gate<Page>();
    fixture.list = async params => params?.cursor === "next" ? last.promise : { tools: [tool("first")], nextCursor: "next" };
    const connected = connectMcpServer(config);
    await settleMicrotasks();
    const unpublished = toolRegistry.getById("pages-first");
    last.resolve({ tools: [tool("second")] });
    const ids = await connected;
    expect(unpublished).toBeUndefined();
    expect(ids).toEqual(["pages-first", "pages-second"]);
    expect(fixture.clients[0].listTools.mock.calls.map(call => call[0])).toEqual([undefined, { cursor: "next" }]);
    expect(fixture.clients[0].listTools.mock.calls[1][1].signal).toBeInstanceOf(AbortSignal);
    const controller = new AbortController();
    expect(await toolRegistry.getById("pages-second")!.execute({ query: "safe" }, { userQuery: "test", signal: controller.signal })).toBe("ok");
    expect(fixture.clients[0].callTool).toHaveBeenCalledWith({ name: "second", arguments: { query: "safe" } }, undefined, { signal: controller.signal });
  });

  it("follows a cursor after an empty page", async () => {
    pages([]);
    expect(await connectMcpServer(config)).toEqual(["pages-second"]);
  });

  it("keeps single-page servers working and releases the deadline timer", async () => {
    vi.useFakeTimers();
    expect(await connectMcpServer(config)).toEqual(["pages-first"]);
    expect(fixture.clients[0].listTools).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not publish the first page if a later page fails", async () => {
    fixture.list = async params => {
      if (params?.cursor) throw Error("second page unavailable");
      return { tools: [tool("first")], nextCursor: "next" };
    };
    await expect(connectMcpServer(config)).rejects.toThrow("second page unavailable");
    expectUnpublished();
  });

  it.each(["cycle", "duplicate"])("rejects a %s without publishing a partial catalog", async kind => {
    fixture.list = async params => params?.cursor
      ? { tools: [tool(kind === "duplicate" ? "first" : "second")], ...(kind === "cycle" ? { nextCursor: "next" } : {}) }
      : { tools: [tool("first")], nextCursor: "next" };
    await expect(connectMcpServer(config)).rejects.toThrow(kind === "cycle" ? /cursor/i : /duplicate/i);
    expectUnpublished();
  });

  it("bounds catalogs to 10,000 tools", async () => {
    fixture.list = async () => ({ tools: Array.from({ length: 10_001 }, (_, i) => tool(`tool${i}`)) });
    await expect(connectMcpServer(config)).rejects.toThrow(/tool.*limit/i);
    expectUnpublished();
  });

  it("bounds cursor traversal to 100 pages", async () => {
    let page = 0;
    fixture.list = async () => ({ tools: [], nextCursor: `cursor-${++page}` });
    await expect(connectMcpServer(config)).rejects.toThrow(/page.*limit/i);
    expect(fixture.clients[0].listTools).toHaveBeenCalledTimes(100);
    expectUnpublished();
  });

  it("expires an unresponsive discovery after 60 seconds, even if the transport ignores cancellation", async () => {
    vi.useFakeTimers();
    const pending = gate<Page>();
    fixture.list = () => pending.promise;
    let settled = false;
    const result = connectMcpServer(config).then(() => undefined, error => error as Error).then(value => { settled = true; return value; });
    await settleMicrotasks();
    try {
      await vi.advanceTimersByTimeAsync(60_001);
      expect(settled).toBe(true);
      expect(await result).toBeInstanceOf(Error);
      expect((await result)?.message).toMatch(/deadline/i);
      expect(fixture.clients[0].listTools.mock.calls[0][1].signal.aborted).toBe(true);
      expectUnpublished();
    } finally {
      pending.resolve({ tools: [tool("late")] });
      await result;
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects promptly when the connection closes during a pending page and ignores late results", async () => {
    const pending = gate<Page>();
    fixture.list = () => pending.promise;
    let settled = false;
    const result = connectMcpServer(config).then(() => undefined, error => error as Error).then(value => { settled = true; return value; });
    await settleMicrotasks();
    fixture.clients[0].onclose?.();
    try {
      await settleMicrotasks();
      expect(settled).toBe(true);
      expect((await result)?.message).toMatch(/closed/i);
    } finally {
      pending.resolve({ tools: [tool("late")] });
      await result;
    }
    expectUnpublished();
  });

  it.each(["first", "second"])("validates valid structured results from the %s page", async name => {
    pages([tool("first", { outputSchema: schema })], [tool("second", { outputSchema: schema })]);
    await connectMcpServer(config);
    fixture.clients[0].callTool.mockResolvedValue({ content: [{ type: "text", text: "valid" }], structuredContent: { count: 2 } });
    expect(await toolRegistry.getById(`pages-${name}`)!.execute({})).toBe("valid");
  });

  it.each(["first", "second"])("rejects invalid or missing structured results from the %s page", async name => {
    pages([tool("first", { outputSchema: schema })], [tool("second", { outputSchema: schema })]);
    await connectMcpServer(config);
    const entry = toolRegistry.getById(`pages-${name}`);
    expect(entry).toBeDefined();
    fixture.clients[0].callTool.mockResolvedValue({ content: [], structuredContent: { count: "wrong" } });
    await expect(entry!.execute({})).rejects.toThrow(/output schema/i);
    fixture.clients[0].callTool.mockResolvedValue({ content: [] });
    await expect(entry!.execute({})).rejects.toThrow(/structured content/i);
  });

  it("allows an error to omit structured content but still validates any content supplied", async () => {
    pages([tool("first", { outputSchema: schema })]);
    await connectMcpServer(config);
    const entry = toolRegistry.getById("pages-first")!;
    fixture.clients[0].callTool.mockResolvedValue({ isError: true, content: [{ type: "text", text: "server refused" }] });
    await expect(entry.execute({})).rejects.toThrow("server refused");
    fixture.clients[0].callTool.mockResolvedValue({ isError: true, content: [], structuredContent: { count: "wrong" } });
    await expect(entry.execute({})).rejects.toThrow(/output schema/i);
  });

  it.each(["first", "second"])("does not invoke a required-task tool on the %s page as an ordinary call", async name => {
    pages([tool("first", { execution: { taskSupport: "required" } })], [tool("second", { execution: { taskSupport: "required" } })]);
    await connectMcpServer(config);
    const entry = toolRegistry.getById(`pages-${name}`);
    expect(entry).toBeDefined();
    await expect(entry!.execute({})).rejects.toThrow(/task.*required|required.*task/i);
    expect(fixture.clients[0].callTool).not.toHaveBeenCalled();
  });

  it("rejects conflicting output schemas with the same $id across pages", async () => {
    const $id = "https://example.invalid/test-output";
    pages([tool("first", { outputSchema: { ...schema, $id } })],
      [tool("second", { outputSchema: { type: "object", $id, properties: { count: { type: "string" } }, required: ["count"] } })]);
    await expect(connectMcpServer(config)).rejects.toThrow(/conflicting.*schema/i);
    expectUnpublished();
  });

  it("accepts identical output schemas with the same $id without weakening validation", async () => {
    const identified = { ...schema, $id: "https://example.invalid/shared-output" };
    pages([tool("first", { outputSchema: identified })], [tool("second", { outputSchema: structuredClone(identified) })]);
    await connectMcpServer(config);
    fixture.clients[0].callTool.mockResolvedValue({ content: [], structuredContent: { count: "wrong" } });
    await expect(toolRegistry.getById("pages-first")!.execute({})).rejects.toThrow(/output schema/i);
    await expect(toolRegistry.getById("pages-second")!.execute({})).rejects.toThrow(/output schema/i);
  });
  it.each(["#", "#/"])("rejects conflicting schema resource aliases ending in %s in either page order", async suffix => {
    for (const reverse of [false, true]) {
      const $id = "https://example.invalid/aliased-output";
      const definitions = [tool("first", { outputSchema: { ...schema, $id } }),
        tool("second", { outputSchema: { type: "object", $id: $id + suffix, properties: { count: { type: "string" } }, required: ["count"] } })];
      if (reverse) definitions.reverse();
      pages([definitions[0]], [definitions[1]]);
      await expect(connectMcpServer(config)).rejects.toThrow(/conflicting.*schema/i);
      expectUnpublished();
      fixture.clients = [];
    }
  });
  it("accepts equivalent schemas whose root $id only differs by an empty fragment", async () => {
    const $id = "https://example.invalid/equivalent-output";
    pages([tool("first", { outputSchema: { ...schema, $id } })], [tool("second", { outputSchema: { ...schema, $id: $id + "#/" } })]);
    expect(await connectMcpServer(config)).toEqual(["pages-first", "pages-second"]);
    fixture.clients[0].callTool.mockResolvedValue({ content: [], structuredContent: { count: "wrong" } });
    await expect(toolRegistry.getById("pages-second")!.execute({})).rejects.toThrow(/output schema/i);
  });
  it("resolves a nested relative $id before rejecting a conflicting root resource", async () => {
    pages([tool("first", { outputSchema: { type: "object", $id: "https://example.invalid/one/source", definitions: {
      nested: { ...schema, $id: "nested" } } } })],
    [tool("second", { outputSchema: { type: "object", $id: "https://example.invalid/one/nested", properties: { count: { type: "string" } } } })]);
    await expect(connectMcpServer(config)).rejects.toThrow(/conflicting.*schema/i);
    expectUnpublished();
  });
  it("does not conflate relative IDs resolved against different bases", async () => {
    pages([tool("first", { outputSchema: { type: "object", $id: "https://example.invalid/one/source", definitions: {
      nested: { ...schema, $id: "nested" } } } })],
    [tool("second", { outputSchema: { type: "object", $id: "https://example.invalid/two/nested", properties: { count: { type: "string" } } } })]);
    expect(await connectMcpServer(config)).toEqual(["pages-first", "pages-second"]);
  });
  it("does not treat an $id inside a const value as a schema resource", async () => {
    const $id = "https://example.invalid/literal-data";
    pages([tool("first", { outputSchema: { type: "object", properties: { literal: { const: { $id, value: "data" } } } } })],
      [tool("second", { outputSchema: { ...schema, $id } })]);
    expect(await connectMcpServer(config)).toEqual(["pages-first", "pages-second"]);
  });
});
