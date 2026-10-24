import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { type BrowserPermissionScope, type BrowserOwnedPageDto, type BrowserOwnedPermissionDto, type ManualBrowserApi, type BrowserReply, type ManualBrowserCommand } from "../../../../../shared/manual-browser";
import { manualBrowserTarget, parseLocalAuthority, resolveAddressInput } from "../../../../../shared/local-network-target";
import { useTranslation } from "../../../i18n";
import { BrowserWorkspacePanel, type BrowserWorkspaceLabels } from "./BrowserWorkspacePanel";
import { BrowserNewTab, rememberVisitedSite } from "./BrowserNewTab";
import { useBrowserChrome } from "./useBrowserChrome";
import { createBrowserPageState, type BrowserPageState } from "./browser-page-state";

type ViewApi = Omit<ManualBrowserApi, "getPermission" | "requestPermission" | "revokePermission" | "execute" | "onChanged"> & {
  getPermission(): Promise<BrowserReply<BrowserOwnedPermissionDto>>;
  requestPermission(scope: BrowserPermissionScope): Promise<BrowserReply<BrowserOwnedPermissionDto>>;
  revokePermission(identity?: string): Promise<BrowserReply<BrowserOwnedPermissionDto>>;
  execute(command: ManualBrowserCommand): Promise<BrowserReply<BrowserOwnedPageDto | null>>;
  onChanged(listener: (page: BrowserOwnedPageDto) => void): () => void;
};
function belongs(scope: Scope, dto: BrowserOwnedPageDto | BrowserOwnedPermissionDto) {
  return scope.workspaceId ? dto.conversationId === null && dto.workspaceId === scope.workspaceId && dto.tabId === scope.tabId
    : !!scope.sessionId && dto.conversationId === scope.sessionId;
}
function emptyPage(sessionId?: string, workspaceId?: string, tabId?: string): BrowserPageState {
  return workspaceId ? { ...createBrowserPageState(null, ""), workspaceId, tabId } : createBrowserPageState(sessionId ?? "", "");
}
interface Scope {
  sessionId?: string; workspaceId?: string; tabId?: string; ownerKey?: string; api?: ViewApi; disposed: boolean; closed: boolean; opening: boolean;
  commandRevision: number; permissionRevision: number; preserveAddress: boolean; permissionBusy: boolean; permission: BrowserOwnedPermissionDto | null;
  addressDirty: boolean; addressRevision: number; commandPending: boolean; closing: boolean; cleaned: boolean; cleanupFailed: boolean;
  refresh(): void;
  page: BrowserOwnedPageDto | null; accept(page: BrowserOwnedPageDto): void;
  acceptPermission(permission: BrowserOwnedPermissionDto): void;
}
export interface ManualBrowserTabHandle { close(): Promise<boolean> }

/** Main owns the active conversation, permission decisions and guest. DTOs are presentation only. */
export function ManualBrowserTab({ sessionId, workspaceId, tabId, active = true, onClose, ref }: { sessionId?: string; workspaceId?: string; tabId?: string; active?: boolean; onClose(): void; ref?: Ref<ManualBrowserTabHandle> }) {
  const ownerSessionId = workspaceId ? undefined : sessionId;
  const ownerKey = workspaceId && tabId ? workspaceId : ownerSessionId;
  const { t } = useTranslation();
  const [address, setAddress] = useState("");
  const [agentSites, setAgentSites] = useState(""), [agentResources, setAgentResources] = useState("");
  const [commandPending, setCommandPending] = useState(false), [closing, setClosing] = useState(false);
  const [stateFailure, setStateFailure] = useState(false), [stateBusy, setStateBusy] = useState(false);
  const [available, setAvailable] = useState(false), [checked, setChecked] = useState(false);
  const [permission, setPermission] = useState<BrowserOwnedPermissionDto | null>(null);
  const [permissionBusy, setPermissionBusy] = useState(false);
  const [page, setPage] = useState<BrowserPageState>(() => emptyPage(ownerSessionId, workspaceId, tabId));
  const [selectedResources, setSelectedResources] = useState<{ browserId: string; requestId: number; hosts: string[] }>({ browserId: "", requestId: 0, hosts: [] });
  const [scopeReloaded, setScopeReloaded] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const viewport = useRef<HTMLDivElement>(null), scopeRef = useRef<Scope | null>(null);
  // Window tabs on ordinary browsing get the tools (menu, find, downloads, settings). The native page stays detached while one covers it.
  const chrome = useBrowserChrome({ tabId: workspaceId && tabId ? tabId : undefined,
    enabled: active && permission?.status === "granted" && permission.scope.mode === "manual" && permission.scope.web === true,
    pageLoaded: !!page.url && !page.closed, navigate: url => { setAddress(url); navigate(url); },
    reload: () => { const id = scopeRef.current?.page?.browserId; if (id) void command({ kind: "history", browserId: id, action: "reload" }); } });
  const overlayOpen = chrome.overlayOpen;
  useEffect(() => {
    const workspace = window.manualBrowserWorkspace;
    const api: ViewApi | undefined = workspaceId && tabId ? workspace && {
      getAvailability: () => workspace.getAvailability(), getPermission: () => workspace.getPermission(tabId),
      requestPermission: proposal => workspace.requestPermission(proposal, tabId),
      revokePermission: () => workspace.revokePermission(workspaceId, tabId),
      execute: input => workspace.execute(input, tabId), onChanged: callback => workspace.onChanged(callback),
    } : window.manualBrowser;
    const scope: Scope = {
      sessionId: ownerSessionId, workspaceId, tabId, ownerKey, api, disposed: false, closed: false, opening: false, commandRevision: 0, permissionRevision: 0, preserveAddress: false, permissionBusy: false, permission: null, page: null,
      addressDirty: false, addressRevision: 0, commandPending: false, closing: false, cleaned: false, cleanupFailed: false, refresh() {},
      acceptPermission(dto) {
        if (scope.disposed || scope.closed || !belongs(scope, dto)) return;
        scope.permission = dto; setPermission(dto);
      },
      accept(dto) {
        if (scope.disposed || scope.closed || !scope.ownerKey || !belongs(scope, dto)) return;
        const current = scope.page;
        // Main filters expired owner generations. Within a page, requests are monotonic and close is terminal.
        // A new Main page may follow the previous page's close; a late get never displaces a newer event.
        if (current && (dto.browserId === current.browserId
          ? dto.requestId < current.requestId || (current.closed && !dto.closed)
          : !current.closed)) return;
        scope.page = dto;
        if (!dto.closed && !dto.loading && dto.url && !dto.error) rememberVisitedSite(dto.url);
        if (dto.closed && scope.permission?.scope.mode === "manual") {
          setPage(emptyPage(scope.sessionId, scope.workspaceId, scope.tabId));
        } else setPage({ ...dto, error: dto.error === null ? null : dto.error === "blocked_url" || dto.error === "network_unavailable" ? "blocked" : "load_failed" });
        if (dto.error === "cleanup_failed") { failCleanup(scope); return; }
        setFailure(dto.error);
        if (!dto.closed && !dto.loading && dto.url && !scope.permissionBusy && !scope.preserveAddress && !scope.addressDirty && !scope.commandPending) setAddress(dto.url);
      },
    };
    scopeRef.current = scope; setAvailable(false); setChecked(false); setAddress(""); setAgentSites(""); setAgentResources(""); setFailure(null); setPermission(null); setPermissionBusy(false); setSelectedResources({ browserId: "", requestId: 0, hosts: [] }); setScopeReloaded(false);
    setPage(emptyPage(ownerSessionId, workspaceId, tabId));
    setCommandPending(false); setClosing(false); setStateFailure(false); setStateBusy(false);
    const readPermission = (includePage = false) => {
      if (!api || scope.disposed || scope.closed || scope.permissionBusy) return;
      const revision = ++scope.permissionRevision;
      const isCurrent = () => !scope.disposed && !scope.closed && scope.permissionRevision === revision && !scope.permissionBusy;
      setStateBusy(true);
      void Promise.all([api.getPermission(), includePage ? api.execute({ kind: "get" }) : Promise.resolve(null)]).then(([reply, pageReply]) => {
        if (!isCurrent()) return;
        if (!reply.ok || !belongs(scope, reply.value) || (pageReply && !pageReply.ok)) throw new Error("state unavailable");
        scope.acceptPermission(reply.value);
        if (pageReply?.ok && pageReply.value && !scope.page) scope.accept(pageReply.value);
        setStateFailure(false);
      }).catch(() => { if (isCurrent()) setStateFailure(true); })
        .finally(() => { if (isCurrent()) setStateBusy(false); });
    };
    scope.refresh = () => readPermission(true);
    const off = api?.onChanged?.(dto => {
      scope.accept(dto);
      if (belongs(scope, dto) && !scope.disposed && !scope.closed && !scope.permissionBusy) {
        readPermission();
      }
    });
    void Promise.resolve().then(() => api?.getAvailability()).catch(() => undefined).then(result => {
      if (scope.disposed) return;
      const ready = result?.available === true && !!api?.execute && !!api?.onChanged && !!api?.getPermission && !!api?.requestPermission && !!api?.revokePermission;
      setAvailable(ready); setChecked(true);
      if (!ready || !ownerKey) return;
      readPermission(true);
    });
    return () => {
      scope.disposed = true; scope.commandRevision++; scope.permissionRevision++; off?.();
      if (scopeRef.current === scope) scopeRef.current = null;
      if (!scope.cleaned && !scope.cleanupFailed) queueMicrotask(() => {
        // StrictMode replaces this scope immediately. A real unmount revokes only its own session.
        if (scopeRef.current?.ownerKey === scope.ownerKey && scopeRef.current?.tabId === scope.tabId) return;
        // Main revoke cancels consent and awaits all owned pages; never race it with another close.
        if (scope.ownerKey) void api?.revokePermission(scope.sessionId).catch(() => {});
      });
    };
  }, [ownerSessionId, workspaceId, tabId]);

  function failCleanup(scope: Scope) {
    // Main caches failed native cleanup. A second revoke cannot recover this scope.
    scope.cleanupFailed = true; scope.closed = true; scope.commandRevision++; scope.permissionRevision++;
    scope.commandPending = false; scope.permissionBusy = false; scope.opening = false;
    setCommandPending(false); setPermissionBusy(false); setStateBusy(false);
    setPage(current => ({ ...current, closed: true, loading: false }));
    setFailure("cleanup_failed");
  }
  function clearManualPage(scope: Scope) {
    // Main clears the native session/history before showing new-scope consent.
    // Keep a closed tombstone so late events from the previous page cannot revive it.
    if (scope.page) scope.page = { ...scope.page, closed: true, loading: false, canGoBack: false, canGoForward: false };
    setPage(emptyPage(scope.sessionId, scope.workspaceId, scope.tabId));
    setSelectedResources({ browserId: "", requestId: 0, hosts: [] });
  }
  async function recoverPermission(scope: Scope, isCurrent: () => boolean, code: string) {
    // A rejected scope can fail before or after Main closes the previous page.
    // Recover the real state; never turn an old presentation DTO into authority.
    try {
      const [permissionReply, pageReply] = await Promise.all([scope.api!.getPermission(), scope.api!.execute({ kind: "get" })]);
      if (!isCurrent()) return;
      if (!permissionReply.ok || !pageReply.ok) throw new Error("recovery unavailable");
      scope.acceptPermission(permissionReply.value);
      scope.page = null;
      if (pageReply.value) scope.accept(pageReply.value);
      else setPage(emptyPage(scope.sessionId, scope.workspaceId, scope.tabId));
    } catch {
      if (!isCurrent()) return;
      const revoked = await scope.api!.revokePermission(scope.sessionId).catch(() => null);
      if (!isCurrent()) return;
      if (revoked?.ok) { scope.acceptPermission(revoked.value); clearManualPage(scope); }
      else { failCleanup(scope); return; }
    }
    if (isCurrent()) setFailure(code);
  }
  async function changePermission(revoke = false, requested?: BrowserPermissionScope) {
    const scope = scopeRef.current;
    if (!scope?.api || !scope.ownerKey || scope.disposed || scope.closed || !available || (!revoke && scope.permissionBusy)) return;
    const revision = ++scope.permissionRevision;
    scope.commandRevision++; scope.commandPending = false; setCommandPending(false); setStateBusy(false);
    scope.permissionBusy = true; scope.opening = false; setPermissionBusy(true); setFailure(null);
    if (scope.permission?.scope.mode === "manual") clearManualPage(scope);
    const isCurrent = () => !scope.disposed && !scope.closed && scope.permissionRevision === revision;
    try {
      const reply = await (revoke ? scope.api.revokePermission(scope.sessionId) : scope.api.requestPermission(requested ?? scope.permission!.scope));
      if (!isCurrent()) return;
      if (reply.ok) {
        scope.acceptPermission(reply.value);
        if (belongs(scope, reply.value) && reply.value.status === "granted" && scope.page?.closed) {
          scope.page = null; setPage(emptyPage(scope.sessionId, scope.workspaceId, scope.tabId));
        }
      } else await recoverPermission(scope, isCurrent, reply.code);
    } catch { if (isCurrent()) await recoverPermission(scope, isCurrent, "permission_denied"); }
    finally { if (isCurrent()) { scope.permissionBusy = false; setPermissionBusy(false); } }
  }
  function authorizeAgentSites() {
    const current = scopeRef.current?.permission;
    if (!current?.agentSiteSelection || !current.agentScope || workspaceId) return;
    const split = (value: string) => [...new Set(value.split(/[\s,]+/).filter(Boolean))];
    void changePermission(false, { mode: "agent", site: true, hosts: split(agentSites), resourceHosts: split(agentResources), actions: current.agentScope.actions });
  }
  function rejectAddress(scope: Scope) {
    scope.commandRevision++; scope.commandPending = false; setCommandPending(false);
    if (scope.permissionBusy || scope.opening || scope.permission?.status === "pending") {
      const revision = ++scope.permissionRevision;
      scope.permissionBusy = false; scope.opening = false; setPermissionBusy(false);
      if (scope.permission) scope.acceptPermission({ ...scope.permission, status: "required", requestId: null });
      void scope.api?.revokePermission(scope.sessionId).then(reply => {
        if (reply.ok && scope.permissionRevision === revision) scope.acceptPermission(reply.value);
      }).catch(() => {});
    }
    setFailure("blocked_url"); setPage(current => ({ ...current, loading: false, error: "blocked" }));
  }
  async function proposeSite(url: string, requested?: BrowserPermissionScope, preserveAddress = false) {
    const scope = scopeRef.current;
    if (!scope?.api || !scope.ownerKey || scope.disposed || scope.closed || !available || scope.permission?.scope.mode !== "manual") return;
    // Syntax for a proposal only. Main remains the network/security authority for public and private targets.
    const target = manualBrowserTarget(url);
    if (!target) { rejectAddress(scope); return; }
    const addressRevision = scope.addressRevision;
    // The window workspace browses the public web as one ordinary grant; only private networks name an authority.
    const proposal: BrowserPermissionScope = requested ?? (target.network === "public" && scope.workspaceId
      ? { mode: "manual", web: true, hosts: [], resourceHosts: [], actions: ["navigate"] }
      : { mode: "manual", hosts: [target.key], resourceHosts: [], actions: ["navigate"] });
    const revision = ++scope.permissionRevision;
    scope.commandRevision++; scope.commandPending = false; setCommandPending(false); setStateBusy(false); scope.opening = false; scope.permissionBusy = true;
    setPermissionBusy(true); setFailure(null); setScopeReloaded(false);
    if (!preserveAddress) setAddress(url);
    clearManualPage(scope);
    scope.acceptPermission({ ...scope.permission, status: "pending", scope: proposal, requestId: null });
    const isCurrent = () => !scope.disposed && !scope.closed && scope.permissionRevision === revision;
    try {
      const reply = await scope.api.requestPermission(proposal);
      if (!isCurrent()) return;
      if (!reply.ok) { await recoverPermission(scope, isCurrent, reply.code); return; }
      if (!belongs(scope, reply.value)) return;
      scope.acceptPermission(reply.value);
      if (reply.value.status !== "granted") return;
      scope.page = null; scope.permissionBusy = false; setPermissionBusy(false);
      if (preserveAddress) setScopeReloaded(true);
      await command({ kind: "open", url }, preserveAddress || scope.addressRevision !== addressRevision);
    } catch { if (isCurrent()) await recoverPermission(scope, isCurrent, "permission_denied"); }
    finally { if (isCurrent()) { scope.permissionBusy = false; setPermissionBusy(false); } }
  }
  function navigate(typed: string) {
    const url = resolveAddressInput(typed);
    const scope = scopeRef.current;
    if (scope?.permission?.scope.mode === "manual") {
      const target = manualBrowserTarget(url);
      if (!target) { rejectAddress(scope); return; }
      const covered = scope.permission.scope.hosts.includes(target.key) || (target.network === "public" && scope.permission.scope.web === true);
      if (scope.permissionBusy || scope.permission.status !== "granted" || !covered) {
        void proposeSite(url); return;
      }
    }
    void command(scope?.page && !scope.page.closed ? { kind: "navigate", browserId: scope.page.browserId, url } : { kind: "open", url });
  }
  function approveResources() {
    const scope = scopeRef.current, current = scope?.page, grant = scope?.permission;
    if (!scope || !current || current.closed || current.loading || scope.permissionBusy || grant?.status !== "granted" || grant.scope.mode !== "manual") return;
    const chosen = selectedResources.browserId === current.browserId && selectedResources.requestId === current.requestId
      ? selectedResources.hosts.filter(host => current.blockedResourceHosts?.includes(host)) : [];
    if (!chosen.length || !current.url) return;
    void proposeSite(current.url, { mode: grant.scope.mode, hosts: grant.scope.hosts, actions: grant.scope.actions,
      resourceHosts: [...new Set([...(grant.scope.resourceHosts ?? []), ...chosen])], sourceBrowserId: current.browserId, sourceRequestId: current.requestId }, true);
  }
  async function command(input: ManualBrowserCommand, preserveAddress = false) {
    const scope = scopeRef.current;
    if (!scope?.api || scope.disposed || scope.closed || !available || !scope.ownerKey || scope.permissionBusy || scope.permission?.status !== "granted") return;
    if (input.kind === "open") { if (scope.opening) return; scope.opening = true; }
    // Responses can settle out of order. Only the latest manual command may
    // change presentation, including failures that do not carry a Main request ID.
    // https://react.dev/reference/react/useEffect#fetching-data-with-effects
    const revision = ++scope.commandRevision;
    scope.preserveAddress = preserveAddress;
    if (!preserveAddress && input.kind !== "stop") scope.addressDirty = false;
    scope.commandPending = true; setCommandPending(true); setFailure(null);
    const isCurrent = () => !scope.disposed && !scope.closed && scope.commandRevision === revision;
    try {
      const reply = await scope.api.execute(input);
      if (isCurrent()) { scope.commandPending = false; setCommandPending(false); }
      if (reply.ok && reply.value) {
        if ((scope.disposed || scope.closed) && !reply.value.closed) {
          void scope.api.execute({ kind: "close", browserId: reply.value.browserId }).catch(() => {});
        } else if (isCurrent()) scope.accept(reply.value);
      } else if (!reply.ok && isCurrent()) {
        if (reply.code === "cleanup_failed") { failCleanup(scope); return; }
        setFailure(reply.code); setPage(current => ({ ...current, loading: false, error: reply.code === "blocked_url" ? "blocked" : "load_failed" }));
      }
    } catch { if (isCurrent()) { setFailure("load_failed"); setPage(current => ({ ...current, loading: false, error: "load_failed" })); } }
    finally { if (isCurrent()) { scope.commandPending = false; setCommandPending(false); scope.preserveAddress = false; if (input.kind === "open") scope.opening = false; } }
  }
  useEffect(() => {
    const scope = scopeRef.current, node = viewport.current, id = page.browserId;
    if (!scope?.api || !id || page.closed) return;
    const layout = () => {
      if (scope.disposed) return;
      const rect = node?.getBoundingClientRect();
      const bounds = active && !overlayOpen && !scope.closed && !scope.permissionBusy && scope.permission?.status === "granted" && !stateFailure && document.visibilityState !== "hidden" && rect && rect.width > 0 && rect.height > 0
        ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height } : null;
      void scope.api!.execute({ kind: "layout", browserId: id, bounds }).catch(() => {});
    };
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(layout) : undefined;
    if (node) { observer?.observe(node); if (node.parentElement) observer?.observe(node.parentElement); }
    window.addEventListener("resize", layout); window.addEventListener("focus", layout); document.addEventListener("visibilitychange", layout);
    layout();
    return () => {
      observer?.disconnect(); window.removeEventListener("resize", layout); window.removeEventListener("focus", layout); document.removeEventListener("visibilitychange", layout);
      if (!scope.disposed && !scope.closed) void scope.api!.execute({ kind: "layout", browserId: id, bounds: null }).catch(() => {});
    };
  }, [page.browserId, page.closed, page.loading, page.error, active, overlayOpen, permission?.status, permissionBusy, stateFailure]);
  async function close(): Promise<boolean> {
    const scope = scopeRef.current;
    if (!scope || scope.cleaned) { onClose(); return true; }
    if (scope.closing || scope.cleanupFailed) return false;
    scope.closed = true; scope.closing = true; scope.commandRevision++; scope.permissionRevision++;
    scope.commandPending = false; setCommandPending(false); setClosing(true); setFailure(null);
    setPage(current => ({ ...current, closed: true, loading: false }));
    if (scope.page && !scope.page.closed) void scope.api?.execute({ kind: "layout", browserId: scope.page.browserId, bounds: null }).catch(() => {});
    try {
      // Main's revoke clears the grant, cancels pending consent and awaits cleanup
      // of every owned page. A second simultaneous close would only race that cleanup.
      if (scope.api?.revokePermission && scope.ownerKey) {
        const reply = await scope.api.revokePermission(scope.sessionId);
        if (!reply.ok) throw new Error(reply.code);
      }
      scope.cleaned = true;
      if (!scope.disposed) onClose();
      return true;
    } catch { if (!scope.disposed) failCleanup(scope); return false; }
    finally { scope.closing = false; if (!scope.disposed) setClosing(false); }
  }
  useImperativeHandle(ref, () => ({ close }));
  function editAddress(value: string) {
    const scope = scopeRef.current;
    if (scope) { scope.addressDirty = true; scope.addressRevision++; }
    setAddress(value);
  }
  function resetAddress() {
    const scope = scopeRef.current;
    if (scope) { scope.addressDirty = false; scope.addressRevision++; setAddress(scope.page?.url ?? ""); }
  }
  const granted = permission?.status === "granted";
  const manual = permission?.scope.mode === "manual";
  const candidates = manual && !scopeRef.current?.page?.closed ? scopeRef.current?.page?.blockedResourceHosts ?? [] : [];
  const selected = selectedResources.browserId === page.browserId && selectedResources.requestId === page.requestId ? selectedResources.hosts.filter(host => candidates.includes(host)) : [];
  const blockedNavigationUrl = manual && !scopeRef.current?.page?.closed ? scopeRef.current?.page?.blockedNavigationUrl : undefined;
  // The window browser behaves like an ordinary browser: the public web needs no consent panel at all.
  // Only a private-network grant, a pending or failed request, or an actionable block earns screen space.
  const compact = !!workspaceId && manual;
  const localHost = compact ? permission?.scope.hosts.find(host => parseLocalAuthority(host) !== null) : undefined;
  const attention = !compact || !!localHost || permission?.status === "pending" || permission?.status === "denied" || permissionBusy
    || failure === "permission_denied" || failure === "cancelled" || failure === "cleanup_failed" || scopeReloaded
    || !!candidates.length || !!blockedNavigationUrl;
  const labels: BrowserWorkspaceLabels = {
    panel: t("browserWorkspace.title"), address: t("browserWorkspace.address"), go: t("browserWorkspace.go"),
    back: t("browserWorkspace.back"), forward: t("browserWorkspace.forward"), reload: t("browserWorkspace.reload"), stop: t("browserWorkspace.stop"), close: t("browserWorkspace.close"),
    loading: t("browserWorkspace.loading"), blocked: t(available ? "browserWorkspace.blocked" : checked ? "browserWorkspace.unavailable" : "browserWorkspace.checking"),
    loadFailed: t(failure === "restricted_address" ? "browserWorkspace.restrictedAddress" : failure === "dns_failed" ? "browserWorkspace.dnsFailed" : failure === "dns_timeout" ? "browserWorkspace.dnsTimeout" : failure === "connection_failed" ? "browserWorkspace.connectionFailed" : "browserWorkspace.loadFailed"), closed: t(closing ? "browserWorkspace.closing" : failure === "cleanup_failed" ? "browserWorkspace.cleanupFailed" : "browserWorkspace.closed"),
    committedUrl: t("browserWorkspace.currentPage"), addressHint: t("browserWorkspace.addressHint"), addressPlaceholder: t("browserWorkspace.addressPlaceholder"),
    viewport: t("browserWorkspace.viewport"), empty: t(ownerKey ? "browserWorkspace.ready" : "browserWorkspace.sessionRequired"),
  };
  return <div className="ff-browser-tab">
    {available && ownerKey && (!permission || stateFailure) && <div className="ff-browser-workspace__state" role={stateFailure ? "alert" : "status"}>
      <p>{t(stateFailure ? "browserWorkspace.stateUnavailable" : "browserWorkspace.checking")}</p>
      {stateFailure && <button type="button" data-browser-retry-state disabled={stateBusy} onClick={() => scopeRef.current?.refresh()}>{t("browserWorkspace.retryState")}</button>}
    </div>}
    {available && ownerKey && permission && !scopeRef.current?.closed && attention && <section className={`ff-browser-permission${compact ? " ff-browser-permission--compact" : ""}`} aria-label={t("browserWorkspace.permission")}>
      {compact ? localHost && <div className="ff-browser-chip">
        <span className="ff-browser-permission__mode">{t("browserWorkspace.localBadge")}</span><code>{localHost}</code>
        {!!permission?.scope.resourceHosts?.length && <span className="ff-browser-chip__extra">+{permission.scope.resourceHosts.length}</span>}
      </div> : <details open={!granted}>
        <summary><span className="ff-browser-permission__mode">{t(manual ? "browserWorkspace.manualMode" : "browserWorkspace.agentMode")}</span>{t(granted ? "browserWorkspace.permissionGranted" : "browserWorkspace.permissionRequired")}</summary>
        <p>{t(manual ? "browserWorkspace.manualScope" : "browserWorkspace.permissionScope")}</p>
        <p className="ff-browser-permission__scope">{permission?.scope.hosts.join(", ")}<br />{permission?.scope.actions.join(", ")}</p>
        {manual && !!permission?.scope.resourceHosts?.length && <p className="ff-browser-permission__scope">
          {t("browserWorkspace.approvedResources")} {permission.scope.resourceHosts.join(", ")}
        </p>}
        {manual && <p>{t("browserWorkspace.manualLimits")}</p>}
        {!manual && permission?.scope.mode === "agent" && <p>{t("browserWorkspace.agentScope")}</p>}
      </details>}
      {permission?.status === "denied" && <p role="status">{t("browserWorkspace.permissionDenied")}</p>}
      {(failure === "permission_denied" || failure === "cancelled") && <p role="alert">{t(manual ? "browserWorkspace.permissionRequestFailed" : "browserWorkspace.permissionFailed")}</p>}
      {(granted || permissionBusy || permission?.status === "pending" || !manual) && <button type="button" data-browser-enable={!granted && !permissionBusy || undefined} data-browser-revoke={granted || permissionBusy || permission?.status === "pending" || undefined}
        data-browser-manual={!manual && granted && !!permission?.agentScope || undefined}
        disabled={!manual && (permissionBusy || permission?.status === "pending")} onClick={() => void changePermission(granted || permissionBusy || permission?.status === "pending")}>
        {t(manual && (permissionBusy || permission?.status === "pending") ? "browserWorkspace.cancelPermission" : permissionBusy || permission?.status === "pending" ? "browserWorkspace.permissionPending" : granted ? !manual && permission?.agentScope ? "browserWorkspace.switchToManual" : "browserWorkspace.revoke" : "browserWorkspace.enable")}
      </button>}
      {!workspaceId && permission?.agentSiteSelection && <details className="ff-browser-agent-consent">
        <summary>{t("browserWorkspace.agentChooseSites")}</summary>
        <p>{t("browserWorkspace.agentExactSitesHelp")}</p>
        <label>{t("browserWorkspace.agentSites")}<textarea data-browser-agent-sites value={agentSites} onChange={event => setAgentSites(event.currentTarget.value)} /></label>
        <label>{t("browserWorkspace.agentResources")}<textarea data-browser-agent-resources value={agentResources} onChange={event => setAgentResources(event.currentTarget.value)} /></label>
        {!!scopeRef.current?.page?.blockedResourceHosts?.length && <p>{t("browserWorkspace.blockedResources")}: {scopeRef.current.page.blockedResourceHosts.join(", ")}</p>}
        <button type="button" data-browser-authorize-agent-sites disabled={permissionBusy || !agentSites.trim() || failure === "cleanup_failed"}
          onClick={authorizeAgentSites}>{t("browserWorkspace.authorizeAgent")}</button>
      </details>}
      {manual && permission?.agentScope && <details className="ff-browser-agent-consent">
        <summary>{t("browserWorkspace.separateAgent")}</summary>
        <p>{t("browserWorkspace.agentScope")}</p>
        <p className="ff-browser-permission__scope">{permission.agentScope.hosts.join(", ")}<br />{permission.agentScope.actions.join(", ")}</p>
        <button type="button" data-browser-authorize-agent disabled={permissionBusy || permission.status === "pending" || !!scopeRef.current?.closed || failure === "cleanup_failed"}
          onClick={() => void changePermission(false, permission.agentScope)}>{t("browserWorkspace.authorizeAgent")}</button>
      </details>}
      {manual && (permissionBusy || permission?.status === "pending") && <p role="status">{t("browserWorkspace.permissionPending")}</p>}
      {manual && !scopeRef.current?.page?.closed && scopeRef.current?.page?.blockedRequest && <p className="ff-browser-workspace__notice is-error" role="status">{t("browserWorkspace.blockedRequest")}</p>}
      {manual && failure === "cleanup_failed" && <p role="alert">{t("browserWorkspace.cleanupFailed")}</p>}
      {scopeReloaded && <p role="status">{t("browserWorkspace.scopeReloaded")}</p>}
      {!!candidates.length && <fieldset className="ff-browser-resource-consent" disabled={permissionBusy || !granted || page.loading}>
        <legend>{t("browserWorkspace.blockedResources")}</legend>
        <p>{t("browserWorkspace.resourceScope")}</p>
        {candidates.map(host => <label key={host}>
          <input type="checkbox" checked={selected.includes(host)} onChange={event => {
            const next = event.currentTarget.checked ? [...selected, host] : selected.filter(value => value !== host);
            setSelectedResources({ browserId: page.browserId, requestId: page.requestId, hosts: next });
          }} />{host}
        </label>)}
        <button type="button" data-browser-authorize-resources disabled={permissionBusy || !granted || page.loading || !selected.length} onClick={approveResources}>
          {t("browserWorkspace.authorizeResources")}
        </button>
      </fieldset>}
      {blockedNavigationUrl && <div className="ff-browser-site-consent">
        <p>{t("browserWorkspace.blockedNavigation")} {blockedNavigationUrl}</p>
        <button type="button" data-browser-authorize-site disabled={permissionBusy} onClick={() => void proposeSite(blockedNavigationUrl)}>
          {t("browserWorkspace.authorizeSite")}
        </button>
      </div>}
    </section>}
    <BrowserWorkspacePanel page={!available ? { ...page, error: "blocked" } : page}
      address={address} labels={labels} navigationAvailable={available && granted && !permissionBusy && !stateFailure && !!ownerKey && !page.closed}
      addressAvailable={manual ? available && !!ownerKey && !scopeRef.current?.closed && !stateFailure && failure !== "cleanup_failed" : undefined}
      emptyContent={<BrowserNewTab available={available && !!ownerKey && !stateFailure} onOpen={url => { setAddress(url); navigate(url); }} />}
      viewportRef={viewport} onAddressChange={editAddress} onAddressReset={resetAddress} onNavigate={navigate}
      toolbarEnd={chrome.toolbarEnd} belowToolbar={chrome.belowToolbar} overlay={chrome.overlay} snapshot={chrome.snapshot}
      commandPending={commandPending} closeAvailable={!closing && !scopeRef.current?.cleanupFailed && !page.closed}
      onCommand={action => { const id = scopeRef.current?.page?.browserId; if (id) void command(action === "stop" ? { kind: "stop", browserId: id } : { kind: "history", browserId: id, action }); }} onClose={() => { void close(); }} />
  </div>;
}
