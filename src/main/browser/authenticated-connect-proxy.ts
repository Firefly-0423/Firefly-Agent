import { BlockList, connect, isIP, type Socket } from "node:net";
import { createServer, type IncomingMessage } from "node:http";
import { lookup } from "node:dns/promises";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isPublicNetworkAddress, parseConnectAuthority } from "./public-network-target";
import type { BrowserConnectionError } from "../../shared/manual-browser";
/** Main-only snapshot at CONNECT admission; no URL, credentials or raw error crosses it. */
export type BrowserConnectionObserver = (host: string) => ((code: BrowserConnectionError) => void) | undefined;
export interface PinnedTarget { address: string; family: 4 | 6; port: 443 }
export interface ProxyChallenge { isProxy: boolean; host: string; port: number; realm: string; scheme: string; webContentsId?: number }
export interface ConnectProxy {
  endpoint: { host: "127.0.0.1"; port: number; realm: string };
  credentialsFor(challenge: ProxyChallenge): { username: string; password: string } | null;
  /** Closes listener/tunnels and disables credentials. OS lookup may outlive
   * revocation; it retains this Main module's DNS budget until actual settlement. */
  revoke(): Promise<void>;
}
export interface ProxyDependencies {
  resolve(host: string): Promise<readonly { address: string; family: number }[]>;
  connect(target: PinnedTarget, signal: AbortSignal): Socket;
}
const defaults: ProxyDependencies = {
  resolve: (host) => lookup(host, { all: true, verbatim: true }),
  // Numeric host prevents a second hostname lookup. No proxy-env/HTTP-agent path.
  // https://nodejs.org/download/release/v24.19.0/docs/api/net.html#netcreateconnectionoptions-connectlistener
  connect: (target, signal) => connect({ host: target.address, port: target.port, family: target.family, signal }),
};
// dns.lookup has no AbortSignal. Cancelled waiters must not return this capacity
// while OS DNS is still running, including when the Main binding is recreated.
// Saturation fails closed; never-settling lookups keep at most 32 slots occupied
// for this Main module instance until they settle or the process exits.
let pendingLookups = 0;
function resolveWithinBudget(dependencies: ProxyDependencies, host: string): ReturnType<ProxyDependencies["resolve"]> | null {
  if (pendingLookups >= 32) return null;
  pendingLookups++;
  try {
    return Promise.resolve(dependencies.resolve(host)).finally(() => { pendingLookups--; });
  } catch (error) { pendingLookups--; throw error; }
}
const digest = (text: string) => createHash("sha256").update(text).digest();

function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("cancelled"));
    if (signal.aborted) { pending.catch(() => {}); abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
function headerCount(request: IncomingMessage, name: string): number {
  let count = 0;
  for (let i = 0; i < request.rawHeaders.length; i += 2) if (request.rawHeaders[i].toLowerCase() === name) count++;
  return count;
}
function matchesRemote(target: PinnedTarget, remote: string | undefined): boolean {
  if (!remote || !isIP(remote)) return false;
  const match = new BlockList(); match.addAddress(target.address, target.family === 4 ? "ipv4" : "ipv6");
  return match.check(remote, isIP(remote) === 4 ? "ipv4" : "ipv6");
}

/** Main-only building block. Does not open pages or certify browser egress safety.
 * https://nodejs.org/docs/latest-v24.x/api/http.html#event-connect
 * Caller must combine a dedicated session, request policy and complete N1-N10.
 */
export async function startAuthenticatedConnectProxy(ownerInput: { webContentsId: number; signal: AbortSignal; readonly allowedHosts?: readonly string[]; beginConnection?: BrowserConnectionObserver }, dependencies: ProxyDependencies = defaults): Promise<ConnectProxy> {
  const owner = { webContentsId: ownerInput.webContentsId, signal: ownerInput.signal,
    allowedHosts: ownerInput.allowedHosts === undefined ? undefined : Object.freeze([...ownerInput.allowedHosts]), beginConnection: ownerInput.beginConnection };
  if (!Number.isSafeInteger(owner.webContentsId) || owner.webContentsId <= 0 || owner.signal.aborted) throw new Error("browser binding unavailable");
  const username = randomBytes(16).toString("hex"); const password = randomBytes(32).toString("hex");
  const realm = `browser-${randomBytes(16).toString("hex")}`;
  const expected = digest(`Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`);
  let active = true; let closing: Promise<void> | null = null;
  const sockets = new Set<Socket>(); const requests = new Set<AbortController>();
  const reject = (client: Socket, status: 403 | 407 | 503) => {
    if (client.destroyed) return;
    // Peer FIN is untrusted. Flush the response then reclaim the entire socket;
    // this deadline cannot be extended by a half-open peer sending more bytes.
    const finish = setTimeout(() => client.destroy(), 1000); finish.unref();
    client.once("close", () => clearTimeout(finish));
    client.end(`HTTP/1.1 ${status} Blocked\r\n${status === 407 ? `Proxy-Authenticate: Basic realm="${realm}"\r\n` : ""}Connection: close\r\nContent-Length: 0\r\n\r\n`, () => client.destroy());
  };
  const server = createServer({ maxHeaderSize: 4096 }, (_request, response) => { response.writeHead(403, { Connection: "close" }); response.end(); });
  server.maxConnections = 64; server.headersTimeout = 5000; server.requestTimeout = 10000; server.keepAliveTimeout = 1000;
  server.on("connection", (socket) => {
    sockets.add(socket); socket.setTimeout(30000, () => socket.destroy()); socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    if (!active) socket.destroy();
  });
  server.on("upgrade", (_request, socket) => socket.destroy());
  server.on("clientError", (_error, socket) => socket.destroy());
  server.on("connect", (request, rawClient, head) => {
    const client = rawClient as Socket;
    void (async () => {
      if (!active || owner.signal.aborted || client.destroyed) { client.destroy(); return; }
      const authorization = request.headers["proxy-authorization"];
      if (headerCount(request, "proxy-authorization") !== 1 || typeof authorization !== "string" || authorization.length > 512
        || !timingSafeEqual(digest(authorization), expected)) { reject(client, 407); return; }
      const target = parseConnectAuthority(request.url ?? "");
      if (!target || headerCount(request, "host") !== 1 || request.headers.host?.toLowerCase() !== request.url?.toLowerCase()
        || request.headers["transfer-encoding"] || (request.headers["content-length"] && request.headers["content-length"] !== "0")) { reject(client, 403); return; }
      // Scope is an exact, immutable host snapshot. Reject before consuming DNS
      // capacity or opening a socket, including public IP-literal authorities.
      if (owner.allowedHosts !== undefined && !owner.allowedHosts.includes(target.host)) { reject(client, 403); return; }
      if (requests.size >= 32) { reject(client, 503); return; }
      const scope = new AbortController(); requests.add(scope);
      let sink: ReturnType<BrowserConnectionObserver>;
      try { sink = owner.beginConnection?.(target.host); } catch { /* diagnostics never change authority */ }
      let reported = false, phase: "dns" | "connect" | "tunnel" = "dns", timedOut = false;
      const report = (code: BrowserConnectionError) => {
        if (reported || !active || owner.signal.aborted || client.destroyed || (scope.signal.aborted && !timedOut)) return;
        reported = true; try { sink?.(code); } catch { /* presentation observer only */ }
      };
      const cancelled = () => scope.abort(); client.once("close", cancelled);
      const deadline = setTimeout(() => { timedOut = true; cancelled(); }, 10000); deadline.unref();
      let upstream: Socket | undefined;
      try {
        const literalFamily = isIP(target.host);
        let answers: Awaited<ReturnType<ProxyDependencies["resolve"]>>;
        if (literalFamily) answers = [{ address: target.host, family: literalFamily }];
        else {
          const resolving = resolveWithinBudget(dependencies, target.host);
          if (!resolving) { reject(client, 503); return; }
          answers = await abortable(resolving, scope.signal);
        }
        if (!active || owner.signal.aborted || scope.signal.aborted || client.destroyed) return;
        if (!answers.length || answers.length > 64 || answers.some(answer => isIP(answer.address) !== answer.family)) { report("dns_failed"); reject(client, 403); return; }
        if (answers.some(answer => !isPublicNetworkAddress(answer.address))) { report("restricted_address"); reject(client, 403); return; }
        phase = "connect";
        const pin: PinnedTarget = { address: answers[0].address, family: answers[0].family as 4 | 6, port: 443 };
        upstream = dependencies.connect(pin, scope.signal); sockets.add(upstream);
        upstream.once("close", () => { sockets.delete(upstream!); client.destroy(); });
        upstream.on("error", () => { if (phase === "connect") report("connection_failed"); reject(client, 403); upstream?.destroy(); });
        client.once("close", () => upstream?.destroy());
        await abortable(new Promise<void>((resolve, fail) => {
          upstream!.once("connect", resolve); upstream!.once("error", fail); upstream!.once("close", () => fail(new Error("connection closed")));
        }), scope.signal);
        if (!active || owner.signal.aborted || scope.signal.aborted || client.destroyed || upstream.destroyed || !matchesRemote(pin, upstream.remoteAddress)) {
          report("connection_failed"); upstream.destroy(); reject(client, 403); return;
        }
        phase = "tunnel";
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        client.pipe(upstream); upstream.pipe(client);
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
        report(phase === "dns" ? timedOut || code === "ETIMEOUT" || code === "ETIMEDOUT" ? "dns_timeout" : "dns_failed" : "connection_failed");
        upstream?.destroy(); reject(client, 403);
      }
      finally { clearTimeout(deadline); requests.delete(scope); client.removeListener("close", cancelled); }
    })();
  });
  const listening = new Promise<void>((resolve, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => { server.removeListener("error", fail); resolve(); });
  });
  const revoke = () => {
    active = false; owner.signal.removeEventListener("abort", onAbort);
    requests.forEach((scope) => scope.abort()); sockets.forEach((socket) => socket.destroy());
    closing ??= listening.then(() => new Promise<void>((resolve, fail) => server.close((error) => error ? fail(new Error("proxy cleanup failed")) : resolve())), () => {});
    return closing;
  };
  const onAbort = () => { void revoke().catch(() => {}); }; // await revoke() reports cleanup errors to the caller.
  owner.signal.addEventListener("abort", onAbort, { once: true });
  server.on("error", onAbort);
  try { await listening; } catch { await revoke(); throw new Error("proxy unavailable"); }
  if (!active || owner.signal.aborted) { await revoke(); throw new Error("browser binding cancelled"); }
  const address = server.address();
  if (!address || typeof address === "string") { await revoke(); throw new Error("proxy unavailable"); }
  const endpoint = Object.freeze({ host: "127.0.0.1" as const, port: address.port, realm });
  return {
    endpoint, revoke,
    credentialsFor(challenge) {
      return active && !owner.signal.aborted && challenge.isProxy && challenge.webContentsId === owner.webContentsId
        && challenge.host === endpoint.host && challenge.port === endpoint.port && challenge.realm === realm && challenge.scheme === "basic"
        ? { username, password } : null;
    },
  };
}
