import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ preferences: undefined as unknown, contents: undefined as any, bounds: [] as unknown[] }));
vi.mock("electron", () => ({ WebContentsView: class {
  webContents: any;
  constructor(options: unknown) { fixture.preferences = options; this.webContents = fixture.contents; }
  setBounds(bounds: unknown) { fixture.bounds.push(bounds); }
} }));
import { createElectronBrowserGuest } from "./electron-browser-guest";
import { routeBrowserGuestNavigation } from "./browser-guest-routing";
import type { BrowserHostPort } from "./browser-service";
import type { App } from "electron";
import { createBrowserService } from "./browser-service";
import { installBrowserServiceLifecycle } from "./browser-service-ipc";

function nativeFixture() {
  const events = new EventEmitter(), session = {}, trace: string[] = [];
  let dead = false, url = "", popup: (() => unknown) | undefined;
  const contents = Object.assign(events, { id: 22, session, isDestroyed: () => dead, isCrashed: () => false, getURL: () => url,
    loadURL: async (next: string) => { url = next; trace.push("load"); },
    setWindowOpenHandler: (handler: () => unknown) => { popup = handler; }, setWebRTCIPHandlingPolicy: (policy: string) => trace.push(policy),
    close: (options: unknown) => { trace.push("close:" + JSON.stringify(options)); dead = true; events.emit("destroyed"); }, stop: () => trace.push("stop"), reload: () => events.emit("did-finish-load"),
    navigationHistory: { canGoBack: () => true, canGoForward: () => false, goBack: (): void => { events.emit("did-finish-load"); }, goForward: (): void => { events.emit("did-finish-load"); } } });
  fixture.contents = contents; fixture.bounds = [];
  return { session, contents, trace, popup: () => popup?.() };
}
describe("real Electron WebContentsView adapter boundary", () => {
  it("retains only the numeric history failure and removes waiters", async () => {
    const f = nativeFixture(), guest = createElectronBrowserGuest(f.session as any);
    f.contents.reload = () => { f.contents.emit("did-fail-load", {}, -111, "private description", "https://example.com/?secret", true); };
    try {
      await expect(guest.history("reload")).rejects.toMatchObject({ errno: -111, message: "browser navigation failed" });
      expect(f.contents.listenerCount("did-fail-load")).toBe(1);
    } finally { guest.destroy(); }
  });
  it("forwards only main-frame redirect targets", () => {
    const f = nativeFixture(), guest = createElectronBrowserGuest(f.session as any), started = vi.fn();
    guest.installCallbacks({ allowsNavigation: () => true, started, changed() {}, failed() {}, destroyed() {} });
    f.contents.emit("did-redirect-navigation", {}, "https://github.com/", false, false);
    expect(started).not.toHaveBeenCalled();
    f.contents.emit("did-redirect-navigation", {}, "https://github.com/", false, true);
    expect(started).toHaveBeenCalledWith("https://github.com/", true); guest.destroy();
  });
  it("routes only exact managed guests and keeps destroyed guests denied instead of external fallback", () => {
    const f = nativeFixture(), guest = createElectronBrowserGuest(f.session as any), preventDefault = vi.fn();
    expect(routeBrowserGuestNavigation({}, { preventDefault }, "https://example.com/")).toBe(false); expect(preventDefault).not.toHaveBeenCalled();
    expect(routeBrowserGuestNavigation(f.contents, { preventDefault }, "https://example.com/")).toBe(true); expect(preventDefault).toHaveBeenCalledTimes(1);
    guest.installCallbacks({ allowsNavigation: url => url === "https://example.com/", started: () => {}, changed: () => {}, failed: () => {}, destroyed: () => {} });
    preventDefault.mockClear(); expect(routeBrowserGuestNavigation(f.contents, { preventDefault }, "https://example.com/")).toBe(true); expect(preventDefault).not.toHaveBeenCalled();
    guest.destroy(); expect(routeBrowserGuestNavigation(f.contents, { preventDefault }, "https://example.com/")).toBe(true); expect(preventDefault).toHaveBeenCalledTimes(1);
  });
  it("constructs an unloaded unattached view with the exact dedicated Session and no privileged preload", () => {
    const f = nativeFixture(), guest = createElectronBrowserGuest(f.session as any);
    expect(guest.contents).toBe(f.contents); expect(f.trace).toEqual(["disable_non_proxied_udp"]);
    expect(fixture.preferences).toEqual({ webPreferences: { session: f.session, sandbox: true, contextIsolation: true, webSecurity: true, nodeIntegration: false,
      nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, allowRunningInsecureContent: false, webviewTag: false, devTools: false, navigateOnDragDrop: false, disableDialogs: true } });
    expect(f.popup()).toEqual({ action: "deny" }); guest.destroy();
  });
  it("defaults to deny and preserves request method at the native navigation boundary after registration", async () => {
    const f = nativeFixture(), guest = createElectronBrowserGuest(f.session as any), preventDefault = vi.fn();
    f.contents.emit("will-navigate", { url: "https://example.com/", preventDefault }); expect(preventDefault).toHaveBeenCalledTimes(1);
    const started: string[] = []; guest.installCallbacks({ allowsNavigation: url => url === "https://example.com/", started: url => started.push(url), changed: () => {}, failed: () => {}, destroyed: () => {} });
    preventDefault.mockClear(); f.contents.emit("will-frame-navigate", { url: "https://example.com/", preventDefault }); expect(preventDefault).not.toHaveBeenCalled();
    f.contents.emit("will-redirect", { url: "http://127.0.0.1/", preventDefault }); expect(preventDefault).toHaveBeenCalledTimes(1);
    f.contents.emit("did-start-navigation", {}, "https://example.com/", false, true); expect(started).toEqual(["https://example.com/"]);
    expect(f.trace).not.toContain("load"); await guest.history("back"); guest.destroy();
  });
  it("denies certificate trust, popup/webview and guest resizing without any external fallback", () => {
    const f = nativeFixture(), guest = createElectronBrowserGuest(f.session as any), preventDefault = vi.fn(), callback = vi.fn();
    f.contents.emit("certificate-error", { preventDefault }, "https://example.com", "bad", {}, callback, true); expect(callback).toHaveBeenCalledWith(false);
    f.contents.emit("will-attach-webview", { preventDefault }); f.contents.emit("content-bounds-updated", { preventDefault }); expect(preventDefault).toHaveBeenCalledTimes(3); guest.destroy();
  });
  it("rejects once when Electron forwards the same certificate event/callback to guest and App", () => {
    const f = nativeFixture(), guest = createElectronBrowserGuest(f.session as any), app = new EventEmitter();
    // Electron 43.1.0 lib/browser/api/app.ts forwards this event synchronously to
    // WebContents BEFORE application listeners, reusing the one-time callback.
    app.on("certificate-error", (event, contents, ...args) => contents.emit("certificate-error", event, ...args));
    const service = createBrowserService({ profile: {}, createSession: () => { throw Error("no allocation"); }, createView: () => { throw Error("no allocation"); } });
    const stop = installBrowserServiceLifecycle(app as unknown as Pick<App, "on" | "removeListener">, { ...service, isRegisteredBrowser: contents => contents === f.contents }, { register: () => () => {} });
    const answers: boolean[] = [], callback = (trusted: boolean) => { if (answers.length) throw Error("one-time certificate callback reused"); answers.push(trusted); };
    const event = { preventDefault: vi.fn() };
    try { expect(() => app.emit("certificate-error", event, f.contents, "https://expired.badssl.com/", "ERR_CERT_DATE_INVALID", {}, callback, true)).not.toThrow(); expect(answers).toEqual([false]); }
    finally { stop(); guest.destroy(); }
  });
  it("attaches once, detaches on destroy, and closes without beforeunload waits", () => {
    const f = nativeFixture(), guest = createElectronBrowserGuest(f.session as any), trace: string[] = [];
    const host: BrowserHostPort = Object.assign(new EventEmitter(), { isDestroyed: () => false, isVisible: () => true, isFocused: () => true, getContentSize: (): [number, number] => [100, 100],
      webContents: Object.assign(new EventEmitter(), { id: 10, mainFrame: {}, isDestroyed: () => false }),
      contentView: { addChildView: () => { trace.push("add"); }, removeChildView: () => { trace.push("remove"); } } });
    guest.setBounds({ x: 1, y: 2, width: 3, height: 4 }); guest.attach(host); guest.attach(host); guest.destroy(); guest.destroy();
    expect(trace).toEqual(["add", "remove"]); expect(f.trace).toContain('close:{"waitForBeforeUnload":false}'); expect(fixture.bounds).toEqual([{ x: 1, y: 2, width: 3, height: 4 }]);
  });
  it("completes same-document history on main-frame in-page events and removes wait listeners", async () => {
    const f = nativeFixture(), guest = createElectronBrowserGuest(f.session as any);
    f.contents.navigationHistory.goBack = () => {
      f.contents.emit("did-navigate-in-page", {}, "https://example.com/#child", false);
      f.contents.emit("did-navigate-in-page", {}, "https://example.com/#previous", true);
    };
    let settled = false;
    const pending = guest.history("back").then(() => { settled = true; }, () => {});
    for (let n = 0; n < 8; n++) await Promise.resolve();
    try { expect(settled).toBe(true); expect(f.contents.listenerCount("did-navigate-in-page")).toBe(1); }
    finally { guest.stop(); await pending; guest.destroy(); }
  });
  it("reports renderer crashes and promptly rejects pending history instead of waiting for its timeout", async () => {
    const f = nativeFixture(), guest = createElectronBrowserGuest(f.session as any), failed = vi.fn();
    guest.installCallbacks({ allowsNavigation: () => true, started() {}, changed() {}, failed, destroyed() {} });
    f.contents.navigationHistory.goBack = () => {};
    const pending = guest.history("back");
    f.contents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 1 });
    try {
      expect(failed).toHaveBeenCalledTimes(1);
      await expect(pending).rejects.toThrow("cancelled");
      expect(f.contents.listenerCount("did-fail-load")).toBe(1);
      expect(f.contents.listenerCount("did-navigate-in-page")).toBe(1);
      await expect(guest.history("reload")).resolves.toBeUndefined();
    } finally { guest.destroy(); }
  });
  it("a renderer crash rejects an outstanding load and allows a subsequent load", async () => {
    const f = nativeFixture(), guest = createElectronBrowserGuest(f.session as any);
    let finish!: () => void;
    f.contents.loadURL = () => new Promise<void>(resolve => { finish = resolve; });
    const pending = guest.loadURL("https://example.com/");
    f.contents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 1 });
    try {
      await expect(pending).rejects.toThrow("renderer"); finish();
      f.contents.loadURL = async () => {};
      await expect(guest.loadURL("https://example.com/next")).resolves.toBeUndefined();
    } finally { finish(); guest.destroy(); }
  });
});

  it("runs only fixed DOM scripts in an isolated world and rejects navigation-invalidated observations", async () => {
    const f = nativeFixture(), guest = createElectronBrowserGuest(f.session as any) as any;
    expect(guest.observe).toBeTypeOf("function"); expect(guest.act).toBeTypeOf("function");
    guest.installCallbacks({ allowsNavigation: () => true, started: () => {}, changed: () => {}, failed: () => {}, destroyed: () => {} });
    await guest.loadURL("https://example.com/");
    const execute = vi.fn(async (world: number, scripts: {code: string}[], gesture: boolean) => {
      expect(world).toBe(999); expect(gesture).toBe(false); expect(scripts).toHaveLength(1);
      const match = scripts[0].code.match(/\(({"kind":"observe".*})\)$/);
      const data = JSON.parse(match![1]);
      return { snapshotId: data.snapshotId, url: data.url, title: "fixture", text: "real page", elements: [] };
    });
    (f.contents as any).executeJavaScriptInIsolatedWorld = execute;
    const result = await guest.observe(["example.com"]); expect(result.text).toBe("real page");
    execute.mockImplementationOnce(async () => { await guest.loadURL("https://example.com/next"); return result; });
    await expect(guest.observe(["example.com"])).rejects.toThrow(); guest.destroy();
  });
