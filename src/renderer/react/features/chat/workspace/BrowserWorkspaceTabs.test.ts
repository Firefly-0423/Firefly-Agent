// @vitest-environment jsdom
import { act, createElement, useImperativeHandle } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { BrowserWorkspaceStateDto } from "../../../../../shared/manual-browser";
vi.mock("../../../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
let agentClose: ReturnType<typeof vi.fn>;
vi.mock("./ManualBrowserTab", () => ({ ManualBrowserTab: (p: any) => { useImperativeHandle(p.ref, () => ({ close: () => agentClose() })); return createElement("input", { "data-tab": p.tabId ?? "agent", "data-active": p.active, defaultValue: "", "aria-label": "address" }); } }));
import { BrowserWorkspaceTabs } from "./BrowserWorkspaceTabs";
let host: HTMLDivElement, root: ReturnType<typeof createRoot>, state: BrowserWorkspaceStateDto;
let newTab: ReturnType<typeof vi.fn>, closeTab: ReturnType<typeof vi.fn>, selectTab: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  agentClose = vi.fn(async () => true);
  state = { workspaceId: "w", activeTabId: "a", tabs: [{ tabId: "a", page: null }] };
  newTab = vi.fn(async () => { state = { ...state, activeTabId: "b", tabs: [...state.tabs, { tabId: "b", page: null }] }; return { ok: true, value: state }; });
  closeTab = vi.fn(async (id: string) => { state = { ...state, activeTabId: "a", tabs: state.tabs.filter(t => t.tabId !== id) }; return { ok: true, value: state }; });
  selectTab = vi.fn(async (id: string) => { state = { ...state, activeTabId: id }; return { ok: true, value: state }; });
  window.manualBrowserWorkspace = { getTabs: async () => ({ ok: true, value: state }), newTab, closeTab, selectTab, getAvailability: async () => ({ available: true }), getPermission: vi.fn(), requestPermission: vi.fn(), revokePermission: vi.fn(), execute: vi.fn(), onChanged: () => () => {} };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); delete window.manualBrowserWorkspace; vi.unstubAllGlobals(); });
async function render(sessionId?: string, active=true, paneClose = false) { await act(async () => root.render(createElement(BrowserWorkspaceTabs, { sessionId, active, paneClose, onClose() {} }))); }
/** Longer than the 150ms tab exit, so the close has reached Main. */
const afterExit = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 170)); });
it("keeps each tab component and address draft across tab selection and conversation changes", async () => {
  await render(); const input = host.querySelector<HTMLInputElement>('[data-tab="a"]')!; expect(input).not.toBeNull(); input.value = "draft-a";
  await act(async () => host.querySelector<HTMLButtonElement>('[data-browser-new-tab]')!.click());
  expect(newTab).toHaveBeenCalledTimes(1); expect(host.querySelector('[data-tab="a"]')).toBe(input);
  await act(async () => host.querySelector<HTMLButtonElement>('[data-browser-select-tab="a"]')!.click());
  await render("new-conversation"); expect(input.value).toBe("draft-a"); expect(input.dataset.active).toBe("true");
  await render("new-conversation",false); expect(input.dataset.active).toBe("false");
});
it("plays the closing tab's exit before asking Main, and only closes the selected tab", async () => {
  await render(); const input=host.querySelector('[data-tab="a"]');
  await act(async () => host.querySelector<HTMLButtonElement>('[data-browser-new-tab]')!.click());
  await act(async () => host.querySelector<HTMLButtonElement>('[data-browser-close-tab="b"]')!.click());
  expect(host.querySelector('[data-browser-close-tab="b"]')!.closest(".ff-browser-window__tab")!.classList.contains("is-closing")).toBe(true);
  expect(closeTab).not.toHaveBeenCalled();
  await afterExit();
  expect(closeTab).toHaveBeenCalledWith("b"); expect(host.querySelector('[data-tab="b"]')).toBeNull(); expect(host.querySelector('[data-tab="a"]')).toBe(input);
});
it("returns a refused close to view with its error", async () => {
  await render(); await act(async () => host.querySelector<HTMLButtonElement>('[data-browser-new-tab]')!.click());
  closeTab.mockResolvedValueOnce({ ok: false, code: "cleanup_failed" });
  await act(async () => host.querySelector<HTMLButtonElement>('[data-browser-close-tab="b"]')!.click());
  await afterExit();
  expect(host.querySelector('[data-browser-close-tab="b"]')!.closest(".ff-browser-window__tab")!.classList.contains("is-closing")).toBe(false);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("browserWorkspace.cleanupFailed");
});
it("keeps existing tabs and exposes a server tab-limit failure", async () => {
  await render(); newTab.mockResolvedValue({ ok:false, code:"tab_limit" });
  await act(async () => host.querySelector<HTMLButtonElement>('[data-browser-new-tab]')!.click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("browserWorkspace.tabLimit"); expect(host.querySelectorAll('[data-tab="a"]')).toHaveLength(1);
});

it("keeps the new-tab control outside the tab list and offers no pane close unless asked", async () => {
  await render();
  expect(host.querySelector('[role="tablist"] [data-browser-new-tab]')).toBeNull();
  expect(host.querySelector('[data-browser-new-tab]')).not.toBeNull();
  expect(host.querySelector('[data-browser-close-pane]')).toBeNull();
});

it("closes the pane from its own strip through the same Main cleanup when it is the only tab", async () => {
  const onClose = vi.fn();
  vi.mocked(window.manualBrowserWorkspace!.revokePermission).mockResolvedValue({ ok: true, value: { conversationId: null, workspaceId: "w", status: "required", scope: { mode: "manual", hosts: [], actions: ["navigate"] }, requestId: null } });
  await act(async () => root.render(createElement(BrowserWorkspaceTabs, { sessionId: undefined, active: true, paneClose: true, onClose })));
  await act(async () => host.querySelector<HTMLButtonElement>('[data-browser-close-pane]')!.click());
  expect(window.manualBrowserWorkspace!.revokePermission).toHaveBeenCalledWith("w");
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("keeps the panel open until Agent cleanup succeeds and exposes its failure", async () => {
  const onClose = vi.fn(), ref = { current: null as any };
  vi.mocked(window.manualBrowserWorkspace!.revokePermission).mockResolvedValue({ ok: true, value: { conversationId: null, workspaceId: "w", status: "required", scope: { mode: "manual", hosts: [], actions: ["navigate"] }, requestId: null } });
  let finish!: (result:boolean) => void; agentClose.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => root.render(createElement(BrowserWorkspaceTabs,{sessionId:"s",active:true,onClose,ref})));
  let closing!: Promise<boolean>; await act(async () => { closing = ref.current.close(); await Promise.resolve(); });
  expect(onClose).not.toHaveBeenCalled(); expect(agentClose).toHaveBeenCalledTimes(1);
  await act(async () => { finish(false); await closing; });
  expect(onClose).not.toHaveBeenCalled(); expect(host.querySelector('[role="alert"]')?.textContent).toContain("browserWorkspace.cleanupFailed");
});

it("closes the whole pane when the last tab is closed, so no empty pane keeps the width", async () => {
  const onClose = vi.fn();
  vi.mocked(window.manualBrowserWorkspace!.revokePermission).mockResolvedValue({ ok: true, value: { conversationId: null, workspaceId: "w", status: "required", scope: { mode: "manual", hosts: [], actions: ["navigate"] }, requestId: null } });
  await act(async () => root.render(createElement(BrowserWorkspaceTabs, { sessionId: undefined, active: true, paneClose: true, onClose })));
  await act(async () => host.querySelector<HTMLButtonElement>('[data-browser-new-tab]')!.click());
  await act(async () => host.querySelector<HTMLButtonElement>('[data-browser-close-tab="b"]')!.click());
  await afterExit();
  expect(host.querySelector('[data-tab="a"]')).not.toBeNull();
  expect(onClose).not.toHaveBeenCalled();
  await act(async () => host.querySelector<HTMLButtonElement>('[data-browser-close-tab="a"]')!.click());
  await afterExit();
  expect(closeTab).toHaveBeenLastCalledWith("a");
  expect(window.manualBrowserWorkspace!.revokePermission).toHaveBeenCalledWith("w");
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("keeps the pane open when Main refuses to close the last tab", async () => {
  const onClose = vi.fn();
  closeTab.mockResolvedValueOnce({ ok: false, code: "cleanup_failed" });
  await act(async () => root.render(createElement(BrowserWorkspaceTabs, { sessionId: undefined, active: true, paneClose: true, onClose })));
  await act(async () => host.querySelector<HTMLButtonElement>('[data-browser-close-tab="a"]')!.click());
  await afterExit();
  expect(onClose).not.toHaveBeenCalled();
  expect(host.querySelector('[data-tab="a"]')).not.toBeNull();
});
