import { randomUUID } from "node:crypto";
import type { Session } from "electron";
import type { BrowserAuthorizationDomain, BrowserAuthorizationDomainRegistry, BrowserDomainContext, BrowserDomainContents, BrowserDomainPolicy } from "./browser-authorization-domain";
import { BrowserProxyCleanupError, startBrowserDomainProxy, type BrowserDomainProxy, type BrowserProxyFactory } from "./browser-domain-proxy";
import type { BrowserRequestDetails } from "./browser-request-policy";
import type { ConnectProxy } from "./authenticated-connect-proxy";
import { parseLocalAuthority } from "../../shared/local-network-target";
import type { DownloadItemLike } from "./browser-downloads";
export interface BrowserSessionPort<S extends object> {
  session: S; persistent: boolean;
  installRequestHandler(handler: (request: BrowserRequestDetails) => boolean): void;
  /** Downloads are refused unless a handler is installed and returns true for that item. */
  installDownloadHandler?(handler: (item: DownloadItemLike) => boolean): void;
  denyPermissions(): void;
  setProxy(endpoint: ConnectProxy["endpoint"]): Promise<void>;
  /** Private-network grants only. Absent means such a grant cannot be prepared. */
  setDirect?(): Promise<void>;
  closeAllConnections(): Promise<void>; clearStorageData(): Promise<void>; clearCache(): Promise<void>;
  clearAuthCache(): Promise<void>; clearHostResolverCache(): Promise<void>; runningWorkerCount(): number;
}
import type { BrowserNetworkFailure } from "../../shared/manual-browser";
export type { BrowserNetworkFailure } from "../../shared/manual-browser";
export type BrowserNetworkReply<T> = { ok: true; value: T } | { ok: false; code: BrowserNetworkFailure };
export interface BrowserViewPort<S extends object> { contents: BrowserDomainContents<S>; destroy(): void }
export interface BrowserNetworkBinding<S extends object> {
  readonly session: S;
  readonly epoch: BrowserAuthorizationDomain<S>["epoch"];
  isCurrent(): boolean;
  revoke(): void;
  dispose(signal?: AbortSignal): Promise<BrowserNetworkReply<void>>;
  credentialsFor(contents: BrowserDomainContents<S> | undefined, challenge: import("./authenticated-connect-proxy").ProxyChallenge): ReturnType<ConnectProxy["credentialsFor"]>;
}
export interface BrowserNetworkDependencies<S extends object> {
  /** Must return a newly allocated, nonpersistent Main Session. Never borrow another consumer's Session. */
  createSession(partition: string): BrowserSessionPort<S>;
  /** Must create a hidden, unloaded view. The controller has no navigation API. */
  createView(session: S): BrowserViewPort<S>;
  proxyFactory?: BrowserProxyFactory;
  /** Presentation-only report from the current denied request. Cannot grant a request. */
  onRequestBlocked?(context: BrowserDomainContext, request: BrowserRequestDetails): void;
  /** Decides one download for the page of this context. Absent or false: the download is refused. */
  onDownload?(context: BrowserDomainContext, item: DownloadItemLike): boolean;
  beginConnection?(context: BrowserDomainContext, host: string): ReturnType<import("./authenticated-connect-proxy").BrowserConnectionObserver>;
  cleanupTimeoutMs?: number;
  workerStopTimeoutMs?: number;
}
const success = (): BrowserNetworkReply<void> => ({ ok: true, value: undefined });
const failure = (code: BrowserNetworkFailure): BrowserNetworkReply<never> => ({ ok: false, code });

type ElectronSessionOperations = Pick<Session, "storagePath" | "setPermissionCheckHandler" | "setPermissionRequestHandler" | "setDevicePermissionHandler" | "setProxy" | "closeAllConnections" | "clearStorageData" | "clearCache" | "clearAuthCache" | "clearHostResolverCache"> & {
  webRequest: { onBeforeRequest(handler: (details: BrowserRequestDetails, callback: (response: { cancel: boolean }) => void) => void): void };
  serviceWorkers: Pick<Session["serviceWorkers"], "getAllRunning">;
  on(event: "will-download", listener: (event: { preventDefault(): void }, item: DownloadItemLike) => void): unknown;
};
export function createElectronBrowserSessionPort<S extends ElectronSessionOperations>(session: S): BrowserSessionPort<S> {
  let downloadHandler: ((item: DownloadItemLike) => boolean) | undefined;
  return {
    session, persistent: session.storagePath !== null,
    installDownloadHandler(handler) { downloadHandler = handler; },
    installRequestHandler(handler) {
      session.webRequest.onBeforeRequest((details, callback) => {
        let allowed = false;
        try { allowed = handler(details); } catch { /* deny */ }
        callback({ cancel: !allowed });
      });
    },
    denyPermissions() {
      session.setPermissionCheckHandler(() => false);
      session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      session.setDevicePermissionHandler(() => false);
      session.on("will-download", (event, item) => {
        let accepted = false;
        try { accepted = downloadHandler?.(item) === true; } catch { /* refuse */ }
        if (!accepted) event.preventDefault();
      });
    },
    setProxy: (endpoint) => session.setProxy({ mode: "fixed_servers", proxyRules: `http://${endpoint.host}:${endpoint.port}`, proxyBypassRules: "<-loopback>" }),
    setDirect: () => session.setProxy({ mode: "direct" }),
    closeAllConnections: () => session.closeAllConnections(),
    clearStorageData: () => session.clearStorageData(),
    clearCache: () => session.clearCache(),
    clearAuthCache: () => session.clearAuthCache(),
    clearHostResolverCache: () => session.clearHostResolverCache(),
    runningWorkerCount: () => Object.keys(session.serviceWorkers.getAllRunning()).length,
  };
}

/** Offline orchestration; authority, native view creation and production gate stay with Main. */
export function createBrowserNetworkController<S extends object>(registry: BrowserAuthorizationDomainRegistry<S>, dependencies: BrowserNetworkDependencies<S>) {
  type Cell = {
    context: BrowserDomainContext; port?: BrowserSessionPort<S>; domain?: BrowserAuthorizationDomain<S>;
    view?: BrowserViewPort<S>; proxy?: BrowserDomainProxy<S>; proxyClosing?: Promise<void>;
    revoked: boolean; destroyAttempted: boolean; failed: boolean;
    prepared: Promise<void>; settlePrepared(): void; detachAbort(): void;
    cleanup?: Promise<BrowserNetworkReply<void>>;
  };
  const slots = new WeakMap<object, Map<string, Cell>>(), live = new Set<Cell>(), seen = new WeakSet<S>();
  const budget = dependencies.cleanupTimeoutMs ?? 10000;
  const workerBudget = dependencies.workerStopTimeoutMs ?? 3000;
  if (!Number.isFinite(budget) || budget <= 0 || !Number.isFinite(workerBudget) || workerBudget <= 0) throw new Error("invalid browser cleanup budget");
  let stopped = false;
  function revoke(cell: Cell): void {
    cell.revoked = true;
    cell.domain?.revoke();
    if (cell.proxy && !cell.proxyClosing) {
      try { cell.proxyClosing = cell.proxy.revoke(); }
      catch { cell.failed = true; }
      void cell.proxyClosing?.catch(() => { cell.failed = true; });
    }
    if (cell.view && !cell.destroyAttempted) {
      cell.destroyAttempted = true;
      try { cell.view.destroy(); } catch { cell.failed = true; }
    }
  }
  function interrupted(cell: Cell): BrowserNetworkFailure | null {
    if (cell.context.signal.aborted) return "cancelled";
    if (stopped || cell.revoked) return "closed";
    if (!registry.canPrepare(cell.context) || (cell.domain && !cell.domain.isCurrent())) return "owner_mismatch";
    return null;
  }
  function ensureCurrent(cell: Cell): void {
    const code = interrupted(cell);
    if (code) throw code;
  }
  function dispose(cell: Cell, signal?: AbortSignal): Promise<BrowserNetworkReply<void>> {
    revoke(cell);
    if (cell.cleanup) return cell.cleanup;
    cell.cleanup = (async () => {
      if (signal?.aborted) cell.failed = true;
      const deadline = Date.now() + budget;
      async function attempt(operation: () => Promise<unknown>): Promise<boolean> {
        let pending: Promise<unknown>;
        // Always invoke every cleanup, including after the total budget expired.
        try { pending = Promise.resolve(operation()); } catch { cell.failed = true; return false; }
        let timer: ReturnType<typeof setTimeout> | undefined;
        let abort: (() => void) | undefined;
        try {
          const ok = await Promise.race([
            pending.then(() => true, () => false),
            new Promise<boolean>((resolve) => {
              timer = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now()));
              abort = () => resolve(false);
              signal?.addEventListener("abort", abort, { once: true });
              if (signal?.aborted) resolve(false);
            }),
          ]);
          if (!ok) cell.failed = true;
          return ok;
        } finally {
          if (timer !== undefined) clearTimeout(timer);
          if (abort) signal?.removeEventListener("abort", abort);
        }
      }
      await attempt(() => cell.prepared);
      // A timed-out preparation can still produce a proxy. Its adapter closes it
      // on arrival; this disposal result remains failed, never upgrades silently.
      const tasks: Promise<boolean>[] = [];
      if (cell.proxyClosing) tasks.push(attempt(() => cell.proxyClosing!));
      if (cell.port) {
        const port = cell.port;
        for (const operation of [() => port.closeAllConnections(), () => port.clearStorageData(), () => port.clearCache(), () => port.clearAuthCache(), () => port.clearHostResolverCache()]) tasks.push(attempt(operation));
      }
      await Promise.all(tasks);
      if (cell.port) {
        const workerDeadline = Math.min(deadline, Date.now() + workerBudget);
        while (true) {
          try { if (cell.port.runningWorkerCount() === 0 && (!cell.view || cell.view.contents.isDestroyed())) break; }
          catch { cell.failed = true; break; }
          if (signal?.aborted || Date.now() >= workerDeadline) { cell.failed = true; break; }
          await new Promise<void>((resolve) => setTimeout(resolve, Math.min(10, workerDeadline - Date.now())));
        }
      }
      cell.detachAbort();
      if (cell.failed) return failure("cleanup_failed");
      live.delete(cell);
      slots.get(cell.context.owner)?.delete(cell.context.browserId);
      return success();
    })();
    return cell.cleanup;
  }
  async function prepare(context: BrowserDomainContext, policy?: BrowserDomainPolicy): Promise<BrowserNetworkReply<BrowserNetworkBinding<S>>> {
    if (stopped) return failure("closed");
    if (!registry.canPrepare(context, policy)) return failure(context.signal.aborted ? "cancelled" : "permission_denied");
    const copiedContext = Object.freeze({ ...context });
    const copiedPolicy: BrowserDomainPolicy | undefined = policy?.web === true ? Object.freeze({ web: true }) : policy?.hosts === undefined ? undefined : Object.freeze({ hosts: Object.freeze([...policy.hosts]),
      ...(policy.resourceHosts === undefined ? {} : { resourceHosts: Object.freeze([...policy.resourceHosts]) }) });
    let ownerSlots = slots.get(copiedContext.owner);
    if (!ownerSlots) { ownerSlots = new Map(); slots.set(copiedContext.owner, ownerSlots); }
    if (ownerSlots.has(copiedContext.browserId)) return failure("closed");
    let settlePrepared!: () => void;
    const prepared = new Promise<void>((resolve) => { settlePrepared = resolve; });
    const cell: Cell = { context: copiedContext, revoked: false, destroyAttempted: false, failed: false, prepared, settlePrepared, detachAbort: () => copiedContext.signal.removeEventListener("abort", onAbort) };
    ownerSlots.set(copiedContext.browserId, cell); live.add(cell);
    const onAbort = () => revoke(cell);
    copiedContext.signal.addEventListener("abort", onAbort, { once: true });
    let code: BrowserNetworkFailure = "network_unavailable";
    try {
      ensureCurrent(cell);
      const port = dependencies.createSession(`firefly-browser-${randomUUID()}`);
      // A borrowed Session must not acquire a handler or have user data cleared.
      if (port.persistent || seen.has(port.session) || registry.hasSeenSession(port.session)) throw "permission_denied";
      seen.add(port.session); cell.port = port;
      cell.domain = registry.create(copiedContext, port.session, copiedPolicy) ?? undefined;
      registry.retireSession(port.session);
      port.installRequestHandler((request) => {
        const allowed = !cell.revoked && (cell.domain?.allows(request) ?? false);
        if (!allowed && !cell.revoked && cell.domain?.isActive()) {
          try { dependencies.onRequestBlocked?.(cell.context, request); } catch { /* reporting cannot allow a request */ }
        }
        return allowed;
      });
      ensureCurrent(cell);
      if (!cell.domain) throw "owner_mismatch";
      port.installDownloadHandler?.(item => !cell.revoked && cell.domain?.isActive() === true && dependencies.onDownload?.(cell.context, item) === true);
      port.denyPermissions(); ensureCurrent(cell);
      cell.view = dependencies.createView(port.session); ensureCurrent(cell);
      if (!cell.domain.registerContents(cell.view.contents)) throw "owner_mismatch";
      if (parseLocalAuthority(copiedPolicy?.hosts?.[0]) !== null) {
        // Private-network grant: the public CONNECT proxy refuses non-public addresses by design,
        // so this session connects directly. The request handler above still admits only the
        // granted `host:port` (plus same-host resource ports), and DNS is never involved: the
        // policy accepts `localhost` and IP literals only.
        if (!port.setDirect) throw new Error("direct mode unavailable");
        await port.setDirect(); ensureCurrent(cell);
      } else {
        cell.proxy = await startBrowserDomainProxy(cell.domain, cell.view.contents, dependencies.proxyFactory,
          dependencies.beginConnection ? host => dependencies.beginConnection!(cell.context, host) : undefined);
        ensureCurrent(cell);
        await port.setProxy(cell.proxy.endpoint); ensureCurrent(cell);
      }
      await port.closeAllConnections(); ensureCurrent(cell);
      if (!cell.domain.activate()) throw "owner_mismatch";
      const domain = cell.domain;
      return { ok: true, value: Object.freeze({
        session: port.session, epoch: domain.epoch,
        isCurrent: () => !cell.revoked && domain.isActive(),
        revoke: () => revoke(cell), dispose: (signal?: AbortSignal) => dispose(cell, signal),
        credentialsFor: (contents: BrowserDomainContents<S> | undefined, challenge: import("./authenticated-connect-proxy").ProxyChallenge) => cell.proxy?.credentialsFor(contents, challenge) ?? null,
      }) };
    } catch (error) {
      if (error instanceof BrowserProxyCleanupError) cell.failed = true;
      code = copiedContext.signal.aborted ? "cancelled" : stopped || cell.revoked ? "closed" :
        !registry.canPrepare(copiedContext) ? "owner_mismatch" :
        typeof error === "string" && ["permission_denied", "owner_mismatch", "closed", "cancelled"].includes(error) ? error as BrowserNetworkFailure : "network_unavailable";
    } finally { cell.settlePrepared(); }
    // Settle the preparation barrier before cleanup, avoiding circular waits.
    const result = await dispose(cell);
    copiedContext.signal.removeEventListener("abort", onAbort);
    return result.ok ? failure(code) : result;
  }
  function revokeAll(): void {
    stopped = true;
    for (const cell of live) revoke(cell);
  }
  async function disposeAll(signal?: AbortSignal): Promise<BrowserNetworkReply<void>> {
    revokeAll();
    const results = await Promise.all([...live].map((cell) => dispose(cell, signal)));
    return results.every((result) => result.ok) ? success() : failure("cleanup_failed");
  }
  function disposeContext(context: BrowserDomainContext, signal?: AbortSignal): Promise<BrowserNetworkReply<void>> {
    const cell = slots.get(context.owner)?.get(context.browserId);
    // An already cleared slot needs no action. This API never allocates or grants authority.
    if (!cell) return Promise.resolve(success());
    const original = cell.context;
    if (original.profile !== context.profile || original.conversationId !== context.conversationId
      || original.generation !== context.generation || original.signal !== context.signal) {
      return Promise.resolve(failure("owner_mismatch"));
    }
    return dispose(cell, signal);
  }
  return Object.freeze({ prepare, revokeAll, disposeAll, disposeContext });
}
