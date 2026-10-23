import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const adapter = vi.hoisted(() => ({ connect: vi.fn(), disconnect: vi.fn(), states: vi.fn() }));
vi.mock("./mcp-adapter", () => ({ connectMcpServer: adapter.connect, disconnectMcpServer: adapter.disconnect, getMcpServerStates: adapter.states }));
vi.mock("electron", () => ({ app: { getPath: () => { throw new Error("real userData forbidden"); } } }));
const roots: string[] = [];
const server = (id: string, extra: object = {}) => ({ id, name: `Server ${id}`, transport: "stdio", command: "synthetic-command", args: ["--synthetic"], ...extra });
async function fixture(configs: unknown[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-mcp-enabled-")); roots.push(root);
  fs.mkdirSync(path.join(root, "test"));
  const { resolveRuntimeProfile } = await import("../runtime-profile");
  const { initializeStorageContext } = await import("../storage-context");
  const storage = initializeStorageContext(resolveRuntimeProfile({ isPackaged: true, env: {}, productionAppData: path.join(root, "unused"), argv: ["--firefly-profile=test", `--firefly-isolation-root=${path.join(root, "test")}`] }));
  fs.mkdirSync(storage.configRoot, { recursive: true });
  fs.writeFileSync(storage.files.mcp, JSON.stringify(configs));
  const saved = () => JSON.parse(fs.readFileSync(storage.files.mcp, "utf8")) as Array<{ id: string; enabled?: boolean }>;
  return { storage, saved, manager: await import("./mcp-manager") };
}
const connectedIds = new Set<string>();
beforeEach(() => {
  vi.resetModules(); vi.resetAllMocks(); connectedIds.clear();
  adapter.states.mockImplementation(() => [...connectedIds].map(id => ({ id, name: id, connected: true, toolCount: 1, toolIds: [`tool-${id}`] })));
  adapter.connect.mockImplementation(async (config: { id: string }) => { connectedIds.add(config.id); return [`tool-${config.id}`]; });
  adapter.disconnect.mockImplementation(async (id: string) => connectedIds.delete(id));
});
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("MCP server enable and disable", () => {
  it("lists a server without the flag as enabled", async () => {
    const f = await fixture([server("a")]);
    expect(f.manager.listMcpServers()[0]).toMatchObject({ id: "a", enabled: true });
  });

  it("disabling disconnects the server, removes its tools and keeps the saved configuration", async () => {
    const f = await fixture([server("a")]);
    await f.manager.initMcpManager();
    expect(connectedIds.has("a")).toBe(true);
    expect(await f.manager.setMcpServerEnabled("a", false)).toEqual({ ok: true });
    expect(adapter.disconnect).toHaveBeenCalledWith("a");
    expect(f.saved()).toEqual([expect.objectContaining({ id: "a", enabled: false, command: "synthetic-command" })]);
    expect(f.manager.listMcpServers()[0]).toMatchObject({ id: "a", enabled: false, connected: false });
  });

  it("does not connect a disabled server on startup, and still connects the others", async () => {
    const f = await fixture([server("off", { enabled: false }), server("on")]);
    await f.manager.initMcpManager();
    expect(adapter.connect.mock.calls.map(call => call[0].id)).toEqual(["on"]);
  });

  it("enabling connects first and saves the flag only after the connection works", async () => {
    const f = await fixture([server("a", { enabled: false })]);
    expect(await f.manager.setMcpServerEnabled("a", true)).toEqual({ ok: true, toolIds: ["tool-a"] });
    expect(f.saved()).toEqual([expect.objectContaining({ id: "a", enabled: true })]);
    expect(f.manager.listMcpServers()[0]).toMatchObject({ enabled: true, connected: true });
  });

  it("a failed enable leaves the server disabled and reports only a fixed reason", async () => {
    const f = await fixture([server("a", { enabled: false })]);
    adapter.connect.mockRejectedValueOnce(Object.assign(new Error("spawn secret-token-command ENOENT"), { code: "ENOENT" }));
    const result = await f.manager.setMcpServerEnabled("a", true);
    expect(result).toMatchObject({ ok: false, reason: "command-not-found" });
    expect(f.saved()[0].enabled).toBe(false);
    expect(f.manager.listMcpServers()[0]).toEqual(expect.objectContaining({ enabled: false, connected: false, failure: "command-not-found" }));
    expect(JSON.stringify(f.manager.listMcpServers())).not.toContain("secret-token-command");
  });

  it("rolls the connection back when the enabled flag cannot be saved", async () => {
    const f = await fixture([server("a", { enabled: false })]);
    fs.chmodSync(f.storage.files.mcp, 0o444);
    const write = vi.spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("ATOMIC_JSON_WRITE_FAILED"); });
    await expect(f.manager.setMcpServerEnabled("a", true)).rejects.toThrow();
    write.mockRestore();
    expect(adapter.disconnect).toHaveBeenCalledWith("a");
    expect(connectedIds.has("a")).toBe(false);
    expect(f.saved()[0].enabled).toBe(false);
  });

  it("enabling an enabled server that is not connected is a reconnect and writes nothing", async () => {
    const f = await fixture([server("a")]);
    const before = fs.readFileSync(f.storage.files.mcp, "utf8");
    expect(await f.manager.setMcpServerEnabled("a", true)).toEqual({ ok: true, toolIds: ["tool-a"] });
    expect(adapter.connect).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(f.storage.files.mcp, "utf8")).toBe(before);
  });

  it("enabling an already connected server does not connect it again", async () => {
    const f = await fixture([server("a")]);
    await f.manager.initMcpManager(); adapter.connect.mockClear();
    expect(await f.manager.setMcpServerEnabled("a", true)).toEqual({ ok: true });
    expect(adapter.connect).not.toHaveBeenCalled();
  });

  it("answers an unknown server without connecting anything", async () => {
    const f = await fixture([server("a")]);
    expect(await f.manager.setMcpServerEnabled("missing", true)).toEqual({ ok: false, error: "MCP_SERVER_NOT_FOUND" });
    expect(adapter.connect).not.toHaveBeenCalled();
  });

  it("shows why a server failed to connect at startup, and forgets it once it connects or is removed", async () => {
    const f = await fixture([server("a"), server("b")]);
    adapter.connect.mockRejectedValueOnce(Object.assign(new Error("Request timed out"), { code: -32001 })).mockRejectedValueOnce(new Error("odd"));
    await f.manager.initMcpManager();
    expect(f.manager.listMcpServers().map(s => s.failure)).toEqual(["timeout", "failed"]);
    expect((await f.manager.setMcpServerEnabled("a", true)).ok).toBe(true);
    expect(f.manager.listMcpServers()[0].failure).toBeUndefined();
    await f.manager.removeMcpServer("b");
    expect(f.manager.listMcpServers().map(s => s.id)).toEqual(["a"]);
  });

  it("returns the fixed reason when adding fails", async () => {
    const f = await fixture([]);
    adapter.connect.mockRejectedValueOnce(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }));
    expect(await f.manager.addMcpServer(server("new") as never)).toMatchObject({ ok: false, reason: "unreachable" });
  });
});
