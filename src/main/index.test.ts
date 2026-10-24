import { beforeEach, describe, it, expect, vi } from "vitest";
const servers = vi.hoisted(() => ({ add: vi.fn(), remove: vi.fn(), list: vi.fn() }));
vi.mock("electron", () => ({ app: { getPath: vi.fn() }, ipcMain: { handle: vi.fn() } }));
vi.mock("./orchestrator/mcp-manager", () => ({ addMcpServer: servers.add, removeMcpServer: servers.remove, listMcpServerConfigs: servers.list }));
import { syncPlaywrightMcp, buildPlaywrightMcpConfig, PLAYWRIGHT_MCP_ID } from "./orchestrator/sync-mcp-builtin";
beforeEach(() => { vi.clearAllMocks(); servers.add.mockResolvedValue({ ok: true, toolIds: [] }); servers.remove.mockResolvedValue({ ok: true }); servers.list.mockReturnValue([]); });
describe("builtin browser server reconciliation", () => {
    it.each([false, true])("reconciles disabled mode with stored=%s", stored => {
        if (stored)
            servers.list.mockReturnValue([buildPlaywrightMcpConfig()]);
        return syncPlaywrightMcp({ playwrightMcpEnabled: false }).then(() => {
            expect(servers.add).not.toHaveBeenCalled();
            expect(servers.remove.mock.calls).toEqual(stored ? [[PLAYWRIGHT_MCP_ID]] : []);
        });
    });
    it("keeps an already matching enabled configuration", async () => {
        servers.list.mockReturnValue([buildPlaywrightMcpConfig()]);
        await syncPlaywrightMcp({ playwrightMcpEnabled: true });
        expect(servers.add).not.toHaveBeenCalled();
        expect(servers.remove).not.toHaveBeenCalled();
    });
    it.each([false, true])("installs the bundled stdio command with stale=%s", async (stale) => {
        if (stale)
            servers.list.mockReturnValue([{ id: PLAYWRIGHT_MCP_ID, command: "npx", transport: "stdio", args: ["-y", "@playwright/mcp@latest"] }]);
        await syncPlaywrightMcp({ playwrightMcpEnabled: true });
        expect(servers.add).toHaveBeenCalledTimes(1);
        expect(servers.add).toHaveBeenCalledWith(expect.objectContaining({
            id: PLAYWRIGHT_MCP_ID, transport: "stdio", command: process.execPath,
            args: [expect.stringContaining("cli.js"), "--isolated", "--headless", "--browser", "msedge"], env: { ELECTRON_RUN_AS_NODE: "1" },
        }));
        if (stale) {
            expect(servers.remove).toHaveBeenCalledExactlyOnceWith(PLAYWRIGHT_MCP_ID);
            expect(servers.remove).toHaveBeenCalledBefore(servers.add);
        }
    });
});
