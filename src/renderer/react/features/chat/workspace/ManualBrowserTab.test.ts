// @vitest-environment jsdom
import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserPageDto, BrowserPermissionDto, BrowserPermissionScope, ManualBrowserCommand } from "../../../../../shared/manual-browser";
vi.mock("../../../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import { ManualBrowserTab } from "./ManualBrowserTab";
import en from "../../../i18n/en.json";
import zhCN from "../../../i18n/zh-CN.json";
const page = (id = "b", requestId = 1): BrowserPageDto => ({ browserId: id, conversationId: "s", requestId, closed: false, loading: false, url: "https://example.com/", pendingUrl: null, canGoBack: true, canGoForward: false, error: null });
const permission = (status: "required" | "pending" | "granted" | "denied") => ({ conversationId: "s", status, scope: { hosts: ["example.com", "github.com", "github.githubassets.com", "avatars.githubusercontent.com"], actions: ["navigate", "observe", "click", "type"] as const }, requestId: null });
let changed: (p: BrowserPageDto) => void, host: HTMLDivElement, root: ReturnType<typeof createRoot>;
let requestPermission: ReturnType<typeof vi.fn>, revokePermission: ReturnType<typeof vi.fn>, onClose: ReturnType<typeof vi.fn>;
let execute: ReturnType<typeof vi.fn>, off: ReturnType<typeof vi.fn>, resize: (() => void) | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { constructor(fn: () => void) { resize = fn; } observe() {} disconnect() {} });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ x: 300, y: 80, left: 300, top: 80, width: 400, height: 300, right: 700, bottom: 380, toJSON() {} });
  onClose = vi.fn(); off = vi.fn(); execute = vi.fn(async (command: ManualBrowserCommand) => ({ ok: true, value: command.kind === "open" ? page() : null }));
  requestPermission = vi.fn(async () => ({ ok: true, value: permission("granted") }));
  revokePermission = vi.fn(async () => ({ ok: true, value: permission("required") }));
  window.manualBrowser = { getAvailability: async () => ({ available: true }), getPermission: async () => ({ ok: true, value: permission("granted") }), requestPermission, revokePermission, execute, onChanged: fn => { changed = fn; return off; } };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); delete window.manualBrowser; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function render(sessionId: string | undefined = "s", active = true) { await act(async () => root.render(createElement(ManualBrowserTab, { sessionId, active, onClose }))); }
async function navigate(url = "https://example.com/") {
  const input = host.querySelector("input")!;
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, url); input.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
}
describe("manual browser Main bridge and viewport lifecycle", () => {
  it.each([["restricted_address", "restrictedAddress"], ["dns_failed", "dnsFailed"], ["dns_timeout", "dnsTimeout"], ["connection_failed", "connectionFailed"]] as const)("renders a safe message for %s and clears it on recovery", async (code, label) => {
    await render(); await navigate();
    await act(async () => changed({ ...page("b", 2), error: code }));
    expect(host.textContent).toContain(`browserWorkspace.${label}`); expect(host.textContent).not.toContain(code);
    await act(async () => changed(page("b", 3))); expect(host.textContent).not.toContain(`browserWorkspace.${label}`);
    expect(en.browserWorkspace[label]).toBeTruthy(); expect(zhCN.browserWorkspace[label]).toBeTruthy();
  });
  it.each(["cancelled reply", "rejected promise"])("does not mark the newest page failed when an older navigation ends with %s", async outcome => {
    await render(); await navigate();
    let finish!: (reply: unknown) => void, fail!: (reason: Error) => void;
    execute.mockImplementation((command: ManualBrowserCommand) => {
      if (command.kind !== "navigate") return Promise.resolve({ ok: true, value: null });
      if (command.url.endsWith("/old")) return new Promise((resolve, reject) => { finish = resolve; fail = reject; });
      return Promise.resolve({ ok: true, value: { ...page("b", 3), url: "https://example.com/new" } });
    });
    await navigate("https://example.com/old");
    await navigate("https://example.com/new");
    expect(host.querySelector<HTMLInputElement>("input")!.value).toBe("https://example.com/new");
    await act(async () => outcome === "cancelled reply" ? finish({ ok: false, code: "cancelled" }) : fail(new Error("old navigation aborted")));
    expect(host.querySelector<HTMLInputElement>("input")!.value).toBe("https://example.com/new");
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it("preserves the current navigation error when an older successful response arrives", async () => {
    await render(); await navigate();
    let finish!: (reply: unknown) => void;
    execute.mockImplementation((command: ManualBrowserCommand) => {
      if (command.kind !== "navigate") return Promise.resolve({ ok: true, value: null });
      if (command.url.endsWith("/old")) return new Promise(resolve => { finish = resolve; });
      return Promise.resolve({ ok: false, code: "blocked_url" });
    });
    await navigate("https://example.com/old"); await navigate("https://outside.invalid/");
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("browserWorkspace.blocked");
    await act(async () => finish({ ok: true, value: { ...page("b", 2), url: "https://example.com/old" } }));
    expect(host.querySelector<HTMLInputElement>("input")!.value).toBe("https://outside.invalid/");
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("browserWorkspace.blocked");
  });
  it.each(["close", "session change", "unmount", "revoke"])("invalidates an in-flight navigation on %s", async action => {
    await render(); await navigate();
    let finish!: (reply: unknown) => void;
    execute.mockImplementation((command: ManualBrowserCommand) => command.kind === "navigate"
      ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ ok: true, value: null }));
    await navigate("https://example.com/old");
    if (action === "close") await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="browserWorkspace.close"]')!.click());
    else if (action === "session change") await render("other");
    else if (action === "unmount") await act(async () => root.unmount());
    else await act(async () => host.querySelector<HTMLButtonElement>('[data-browser-revoke]')!.click());
    await act(async () => finish({ ok: true, value: { ...page("b", 2), url: "https://example.com/stale" } }));
    expect(host.querySelector<HTMLInputElement>("input")?.value).not.toBe("https://example.com/stale");
    expect(host.textContent).not.toContain("browserWorkspace.loadFailed");
  });
  it("stops an active navigation without closing the page or revoking its permission", async () => {
    await render(); await navigate();
    let finish!: (reply: unknown) => void;
    execute.mockImplementation((command: ManualBrowserCommand) => {
      if (command.kind === "navigate") return new Promise(resolve => { finish = resolve; });
      if (command.kind === "stop") return Promise.resolve({ ok: true, value: page("b", 4) });
      return Promise.resolve({ ok: true, value: null });
    });
    await navigate("https://example.com/pending");
    await act(async () => changed({ ...page("b", 3), loading: true, pendingUrl: "https://example.com/pending" }));
    const stop = host.querySelector<HTMLButtonElement>('[aria-label="browserWorkspace.stop"]');
    expect(stop).not.toBeNull();
    await act(async () => stop!.click());
    expect(execute).toHaveBeenCalledWith({ kind: "stop", browserId: "b" });
    await act(async () => finish({ ok: false, code: "cancelled" }));
    expect(host.querySelector('[role="alert"]')).toBeNull(); expect(host.querySelector('[aria-busy="true"]')).toBeNull();
    expect(host.querySelector('[data-browser-revoke]')).not.toBeNull(); expect(revokePermission).not.toHaveBeenCalled();
    expect(execute.mock.calls.some(([command]) => command.kind === "close")).toBe(false);
  });
  it("does not mint a fake conversation on welcome; closed production availability cannot navigate", async () => {
    await act(async () => root.render(createElement(ManualBrowserTab, { onClose: vi.fn() }))); await navigate(); expect(execute).not.toHaveBeenCalled();
    window.manualBrowser!.getAvailability = async () => ({ available: false, reason: "network_unavailable" });
    await render("closed-gate"); await navigate(); expect(execute).not.toHaveBeenCalled();
    expect(host.querySelector("iframe, webview, a[href]")).toBeNull();
  });
  it("adopts Main IDs, ignores foreign/older updates, detaches inactive viewport, and resends on focus/resize", async () => {
    await render(); await navigate();
    expect(execute).toHaveBeenCalledWith({ kind: "open", url: "https://example.com/" });
    expect(execute).toHaveBeenCalledWith({ kind: "layout", browserId: "b", bounds: { x: 300, y: 80, width: 400, height: 300 } });
    await act(async () => changed({ ...page("foreign", 99), conversationId: "other" }));
    await act(async () => changed({ ...page("b", 0), url: "https://stale.example/" }));
    expect(host.querySelector<HTMLInputElement>("input")!.value).toBe("https://example.com/");
    await render("s", false); expect(execute).toHaveBeenLastCalledWith({ kind: "layout", browserId: "b", bounds: null });
    await render("s", true); execute.mockClear();
    await act(async () => { window.dispatchEvent(new Event("focus")); resize?.(); });
    expect(execute.mock.calls.filter(([c]) => c.kind === "layout").length).toBeGreaterThanOrEqual(2);
    await render("next"); expect(revokePermission).toHaveBeenCalledExactlyOnceWith("s"); expect(execute.mock.calls.some(([c]) => c.kind === "close")).toBe(false); expect(off).toHaveBeenCalled();
  });
  it("close cancels pending open as soon as Main publishes its ID and never adopts a late reply", async () => {
    let finish!: (value: unknown) => void;
    execute.mockImplementation((c: ManualBrowserCommand) => c.kind === "open" ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ ok: true, value: null }));
    await render(); await navigate();
    await act(async () => changed({ ...page(), loading: true, url: "", pendingUrl: "https://example.com/" }));
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="browserWorkspace.close"]')!.click());
    // Main revoke also cancels navigation and waits for every owned page to close.
    expect(revokePermission).toHaveBeenCalledExactlyOnceWith("s");
    await act(async () => finish({ ok: true, value: page() }));
    expect(host.textContent).toContain("browserWorkspace.closed");
  });
  it("closed DTO remains terminal and cleanup_failed stays visible", async () => {
    await render(); await navigate();
    await act(async () => changed({ ...page("b", 3), closed: true, error: "cleanup_failed" }));
    await act(async () => changed(page("b", 4)));
    expect(host.textContent).toContain("browserWorkspace.cleanupFailed");
    expect(host.querySelector<HTMLButtonElement>('[aria-label="browserWorkspace.go"]')!.disabled).toBe(true);
  });
});


describe("manual browser permission and current page", () => {
  it("shows exact scope, requests Main approval once and never navigates before Main grants", async () => {
    window.manualBrowser!.getPermission = async () => ({ ok: true, value: permission("required") });
    let approve!: (value: unknown) => void;
    requestPermission.mockImplementation(() => new Promise(resolve => { approve = resolve; }));
    await render(); await navigate();
    expect(execute.mock.calls.some(([c]) => c.kind === "open")).toBe(false);
    const enable = host.querySelector<HTMLButtonElement>('[data-browser-enable]')!;
    expect(enable).not.toBeNull();
    expect(host.textContent).toContain("github.githubassets.com");
    expect(host.textContent).toContain("observe");
    await act(async () => { enable.click(); enable.click(); });
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(requestPermission).toHaveBeenCalledWith(permission("required").scope);
    await navigate(); expect(execute.mock.calls.some(([c]) => c.kind === "open")).toBe(false);
    await act(async () => approve({ ok: true, value: permission("granted") }));
    await navigate(); expect(execute).toHaveBeenCalledWith({ kind: "open", url: "https://example.com/" });
  });
  it("keeps Main denial closed and exposes a retry", async () => {
    window.manualBrowser!.getPermission = async () => ({ ok: true, value: permission("required") });
    requestPermission.mockResolvedValue({ ok: true, value: permission("denied") });
    await render();
    await act(async () => host.querySelector<HTMLButtonElement>('[data-browser-enable]')!.click());
    await navigate();
    expect(host.textContent).toContain("browserWorkspace.permissionDenied");
    expect(host.querySelector<HTMLButtonElement>('[data-browser-enable]')!.disabled).toBe(false);
    expect(execute.mock.calls.some(([c]) => c.kind === "open")).toBe(false);
  });
  it("adopts the first agent event without a manual open and rejects stale recovery", async () => {
    let recover!: (value: unknown) => void;
    execute.mockImplementation((c: ManualBrowserCommand) => c.kind === "get" ? new Promise(resolve => { recover = resolve; }) : Promise.resolve({ ok: true, value: null }));
    await render();
    await act(async () => changed({ ...page("agent", 2), url: "https://github.com/" }));
    expect(host.querySelector<HTMLInputElement>("input")!.value).toBe("https://github.com/");
    await act(async () => recover({ ok: true, value: page("old", 1) }));
    expect(host.querySelector<HTMLInputElement>("input")!.value).toBe("https://github.com/");
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ kind: "layout", browserId: "agent" }));
  });
  it("recovers a current Main page and remains alive while hidden", async () => {
    execute.mockImplementation(async (c: ManualBrowserCommand) => ({ ok: true, value: c.kind === "get" ? page("restored", 7) : null }));
    await render();
    expect(host.querySelector<HTMLInputElement>("input")!.value).toBe("https://example.com/");
    await render("s", false);
    expect(execute).toHaveBeenCalledWith({ kind: "layout", browserId: "restored", bounds: null });
    expect(execute.mock.calls.some(([c]) => c.kind === "close")).toBe(false);
    await render("s", true);
    expect(execute).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "layout", browserId: "restored", bounds: expect.any(Object) }));
  });
  it("ignores a permission reply from a previous session", async () => {
    window.manualBrowser!.getPermission = async () => ({ ok: true, value: permission("required") });
    let approve!: (value: unknown) => void;
    requestPermission.mockImplementation(() => new Promise(resolve => { approve = resolve; }));
    await render(); await act(async () => host.querySelector<HTMLButtonElement>('[data-browser-enable]')!.click());
    await render("other");
    await act(async () => approve({ ok: true, value: permission("granted") }));
    await navigate();
    expect(execute.mock.calls.some(([c]) => c.kind === "open")).toBe(false);
  });
});

const manualPermission = (status: BrowserPermissionDto["status"] = "required", hosts: readonly string[] = [], resourceHosts: readonly string[] = []): BrowserPermissionDto => ({
  conversationId: "s", status, scope: { mode: "manual", hosts, resourceHosts, actions: ["navigate"] }, requestId: null,
});

describe("separate Agent browser approval controls", () => {
  const agentScope = { ...permission("required").scope, mode: "agent" as const };
  it.each(["close", "unmount"])("revokes approved Agent permission on %s even before a page exists", async action => {
    window.manualBrowser!.getPermission = async () => ({ ok: true, value: { ...permission("granted"), scope: agentScope, agentScope } });
    execute.mockResolvedValue({ ok: true, value: null });
    await render();
    expect(revokePermission).not.toHaveBeenCalled();
    if (action === "close") await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="browserWorkspace.close"]')!.click());
    else await act(async () => root.unmount());
    expect(revokePermission).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls.some(([command]) => command.kind === "open")).toBe(false);
  });
  it("manual navigation never requests the separately offered Agent scope", async () => {
    window.manualBrowser!.getPermission = async () => ({ ok: true, value: { ...manualPermission(), agentScope } });
    requestPermission.mockResolvedValue({ ok: true, value: { ...manualPermission("granted", ["example.com"]), agentScope } });
    await render(); await navigate();
    expect(requestPermission).toHaveBeenCalledExactlyOnceWith({ mode: "manual", hosts: ["example.com"], resourceHosts: [], actions: ["navigate"] });
  });
  it.each(["failed reply", "rejected promise"])("recovers Main permission after an Agent request %s so the same manual host can be approved again", async outcome => {
    window.manualBrowser!.getPermission = async () => ({ ok: true, value: { ...manualPermission("granted", ["example.com"]), agentScope } });
    await render(); await navigate();
    window.manualBrowser!.getPermission = async () => ({ ok: true, value: { ...manualPermission(), agentScope } });
    if (outcome === "failed reply") requestPermission.mockResolvedValueOnce({ ok: false, code: "permission_denied" });
    else requestPermission.mockRejectedValueOnce(new Error("native dialog unavailable"));
    await act(async () => host.querySelector<HTMLButtonElement>("[data-browser-authorize-agent]")!.click());
    requestPermission.mockResolvedValueOnce({ ok: true, value: { ...manualPermission("granted", ["example.com"]), agentScope } });
    await navigate();
    expect(requestPermission).toHaveBeenCalledTimes(2);
    expect(requestPermission).toHaveBeenLastCalledWith({ mode: "manual", hosts: ["example.com"], resourceHosts: [], actions: ["navigate"] });
    expect(execute.mock.calls.filter(([command]) => command.kind === "open")).toHaveLength(2);
  });
  it("fails closed if a failed Agent request cannot recover or revoke Main permission", async () => {
    window.manualBrowser!.getPermission = async () => ({ ok: true, value: { ...manualPermission("granted", ["example.com"]), agentScope } });
    await render(); await navigate();
    window.manualBrowser!.getPermission = vi.fn().mockRejectedValue(new Error("unavailable"));
    requestPermission.mockResolvedValueOnce({ ok: false, code: "permission_denied" });
    revokePermission.mockResolvedValueOnce({ ok: false, code: "cleanup_failed" });
    await act(async () => host.querySelector<HTMLButtonElement>("[data-browser-authorize-agent]")!.click());
    expect(revokePermission).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("browserWorkspace.cleanupFailed");
    expect(host.querySelector("[data-browser-authorize-agent]")).toBeNull();
    expect(host.querySelector<HTMLButtonElement>('[aria-label="browserWorkspace.go"]')!.disabled).toBe(true);
  });
  it("offers the Main Agent scope separately without navigating on approval", async () => {
    window.manualBrowser!.getPermission = async () => ({ ok: true, value: { ...manualPermission(), agentScope } as BrowserPermissionDto });
    requestPermission.mockImplementation(async (scope: BrowserPermissionScope) => ({ ok: true, value: { ...manualPermission("granted"), scope, agentScope } }));
    await render();
    const agent = host.querySelector<HTMLButtonElement>("[data-browser-authorize-agent]");
    expect(agent).not.toBeNull();
    expect(requestPermission).not.toHaveBeenCalled();
    await act(async () => agent!.click());
    expect(requestPermission).toHaveBeenCalledExactlyOnceWith(agentScope);
    expect(execute.mock.calls.some(([command]) => command.kind === "open")).toBe(false);
    expect(host.textContent).toContain("browserWorkspace.agentScope");
    const manual = host.querySelector<HTMLButtonElement>("[data-browser-manual]");
    expect(manual).not.toBeNull();
    await act(async () => manual!.click());
    expect(revokePermission).toHaveBeenCalledTimes(1);
  });
  it("waits for explicit Agent approval, ignores a late reply after close, and allows retry after denial", async () => {
    window.manualBrowser!.getPermission = async () => ({ ok: true, value: { ...manualPermission(), agentScope } as BrowserPermissionDto });
    requestPermission.mockResolvedValueOnce({ ok: true, value: { ...manualPermission("denied"), agentScope } });
    await render();
    expect(host.querySelector("[data-browser-authorize-agent]")).not.toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>("[data-browser-authorize-agent]")!.click());
    expect(host.querySelector<HTMLButtonElement>("[data-browser-authorize-agent]")!.disabled).toBe(false);
    let finish!: (value: unknown) => void;
    requestPermission.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await act(async () => host.querySelector<HTMLButtonElement>("[data-browser-authorize-agent]")!.click());
    expect(host.querySelector<HTMLButtonElement>("[data-browser-authorize-agent]")!.disabled).toBe(true);
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="browserWorkspace.close"]')!.click());
    await act(async () => finish({ ok: true, value: { ...permission("granted"), scope: agentScope, agentScope } }));
    expect(execute.mock.calls.some(([command]) => command.kind === "open")).toBe(false);
    expect(revokePermission).toHaveBeenCalled();
  });
});
function useManualPermission(status: BrowserPermissionDto["status"] = "required", hosts: readonly string[] = [], resourceHosts: readonly string[] = []) {
  window.manualBrowser!.getPermission = async () => ({ ok: true, value: manualPermission(status, hosts, resourceHosts) });
  requestPermission.mockImplementation(async (scope: BrowserPermissionScope) => ({ ok: true, value: { ...manualPermission("granted"), scope } }));
  revokePermission.mockResolvedValue({ ok: true, value: manualPermission() });
}
const navCalls = () => execute.mock.calls.map(([c]) => c as ManualBrowserCommand).filter(c => c.kind === "open" || c.kind === "navigate");

describe("manual public HTTPS site consent", () => {
  it("uses Go before a grant to propose exactly one site and opens the entered address only after approval", async () => {
    useManualPermission();
    let approve!: (reply: unknown) => void;
    requestPermission.mockImplementation(() => new Promise(resolve => { approve = resolve; }));
    await render(); await navigate("https://docs.example/path?q=hello#section");
    expect(requestPermission).toHaveBeenCalledExactlyOnceWith({ mode: "manual", hosts: ["docs.example"], resourceHosts: [], actions: ["navigate"] });
    expect(navCalls()).toEqual([]);
    expect(host.textContent).not.toContain("github.githubassets.com");
    expect(host.textContent).toContain("browserWorkspace.manualLimits");
    await act(async () => approve({ ok: true, value: manualPermission("granted", ["docs.example"]) }));
    expect(navCalls()).toEqual([{ kind: "open", url: "https://docs.example/path?q=hello#section" }]);
  });
  it.each(["http://example.com/", "file:///tmp/a", "javascript:alert(1)", "https://user:password@example.com/", "https://example.com:8443/path"])("rejects non-public-HTTPS proposal syntax %s without permission or execution", async url => {
    useManualPermission(); await render(); await navigate(url);
    expect(requestPermission).not.toHaveBeenCalled(); expect(navCalls()).toEqual([]);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("browserWorkspace.blocked");
  });
  it("navigates an exact approved host directly and explicitly proposes a different host", async () => {
    useManualPermission("granted", ["example.com"]); await render(); await navigate();
    await navigate("https://example.com/next");
    expect(requestPermission).not.toHaveBeenCalled();
    expect(navCalls().at(-1)).toEqual({ kind: "navigate", browserId: "b", url: "https://example.com/next" });
    await navigate("https://other.example/new");
    expect(requestPermission).toHaveBeenCalledWith({ mode: "manual", hosts: ["other.example"], resourceHosts: [], actions: ["navigate"] });
    expect(navCalls().at(-1)).toEqual({ kind: "open", url: "https://other.example/new" });
  });
  it.each([
    ["http://localhost:5173/app", "localhost:5173"],
    ["localhost:5173", "localhost:5173"],
    ["192.168.1.5:3000/dash", "192.168.1.5:3000"],
    ["http://127.0.0.1:8080", "127.0.0.1:8080"],
  ])("proposes exactly one private-network authority for %s and opens it only after approval", async (typed, key) => {
    useManualPermission();
    let approve!: (reply: unknown) => void;
    requestPermission.mockImplementation(() => new Promise(resolve => { approve = resolve; }));
    await render(); await navigate(typed);
    expect(requestPermission).toHaveBeenCalledExactlyOnceWith({ mode: "manual", hosts: [key], resourceHosts: [], actions: ["navigate"] });
    expect(navCalls()).toEqual([]);
    await act(async () => approve({ ok: true, value: manualPermission("granted", [key]) }));
    expect(navCalls()).toHaveLength(1);
    expect(navCalls()[0]).toMatchObject({ kind: "open" });
  });
  it.each(["http://169.254.169.254/", "http://nas.local/", "http://localhost.evil.com/", "ws://localhost:5173/","http://[::ffff:127.0.0.1]/", "http://user@localhost:3000/"])("rejects private-network look-alike %s without permission or execution", async url => {
    useManualPermission(); await render(); await navigate(url);
    expect(requestPermission).not.toHaveBeenCalled(); expect(navCalls()).toEqual([]);
  });
  it("treats a different port on the same private host as a new proposal", async () => {
    useManualPermission("granted", ["localhost:5173"]); await render(); await navigate("http://localhost:5173/");
    expect(requestPermission).not.toHaveBeenCalled();
    await navigate("http://localhost:5173/next");
    expect(requestPermission).not.toHaveBeenCalled();
    expect(navCalls().at(-1)).toMatchObject({ kind: "navigate", url: "http://localhost:5173/next" });
    await navigate("http://localhost:3000/");
    expect(requestPermission).toHaveBeenCalledWith({ mode: "manual", hosts: ["localhost:3000"], resourceHosts: [], actions: ["navigate"] });
  });
  it("leaves no usable old history on denial and can retry the same address", async () => {
    useManualPermission("granted", ["example.com"]); await render(); await navigate();
    requestPermission.mockResolvedValueOnce({ ok: true, value: manualPermission("denied", ["other.example"]) });
    await navigate("https://other.example/next");
    expect(host.textContent).toContain("browserWorkspace.permissionDenied");
    expect(host.querySelector<HTMLInputElement>('input[type="text"]')!.disabled).toBe(false);
    expect(host.querySelector<HTMLInputElement>('input[type="text"]')!.value).toBe("https://other.example/next");
    for (const label of ["back", "forward", "reload"]) expect(host.querySelector<HTMLButtonElement>(`[aria-label="browserWorkspace.${label}"]`)!.disabled).toBe(true);
    await navigate("https://other.example/next"); expect(requestPermission).toHaveBeenCalledTimes(2);
    expect(navCalls().at(-1)).toEqual({ kind: "open", url: "https://other.example/next" });
  });
  it("keeps the manual address usable after Main closes a page while clearing a scope", async () => {
    useManualPermission("granted", ["example.com"]); await render(); await navigate();
    await act(async () => changed({ ...page("b", 2), closed: true }));
    expect(host.querySelector<HTMLInputElement>('input[type="text"]')!.disabled).toBe(false);
    await navigate("https://example.com/new");
    expect(navCalls().at(-1)).toEqual({ kind: "open", url: "https://example.com/new" });
  });
  it("does not request consent when page events report blocked resources or navigation", async () => {
    useManualPermission("granted", ["example.com"]); await render();
    await act(async () => changed({ ...page(), blockedResourceHosts: ["cdn.example", "api.example"], blockedNavigationUrl: "https://other.example/", blockedRequest: true }));
    expect(requestPermission).not.toHaveBeenCalled();
    expect(host.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
    expect(Array.from(host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).every(input => !input.checked)).toBe(true);
    expect(host.textContent).toContain("browserWorkspace.blockedRequest");
    expect(host.textContent).toContain("browserWorkspace.resourceScope");
    expect(host.querySelector<HTMLButtonElement>('[data-browser-authorize-resources]')!.disabled).toBe(true);
  });
  it("sends only explicitly selected resources plus prior grants and the exact source page, then reloads with history reset", async () => {
    useManualPermission("granted", ["example.com"], ["existing.example"]); await render();
    await act(async () => changed({ ...page("source-page", 4), blockedResourceHosts: ["cdn.example", "api.example"] }));
    const choices = host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    await act(async () => choices[1]!.click());
    await act(async () => host.querySelector<HTMLButtonElement>('[data-browser-authorize-resources]')!.click());
    expect(requestPermission).toHaveBeenCalledExactlyOnceWith({ mode: "manual", hosts: ["example.com"], resourceHosts: ["existing.example", "api.example"], actions: ["navigate"], sourceBrowserId: "source-page", sourceRequestId: 4 });
    expect(navCalls()).toEqual([{ kind: "open", url: "https://example.com/" }]);
    expect(host.querySelector<HTMLInputElement>('input[type="text"]')!.value).toBe("https://example.com/");
    expect(host.textContent).toContain("browserWorkspace.scopeReloaded");
  });
  it("drops selected resource choices when their source page changes", async () => {
    useManualPermission("granted", ["example.com"]); await render();
    await act(async () => changed({ ...page(), blockedResourceHosts: ["cdn.example"] }));
    await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await act(async () => changed({ ...page("b", 2), closed: true }));
    await act(async () => changed({ ...page("new", 1), blockedResourceHosts: ["cdn.example"] }));
    expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false);
    expect(host.querySelector<HTMLButtonElement>('[data-browser-authorize-resources]')!.disabled).toBe(true);
  });
  it("clears selected resources when navigation changes the same page request ID", async () => {
    useManualPermission("granted", ["example.com"]); await render();
    await act(async () => changed({ ...page("b", 1), blockedResourceHosts: ["cdn.example"] }));
    await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await act(async () => changed({ ...page("b", 2), blockedResourceHosts: ["cdn.example"] }));
    expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false);
    expect(host.querySelector<HTMLButtonElement>('[data-browser-authorize-resources]')!.disabled).toBe(true);
  });
  it("blocks resource reauthorization while the current request is still loading", async () => {
    useManualPermission("granted", ["example.com"]); await render();
    const current = { ...page("b", 2), blockedResourceHosts: ["cdn.example"] };
    await act(async () => changed(current));
    await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await act(async () => changed({ ...current, loading: true, pendingUrl: "https://example.com/new" }));
    const authorize = host.querySelector<HTMLButtonElement>('[data-browser-authorize-resources]')!;
    expect(authorize.disabled).toBe(true);
    await act(async () => authorize.click()); expect(requestPermission).not.toHaveBeenCalled();
    await act(async () => changed({ ...current, url: "https://example.com/new" }));
    expect(host.querySelector<HTMLButtonElement>('[data-browser-authorize-resources]')!.disabled).toBe(false);
    await act(async () => host.querySelector<HTMLButtonElement>('[data-browser-authorize-resources]')!.click());
    expect(navCalls()).toEqual([{ kind: "open", url: "https://example.com/new" }]);
  });
  it("authorizes only the blocked navigation origin on an explicit button click", async () => {
    useManualPermission("granted", ["example.com"]); await render();
    await act(async () => changed({ ...page(), blockedNavigationUrl: "https://other.example/" }));
    await act(async () => host.querySelector<HTMLButtonElement>('[data-browser-authorize-site]')!.click());
    expect(requestPermission).toHaveBeenCalledExactlyOnceWith({ mode: "manual", hosts: ["other.example"], resourceHosts: [], actions: ["navigate"] });
    expect(navCalls()).toEqual([{ kind: "open", url: "https://other.example/" }]);
  });
  it.each(["close", "unmount", "revoke", "session change"])("revokes a pending native request on %s and ignores its late grant", async action => {
    useManualPermission(); let approve!: (reply: unknown) => void;
    requestPermission.mockImplementation(() => new Promise(resolve => { approve = resolve; }));
    await render(); await navigate("https://docs.example/late");
    if (action === "close") await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="browserWorkspace.close"]')!.click());
    else if (action === "unmount") await act(async () => root.unmount());
    else if (action === "session change") await render("other");
    else await act(async () => host.querySelector<HTMLButtonElement>('[data-browser-revoke]')!.click());
    expect(revokePermission).toHaveBeenCalledTimes(1);
    await act(async () => approve({ ok: true, value: manualPermission("granted", ["docs.example"]) }));
    expect(navCalls()).toEqual([]);
  });
  it.each(["grant", "denial", "cancelled", "rejected"])("supersedes an older pending request and ignores its stale %s", async outcome => {
    useManualPermission(); const finishes: ((reply: unknown) => void)[] = [], failures: ((error: Error) => void)[] = [];
    requestPermission.mockImplementation(() => new Promise((resolve, reject) => { finishes.push(resolve); failures.push(reject); }));
    await render(); await navigate("https://old.example/path"); await navigate("https://new.example/path");
    expect(requestPermission).toHaveBeenCalledTimes(2);
    await act(async () => finishes[1]!({ ok: true, value: manualPermission("granted", ["new.example"]) }));
    await act(async () => outcome === "rejected" ? failures[0]!(new Error("cancelled"))
      : outcome === "cancelled" ? finishes[0]!({ ok: false, code: "cancelled" })
      : finishes[0]!({ ok: true, value: manualPermission(outcome === "grant" ? "granted" : "denied", ["old.example"]) }));
    expect(navCalls()).toEqual([{ kind: "open", url: "https://new.example/path" }]);
    expect(host.textContent).toContain("new.example"); expect(host.textContent).not.toContain("old.example");
  });
  it.each(["close", "unmount"])("cancels a pending native request recovered from Main on %s", async action => {
    useManualPermission("pending", ["docs.example"]); await render();
    if (action === "close") await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="browserWorkspace.close"]')!.click());
    else await act(async () => root.unmount());
    expect(revokePermission).toHaveBeenCalledExactlyOnceWith("s");
  });
  it.each(["cancelled", "rejected"])("clears a failed native request's pending status for a retry after %s", async outcome => {
    useManualPermission();
    if (outcome === "cancelled") requestPermission.mockResolvedValueOnce({ ok: false, code: "cancelled" });
    else requestPermission.mockRejectedValueOnce(new Error("native request rejected"));
    await render(); await navigate("https://docs.example/path");
    expect(host.textContent).not.toContain("browserWorkspace.permissionPending");
    expect(host.textContent).toContain("browserWorkspace.permissionRequestFailed");
    expect(host.querySelector<HTMLButtonElement>('[aria-label="browserWorkspace.go"]')!.disabled).toBe(false);
    await navigate("https://docs.example/path"); expect(requestPermission).toHaveBeenCalledTimes(2);
    expect(navCalls()).toEqual([{ kind: "open", url: "https://docs.example/path" }]);
  });
  it("keeps a draft address intact during resource reauthorization and exposes the granted resources", async () => {
    useManualPermission("granted", ["example.com"]); await render();
    await act(async () => changed({ ...page("source-page", 4), blockedResourceHosts: ["api.example"] }));
    const input = host.querySelector<HTMLInputElement>('input[type="text"]')!;
    act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "https://example.com/draft"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await act(async () => host.querySelector<HTMLButtonElement>('[data-browser-authorize-resources]')!.click());
    expect(navCalls()).toEqual([{ kind: "open", url: "https://example.com/" }]);
    expect(host.querySelector<HTMLInputElement>('input[type="text"]')!.value).toBe("https://example.com/draft");
    expect(host.textContent).toContain("browserWorkspace.approvedResources");
    expect(host.textContent).toContain("api.example");
  });
  it.each(["close", "unmount"])("revokes a granted opening immediately before Main publishes an ID on %s", async action => {
    useManualPermission(); let finish!: (reply: unknown) => void;
    execute.mockImplementation((c: ManualBrowserCommand) => c.kind === "open" ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ ok: true, value: null }));
    await render(); await navigate("https://docs.example/path");
    expect(navCalls()).toEqual([{ kind: "open", url: "https://docs.example/path" }]);
    if (action === "close") await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="browserWorkspace.close"]')!.click());
    else await act(async () => root.unmount());
    expect(revokePermission).toHaveBeenCalledExactlyOnceWith("s");
    await act(async () => finish({ ok: true, value: { ...page("late-id", 1), url: "https://docs.example/path" } }));
    expect(execute).toHaveBeenCalledWith({ kind: "close", browserId: "late-id" });
    expect(host.querySelector<HTMLInputElement>('input[type="text"]')?.value).not.toBe("https://example.com/");
  });
  it.each(["close", "unmount"])("revokes the previous live authority after Main rejects a new scope before cleanup on %s", async action => {
    useManualPermission("granted", ["example.com"]); await render(); await navigate();
    requestPermission.mockResolvedValueOnce({ ok: false, code: "permission_denied" });
    await navigate("https://private.example/path");
    if (action === "close") await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="browserWorkspace.close"]')!.click());
    else await act(async () => root.unmount());
    expect(revokePermission).toHaveBeenCalledExactlyOnceWith("s");
  });
  it("cancels an older native consent request when the latest Go address has invalid syntax", async () => {
    useManualPermission(); let approve!: (reply: unknown) => void;
    requestPermission.mockImplementation(() => new Promise(resolve => { approve = resolve; }));
    await render(); await navigate("https://docs.example/old"); await navigate("http://docs.example/new");
    expect(revokePermission).toHaveBeenCalledExactlyOnceWith("s");
    await act(async () => approve({ ok: true, value: manualPermission("granted", ["docs.example"]) }));
    expect(navCalls()).toEqual([]);
    expect(host.querySelector<HTMLInputElement>('input[type="text"]')!.value).toBe("http://docs.example/new");
  });
  it("keeps the newest invalid-address error when an older same-site navigation completes", async () => {
    useManualPermission("granted", ["example.com"]); await render(); await navigate();
    let finish!: (reply: unknown) => void;
    execute.mockImplementation((c: ManualBrowserCommand) => c.kind === "navigate" ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ ok: true, value: null }));
    await navigate("https://example.com/old"); await navigate("http://example.com/new");
    await act(async () => finish({ ok: true, value: { ...page("b", 2), url: "https://example.com/old" } }));
    expect(host.querySelector<HTMLInputElement>('input[type="text"]')!.value).toBe("http://example.com/new");
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("browserWorkspace.blocked");
  });
  it("recovers the real Main page and grant after a rejected resource scope without losing the address", async () => {
    useManualPermission("granted", ["example.com"]); await render();
    const current = { ...page("live", 2), blockedResourceHosts: ["api.example"] };
    await act(async () => changed(current));
    execute.mockImplementation(async (c: ManualBrowserCommand) => ({ ok: true, value: c.kind === "get" ? current : null }));
    requestPermission.mockResolvedValueOnce({ ok: false, code: "permission_denied" });
    const input = host.querySelector<HTMLInputElement>('input[type="text"]')!;
    act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "https://example.com/draft"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await act(async () => host.querySelector<HTMLButtonElement>('[data-browser-authorize-resources]')!.click());
    expect(host.querySelector('[data-browser-revoke]')).not.toBeNull();
    expect(host.querySelector<HTMLInputElement>('input[type="text"]')!.value).toBe("https://example.com/draft");
    expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false);
    expect(host.querySelector<HTMLButtonElement>('[aria-label="browserWorkspace.reload"]')!.disabled).toBe(false);
    expect(host.textContent).not.toContain("browserWorkspace.scopeReloaded");
    expect(host.textContent).toContain("browserWorkspace.permissionRequestFailed");
  });
  it("revokes an uncertain old scope if Main recovery cannot be read", async () => {
    useManualPermission("granted", ["example.com"]); await render(); await navigate();
    requestPermission.mockResolvedValueOnce({ ok: false, code: "permission_denied" });
    execute.mockImplementation(async (c: ManualBrowserCommand) => c.kind === "get" ? { ok: false, code: "network_unavailable" } : { ok: true, value: null });
    await navigate("https://rejected.example/");
    expect(revokePermission).toHaveBeenCalledExactlyOnceWith("s");
    expect(host.querySelector<HTMLButtonElement>('[aria-label="browserWorkspace.reload"]')!.disabled).toBe(true);
  });
  it("ignores an old failed-scope recovery read after a newer site was approved", async () => {
    useManualPermission("granted", ["example.com"]); await render(); await navigate();
    let oldRecovery!: (reply: unknown) => void;
    execute.mockImplementation((c: ManualBrowserCommand) => c.kind === "get" ? new Promise(resolve => { oldRecovery = resolve; })
      : Promise.resolve({ ok: true, value: c.kind === "open" ? { ...page("new-page", 1), url: "https://new.example/" } : null }));
    requestPermission.mockResolvedValueOnce({ ok: false, code: "permission_denied" });
    await navigate("https://rejected.example/"); await navigate("https://new.example/");
    await act(async () => oldRecovery({ ok: true, value: page("old-page", 9) }));
    expect(host.querySelector<HTMLInputElement>('input[type="text"]')!.value).toBe("https://new.example/");
    expect(host.textContent).not.toContain("browserWorkspace.permissionRequestFailed");
  });
  it("ignores a stale initial permission read after a newer explicit site grant", async () => {
    useManualPermission(); let oldRead!: (reply: unknown) => void;
    window.manualBrowser!.getPermission = vi.fn().mockResolvedValueOnce({ ok: true, value: manualPermission() })
      .mockImplementationOnce(() => new Promise(resolve => { oldRead = resolve; }));
    await render(); await act(async () => changed(page()));
    await navigate("https://new.example/path");
    await act(async () => oldRead({ ok: true, value: manualPermission("granted", ["old.example"]) }));
    expect(host.textContent).toContain("new.example"); expect(host.textContent).not.toContain("old.example");
  });
});

describe("manual browser consent copy", () => {
  it.each([en, zhCN])("provides every manual consent label in both locales", locale => {
    const copy = locale.browserWorkspace as Record<string, string>;
    for (const key of ["manualScope", "manualLimits", "cancelPermission", "blockedRequest", "scopeReloaded", "blockedResources", "resourceScope", "authorizeResources", "blockedNavigation", "authorizeSite", "approvedResources"]) {
      expect(copy[key], key).toBeTruthy();
    }
  });
  it("discloses script/XHR scope, GET side effects, unsupported login and credential precautions", () => {
    const copy = en.browserWorkspace as Record<string, string>;
    expect(copy.resourceScope).toMatch(/scripts/i); expect(copy.resourceScope).toMatch(/XHR/);
    expect(copy.resourceScope).toMatch(/tracking/i); expect(copy.resourceScope).toMatch(/GET/);
    expect(copy.manualLimits).toMatch(/login/i); expect(copy.manualLimits).toMatch(/POST/);
    expect(copy.manualLimits).toMatch(/credentials or sensitive information/i);
  });
});


describe("browser chrome state follows user intent and confirmed Main cleanup", () => {
  function typeAddress(value: string) {
    const input = host.querySelector<HTMLInputElement>('input[type="text"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  it("keeps an unsubmitted draft when native page events arrive or the browser is hidden and restored", async () => {
    await render(); await navigate(); typeAddress("https://example.com/my-draft");
    await act(async () => changed({ ...page("b", 2), url: "https://example.com/from-page", canGoForward: true }));
    await render("s", false); await render("s", true);
    expect(host.querySelector<HTMLInputElement>('input[type="text"]')!.value).toBe("https://example.com/my-draft");
    expect(host.querySelector("[data-browser-committed-url]")?.textContent).toBe("https://example.com/from-page");
    expect(host.querySelector<HTMLButtonElement>('[aria-label="browserWorkspace.forward"]')!.disabled).toBe(false);
  });
  it("does not overwrite a newer draft when the submitted navigation finishes", async () => {
    await render(); await navigate(); let finish!: (reply: unknown) => void;
    execute.mockImplementation((c: ManualBrowserCommand) => c.kind === "navigate" ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ ok: true, value: null }));
    await navigate("https://example.com/submitted"); typeAddress("https://example.com/next-draft");
    await act(async () => finish({ ok: true, value: { ...page("b", 2), url: "https://example.com/submitted" } }));
    expect(host.querySelector<HTMLInputElement>('input[type="text"]')!.value).toBe("https://example.com/next-draft");
    expect(host.querySelector("[data-browser-committed-url]")?.textContent).toBe("https://example.com/submitted");
  });
  it("shows an IPC command as busy before Main publishes a page and leaves newer addresses usable", async () => {
    await render(); let finish!: (reply: unknown) => void;
    execute.mockImplementation((c: ManualBrowserCommand) => c.kind === "open" ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ ok: true, value: null }));
    await navigate();
    expect(host.querySelector('[data-browser-command-pending="true"]')).not.toBeNull();
    expect(host.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(host.querySelector<HTMLButtonElement>('[aria-label="browserWorkspace.close"]')!.disabled).toBe(false);
    await act(async () => finish({ ok: false, code: "load_failed" }));
    expect(host.querySelector('[data-browser-command-pending="true"]')).toBeNull();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("browserWorkspace.loadFailed");
  });
  it("reports an unreadable permission state and retries without opening a native authorization dialog", async () => {
    window.manualBrowser!.getPermission = vi.fn().mockRejectedValueOnce(new Error("bridge unavailable")).mockResolvedValue({ ok: true, value: permission("required") });
    await render();
    expect(host.textContent).toContain("browserWorkspace.stateUnavailable");
    expect(host.querySelector('[data-browser-enable]')).toBeNull();
    const retry = host.querySelector<HTMLButtonElement>('[data-browser-retry-state]');
    expect(retry).not.toBeNull();
    await act(async () => retry!.click());
    expect(host.querySelector('[data-browser-enable]')).not.toBeNull();
    expect(host.textContent).not.toContain("browserWorkspace.stateUnavailable");
    expect(requestPermission).not.toHaveBeenCalled();
  });
  it("keeps native cleanup failure terminal and requires a manual restart", async () => {
    await render(); await navigate(); let finish!: (reply: unknown) => void;
    revokePermission.mockResolvedValue({ ok: false, code: "cleanup_failed" })
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="browserWorkspace.close"]')!.click());
    expect(onClose).not.toHaveBeenCalled();
    expect(host.textContent).toContain("browserWorkspace.closing");
    expect(execute).toHaveBeenCalledWith({ kind: "layout", browserId: "b", bounds: null });
    await act(async () => finish({ ok: false, code: "cleanup_failed" }));
    expect(onClose).not.toHaveBeenCalled();
    expect(host.textContent).toContain("browserWorkspace.cleanupFailed");
    expect(host.querySelector('[aria-label="browserWorkspace.retryClose"]')).toBeNull();
    const close = host.querySelector<HTMLButtonElement>('[aria-label="browserWorkspace.close"]')!;
    expect(close.disabled).toBe(true);
    expect(host.querySelector<HTMLInputElement>('input[type="text"]')!.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>('[aria-label="browserWorkspace.go"]')!.disabled).toBe(true);
    expect(host.querySelector('[data-browser-revoke]')).toBeNull();
    await act(async () => close.click());
    await act(async () => changed({ ...page("b", 99), url: "https://example.com/late" }));
    expect(revokePermission).toHaveBeenCalledExactlyOnceWith("s");
    expect(onClose).not.toHaveBeenCalled();
    expect(navCalls()).toHaveLength(1);
    expect(host.textContent).toContain("browserWorkspace.cleanupFailed");
  });
  it("restores the confirmed URL on Escape without navigating or discarding another pane", async () => {
    await render(); await navigate(); typeAddress("https://example.com/unsubmitted");
    await act(async () => host.querySelector("input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(host.querySelector<HTMLInputElement>("input")!.value).toBe("https://example.com/");
    expect(navCalls()).toHaveLength(1); expect(onClose).not.toHaveBeenCalled();
  });
});
it("closes Main's scope even when initial browser availability is still being checked", async () => {
  let ready!: (value: { available: boolean }) => void;
  window.manualBrowser!.getAvailability = () => new Promise(resolve => { ready = resolve; });
  await render();
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="browserWorkspace.close"]')!.click());
  expect(revokePermission).toHaveBeenCalledExactlyOnceWith("s");
  await act(async () => ready({ available: true }));
  expect(execute.mock.calls.some(([c]) => c.kind === "get")).toBe(false);
});
it.each([en, zhCN])("provides browser state, terminal cleanup, and address-control labels in both locales", locale => {
  for (const key of ["currentPage", "addressHint", "closing", "cleanupFailed", "stateUnavailable", "retryState", "manualMode", "agentMode", "separateAgent"] as const) {
    expect(locale.browserWorkspace[key]).toEqual(expect.any(String));
    expect(locale.browserWorkspace[key]?.trim().length).toBeGreaterThan(0);
  }
  expect(locale.browserWorkspace).not.toHaveProperty("retryClose");
  expect(en.browserWorkspace.cleanupFailed).toMatch(/restart.*manually|manually.*restart/i);
  expect(zhCN.browserWorkspace.cleanupFailed).toMatch(/手动重启/);
  expect(locale.rightInspector.closeTab).toContain("{{name}}");
});

it("revokes on real unmount before initial Main permission recovery resolves", async () => {
    let recover!: (value: unknown) => void;
    window.manualBrowser!.getPermission = () => new Promise(resolve => { recover = resolve; });
    await render();
    await act(async () => root.render(null));
    expect(revokePermission).toHaveBeenCalledWith("s");
    await act(async () => recover({ ok: true, value: permission("granted") }));
    expect(execute.mock.calls.some(([c]) => c.kind === "open")).toBe(false);
  });

it("recovers the existing Main grant and page through StrictMode effect replay", async () => {
    execute.mockImplementation(async (c: ManualBrowserCommand) => ({ ok: true, value: c.kind === "get" ? page("restored", 7) : null }));
    await act(async () => root.render(createElement(StrictMode, null, createElement(ManualBrowserTab, { sessionId: "s", onClose: vi.fn() }))));
    expect(revokePermission).not.toHaveBeenCalled();
    expect(execute.mock.calls.some(([c]) => c.kind === "close")).toBe(false);
    expect(host.querySelector<HTMLInputElement>("input")!.value).toBe("https://example.com/");
    expect(host.querySelector<HTMLButtonElement>('[aria-label="browserWorkspace.go"]')!.disabled).toBe(false);
  });

it("shows a cleanup failure from revoking a grant without a page", async () => {
    revokePermission.mockResolvedValue({ ok: false, code: "cleanup_failed" });
    await render();
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="browserWorkspace.close"]')!.click());
    expect(host.textContent).toContain("browserWorkspace.cleanupFailed");
  });

it("revokes the session grant when closing before any page exists", async () => {
    await render();
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="browserWorkspace.close"]')!.click());
    expect(revokePermission).toHaveBeenCalledWith("s");
    expect(execute.mock.calls.some(([c]) => c.kind === "open")).toBe(false);
  });

it("revokes the old session grant on unmount without touching the next session", async () => {
    await render();
    await render("other");
    expect(revokePermission).toHaveBeenCalledWith("s");
    expect(revokePermission).not.toHaveBeenCalledWith("other");
  });

it("cancels a pending native permission on close and ignores its late approval", async () => {
    window.manualBrowser!.getPermission = async () => ({ ok: true, value: permission("required") });
    let approve!: (value: unknown) => void;
    requestPermission.mockImplementation(() => new Promise(resolve => { approve = resolve; }));
    await render();
    await act(async () => host.querySelector<HTMLButtonElement>('[data-browser-enable]')!.click());
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="browserWorkspace.close"]')!.click());
    expect(revokePermission).toHaveBeenCalledWith("s");
    await act(async () => approve({ ok: true, value: permission("granted") }));
    await navigate();
    expect(execute.mock.calls.some(([c]) => c.kind === "open")).toBe(false);
  });

it("offers explicit exact Agent sites and resource-only hosts without granting them automatically", async () => {
  window.manualBrowser!.getPermission = async () => ({ ok:true, value:{...permission('required'), scope:{mode:'manual',hosts:[],actions:['navigate']}, agentScope:permission('required').scope, agentSiteSelection:true} });
  await render();
  const sites = host.querySelector<HTMLTextAreaElement>('[data-browser-agent-sites]');
  const resources = host.querySelector<HTMLTextAreaElement>('[data-browser-agent-resources]');
  expect(sites).not.toBeNull(); expect(resources).not.toBeNull(); expect(requestPermission).not.toHaveBeenCalled();
  act(() => { for (const [element, value] of [[sites!, 'developer.mozilla.org'],[resources!, 'static.example.org']] as const) {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(element,value);
    element.dispatchEvent(new Event('input',{bubbles:true}));
  } });
  await act(async () => (host.querySelector('[data-browser-authorize-agent-sites]') as HTMLButtonElement).click());
  expect(requestPermission).toHaveBeenCalledWith({mode:'agent',site:true,hosts:['developer.mozilla.org'],resourceHosts:['static.example.org'],actions:['navigate','observe','click','type']});
});
