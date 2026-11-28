import { Resolver } from "node:dns/promises";
import { BlockList, connect, isIP } from "node:net";
import { startAuthenticatedConnectProxy, type ProxyDependencies } from "./authenticated-connect-proxy";
import type { BrowserProxyFactory } from "./browser-domain-proxy";

/** Trusted Main composition input only. Never accepted from a page or IPC. */
export interface TrustedBrowserResolverConfig { readonly server: string; readonly port: number }
export interface TrustedBrowserResolver {
  resolve: ProxyDependencies["resolve"];
  dispose(): void;
}
const invalidServer = new BlockList();
invalidServer.addSubnet("0.0.0.0", 8); invalidServer.addSubnet("224.0.0.0", 4); invalidServer.addSubnet("240.0.0.0", 4);
invalidServer.addAddress("::", "ipv6"); invalidServer.addSubnet("ff00::", 8, "ipv6");
function snapshotConfig(input: TrustedBrowserResolverConfig): TrustedBrowserResolverConfig {
  const server = input?.server, port = input?.port;
  const family = typeof server === "string" ? isIP(server) : 0;
  if (!family || invalidServer.check(server, family === 4 ? "ipv4" : "ipv6") || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("browser DNS configuration unavailable");
  }
  return Object.freeze({ server, port });
}
/** Error exposes a stable DNS category, never hostname, raw exception or secrets. */
class BrowserDnsError extends Error {
  constructor(readonly code: string) { super("browser DNS unavailable"); }
}
function errorCode(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return typeof code === "string" && /^E[A-Z]+$/.test(code) ? code : "EFAIL";
}
// All bindings share this admission budget. Capacity is returned only after both
// actual native queries settle, including after owner/deadline cancellation.
let pendingTrustedLookups = 0;
const MAX_PENDING = 32, DEADLINE_MS = 5000;

/** Each admitted lookup owns its own c-ares channel: deadline cancellation cannot
 * cancel a sibling request. No global DNS/Chromium/OS configuration is mutated.
 * https://nodejs.org/download/release/v24.19.0/docs/api/dns.html#class-dnspromisesresolver
 */
export function createTrustedBrowserResolver(input: TrustedBrowserResolverConfig, signal: AbortSignal): TrustedBrowserResolver {
  const config = snapshotConfig(input), resolvers = new Set<Resolver>();
  let closed = signal.aborted;
  const dispose = () => {
    closed = true; signal.removeEventListener("abort", dispose);
    for (const resolver of resolvers) resolver.cancel();
  };
  if (!closed) signal.addEventListener("abort", dispose, { once: true });
  return Object.freeze({ dispose,
    async resolve(host: string) {
      if (closed || signal.aborted) throw new BrowserDnsError("ECANCELLED");
      if (pendingTrustedLookups >= MAX_PENDING) throw new BrowserDnsError("EBUSY");
      pendingTrustedLookups++;
      let resolver: Resolver | undefined, timer: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      try {
        resolver = new Resolver({ timeout: 1000, tries: 2 });
        resolver.setServers([isIP(config.server) === 6 ? `[${config.server}]:${config.port}` : `${config.server}:${config.port}`]);
        resolvers.add(resolver);
        timer = setTimeout(() => { timedOut = true; resolver!.cancel(); }, DEADLINE_MS); timer.unref();
        // allSettled deliberately retains native capacity when one family fails
        // early while the other remains pending. Only ENODATA means no records.
        const query = (family: 4 | 6): Promise<string[]> => {
          try { return family === 4 ? resolver!.resolve4(host) : resolver!.resolve6(host); }
          catch (error) { return Promise.reject(error); }
        };
        const results = await Promise.allSettled([query(4), query(6)]);
        if (closed || signal.aborted) throw new BrowserDnsError("ECANCELLED");
        if (timedOut) throw new BrowserDnsError("ETIMEOUT");
        const answers: Awaited<ReturnType<ProxyDependencies["resolve"]>>[number][] = [];
        for (let i = 0; i < results.length; i++) {
          const result = results[i];
          if (result.status === "rejected") {
            const code = errorCode(result.reason);
            if (code !== "ENODATA") throw new BrowserDnsError(code);
          } else for (const address of result.value) answers.push({ address, family: i === 0 ? 4 : 6 });
        }
        return answers;
      } catch (error) {
        throw error instanceof BrowserDnsError ? error : new BrowserDnsError(errorCode(error));
      } finally {
        clearTimeout(timer); if (resolver) resolvers.delete(resolver); pendingTrustedLookups--;
      }
    },
  });
}

/** Main-only optional dependency factory. Missing config leaves the existing OS
 * default intact. A private DNS infrastructure endpoint grants no webpage access:
 * the unchanged CONNECT path validates ALL answers, pins numeric TCP, checks the
 * actual socket peer, and carries original-host TLS bytes without termination.
 */
export function createTrustedBrowserProxyFactory(input: TrustedBrowserResolverConfig): BrowserProxyFactory {
  const config = snapshotConfig(input);
  return async owner => {
    if (owner.signal.aborted) throw new BrowserDnsError("ECANCELLED");
    const resolver = createTrustedBrowserResolver(config, owner.signal);
    try {
      const proxy = await startAuthenticatedConnectProxy(owner, {
        resolve: resolver.resolve,
        connect: (target, signal) => connect({ host: target.address, port: target.port, family: target.family, signal }),
      });
      return { ...proxy, revoke: () => { resolver.dispose(); return proxy.revoke(); } };
    } catch (error) { resolver.dispose(); throw error; }
  };
}
