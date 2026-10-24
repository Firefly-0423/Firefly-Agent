import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServerConfig } from "./mcp-adapter";

const adapter = vi.hoisted(() => ({ connect: vi.fn(), disconnect: vi.fn(), states: vi.fn() }));
vi.mock("./mcp-adapter", () => ({
  connectMcpServer: adapter.connect,
  disconnectMcpServer: adapter.disconnect,
  getMcpServerStates: adapter.states,
}));
vi.mock("electron", () => ({ app: { getPath: () => { throw new Error("real userData forbidden"); } } }));

const roots: string[] = [];

const server = (id: string, extra: Partial<McpServerConfig> = {}): McpServerConfig => ({
  id,
  name: `Server ${id}`,
  transport: "stdio",
  command: "synthetic-command",
  ...extra,
});

async function fixture(configs: unknown[] = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-mcp-manager-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, "test"));
  const { resolveRuntimeProfile } = await import("../runtime-profile");
  const { initializeStorageContext } = await import("../storage-context");
  const storage = initializeStorageContext(resolveRuntimeProfile({
    isPackaged: true,
    env: {},
    productionAppData: path.join(root, "unused"),
    argv: ["--firefly-profile=test", `--firefly-isolation-root=${path.join(root, "test")}`],
  }));
  fs.mkdirSync(storage.configRoot, { recursive: true });
  fs.writeFileSync(storage.files.mcp, JSON.stringify(configs));
  return {
    storage,
    manager: await import("./mcp-manager"),
    raw: () => fs.readFileSync(storage.files.mcp, "utf8"),
    saved: () => JSON.parse(fs.readFileSync(storage.files.mcp, "utf8")) as McpServerConfig[],
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  adapter.states.mockReturnValue([]);
  adapter.connect.mockResolvedValue(["synthetic-tool"]);
  adapter.disconnect.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("persisted configuration", () => {
  it("returns the full saved configuration, including connection fields", async () => {
    const config = server("a", {
      args: ["--flag"],
      env: { TOKEN: "synthetic" },
      cwd: "C:/work",
      enabled: false,
      effectKindOverrides: { lookup: "read" },
    });
    const f = await fixture([config]);
    expect(f.manager.listMcpServerConfigs()).toEqual([config]);
  });

  it("falls back to an empty configuration when the file does not exist", async () => {
    const f = await fixture([]);
    fs.rmSync(f.storage.files.mcp);
    expect(f.manager.listMcpServerConfigs()).toEqual([]);
  });

  it("logs and returns an empty configuration when stored JSON is malformed", async () => {
    const f = await fixture([]);
    fs.writeFileSync(f.storage.files.mcp, "{not-json");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(f.manager.listMcpServerConfigs()).toEqual([]);
    expect(error).toHaveBeenCalledWith("[MCP Manager]", "configuration read failed:", expect.any(String));
    error.mockRestore();
  });

  it.each([
    ["empty id", [{ id: "", name: "n", transport: "stdio" }]],
    ["empty name", [{ id: "a", name: "", transport: "stdio" }]],
    ["unknown transport", [{ id: "a", name: "n", transport: "http" }]],
    ["duplicate ids", [{ id: "a", name: "n", transport: "stdio" }, { id: "a", name: "m", transport: "stdio" }]],
    ["non-string command", [{ id: "a", name: "n", transport: "stdio", command: 3 }]],
    ["non-string args", [{ id: "a", name: "n", transport: "stdio", args: ["ok", 3] }]],
    ["non-string env value", [{ id: "a", name: "n", transport: "stdio", env: { K: 3 } }]],
    ["non-boolean enabled", [{ id: "a", name: "n", transport: "stdio", enabled: "yes" }]],
    ["array item", [[]]],
  ])("rejects a persisted configuration with %s on direct list but falls back for load", async (_label, configs) => {
    const f = await fixture(configs);
    expect(() => f.manager.listMcpServers()).toThrow("ATOMIC_JSON_EXISTING_INVALID");
    expect(f.manager.listMcpServerConfigs()).toEqual([]);
  });
});

describe("startup restoration", () => {
  it("does nothing when no servers are configured", async () => {
    const f = await fixture([]);
    await expect(f.manager.initMcpManager()).resolves.toBeUndefined();
    expect(adapter.connect).not.toHaveBeenCalled();
  });

  it("connects enabled servers and skips disabled ones", async () => {
    const f = await fixture([server("off", { enabled: false }), server("on")]);
    await f.manager.initMcpManager();
    expect(adapter.connect.mock.calls.map(call => call[0].id)).toEqual(["on"]);
  });

  it("starts no connection when the signal is already aborted", async () => {
    const f = await fixture([server("a"), server("b")]);
    const controller = new AbortController();
    controller.abort();
    await f.manager.initMcpManager({ signal: controller.signal });
    expect(adapter.connect).not.toHaveBeenCalled();
  });

  it("disconnects a connection that finishes after the signal aborted and skips the rest", async () => {
    const f = await fixture([server("a"), server("b")]);
    const controller = new AbortController();
    adapter.connect.mockImplementation(async (config: McpServerConfig) => {
      if (config.id === "a") controller.abort();
      return [`tool-${config.id}`];
    });

    await f.manager.initMcpManager({ signal: controller.signal });

    expect(adapter.connect.mock.calls.map(call => call[0].id)).toEqual(["a"]);
    expect(adapter.disconnect).toHaveBeenCalledWith("a");
  });

  it("keeps starting later servers after one connection fails and records a fixed reason", async () => {
    const f = await fixture([server("a"), server("b")]);
    const connected = new Set<string>();
    adapter.states.mockImplementation(() => [...connected].map(id => ({
      id,
      name: `Server ${id}`,
      connected: true,
      toolCount: 1,
      toolIds: [`tool-${id}`],
    })));
    adapter.connect
      .mockRejectedValueOnce(Object.assign(new Error("spawn synthetic-command ENOENT"), { code: "ENOENT" }))
      .mockImplementationOnce(async (config: McpServerConfig) => {
        connected.add(config.id);
        return [`tool-${config.id}`];
      });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await f.manager.initMcpManager();

    expect(adapter.connect).toHaveBeenCalledTimes(2);
    expect(f.manager.listMcpServers()).toEqual([
      expect.objectContaining({ id: "a", connected: false, failure: "command-not-found" }),
      expect.objectContaining({ id: "b", connected: true }),
    ]);
    expect(JSON.stringify(f.manager.listMcpServers())).not.toContain("spawn synthetic-command");
    error.mockRestore();
  });

  it("hides a previous failure while the server is connected again", async () => {
    const f = await fixture([server("a")]);
    adapter.connect.mockRejectedValueOnce(new Error("connection closed"));
    await f.manager.initMcpManager();
    expect(f.manager.listMcpServers()[0].failure).toBe("exited");

    adapter.states.mockReturnValue([{ id: "a", name: "Server a", connected: true, toolCount: 1, toolIds: ["t"] }]);
    expect(f.manager.listMcpServers()[0]).toEqual(expect.objectContaining({ connected: true }));
    expect(f.manager.listMcpServers()[0].failure).toBeUndefined();
  });
});

describe("adding servers", () => {
  it("refuses a duplicate id without connecting or writing", async () => {
    const f = await fixture([server("a")]);
    const before = f.raw();
    await expect(f.manager.addMcpServer(server("a"))).resolves.toEqual({
      ok: false,
      error: "已存在相同 ID 的 MCP server: a",
    });
    expect(adapter.connect).not.toHaveBeenCalled();
    expect(f.raw()).toBe(before);
  });

  it("connects, persists and reports the discovered tool ids", async () => {
    const f = await fixture([]);
    const config = server("new", { args: ["--serve"], env: { MODE: "test" } });
    adapter.connect.mockResolvedValue(["new-tool-1", "new-tool-2"]);

    await expect(f.manager.addMcpServer(config)).resolves.toEqual({
      ok: true,
      toolIds: ["new-tool-1", "new-tool-2"],
    });
    expect(adapter.connect).toHaveBeenCalledWith(config);
    expect(f.manager.listMcpServerConfigs()).toEqual([config]);
  });

  it("returns a content-free error code and the failure reason without persisting", async () => {
    const f = await fixture([]);
    adapter.connect.mockRejectedValue(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1"), { code: "ECONNREFUSED" }));

    await expect(f.manager.addMcpServer(server("new"))).resolves.toEqual({
      ok: false,
      error: "MCP_CONNECTION_FAILED",
      reason: "unreachable",
    });
    expect(f.saved()).toEqual([]);
  });
});

describe("removing servers", () => {
  it("removes a stored entry and disconnects it", async () => {
    const f = await fixture([server("a"), server("b")]);
    await expect(f.manager.removeMcpServer("a")).resolves.toEqual({ ok: true });
    expect(adapter.disconnect).toHaveBeenCalledWith("a");
    expect(f.saved().map(config => config.id)).toEqual(["b"]);
  });

  it("answers success for an unknown id and leaves the other entries intact", async () => {
    const f = await fixture([server("a")]);
    await expect(f.manager.removeMcpServer("missing")).resolves.toEqual({ ok: true });
    expect(f.saved().map(config => config.id)).toEqual(["a"]);
  });
});

describe("enabling and disabling servers", () => {
  it("disconnects an already-disabled server without rewriting the configuration", async () => {
    const f = await fixture([server("a", { enabled: false })]);
    const before = f.raw();
    await expect(f.manager.setMcpServerEnabled("a", false)).resolves.toEqual({ ok: true });
    expect(adapter.disconnect).toHaveBeenCalledWith("a");
    expect(f.raw()).toBe(before);
  });

  it("reports an unknown server without connecting", async () => {
    const f = await fixture([server("a")]);
    await expect(f.manager.setMcpServerEnabled("missing", true)).resolves.toEqual({
      ok: false,
      error: "MCP_SERVER_NOT_FOUND",
    });
    expect(adapter.connect).not.toHaveBeenCalled();
  });
});

describe("removing retired built-in servers", () => {
  it("removes only the requested ids, in stored order, and disconnects each", async () => {
    const f = await fixture([server("builtin-a"), server("custom"), server("builtin-b")]);
    await expect(f.manager.pruneMcpServersByIds(["builtin-b", "builtin-a"])).resolves.toEqual(["builtin-a", "builtin-b"]);
    expect(adapter.disconnect.mock.calls.map(call => call[0])).toEqual(["builtin-a", "builtin-b"]);
    expect(f.saved().map(config => config.id)).toEqual(["custom"]);
  });

  it("does not write when no requested id exists", async () => {
    const f = await fixture([server("custom")]);
    const before = f.raw();
    await expect(f.manager.pruneMcpServersByIds(["missing"])).resolves.toEqual([]);
    expect(f.raw()).toBe(before);
    expect(fs.existsSync(`${f.storage.files.mcp}.bak`)).toBe(false);
    expect(adapter.disconnect).not.toHaveBeenCalled();
  });

  it("still removes the configuration when disconnecting fails", async () => {
    const f = await fixture([server("builtin-a"), server("custom")]);
    adapter.disconnect.mockRejectedValue(new Error("disconnect failed"));

    await expect(f.manager.pruneMcpServersByIds(["builtin-a"])).resolves.toEqual(["builtin-a"]);
    expect(f.saved().map(config => config.id)).toEqual(["custom"]);
  });

  it("never touches an unrequested custom server with a similar id", async () => {
    const f = await fixture([server("custom-builtin-a")]);
    await expect(f.manager.pruneMcpServersByIds(["builtin-a"])).resolves.toEqual([]);
    expect(f.saved().map(config => config.id)).toEqual(["custom-builtin-a"]);
  });
});

describe("listing server status", () => {
  it("merges runtime state for stored servers and exposes runtime-only cleanup entries", async () => {
    const f = await fixture([server("stored")]);
    adapter.states.mockReturnValue([
      { id: "stored", name: "Stored runtime name", connected: true, toolCount: 2, toolIds: ["a", "b"], env: { SECRET: "x" } },
      { id: "cleanup", name: "Cleanup", connected: false, toolCount: 0, toolIds: [], command: "hidden" },
    ]);

    expect(f.manager.listMcpServers()).toEqual([
      { id: "stored", name: "Server stored", connected: true, toolCount: 2, toolIds: ["a", "b"], enabled: true },
      { id: "cleanup", name: "Cleanup", connected: false, toolCount: 0, toolIds: [], enabled: true },
    ]);
  });

  it("marks a saved disabled server as disabled even when a runtime entry exists", async () => {
    const f = await fixture([server("a", { enabled: false })]);
    adapter.states.mockReturnValue([{ id: "a", name: "A", connected: true, toolCount: 1, toolIds: ["t"] }]);
    expect(f.manager.listMcpServers()[0]).toMatchObject({ enabled: false, connected: true });
  });

  it("defaults missing runtime state to disconnected with zero tools", async () => {
    const f = await fixture([server("a")]);
    expect(f.manager.listMcpServers()).toEqual([{
      id: "a",
      name: "Server a",
      connected: false,
      toolCount: 0,
      toolIds: [],
      enabled: true,
    }]);
  });

  it("copies runtime tool ids so callers cannot mutate adapter state", async () => {
    const f = await fixture([server("a")]);
    const state = { id: "a", name: "A", connected: true, toolCount: 1, toolIds: ["only"] };
    adapter.states.mockReturnValue([state]);
    const listed = f.manager.listMcpServers();
    listed[0].toolIds.push("mutated");
    expect(state.toolIds).toEqual(["only"]);
  });
});
