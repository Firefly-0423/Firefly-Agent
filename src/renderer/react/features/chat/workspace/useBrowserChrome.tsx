import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Download, MoreHorizontal } from "lucide-react";
import { useTranslation } from "../../../i18n";
import type { BrowserClearKind, BrowserCookieDomainDto, BrowserDevicePreset, BrowserHistoryEntryDto, BrowserZoomOp } from "../../../../../shared/browser-tools";
import { useBrowserToolsState } from "./browser-tools-state";
import { BrowserFindBar } from "./BrowserFindBar";
import { BrowserDownloadsPopover, BrowserHistoryPopover, BrowserMoreMenu, type BrowserMenuAction } from "./BrowserToolsMenu";
import { BrowserSettingsPanel, type BrowserSettingsSection } from "./BrowserSettingsPanel";
import "./BrowserTools.css";

type Surface = "menu" | "downloads" | "history" | "settings";
/** The native page is detached while a surface covers it; it needs a moment to be back before capture or print. */
const REATTACH_MS = 300;
const NOTICE_MS = 4000;
const sleep = (ms: number) => new Promise<void>(resolve => window.setTimeout(resolve, ms));

export interface BrowserChromeInput {
  /** Workspace tab id. Tools exist only for window tabs. */
  tabId?: string;
  /** False while the tab is hidden: every open surface closes. */
  enabled: boolean;
  pageLoaded: boolean;
  navigate(url: string): void;
  /** Reloads the current page. Asked for after a device preview change, because the user agent only applies to new requests. */
  reload?(): void;
}
export interface BrowserChrome {
  /** Downloads and "more" buttons for the right end of the toolbar. */
  toolbarEnd: ReactNode;
  /** Find bar and short notices, under the toolbar. */
  belowToolbar: ReactNode;
  /** Menu, popovers and the settings page, drawn over the page area. */
  overlay: ReactNode;
  /** A surface covers the page area, so the native page has to stay detached. */
  overlayOpen: boolean;
  /** Stand-in picture of the page while it is detached. */
  snapshot: string | null;
}

/** The window browser's tools: toolbar buttons, the more menu, find, downloads, history and the settings page.
 * The panel stays a controlled view; all asynchronous work and every Main call lives here. */
export function useBrowserChrome({ tabId, enabled, pageLoaded, navigate, reload }: BrowserChromeInput): BrowserChrome {
  const { t } = useTranslation();
  const tools = useBrowserToolsState(tabId, pageLoaded);
  const { run } = tools;
  const [surface, setSurface] = useState<Surface | null>(null), [snapshot, setSnapshot] = useState<string | null>(null);
  const [section, setSection] = useState<BrowserSettingsSection>("downloads");
  const [findOpen, setFindOpen] = useState(false);
  const [history, setHistory] = useState<readonly BrowserHistoryEntryDto[] | null>(null);
  const [cookies, setCookies] = useState<readonly BrowserCookieDomainDto[] | null>(null);
  const [status, setStatus] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const opening = useRef(false), moreButton = useRef<HTMLButtonElement>(null), downloadsButton = useRef<HTMLButtonElement>(null), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const close = useCallback((restoreFocus = true) => {
    if (restoreFocus && surface === "menu") moreButton.current?.focus();
    else if (restoreFocus && surface === "downloads") downloadsButton.current?.focus();
    setSurface(null); setSnapshot(null); setStatus(null);
  }, [surface]);
  useEffect(() => { if (!enabled) { close(false); setFindOpen(false); } }, [enabled, close]);
  useEffect(() => { if (!pageLoaded) setFindOpen(false); }, [pageLoaded]);

  /** Opens a surface. The first one captures the page first, so the stand-in is already there when the page is detached. */
  const open = useCallback(async (next: Surface) => {
    if (opening.current) return;
    opening.current = true;
    try {
      if (surface === null) {
        let image: string | null = null;
        if (pageLoaded) { const reply = await run({ tool: "snapshot" }); if (reply.ok) image = reply.value.image; }
        if (!alive.current) return;
        setSnapshot(image);
      }
      setSurface(next);
    } finally { opening.current = false; }
  }, [surface, pageLoaded, run]);
  const toggle = (next: Surface) => { if (surface === next) close(); else void open(next); };

  const fail = (code: string) => setNotice(t(code === "unsupported" || code === "permission_denied" ? "browserWorkspace.tools.toolUnavailable" : "browserWorkspace.tools.toolFailed"));

  const loadCookies = useCallback(async () => {
    const reply = await run({ tool: "cookies" });
    if (alive.current) setCookies(reply.ok ? reply.value.domains : []);
  }, [run]);
  const openSettings = (next: BrowserSettingsSection) => {
    setSection(next); setCookies(null); setStatus(null);
    void open("settings"); void loadCookies();
  };

  async function afterClosing(work: () => Promise<void>) {
    close(false);
    await sleep(REATTACH_MS);
    if (alive.current) await work();
  }
  function onAction(action: BrowserMenuAction) {
    switch (action) {
      case "find": close(false); setFindOpen(true); break;
      case "print": void afterClosing(async () => { const reply = await run({ tool: "print" }); if (!reply.ok) fail(reply.code); }); break;
      case "screenshot": void afterClosing(async () => {
        const reply = await run({ tool: "screenshot" });
        if (!reply.ok) fail(reply.code); else if (reply.value.saved) setNotice(t("browserWorkspace.tools.screenshotSaved"));
      }); break;
      case "cookies": openSettings("cookies"); break;
      case "clear-data": openSettings("clear"); break;
      case "settings": openSettings("downloads"); break;
      case "downloads": void run({ tool: "download", op: "list" }); setSurface("downloads"); break;
      case "history":
        setHistory(null); setSurface("history");
        void run({ tool: "history" }).then(reply => { if (alive.current) setHistory(reply.ok ? reply.value.entries : []); });
        break;
    }
  }
  const zoom = (op: BrowserZoomOp) => { void run({ tool: "zoom", op }).then(reply => { if (!reply.ok) fail(reply.code); }); };
  const device = (preset: BrowserDevicePreset) => {
    const changed = preset !== tools.tab.device;
    void run({ tool: "device", preset }).then(reply => { if (!reply.ok) fail(reply.code); else if (changed) reload?.(); });
  };

  const queryFind = useCallback((text: string) => { void run(text ? { tool: "find", text, forward: true, next: false } : { tool: "stop-find" }); }, [run]);
  const stepFind = useCallback((forward: boolean, text: string) => { void run({ tool: "find", text, forward, next: true }); }, [run]);
  const closeFind = () => { setFindOpen(false); void run({ tool: "stop-find" }); };

  async function settingsCall(work: () => Promise<boolean>, success?: string) {
    setBusy(true); setStatus(null);
    try { const ok = await work(); if (alive.current) setStatus(ok ? success ?? null : t("browserWorkspace.tools.toolFailed")); }
    finally { if (alive.current) setBusy(false); }
  }
  const clear = (kinds: readonly BrowserClearKind[], domain?: string) => settingsCall(async () => {
    const reply = await run({ tool: "clear-data", kinds, ...(domain === undefined ? {} : { domain }) });
    if (reply.ok && (kinds.includes("cookies"))) await loadCookies();
    return reply.ok;
  }, t("browserWorkspace.tools.clearDone"));

  if (!tools.available || !enabled) return { toolbarEnd: null, belowToolbar: null, overlay: null, overlayOpen: false, snapshot: null };
  const running = tools.downloads.some(item => item.state === "progressing");
  const toolbarEnd = <div className="ff-browser-tools" role="group" aria-label={t("browserWorkspace.tools.more")}>
    <button ref={downloadsButton} type="button" data-browser-downloads-button aria-label={t("browserWorkspace.tools.downloadsButton")} title={t("browserWorkspace.tools.downloadsButton")}
      aria-haspopup="dialog" aria-expanded={surface === "downloads"} data-active={running || undefined} onClick={() => toggle("downloads")}>
      <Download size={16} aria-hidden="true" />{running && <span className="ff-browser-tools__dot" aria-hidden="true" />}
    </button>
    <button ref={moreButton} type="button" data-browser-more-button aria-label={t("browserWorkspace.tools.more")} title={t("browserWorkspace.tools.more")}
      aria-haspopup="menu" aria-expanded={surface === "menu"} onClick={() => toggle("menu")}>
      <MoreHorizontal size={16} aria-hidden="true" />
    </button>
  </div>;
  const belowToolbar = <>
    {findOpen && pageLoaded && <BrowserFindBar find={tools.tab.find} onQuery={queryFind} onStep={stepFind} onClose={closeFind} />}
    {notice && <p className="ff-browser-workspace__notice" role="status" data-browser-tool-notice>{notice}</p>}
  </>;
  const overlay = surface === null ? null : <div className="ff-browser-layer" data-browser-layer={surface}>
    {surface !== "settings" && <div className="ff-browser-layer__backdrop" data-browser-backdrop onMouseDown={() => close()} />}
    {surface === "menu" && <BrowserMoreMenu pageLoaded={pageLoaded} zoomPercent={tools.tab.zoomPercent} device={tools.tab.device}
      onAction={onAction} onZoom={zoom} onDevice={device} onClose={() => close()} />}
    {surface === "downloads" && <BrowserDownloadsPopover downloads={tools.downloads} onClose={() => close()} onSettings={() => openSettings("downloads")}
      onOpen={id => { void run({ tool: "download", op: "open", id }).then(reply => { if (!reply.ok) fail(reply.code); }); }}
      onReveal={id => { void run({ tool: "download", op: "reveal", id }).then(reply => { if (!reply.ok) fail(reply.code); }); }}
      onCancel={id => { void run({ tool: "download", op: "cancel", id }); }} onRemove={id => { void run({ tool: "download", op: "remove", id }); }}
      onClear={() => { void run({ tool: "download", op: "clear" }); }} />}
    {surface === "history" && <BrowserHistoryPopover entries={history} onClose={() => close()} onPick={url => { close(false); navigate(url); }} />}
    {surface === "settings" && <BrowserSettingsPanel section={section} settings={tools.settings} cookies={cookies} status={status} busy={busy} onClose={() => close(false)}
      onAskWhere={value => { void settingsCall(async () => (await run({ tool: "settings", patch: { askWhereToSave: value } })).ok); }}
      onChooseFolder={() => { void settingsCall(async () => (await run({ tool: "settings", chooseFolder: true })).ok); }}
      onResetFolder={() => { void settingsCall(async () => (await run({ tool: "settings", resetFolder: true })).ok); }}
      onClearSite={domain => { void clear(["cookies"], domain); }} onClear={kinds => { void clear(kinds); }} />}
  </div>;
  return { toolbarEnd, belowToolbar, overlay, overlayOpen: surface !== null, snapshot };
}
