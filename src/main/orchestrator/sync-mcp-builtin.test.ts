import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const manager = vi.hoisted(() => ({ addMcpServer: vi.fn(), removeMcpServer: vi.fn(), listMcpServerConfigs: vi.fn() }));
vi.mock("./mcp-manager", () => manager);
import { buildPlaywrightMcpConfig, resolvePlaywrightMcpCliPath, syncPlaywrightMcp } from "./sync-mcp-builtin";
beforeEach(() => {
  vi.clearAllMocks();
  manager.listMcpServerConfigs.mockReturnValue([]);
  manager.addMcpServer.mockResolvedValue({ ok: true, toolIds: ["browser"] });
  manager.removeMcpServer.mockResolvedValue(undefined);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());
it("builds a bundled, isolated Edge server using the current executable", () => {
  expect(resolvePlaywrightMcpCliPath()).toBe(path.join(path.dirname(require.resolve("@playwright/mcp/package.json")), "cli.js").replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`));
  expect(buildPlaywrightMcpConfig()).toEqual({ id: "playwright-mcp", name: "Playwright 浏览器", transport: "stdio", command: process.execPath, args: [resolvePlaywrightMcpCliPath(), "--isolated", "--headless", "--browser", "msedge"], env: { ELECTRON_RUN_AS_NODE: "1" } });
});
it("defaults to doing nothing when disabled and absent, preserving custom servers", async () => {
  manager.listMcpServerConfigs.mockReturnValue([{ id: "custom" }]);
  await syncPlaywrightMcp({ playwrightMcpEnabled: false });
  expect(manager.addMcpServer).not.toHaveBeenCalled();
  expect(manager.removeMcpServer).not.toHaveBeenCalled();
});
it("registers an opted-in server", async () => {
  await syncPlaywrightMcp({ playwrightMcpEnabled: true });
  expect(manager.addMcpServer).toHaveBeenCalledExactlyOnceWith(buildPlaywrightMcpConfig());
});
it("leaves matching executable, arguments and environment alone", async () => {
  manager.listMcpServerConfigs.mockReturnValue([{ ...buildPlaywrightMcpConfig(), name: "renamed" }]);
  await syncPlaywrightMcp({ playwrightMcpEnabled: true });
  expect(manager.addMcpServer).not.toHaveBeenCalled();
  expect(manager.removeMcpServer).not.toHaveBeenCalled();
});
it.each(["command", "args", "env"])("migrates a stale %s by removing before adding", async (field) => {
  manager.listMcpServerConfigs.mockReturnValue([{ ...buildPlaywrightMcpConfig(), [field]: undefined }]);
  await syncPlaywrightMcp({ playwrightMcpEnabled: true });
  expect(manager.removeMcpServer).toHaveBeenCalledWith("playwright-mcp");
  expect(manager.removeMcpServer.mock.invocationCallOrder[0]).toBeLessThan(manager.addMcpServer.mock.invocationCallOrder[0]);
});
it("continues migration after removal failure", async () => {
  manager.listMcpServerConfigs.mockReturnValue([{ id: "playwright-mcp", command: "npx" }]);
  manager.removeMcpServer.mockRejectedValue(new Error("remove failed"));
  await syncPlaywrightMcp({ playwrightMcpEnabled: true });
  expect(manager.addMcpServer).toHaveBeenCalledOnce();
});
it.each([{ ok: false, error: "offline" }, new Error("offline")])("contains registration failures", async (result) => {
  if (result instanceof Error) manager.addMcpServer.mockRejectedValue(result);
  else manager.addMcpServer.mockResolvedValue(result);
  await expect(syncPlaywrightMcp({ playwrightMcpEnabled: true })).resolves.toBeUndefined();
  expect(console.error).toHaveBeenCalled();
});
it.each([false, true])("removes a disabled server, containing removal failure=%s", async (fail) => {
  manager.listMcpServerConfigs.mockReturnValue([buildPlaywrightMcpConfig()]);
  if (fail) manager.removeMcpServer.mockRejectedValue(new Error("offline"));
  await expect(syncPlaywrightMcp({ playwrightMcpEnabled: false })).resolves.toBeUndefined();
  expect(manager.removeMcpServer).toHaveBeenCalledExactlyOnceWith("playwright-mcp");
});
