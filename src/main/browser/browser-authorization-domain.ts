import { isIP } from "node:net";
import { randomUUID } from "node:crypto";
import { isPublicNetworkAddress, parseConnectAuthority } from "./public-network-target";
import type { BrowserRequestDetails } from "./browser-request-policy";
import { localAuthorityFromUrl, localAuthorityKey, parseLocalAuthority, sameLocalHost } from "../../shared/local-network-target";

export interface BrowserDomainContext {
  readonly owner: object;
  readonly profile: object;
  readonly conversationId: string | null;
  readonly workspaceId?: string;
  readonly browserId: string;
  readonly generation: number;
  readonly signal: AbortSignal;
}
/** `web` is the ordinary-browsing grant: any public HTTPS host and resource, the usual request methods,
 * and no host lists. It still never reaches a non-public address, and excludes every private authority. */
export interface BrowserDomainPolicy { readonly hosts?: readonly string[]; readonly resourceHosts?: readonly string[]; readonly web?: boolean }
export interface BrowserDomainContents<S extends object> {
  readonly id: number;
  readonly session: S;
  isDestroyed(): boolean;
}
export interface BrowserAuthorizationDomain<S extends object> {
  readonly epoch: Readonly<{
    id: string; session: S; context: BrowserDomainContext;
    policy: Readonly<{ hosts?: readonly string[]; resourceHosts?: readonly string[]; web?: true; methods: readonly string[]; resources: readonly string[] }>;
  }>;
  readonly signal: AbortSignal;
  isCurrent(): boolean;
  isActive(): boolean;
  activate(): boolean;
  revoke(): void;
  registerContents(contents: BrowserDomainContents<S>): boolean;
  ownsContents(contents: BrowserDomainContents<S> | undefined): boolean;
  allows(details: BrowserRequestDetails): boolean;
}
export interface BrowserAuthorizationDomainRegistry<S extends object> {
  canPrepare(context: BrowserDomainContext, policy?: BrowserDomainPolicy): boolean;
  hasSeenSession(session: S): boolean;
  /** Permanently consume an owned fresh allocation even if preparation was cancelled. */
  retireSession(session: S): void;
  create(context: BrowserDomainContext, session: S, policy?: BrowserDomainPolicy): BrowserAuthorizationDomain<S> | null;
  revokeAll(): void;
}
const methods = Object.freeze(["GET", "HEAD"]);
const resources = Object.freeze(["mainFrame", "subFrame", "stylesheet", "script", "image", "font", "media", "xhr"]);
/** A private-network grant additionally carries same-host WebSocket traffic (dev-server reload). */
const localResources = Object.freeze([...resources, "webSocket"]);
/** Ordinary pages post forms, open sockets and send beacons; CORS preflights use OPTIONS. */
const webMethods = Object.freeze(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const webResources = Object.freeze([...resources, "webSocket", "ping", "other"]);
/** Public targets key on hostname; private-network targets key on `host:port`. */
function classify(url: string): { key: string; local: boolean; socket: boolean } | null {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) return null;
    const local = localAuthorityFromUrl(parsed);
    if (local) return { key: local, local: true, socket: parsed.protocol === "ws:" || parsed.protocol === "wss:" };
    // Secure WebSocket rides the same CONNECT tunnel on 443; plain ws:// to a public host never does.
    if ((parsed.protocol !== "https:" && parsed.protocol !== "wss:") || (parsed.port && parsed.port !== "443")) return null;
    const authority = parseConnectAuthority(`${parsed.hostname}:443`);
    if (!authority || (isIP(authority.host) && !isPublicNetworkAddress(authority.host))) return null;
    return { key: authority.host, local: false, socket: parsed.protocol === "wss:" };
  } catch { return null; }
}
/** Mixed classes are refused: a private grant never names a public host and vice versa.
 * Resource authorities of a private grant must share the primary host (other ports only). */
function normalizeHosts(key: "hosts" | "resourceHosts", input: readonly string[], primary?: string): string[] | null {
  const hosts: string[] = [];
  for (const host of input) {
    const local = parseLocalAuthority(host);
    if (local) {
      if (key === "resourceHosts" && !sameLocalHost(host, primary ?? "")) return null;
      hosts.push(localAuthorityKey(local));
      continue;
    }
    if (primary !== undefined && parseLocalAuthority(primary)) return null;
    const authority = parseConnectAuthority(`${isIP(host) === 6 ? `[${host}]` : host}:443`);
    if (!authority || (isIP(authority.host) && !isPublicNetworkAddress(authority.host))) return null;
    hosts.push(authority.host);
  }
  return hosts;
}
function snapshotPolicy(policy?: BrowserDomainPolicy): BrowserAuthorizationDomain<object>["epoch"]["policy"] | null {
  const normalized: { hosts?: readonly string[]; resourceHosts?: readonly string[] } = {};
  if (policy?.web === true) {
    // Open web access is its own shape: no lists to narrow or widen, and no private authority.
    if (policy.hosts !== undefined || policy.resourceHosts !== undefined) return null;
    return Object.freeze({ web: true as const, methods: webMethods, resources: webResources });
  }
  if (policy?.resourceHosts !== undefined && policy.hosts === undefined) return null;
  let primary: string | undefined;
  for (const key of ["hosts", "resourceHosts"] as const) {
    const input = policy?.[key];
    if (input !== undefined) {
      const hosts = normalizeHosts(key, input, primary);
      if (!hosts) return null;
      if (key === "hosts") primary = hosts[0];
      normalized[key] = Object.freeze([...new Set(hosts)]);
    }
  }
  const isLocal = primary !== undefined && parseLocalAuthority(primary) !== null;
  // A private grant is exactly one primary authority; it never widens to several hosts.
  if (isLocal && (normalized.hosts?.length ?? 0) !== 1) return null;
  return Object.freeze({ methods, resources: isLocal ? localResources : resources, ...normalized });
}

/** Main-only registry. Object identities and the trusted owner callback are its authority. */
export function createBrowserAuthorizationDomainRegistry<S extends object>(options: {
  isOwnerCurrent(context: BrowserDomainContext): boolean;
  gateOpen?: boolean;
  isContextAuthorized?(context: BrowserDomainContext): boolean;
}): BrowserAuthorizationDomainRegistry<S> {
  const gateOpen = options.gateOpen === true;
  const verifyOwner = options.isOwnerCurrent;
  const seen = new WeakSet<S>();
  const live = new Set<BrowserAuthorizationDomain<S>>();
  function ownerCurrent(context: BrowserDomainContext): boolean {
    try {
      return (gateOpen || options.isContextAuthorized?.(context) === true) && !context.signal.aborted && Number.isSafeInteger(context.generation) && context.generation >= 0
        && (context.workspaceId === undefined ? !!context.conversationId : context.conversationId === null && !!context.workspaceId)
        && !!context.browserId && verifyOwner(context) === true;
    } catch { return false; }
  }
  function canPrepare(context: BrowserDomainContext, policy?: BrowserDomainPolicy): boolean {
    return ownerCurrent(context) && snapshotPolicy(policy) !== null;
  }
  function create(context: BrowserDomainContext, session: S, policy?: BrowserDomainPolicy): BrowserAuthorizationDomain<S> | null {
    const copiedPolicy = snapshotPolicy(policy);
    if (!ownerCurrent(context) || !copiedPolicy || seen.has(session)) return null;
    seen.add(session);
    const copiedContext = Object.freeze({ ...context });
    const epoch = Object.freeze({ id: randomUUID(), session, context: copiedContext, policy: copiedPolicy });
    const cancellation = new AbortController();
    let revoked = false, active = false;
    let primary: BrowserDomainContents<S> | undefined;
    let primaryId: number | undefined;
    function revoke(): void {
      if (revoked) return;
      revoked = true; active = false;
      copiedContext.signal.removeEventListener("abort", revoke);
      live.delete(domain);
      cancellation.abort();
    }
    function nativeCurrent(): boolean {
      try { return !primary || (primary.session === session && primary.id === primaryId && !primary.isDestroyed()); }
      catch { return false; }
    }
    function isCurrent(): boolean {
      if (!revoked && (!ownerCurrent(copiedContext) || !nativeCurrent())) revoke();
      return !revoked;
    }
    function ownsContents(contents: BrowserDomainContents<S> | undefined): boolean {
      return isCurrent() && primary !== undefined && contents === primary;
    }
    const domain: BrowserAuthorizationDomain<S> = Object.freeze({
      epoch, signal: cancellation.signal, isCurrent,
      isActive: () => isCurrent() && active,
      activate: () => { if (!isCurrent() || !primary) return false; active = true; return true; },
      revoke,
      registerContents(contents: BrowserDomainContents<S>): boolean {
        if (!isCurrent()) return false;
        if (primary) return ownsContents(contents);
        try {
          if (contents.session !== session || !Number.isSafeInteger(contents.id) || contents.id <= 0 || contents.isDestroyed()) return false;
          primary = contents; primaryId = contents.id; return true;
        } catch { return false; }
      },
      ownsContents,
      allows(details: BrowserRequestDetails): boolean {
        if (!isCurrent() || !active || !copiedPolicy.methods.includes(details.method) || !copiedPolicy.resources.includes(details.resourceType)) return false;
        if (details.webContentsId !== undefined && details.webContentsId !== primaryId) return false;
        const found = classify(details.url);
        if (!found) return false;
        const granted = copiedPolicy.hosts?.[0] !== undefined && parseLocalAuthority(copiedPolicy.hosts[0]) !== null;
        // Classes never cross, and a socket scheme only accompanies a WebSocket request.
        if (found.local !== granted) return false;
        // A socket scheme only accompanies a WebSocket request, and a WebSocket request only a socket scheme.
        if (found.socket !== (details.resourceType === "webSocket")) return false;
        const host = found.key;
        return copiedPolicy.hosts === undefined || copiedPolicy.hosts.includes(host)
          || (!["mainFrame", "subFrame"].includes(details.resourceType) && copiedPolicy.resourceHosts?.includes(host) === true);
      },
    });
    live.add(domain);
    copiedContext.signal.addEventListener("abort", revoke, { once: true });
    if (copiedContext.signal.aborted) revoke();
    return domain;
  }
  return Object.freeze({ canPrepare, create, hasSeenSession: (session: S) => seen.has(session), retireSession: (session: S) => { seen.add(session); }, revokeAll: () => { for (const domain of live) domain.revoke(); } });
}
