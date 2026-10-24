// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BrowserToolRequest, BrowserToolsChange } from "../../../../../shared/browser-tools";
vi.mock("../../../i18n", () => ({ useTranslation: () => ({ t: (key: string, options?: Record<string, unknown>) => options ? `${key}${JSON.stringify(options)}` : key }) }));
import { useBrowserChrome, type BrowserChromeInput } from "./useBrowserChrome";

type Reply = { ok: true; value: unknown } | { ok: false; code: string };
let host: HTMLDivElement, root: ReturnType<typeof createRoot>, calls: Array<[BrowserToolRequest, string | undefined]>;
let respond: (request: BrowserToolRequest) => Reply, listeners: Array<(change: BrowserToolsChange) => void>;
const baseState = { zoomPercent: 100, device: "off", find: null };
function defaults(request: BrowserToolRequest): Reply {
  switch (request.tool) {
    case "download": return { ok: true, value: { downloads: [] } };
    case "settings": return { ok: true, value: { settings: { askWhereToSave: false, downloadFolderName: null } } };
    case "state": case "stop-find": case "device": return { ok: true, value: baseState };
    case "zoom": return { ok: true, value: { ...baseState, zoomPercent: 110 } };
    case "find": return { ok: true, value: { ...baseState, find: { query: request.text, active: 1, matches: 3 } } };
    case "snapshot": return { ok: true, value: { image: "data:image/jpeg;base64,AA==" } };
    case "history": return { ok: true, value: { entries: [{ index: 1, url: "https://b.example/", title: "B", current: true }, { index: 0, url: "https://a.example/", title: "A", current: false }] } };
    case "cookies": return { ok: true, value: { domains: [{ domain: "a.test", count: 2 }] } };
    case "clear-data": return { ok: true, value: { cleared: true } };
    case "screenshot": return { ok: true, value: { saved: true } };
    case "print": return { ok: true, value: { started: true } };
  }
}
let navigate: ReturnType<typeof vi.fn>, reload: ReturnType<typeof vi.fn>;
function Harness(props: BrowserChromeInput) {
  const chrome = useBrowserChrome(props);
  return createElement("div", null,
    createElement("div", { id: "end" }, chrome.toolbarEnd), createElement("div", { id: "below" }, chrome.belowToolbar),
    createElement("div", { id: "overlay", "data-open": String(chrome.overlayOpen), "data-snapshot": chrome.snapshot ?? "" }, chrome.overlay));
}
const props = (over: Partial<BrowserChromeInput> = {}): BrowserChromeInput => ({ tabId: "tab-1", enabled: true, pageLoaded: true, navigate, reload, ...over });
const render = (over: Partial<BrowserChromeInput> = {}) => act(async () => root.render(createElement(Harness, props(over))));
const q = <T extends Element = HTMLElement>(selector: string) => host.querySelector<T>(selector)!;
const click = (element: Element | null) => act(async () => { (element as HTMLElement).click(); });
const settle = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const tools = () => calls.map(([request]) => request.tool);
const menuItem = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]')].find(node => node.textContent?.includes(text) || node.getAttribute("aria-label")?.includes(text))!;
const openMenu = async () => { await click(q("[data-browser-more-button]")); await settle(); };

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.useFakeTimers();
  calls = []; listeners = []; respond = defaults; navigate = vi.fn(); reload = vi.fn();
  (window as unknown as { manualBrowserWorkspace: unknown }).manualBrowserWorkspace = {
    tool: vi.fn(async (request: BrowserToolRequest, tabId?: string) => { calls.push([request, tabId]); return respond(request); }),
    onToolsChanged: (listener: (change: BrowserToolsChange) => void) => { listeners.push(listener); return () => { listeners.splice(listeners.indexOf(listener), 1); }; },
  };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); delete (window as unknown as { manualBrowserWorkspace?: unknown }).manualBrowserWorkspace; vi.useRealTimers(); vi.unstubAllGlobals(); });

it("offers nothing without the bridge, for a tab that is not a window tab, or while hidden", async () => {
  await render({ enabled: false }); expect(host.querySelector("[data-browser-more-button]")).toBeNull();
  await render({ tabId: undefined }); expect(host.querySelector("[data-browser-more-button]")).toBeNull();
  delete (window as unknown as { manualBrowserWorkspace?: unknown }).manualBrowserWorkspace;
  await render(); expect(host.querySelector("[data-browser-more-button]")).toBeNull();
  expect(q("#overlay").dataset.open).toBe("false");
});

it("loads the window's downloads and settings and the tab's state for its own tab id", async () => {
  await render(); await settle();
  expect(calls.map(([r, id]) => [r.tool, id])).toEqual(expect.arrayContaining([["download", "tab-1"], ["settings", "tab-1"], ["state", "tab-1"]]));
});

it("opens the menu after taking a snapshot, detaching the page behind it, and closes on an outside click", async () => {
  await render(); await settle();
  await openMenu();
  expect(tools()).toContain("snapshot");
  expect(q('[role="menu"]')).not.toBeNull(); expect(q("#overlay").dataset.open).toBe("true"); expect(q("#overlay").dataset.snapshot).toBe("data:image/jpeg;base64,AA==");
  await click(q("[data-browser-more-button]")); await settle(); // the button toggles
  expect(host.querySelector('[role="menu"]')).toBeNull(); expect(q("#overlay").dataset.open).toBe("false"); expect(q("#overlay").dataset.snapshot).toBe("");
  await openMenu();
  await act(async () => { q("[data-browser-backdrop]").dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
  expect(q("#overlay").dataset.open).toBe("false");
});

it("still opens the menu when the snapshot fails, and skips it when no page is loaded", async () => {
  respond = request => request.tool === "snapshot" ? { ok: false, code: "failed" } : defaults(request);
  await render(); await settle(); await openMenu();
  expect(q('[role="menu"]')).not.toBeNull(); expect(q("#overlay").dataset.snapshot).toBe("");
  await click(q("[data-browser-more-button]")); await settle();
  calls.length = 0; await render({ pageLoaded: false }); await openMenu();
  expect(tools()).not.toContain("snapshot"); expect(q('[role="menu"]')).not.toBeNull();
});

it("find: opens the bar, searches the typed text, steps, and stops when closed", async () => {
  await render(); await settle(); await openMenu();
  await click(menuItem("tools.find")); await settle();
  expect(host.querySelector('[role="menu"]')).toBeNull(); expect(q("#overlay").dataset.open).toBe("false");
  const input = q<HTMLInputElement>("[data-browser-find-bar] input");
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "cat"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  await settle(200);
  expect(calls.at(-1)![0]).toEqual({ tool: "find", text: "cat", forward: true, next: false });
  expect(q(".ff-browser-find__count").textContent).toContain('"total":3');
  await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); }); await settle();
  expect(calls.at(-1)![0]).toEqual({ tool: "find", text: "cat", forward: true, next: true });
  await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); }); await settle();
  expect(host.querySelector("[data-browser-find-bar]")).toBeNull(); expect(calls.at(-1)![0]).toEqual({ tool: "stop-find" });
});

it("zoom and device go to Main and the menu shows what Main answers", async () => {
  await render(); await settle(); await openMenu();
  await click(menuItem("tools.zoomIn")); await settle();
  expect(calls.at(-1)![0]).toEqual({ tool: "zoom", op: "in" }); expect(q("output").textContent).toBe("110%");
  await click(menuItem("tools.device")); await click(menuItem("tools.devicePhone")); await settle();
  expect(calls.at(-1)![0]).toEqual({ tool: "device", preset: "phone" });
  expect(q('[role="menu"]')).not.toBeNull();
  expect(reload).toHaveBeenCalledTimes(1); // the user agent changed, so the page is loaded again
});

it("choosing the device preview that is already active does not reload the page, and a refused change does not either", async () => {
  await render(); await settle(); await openMenu();
  await click(menuItem("tools.device")); await click(menuItem("tools.deviceOff")); await settle();
  expect(calls.at(-1)![0]).toEqual({ tool: "device", preset: "off" }); expect(reload).not.toHaveBeenCalled();
  respond = request => request.tool === "device" ? { ok: false, code: "failed" } : defaults(request);
  await click(menuItem("tools.devicePhone")); await settle();
  expect(reload).not.toHaveBeenCalled();
});

it("print and screenshot wait for the page to come back, then run; a saved screenshot is acknowledged and a failure is reported", async () => {
  await render(); await settle(); await openMenu(); calls.length = 0;
  await click(menuItem("tools.print"));
  expect(host.querySelector('[role="menu"]')).toBeNull(); expect(tools()).not.toContain("print");
  await settle(350); expect(tools()).toContain("print");
  await openMenu(); await click(menuItem("tools.screenshot")); await settle(350);
  expect(tools()).toContain("screenshot"); expect(q("[data-browser-tool-notice]").textContent).toBe("browserWorkspace.tools.screenshotSaved");
  await settle(4500); expect(host.querySelector("[data-browser-tool-notice]")).toBeNull();
  respond = request => request.tool === "print" ? { ok: false, code: "failed" } : defaults(request);
  await openMenu(); await click(menuItem("tools.print")); await settle(350);
  expect(q("[data-browser-tool-notice]").textContent).toBe("browserWorkspace.tools.toolFailed");
  respond = request => request.tool === "print" ? { ok: false, code: "unsupported" } : defaults(request);
  await openMenu(); await click(menuItem("tools.print")); await settle(350);
  expect(q("[data-browser-tool-notice]").textContent).toBe("browserWorkspace.tools.toolUnavailable");
});

it("history lists this tab's entries and navigates to the picked one", async () => {
  await render(); await settle(); await openMenu();
  await click(menuItem("tools.history")); await settle();
  expect(host.querySelectorAll("[data-history-index]")).toHaveLength(2);
  await click(q('[data-history-index="0"]'));
  expect(navigate).toHaveBeenCalledWith("https://a.example/"); expect(q("#overlay").dataset.open).toBe("false");
});

it("settings: shows the tab's cookies, clears one site, and reloads the list", async () => {
  await render(); await settle(); await openMenu();
  await click(menuItem("tools.cookies")); await settle();
  expect(q('[data-browser-layer="settings"]')).not.toBeNull(); expect(tools()).toContain("cookies");
  expect(q('[data-cookie-clear="a.test"]')).not.toBeNull();
  calls.length = 0;
  await click(q('[data-cookie-clear="a.test"]')); await settle();
  expect(calls[0][0]).toEqual({ tool: "clear-data", kinds: ["cookies"], domain: "a.test" });
  expect(tools()).toContain("cookies"); expect(q(".ff-browser-settings__status").textContent).toBe("browserWorkspace.tools.clearDone");
  await click(q("[data-clear-run]")); await settle();
  expect(calls.find(([r]) => r.tool === "clear-data" && !("domain" in r))![0]).toEqual({ tool: "clear-data", kinds: ["cookies", "cache"] });
  respond = request => request.tool === "clear-data" ? { ok: false, code: "failed" } : defaults(request);
  await click(q("[data-cookies-clear-all]")); await settle();
  expect(q(".ff-browser-settings__status").textContent).toBe("browserWorkspace.tools.toolFailed");
});

it("settings: the download options go to Main and Main's pushed settings replace the shown ones", async () => {
  await render(); await settle(); await openMenu();
  await click(menuItem("tools.settings")); await settle();
  await click(q("[data-ask-where]")); await settle();
  expect(calls.at(-1)![0]).toEqual({ tool: "settings", patch: { askWhereToSave: true } });
  await click(q("[data-folder-change]")); await settle();
  expect(calls.at(-1)![0]).toEqual({ tool: "settings", chooseFolder: true });
  await act(async () => { for (const listener of listeners) listener({ kind: "settings", settings: { askWhereToSave: true, downloadFolderName: "Docs" } }); });
  expect(q("[data-download-folder]").textContent).toBe("Docs");
  await click(q("[data-folder-reset]")); await settle();
  expect(calls.at(-1)![0]).toEqual({ tool: "settings", resetFolder: true });
});

it("downloads: the button shows activity from pushed changes, and the popover drives the downloads", async () => {
  await render(); await settle();
  expect(host.querySelector(".ff-browser-tools__dot")).toBeNull();
  const running = { id: "d1", fileName: "a.zip", host: "x.example", state: "progressing" as const, receivedBytes: 1, totalBytes: 10, openable: true, startedAt: 1 };
  await act(async () => { for (const listener of listeners) listener({ kind: "downloads", downloads: [running] }); });
  expect(q(".ff-browser-tools__dot")).not.toBeNull();
  await click(q("[data-browser-downloads-button]")); await settle();
  await click(q('[data-download-cancel="d1"]')); await settle();
  expect(calls.at(-1)![0]).toEqual({ tool: "download", op: "cancel", id: "d1" });
  await act(async () => { for (const listener of listeners) listener({ kind: "downloads", downloads: [{ ...running, state: "completed", receivedBytes: 10 }] }); });
  expect(host.querySelector(".ff-browser-tools__dot")).toBeNull();
  await click(q('[data-download-open="d1"]')); await settle();
  expect(calls.at(-1)![0]).toEqual({ tool: "download", op: "open", id: "d1" });
});

it("tab changes pushed for another tab are ignored, and a hidden tab closes every surface", async () => {
  await render(); await settle(); await openMenu();
  await act(async () => { for (const listener of listeners) listener({ kind: "tab", tabId: "other", state: { zoomPercent: 200, device: "off", find: null } }); });
  expect(q("output").textContent).toBe("100%");
  await act(async () => { for (const listener of listeners) listener({ kind: "tab", tabId: "tab-1", state: { zoomPercent: 150, device: "off", find: null } }); });
  expect(q("output").textContent).toBe("150%");
  await render({ enabled: false });
  expect(host.querySelector('[role="menu"]')).toBeNull(); expect(q("#overlay").dataset.open).toBe("false");
});
