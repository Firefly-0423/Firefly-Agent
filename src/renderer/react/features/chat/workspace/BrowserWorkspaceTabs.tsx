import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import type { BrowserReply, BrowserWorkspaceStateDto } from "../../../../../shared/manual-browser";
import { Globe, Plus, X } from "lucide-react";
import { useTranslation } from "../../../i18n";
import { ManualBrowserTab, type ManualBrowserTabHandle } from "./ManualBrowserTab";
import "./BrowserWorkspaceTabs.css";

/** A closed tab collapses for this long before Main is asked to remove it. Matches the CSS exit time. */
const TAB_EXIT_MS = 150;

/** Window tabs stay mounted when conversation or inspector selection changes.
 * Main supplies every workspace/tab ID and owns the cap and native attachment.
 * `paneClose` adds the pane's own close control, used when the browser is the only inspector tab. */
export function BrowserWorkspaceTabs({ sessionId, active = true, onClose, paneClose = false, ref }: { sessionId?: string; active?: boolean; onClose(): void; paneClose?: boolean; ref?: Ref<ManualBrowserTabHandle> }) {
  const { t } = useTranslation();
  const [state, setState] = useState<BrowserWorkspaceStateDto | null>(null);
  const [error, setError] = useState<string | null>(null), [pending, setPending] = useState(false);
  const [agent, setAgent] = useState(false);
  const [exiting, setExiting] = useState<string | null>(null);
  const current = useRef<BrowserWorkspaceStateDto | null>(null), busy = useRef(false);
  const scopeRef = useRef<object | null>(null), agentRef = useRef<ManualBrowserTabHandle>(null);
  const api = typeof window === "undefined" ? undefined : window.manualBrowserWorkspace;
  function adopt(next: BrowserWorkspaceStateDto) { current.current = next; setState(next); }
  useEffect(() => {
    const scope = {}; scopeRef.current = scope;
    const off = api?.onChanged(page => {
      const value = current.current;
      if (scopeRef.current !== scope || !value || page.workspaceId !== value.workspaceId) return;
      const found = value.tabs.find(tab => tab.tabId === page.tabId);
      if (!found || (found.page && found.page.browserId === page.browserId && found.page.requestId > page.requestId)) return;
      adopt({ ...value, tabs: value.tabs.map(tab => tab === found ? { ...tab, page } : tab) });
    });
    void api?.getTabs().then(reply => {
      if (scopeRef.current !== scope) return;
      if (reply.ok) { adopt(reply.value); setError(null); } else setError(reply.code);
    }).catch(() => { if (scopeRef.current === scope) setError("network_unavailable"); });
    if (!api) setError("network_unavailable");
    return () => { off?.(); if (scopeRef.current === scope) scopeRef.current = null; };
  }, [api]);
  useEffect(() => { if (!sessionId) setAgent(false); }, [sessionId]);
  useEffect(() => {
    if (!api || !sessionId) return;
    let disposed = false, received = false;
    const legacy = window.manualBrowser;
    const off = legacy?.onChanged(page => {
      if (!disposed && page.conversationId === sessionId) { received = true; if (!page.closed) setAgent(true); }
    });
    void legacy?.execute({ kind: "get" }).then(reply => {
      if (!disposed && !received && reply.ok && reply.value?.conversationId === sessionId && !reply.value.closed) setAgent(true);
    }).catch(() => {});
    return () => { disposed = true; off?.(); };
  }, [api, sessionId]);
  /** Resolves with the adopted state, or null when nothing changed (refused, superseded or failed). */
  async function mutate(action: () => Promise<BrowserReply<BrowserWorkspaceStateDto>>): Promise<BrowserWorkspaceStateDto | null> {
    if (busy.current || !scopeRef.current) return null;
    const scope = scopeRef.current; busy.current = true; setPending(true);
    try {
      const reply = await action(); if (scopeRef.current !== scope) return null;
      if (reply.ok) { adopt(reply.value); setAgent(false); setError(null); return reply.value; }
      setError(reply.code);
    } catch { if (scopeRef.current === scope) setError("network_unavailable"); }
    finally { busy.current = false; if (scopeRef.current === scope) setPending(false); }
    return null;
  }
  async function close(): Promise<boolean> {
    if (!api) return await agentRef.current?.close() ?? false;
    if (!current.current) { onClose(); return true; }
    if (busy.current || !scopeRef.current) return false;
    const scope = scopeRef.current, agentHandle = agentRef.current;
    busy.current = true; setPending(true);
    try {
      const reply = await api.revokePermission(current.current.workspaceId);
      if (scopeRef.current !== scope) return false;
      if (!reply.ok) { setError(reply.code); return false; }
      adopt({ ...current.current, activeTabId: null, tabs: [] });
      if (agentHandle && !(await agentHandle.close())) { if (scopeRef.current === scope) setError("cleanup_failed"); return false; }
      if (scopeRef.current !== scope) return false;
      onClose(); return true;
    } catch { if (scopeRef.current === scope) setError("cleanup_failed"); return false; }
    finally { busy.current = false; if (scopeRef.current) setPending(false); }
  }
  /** Closing plays the tab's exit first and only then asks Main. A refused close brings the tab back.
   * Closing the last tab closes the browser pane too, so no empty pane is left holding the width. */
  function closeTab(tabId: string) {
    const target = api;
    if (!target || exiting) return;
    setExiting(tabId);
    window.setTimeout(() => {
      void mutate(() => target.closeTab(tabId))
        .then(next => { if (next && next.tabs.length === 0) return close(); })
        .finally(() => setExiting(now => now === tabId ? null : now));
    }, TAB_EXIT_MS);
  }
  useImperativeHandle(ref, () => ({ close }));
  // Compatibility for an older preload and static rendering. No window grant is
  // translated into a conversation identity; production uses the dedicated API.
  if (!api) return <div className="ff-browser-window">
    {paneClose && <div className="ff-browser-window__strip">
      <span className="ff-browser-window__strip-spacer" aria-hidden="true" />
      <button type="button" aria-label={t("browserWorkspace.closePanel")} title={t("browserWorkspace.closePanel")} data-browser-close-pane disabled={pending}
        onClick={() => void close()}><X size={15} aria-hidden="true" /></button>
    </div>}
    <ManualBrowserTab ref={agentRef} sessionId={sessionId} active={active} onClose={onClose} />
  </div>;
  return <div className="ff-browser-window">
    <div className="ff-browser-window__strip">
      <div className="ff-browser-window__tabs" role="tablist" aria-label={t("browserWorkspace.tabs")}>
        {state?.tabs.map((tab, index) => <div className={`ff-browser-window__tab${exiting === tab.tabId ? " is-closing" : ""}`} key={tab.tabId}>
          <button type="button" role="tab" aria-selected={!agent && state.activeTabId === tab.tabId} disabled={pending} data-browser-select-tab={tab.tabId}
            title={tab.page?.url || undefined} onClick={() => api && void mutate(() => api.selectTab(tab.tabId))}>
            <Globe size={14} aria-hidden="true" />
            <span className="ff-browser-window__tab-title">{tab.page?.url ? new URL(tab.page.url).hostname : index === 0 && state.tabs.length === 1 ? t("browserWorkspace.newTabTitle") : `${t("browserWorkspace.newTabTitle")} ${index + 1}`}</span>
          </button>
          <button type="button" aria-label={t("browserWorkspace.closeTab")} disabled={pending || exiting !== null} data-browser-close-tab={tab.tabId}
            onClick={() => closeTab(tab.tabId)}><X size={13} aria-hidden="true" /></button>
        </div>)}
        {sessionId && <button type="button" role="tab" className="ff-browser-window__agent" aria-selected={agent} disabled={pending} onClick={() => setAgent(true)}>{t("browserWorkspace.agentMode")}</button>}
      </div>
      <button type="button" aria-label={t("browserWorkspace.newTab")} title={t("browserWorkspace.newTab")} data-browser-new-tab disabled={pending || !api || !state || state.tabs.length >= 8}
        onClick={() => api && void mutate(() => api.newTab())}><Plus size={15} aria-hidden="true" /></button>
      {paneClose && <button type="button" aria-label={t("browserWorkspace.closePanel")} title={t("browserWorkspace.closePanel")} data-browser-close-pane disabled={pending}
        onClick={() => void close()}><X size={15} aria-hidden="true" /></button>}
    </div>
    {error && <p className="ff-browser-window__alert" role="alert">{t(error === "tab_limit" ? "browserWorkspace.tabLimit" : error === "cleanup_failed" ? "browserWorkspace.cleanupFailed" : "browserWorkspace.stateUnavailable")}</p>}
    {state?.tabs.map(tab => <div key={tab.tabId} hidden={agent || state.activeTabId !== tab.tabId} className="ff-browser-window__page">
      <ManualBrowserTab workspaceId={state.workspaceId} tabId={tab.tabId} active={active && !agent && state.activeTabId === tab.tabId}
        onClose={() => closeTab(tab.tabId)} />
    </div>)}
    {sessionId && <div hidden={!agent} className="ff-browser-window__page"><ManualBrowserTab key={sessionId} ref={agentRef} sessionId={sessionId} active={active && agent} onClose={() => setAgent(false)} /></div>}
  </div>;
}
