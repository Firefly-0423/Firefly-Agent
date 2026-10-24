import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createBrowserService, type BrowserGuestPort, type BrowserHostPort } from "./browser-service";
import type { BrowserSessionPort } from "./browser-network-binding";
import type { ConnectProxy } from "./authenticated-connect-proxy";
import { registerManualBrowserHostOwner } from "./browser-host-owner";
import type { BrowserRequestDetails } from "./browser-request-policy";

/** Window-owned manual workspace over the real network/domain controllers. Fakes stop at Electron. */
function fixture(options: { direct?: boolean; conversation?: boolean } = {}) {
  const profile = {}, effects: string[] = [], topFrame = {};
  const host: BrowserHostPort = Object.assign(new EventEmitter(), { webContents: Object.assign(new EventEmitter(), { id: 10, mainFrame: topFrame, isDestroyed: () => false }),
    isDestroyed: () => false, isVisible: () => true, isFocused: () => true, getContentSize: (): [number, number] => [800, 600], contentView: { addChildView: () => {}, removeChildView: () => {} } });
  const sender = { sender: host.webContents, senderFrame: topFrame };
  const guests: BrowserGuestPort<object>[] = [], changed: Array<Record<string, unknown>> = [];
  const callbacks: Parameters<BrowserGuestPort<object>["installCallbacks"]>[0][] = [];
  const requests: Array<(request: BrowserRequestDetails) => boolean> = [];
  const confirm = vi.fn(async () => true);
  const service = createBrowserService({ profile, gateOpen: false, manualBrowsing: true, confirmPermission: confirm,
    permissionPolicy: { hosts: ["example.com"], actions: ["navigate", "observe", "click", "type"] },
    onChanged: (_owner, state) => changed.push({ ...state } as Record<string, unknown>),
    createSession: () => {
      const session = {};
      const port: BrowserSessionPort<object> = { session, persistent: false,
        installRequestHandler: handler => { requests.push(handler); }, denyPermissions: () => {},
        setProxy: async () => { effects.push("setProxy"); },
        ...(options.direct === false ? {} : { setDirect: async () => { effects.push("setDirect"); } }),
        closeAllConnections: async () => {}, clearStorageData: async () => {}, clearCache: async () => {},
        clearAuthCache: async () => {}, clearHostResolverCache: async () => {}, runningWorkerCount: () => 0 };
      return port;
    },
    createView: session => {
      let destroyed = false, url = "";
      const contents = { id: 20 + guests.length, session, isDestroyed: () => destroyed };
      const guest: BrowserGuestPort<object> = { contents, loadURL: async target => { effects.push("load:" + target); url = target; },
        history: async () => {}, snapshot: () => ({ url, canGoBack: false, canGoForward: false }), stop: () => {}, attach: () => {}, detach: () => {},
        setBounds: () => {}, destroy: () => { destroyed = true; }, installCallbacks: next => { callbacks.push(next); } };
      guests.push(guest); return guest;
    },
    proxyFactory: async () => { effects.push("proxyStart"); return { endpoint: { host: "127.0.0.1", port: 1234, realm: "fixture" }, credentialsFor: () => ({ username: "o", password: "o" }), revoke: async () => { effects.push("proxyRevoke"); } } satisfies ConnectProxy; },
    cleanupTimeoutMs: 100, workerStopTimeoutMs: 30,
  });
  if (options.conversation) {
    const owner = Object.freeze({ host, topFrame, profile, conversationId: "chat-a", ownerSessionId: "s", generation: 1, signal: new AbortController().signal });
    service.registerHost(host, () => owner);
  } else registerManualBrowserHostOwner({ host, profile, service });
  const scope = (hosts: string[], resourceHosts: string[] = [], extra: Record<string, unknown> = {}) => ({ mode: "manual", hosts, resourceHosts, actions: ["navigate"], ...extra });
  return { service, sender, effects, guests, changed, callbacks, requests, confirm, scope,
    grant: (hosts: string[], resourceHosts: string[] = [], extra: Record<string, unknown> = {}) => service.dispatchPermission(sender, { kind: "request", scope: scope(hosts, resourceHosts, extra) }),
    open: (url: string) => service.dispatch(sender, { kind: "open", url }) };
}
const req = (url: string, resourceType = "mainFrame") => ({ url, method: "GET", resourceType });

describe("private-network manual browsing in the service", () => {
  it("connects directly with no public proxy and admits only the granted authority", async () => {
    const f = fixture();
    expect(await f.grant(["192.168.1.5:5173"])).toMatchObject({ ok: true, value: { status: "granted", scope: { hosts: ["192.168.1.5:5173"] } } });
    expect(await f.open("http://192.168.1.5:5173/app")).toMatchObject({ ok: true, value: { url: "http://192.168.1.5:5173/app", workspaceId: expect.any(String) } });
    expect(f.effects).toContain("setDirect"); expect(f.effects).not.toContain("setProxy"); expect(f.effects).not.toContain("proxyStart");
    expect(f.requests[0](req("http://192.168.1.5:5173/x"))).toBe(true);
    for (const url of ["http://192.168.1.5:22/", "http://localhost:5173/", "https://example.com/", "http://169.254.169.254/"]) expect(f.requests[0](req(url)), url).toBe(false);
    await f.service.dispose();
  });

  it("keeps the public path on the authenticated proxy", async () => {
    const f = fixture();
    await f.grant(["example.com"]); await f.open("https://example.com/");
    expect(f.effects).toContain("proxyStart"); expect(f.effects).toContain("setProxy"); expect(f.effects).not.toContain("setDirect");
    await f.service.dispose();
  });

  it("opens a private page only under a matching private grant, and a public page only under a public one", async () => {
    const f = fixture();
    expect(await f.open("http://localhost:5173/")).toEqual({ ok: false, code: "permission_denied" }); // no grant
    await f.grant(["localhost:5173"]);
    expect(await f.open("http://localhost:3000/")).toEqual({ ok: false, code: "blocked_url" }); // other port
    expect(await f.open("http://127.0.0.1:5173/")).toEqual({ ok: false, code: "blocked_url" }); // other spelling
    expect(await f.open("https://example.com/")).toEqual({ ok: false, code: "blocked_url" });
    expect(await f.open("http://localhost:5173/login")).toMatchObject({ ok: true }); // local apps may have /login
    await f.service.dispose();
    const g = fixture();
    await g.grant(["example.com"]);
    expect(await g.open("http://localhost:5173/")).toEqual({ ok: false, code: "blocked_url" });
    expect(await g.open("https://example.com/login")).toEqual({ ok: false, code: "blocked_url" }); // public login filter intact
    await g.service.dispose();
  });

  it("rejects malformed, widened or agent-tagged private scopes before any prompt", async () => {
    const f = fixture();
    const denied = { ok: false, code: "permission_denied" };
    expect(await f.grant(["localhost"])).toEqual(denied);
    expect(await f.grant(["169.254.169.254:80"])).toEqual(denied);
    expect(await f.grant(["localhost:5173", "localhost:3000"])).toEqual(denied);
    expect(await f.grant(["LOCALHOST:5173"])).toEqual(denied);
    expect(await f.grant(["localhost:05173"])).toEqual(denied);
    expect(await f.grant(["localhost:5173"], ["127.0.0.1:3000"])).toEqual(denied);
    expect(await f.grant(["localhost:5173"], ["example.com"])).toEqual(denied);
    expect(await f.grant(["example.com"], ["localhost:3000"])).toEqual(denied);
    expect(await f.grant(["localhost:5173"], ["localhost:1", "localhost:2", "localhost:3", "localhost:4", "localhost:5", "localhost:6", "localhost:7", "localhost:8", "localhost:9"])).toEqual(denied);
    expect(await f.service.dispatchPermission(f.sender, { kind: "request", scope: { mode: "agent", hosts: ["localhost:5173"], actions: ["navigate"] } })).toEqual(denied);
    expect(f.confirm).not.toHaveBeenCalled(); await f.service.dispose();
  });

  it("reports a private grant as manual with no Agent proposal", async () => {
    const f = fixture();
    await f.grant(["localhost:5173"]);
    const reply = await f.service.dispatchPermission(f.sender, { kind: "get" });
    expect(reply).toMatchObject({ ok: true, value: { scope: { mode: "manual", hosts: ["localhost:5173"] }, status: "granted" } });
    expect(JSON.stringify(reply)).not.toContain("agentScope");
    await f.service.dispose();
  });

  it("fails closed when the session cannot connect directly", async () => {
    const f = fixture({ direct: false });
    await f.grant(["localhost:5173"]);
    expect(await f.open("http://localhost:5173/")).toMatchObject({ ok: false });
    expect(f.effects).not.toContain("setProxy"); expect(f.effects).not.toContain("proxyStart");
    await f.service.dispose();
  });

  it("does not let a page link, redirect or script switch network class", async () => {
    const f = fixture();
    await f.grant(["localhost:5173"]); await f.open("http://localhost:5173/");
    expect(f.callbacks[0].allowsNavigation("https://example.com/")).toBe(false);
    expect(f.changed.at(-1)).toMatchObject({ blockedRequest: true }); expect(f.changed.at(-1)?.blockedNavigationUrl).toBeUndefined();
    expect(f.callbacks[0].allowsNavigation("http://localhost:3000/")).toBe(false);
    expect(f.changed.at(-1)?.blockedNavigationUrl).toBeUndefined();
    await f.service.dispose();
    const g = fixture();
    await g.grant(["example.com"]); await g.open("https://example.com/");
    for (const url of ["http://localhost:5173/", "http://192.168.1.5/", "http://127.0.0.1:8080/"]) {
      expect(g.callbacks[0].allowsNavigation(url), url).toBe(false);
      expect(g.changed.at(-1)?.blockedNavigationUrl, url).toBeUndefined();
      expect(g.changed.at(-1)).toMatchObject({ blockedRequest: true });
    }
    expect(g.callbacks[0].allowsNavigation("https://elsewhere.example/")).toBe(false);
    expect(g.changed.at(-1)).toMatchObject({ blockedNavigationUrl: "https://elsewhere.example/" }); // public flow unchanged
    await g.service.dispose();
  });

  it("offers extra ports of the same host only, after the page requested them", async () => {
    const f = fixture();
    await f.grant(["localhost:5173"]);
    const opened = await f.open("http://localhost:5173/");
    if (!opened.ok || !opened.value) throw Error("missing page");
    expect(f.requests[0]({ url: "http://localhost:3000/api", method: "GET", resourceType: "xhr" })).toBe(false);
    expect(f.requests[0]({ url: "ws://localhost:24678/", method: "GET", resourceType: "webSocket" })).toBe(false);
    expect(f.requests[0]({ url: "http://192.168.1.9:3000/api", method: "GET", resourceType: "xhr" })).toBe(false);
    expect(f.requests[0]({ url: "https://tracker.example/x", method: "GET", resourceType: "script" })).toBe(false);
    expect(f.changed.at(-1)).toMatchObject({ blockedResourceHosts: ["localhost:3000", "localhost:24678"] });
    const page = f.changed.at(-1) as { browserId: string; requestId: number };
    // Unlisted authority is refused even with a valid source page.
    expect(await f.grant(["localhost:5173"], ["localhost:9999"], { sourceBrowserId: page.browserId, sourceRequestId: page.requestId })).toEqual({ ok: false, code: "permission_denied" });
    expect(await f.grant(["localhost:5173"], ["localhost:3000", "localhost:24678"], { sourceBrowserId: page.browserId, sourceRequestId: page.requestId })).toMatchObject({ ok: true, value: { status: "granted" } });
    expect(await f.open("http://localhost:5173/")).toMatchObject({ ok: true });
    expect(f.requests[1]({ url: "http://localhost:3000/api", method: "GET", resourceType: "xhr" })).toBe(true);
    expect(f.requests[1]({ url: "ws://localhost:24678/", method: "GET", resourceType: "webSocket" })).toBe(true);
    expect(f.requests[1]({ url: "http://localhost:3000/", method: "GET", resourceType: "mainFrame" })).toBe(false);
    expect(f.requests[1]({ url: "http://localhost:3000/", method: "POST", resourceType: "xhr" })).toBe(false);
    await f.service.dispose();
  });

  describe("ordinary web browsing grant", () => {
    const web = (extra: Record<string, unknown> = {}) => ({ mode: "manual", web: true, hosts: [], resourceHosts: [], actions: ["navigate"], ...extra });
    const request = (f: ReturnType<typeof fixture>, scope: unknown) => f.service.dispatchPermission(f.sender, { kind: "request", scope });

    it("opens any public HTTPS page through the authenticated proxy, sign-in pages included", async () => {
      const f = fixture();
      expect(await request(f, web())).toMatchObject({ ok: true, value: { status: "granted", scope: { web: true, hosts: [] } } });
      expect(await f.open("https://news.example/path")).toMatchObject({ ok: true, value: { url: "https://news.example/path" } });
      expect(f.effects).toContain("proxyStart"); expect(f.effects).toContain("setProxy"); expect(f.effects).not.toContain("setDirect");
      expect(await f.service.dispatch(f.sender, { kind: "navigate", browserId: (f.changed.at(-1) as { browserId: string }).browserId, url: "https://accounts.other.example/login?next=/" })).toMatchObject({ ok: true });
      await f.service.dispose();
    });

    it("lets the page use third-party hosts, forms and sockets, but not private or non-HTTPS targets", async () => {
      const f = fixture();
      await request(f, web()); await f.open("https://news.example/");
      const send = (url: string, resourceType: string, method = "GET") => f.requests[0]({ url, method, resourceType });
      expect(send("https://cdn.fonts.example/a.woff2", "font")).toBe(true);
      expect(send("https://api.news.example/submit", "xhr", "POST")).toBe(true);
      expect(send("wss://live.news.example/feed", "webSocket")).toBe(true);
      for (const url of ["http://news.example/", "https://localhost/", "https://192.168.1.5/", "http://localhost:5173/", "https://169.254.169.254/", "https://news.example:8443/"]) {
        expect(send(url, "xhr"), url).toBe(false); expect(send(url, "mainFrame"), url).toBe(false);
      }
      await f.service.dispose();
    });

    it("never offers per-site or per-resource approval, and a page link cannot reach a private address", async () => {
      const f = fixture();
      await request(f, web()); await f.open("https://news.example/");
      f.requests[0]({ url: "http://localhost:5173/x", method: "GET", resourceType: "script" });
      f.requests[0]({ url: "https://news.example:8443/x", method: "GET", resourceType: "script" });
      expect(f.changed.at(-1)).toMatchObject({ blockedRequest: true });
      expect(f.changed.at(-1)?.blockedResourceHosts ?? []).toEqual([]);
      for (const url of ["http://localhost:5173/", "http://192.168.1.5/", "http://127.0.0.1:8080/"]) {
        expect(f.callbacks[0].allowsNavigation(url), url).toBe(false);
        expect(f.changed.at(-1)?.blockedNavigationUrl, url).toBeUndefined();
      }
      expect(f.callbacks[0].allowsNavigation("https://another.example/")).toBe(true);
      await f.service.dispose();
    });

    it("refuses web scopes that carry lists, provenance, Agent tags or a conversation owner", async () => {
      const f = fixture(), denied = { ok: false, code: "permission_denied" };
      expect(await request(f, web({ hosts: ["example.com"] }))).toEqual(denied);
      expect(await request(f, web({ resourceHosts: ["cdn.example"] }))).toEqual(denied);
      expect(await request(f, web({ sourceBrowserId: "x", sourceRequestId: 1 }))).toEqual(denied);
      expect(await request(f, web({ actions: ["navigate", "click"] }))).toEqual(denied);
      expect(await request(f, web({ mode: "agent" }))).toEqual(denied);
      expect(await request(f, { mode: "manual", web: "yes", hosts: [], resourceHosts: [], actions: ["navigate"] })).toEqual(denied);
      expect(await request(f, { mode: "manual", web: false, hosts: ["example.com"], resourceHosts: [], actions: ["navigate"] })).toEqual(denied);
      await f.service.dispose();
      const c = fixture({ conversation: true });
      expect(await request(c, web())).toEqual(denied);
      await c.service.dispose();
    });

    it("keeps a web grant public-only: a private address needs its own explicit grant and clears the page", async () => {
      const f = fixture();
      await request(f, web()); await f.open("https://news.example/");
      expect(await f.open("http://localhost:5173/")).toEqual({ ok: false, code: "blocked_url" }); // the web grant never names a private address
      await f.grant(["localhost:5173"]);
      expect(f.requests[0]({ url: "https://news.example/", method: "GET", resourceType: "mainFrame" })).toBe(false);
      expect(await f.open("http://localhost:5173/")).toMatchObject({ ok: true });
      expect(f.effects).toContain("setDirect");
      await f.service.dispose();
    });
  });

  it("clears the page and asks again when switching between networks", async () => {
    const f = fixture();
    await f.grant(["example.com"]); await f.open("https://example.com/");
    await f.grant(["localhost:5173"]);
    expect(f.confirm).toHaveBeenCalledTimes(2);
    expect(f.requests[0](req("https://example.com/"))).toBe(false); // old public domain revoked
    expect(await f.open("http://localhost:5173/")).toMatchObject({ ok: true });
    expect(f.requests[1](req("https://example.com/"))).toBe(false);
    await f.service.dispose();
  });
});
