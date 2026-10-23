// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BrowserDownloadDto } from "../../../../../shared/browser-tools";
vi.mock("../../../i18n", () => ({ useTranslation: () => ({ t: (key: string, options?: Record<string, unknown>) => options ? `${key}${JSON.stringify(options)}` : key }) }));
import { BrowserFindBar } from "./BrowserFindBar";
import { BrowserDownloadsPopover, BrowserHistoryPopover, BrowserMoreMenu } from "./BrowserToolsMenu";
import { BrowserSettingsPanel } from "./BrowserSettingsPanel";

let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.useFakeTimers();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const render = (element: ReturnType<typeof createElement>) => act(async () => root.render(element));
const q = <T extends Element = HTMLElement>(selector: string) => host.querySelector<T>(selector)!;
const click = (element: Element | null) => act(async () => (element as HTMLElement).click());
function type(input: HTMLInputElement, value: string) {
  return act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const key = (element: Element, name: string, init: KeyboardEventInit = {}) => act(async () => { element.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init })); });

it("find bar searches after a typing pause, steps on Enter, closes on Escape, and shows the match count", async () => {
  const onQuery = vi.fn(), onStep = vi.fn(), onClose = vi.fn();
  await render(createElement(BrowserFindBar, { find: null, onQuery, onStep, onClose }));
  const input = q<HTMLInputElement>("input");
  expect(document.activeElement).toBe(input);
  await type(input, "  cat ");
  expect(onQuery).not.toHaveBeenCalled();
  await act(async () => { vi.advanceTimersByTime(200); });
  expect(onQuery).toHaveBeenCalledWith("cat");
  await key(input, "Enter"); expect(onStep).toHaveBeenLastCalledWith(true, "cat");
  await key(input, "Enter", { shiftKey: true }); expect(onStep).toHaveBeenLastCalledWith(false, "cat");
  await key(input, "Escape"); expect(onClose).toHaveBeenCalledTimes(1);
  await type(input, "");
  await act(async () => { vi.advanceTimersByTime(200); });
  expect(onQuery).toHaveBeenLastCalledWith("");
  await render(createElement(BrowserFindBar, { find: { query: "cat", active: 2, matches: 7 }, onQuery, onStep, onClose }));
  expect(q(".ff-browser-find__count").textContent).toContain('"active":2'); expect(q(".ff-browser-find__count").textContent).toContain('"total":7');
  await click(host.querySelectorAll(".ff-browser-find button")[1]); expect(onStep).toHaveBeenLastCalledWith(true, "cat");
  await render(createElement(BrowserFindBar, { find: { query: "zzz", active: 0, matches: 0 }, onQuery, onStep, onClose }));
  expect(q(".ff-browser-find__count").textContent).toBe("browserWorkspace.tools.findNone");
  expect(host.querySelectorAll<HTMLButtonElement>(".ff-browser-find button")[0].disabled).toBe(true);
});

function menu(overrides: Partial<Parameters<typeof BrowserMoreMenu>[0]> = {}) {
  const props = { pageLoaded: true, zoomPercent: 100, device: "off" as const, onAction: vi.fn(), onZoom: vi.fn(), onDevice: vi.fn(), onClose: vi.fn(), ...overrides };
  return { props, element: createElement(BrowserMoreMenu, props) };
}
const item = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]')].find(node => node.textContent?.includes(text) || node.getAttribute("aria-label")?.includes(text))!;

it("more menu: page tools need a page, other entries do not", async () => {
  const { element } = menu({ pageLoaded: false }); await render(element);
  for (const label of ["tools.find", "tools.print", "tools.screenshot", "tools.history", "tools.device"]) expect(item(label).disabled, label).toBe(true);
  for (const label of ["tools.cookies", "tools.downloads", "tools.clearData", "tools.settings"]) expect(item(label).disabled, label).toBe(false);
  expect(item("tools.zoomIn").disabled).toBe(true);
});

it("more menu: entries report their action and zoom and device keep the menu open", async () => {
  const { props, element } = menu({ zoomPercent: 110 }); await render(element);
  for (const [label, action] of [["tools.find", "find"], ["tools.print", "print"], ["tools.screenshot", "screenshot"], ["tools.cookies", "cookies"], ["tools.downloads", "downloads"],
    ["tools.history", "history"], ["tools.clearData", "clear-data"], ["tools.settings", "settings"]] as const) {
    await click(item(label)); expect(props.onAction, action).toHaveBeenLastCalledWith(action);
  }
  expect(q("output").textContent).toBe("110%");
  await click(item("tools.zoomIn")); await click(item("tools.zoomOut")); await click(item("tools.zoomReset"));
  expect(props.onZoom.mock.calls).toEqual([["in"], ["out"], ["reset"]]);
  expect(props.onClose).not.toHaveBeenCalled();
  await click(item("tools.device"));
  await click(item("tools.devicePhone")); await click(item("tools.deviceTablet")); await click(item("tools.deviceOff"));
  expect(props.onDevice.mock.calls).toEqual([["phone"], ["tablet"], ["off"]]);
});

it("more menu: zoom limits disable the buttons, the current device is checked, Escape and arrows work", async () => {
  const first = menu({ zoomPercent: 500, device: "tablet" }); await render(first.element);
  expect(item("tools.zoomIn").disabled).toBe(true); expect(item("tools.zoomOut").disabled).toBe(false);
  expect(item("tools.deviceTablet").getAttribute("aria-checked")).toBe("true"); expect(item("tools.devicePhone").getAttribute("aria-checked")).toBe("false");
  await render(menu({ zoomPercent: 25 }).element); expect(item("tools.zoomOut").disabled).toBe(true);
  const { props, element } = menu(); await render(element);
  const root = q('[role="menu"]');
  expect(document.activeElement).toBe(item("tools.find"));
  await key(root, "ArrowDown"); expect(document.activeElement).toBe(item("tools.print"));
  await key(root, "End"); expect(document.activeElement).toBe(item("tools.settings"));
  await key(root, "ArrowDown"); expect(document.activeElement).toBe(item("tools.find"));
  await key(root, "Escape"); expect(props.onClose).toHaveBeenCalledTimes(1);
});

const download = (over: Partial<BrowserDownloadDto>): BrowserDownloadDto => ({ id: "d1", fileName: "a.zip", host: "files.example", state: "completed", receivedBytes: 2048, totalBytes: 2048, openable: true, startedAt: 1, ...over });
it("downloads popover: shows each state with the right actions", async () => {
  const handlers = { onOpen: vi.fn(), onReveal: vi.fn(), onCancel: vi.fn(), onRemove: vi.fn(), onClear: vi.fn(), onSettings: vi.fn(), onClose: vi.fn() };
  await render(createElement(BrowserDownloadsPopover, { ...handlers, downloads: [] }));
  expect(q(".ff-browser-popover__empty").textContent).toBe("browserWorkspace.tools.downloadsEmpty");
  await render(createElement(BrowserDownloadsPopover, { ...handlers, downloads: [
    download({ id: "d1", state: "progressing", receivedBytes: 1024, totalBytes: 4096 }), download({ id: "d2", fileName: "setup.exe", openable: false }),
    download({ id: "d3", state: "failed" }), download({ id: "d4", fileName: "doc.pdf" }),
  ] }));
  expect(q('[data-download-cancel="d1"]')).not.toBeNull(); expect(q("progress")).not.toBeNull();
  expect(q<HTMLButtonElement>('[data-download-open="d2"]').disabled).toBe(true); expect(q<HTMLButtonElement>('[data-download-reveal="d2"]').disabled).toBe(false);
  expect(q('[data-download-remove="d3"]')).not.toBeNull(); expect(q('[data-download-open="d3"]', ) ?? null).toBeNull();
  await click(q('[data-download-open="d4"]')); expect(handlers.onOpen).toHaveBeenCalledWith("d4");
  await click(q('[data-download-reveal="d2"]')); expect(handlers.onReveal).toHaveBeenCalledWith("d2");
  await click(q('[data-download-cancel="d1"]')); expect(handlers.onCancel).toHaveBeenCalledWith("d1");
  await click(q('[data-download-remove="d3"]')); expect(handlers.onRemove).toHaveBeenCalledWith("d3");
  await click(q("[data-downloads-clear]")); expect(handlers.onClear).toHaveBeenCalled();
  await click(q(".ff-browser-popover__head button")); expect(handlers.onSettings).toHaveBeenCalled();
  expect(host.textContent).toContain("files.example");
  await key(q('[role="dialog"]'), "Escape"); expect(handlers.onClose).toHaveBeenCalled();
});

it("history popover lists entries newest first and reports the picked address", async () => {
  const onPick = vi.fn(), onClose = vi.fn();
  await render(createElement(BrowserHistoryPopover, { entries: null, onPick, onClose }));
  expect(host.querySelector(".ff-browser-popover__empty")).toBeNull();
  await render(createElement(BrowserHistoryPopover, { entries: [{ index: 1, url: "https://b.example/", title: "B", current: true }, { index: 0, url: "https://a.example/", title: "", current: false }], onPick, onClose }));
  expect(host.querySelectorAll("[data-history-index]")).toHaveLength(2);
  expect(q('[data-history-index="0"]').textContent).toContain("https://a.example/");
  expect(q('[data-history-index="1"]').getAttribute("aria-current")).toBe("true");
  await click(q('[data-history-index="0"]')); expect(onPick).toHaveBeenCalledWith("https://a.example/");
  await render(createElement(BrowserHistoryPopover, { entries: [], onPick, onClose }));
  expect(q(".ff-browser-popover__empty").textContent).toBe("browserWorkspace.tools.historyEmpty");
});

function settings(over: Partial<Parameters<typeof BrowserSettingsPanel>[0]> = {}) {
  const props = { section: "downloads" as const, settings: { askWhereToSave: false, downloadFolderName: null }, cookies: [{ domain: "a.test", count: 3 }, { domain: "b.test", count: 1 }],
    status: null, busy: false, onAskWhere: vi.fn(), onChooseFolder: vi.fn(), onResetFolder: vi.fn(), onClearSite: vi.fn(), onClear: vi.fn(), onClose: vi.fn(), ...over };
  return { props, element: createElement(BrowserSettingsPanel, props) };
}
it("settings panel: download folder, ask-where, cookie lists and clearing report to their handlers", async () => {
  const { props, element } = settings(); await render(element);
  expect(q("[data-download-folder]").textContent).toBe("browserWorkspace.tools.folderDefault");
  expect(host.querySelector("[data-folder-reset]")).toBeNull();
  await click(q("[data-folder-change]")); expect(props.onChooseFolder).toHaveBeenCalled();
  await click(q("[data-ask-where]")); expect(props.onAskWhere).toHaveBeenCalledWith(true);
  expect(q(".ff-browser-settings__summary").textContent).toContain('"count":4'); expect(q(".ff-browser-settings__summary").textContent).toContain('"sites":2');
  await click(q('[data-cookie-clear="a.test"]')); expect(props.onClearSite).toHaveBeenCalledWith("a.test");
  await click(q("[data-cookies-clear-all]")); expect(props.onClear).toHaveBeenLastCalledWith(["cookies"]);
  await click(q('[data-clear-kind="storage"]')); await click(q('[data-clear-kind="cache"]'));
  await click(q("[data-clear-run]")); expect(props.onClear).toHaveBeenLastCalledWith(["cookies", "storage"]);
  await click(q("[data-settings-close]")); expect(props.onClose).toHaveBeenCalled();
  await key(q('[role="dialog"]'), "Escape"); expect(props.onClose).toHaveBeenCalledTimes(2);
});

it("settings panel: shows a chosen folder by name with a reset, disables controls while busy, and handles empty or loading cookies", async () => {
  const chosen = settings({ settings: { askWhereToSave: true, downloadFolderName: "Docs" }, busy: true, cookies: [], status: "browserWorkspace.tools.clearDone" });
  await render(chosen.element);
  expect(q("[data-download-folder]").textContent).toBe("Docs");
  expect(q<HTMLButtonElement>("[data-folder-reset]").disabled).toBe(true); expect(q<HTMLInputElement>("[data-ask-where]").checked).toBe(true);
  expect(q(".ff-browser-settings__empty").textContent).toBe("browserWorkspace.tools.cookiesEmpty");
  expect(q<HTMLButtonElement>("[data-clear-run]").disabled).toBe(true);
  expect(q(".ff-browser-settings__status").textContent).toBe("browserWorkspace.tools.clearDone");
  await render(settings({ cookies: null, settings: null }).element);
  expect(host.querySelector(".ff-browser-cookies")).toBeNull(); expect(q<HTMLButtonElement>("[data-folder-change]").disabled).toBe(true);
});
