import type { BrowserAuthorizationDomain, BrowserDomainContents } from "./browser-authorization-domain";
import { startAuthenticatedConnectProxy, type ConnectProxy, type ProxyChallenge, type BrowserConnectionObserver } from "./authenticated-connect-proxy";
export type BrowserProxyFactory = (owner: { webContentsId: number; signal: AbortSignal; readonly allowedHosts?: readonly string[]; beginConnection?: BrowserConnectionObserver }) => Promise<ConnectProxy>;
/** Carries only cleanup semantics; never an underlying error or credentials. */
export class BrowserProxyCleanupError extends Error {
  constructor() { super("browser proxy cleanup failed"); }
}
export interface BrowserDomainProxy<S extends object> {
  readonly endpoint: ConnectProxy["endpoint"];
  credentialsFor(contents: BrowserDomainContents<S> | undefined, challenge: ProxyChallenge): ReturnType<ConnectProxy["credentialsFor"]>;
  revoke(): Promise<void>;
}
export async function startBrowserDomainProxy<S extends object>(domain: BrowserAuthorizationDomain<S>, contents: BrowserDomainContents<S>, factory: BrowserProxyFactory = startAuthenticatedConnectProxy, beginConnection?: BrowserConnectionObserver): Promise<BrowserDomainProxy<S>> {
  if (!domain.ownsContents(contents)) throw new Error("browser domain unavailable");
  const nativeId = contents.id;
  const hosts = domain.epoch.policy.hosts;
  const scope = hosts === undefined ? {} : { allowedHosts: Object.freeze([...new Set([...hosts, ...(domain.epoch.policy.resourceHosts ?? [])])]) };
  const proxy = await factory({ webContentsId: nativeId, signal: domain.signal, ...scope, ...(beginConnection ? { beginConnection } : {}) });
  if (!domain.ownsContents(contents)) {
    try { await proxy.revoke(); } catch { throw new BrowserProxyCleanupError(); }
    throw new Error("browser domain unavailable");
  }
  let closing: Promise<void> | undefined;
  function revoke(): Promise<void> {
    domain.revoke();
    if (!closing) {
      try { closing = proxy.revoke(); }
      catch { closing = Promise.reject(new Error("browser proxy cleanup failed")); }
      void closing.catch(() => {});
    }
    return closing;
  }
  domain.signal.addEventListener("abort", () => { void revoke(); }, { once: true });
  return Object.freeze({
    endpoint: Object.freeze({ ...proxy.endpoint }),
    credentialsFor(candidate: BrowserDomainContents<S> | undefined, challenge: ProxyChallenge) {
      if (!domain.isActive() || !domain.ownsContents(candidate)) return null;
      return proxy.credentialsFor({ ...challenge, webContentsId: nativeId });
    },
    revoke,
  });
}
