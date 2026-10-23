// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BrowserToolRequest } from "../../../../../shared/browser-tools";
import type { ManualBrowserCommand } from "../../../../../shared/manual-browser";
vi.mock("../../../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import { ManualBrowserTab } from "./ManualBrowserTab";

const WEB = { mode: "manual", web: true, hosts: [], resourceHosts: [], actions: ["navigate"] };
const LIMITED = { mode: "manual", hosts: ["example.com"], resourceHosts: [], actions: ["navigate"] };
const livePage = { browserId: "b", conversationId: null, workspaceId: "w", tabId: "t", requestId: 1, closed: false, loading: false, url: "https://example.com/", pendingUrl: null, canGoBack: false, canGoForward: false, error: null };
let host: HTMLDivElement, root: ReturnType<typeof createRoot>, layouts: Array<unknown>, toolCalls: BrowserToolRequest[];

function install(scope: unknown, withTools = true) {
  layouts = []; toolCalls = [];
  (window as unknown as { manualBrowserWorkspace: unknown }).manualBrowserWorkspace = {
    getAvailability: async () => ({ available: true }),
    getPermission: async () => ({ ok: true, value: { conversationId: null, workspaceId: "w", tabId: "t", status: "granted", scope, requestId: null } }),
    requestPermission: vi.fn(async () => ({ ok: true, value: null })), revokePermission: vi.fn(async () => ({ ok: true, value: null })),
    execute: vi.fn(async (command: ManualBrowserCommand) => {
      if (command.kind === "layout") { layouts.push(command.bounds); return { ok: true, value: livePage }; }
      return { ok: true, value: command.kind === "get" ? livePage : null };
    }),
    onChanged: () => () => {},
    ...(withTools ? {
      tool: vi.fn(async (request: BrowserToolRequest) => {
        toolCalls.push(request);
        if (request.tool === "download") return { ok: true, value: { downloads: [] } };
        if (request.tool === "settings") return { ok: true, value: { settings: { askWhereToSave: false, downloadFolderName: null } } };
        if (request.tool === "snapshot") return { ok: true, value: { image: "data:image/jpeg;base64,AA==" } };
        return { ok: true, value: { zoomPercent: 100, device: "off", find: null } };
      }),
      onToolsChanged: () => () => {},
    } : {}),
  };
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ x: 300, y: 80, left: 300, top: 80, width: 400, height: 300, right: 700, bottom: 380, toJSON() {} });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); delete (window as unknown as { manualBrowserWorkspace?: unknown }).manualBrowserWorkspace; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const render = async (active = true) => { await act(async () => root.render(createElement(ManualBrowserTab, { workspaceId: "w", tabId: "t", active, onClose: vi.fn() }))); await act(async () => { await Promise.resolve(); }); };
const click = (element: Element | null) => act(async () => { (element as HTMLElement).click(); });
const q = (selector: string) => host.querySelector<HTMLElement>(selector);
const lastLayout = () => layouts.at(-1);

it("shows the tools on an ordinary-browsing window tab and keeps the native page detached while a surface covers it", async () => {
  install(WEB); await render();
  expect(q("[data-browser-more-button]")).not.toBeNull(); expect(q("[data-browser-downloads-button]")).not.toBeNull();
  expect(lastLayout()).toMatchObject({ width: 400, height: 300 }); // page attached
  await click(q("[data-browser-more-button]")); await act(async () => { await Promise.resolve(); });
  expect(q('[role="menu"]')).not.toBeNull(); expect(lastLayout()).toBeNull(); // detached under the menu
  expect(q(".ff-browser-workspace__snapshot")).not.toBeNull(); // with its picture standing in
  await act(async () => { q("[data-browser-backdrop]")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
  expect(q('[role="menu"]')).toBeNull(); expect(q(".ff-browser-workspace__snapshot")).toBeNull();
  expect(lastLayout()).toMatchObject({ width: 400, height: 300 }); // back in place
});

it("offers no tools for a host-limited grant, without the bridge, or while the tab is hidden", async () => {
  install(LIMITED); await render(); expect(q("[data-browser-more-button]")).toBeNull();
  install(WEB, false); await render(); expect(q("[data-browser-more-button]")).toBeNull();
  install(WEB); await render(false); expect(q("[data-browser-more-button]")).toBeNull();
});

it("a surface closes and the page comes back when the tab is hidden", async () => {
  install(WEB); await render();
  await click(q("[data-browser-more-button]")); await act(async () => { await Promise.resolve(); });
  expect(lastLayout()).toBeNull();
  await render(false);
  expect(q('[role="menu"]')).toBeNull();
});
