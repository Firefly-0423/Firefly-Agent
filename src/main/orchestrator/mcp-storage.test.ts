import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./mcp-adapter", () => ({ connectMcpServer: async () => ["tool"], disconnectMcpServer: vi.fn(async () => {}), getMcpServerStates: () => [] }));
vi.mock("electron", () => ({ app: { getPath: () => { throw new Error("direct Electron path access forbidden"); } } }));
const roots: string[] = [];
function temporary() { const root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-mcp-storage-")); roots.push(root); return root; }
beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
async function setup() {
  const { resolveRuntimeProfile } = await import("../runtime-profile");
  const { initializeStorageContext } = await import("../storage-context");
  const root = temporary();
  const profile = resolveRuntimeProfile({ isPackaged: true, env: {}, productionAppData: temporary(), argv: ["--firefly-profile=test", `--firefly-isolation-root=${root}`] });
  return initializeStorageContext(profile);
}
const config = { id: "test-server", name: "Test server", transport: "stdio" as const, command: "fixture-command", args: ["fixture"], env: { FIXTURE_KEY: "fixture-value" } };
describe("MCP persistent boundary", () => {
  it.each([["sse"], { kind: "stdio" }])("rejects non-string transport types (%j)", async (transport) => {
    const storage = await setup(); fs.mkdirSync(storage.configRoot, { recursive: true });
    const original = JSON.stringify([{ ...config, transport }]); fs.writeFileSync(storage.files.mcp, original);
    const manager = await import("./mcp-manager");
    expect(manager.listMcpServerConfigs()).toEqual([]);
    expect(fs.readFileSync(storage.files.mcp, "utf8")).toBe(original);
  });
  it("refuses access before StorageContext is initialized", async () => {
    const manager = await import("./mcp-manager");
    expect(() => manager.listMcpServerConfigs()).toThrow("FIREFLY_STORAGE_NOT_INITIALIZED");
  });
  it("persists through StorageContext without direct Electron access and keeps one backup", async () => {
    const storage = await setup(); const manager = await import("./mcp-manager");
    expect(await manager.addMcpServer(config)).toEqual({ ok: true, toolIds: ["tool"] });
    expect(manager.listMcpServerConfigs()).toEqual([config]);
    expect(await manager.removeMcpServer(config.id)).toEqual({ ok: true });
    expect(JSON.parse(fs.readFileSync(storage.files.mcp, "utf8"))).toEqual([]);
    expect(JSON.parse(fs.readFileSync(`${storage.files.mcp}.bak`, "utf8"))).toEqual([config]);
  });
  it("does not overwrite malformed MCP JSON with an empty/default configuration", async () => {
    const storage = await setup(); fs.mkdirSync(storage.configRoot, { recursive: true }); fs.writeFileSync(storage.files.mcp, "{malformed");
    const manager = await import("./mcp-manager");
    expect((await manager.addMcpServer(config)).ok).toBe(false);
    const adapter = await import("./mcp-adapter");
    expect(adapter.disconnectMcpServer).toHaveBeenCalledWith(config.id);
    expect(fs.readFileSync(storage.files.mcp, "utf8")).toBe("{malformed");
  });
});
