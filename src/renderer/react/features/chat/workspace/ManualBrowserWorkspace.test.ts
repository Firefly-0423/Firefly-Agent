// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BrowserWorkspacePageDto, BrowserWorkspacePermissionDto, ManualBrowserCommand } from "../../../../../shared/manual-browser";
vi.mock("../../../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import { ManualBrowserTab } from "./ManualBrowserTab";

const permission = (status: BrowserWorkspacePermissionDto["status"]): BrowserWorkspacePermissionDto => ({ conversationId: null, workspaceId: "w", tabId: "a", status, scope: { mode: "manual", hosts: ["example.com"], resourceHosts: [], actions: ["navigate"] }, requestId: null });
const page = (): BrowserWorkspacePageDto => ({ conversationId: null, workspaceId: "w", tabId: "a", browserId: "b", requestId: 1, closed: false, loading: false, url: "https://example.com/", pendingUrl: null, canGoBack: false, canGoForward: false, error: null });
let host: HTMLDivElement, root: ReturnType<typeof createRoot>, changed: (page: BrowserWorkspacePageDto) => void;
let execute: ReturnType<typeof vi.fn>, request: ReturnType<typeof vi.fn>, revoke: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300, toJSON() {} });
  execute = vi.fn(async (command: ManualBrowserCommand) => ({ ok: true, value: command.kind === "open" ? page() : null }));
  request = vi.fn(async () => ({ ok: true, value: permission("granted") })); revoke = vi.fn(async () => ({ ok: true, value: permission("required") }));
  window.manualBrowserWorkspace = { getAvailability: async () => ({ available: true }), getPermission: async () => ({ ok: true, value: permission("required") }), requestPermission: request, revokePermission: revoke, execute,
    getTabs: vi.fn(), newTab: vi.fn(), selectTab: vi.fn(), closeTab: vi.fn(), onChanged: callback => { changed = callback; return () => {}; } };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); delete window.manualBrowserWorkspace; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function render(sessionId?: string, active = true) { await act(async () => root.render(createElement(ManualBrowserTab, { workspaceId: "w", tabId: "a", sessionId, active, onClose() {} } as any))); }
async function go() {
  const input = host.querySelector<HTMLInputElement>("input")!;
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "https://example.com/"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
}
it("enables welcome-page Go through the workspace bridge as one ordinary web grant", async () => {
  await render(); expect(host.querySelector<HTMLInputElement>("input")!.disabled).toBe(false); await go();
  expect(request).toHaveBeenCalledWith({ mode: "manual", web: true, hosts: [], resourceHosts: [], actions: ["navigate"] }, "a");
  expect(execute).toHaveBeenCalledWith({ kind: "open", url: "https://example.com/" }, "a");
  expect(host.querySelector<HTMLInputElement>("input")!.value).toBe("https://example.com/");
});
it("shows no consent panel for ordinary web browsing, and only a slim bar for a private-network grant", async () => {
  const web = { ...permission("granted"), scope: { mode: "manual" as const, web: true, hosts: [], resourceHosts: [], actions: ["navigate" as const] } };
  window.manualBrowserWorkspace!.getPermission = async () => ({ ok: true, value: web });
  await render();
  expect(host.querySelector(".ff-browser-permission")).toBeNull();
  expect(host.textContent).not.toContain("navigate");
  const local = { ...permission("granted"), scope: { mode: "manual" as const, hosts: ["localhost:5173"], resourceHosts: ["localhost:3000"], actions: ["navigate" as const] } };
  window.manualBrowserWorkspace!.getPermission = async () => ({ ok: true, value: local });
  await act(async () => root.unmount()); root = createRoot(host); await render();
  const bar = host.querySelector(".ff-browser-permission--compact");
  expect(bar?.querySelector(".ff-browser-chip code")?.textContent).toBe("localhost:5173");
  expect(bar?.querySelector(".ff-browser-chip__extra")?.textContent).toBe("+1");
  expect(bar?.querySelector("details")).toBeNull();
  expect(bar?.querySelector("[data-browser-revoke]")).not.toBeNull();
});
it("keeps window browsing mounted across conversation changes and rejects other window/tab events", async () => {
  await render("chat-a"); await go(); await render("chat-b");
  expect(revoke).not.toHaveBeenCalled(); expect(host.querySelector<HTMLInputElement>("input")!.value).toBe("https://example.com/");
  await act(async () => { changed({ ...page(), tabId: "other", requestId: 99, url: "https://foreign.example/" }); changed({ ...page(), workspaceId: "foreign", requestId: 100, url: "https://foreign.example/" }); });
  expect(host.querySelector<HTMLInputElement>("input")!.value).toBe("https://example.com/");
});
it("detaches an inactive native viewport and revokes only its window tab on real unmount", async () => {
  await render(); await go(); await render(undefined, false);
  expect(execute).toHaveBeenCalledWith({ kind: "layout", browserId: "b", bounds: null }, "a");
  await act(async () => root.unmount()); await Promise.resolve();
  expect(revoke).toHaveBeenCalledWith("w", "a");
});
