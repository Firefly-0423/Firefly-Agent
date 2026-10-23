import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServerConfig } from "./mcp-adapter";

const adapter = vi.hoisted(() => ({ connect: vi.fn(), disconnect: vi.fn(), states: new Set<string>() }));
vi.mock("./mcp-adapter", () => ({
  connectMcpServer: adapter.connect,
  disconnectMcpServer: adapter.disconnect,
  getMcpServerStates: () => [...adapter.states].map(id => ({ id, connected: true })),
}));
vi.mock("electron", () => ({ app: { getPath: () => { throw new Error("real userData forbidden"); } } }));
const roots: string[] = [];
function temporary() {
  const parent = path.resolve("output", "mcp-transactions");
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, "fixture-"));
  roots.push(root);
  return root;
}
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const config = (id: string): McpServerConfig => ({ id, name: id, transport: "stdio", command: "synthetic-command" });
async function storageAt(root = temporary(), productionAppData = temporary()) {
  const { resolveRuntimeProfile } = await import("../runtime-profile");
  const { initializeStorageContext } = await import("../storage-context");
  const storage = initializeStorageContext(resolveRuntimeProfile({ isPackaged: true, env: {}, productionAppData, argv: ["--firefly-profile=test", `--firefly-isolation-root=${root}`] }));
  return { storage, root, productionAppData };
}
async function fixture() {
  const location = await storageAt();
  const manager = await import("./mcp-manager");
  const a = deferred();
  const b = deferred();
  const aStarted = deferred();
  adapter.connect.mockImplementation(async (server: McpServerConfig) => {
    if (server.id === "a") aStarted.resolve();
    await (server.id === "a" ? a : b).promise;
    adapter.states.add(server.id);
    return [`tool-${server.id}`];
  });
  return { ...location, manager, a, b, aStarted };
}
async function coldConfigs(location: Awaited<ReturnType<typeof storageAt>>) {
  vi.resetModules();
  await storageAt(location.root, location.productionAppData);
  return (await import("./mcp-manager")).listMcpServerConfigs();
}
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); adapter.states.clear();
  adapter.connect.mockImplementation(async (server: McpServerConfig) => { adapter.states.add(server.id); return [`tool-${server.id}`]; });
  adapter.disconnect.mockImplementation(async (id: string) => { adapter.states.delete(id); });
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("MCP manager configuration transactions", () => {
  it("retains overlapping adds when the second connection is released first, including after restart", async () => {
    const f = await fixture();
    const first = f.manager.addMcpServer(config("a"));
    await f.aStarted.promise;
    const second = f.manager.addMcpServer(config("b"));
    let firstSettled = false;
    void first.then(() => { firstSettled = true; });
    f.b.resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(firstSettled).toBe(false);
    f.a.resolve();
    expect(await Promise.all([first, second])).toEqual([{ ok: true, toolIds: ["tool-a"] }, { ok: true, toolIds: ["tool-b"] }]);
    expect(await coldConfigs(f)).toEqual([config("a"), config("b")]);
  });
  it("does not resurrect an existing server removed during another pending add", async () => {
    const f = await fixture(); f.b.resolve();
    expect((await f.manager.addMcpServer(config("b"))).ok).toBe(true);
    const addition = f.manager.addMcpServer(config("a"));
    await f.aStarted.promise;
    const removal = f.manager.removeMcpServer("b");
    // Let removal reach its disk write on the old implementation before add completes.
    await new Promise<void>(resolve => setImmediate(resolve));
    f.a.resolve();
    expect(await addition).toEqual({ ok: true, toolIds: ["tool-a"] });
    expect(await removal).toEqual({ ok: true });
    expect(await coldConfigs(f)).toEqual([config("a")]);
    expect([...adapter.states]).toEqual(["a"]);
  });
  it("removes the same ID requested while its add is still connecting", async () => {
    const f = await fixture();
    const addition = f.manager.addMcpServer(config("a"));
    await f.aStarted.promise;
    const removal = f.manager.removeMcpServer("a");
    await new Promise<void>(resolve => setImmediate(resolve));
    f.a.resolve();
    expect((await addition).ok).toBe(true);
    expect(await removal).toEqual({ ok: true });
    expect(await coldConfigs(f)).toEqual([]);
    expect([...adapter.states]).toEqual([]);
  });
  it("prunes an existing ID without resurrecting it from a pending add snapshot", async () => {
    const f = await fixture(); f.b.resolve();
    await f.manager.addMcpServer(config("b"));
    const addition = f.manager.addMcpServer(config("a"));
    await f.aStarted.promise;
    const pruning = f.manager.pruneMcpServersByIds(["b"]);
    await new Promise<void>(resolve => setImmediate(resolve));
    f.a.resolve();
    expect((await addition).ok).toBe(true);
    expect(await pruning).toEqual(["b"]);
    expect(await coldConfigs(f)).toEqual([config("a")]);
  });
  it("rejects an overlapping duplicate ID without replacing its persisted config", async () => {
    const f = await fixture();
    const original = f.manager.addMcpServer(config("a"));
    await f.aStarted.promise;
    const duplicate = f.manager.addMcpServer({ ...config("a"), command: "other-command" });
    f.a.resolve();
    expect((await original).ok).toBe(true);
    expect((await duplicate).ok).toBe(false);
    expect(await coldConfigs(f)).toEqual([config("a")]);
  });
  it("keeps the submitted config stable while callers mutate it during a queued connection", async () => {
    const f = await fixture();
    const submitted = { ...config("a"), args: ["original"], env: { KEY: "original" } };
    const addition = f.manager.addMcpServer(submitted);
    await f.aStarted.promise;
    submitted.command = "mutated"; submitted.args[0] = "mutated"; submitted.env.KEY = "mutated";
    f.a.resolve();
    expect((await addition).ok).toBe(true);
    expect(await coldConfigs(f)).toEqual([{ ...config("a"), args: ["original"], env: { KEY: "original" } }]);
  });
  it("does not leave a removed server connected when startup restoration overlaps removal", async () => {
    const f = await fixture(); f.b.resolve();
    await f.manager.addMcpServer(config("b"));
    adapter.states.clear();
    const restoring = deferred();
    adapter.connect.mockImplementation(async (server: McpServerConfig) => {
      await restoring.promise;
      adapter.states.add(server.id);
      return [`tool-${server.id}`];
    });
    const startup = f.manager.initMcpManager();
    const removal = f.manager.removeMcpServer("b");
    await new Promise<void>(resolve => setImmediate(resolve));
    restoring.resolve();
    await startup;
    expect(await removal).toEqual({ ok: true });
    expect(await coldConfigs(f)).toEqual([]);
    expect([...adapter.states]).toEqual([]);
  });
  it("continues after a connection failure without persisting the failed server", async () => {
    const f = await fixture();
    const failed = f.manager.addMcpServer(config("a"));
    const next = f.manager.addMcpServer(config("b"));
    f.a.reject(new Error("synthetic connect failure")); f.b.resolve();
    expect(await failed).toEqual({ ok: false, error: "MCP_CONNECTION_FAILED", reason: "failed" });
    expect((await next).ok).toBe(true);
    expect(await coldConfigs(f)).toEqual([config("b")]);
  });
  it("disconnects an unpersisted connection on write failure and permits a queued add", async () => {
    const f = await fixture();
    const rename = fs.renameSync.bind(fs);
    const spy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (to === f.storage.files.mcp) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      rename(from, to);
    });
    const failed = f.manager.addMcpServer(config("a")); f.a.resolve();
    expect(await failed).toEqual({ ok: false, error: "ATOMIC_JSON_WRITE_FAILED", reason: "failed" });
    expect([...adapter.states]).toEqual([]);
    spy.mockRestore();
    const next = f.manager.addMcpServer(config("b")); f.b.resolve();
    expect((await next).ok).toBe(true);
    expect(await coldConfigs(f)).toEqual([config("b")]);
  });
  it("does not poison later operations when removal fails", async () => {
    const f = await fixture(); f.b.resolve();
    await f.manager.addMcpServer(config("b"));
    adapter.disconnect.mockRejectedValueOnce(new Error("synthetic disconnect failure"));
    const failed = f.manager.removeMcpServer("b");
    const next = f.manager.addMcpServer(config("a")); f.a.resolve();
    await expect(failed).rejects.toThrow("synthetic disconnect failure");
    expect((await next).ok).toBe(true);
    expect(await coldConfigs(f)).toEqual([config("b"), config("a")]);
  });
});
