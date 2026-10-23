import { randomUUID } from "node:crypto";
import { browserDomScript } from "./browser-dom-script";
import type { BrowserDomInput, BrowserObservation } from "../../shared/manual-browser";
import { WebContentsView, type Session } from "electron";
import type { BrowserGuestPort, BrowserHostPort } from "./browser-service";
import { registerBrowserGuestRouting } from "./browser-guest-routing";
import { rejectBrowserCertificate } from "./browser-certificate-policy";
import { createGuestTools, type GuestToolsContents } from "./browser-guest-tools";
/** Fixed Main preferences; no remote page receives Firefly preload or Node.
 * https://github.com/electron/electron/blob/v43.1.0/docs/api/web-contents-view.md
 */
export function createElectronBrowserGuest(session: Session): BrowserGuestPort<Session> {
  const view = new WebContentsView({ webPreferences: { session, sandbox: true, contextIsolation: true, webSecurity: true,
    nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, allowRunningInsecureContent: false,
    webviewTag: false, devTools: false, navigateOnDragDrop: false, disableDialogs: true } });
  const contents = view.webContents;
  let host: BrowserHostPort | undefined, destroying = false;
  let callbacks: Parameters<BrowserGuestPort<Session>["installCallbacks"]>[0] = {
    allowsNavigation: () => false, started: () => {}, changed: () => {}, failed: () => {}, destroyed: () => {},
  };
  const historyWaiters = new Set<() => void>();
  const rendererWaiters = new Set<() => void>();
  let rendererRevision = 0;
  function cancelRendererWork(): void { rendererRevision++; rendererWaiters.forEach(cancel => cancel()); }
  async function rendererWork<T>(operation: () => Promise<T>): Promise<T> {
    const revision = rendererRevision;
    let cancel!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => { cancel = () => reject(new Error("browser renderer unavailable")); rendererWaiters.add(cancel); });
    try {
      const result = await Promise.race([operation(), cancelled]);
      if (rendererRevision !== revision) throw new Error("browser renderer changed");
      return result;
    } finally { rendererWaiters.delete(cancel); }
  }
  const offRouting = registerBrowserGuestRouting(contents, url => !destroying && !contents.isDestroyed() && callbacks.allowsNavigation(url));
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp"); // Control, not a claim of complete cross-protocol egress proof.
  contents.on("will-navigate", (event, legacyUrl) => { if (!callbacks.allowsNavigation(event.url ?? legacyUrl)) event.preventDefault(); });
  contents.on("will-frame-navigate", event => { if (!callbacks.allowsNavigation(event.url)) event.preventDefault(); });
  contents.on("will-redirect", (event, legacyUrl) => { if (!callbacks.allowsNavigation(event.url ?? legacyUrl)) event.preventDefault(); });
  contents.on("will-attach-webview", event => event.preventDefault());
  contents.on("content-bounds-updated", event => event.preventDefault());
  contents.on("certificate-error", (event, _url, _error, _certificate, callback) => rejectBrowserCertificate(event, callback));
  contents.on("did-start-navigation", (_event, url, _inPlace, main) => { if (main) callbacks.started(url); });
  contents.on("did-redirect-navigation", (_event, url, _inPlace, main) => { if (main) callbacks.started(url, true); });
  contents.on("did-finish-load", () => callbacks.changed());
  contents.on("did-navigate-in-page", (_event, _url, main) => { if (main) callbacks.changed(); });
  contents.on("did-fail-load", (_event, code, _description, url, main) => { if (main) callbacks.failed(code, url); });
  // A crashed renderer leaves WebContents alive; notify the service and settle
  // its native work so the existing error/reload path can recover.
  // https://github.com/electron/electron/blob/v43.7.0/docs/api/web-contents.md#event-render-process-gone
  contents.on("render-process-gone", () => { cancelRendererWork(); historyWaiters.forEach(cancel => cancel()); callbacks.failed(); });
  contents.on("destroyed", () => { offRouting(); cancelRendererWork(); historyWaiters.forEach(cancel => cancel()); callbacks.destroyed(); });
  function detach(): void {
    const attached = host; host = undefined;
    if (attached && !attached.isDestroyed()) attached.contentView.removeChildView(view);
  }
  function stop(): void { cancelRendererWork(); historyWaiters.forEach(cancel => cancel()); if (!contents.isDestroyed()) contents.stop(); }
  function history(action: "back" | "forward" | "reload"): Promise<void> {
    if (contents.isDestroyed()) return Promise.reject(new Error("browser closed"));
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const clear = () => { if (timer) clearTimeout(timer); contents.removeListener("did-finish-load", done); contents.removeListener("did-navigate-in-page", inPage); contents.removeListener("did-fail-load", failed); historyWaiters.delete(cancel); };
      const done = () => { clear(); resolve(); };
      const inPage = (_event: Electron.Event, _url: string, main: boolean) => { if (main) done(); };
      const cancel = () => { clear(); reject(new Error("browser navigation cancelled")); };
      const failed = (_event: Electron.Event, code: number, _description: string, _url: string, main: boolean) => {
        if (main) { clear(); reject(Object.assign(new Error("browser navigation failed"), { errno: code })); }
      };
      contents.on("did-finish-load", done); contents.on("did-navigate-in-page", inPage); contents.on("did-fail-load", failed); historyWaiters.add(cancel);
      timer = setTimeout(() => { cancel(); if (!contents.isDestroyed()) contents.stop(); }, 30000);
      try {
        if (action === "reload") contents.reload();
        else if (action === "back" && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
        else if (action === "forward" && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
        else cancel();
      } catch { cancel(); }
    });
  }
  async function runDom(input: BrowserDomInput): Promise<unknown> {
    if (destroying || contents.isDestroyed() || contents.isCrashed() || contents.getURL() !== input.url || !callbacks.allowsNavigation(input.url)) throw new Error("browser page unavailable");
    const result: unknown = await rendererWork(() => contents.executeJavaScriptInIsolatedWorld(999, [{ code: browserDomScript(input) }], false));
    if (destroying || contents.isDestroyed() || (input.kind === "observe" && contents.getURL() !== input.url) || !callbacks.allowsNavigation(contents.getURL())) throw new Error("browser page changed");
    return result;
  }
  async function observe(hosts?: readonly string[]): Promise<BrowserObservation> {
    const input: BrowserDomInput = { kind: "observe", snapshotId: randomUUID(), url: contents.getURL(), hosts };
    const value = await runDom(input) as Partial<BrowserObservation> | null;
    if (!value || value.snapshotId !== input.snapshotId || value.url !== input.url || typeof value.title !== "string" || typeof value.text !== "string" || !Array.isArray(value.elements) || value.elements.length > 160) throw new Error("browser observation unavailable");
    return value as BrowserObservation;
  }
  async function act(input: BrowserDomInput): Promise<boolean> {
    if (input.kind !== "click" && input.kind !== "type") return false;
    const result = await runDom(input) as { ok?: unknown } | null;
    return result?.ok === true;
  }
  const tools = createGuestTools(contents as unknown as GuestToolsContents);
  return Object.freeze({ contents, tools, observe, act, loadURL: (url: string) => rendererWork(() => contents.loadURL(url)), history,
    snapshot: () => ({ url: contents.getURL(), canGoBack: contents.navigationHistory.canGoBack(), canGoForward: contents.navigationHistory.canGoForward() }),
    stop, detach, setBounds: (bounds: import("./browser-service").BrowserBounds) => view.setBounds(bounds),
    attach(target: BrowserHostPort) { if (destroying || contents.isDestroyed() || target.isDestroyed()) throw new Error("browser view unavailable"); if (host === target) return; detach(); target.contentView.addChildView(view); host = target; },
    destroy() { if (destroying) return; destroying = true; detach(); stop(); if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false }); },
    installCallbacks(next: Parameters<BrowserGuestPort<Session>["installCallbacks"]>[0]) { callbacks = next; },
  });
}
