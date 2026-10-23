import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ configs: [] as unknown[], connect: vi.fn(), disconnect: vi.fn() }));
vi.mock("./mcp-adapter", () => ({
  connectMcpServer: fixture.connect, disconnectMcpServer: fixture.disconnect, getMcpServerStates: () => [],
}));
vi.mock("../storage-context", () => ({ getStorageContext: () => ({ files: { mcp: "synthetic" } }) }));
vi.mock("../atomic-json-store", () => ({ AtomicJsonStore: class {
  read() { return fixture.configs; }
  write(configs: unknown[]) { fixture.configs = configs; }
} }));
vi.mock("../logger", () => ({ logger: { info: vi.fn(), warn: vi.fn() }, LogTag: { MCP: "mcp" } }));

import { addMcpServer, initMcpManager, setMcpServerEnabled } from "./mcp-manager";

const server = { id: "private", name: "Private", transport: "stdio" as const, command: "node" };
const secret = "synthetic-private-credential";
beforeEach(() => { fixture.configs = []; fixture.connect.mockReset(); });

describe("MCP manager diagnostic privacy", () => {
  it.each(["add", "enable"])("returns a fixed error and reason on %s", async operation => {
    fixture.connect.mockRejectedValue(Object.assign(new Error(`spawn ${secret} ENOENT`), { code: "ENOENT" }));
    fixture.configs = operation === "enable" ? [{ ...server, enabled: false }] : [];
    const result = operation === "enable" ? await setMcpServerEnabled(server.id, true) : await addMcpServer(server);
    expect(result).toMatchObject({ ok: false, error: "MCP_CONNECTION_FAILED", reason: "command-not-found" });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("does not log a startup connection's raw error", async () => {
    fixture.configs = [server];
    fixture.connect.mockRejectedValue(new Error(secret));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await initMcpManager();
      expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    } finally { log.mockRestore(); }
  });
});
