import type { View } from "electron";
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { isPublicNetworkAddress, parseConnectAuthority } from "./public-network-target";
import { localAuthorityFromUrl, localAuthorityKey, parseLocalAuthority, parseLocalBrowserUrl, sameLocalHost } from "../../shared/local-network-target";
import { createBrowserAuthorizationDomainRegistry } from "./browser-authorization-domain";
import { createBrowserNetworkController, type BrowserNetworkBinding, type BrowserNetworkReply } from "./browser-network-binding";
import { isAccountPath } from "../../shared/browser-account-policy";
import type { BrowserConnectionError } from "../../shared/manual-browser";
import type { ProxyChallenge } from "./authenticated-connect-proxy";
import type { BrowserDomainContext } from "./browser-authorization-domain";
import type { BrowserGuestTools } from "./browser-guest-tools";
import type { DownloadItemLike } from "./browser-downloads";
import type { BrowserToolErrorCode, BrowserToolReply } from "../../shared/browser-tools";
import type { BrowserNetworkDependencies, BrowserViewPort } from "./browser-network-binding";
export interface BrowserHostPort {
  webContents: { id: number; mainFrame: object; isDestroyed(): boolean; on(event: string, listener: () => void): unknown; removeListener(event: string, listener: () => void): unknown };
  isDestroyed(): boolean; isVisible(): boolean; isFocused(): boolean; getContentSize(): number[]; contentView: Pick<View, "addChildView" | "removeChildView">;
  on(event: string, listener: () => void): unknown; removeListener(event: string, listener: () => void): unknown;
}
export interface TrustedBrowserOwner { readonly host: BrowserHostPort; readonly topFrame: object; readonly profile: object; readonly conversationId: string | null; readonly workspaceId?: string; readonly ownerSessionId: string; readonly generation: number; readonly signal: AbortSignal }
import type { BrowserBounds, BrowserErrorCode, BrowserOwnedPageDto as BrowserPageDto, BrowserReply, ManualBrowserCommand, BrowserPermissionScope, BrowserOwnedPermissionDto as BrowserPermissionDto, BrowserAction, BrowserDomInput, BrowserObservation, BrowserWorkspaceCommand } from "../../shared/manual-browser";
export type { BrowserBounds, BrowserErrorCode, BrowserOwnedPageDto as BrowserPageDto, BrowserReply, ManualBrowserCommand } from "../../shared/manual-browser";
export interface TrustedBrowserRun { readonly conversationId: string; readonly runId: string; readonly signal: AbortSignal; isCurrent(): boolean }
export interface BrowserInvokeEvent { sender: BrowserHostPort["webContents"]; senderFrame: object | null }
export interface BrowserGuestPort<S extends object> extends BrowserViewPort<S> {
  loadURL(url: string): Promise<void>; history(action: "back" | "forward" | "reload"): Promise<void>;
  observe?(hosts?: readonly string[]): Promise<BrowserObservation>; act?(input: BrowserDomInput): Promise<boolean>;
  /** Window-browser tools (find, zoom, print...). Offered only for an ordinary-browsing tab; see `useTab`. */
  tools?: BrowserGuestTools;
  snapshot(): { url: string; canGoBack: boolean; canGoForward: boolean };
  stop(): void; attach(host: BrowserHostPort): void; detach(): void; setBounds(bounds: BrowserBounds): void;
  installCallbacks(callbacks: { allowsNavigation(url: string): boolean; started(url: string, redirect?: boolean): void; changed(): void; failed(code?: number, url?: string): void; destroyed(): void }): void;
}
export interface BrowserServiceOptions<S extends object> extends Omit<BrowserNetworkDependencies<S>, "createView" | "onDownload"> {
  profile: object; gateOpen?: boolean;
  /** Main composition only. Manual site grants never authorize agent operations. */
  manualBrowsing?: boolean;
  /** Explicit composition capability; legacy grants remain bounded by permissionPolicy. */
  agentSiteSelection?: boolean;
  permissionPolicy?: BrowserPermissionScope;
  /** Main-owned native confirmation; never provided by renderer or a tool. */
  confirmPermission?(owner: TrustedBrowserOwner, scope: BrowserPermissionScope, signal: AbortSignal): Promise<boolean>;
  createView(session: S): BrowserGuestPort<S>; onChanged?(owner: TrustedBrowserOwner, page: BrowserPageDto): void;
  /** Main composition only. Asked once per download, and only for an ordinary-browsing (`web`) manual page that is still current. */
  acceptDownload?(owner: TrustedBrowserOwner, item: DownloadItemLike): boolean;
}
/** What a window-browser tool may touch: the tab's guest tools and its window, nothing else. */
export interface BrowserToolTarget { readonly key: object; readonly tools: BrowserGuestTools; readonly host: BrowserHostPort; readonly url: string }
export function validatePublicBrowserUrl(input: unknown): string | null {
  if (typeof input !== "string" || input.length === 0 || input.length > 8192) return null;
  try {
    const url = new URL(input);
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return null;
    const authority = parseConnectAuthority(`${url.hostname}:443`);
    return authority && (!isIP(authority.host) || isPublicNetworkAddress(authority.host)) ? url.href : null;
  } catch { return null; }
}
function parseCommand(value: unknown): ManualBrowserCommand | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.kind === "get") return { kind: "get" };
  if (v.kind === "open") return typeof v.url === "string" ? { kind: "open", url: v.url } : null;
  if (typeof v.browserId !== "string" || !v.browserId || v.browserId.length > 128) return null;
  if (v.kind === "close" || v.kind === "stop") return { kind: v.kind, browserId: v.browserId };
  if (v.kind === "navigate") return typeof v.url === "string" ? { kind: "navigate", browserId: v.browserId, url: v.url } : null;
  if (v.kind === "history" && ["back", "forward", "reload"].includes(String(v.action))) return { kind: "history", browserId: v.browserId, action: v.action as "back" | "forward" | "reload" };
  if (v.kind === "layout") {
    if (v.bounds === null) return { kind: "layout", browserId: v.browserId, bounds: null };
    if (!v.bounds || typeof v.bounds !== "object") return null;
    const b = v.bounds as Record<string, unknown>;
    if (![b.x, b.y, b.width, b.height].every(n => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 1_000_000)
      || (b.width as number) < 0 || (b.height as number) < 0) return null;
    return { kind: "layout", browserId: v.browserId, bounds: { x: b.x as number, y: b.y as number, width: b.width as number, height: b.height as number } };
  }
  return null;
}
const fail = (code: BrowserErrorCode): BrowserReply<never> => ({ ok: false, code });

/** Main-only owner registry and manual controller. No renderer payload creates an owner/epoch. */
export function createBrowserService<S extends object>(options: BrowserServiceOptions<S>) {
  type Host = { host: BrowserHostPort; resolveOwner(event: BrowserInvokeEvent): TrustedBrowserOwner | null; current?: Owner; transitioning: boolean; lastGeneration: number; detach(): void; overlay: boolean; visible: boolean; focused: boolean };
  type PendingPermission = { id: string; scope: BrowserPermissionScope; cancel: AbortController; promise: Promise<BrowserReply<BrowserPermissionDto>> };
  type Owner = { agentBusy?: boolean; grant?: BrowserPermissionScope; pending?: PendingPermission; denied?: boolean; value: TrustedBrowserOwner; host: Host; event: BrowserInvokeEvent; retired: boolean; cells: Set<Cell> };
  type Cell = { connectionFailure?: BrowserConnectionError | "load_failed"; attached: boolean; presentationRevision: number; observation?: { value: BrowserObservation; requestId: number; runId: string }; owner: Owner; context: BrowserDomainContext; abort: AbortController; page: BrowserPageDto; preparing?: Promise<BrowserNetworkReply<BrowserNetworkBinding<S>>>; binding?: BrowserNetworkBinding<S>; guest?: BrowserGuestPort<S>; navigation?: AbortController; manualRequestId?: number; closing: boolean; failed: boolean; cleanup?: Promise<BrowserReply<null>>; onAbort(): void };
  const hosts = new Map<BrowserHostPort, Host>(), owners = new WeakMap<TrustedBrowserOwner, Owner>(), retired = new WeakSet<TrustedBrowserOwner>();
  const cells = new Map<string, Cell>(), guests = new WeakMap<S, BrowserGuestPort<S>>(), byContents = new WeakMap<object, Cell>();
  const registered = new WeakSet<object>();
  const gateOpen = options.gateOpen === true;
  const manualBrowsing = options.manualBrowsing === true && !!options.confirmPermission;
  const agentPolicy: BrowserPermissionScope | undefined = options.permissionPolicy && options.confirmPermission
    ? Object.freeze({ mode: "agent", hosts: Object.freeze([...options.permissionPolicy.hosts]), actions: Object.freeze([...options.permissionPolicy.actions]) }) : undefined;
  const policy: BrowserPermissionScope | undefined = manualBrowsing
    ? Object.freeze({ mode: "manual", hosts: Object.freeze([]), resourceHosts: Object.freeze([]), actions: Object.freeze(["navigate"] as BrowserAction[]) })
    : agentPolicy;
  function clearPermission(owner: Owner): void {
    owner.grant = undefined; owner.denied = false;
    const pending = owner.pending; owner.pending = undefined; pending?.cancel.abort();
  }
  function permits(owner: Owner, action: BrowserAction): boolean { return gateOpen || owner.grant?.actions.includes(action) === true; }
  /** Private-network grants are manual-only, name one exact host:port, and are never an Agent scope. */
  function localGrant(owner: Owner): boolean { return owner.grant?.mode === "manual" && parseLocalAuthority(owner.grant.hosts[0]) !== null; }
  function allowedUrl(owner: Owner, input: unknown): string | null {
    const local = parseLocalBrowserUrl(input);
    if (local) return owner.grant?.mode === "manual" && owner.grant.hosts.includes(local.key) ? local.url : null;
    if (localGrant(owner)) return null;
    // Ordinary browsing: any public HTTPS page, including sign-in pages. Network class never changes from inside a page.
    if (owner.grant?.mode === "manual" && owner.grant.web === true) return validatePublicBrowserUrl(input);
    const url = validatePublicBrowserUrl(input); if (!url) return null;
    const parsed = new URL(url);
    let pathname: string; try { pathname = decodeURIComponent(parsed.pathname); } catch { return null; }
    // Anonymous workspace: never enter account authentication flows.
    if (isAccountPath(pathname)) return null;
    return gateOpen || owner.grant?.hosts.includes(parsed.hostname) ? url : null;
  }
  function permissionDto(owner: Owner): BrowserPermissionDto {
    return Object.freeze({ conversationId: owner.value.conversationId,
      ...(owner.value.workspaceId === undefined ? {} : { workspaceId: owner.value.workspaceId }),
      status: owner.pending ? "pending" : owner.grant ? "granted" : owner.denied ? "denied" : "required",
      scope: owner.pending?.scope ?? owner.grant ?? policy ?? Object.freeze({ hosts: [], actions: [] }),
      ...(manualBrowsing && agentPolicy && owner.value.workspaceId === undefined ? { agentScope: agentPolicy, ...(options.agentSiteSelection ? { agentSiteSelection: true } : {}) } : {}), requestId: owner.pending?.id ?? null }) as BrowserPermissionDto;
  }
  function parseScope(input: unknown, owner: Owner): BrowserPermissionScope | null {
    if (!policy || !input || typeof input !== "object") return null;
    const value = input as Record<string, unknown>;
    if (value.mode === "manual" && value.site !== undefined) return null;
    if (value.mode === "manual" && value.web === true) {
      // Ordinary browsing belongs to the window workspace only. No lists, no provenance, no Agent action.
      if (!manualBrowsing || owner.value.workspaceId === undefined || value.sourceBrowserId !== undefined || value.sourceRequestId !== undefined
        || !Array.isArray(value.hosts) || value.hosts.length !== 0 || !Array.isArray(value.actions) || value.actions.length !== 1 || value.actions[0] !== "navigate"
        || (value.resourceHosts !== undefined && (!Array.isArray(value.resourceHosts) || value.resourceHosts.length !== 0))) return null;
      return Object.freeze({ mode: "manual", web: true, hosts: Object.freeze([]), resourceHosts: Object.freeze([]), actions: Object.freeze(["navigate"] as BrowserAction[]) });
    }
    if (value.mode === "manual") {
      if (!manualBrowsing || value.web !== undefined || !Array.isArray(value.hosts) || value.hosts.length !== 1
        || !Array.isArray(value.actions) || value.actions.length !== 1 || value.actions[0] !== "navigate"
        || !Array.isArray(value.resourceHosts) || value.resourceHosts.length > 16) return null;
      const validHost = (host: unknown): host is string => {
        if (typeof host !== "string") return false;
        const url = validatePublicBrowserUrl(`https://${host}/`);
        return !!url && new URL(url).hostname === host;
      };
      const primaryLocal = parseLocalAuthority(value.hosts[0]);
      if (primaryLocal) {
        // Private network: one canonical host:port; extra resource ports only on that same host.
        const canonical = localAuthorityKey(primaryLocal);
        if (value.hosts[0] !== canonical || value.resourceHosts.length > 8
          || !value.resourceHosts.every(host => typeof host === "string" && parseLocalAuthority(host) !== null && sameLocalHost(host, canonical) && host === localAuthorityKey(parseLocalAuthority(host)!))) return null;
      } else if (!value.hosts.every(validHost) || !value.resourceHosts.every(validHost)) return null;
      const primary = value.hosts[0] as string;
      const resourceHosts = [...new Set(value.resourceHosts as string[])].filter(host => host !== primary).sort();
      if (resourceHosts.length) {
        const source = typeof value.sourceBrowserId === "string" ? cells.get(value.sourceBrowserId) : undefined;
        if (!source || source.owner !== owner || !usable(source) || value.sourceRequestId !== source.page.requestId
          || owner.grant?.mode !== "manual" || owner.grant.hosts[0] !== primary
          || resourceHosts.some(host => !owner.grant?.resourceHosts?.includes(host) && !source.page.blockedResourceHosts?.includes(host))) return null;
      }
      return Object.freeze({ mode: "manual", hosts: Object.freeze([primary]), resourceHosts: Object.freeze(resourceHosts), actions: Object.freeze(["navigate"] as BrowserAction[]) });
    }
    if (value.site !== undefined) {
      if (value.site !== true || value.mode !== "agent" || !options.agentSiteSelection || !agentPolicy
        || owner.value.workspaceId !== undefined || value.web !== undefined
        || Object.keys(value).some(key => !["mode", "site", "hosts", "resourceHosts", "actions"].includes(key))) return null;
      const validHosts = (input: unknown, maximum: number): input is string[] => Array.isArray(input) && input.length <= maximum
        && input.every(host => typeof host === "string" && host.length <= 253 && !isIP(host)
          && validatePublicBrowserUrl(`https://${host}/`) === `https://${host}/` && new URL(`https://${host}/`).hostname === host
          && host.includes(".") && !host.endsWith("."));
      if (!validHosts(value.hosts, 8) || !value.hosts.length || !validHosts(value.resourceHosts ?? [], 16)
        || !Array.isArray(value.actions) || !value.actions.length || value.actions.length > agentPolicy.actions.length
        || !value.actions.every(action => agentPolicy.actions.includes(action))) return null;
      const hosts = [...new Set(value.hosts)].sort(), resources = [...new Set((value.resourceHosts ?? []) as string[])].filter(host => !hosts.includes(host)).sort();
      return Object.freeze({ mode: "agent", site: true, hosts: Object.freeze(hosts), resourceHosts: Object.freeze(resources),
        actions: Object.freeze(agentPolicy.actions.filter(action => (value.actions as unknown[]).includes(action))) });
    }
    // Legacy untagged proposals still require the explicit native Agent dialog.
    // Never erase a manual tag or reinterpret manual resource provenance as Agent authority.
    if (owner.value.workspaceId !== undefined || !agentPolicy || (value.mode !== undefined && value.mode !== "agent")
      || value.web !== undefined || value.resourceHosts !== undefined || value.sourceBrowserId !== undefined || value.sourceRequestId !== undefined) return null;
    if (!Array.isArray(value.hosts) || !value.hosts.length || value.hosts.length > agentPolicy.hosts.length || !Array.isArray(value.actions) || !value.actions.length || value.actions.length > agentPolicy.actions.length) return null;
    if (!value.hosts.every(host => typeof host === "string" && agentPolicy.hosts.includes(host)) || !value.actions.every(action => agentPolicy.actions.includes(action))) return null;
    const hosts = value.hosts as string[], actions = value.actions as BrowserAction[];
    return Object.freeze({ mode: "agent", hosts: Object.freeze(agentPolicy.hosts.filter(host => hosts.includes(host))), actions: Object.freeze(agentPolicy.actions.filter(action => actions.includes(action))) });
  }
  function equalScope(a: BrowserPermissionScope, b: BrowserPermissionScope): boolean { return JSON.stringify(a) === JSON.stringify(b); }
  let stopping = false;
  function validOwner(value: TrustedBrowserOwner, host: Host): boolean {
    try { return value.host === host.host && value.profile === options.profile && value.topFrame === host.host.webContents.mainFrame
      && value.signal instanceof AbortSignal && !value.signal.aborted && !host.host.isDestroyed() && !host.host.webContents.isDestroyed()
      && (value.workspaceId === undefined
        ? typeof value.conversationId === "string" && !!value.conversationId && value.conversationId.length <= 256
        : value.conversationId === null && typeof value.workspaceId === "string" && !!value.workspaceId && value.workspaceId.length <= 256)
      && typeof value.ownerSessionId === "string" && !!value.ownerSessionId && value.ownerSessionId.length <= 256
      && Number.isSafeInteger(value.generation) && value.generation >= 0;
    } catch { return false; }
  }
  function current(owner: Owner): boolean {
    try { return !stopping && !owner.retired && hosts.get(owner.value.host) === owner.host && owner.host.current === owner
      && validOwner(owner.value, owner.host) && owner.host.resolveOwner(owner.event) === owner.value;
    } catch { return false; }
  }
  const registry = createBrowserAuthorizationDomainRegistry<S>({ gateOpen,
    isContextAuthorized: context => {
      const owner = owners.get(context.owner as TrustedBrowserOwner);
      return !!owner?.grant && current(owner) && cells.get(context.browserId)?.owner === owner;
    },
    isOwnerCurrent: context => {
      const owner = owners.get(context.owner as TrustedBrowserOwner);
      return !!owner && current(owner) && context.profile === options.profile && context.conversationId === owner.value.conversationId
        && context.workspaceId === owner.value.workspaceId
        && context.generation === owner.value.generation && cells.get(context.browserId)?.owner === owner;
    } });
  const network = createBrowserNetworkController(registry, { ...options, onDownload: (context, item) => {
    const cell = cells.get(context.browserId);
    if (!cell || cell.context.signal !== context.signal || !usable(cell) || cell.owner.grant?.mode !== "manual" || cell.owner.grant.web !== true) return false;
    try { return options.acceptDownload?.(cell.owner.value, item) === true; } catch { return false; }
  }, beginConnection: (context, host) => {
    const cell = cells.get(context.browserId);
    if (!cell || cell.context.signal !== context.signal || !usable(cell) || !cell.page.loading || !cell.page.pendingUrl) return;
    const { requestId, pendingUrl } = cell.page;
    if (new URL(pendingUrl).hostname !== host) return;
    return code => {
      if (!usable(cell) || !cell.page.loading || cell.page.requestId !== requestId || cell.page.pendingUrl !== pendingUrl) return;
      cell.connectionFailure = cell.connectionFailure === undefined || cell.connectionFailure === code ? code : "load_failed";
    };
  }, onRequestBlocked: (context, request) => {
    const cell = cells.get(context.browserId);
    if (!cell || cell.context.signal !== context.signal || !usable(cell) || !cell.owner.grant) return;
    if (request.webContentsId !== undefined && request.webContentsId !== cell.guest?.contents.id) return;
    if (cell.owner.grant.web === true) {
      // Every public HTTPS host is already allowed; a block here means an unsupported scheme, port or private target.
      if (!cell.page.blockedRequest) { cell.page = { ...cell.page, blockedRequest: true }; publish(cell); }
      return;
    }
    const privateGrant = localGrant(cell.owner);
    // A private grant is offered only extra ports of its own host; any other destination is refused silently.
    let url: string | null = null, host: string | undefined;
    if (privateGrant) {
      try { host = localAuthorityFromUrl(new URL(request.url)) ?? undefined; } catch { host = undefined; }
      if (host && !sameLocalHost(host, cell.owner.grant.hosts[0])) host = undefined;
      if (['mainFrame', 'subFrame'].includes(request.resourceType)) { blockedNavigation(cell, request.url); return; }
    } else {
      url = validatePublicBrowserUrl(request.url);
      if (url && ['mainFrame', 'subFrame'].includes(request.resourceType)) { blockedNavigation(cell, url); return; }
      host = url ? new URL(url).hostname : undefined;
    }
    const supported = ["stylesheet", "script", "image", "font", "media", "xhr", ...(privateGrant ? ["webSocket"] : [])].includes(request.resourceType);
    if (host && supported && ["GET", "HEAD"].includes(request.method) && !cell.owner.grant.hosts.includes(host)
      && !cell.owner.grant.resourceHosts?.includes(host)) {
      const blocked = cell.page.blockedResourceHosts ?? [];
      if (blocked.includes(host) || blocked.length >= 16) return;
      cell.page = { ...cell.page, blockedResourceHosts: Object.freeze([...blocked, host]) };
    } else { if (cell.page.blockedRequest) return; cell.page = { ...cell.page, blockedRequest: true }; }
    publish(cell);
  }, createView: session => {
    const guest = options.createView(session); guests.set(session, guest); return guest;
  } });
  function publish(cell: Cell): void {
    if (current(cell.owner)) {
      try { options.onChanged?.(cell.owner.value, Object.freeze({ ...cell.page })); } catch { /* presentation callback cannot grant authority */ }
    }
  }
  function usable(cell: Cell): boolean { return !cell.closing && !cell.abort.signal.aborted && current(cell.owner) && cell.binding?.isCurrent() === true; }
  function hostVisible(owner: Owner): boolean {
    const entry = owner.host;
    return !owner.pending && !entry.overlay && entry.visible && entry.focused && entry.host.isVisible() && entry.host.isFocused();
  }
  function presented(cell: Cell): boolean { return cell.attached && hostVisible(cell.owner); }
  function detach(cell: Cell): void {
    // A later attach must never revive an observation made before the user hid the page.
    cell.attached = false; cell.presentationRevision++; cell.observation = undefined;
    cell.guest?.detach();
  }
  function blockedNavigation(cell: Cell, input: string): void {
    if (!usable(cell) || !cell.owner.grant) return;
    // Switching between public and private networks is possible only from the address bar,
    // never by a link, redirect or script inside a page. Cross-class attempts only set blockedRequest.
    const url = localGrant(cell.owner) || parseLocalBrowserUrl(input) ? null : validatePublicBrowserUrl(input);
    const origin = url && !cell.owner.grant.hosts.includes(new URL(url).hostname) ? `${new URL(url).origin}/` : undefined;
    if (cell.page.error === "blocked_url" && cell.page.blockedNavigationUrl === origin) return;
    cell.page = { ...cell.page, error: "blocked_url", ...(origin ? { blockedNavigationUrl: origin } : { blockedRequest: true }) }; publish(cell);
  }
  function terminate(cell: Cell): void {
    if (cell.closing) return;
    cell.closing = true; cell.connectionFailure = undefined; cell.navigation?.abort(); cell.abort.abort();
    try { detach(cell); } catch { cell.failed = true; }
    cell.binding?.revoke();
    cell.page = { ...cell.page, requestId: cell.page.requestId + 1, closed: true, loading: false, pendingUrl: null, canGoBack: false, canGoForward: false, error: null };
    publish(cell);
  }
  function cleanup(cell: Cell, signal?: AbortSignal): Promise<BrowserReply<null>> {
    terminate(cell);
    return cell.cleanup ??= (async () => {
      // The controller bounds the preparation barrier as well as native cleanup.
      // Awaiting prepare here would make a hung setProxy block shutdown forever.
      const result = await network.disposeContext(cell.context, signal);
      if (!result.ok) cell.failed = true;
      cell.owner.value.signal.removeEventListener("abort", cell.onAbort);
      if (cell.failed) { cell.page = { ...cell.page, error: "cleanup_failed" }; publish(cell); return fail("cleanup_failed"); }
      cells.delete(cell.page.browserId); cell.owner.cells.delete(cell);
      return { ok: true, value: null };
    })();
  }
  // The exact listener is stored on the cell, never reconstructed during cleanup.
  async function closeOwner(owner: Owner, signal?: AbortSignal): Promise<BrowserReply<null>> {
    const results = await Promise.all([...owner.cells].map(cell => cleanup(cell, signal)));
    return results.every(r => r.ok) ? { ok: true, value: null } : fail("cleanup_failed");
  }
  function revoke(owner: TrustedBrowserOwner): void {
    const record = owners.get(owner); if (!record) return;
    record.retired = true; retired.add(owner); clearPermission(record);
    for (const cell of record.cells) terminate(cell);
    void closeOwner(record).catch(() => { for (const cell of record.cells) cell.failed = true; });
  }
  function snapshot(cell: Cell): void {
    if (!usable(cell) || !cell.guest || cell.manualRequestId !== undefined) return;
    const native = cell.guest.snapshot(), url = allowedUrl(cell.owner, native.url);
    if (url) cell.page = { ...cell.page, url, loading: false, pendingUrl: null, canGoBack: native.canGoBack, canGoForward: native.canGoForward };
    publish(cell);
  }
  async function navigate(cell: Cell, url: string, action?: "back" | "forward" | "reload"): Promise<BrowserReply<BrowserPageDto>> {
    if (!usable(cell) || !cell.guest) return fail(cell.owner.value.signal.aborted ? "cancelled" : "owner_mismatch");
    cell.observation = undefined; cell.connectionFailure = undefined; cell.navigation?.abort();
    const navigation = new AbortController(); cell.navigation = navigation;
    const requestId = cell.page.requestId + 1;
    cell.manualRequestId = requestId;
    const stop = () => { try { cell.guest?.stop(); } catch { cell.failed = true; } };
    navigation.signal.addEventListener("abort", stop, { once: true });
    cell.page = { ...cell.page, requestId, loading: true, pendingUrl: url, error: null,
      ...(cell.owner.grant?.mode === "manual" ? { blockedResourceHosts: [], blockedNavigationUrl: undefined, blockedRequest: false } : {}) }; publish(cell);
    let abort!: () => void;
    try {
      if (!usable(cell)) return fail("cancelled");
      const operation = action ? cell.guest.history(action) : cell.guest.loadURL(url);
      await Promise.race([operation, new Promise<never>((_, reject) => {
        abort = () => reject(new Error("cancelled")); navigation.signal.addEventListener("abort", abort, { once: true });
        if (navigation.signal.aborted) abort();
      })]);
      if (navigation.signal.aborted || cell.page.requestId !== requestId) return fail("cancelled");
      if (!usable(cell)) { terminate(cell); return fail(cell.owner.value.signal.aborted ? "cancelled" : "owner_mismatch"); }
      const native = cell.guest.snapshot(), committed = allowedUrl(cell.owner, native.url);
      if (!committed) throw new Error("invalid committed destination");
      cell.connectionFailure = undefined;
      cell.page = { ...cell.page, loading: false, pendingUrl: null, url: committed, canGoBack: native.canGoBack, canGoForward: native.canGoForward };
      publish(cell); return { ok: true, value: Object.freeze({ ...cell.page }) };
    } catch (error) {
      if (navigation.signal.aborted || cell.page.requestId !== requestId || !usable(cell)) return fail(cell.owner.value.signal.aborted || navigation.signal.aborted ? "cancelled" : "owner_mismatch");
      const tunnel = error !== null && typeof error === "object" && (("code" in error && error.code === "ERR_TUNNEL_CONNECTION_FAILED") || ("errno" in error && error.errno === -111));
      const code = tunnel ? cell.connectionFailure ?? "load_failed" : "load_failed";
      cell.connectionFailure = undefined;
      cell.page = { ...cell.page, loading: false, pendingUrl: null, error: code }; publish(cell); return fail(code);
    } finally { navigation.signal.removeEventListener("abort", stop); if (abort) navigation.signal.removeEventListener("abort", abort); if (cell.manualRequestId === requestId) cell.manualRequestId = undefined; if (cell.navigation === navigation) cell.navigation = undefined; }
  }
  async function execute(ownerValue: TrustedBrowserOwner, input: unknown): Promise<BrowserReply<BrowserPageDto | null>> {
    const owner = owners.get(ownerValue);
    if (!owner || !current(owner)) return fail(ownerValue.signal?.aborted ? "cancelled" : "owner_mismatch");
    const command = parseCommand(input); if (!command) return fail("permission_denied");
    if (command.kind === "get") {
      const page = [...owner.cells].find(cell => !cell.closing)?.page;
      return { ok: true, value: page ? Object.freeze({ ...page }) : null };
    }
    if (command.kind === "open") {
      if (!permits(owner, "navigate")) return fail(policy ? "permission_denied" : "network_unavailable");
      const url = allowedUrl(owner, command.url); if (!url) return fail("blocked_url");
      if (owner.cells.size) return fail("closed");
      const abort = new AbortController(), browserId = randomUUID();
      const identity = { conversationId: ownerValue.conversationId,
        ...(ownerValue.workspaceId === undefined ? {} : { workspaceId: ownerValue.workspaceId }) };
      const context = Object.freeze({ owner: ownerValue, profile: options.profile, ...identity, browserId, generation: ownerValue.generation, signal: abort.signal });
      const cell: Cell = { owner, context, abort, attached: false, presentationRevision: 0, closing: false, failed: false,
        page: { browserId, ...identity, requestId: 0, closed: false, loading: true, url: "", pendingUrl: url, canGoBack: false, canGoForward: false, error: null } as BrowserPageDto,
        onAbort: () => { terminate(cell); void cleanup(cell); } };
      cells.set(browserId, cell); owner.cells.add(cell); ownerValue.signal.addEventListener("abort", cell.onAbort, { once: true });
      cell.preparing = network.prepare(context, owner.grant?.web === true ? { web: true } : owner.grant ? { hosts: owner.grant.hosts, resourceHosts: owner.grant.resourceHosts } : undefined); publish(cell);
      let cancelPrepare!: () => void;
      let prepared: BrowserNetworkReply<BrowserNetworkBinding<S>>;
      try {
        prepared = await Promise.race([cell.preparing, new Promise<BrowserNetworkReply<BrowserNetworkBinding<S>>>(resolve => {
          cancelPrepare = () => resolve({ ok: false, code: "cancelled" });
          abort.signal.addEventListener("abort", cancelPrepare, { once: true });
          if (abort.signal.aborted) cancelPrepare();
        })]);
      } finally { abort.signal.removeEventListener("abort", cancelPrepare); }
      if (abort.signal.aborted) { void cleanup(cell); return fail("cancelled"); }
      if (!prepared.ok) { await cleanup(cell); return fail(ownerValue.signal.aborted ? "cancelled" : prepared.code); }
      cell.binding = prepared.value; cell.guest = guests.get(prepared.value.session);
      if (!usable(cell) || !cell.guest) { await cleanup(cell); return fail(ownerValue.signal.aborted ? "cancelled" : "owner_mismatch"); }
      registered.add(cell.guest.contents); byContents.set(cell.guest.contents, cell);
      cell.guest.installCallbacks({ allowsNavigation: target => { const allowed = usable(cell) && allowedUrl(owner, target) !== null; if (!allowed) blockedNavigation(cell, target); return allowed; },
        started: (target, redirect) => {
          if (!usable(cell) || !allowedUrl(owner, target)) return;
          if (cell.manualRequestId !== undefined || redirect) {
            if (cell.page.loading && cell.page.pendingUrl !== target) {
              cell.connectionFailure = undefined; cell.page = { ...cell.page, pendingUrl: target }; publish(cell);
            }
            return;
          }
          { cell.connectionFailure = undefined; cell.page = { ...cell.page, requestId: cell.page.requestId + 1, loading: true, pendingUrl: target, error: null,
          ...(owner.grant?.mode === "manual" ? { blockedResourceHosts: [], blockedNavigationUrl: undefined, blockedRequest: false } : {}) }; publish(cell); } },
        changed: () => snapshot(cell), failed: (code, url) => { cell.observation = undefined; if (usable(cell) && cell.manualRequestId === undefined) {
          if (url !== undefined && url !== cell.page.pendingUrl) return;
          const error = code === -111 ? cell.connectionFailure ?? "load_failed" : "load_failed";
          cell.connectionFailure = undefined; cell.page = { ...cell.page, loading: false, pendingUrl: null, error }; publish(cell);
        } },
        destroyed: () => { if (!cell.closing) void cleanup(cell); } });
      return navigate(cell, url);
    }
    const cell = cells.get(command.browserId);
    if (!cell || cell.closing) return fail("closed"); if (cell.owner !== owner) return fail("owner_mismatch");
    if (command.kind === "close") {
      clearPermission(owner);
      const closed = await cleanup(cell); return closed.ok ? { ok: true, value: Object.freeze({ ...cell.page }) } : closed;
    }
    if (!usable(cell) || !cell.guest) return fail("owner_mismatch");
    if (command.kind === "stop") {
      if (!permits(owner, "navigate")) return fail("permission_denied");
      if (!cell.page.loading) return { ok: true, value: Object.freeze({ ...cell.page }) };
      const requestId = cell.page.requestId + 1;
      cell.manualRequestId = requestId;
      cell.observation = undefined; cell.connectionFailure = undefined;
      try {
        if (cell.navigation) cell.navigation.abort(); else cell.guest.stop();
        if (cell.failed) throw new Error("browser stop failed");
        const native = cell.guest.snapshot();
        cell.page = { ...cell.page, requestId, loading: false, pendingUrl: null, error: null,
          url: allowedUrl(owner, native.url) ?? cell.page.url, canGoBack: native.canGoBack, canGoForward: native.canGoForward };
        publish(cell); return { ok: true, value: Object.freeze({ ...cell.page }) };
      } catch {
        cell.failed = true;
        clearPermission(owner);
        const closed = await cleanup(cell);
        return fail(closed.ok ? "load_failed" : "cleanup_failed");
      }
      finally { if (cell.manualRequestId === requestId) cell.manualRequestId = undefined; }
    }
    if (command.kind === "navigate") { if (!permits(owner, "navigate")) return fail("permission_denied"); const url = allowedUrl(owner, command.url); return url ? navigate(cell, url) : fail("blocked_url"); }
    if (command.kind === "history") {
      if (!permits(owner, "navigate")) return fail("permission_denied");
      const native = cell.guest.snapshot();
      if ((command.action === "back" && !native.canGoBack) || (command.action === "forward" && !native.canGoForward) || !cell.page.url) return fail("closed");
      return navigate(cell, cell.page.url, command.action);
    }
    if (command.bounds === null || !hostVisible(owner)) detach(cell);
    else {
      const [width, height] = ownerValue.host.getContentSize(), left = Math.trunc(command.bounds.x), top = Math.trunc(command.bounds.y);
      const x = Math.max(0, Math.min(width, left)), y = Math.max(0, Math.min(height, top));
      const bounds = { x, y, width: Math.max(0, Math.min(width, left + Math.trunc(command.bounds.width)) - x), height: Math.max(0, Math.min(height, top + Math.trunc(command.bounds.height)) - y) };
      if (!bounds.width || !bounds.height) detach(cell);
      else { if (!usable(cell)) return fail("owner_mismatch"); cell.guest.setBounds(bounds); cell.guest.attach(ownerValue.host); cell.attached = true; }
    }
    return { ok: true, value: Object.freeze({ ...cell.page }) };
  }
  async function resolveOwner(event: BrowserInvokeEvent): Promise<BrowserReply<Owner>> {
    const host = [...hosts.values()].find(h => h.host.webContents === event.sender);
    if (!host || event.senderFrame !== host.host.webContents.mainFrame || stopping) return fail("owner_mismatch");
    let value: TrustedBrowserOwner | null; try { value = host.resolveOwner(event); } catch { return fail("owner_mismatch"); }
    if (!value || !validOwner(value, host) || retired.has(value)) return fail(value?.signal.aborted ? "cancelled" : "owner_mismatch");
    if (host.current?.value !== value) {
      if (host.transitioning || value.generation <= host.lastGeneration) return fail("owner_mismatch");
      host.transitioning = true;
      try {
        if (host.current) { const old = host.current; revoke(old.value); const result = await closeOwner(old); if (!result.ok) return result; }
        if (hosts.get(host.host) !== host || !validOwner(value, host) || host.resolveOwner(event) !== value) return fail("owner_mismatch");
        const owner: Owner = { value, host, event, retired: false, cells: new Set() }; host.current = owner; host.lastGeneration = value.generation; owners.set(value, owner);
      } finally { host.transitioning = false; }
    }
    return { ok: true, value: host.current! };
  }
  async function dispatch(event: BrowserInvokeEvent, input: unknown): Promise<BrowserReply<BrowserPageDto | null>> {
    const resolved = await resolveOwner(event); return resolved.ok ? execute(resolved.value.value, input) : resolved;
  }
  /** Runs a window-browser tool against this service's page. Only an ordinary-browsing manual page qualifies: a
   * host-limited, private-network or Agent grant gets `permission_denied`. */
  async function useTab<T>(event: BrowserInvokeEvent, run: (target: BrowserToolTarget) => Promise<T>): Promise<BrowserToolReply<T>> {
    const fault = (code: BrowserToolErrorCode): BrowserToolReply<never> => ({ ok: false, code });
    const resolved = await resolveOwner(event);
    if (!resolved.ok) return fault(resolved.code === "cancelled" || resolved.code === "closed" || resolved.code === "permission_denied" ? resolved.code : "owner_mismatch");
    const owner = resolved.value, cell = [...owner.cells].find(candidate => !candidate.closing);
    if (!cell) return fault("closed");
    if (!usable(cell) || !cell.guest) return fault("owner_mismatch");
    if (owner.grant?.mode !== "manual" || owner.grant.web !== true) return fault("permission_denied");
    const tools = cell.guest.tools; if (!tools) return fault("unsupported");
    let value: T;
    try { value = await run({ key: cell.guest, tools, host: owner.value.host, url: cell.page.url }); } catch { return fault("failed"); }
    return usable(cell) ? { ok: true, value } : fault("cancelled");
  }
  async function dispatchPermission(event: BrowserInvokeEvent, input: unknown): Promise<BrowserReply<BrowserPermissionDto>> {
    const resolved = await resolveOwner(event); if (!resolved.ok) return resolved;
    const owner = resolved.value;
    if (!policy || !input || typeof input !== "object") return fail("permission_denied");
    const command = input as Record<string, unknown>;
    if (command.kind === "get") return { ok: true, value: permissionDto(owner) };
    if (command.kind === "revoke") {
      // Cleanup from an old renderer scope cannot revoke the newly active conversation.
      if (owner.value.workspaceId !== undefined) {
        if (command.conversationId !== undefined || (command.workspaceId !== undefined && command.workspaceId !== owner.value.workspaceId)) return fail("owner_mismatch");
      } else if (command.workspaceId !== undefined || (command.conversationId !== undefined && command.conversationId !== owner.value.conversationId)) return fail("owner_mismatch");
      clearPermission(owner); const closed = await closeOwner(owner); if (!closed.ok) return closed;
      return current(owner) ? { ok: true, value: permissionDto(owner) } : fail("owner_mismatch");
    }
    if (command.kind !== "request") return fail("permission_denied");
    const scope = parseScope(command.scope, owner); if (!scope) return fail("permission_denied");
    if (owner.pending) {
      if (equalScope(owner.pending.scope, scope)) return owner.pending.promise;
      if (!manualBrowsing) return fail("permission_denied");
    }
    if (owner.grant && equalScope(owner.grant, scope)) return { ok: true, value: permissionDto(owner) };
    clearPermission(owner);
    const pending: PendingPermission = { id: randomUUID(), scope, cancel: new AbortController(), promise: undefined! };
    owner.pending = pending;
    const cancel = () => pending.cancel.abort(); owner.value.signal.addEventListener("abort", cancel, { once: true });
    pending.promise = (async () => {
      let stop: (() => void) | undefined;
      try {
        const closed = await closeOwner(owner); if (!closed.ok) return closed;
        if (!current(owner) || pending.cancel.signal.aborted) return fail("cancelled");
        const approved = await Promise.race([options.confirmPermission!(owner.value, scope, pending.cancel.signal), new Promise<boolean>(resolve => {
          stop = () => resolve(false); pending.cancel.signal.addEventListener("abort", stop, { once: true });
          if (pending.cancel.signal.aborted) stop();
        })]);
        if (!current(owner) || owner.pending !== pending || pending.cancel.signal.aborted) return fail("cancelled");
        owner.pending = undefined; owner.denied = approved !== true;
        if (approved === true) owner.grant = scope;
        return { ok: true, value: permissionDto(owner) } as BrowserReply<BrowserPermissionDto>;
      } catch { return fail("permission_denied"); }
      finally {
        if (stop) pending.cancel.signal.removeEventListener("abort", stop); owner.value.signal.removeEventListener("abort", cancel);
        if (owner.pending === pending) owner.pending = undefined;
      }
    })();
    return pending.promise;
  }
  async function executeAgent(ownerValue: TrustedBrowserOwner, input: unknown, run: TrustedBrowserRun): Promise<BrowserReply<BrowserPageDto | BrowserObservation | null>> {
    if (ownerValue.workspaceId !== undefined) return fail("owner_mismatch");
    const owner = owners.get(ownerValue);
    const runCurrent = () => {
      try { return !!owner && current(owner) && run.conversationId === ownerValue.conversationId && typeof run.runId === "string" && !!run.runId
        && run.signal instanceof AbortSignal && !run.signal.aborted && run.isCurrent() === true; } catch { return false; }
    };
    if (!runCurrent()) return fail(run?.signal?.aborted ? "cancelled" : "owner_mismatch");
    if (!owner!.grant || owner!.grant.mode !== "agent") return fail("permission_denied");
    if (!input || typeof input !== "object" || Array.isArray(input)) return fail("permission_denied");
    const raw = input as Record<string, unknown>;
    const keys = ["operation", "browserId", "url", "snapshotId", "ref", "text"];
    if (Object.keys(raw).some(key => !keys.includes(key)) || !["open", "navigate", "back", "forward", "reload", "observe", "click", "type", "close"].includes(String(raw.operation))) return fail("permission_denied");
    for (const key of keys.filter(key => key !== "operation")) if (raw[key] !== undefined && typeof raw[key] !== "string") return fail("permission_denied");
    const command = raw as unknown as BrowserWorkspaceCommand;
    const action: BrowserAction = ["open", "navigate", "back", "forward", "reload"].includes(command.operation) ? "navigate" : command.operation === "close" ? "navigate" : command.operation as BrowserAction;
    if (!permits(owner!, action)) return fail("permission_denied");
    if (owner!.agentBusy) return fail("permission_denied");
    const activeCell = () => command.browserId ? cells.get(command.browserId) : [...owner!.cells].find(cell => !cell.closing);
    let cell = activeCell();
    if (command.operation !== "open" && (!cell || cell.closing)) return fail("closed");
    if (cell && cell.owner !== owner) return fail("owner_mismatch");
    if (command.operation !== "open" && (!cell || !usable(cell) || !cell.guest)) return fail("owner_mismatch");
    if (command.operation !== "close" && (!hostVisible(owner!) || (command.operation !== "open" && !presented(cell!)))) return fail("permission_denied");
    const grant = owner!.grant;
    const stillCurrent = () => runCurrent() && owner!.grant === grant;
    const cancel = () => { clearPermission(owner!); for (const owned of owner!.cells) { terminate(owned); void cleanup(owned); } };
    run.signal.addEventListener("abort", cancel, { once: true });
    let onAbort!: () => void;
    const cellSignal = command.operation === "close" ? undefined : cell?.abort.signal;
    owner!.agentBusy = true;
    try {
      const operation = (async (): Promise<BrowserReply<BrowserPageDto | BrowserObservation | null>> => {
        if (!stillCurrent()) return fail("cancelled");
        if (command.operation === "open") return execute(ownerValue, { kind: "open", url: command.url });
        cell = activeCell(); if (!cell || !cell.guest || !usable(cell)) return fail("closed");
        if (command.operation === "navigate") return execute(ownerValue, { kind: "navigate", browserId: cell.page.browserId, url: command.url });
        if (["back", "forward", "reload"].includes(command.operation)) return execute(ownerValue, { kind: "history", browserId: cell.page.browserId, action: command.operation });
        if (command.operation === "close") return execute(ownerValue, { kind: "close", browserId: cell.page.browserId });
        if (!presented(cell) || cell.page.loading || !allowedUrl(owner!, cell.page.url)) return fail("permission_denied");
        const requestId = cell.page.requestId, presentationRevision = cell.presentationRevision;
        const samePresentation = () => presented(cell!) && cell!.presentationRevision === presentationRevision;
        if (command.operation === "observe") {
          if (!cell.guest.observe) return fail("network_unavailable");
          const value = await cell.guest.observe(grant!.hosts);
          if (!stillCurrent() || !usable(cell) || !samePresentation() || cell.page.requestId !== requestId || value.url !== cell.page.url) return fail("cancelled");
          cell.observation = { value, requestId, runId: run.runId };
          return { ok: true, value };
        }
        const observed = cell.observation;
        if (!observed || observed.requestId !== requestId || observed.runId !== run.runId || observed.value.snapshotId !== command.snapshotId
          || !observed.value.elements.some(element => element.ref === command.ref) || !cell.guest.act
          || (command.operation === "type" && (typeof command.text !== "string" || command.text.length > 4000))) return fail("permission_denied");
        cell.observation = undefined;
        if (!stillCurrent()) return fail("cancelled");
        const acted = await cell.guest.act({ kind: command.operation as "click" | "type", snapshotId: observed.value.snapshotId, ref: command.ref!, text: command.text, url: observed.value.url, hosts: grant!.hosts });
        if (!stillCurrent() || !usable(cell) || !samePresentation()) return fail("cancelled");
        return acted ? { ok: true, value: Object.freeze({ ...cell.page }) } : fail("permission_denied");
      })();
      const result = await Promise.race([operation, new Promise<BrowserReply<never>>(resolve => {
        onAbort = () => resolve(fail("cancelled"));
        run.signal.addEventListener("abort", onAbort, { once: true }); ownerValue.signal.addEventListener("abort", onAbort, { once: true }); cellSignal?.addEventListener("abort", onAbort, { once: true });
        if (run.signal.aborted || ownerValue.signal.aborted || cellSignal?.aborted) onAbort();
      })]);
      if (!runCurrent()) { cancel(); return fail(run.signal.aborted ? "cancelled" : "owner_mismatch"); }
      // Closing intentionally consumes its grant.
      return command.operation === "close" || owner!.grant === grant ? result : fail("cancelled");
    } catch { return fail(run.signal.aborted ? "cancelled" : "load_failed"); }
    finally { owner!.agentBusy = false; run.signal.removeEventListener("abort", cancel); if (onAbort) { run.signal.removeEventListener("abort", onAbort); ownerValue.signal.removeEventListener("abort", onAbort); cellSignal?.removeEventListener("abort", onAbort); } }
  }
  function registerHost(host: BrowserHostPort, resolveOwner: Host["resolveOwner"]): () => void {
    if (stopping || hosts.has(host) || host.isDestroyed()) throw new Error("browser host unavailable");
    const detachGuests = () => { for (const cell of entry.current?.cells ?? []) detach(cell); };
    const hidden = () => { entry.visible = false; detachGuests(); };
    const blurred = () => { entry.focused = false; detachGuests(); };
    const shown = () => { entry.visible = true; };
    const focused = () => { entry.focused = true; };
    const closed = () => { void closeHost(host); };
    const entry: Host = { host, resolveOwner, transitioning: false, lastGeneration: -1, overlay: false, visible: host.isVisible(), focused: host.isFocused(), detach: () => {
      host.removeListener("closed", closed); host.removeListener("hide", hidden); host.removeListener("blur", blurred); host.removeListener("show", shown); host.removeListener("focus", focused); host.webContents.removeListener("destroyed", closed);
    } };
    hosts.set(host, entry); host.on("closed", closed); host.on("hide", hidden); host.on("blur", blurred); host.on("show", shown); host.on("focus", focused); host.webContents.on("destroyed", closed);
    return () => { void closeHost(host); };
  }
  async function closeHost(host: BrowserHostPort, signal?: AbortSignal): Promise<BrowserReply<null>> {
    const entry = hosts.get(host); if (!entry) return { ok: true, value: null };
    hosts.delete(host); entry.detach(); if (!entry.current) return { ok: true, value: null };
    revoke(entry.current.value); return closeOwner(entry.current, signal);
  }
  function revokeAll(): void { stopping = true; for (const host of hosts.values()) if (host.current) clearPermission(host.current); for (const cell of cells.values()) terminate(cell); network.revokeAll(); }
  async function dispose(signal?: AbortSignal): Promise<BrowserReply<null>> {
    revokeAll(); for (const entry of hosts.values()) entry.detach(); hosts.clear();
    const results = await Promise.all([...cells.values()].map(cell => cleanup(cell, signal))), result = await network.disposeAll(signal);
    return result.ok && results.every(r => r.ok) ? { ok: true, value: null } : fail("cleanup_failed");
  }
  return Object.freeze({ registerHost, dispatch, dispatchPermission, useTab, execute, executeAgent, revoke, revokeAll, closeHost, dispose,
    isEnabled: () => (gateOpen || !!policy) && !stopping,
    isRegisteredBrowser: (contents: object) => registered.has(contents),
    credentialsFor: (contents: object, challenge: ProxyChallenge) => { const cell = byContents.get(contents); return cell && usable(cell) && cell.guest?.contents === contents ? cell.binding?.credentialsFor(cell.guest.contents, challenge) ?? null : null; },
    setTrustedOverlay(host: BrowserHostPort, visible: boolean) { const entry = hosts.get(host); if (!entry) return; entry.overlay = visible; if (visible) for (const cell of entry.current?.cells ?? []) detach(cell); },
  });
}
