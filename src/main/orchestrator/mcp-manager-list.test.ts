import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const adapter = vi.hoisted(() => ({ connect: vi.fn(), disconnect: vi.fn(), states: vi.fn() }));
vi.mock("./mcp-adapter", () => ({ connectMcpServer: adapter.connect, disconnectMcpServer: adapter.disconnect, getMcpServerStates: adapter.states }));
vi.mock("electron", () => ({ app: { getPath: () => { throw new Error("real userData forbidden"); } } }));
const roots: string[] = [];
const config = { id: "stored", name: "Stored server", transport: "stdio", command: "synthetic-command", args: ["synthetic-secret"], env: { TOKEN: "synthetic-secret" } };
async function fixture(configs: unknown[] = [config]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-mcp-list-")); roots.push(root);
  fs.mkdirSync(path.join(root, "test"));
  const { resolveRuntimeProfile } = await import("../runtime-profile");
  const { initializeStorageContext } = await import("../storage-context");
  const storage = initializeStorageContext(resolveRuntimeProfile({ isPackaged: true, env: {}, productionAppData: path.join(root, "unused"), argv: ["--firefly-profile=test", `--firefly-isolation-root=${path.join(root, "test")}`] }));
  fs.mkdirSync(storage.configRoot, { recursive: true });
  fs.writeFileSync(storage.files.mcp, JSON.stringify(configs));
  return { storage, manager: await import("./mcp-manager") };
}
beforeEach(() => { vi.resetModules(); vi.resetAllMocks(); adapter.states.mockReturnValue([]); adapter.disconnect.mockResolvedValue(false); });
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("MCP management list", () => {
  it("shows persisted disconnected servers without config secrets or writes", async () => {
    const { manager, storage } = await fixture();
    const original = fs.readFileSync(storage.files.mcp, "utf8");
    expect(manager.listMcpServers()).toEqual([{ id: "stored", name: "Stored server", connected: false, toolCount: 0, toolIds: [], enabled: true }]);
    expect(fs.readFileSync(storage.files.mcp, "utf8")).toBe(original);
    expect(fs.existsSync(`${storage.files.mcp}.bak`)).toBe(false);
  });
  it("merges runtime status by ID and retains runtime-only cleanup entries", async () => {
    const { manager } = await fixture();
    const live = { id: "stored", name: "Stored server", connected: true, toolCount: 1, toolIds: ["stored-tool"], env: { TOKEN: "synthetic-secret" } };
    adapter.states.mockReturnValue([live, { id: "cleanup", name: "Cleanup", connected: false, toolCount: 0, toolIds: [], enabled: true }]);
    const listed = manager.listMcpServers();
    expect(listed).toEqual([{ id: "stored", name: "Stored server", connected: true, toolCount: 1, toolIds: ["stored-tool"], enabled: true }, { id: "cleanup", name: "Cleanup", connected: false, toolCount: 0, toolIds: [], enabled: true }]);
    listed[0].toolIds.push("mutated");
    expect(live.toolIds).toEqual(["stored-tool"]);
  });
  it("reports invalid stored JSON instead of a misleading empty list", async () => {
    const { manager, storage } = await fixture();
    fs.writeFileSync(storage.files.mcp, "{malformed");
    expect(() => manager.listMcpServers()).toThrow("ATOMIC_JSON_EXISTING_INVALID");
    expect(fs.readFileSync(storage.files.mcp, "utf8")).toBe("{malformed");
  });
  it("deletes a disconnected persisted entry and the next list reflects disk", async () => {
    const { manager, storage } = await fixture();
    expect(manager.listMcpServers()).toHaveLength(1);
    expect(await manager.removeMcpServer("stored")).toEqual({ ok: true });
    expect(manager.listMcpServers()).toEqual([]);
    expect(JSON.parse(fs.readFileSync(storage.files.mcp, "utf8"))).toEqual([]);
  });
  it("does not report removal success or lose the visible entry when persistence fails", async () => {
    const { manager, storage } = await fixture();
    const rename = fs.renameSync.bind(fs);
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (to === storage.files.mcp) throw new Error("synthetic disk failure");
      rename(from, to);
    });
    await expect(manager.removeMcpServer("stored")).rejects.toThrow("ATOMIC_JSON_WRITE_FAILED");
    expect(manager.listMcpServers()).toEqual([{ id: "stored", name: "Stored server", connected: false, toolCount: 0, toolIds: [], enabled: true }]);
    expect(JSON.parse(fs.readFileSync(storage.files.mcp, "utf8"))).toEqual([config]);
  });
});
