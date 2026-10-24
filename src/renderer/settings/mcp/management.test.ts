// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingsApi } from "../shared/types";

const modal = vi.hoisted(() => ({ showNotice: vi.fn(), showAlert: vi.fn(), showConfirm: vi.fn(), showInputModal: vi.fn(), showHtmlModal: vi.fn() }));
vi.mock("../shared/modal", () => modal);
const row = (id = "weather", name = "Weather", connected = true) => ({ id, name, connected, toolCount: connected ? 2 : 0, toolIds: connected ? ["one", "two"] : [] });
const api = { addMcpServer: vi.fn(), removeMcpServer: vi.fn(), listMcpServers: vi.fn(), setMcpServerEnabled: vi.fn() };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
const click = (selector: string) => { const button = document.querySelector<HTMLButtonElement>(selector); expect(button, selector).not.toBeNull(); button!.click(); };
const list = () => document.querySelector("#mcp-server-list");
const feedback = () => document.querySelector("#mcp-server-feedback");
const remove = () => click('[data-mcp-remove="weather"]');
async function mount() { await import("./panel"); await flush(); }
function inputs() { modal.showInputModal.mockResolvedValueOnce('node "path with space/server.js" --flag').mockResolvedValueOnce("New server"); }

beforeEach(() => {
  vi.resetModules(); vi.resetAllMocks();
  document.body.innerHTML = '<section id="mcp-panel"><h1 id="mcp-panel-title">MCP</h1><button class="mcp-add-btn"></button><div class="mcp-server-host"></div></section>';
  window.settings = api as unknown as SettingsApi;
  api.listMcpServers.mockResolvedValue([row()]);
  api.addMcpServer.mockResolvedValue({ ok: true, toolIds: ["tool"] });
  api.removeMcpServer.mockResolvedValue({ ok: true });
  api.setMcpServerEnabled.mockResolvedValue({ ok: true, toolIds: ["tool"] });
  modal.showConfirm.mockResolvedValue(true);
  modal.showAlert.mockResolvedValue(undefined);
});
afterEach(() => { window.dispatchEvent(new Event("pagehide")); document.body.innerHTML = ""; vi.restoreAllMocks(); });

describe("MCP management UI", () => {
  it("renders live and disconnected status safely without exposing config fields", async () => {
    const name = '<img src=x onerror="bad()">';
    api.listMcpServers.mockResolvedValue([{ ...row("weather", name), command: "synthetic-secret", env: { TOKEN: "synthetic-secret" } }, row("offline", "Offline", false)]);
    await mount();
    expect(list()?.textContent).toContain(name);
    expect(list()?.textContent).toContain("已连接");
    expect(list()?.textContent).toContain("未连接");
    expect(list()?.textContent).toContain("2");
    expect(list()?.querySelector("img")).toBeNull();
    expect(document.body.innerHTML).not.toContain("synthetic-secret");
  });
  it("shows an empty state only after a successful empty read", async () => {
    api.listMcpServers.mockResolvedValue([]); await mount();
    expect(list()?.textContent).toContain("尚未添加");
  });
  it("shows a safe read failure and allows a retry without a fake empty state", async () => {
    api.listMcpServers.mockRejectedValueOnce(new Error("TOKEN=synthetic-secret")); await mount();
    expect(feedback()?.textContent).toContain("读取失败");
    expect(list()?.textContent).not.toContain("尚未添加");
    expect(document.body.textContent).not.toContain("synthetic-secret");
    click("#mcp-refresh-btn"); await flush();
    expect(list()?.textContent).toContain("Weather");
    expect(feedback()?.textContent).toBe("");
  });
  it("keeps the previous list visible when a refresh fails", async () => {
    await mount(); api.listMcpServers.mockRejectedValueOnce(new Error("offline"));
    click("#mcp-refresh-btn"); await flush();
    expect(list()?.textContent).toContain("Weather");
    expect(feedback()?.textContent).toContain("读取失败");
  });
  it("does not queue duplicate add dialogs or execute before explicit confirmation", async () => {
    await mount(); const command = deferred<string | null>(); modal.showInputModal.mockReturnValueOnce(command.promise);
    click(".mcp-add-btn"); click(".mcp-add-btn");
    expect(modal.showInputModal).toHaveBeenCalledTimes(1);
    expect(api.addMcpServer).not.toHaveBeenCalled();
    command.resolve("node synthetic-server.js"); modal.showInputModal.mockResolvedValueOnce("New"); modal.showConfirm.mockResolvedValueOnce(false);
    await flush();
    expect(modal.showConfirm).toHaveBeenCalledTimes(1);
    expect(api.addMcpServer).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLButtonElement>(".mcp-add-btn")?.disabled).toBe(false);
  });
  it.each([null, "", "   "])("canceling or blank command %j never reaches Main", async (command) => {
    await mount(); modal.showInputModal.mockResolvedValueOnce(command);
    click(".mcp-add-btn"); await flush();
    expect(api.addMcpServer).not.toHaveBeenCalled(); expect(modal.showConfirm).not.toHaveBeenCalled();
  });
  it("canceling the name dialog does not silently launch an unnamed server", async () => {
    await mount(); modal.showInputModal.mockResolvedValueOnce("node server.js").mockResolvedValueOnce(null);
    click(".mcp-add-btn"); await flush();
    expect(api.addMcpServer).not.toHaveBeenCalled(); expect(modal.showConfirm).not.toHaveBeenCalled();
  });
  it("adds through the existing stdio contract and refreshes only after Main completes", async () => {
    await mount(); inputs(); const added = deferred<{ ok: boolean; toolIds: string[] }>(); api.addMcpServer.mockReturnValueOnce(added.promise);
    click(".mcp-add-btn"); await flush();
    expect(api.addMcpServer).toHaveBeenCalledWith(expect.objectContaining({ name: "New server", transport: "stdio", command: "node", args: ["path with space/server.js", "--flag"] }));
    expect(list()?.textContent).not.toContain("New server");
    api.listMcpServers.mockResolvedValueOnce([row(), row("new", "New server")]); added.resolve({ ok: true, toolIds: ["tool"] }); await flush();
    expect(list()?.textContent).toContain("New server");
    expect(document.querySelector<HTMLButtonElement>(".mcp-add-btn")?.disabled).toBe(false);
  });
  it("preserves rows on add failure and never echoes command/credential errors to DOM or logs", async () => {
    await mount(); inputs(); api.addMcpServer.mockResolvedValueOnce({ ok: false, error: "TOKEN=synthetic-secret" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {}); const error = vi.spyOn(console, "error").mockImplementation(() => {});
    click(".mcp-add-btn"); await flush();
    expect(list()?.textContent).toContain("Weather");
    expect(modal.showAlert).toHaveBeenCalled();
    const exposed = JSON.stringify([modal.showAlert.mock.calls, log.mock.calls, error.mock.calls]);
    expect(exposed).not.toContain("synthetic-secret"); expect(exposed).not.toContain("path with space");
    expect(document.querySelector<HTMLButtonElement>(".mcp-add-btn")?.disabled).toBe(false);
  });
  it("canceling deletion leaves both server and config untouched", async () => {
    await mount(); modal.showConfirm.mockResolvedValueOnce(false); remove(); await flush();
    expect(modal.showConfirm).toHaveBeenCalledWith(expect.objectContaining({ dangerous: true }));
    expect(api.removeMcpServer).not.toHaveBeenCalled(); expect(list()?.textContent).toContain("Weather");
  });
  it("deduplicates delete clicks and removes rows only after persistence succeeds", async () => {
    await mount(); const deletion = deferred<{ ok: boolean }>(); api.removeMcpServer.mockReturnValueOnce(deletion.promise);
    remove(); remove(); await flush();
    expect(api.removeMcpServer).toHaveBeenCalledTimes(1); expect(list()?.textContent).toContain("Weather");
    api.listMcpServers.mockResolvedValueOnce([]); deletion.resolve({ ok: true }); await flush();
    expect(list()?.textContent).toContain("尚未添加");
  });
  it.each(["result", "reject"])("keeps a failed deletion visible and controls retryable (%s)", async (mode) => {
    await mount(); if (mode === "result") api.removeMcpServer.mockResolvedValueOnce({ ok: false, error: "synthetic-secret" }); else api.removeMcpServer.mockRejectedValueOnce(new Error("synthetic-secret"));
    remove(); await flush();
    expect(list()?.textContent).toContain("Weather"); expect(modal.showAlert).toHaveBeenCalled();
    expect(JSON.stringify(modal.showAlert.mock.calls)).not.toContain("synthetic-secret");
    expect(document.querySelector<HTMLButtonElement>('[data-mcp-remove="weather"]')?.disabled).toBe(false);
  });
  it("leaves built-in Playwright under its existing setting instead of offering conflicting deletion", async () => {
    api.listMcpServers.mockResolvedValueOnce([row("playwright-mcp", "Playwright")]); await mount();
    expect(list()?.textContent).toContain("工具配置"); expect(list()?.querySelector("[data-mcp-remove]")).toBeNull();
    const nav = document.createElement("button"); nav.className = "nav-item"; nav.dataset.section = "plugins"; const opened = vi.fn(); nav.addEventListener("click", opened); document.body.append(nav);
    const open = [...list()!.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "前往工具配置");
    expect(open).toBeDefined(); open!.click(); expect(opened).toHaveBeenCalledTimes(1);
  });
  it("ignores an older list result after a confirmed add refresh", async () => {
    const stale = deferred<ReturnType<typeof row>[]>(); api.listMcpServers.mockReturnValueOnce(stale.promise); await mount();
    inputs(); api.listMcpServers.mockResolvedValueOnce([row("new", "New server")]); click(".mcp-add-btn"); await flush();
    stale.resolve([row("old", "Old snapshot")]); await flush();
    expect(list()?.textContent).toContain("New server"); expect(list()?.textContent).not.toContain("Old snapshot");
  });
  it("retains an in-flight initial read when addition is canceled", async () => {
    const pending = deferred<ReturnType<typeof row>[]>(); api.listMcpServers.mockReturnValueOnce(pending.promise); await mount();
    modal.showInputModal.mockResolvedValueOnce(null); click(".mcp-add-btn"); await flush();
    pending.resolve([row()]); await flush();
    expect(list()?.textContent).toContain("Weather");
    expect(api.addMcpServer).not.toHaveBeenCalled();
  });
  it("does not start a command after the window unloads during confirmation", async () => {
    await mount(); inputs(); const confirmation = deferred<boolean>(); modal.showConfirm.mockReturnValueOnce(confirmation.promise);
    click(".mcp-add-btn"); await flush(); window.dispatchEvent(new Event("pagehide")); confirmation.resolve(true); await flush();
    expect(api.addMcpServer).not.toHaveBeenCalled();
  });
  it("does not revive UI or refresh after an in-flight operation returns to an unloaded window", async () => {
    await mount(); inputs(); const added = deferred<{ ok: boolean }>(); api.addMcpServer.mockReturnValueOnce(added.promise);
    click(".mcp-add-btn"); await flush(); window.dispatchEvent(new Event("pagehide")); document.body.innerHTML = "";
    added.resolve({ ok: true }); await flush();
    expect(document.body.innerHTML).toBe(""); expect(api.listMcpServers).toHaveBeenCalledTimes(1); expect(modal.showNotice).not.toHaveBeenCalled();
  });
  it("does not paint a list into a detached settings panel after a late response", async () => {
    const pending = deferred<ReturnType<typeof row>[]>(); api.listMcpServers.mockReturnValueOnce(pending.promise); await mount();
    document.getElementById("mcp-panel")!.remove(); pending.resolve([row()]); await flush(); expect(document.body.innerHTML).toBe("");
  });
});

describe("MCP enable, disable and failure reasons", () => {
  const action = (kind: string, id = "weather") => `[data-mcp-action="${kind}:${id}"]`;

  it("shows a disabled server as disabled with an Enable action, and a running one with Disable", async () => {
    api.listMcpServers.mockResolvedValue([{ ...row("off", "Off", false), enabled: false }, row("on", "On", true)]); await mount();
    expect(list()?.textContent).toContain("已停用");
    expect(document.querySelector(action("enable", "off"))).not.toBeNull();
    expect(document.querySelector(action("disable", "off"))).toBeNull();
    expect(document.querySelector(action("disable", "on"))).not.toBeNull();
    expect(document.querySelector(action("enable", "on"))).toBeNull();
  });

  it("explains why an enabled server is not connected, and offers Reconnect next to Disable", async () => {
    api.listMcpServers.mockResolvedValue([{ ...row("weather", "Weather", false), enabled: true, failure: "command-not-found" }]); await mount();
    expect(list()?.textContent).toContain("找不到启动命令");
    expect(document.querySelector(action("enable"))?.textContent).toBe("重新连接");
    expect(document.querySelector(action("disable"))).not.toBeNull();
  });

  it("shows an unrecognised reason as an unknown failure and never as text from Main", async () => {
    api.listMcpServers.mockResolvedValue([{ ...row("weather", "Weather", false), enabled: true, failure: "TOKEN=synthetic-secret" }]); await mount();
    expect(list()?.textContent).toContain("原因未知");
    expect(document.body.textContent).not.toContain("synthetic-secret");
  });

  it("disables a server and reports it", async () => {
    await mount();
    click(action("disable")); await flush();
    expect(api.setMcpServerEnabled).toHaveBeenCalledWith("weather", false);
    expect(modal.showNotice).toHaveBeenCalledWith(expect.objectContaining({ tone: "success", message: expect.stringContaining("已停用") }));
  });

  it("enables a server and reports the tool count", async () => {
    api.listMcpServers.mockResolvedValue([{ ...row("weather", "Weather", false), enabled: false }]); await mount();
    click(action("enable")); await flush();
    expect(api.setMcpServerEnabled).toHaveBeenCalledWith("weather", true);
    expect(modal.showNotice).toHaveBeenCalledWith(expect.objectContaining({ tone: "success", message: expect.stringContaining("已启用") }));
  });

  it("stays quiet when the native confirmation is canceled", async () => {
    api.listMcpServers.mockResolvedValue([{ ...row("weather", "Weather", false), enabled: false }]); await mount();
    api.setMcpServerEnabled.mockResolvedValue({ ok: false, code: "MCP_CANCELLED" });
    click(action("enable")); await flush();
    expect(modal.showAlert).not.toHaveBeenCalled(); expect(modal.showNotice).not.toHaveBeenCalled();
  });

  it("explains a failed enable with the fixed reason only", async () => {
    api.listMcpServers.mockResolvedValue([{ ...row("weather", "Weather", false), enabled: false }]); await mount();
    api.setMcpServerEnabled.mockResolvedValue({ ok: false, code: "MCP_OPERATION_FAILED", error: "TOKEN=synthetic-secret", reason: "timeout" });
    click(action("enable")); await flush();
    const alert = modal.showAlert.mock.calls[0][0];
    expect(alert.message).toContain("连接超时");
    expect(JSON.stringify(alert)).not.toContain("synthetic-secret");
  });

  it("explains a failed add with the fixed reason", async () => {
    await mount(); inputs(); api.addMcpServer.mockResolvedValue({ ok: false, reason: "command-not-found" });
    click(".mcp-add-btn"); await flush();
    expect(modal.showAlert.mock.calls[0][0].message).toContain("找不到启动命令");
  });

  it("falls back to the general message for an add failure without a reason", async () => {
    await mount(); inputs(); api.addMcpServer.mockResolvedValue({ ok: false });
    click(".mcp-add-btn"); await flush();
    expect(modal.showAlert.mock.calls[0][0].message).toContain("未能完成连接或保存");
  });

  it("refreshes the list after a thrown error and shows the general message", async () => {
    await mount(); api.setMcpServerEnabled.mockRejectedValue(new Error("TOKEN=synthetic-secret")); api.listMcpServers.mockClear();
    click(action("disable")); await flush();
    expect(api.listMcpServers).toHaveBeenCalled();
    expect(JSON.stringify(modal.showAlert.mock.calls)).not.toContain("synthetic-secret");
  });

  it("gives the built-in server no enable or disable action", async () => {
    api.listMcpServers.mockResolvedValue([row("playwright-mcp", "Playwright", true)]); await mount();
    expect(document.querySelector('[data-mcp-action]')).toBeNull();
  });
});
