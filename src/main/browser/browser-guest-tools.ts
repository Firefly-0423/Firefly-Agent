import {
  BROWSER_COOKIE_DOMAIN_LIMIT, BROWSER_HISTORY_LIMIT, BROWSER_SNAPSHOT_MAX_CHARS, nextBrowserZoomPercent,
  type BrowserClearKind, type BrowserCookieDomainDto, type BrowserDevicePreset, type BrowserHistoryEntryDto, type BrowserTabToolState, type BrowserZoomOp,
} from "../../shared/browser-tools";

/** The part of an Electron WebContents the tools use. Kept structural so tests can supply a fake. */
export interface GuestToolsContents {
  isDestroyed(): boolean;
  findInPage(text: string, options: { forward: boolean; findNext: boolean; matchCase: boolean }): number;
  stopFindInPage(action: "clearSelection"): void;
  getZoomFactor(): number;
  setZoomFactor(factor: number): void;
  enableDeviceEmulation(parameters: {
    screenPosition: "mobile"; screenSize: { width: number; height: number }; viewPosition: { x: number; y: number };
    deviceScaleFactor: number; viewSize: { width: number; height: number }; scale: number;
  }): void;
  disableDeviceEmulation(): void;
  getUserAgent(): string;
  setUserAgent(userAgent: string): void;
  print(options: { silent: boolean; printBackground: boolean }): void;
  capturePage(): Promise<{ isEmpty(): boolean; toPNG(): Buffer; toJPEG(quality: number): Buffer }>;
  navigationHistory: { getAllEntries(): { url: string; title: string }[]; getActiveIndex(): number };
  session: {
    cookies: {
      get(filter: Record<string, never>): Promise<{ domain: string; name: string; path: string; secure?: boolean }[]>;
      remove(url: string, name: string): Promise<void>;
    };
    clearStorageData(options?: { storages?: string[] }): Promise<void>;
    clearCache(): Promise<void>;
  };
  on(event: string, listener: (...args: any[]) => void): unknown;
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
}

export interface BrowserGuestTools {
  state(): BrowserTabToolState;
  find(text: string, forward: boolean, next: boolean): BrowserTabToolState;
  stopFind(): BrowserTabToolState;
  zoom(op: BrowserZoomOp): BrowserTabToolState;
  device(preset: BrowserDevicePreset): BrowserTabToolState;
  print(): void;
  /** PNG of the visible page, or null when nothing could be captured (for example the view is not attached). */
  capture(): Promise<Buffer | null>;
  /** A JPEG data URL of the visible page, or null when nothing was captured or it is too large to be worth sending. */
  snapshot(): Promise<string | null>;
  history(): BrowserHistoryEntryDto[];
  cookies(): Promise<BrowserCookieDomainDto[]>;
  clear(kinds: readonly BrowserClearKind[], domain?: string): Promise<void>;
  /** Called after any change the window should re-read (find result, navigation, zoom). Returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
}

const SITE_STORAGES = ["localstorage", "indexdb", "filesystem", "websql", "serviceworkers", "cachestorage"];
const DEVICES = {
  phone: { screenSize: { width: 390, height: 844 }, deviceScaleFactor: 3, mobileToken: " Mobile" },
  tablet: { screenSize: { width: 820, height: 1180 }, deviceScaleFactor: 2, mobileToken: "" },
} as const;
const MAX_TITLE = 200, MAX_URL = 4096;

function chromeVersion(userAgent: string): string { return /Chrome\/([\d.]+)/.exec(userAgent)?.[1] ?? "130.0.0.0"; }
function mobileUserAgent(preset: "phone" | "tablet", original: string): string {
  const version = chromeVersion(original);
  const device = preset === "phone" ? "Android 14; Pixel 8" : "Android 14; SM-X710";
  return `Mozilla/5.0 (Linux; ${device}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version}${DEVICES[preset].mobileToken} Safari/537.36`;
}
const cookieHost = (domain: string) => (domain.startsWith(".") ? domain.slice(1) : domain).toLowerCase();

export function createGuestTools(contents: GuestToolsContents): BrowserGuestTools {
  const listeners = new Set<() => void>();
  let find: BrowserTabToolState["find"] = null, device: BrowserDevicePreset = "off", originalUserAgent: string | null = null;
  const alive = () => !contents.isDestroyed();
  const notify = () => { for (const listener of [...listeners]) { try { listener(); } catch { /* a listener cannot break the page */ } } };
  const state = (): BrowserTabToolState => ({
    zoomPercent: alive() ? Math.round(contents.getZoomFactor() * 100) : 100, device, find: find ? { ...find } : null,
  });
  const onFound = (_event: unknown, result: { activeMatchOrdinal?: number; matches?: number }) => {
    if (!find) return;
    find = { ...find, active: Math.max(0, Math.trunc(result.activeMatchOrdinal ?? 0)), matches: Math.max(0, Math.trunc(result.matches ?? 0)) };
    notify();
  };
  // A new document drops the previous highlights; an in-page change keeps them (and needs no listener).
  const onNavigated = () => { find = null; notify(); };
  contents.on("found-in-page", onFound);
  contents.on("did-navigate", onNavigated);
  contents.on("did-finish-load", notify);
  contents.on("zoom-changed", notify);

  return Object.freeze({
    state,
    find(text: string, forward: boolean, next: boolean) {
      if (!alive()) return state();
      // A new query starts a new search; the same query steps through the matches.
      const continuing = next && find?.query === text;
      if (!continuing) find = { query: text, active: 0, matches: 0 };
      contents.findInPage(text, { forward, findNext: continuing, matchCase: false });
      return state();
    },
    stopFind() {
      if (alive()) contents.stopFindInPage("clearSelection");
      find = null;
      return state();
    },
    zoom(op: BrowserZoomOp) {
      if (!alive()) return state();
      contents.setZoomFactor(nextBrowserZoomPercent(Math.round(contents.getZoomFactor() * 100), op) / 100);
      notify();
      return state();
    },
    device(preset: BrowserDevicePreset) {
      if (!alive()) return state();
      if (preset === "off") {
        contents.disableDeviceEmulation();
        if (originalUserAgent !== null) { contents.setUserAgent(originalUserAgent); originalUserAgent = null; }
      } else {
        if (originalUserAgent === null) originalUserAgent = contents.getUserAgent();
        const spec = DEVICES[preset];
        // A zero view size lets the emulated screen follow the pane, so resizing the pane keeps working.
        contents.enableDeviceEmulation({ screenPosition: "mobile", screenSize: spec.screenSize, viewPosition: { x: 0, y: 0 },
          deviceScaleFactor: spec.deviceScaleFactor, viewSize: { width: 0, height: 0 }, scale: 1 });
        contents.setUserAgent(mobileUserAgent(preset, originalUserAgent));
      }
      device = preset;
      notify();
      return state();
    },
    print() { if (alive()) contents.print({ silent: false, printBackground: true }); },
    async capture() {
      if (!alive()) return null;
      const image = await contents.capturePage();
      return image.isEmpty() ? null : image.toPNG();
    },
    async snapshot() {
      if (!alive()) return null;
      const image = await contents.capturePage();
      if (image.isEmpty()) return null;
      const url = `data:image/jpeg;base64,${image.toJPEG(70).toString("base64")}`;
      return url.length <= BROWSER_SNAPSHOT_MAX_CHARS ? url : null;
    },
    history() {
      if (!alive()) return [];
      const entries = contents.navigationHistory.getAllEntries(), active = contents.navigationHistory.getActiveIndex();
      const start = Math.max(0, entries.length - BROWSER_HISTORY_LIMIT);
      const result: BrowserHistoryEntryDto[] = [];
      for (let index = start; index < entries.length; index++) {
        const entry = entries[index];
        if (typeof entry.url !== "string" || !entry.url || entry.url.length > MAX_URL) continue;
        result.push({ index, url: entry.url, title: String(entry.title ?? "").slice(0, MAX_TITLE), current: index === active });
      }
      return result.reverse();
    },
    async cookies() {
      if (!alive()) return [];
      const counts = new Map<string, number>();
      for (const cookie of await contents.session.cookies.get({})) {
        const host = cookieHost(cookie.domain);
        if (host) counts.set(host, (counts.get(host) ?? 0) + 1);
      }
      return [...counts.entries()].map(([domain, count]) => ({ domain, count }))
        .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain)).slice(0, BROWSER_COOKIE_DOMAIN_LIMIT);
    },
    async clear(kinds: readonly BrowserClearKind[], domain?: string) {
      if (!alive()) return;
      const session = contents.session;
      if (kinds.includes("cookies")) {
        if (domain === undefined) await session.clearStorageData({ storages: ["cookies"] });
        else {
          for (const cookie of await session.cookies.get({})) {
            if (cookieHost(cookie.domain) !== domain) continue;
            await session.cookies.remove(`${cookie.secure ? "https" : "http"}://${domain}${cookie.path || "/"}`, cookie.name);
          }
        }
      }
      if (kinds.includes("cache")) await session.clearCache();
      if (kinds.includes("storage")) await session.clearStorageData({ storages: SITE_STORAGES });
      notify();
    },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  });
}
