import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServerConfig } from "./mcp-adapter";

const fixture = vi.hoisted(() => ({
  clients: [] as Array<{
    connect: ReturnType<typeof vi.fn>;
    listTools: ReturnType<typeof vi.fn>;
    callTool: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    onclose?: () => void;
  }>,
  transports: [] as Array<{ close: ReturnType<typeof vi.fn> }>,
  configs: [] as McpServerConfig[],
  nextConnect: undefined as (() => Promise<void>) | undefined,
  nextList: undefined as (() => Promise<unknown>) | undefined,
  writeFailure: false,
}));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    connect = vi.fn(fixture.nextConnect ?? (async () => {}));
    listTools = vi.fn(fixture.nextList ?? (async () => ({ tools: [
      { name: "inspect", inputSchema: { type: "object", properties: {} } },
    ] })));
    callTool = vi.fn(async (): Promise<{ content: Array<{ type: string; text: string }> }> => ({ content: [{ type: "text", text: "client-" + fixture.clients.indexOf(this) }] }));
    close = vi.fn(async () => { this.onclose?.(); });
    onclose?: () => void;
    constructor() {
      fixture.nextConnect = undefined;
      fixture.nextList = undefined;
      fixture.clients.push(this);
    }
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class {
    close = vi.fn(async () => {});
    constructor() { fixture.transports.push(this); }
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: class {
    close = vi.fn(async () => {});
    constructor() { fixture.transports.push(this); }
  },
}));
vi.mock("../rag/index", () => ({ searchMemory: vi.fn() }));
vi.mock("../logger", () => ({ logger: { info: vi.fn(), warn: vi.fn() }, LogTag: { MCP: "mcp" } }));
vi.mock("../storage-context", () => ({ getStorageContext: () => ({ files: { mcp: "synthetic" } }) }));
vi.mock("../atomic-json-store", () => ({
  AtomicJsonStore: class {
    read() { return structuredClone(fixture.configs); }
    write(configs: McpServerConfig[]) {
      if (fixture.writeFailure) throw new Error("synthetic write failure");
      fixture.configs = structuredClone(configs);
    }
  },
}));

import { connectMcpServer, disconnectMcpServer, getMcpServerStates } from "./mcp-adapter";
import { initMcpManager, addMcpServer } from "./mcp-manager";
import { buildPlaywrightMcpConfig, syncPlaywrightMcp } from "../sync-mcp-builtin";
import { toolRegistry } from "./tools/registry/tool-registry";

const config: McpServerConfig = { id: "fixture", name: "Fixture", transport: "stdio", command: "synthetic-node" };
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("MCP connection ownership", () => {
  beforeEach(() => {
    fixture.clients = [];
    fixture.transports = [];
    fixture.configs = [];
    fixture.nextConnect = undefined;
    fixture.nextList = undefined;
    fixture.writeFailure = false;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(async () => {
    for (const state of getMcpServerStates()) await disconnectMcpServer(state.id);
    for (const tool of toolRegistry.getAllTools()) toolRegistry.unregister(tool.id);
    vi.restoreAllMocks();
  });

  it.each(["missing", "stale"])("sync then restore connects a %s built-in once", async (kind) => {
    if (kind === "stale") fixture.configs = [{ ...buildPlaywrightMcpConfig(), command: "old-npx" }];
    await syncPlaywrightMcp({ playwrightMcpEnabled: true });
    await initMcpManager();
    expect(fixture.clients).toHaveLength(1);
    expect(getMcpServerStates()[0].toolIds).toEqual(["playwright-mcp-inspect"]);
    expect(await toolRegistry.getById("playwright-mcp-inspect")?.execute({})).toBe("client-0");
  });

  it("merges concurrent connections with the same configuration", async () => {
    const pending = gate();
    fixture.nextConnect = () => pending.promise;
    const first = connectMcpServer(config);
    const second = connectMcpServer({ ...config });
    await vi.waitFor(() => expect(fixture.clients.length).toBeGreaterThan(0));
    const clientCount = fixture.clients.length;
    pending.resolve();
    expect(await Promise.all([first, second])).toEqual([["fixture-inspect"], ["fixture-inspect"]]);
    expect(clientCount).toBe(1);
    await connectMcpServer(config);
    expect(fixture.clients).toHaveLength(1);
  });

  it("shares an inflight failure and allows a subsequent retry", async () => {
    const pending = gate();
    fixture.nextConnect = async () => { await pending.promise; throw new Error("synthetic connect failure"); };
    const first = connectMcpServer(config);
    const second = connectMcpServer({ ...config });
    const results = Promise.allSettled([first, second]);
    pending.resolve();
    expect((await results).map(result => result.status)).toEqual(["rejected", "rejected"]);
    expect(fixture.clients).toHaveLength(1);
    expect(getMcpServerStates()).toEqual([]);
    await connectMcpServer(config);
    expect(getMcpServerStates()[0].toolCount).toBe(1);
    expect(fixture.clients).toHaveLength(2);
  });

  it("snapshots nested configuration before waiting for the connection", async () => {
    const pending = gate();
    fixture.nextConnect = () => pending.promise;
    const mutable: McpServerConfig = {
      ...config, args: ["original"], env: { SYNTHETIC: "original" },
      effectKindOverrides: { inspect: "read" },
    };
    const connecting = connectMcpServer(mutable);
    mutable.args![0] = "changed";
    mutable.env!.SYNTHETIC = "changed";
    mutable.effectKindOverrides!.inspect = "mutation";
    pending.resolve();
    await connecting;
    expect(toolRegistry.getById("fixture-inspect")?.effectKind).toBe("read");
    await connectMcpServer(mutable);
    expect(toolRegistry.getById("fixture-inspect")?.effectKind).toBe("mutation");
    expect(fixture.clients).toHaveLength(2);
  });

  it("does not reconnect for equivalent map order and optional empty collections", async () => {
    await connectMcpServer({ ...config, env: { A: "1", B: "2" } });
    await connectMcpServer({ ...config, env: { B: "2", A: "1" }, args: [], effectKindOverrides: {} });
    expect(fixture.clients).toHaveLength(1);
    expect(await toolRegistry.getById("fixture-inspect")?.execute({})).toBe("client-0");
  });

  it("does not publish tools if the remote closes during discovery", async () => {
    const pending = gate();
    fixture.nextList = async () => {
      await pending.promise;
      return { tools: [{ name: "inspect", inputSchema: { type: "object", properties: {} } }] };
    };
    const connecting = connectMcpServer(config);
    await vi.waitFor(() => expect(fixture.clients).toHaveLength(1));
    fixture.clients[0].onclose?.();
    pending.resolve();
    await expect(connecting).rejects.toThrow("MCP connection closed during discovery");
    expect(getMcpServerStates()).toEqual([]);
    expect(toolRegistry.getById("fixture-inspect")).toBeUndefined();
    await connectMcpServer(config);
    expect(getMcpServerStates()[0].toolCount).toBe(1);
  });

  it("returns detached ID arrays to callers", async () => {
    const ids = await connectMcpServer(config);
    ids.length = 0;
    expect(await connectMcpServer(config)).toEqual(["fixture-inspect"]);
    expect(getMcpServerStates()[0].toolCount).toBe(1);
  });

  it.each([
    { command: "changed-node" },
    { args: ["changed-arg"] },
    { env: { SYNTHETIC: "changed" } },
    { cwd: "synthetic-directory" },
    { transport: "sse" as const, url: "https://synthetic.invalid" },
    { effectKindOverrides: { inspect: "read" as const } },
    { name: "Changed display name" },
  ])("replaces the owned client when configuration changes: %j", async (change) => {
    await connectMcpServer(config);
    const oldTool = toolRegistry.getById("fixture-inspect")!;
    await connectMcpServer({ ...config, ...change });
    expect(fixture.clients).toHaveLength(2);
    expect(fixture.clients[0].close).toHaveBeenCalledTimes(1);
    expect(await toolRegistry.getById("fixture-inspect")?.execute({})).toBe("client-1");
    await expect(oldTool.execute({})).rejects.toThrow("E_MCP_TOOL_FAILED");
    expect(fixture.clients[0].callTool).not.toHaveBeenCalled();
  });

  it("serializes a changed configuration behind an inflight connection", async () => {
    const pending = gate();
    fixture.nextConnect = () => pending.promise;
    const first = connectMcpServer(config);
    const changed = connectMcpServer({ ...config, command: "changed-node" });
    await vi.waitFor(() => expect(fixture.clients.length).toBeGreaterThan(0));
    const earlyCount = fixture.clients.length;
    pending.resolve();
    await Promise.all([first, changed]);
    expect(earlyCount).toBe(1);
    expect(fixture.clients[0].close).toHaveBeenCalledTimes(1);
    expect(await toolRegistry.getById("fixture-inspect")?.execute({})).toBe("client-1");
  });

  it("waits for an inflight connection when disconnecting and removes its tools", async () => {
    const pending = gate();
    fixture.nextConnect = () => pending.promise;
    const connecting = connectMcpServer(config);
    const disconnecting = disconnectMcpServer(config.id);
    pending.resolve();
    await connecting;
    expect(await disconnecting).toBe(true);
    expect(getMcpServerStates()).toEqual([]);
    expect(toolRegistry.getById("fixture-inspect")).toBeUndefined();
    expect(fixture.clients[0].close).toHaveBeenCalledTimes(1);
  });

  it("closes the failed transport and permits retry after a connect failure", async () => {
    fixture.nextConnect = async () => { throw new Error("synthetic connect failure"); };
    await expect(connectMcpServer(config)).rejects.toThrow("synthetic connect failure");
    expect(fixture.transports[0].close).toHaveBeenCalled();
    await connectMcpServer(config);
    expect(getMcpServerStates()[0].toolIds).toEqual(["fixture-inspect"]);
  });

  it("releases the transport on discovery failure even when client.close fails", async () => {
    const pending = gate();
    fixture.nextList = async () => { await pending.promise; throw new Error("synthetic discovery failure"); };
    const connecting = connectMcpServer(config);
    await vi.waitFor(() => expect(fixture.clients).toHaveLength(1));
    fixture.clients[0].close.mockRejectedValueOnce(new Error("synthetic close failure"));
    pending.resolve();
    await expect(connecting).rejects.toThrow("synthetic discovery failure");
    expect(fixture.transports[0].close).toHaveBeenCalled();
    expect(getMcpServerStates()).toEqual([]);
    await connectMcpServer(config);
    expect(getMcpServerStates()[0].toolCount).toBe(1);
  });

  it("refuses a replacement until failed resource cleanup can be retried", async () => {
    await connectMcpServer(config);
    const oldTool = toolRegistry.getById("fixture-inspect")!;
    fixture.clients[0].close.mockRejectedValueOnce(new Error("synthetic client close failure"));
    fixture.transports[0].close.mockRejectedValueOnce(new Error("synthetic transport close failure"));
    await expect(connectMcpServer({ ...config, command: "changed-node" })).rejects.toThrow("synthetic transport close failure");
    expect(fixture.clients).toHaveLength(1);
    expect(getMcpServerStates()[0].connected).toBe(false);
    expect(toolRegistry.getById("fixture-inspect")).toBeUndefined();
    await expect(oldTool.execute({})).rejects.toThrow("E_MCP_TOOL_FAILED");
    await connectMcpServer({ ...config, command: "changed-node" });
    expect(fixture.clients[0].close).toHaveBeenCalledTimes(2);
    expect(fixture.clients).toHaveLength(2);
    expect(await toolRegistry.getById("fixture-inspect")?.execute({})).toBe("client-1");
  });

  it("retains ownership for retry when discovery and both cleanup attempts fail", async () => {
    const pending = gate();
    fixture.nextList = async () => { await pending.promise; throw new Error("synthetic discovery failure"); };
    const connecting = connectMcpServer(config);
    await vi.waitFor(() => expect(fixture.clients).toHaveLength(1));
    fixture.clients[0].close.mockRejectedValueOnce(new Error("synthetic client close failure"));
    fixture.transports[0].close.mockRejectedValueOnce(new Error("synthetic transport close failure"));
    pending.resolve();
    await expect(connecting).rejects.toThrow("synthetic discovery failure");
    expect(getMcpServerStates()[0]?.connected).toBe(false);
    expect(toolRegistry.getById("fixture-inspect")).toBeUndefined();
    await connectMcpServer(config);
    expect(fixture.clients[0].close).toHaveBeenCalledTimes(2);
    expect(fixture.clients).toHaveLength(2);
  });

  it("removes ownership and allows reconnect after remote closure", async () => {
    await connectMcpServer(config);
    const oldTool = toolRegistry.getById("fixture-inspect")!;
    fixture.clients[0].onclose?.();
    expect(getMcpServerStates()).toEqual([]);
    expect(toolRegistry.getById("fixture-inspect")).toBeUndefined();
    await expect(oldTool.execute({})).rejects.toThrow("E_MCP_TOOL_FAILED");
    await connectMcpServer(config);
    expect(fixture.clients).toHaveLength(2);
  });

  it.each(["disconnect", "remote close"] as const)("preserves a later registry definition during %s", async path => {
    await connectMcpServer(config);
    const original = toolRegistry.getById("fixture-inspect")!;
    const replacement = { ...original, execute: async () => "later-registry-owner" };
    toolRegistry.register(replacement);
    if (path === "disconnect") await disconnectMcpServer(config.id);
    else fixture.clients[0].onclose?.();
    expect(getMcpServerStates()).toEqual([]);
    expect(toolRegistry.getById("fixture-inspect")).toBe(replacement);
    expect(await replacement.execute({})).toBe("later-registry-owner");
    await expect(original.execute({})).rejects.toThrow("E_MCP_TOOL_FAILED");
  });

  it("does not let a stale connection owner close a later client with the same server ID", async () => {
    const originalOwner = {}, laterOwner = {};
    await connectMcpServer(config, originalOwner);
    const original = toolRegistry.getById("fixture-inspect")!;
    await connectMcpServer({ ...config, command: "later-client" }, laterOwner);
    expect(await disconnectMcpServer(config.id, originalOwner)).toBe(false);
    expect(fixture.clients[0].close).toHaveBeenCalledTimes(1);
    expect(fixture.clients[1].close).not.toHaveBeenCalled();
    expect(getMcpServerStates()[0]).toMatchObject({ connected: true });
    expect(await toolRegistry.getById("fixture-inspect")!.execute({})).toBe("client-1");
    await expect(original.execute({})).rejects.toThrow("E_MCP_TOOL_FAILED");
    expect(await disconnectMcpServer(config.id, laterOwner)).toBe(true);
  });

  it("refuses to coalesce an owned connection into another caller's inflight ownership", async () => {
    const originalOwner = {}, otherOwner = {}, pending = gate();
    fixture.nextConnect = () => pending.promise;
    const first = connectMcpServer(config, originalOwner);
    const refused = expect(connectMcpServer({ ...config }, otherOwner)).rejects.toThrow("MCP connection ownership conflict");
    pending.resolve(); await first; await refused;
    expect(fixture.clients).toHaveLength(1);
    expect(await toolRegistry.getById("fixture-inspect")!.execute({})).toBe("client-0");
    expect(await disconnectMcpServer(config.id, originalOwner)).toBe(true);
  });

  it("rolls back an unpersisted connection after a configuration write failure", async () => {
    fixture.writeFailure = true;
    expect(await addMcpServer(config)).toEqual({ ok: false, error: "ATOMIC_JSON_WRITE_FAILED", reason: "failed" });
    expect(getMcpServerStates()).toEqual([]);
    expect(toolRegistry.getById("fixture-inspect")).toBeUndefined();
    fixture.writeFailure = false;
    expect((await addMcpServer(config)).ok).toBe(true);
    expect(fixture.configs).toEqual([config]);
  });
it("propagates run cancellation to MCP and promptly rejects a stalled call", async () => {
  await connectMcpServer(config);
  const tool = toolRegistry.getById("fixture-inspect")!;
  const controller = new AbortController();
  fixture.clients[0].callTool.mockImplementation(() => new Promise(() => {}));
  expect(tool.needsContext).toBe(true);
  const pending = tool.execute({}, { signal: controller.signal } as never);
  await vi.waitFor(() => expect(fixture.clients[0].callTool).toHaveBeenCalledTimes(1));
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(fixture.clients[0].callTool.mock.calls[0][2]).toMatchObject({ signal: controller.signal });
});
it("does not start an MCP call after its run was already cancelled", async () => {
  await connectMcpServer(config);
  const controller = new AbortController(); controller.abort();
  await expect(toolRegistry.getById("fixture-inspect")!.execute({}, { signal: controller.signal } as never)).rejects.toMatchObject({ name: "AbortError" });
  expect(fixture.clients[0].callTool).not.toHaveBeenCalled();
});

});
