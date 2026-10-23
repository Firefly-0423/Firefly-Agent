import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createBrowserService, type BrowserGuestPort, type BrowserHostPort, type TrustedBrowserOwner } from "./browser-service";
import type { BrowserSessionPort } from "./browser-network-binding";
import type { ConnectProxy } from "./authenticated-connect-proxy";
import { registerManualBrowserHostOwner } from "./browser-host-owner";
import { createActiveChatTargetRegistry } from "../plugin-host/active-chat-target";
import type { WebContents } from "electron";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture(gateOpen = true, confirmPermission?: () => Promise<boolean>, manualBrowsing = false, windowOwned = false, agentSiteSelection = false) {
  const profile = {}, abort = new AbortController(), effects: string[] = [], frames = new EventEmitter();
  const topFrame = {}, hostEvents = new EventEmitter();
  const host: BrowserHostPort = Object.assign(hostEvents, { webContents: Object.assign(frames, { id: 10, mainFrame: topFrame, isDestroyed: () => false }),
    isDestroyed: () => false, isVisible: () => true, isFocused: () => true, getContentSize: (): [number, number] => [800, 600], contentView: { addChildView: () => {}, removeChildView: () => {} } });
  let owner: TrustedBrowserOwner = Object.freeze({ host, topFrame, profile, conversationId: "a", ownerSessionId: "manual-a", generation: 1, signal: abort.signal });
  const sender = { sender: host.webContents, senderFrame: topFrame };
  const sessions: object[] = [], guests: BrowserGuestPort<object>[] = [], changed: unknown[] = [];
  const callbacks: Parameters<BrowserGuestPort<object>["installCallbacks"]>[0][] = [];
  const requests: Array<(request: import("./browser-request-policy").BrowserRequestDetails) => boolean> = [];
  let nextLoad = async () => {};
  let nextProxy = async () => {};
  let nextObservation = async () => {};
  let nextAction = async () => {};
  let proxyOwner: Parameters<import("./browser-domain-proxy").BrowserProxyFactory>[0];
  const service = createBrowserService({ profile, gateOpen, manualBrowsing, agentSiteSelection, ...(confirmPermission ? { permissionPolicy: { hosts: ["example.com", "github.com"], actions: ["navigate", "observe", "click", "type"] }, confirmPermission } : {}), onChanged: (_owner, state) => changed.push(state),
    createSession: () => {
      const session = {}; sessions.push(session); effects.push("session");
      const port: BrowserSessionPort<object> = { session, persistent: false,
        installRequestHandler: handler => { requests.push(handler); effects.push("deny"); }, denyPermissions: () => { effects.push("permissions"); },
        setProxy: async () => { effects.push("setProxy"); await nextProxy(); }, closeAllConnections: async () => { effects.push("connections"); },
        clearStorageData: async () => { effects.push("storage"); }, clearCache: async () => { effects.push("cache"); },
        clearAuthCache: async () => { effects.push("auth"); }, clearHostResolverCache: async () => { effects.push("resolver"); }, runningWorkerCount: () => 0 };
      return port;
    },
    createView: (session) => {
      effects.push("view"); let destroyed = false, url = "";
      const contents = { id: 20 + guests.length, session, isDestroyed: () => destroyed };
      const guest: BrowserGuestPort<object> = { contents,
        observe: async () => { effects.push("observe"); await nextObservation(); return { snapshotId: "observed", url, title: "Example", text: "Public text", elements: [{ ref: "1", tag: "button", role: "button", name: "Count" }] }; },
        act: async input => { effects.push(input.kind + ":" + ("ref" in input ? input.ref : "")); await nextAction(); return true; },
        loadURL: async (target) => { effects.push("load:" + target); await nextLoad(); url = target; },
        history: async action => { effects.push(action); }, snapshot: () => ({ url, canGoBack: true, canGoForward: false }),
        stop: () => { effects.push("stop"); }, attach: () => { effects.push("attach"); }, detach: () => { effects.push("detach"); },
        setBounds: bounds => { effects.push("bounds:" + JSON.stringify(bounds)); },
        destroy: () => { effects.push("destroy"); destroyed = true; }, installCallbacks: next => { callbacks.push(next); } };
      guests.push(guest); return guest;
    },
    proxyFactory: async input => { proxyOwner = input; return { endpoint: { host: "127.0.0.1", port: 1234, realm: "fixture" }, credentialsFor: () => ({ username: "opaque", password: "opaque" }), revoke: async () => { effects.push("proxyRevoke"); } } satisfies ConnectProxy; },
    cleanupTimeoutMs: 100, workerStopTimeoutMs: 30,
  });
  const manualHost = windowOwned ? registerManualBrowserHostOwner({ host, profile, service }) : undefined;
  if (!manualHost) service.registerHost(host, () => owner);
  return { service, host, sender, profile, abort, effects, guests, sessions, changed, callbacks, requests, owner: () => manualHost?.getCurrentOwner() ?? owner,
    beginConnection: (host: string) => proxyOwner?.beginConnection?.(host),
    swap: () => { owner = Object.freeze({ ...owner, conversationId: "b", ownerSessionId: "manual-b", generation: 2 }); },
    delayAction: (operation: () => Promise<void>) => { nextAction = operation; },
    delayObservation: (operation: () => Promise<void>) => { nextObservation = operation; },
    delayLoad: (operation: () => Promise<void>) => { nextLoad = operation; }, delayProxy: (operation: () => Promise<void>) => { nextProxy = operation; } };
}

async function showPage(f: ReturnType<typeof fixture>): Promise<void> {
  const page = await f.service.dispatch(f.sender, { kind: "get" });
  if (!page.ok || !page.value) throw new Error("missing page");
  expect(await f.service.dispatch(f.sender, { kind: "layout", browserId: page.value.browserId,
    bounds: { x: 0, y: 0, width: 300, height: 200 } })).toMatchObject({ ok: true });
}

describe("manual window workspace with the real network/domain controller", () => {
  it("does not pick a precise cause when same-host connection failures disagree", async () => {
    const f = fixture(); f.delayLoad(async () => {
      f.beginConnection("example.com")?.("restricted_address"); f.beginConnection("example.com")?.("dns_failed");
      throw Object.assign(Error("failed"), { errno: -111 });
    });
    try { expect(await f.service.dispatch(f.sender, { kind: "open", url: "https://example.com/" })).toEqual({ ok: false, code: "load_failed" }); }
    finally { await f.service.dispose(); }
  });
  it("propagates the diagnostic through executeAgent and ignores non-tunnel native failures", async () => {
    const f = fixture(false, async () => true);
    await f.service.dispatchPermission(f.sender, { kind: "request", scope: { hosts: ["example.com"], actions: ["navigate"] } });
    f.delayLoad(async () => { f.beginConnection("example.com")?.("connection_failed"); throw Object.assign(Error("secret"), { errno: -111 }); });
    const run = { conversationId: "a", runId: "run", signal: new AbortController().signal, isCurrent: () => true };
    try {
      expect(await f.service.executeAgent(f.owner(), { operation: "open", url: "https://example.com/" }, run)).toEqual({ ok: false, code: "connection_failed" });
      f.callbacks[0].started("https://example.com/link"); f.beginConnection("example.com")?.("restricted_address");
      f.callbacks[0].failed(-202, "https://example.com/link");
      expect(f.changed.at(-1)).toMatchObject({ error: "load_failed" });
      f.callbacks[0].started("https://example.com/retry"); f.beginConnection("example.com")?.("dns_timeout");
      f.callbacks[0].failed(-111, "https://example.com/obsolete");
      expect(f.changed.at(-1)).toMatchObject({ loading: true, error: null });
      f.callbacks[0].failed(-111, "https://example.com/retry");
      expect(f.changed.at(-1)).toMatchObject({ loading: false, error: "dns_timeout" });
    } finally { await f.service.dispose(); }
  });
  it.each(["navigate", "history"])("tracks approved cross-host targets during %s", async kind => {
    const f = fixture();
    const opened = await f.service.dispatch(f.sender, { kind: "open", url: "https://example.com/" });
    if (!opened.ok || !opened.value) throw Error("missing page");
    const failed = async () => {
      f.callbacks[0].started("https://github.com/");
      f.beginConnection("github.com")?.("dns_failed");
      throw Object.assign(Error("private"), { errno: -111 });
    };
    f.delayLoad(failed); f.guests[0].history = failed;
    try {
      expect(await f.service.dispatch(f.sender, { kind, browserId: opened.value.browserId, url: "https://example.com/next", action: "back" })).toEqual({ ok: false, code: "dns_failed" });
    } finally { await f.service.dispose(); }
  });
  it.each([true, false])("keeps precise tunnel errors and clears them on recovery (manual=%s)", async manual => {
    const f = fixture(false, async () => true, manual, manual);
    await f.service.dispatchPermission(f.sender, { kind: "request", scope: manual ? { mode: "manual", web: true, hosts: [], actions: ["navigate"] } : { hosts: ["example.com"], actions: ["navigate"] } });
    f.delayLoad(async () => { f.beginConnection("example.com")?.("restricted_address"); throw Object.assign(new Error("secret"), { code: "ERR_TUNNEL_CONNECTION_FAILED" }); });
    expect(await f.service.dispatch(f.sender, { kind: "open", url: "https://example.com/?private=query" })).toEqual({ ok: false, code: "restricted_address" });
    const page = await f.service.dispatch(f.sender, { kind: "get" }); if (!page.ok || !page.value) throw Error("missing page");
    expect(page.value.error).toBe("restricted_address"); f.delayLoad(async () => {});
    expect(await f.service.dispatch(f.sender, { kind: "navigate", browserId: page.value.browserId, url: "https://example.com/" })).toMatchObject({ ok: true, value: { error: null } }); await f.service.dispose();
  });
  it("ignores previous-request diagnostics after a new same-host navigation starts", async () => {
    const f = fixture(); await f.service.dispatch(f.sender, { kind: "open", url: "https://example.com/" });
    let stale: ((code: import("../../shared/manual-browser").BrowserConnectionError) => void) | undefined;
    const hold = deferred<void>(); f.delayLoad(async () => { stale = f.beginConnection("example.com"); await hold.promise; });
    const page = await f.service.dispatch(f.sender, { kind: "get" }); if (!page.ok || !page.value) throw Error("missing page");
    const older = f.service.dispatch(f.sender, { kind: "navigate", browserId: page.value.browserId, url: "https://example.com/old" });
    await vi.waitFor(() => expect(stale).toBeTypeOf("function"));
    f.delayLoad(async () => { stale?.("restricted_address"); throw Object.assign(Error("failed"), { code: "ERR_TUNNEL_CONNECTION_FAILED" }); });
    expect(await f.service.dispatch(f.sender, { kind: "navigate", browserId: page.value.browserId, url: "https://example.com/new" })).toEqual({ ok: false, code: "load_failed" });
    hold.resolve(); await older; await f.service.dispose();
  });
  it("can obtain native site consent and browse without an active conversation", async () => {
    const f = fixture(false, async () => true, true, true);
    const owner = f.owner();
    expect(await f.service.dispatchPermission(f.sender, { kind: "get" })).toMatchObject({ ok: true,
      value: { conversationId: null, workspaceId: owner.workspaceId, status: "required" } });
    expect(f.sessions).toHaveLength(0);
    expect(await f.service.dispatchPermission(f.sender, { kind: "request", scope: manualScope() })).toMatchObject({ ok: true, value: { status: "granted" } });
    expect(await f.service.dispatch(f.sender, { kind: "open", url: "https://public.example/" })).toMatchObject({ ok: true,
      value: { conversationId: null, workspaceId: owner.workspaceId, url: "https://public.example/" } });
    expect(f.sessions).toHaveLength(1); await f.service.dispose();
  });
  it("preserves the native page, lease and history across conversation/mode changes and hides", async () => {
    const f = fixture(false, async () => true, true, true), targets = createActiveChatTargetRegistry();
    await f.service.dispatchPermission(f.sender, { kind: "request", scope: manualScope() });
    const opened = await f.service.dispatch(f.sender, { kind: "open", url: "https://public.example/article" });
    expect(opened.ok).toBe(true); if (!opened.ok || !opened.value) throw Error("missing page");
    const guest = f.guests[0], before = [...f.effects];
    for (const mode of ["chat", "work", "code"] as const) {
      targets.setActive({ sender: f.host.webContents as unknown as WebContents, sessionId: mode, mode, rendererTargetId: "r" });
      expect(await f.service.dispatch(f.sender, { kind: "get" })).toMatchObject({ ok: true, value: opened.value });
    }
    targets.clearActive(f.host.webContents as unknown as WebContents); targets.notifySessionDeleted("code");
    (f.host as unknown as EventEmitter).emit("hide"); (f.host as unknown as EventEmitter).emit("blur");
    expect(f.guests[0]).toBe(guest); expect(f.sessions).toHaveLength(1);
    expect(f.effects.slice(before.length)).not.toContain("destroy"); expect(f.effects.slice(before.length)).not.toContain("storage");
    expect(f.callbacks[0].allowsNavigation("https://public.example/next")).toBe(true);
    expect(await f.service.dispatch(f.sender, { kind: "history", browserId: opened.value.browserId, action: "back" })).toMatchObject({ ok: true });
    targets.dispose(); await f.service.dispose();
  });
  it("never grants Agent access to a window workspace or lets an old conversation revoke it", async () => {
    const f = fixture(false, async () => true, true, true), owner = f.owner();
    expect(await f.service.dispatchPermission(f.sender, { kind: "request", scope })).toEqual({ ok: false, code: "permission_denied" });
    await f.service.dispatchPermission(f.sender, { kind: "request", scope: manualScope() });
    const opened = await f.service.dispatch(f.sender, { kind: "open", url: "https://public.example/" });
    expect(opened.ok).toBe(true);
    expect(await f.service.dispatchPermission(f.sender, { kind: "revoke", conversationId: "a" })).toEqual({ ok: false, code: "owner_mismatch" });
    expect(await f.service.dispatchPermission(f.sender, { kind: "revoke", workspaceId: "old-window" })).toEqual({ ok: false, code: "owner_mismatch" });
    const run = { conversationId: "a", runId: "run", signal: new AbortController().signal, isCurrent: () => true };
    expect(await f.service.executeAgent(owner, { operation: "observe" }, run)).toEqual({ ok: false, code: "owner_mismatch" });
    expect(await f.service.dispatchPermission(f.sender, { kind: "revoke", workspaceId: owner.workspaceId })).toMatchObject({ ok: true, value: { status: "required" } });
    expect(f.effects).toContain("destroy"); expect(f.effects).toContain("storage"); await f.service.dispose();
  });
});

describe("Main browser service using the real Session/epoch controller", () => {
  it("stops only the current navigation and preserves the permission, page and network lease", async () => {
    const f = fixture(false, async () => true);
    await f.service.dispatchPermission(f.sender, { kind: "request", scope: { hosts: ["example.com"], actions: ["navigate"] } });
    const opened = await f.service.dispatch(f.sender, { kind: "open", url: "https://example.com/" });
    if (!opened.ok || !opened.value) throw Error("missing initial page");
    const browserId = opened.value.browserId, wait = deferred<void>();
    f.delayLoad(() => wait.promise);
    const pending = f.service.dispatch(f.sender, { kind: "navigate", browserId, url: "https://example.com/pending" });
    await vi.waitFor(() => expect(f.effects).toContain("load:https://example.com/pending"));
    const stopped = await f.service.dispatch(f.sender, { kind: "stop", browserId });
    expect(stopped).toMatchObject({ ok: true, value: { browserId, url: "https://example.com/", loading: false, closed: false, error: null, pendingUrl: null } });
    expect(f.effects).toContain("stop"); expect(f.effects).not.toContain("destroy"); expect(f.effects).not.toContain("proxyRevoke");
    expect(await f.service.dispatchPermission(f.sender, { kind: "get" })).toMatchObject({ ok: true, value: { status: "granted" } });
    wait.resolve(); expect(await pending).toEqual({ ok: false, code: "cancelled" });
    expect(await f.service.dispatch(f.sender, { kind: "get" })).toEqual(stopped);
    f.delayLoad(async () => {});
    expect(await f.service.dispatch(f.sender, { kind: "navigate", browserId, url: "https://example.com/after-stop" })).toMatchObject({ ok: true, value: { loading: false, url: "https://example.com/after-stop" } });
    await f.service.dispose();
  });
  it("fails closed if the native stop throws instead of reporting a successful stop", async () => {
    const f = fixture(false, async () => true);
    await f.service.dispatchPermission(f.sender, { kind: "request", scope: { hosts: ["example.com"], actions: ["navigate"] } });
    const opened = await f.service.dispatch(f.sender, { kind: "open", url: "https://example.com/" });
    if (!opened.ok || !opened.value) throw Error("missing page");
    const wait = deferred<void>(), browserId = opened.value.browserId; f.delayLoad(() => wait.promise);
    const pending = f.service.dispatch(f.sender, { kind: "navigate", browserId, url: "https://example.com/pending" });
    await vi.waitFor(() => expect(f.effects).toContain("load:https://example.com/pending"));
    f.guests[0].stop = () => { throw new Error("native stop failed"); };
    const stopped = await f.service.dispatch(f.sender, { kind: "stop", browserId });
    expect(stopped.ok).toBe(false); expect(f.effects).toContain("destroy"); expect(f.effects).toContain("proxyRevoke");
    expect(await f.service.dispatchPermission(f.sender, { kind: "get" })).toMatchObject({ ok: true, value: { status: "required" } });
    expect(f.changed.at(-1)).toMatchObject({ closed: true, loading: false, error: "cleanup_failed" });
    wait.resolve(); await pending; await f.service.dispose();
  });
  it("also reports failed cleanup when stopping a page-initiated navigation throws", async () => {
    const f = fixture(), opened = await f.service.dispatch(f.sender, { kind: "open", url: "https://example.com/" });
    if (!opened.ok || !opened.value) throw Error("missing page");
    f.callbacks[0].started("https://example.com/from-link");
    f.guests[0].stop = () => { throw new Error("native stop failed"); };
    expect(await f.service.dispatch(f.sender, { kind: "stop", browserId: opened.value.browserId })).toEqual({ ok: false, code: "cleanup_failed" });
    expect(f.changed.at(-1)).toMatchObject({ closed: true, error: "cleanup_failed" });
    expect(f.effects).toContain("destroy"); await f.service.dispose();
  });
  it("rejects stop from a foreign frame without touching the owned page", async () => {
    const f = fixture(), opened = await f.service.dispatch(f.sender, { kind: "open", url: "https://example.com/" });
    if (!opened.ok || !opened.value) throw Error("missing page");
    const effects = [...f.effects];
    expect(await f.service.dispatch({ ...f.sender, senderFrame: {} }, { kind: "stop", browserId: opened.value.browserId })).toEqual({ ok: false, code: "owner_mismatch" });
    expect(f.effects).toEqual(effects); await f.service.dispose();
  });
  it("default closed gate has zero Session/view/proxy/navigation effects", async () => {
    const f = fixture(false); expect(await f.service.dispatch(f.sender, { kind: "open", url: "https://example.com/" })).toEqual({ ok: false, code: "network_unavailable" }); expect(f.effects).toEqual([]);
  });
  it("renderer DNS/config/factory fields cannot open the gate or permit private pages", async () => {
    const forged = { trustedResolver: { server: "127.0.0.1", port: 53 }, resolve: () => [], proxyFactory: () => {}, gateOpen: true };
    const closed = fixture(false);
    expect(await closed.service.dispatch(closed.sender, { kind: "open", url: "https://example.com/", ...forged })).toEqual({ ok: false, code: "network_unavailable" });
    expect(closed.effects).toEqual([]);
    const open = fixture();
    expect(await open.service.dispatch(open.sender, { kind: "open", url: "https://192.168.31.1/", ...forged })).toEqual({ ok: false, code: "blocked_url" });
    expect(open.effects).toEqual([]); await closed.service.dispose(); await open.service.dispose();
  });
  it("public renderer commands cannot choose a resolver or replace the trusted factory", async () => {
    const f = fixture(), resolve = vi.fn(), proxyFactory = vi.fn();
    expect((await f.service.dispatch(f.sender, { kind: "open", url: "https://example.com/", trustedResolver: { server: "127.0.0.1", port: 53 }, resolve, proxyFactory })).ok).toBe(true);
    expect(resolve).not.toHaveBeenCalled(); expect(proxyFactory).not.toHaveBeenCalled();
    expect(f.effects).toContain("setProxy"); expect(f.effects).toContain("load:https://example.com/"); await f.service.dispose();
  });
  it("rejects forged frame/host/profile and an unregistered owner before allocation", async () => {
    const f = fixture();
    expect((await f.service.dispatch({ ...f.sender, senderFrame: {} }, { kind: "open", url: "https://example.com/" })).ok).toBe(false);
    expect(await f.service.execute({ ...f.owner() }, { kind: "open", url: "https://example.com/" })).toEqual({ ok: false, code: "owner_mismatch" }); expect(f.effects).toEqual([]);
  });
  it.each(["file:///x", "http://example.com", "https://127.0.0.1", "https://[::1]", "https://example.com:444", "https://u:p@example.com", "javascript:alert(1)"])("refuses %s before allocation", async url => {
    const f = fixture(); expect(await f.service.dispatch(f.sender, { kind: "open", url })).toEqual({ ok: false, code: "blocked_url" }); expect(f.effects).toEqual([]);
  });
  it("prepares actual network domain before load and attaches only with clipped explicit bounds", async () => {
    const f = fixture(), result = await f.service.dispatch(f.sender, { kind: "open", url: "https://example.com/" });
    expect(result.ok).toBe(true); if (!result.ok || !result.value) throw Error("page missing");
    expect(f.effects.slice(0, 7)).toEqual(["session", "deny", "permissions", "view", "setProxy", "connections", "load:https://example.com/"]);
    expect(f.effects).not.toContain("attach"); expect(result.value.loading).toBe(false); expect(result.value.url).toBe("https://example.com/");
    const layout = await f.service.dispatch(f.sender, { kind: "layout", browserId: result.value.browserId, bounds: { x: 700, y: 500, width: 400, height: 400 } });
    expect(layout.ok).toBe(true); expect(f.effects).toContain('bounds:{"x":700,"y":500,"width":100,"height":100}'); expect(f.effects).toContain("attach");
    await f.service.dispose();
  });
  it("cancellation during setProxy starts no document and returns cancelled", async () => {
    const f = fixture(), wait = deferred<void>(); f.delayProxy(() => wait.promise);
    const pending = f.service.dispatch(f.sender, { kind: "open", url: "https://example.com/" });
    for (let n = 0; n < 8; n++) await Promise.resolve(); f.abort.abort(); wait.resolve();
    expect(await pending).toEqual({ ok: false, code: "cancelled" }); expect(f.effects.some(x => x.startsWith("load:"))).toBe(false);
    expect(await f.service.dispose()).toEqual({ ok: true, value: null }); expect(f.effects).toContain("storage");
  });
  it("cancels a never-settling setup promptly and bounds failed shutdown cleanup", async () => {
    const f = fixture(), wait = deferred<void>(); f.delayProxy(() => wait.promise);
    const pending = f.service.dispatch(f.sender, { kind: "open", url: "https://example.com/" });
    for (let n = 0; n < 8; n++) await Promise.resolve();
    expect(f.effects).toContain("setProxy"); f.abort.abort();
    const result = await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve("hung"), 200))]);
    expect(result).toEqual({ ok: false, code: "cancelled" });
    expect(await f.service.dispose()).toEqual({ ok: false, code: "cleanup_failed" });
    expect(f.effects).toContain("storage"); expect(f.effects).not.toContain("attach");
    expect(f.effects.some(x => x.startsWith("load:"))).toBe(false);
    wait.resolve();
  });
  it("publishes the pending browser ID so close can cancel initialization before any navigation", async () => {
    const f = fixture(), wait = deferred<void>(); f.delayProxy(() => wait.promise);
    const pending = f.service.dispatch(f.sender, { kind: "open", url: "https://example.com/" });
    for (let n = 0; n < 8; n++) await Promise.resolve();
    expect(f.changed.at(-1)).toMatchObject({ loading: true, pendingUrl: "https://example.com/", closed: false });
    const page = f.changed.at(-1) as { browserId: string };
    const closed = f.service.dispatch(f.sender, { kind: "close", browserId: page.browserId });
    wait.resolve();
    expect(await pending).toEqual({ ok: false, code: "cancelled" });
    expect(await closed).toMatchObject({ ok: true, value: { closed: true } });
    expect(f.effects.some(x => x.startsWith("load:"))).toBe(false); await f.service.dispose();
  });
  it("owner switch revokes old view and old response cannot publish into the new session", async () => {
    const f = fixture(), wait = deferred<void>(); f.delayLoad(() => wait.promise);
    const old = f.service.dispatch(f.sender, { kind: "open", url: "https://example.com/a" });
    for (let n = 0; n < 15; n++) await Promise.resolve(); f.swap(); f.delayLoad(async () => {});
    const fresh = await f.service.dispatch(f.sender, { kind: "open", url: "https://example.com/b" }); expect(fresh.ok).toBe(true); wait.resolve();
    expect((await old).ok).toBe(false); expect(f.effects).toContain("destroy"); expect(f.sessions).toHaveLength(2);
    expect(f.changed.at(-1)).toMatchObject({ conversationId: "b", url: "https://example.com/b" }); await f.service.dispose();
  });
  it("a newer navigation cancels old delivery and preserves its own committed URL", async () => {
    const f = fixture(), opened = await f.service.dispatch(f.sender, { kind: "open", url: "https://example.com/" });
    if (!opened.ok || !opened.value) throw Error("page missing"); const browserId = opened.value.browserId, wait = deferred<void>();
    f.delayLoad(() => wait.promise); const old = f.service.dispatch(f.sender, { kind: "navigate", browserId, url: "https://example.com/old" });
    f.delayLoad(async () => {}); const fresh = await f.service.dispatch(f.sender, { kind: "navigate", browserId, url: "https://example.com/new" }); wait.resolve();
    expect(await old).toEqual({ ok: false, code: "cancelled" }); expect(fresh).toMatchObject({ ok: true, value: { url: "https://example.com/new", loading: false } }); await f.service.dispose();
  });
  it("load failure preserves committed URL and hides raw exceptions", async () => {
    const f = fixture(), opened = await f.service.dispatch(f.sender, { kind: "open", url: "https://example.com/" }); if (!opened.ok || !opened.value) throw Error("page missing");
    f.delayLoad(async () => { throw Error("private-token=never-expose"); });
    expect(await f.service.dispatch(f.sender, { kind: "navigate", browserId: opened.value.browserId, url: "https://example.com/fail" })).toEqual({ ok: false, code: "load_failed" });
    expect(f.changed.at(-1)).toMatchObject({ url: "https://example.com/", error: "load_failed", pendingUrl: null }); await f.service.dispose();
  });
  it("close clears real Session resources and stale browser IDs stay closed", async () => {
    const f = fixture(), opened = await f.service.dispatch(f.sender, { kind: "open", url: "https://example.com/" }); if (!opened.ok || !opened.value) throw Error("page missing");
    const browserId = opened.value.browserId; expect(await f.service.dispatch(f.sender, { kind: "close", browserId })).toMatchObject({ ok: true, value: { closed: true } });
    expect(f.effects).toEqual(expect.arrayContaining(["destroy", "proxyRevoke", "storage", "cache", "auth", "resolver"]));
    expect(await f.service.dispatch(f.sender, { kind: "navigate", browserId, url: "https://example.com/" })).toEqual({ ok: false, code: "closed" }); await f.service.dispose();
  });
  it("uses native history state and detaches on trusted overlays, blur, hide and host close", async () => {
    const f = fixture(), opened = await f.service.dispatch(f.sender, { kind: "open", url: "https://example.com/" });
    if (!opened.ok || !opened.value) throw Error("page missing"); const browserId = opened.value.browserId;
    expect((await f.service.dispatch(f.sender, { kind: "history", browserId, action: "back" })).ok).toBe(true);
    expect(f.effects).toContain("back");
    expect(await f.service.dispatch(f.sender, { kind: "history", browserId, action: "forward" })).toEqual({ ok: false, code: "closed" });
    const layout = { kind: "layout", browserId, bounds: { x: 0, y: 0, width: 200, height: 100 } };
    await f.service.dispatch(f.sender, layout); f.service.setTrustedOverlay(f.host, true);
    const attachments = f.effects.filter(effect => effect === "attach").length;
    await f.service.dispatch(f.sender, layout); expect(f.effects.filter(effect => effect === "attach")).toHaveLength(attachments);
    f.service.setTrustedOverlay(f.host, false); await f.service.dispatch(f.sender, layout);
    (f.host as unknown as EventEmitter).emit("blur"); (f.host as unknown as EventEmitter).emit("hide");
    expect(f.effects.filter(effect => effect === "detach").length).toBeGreaterThanOrEqual(3);
    expect(await f.service.closeHost(f.host)).toEqual({ ok: true, value: null });
    expect(f.effects).toContain("destroy"); expect(f.callbacks[0].allowsNavigation("https://example.com/")).toBe(false);
    expect(await f.service.dispatch(f.sender, layout)).toEqual({ ok: false, code: "owner_mismatch" }); await f.service.dispose();
  });
  it("native callbacks publish current page errors and exact proxy credentials expire on owner revoke", async () => {
    const f = fixture(), opened = await f.service.dispatch(f.sender, { kind: "open", url: "https://example.com/" });
    expect(opened.ok).toBe(true);
    const native = f.guests[0].contents, challenge = { isProxy: true, host: "127.0.0.1", port: 1234, realm: "fixture", scheme: "basic" };
    expect(f.service.credentialsFor(native, challenge)).toEqual({ username: "opaque", password: "opaque" });
    expect(f.service.credentialsFor({ ...native }, challenge)).toBeNull();
    f.callbacks[0].started("https://example.com/linked"); expect(f.changed.at(-1)).toMatchObject({ loading: true, pendingUrl: "https://example.com/linked" });
    f.callbacks[0].failed(); expect(f.changed.at(-1)).toMatchObject({ error: "load_failed", loading: false, url: "https://example.com/" });
    f.service.revoke(f.owner()); const notifications = f.changed.length;
    f.callbacks[0].changed(); f.callbacks[0].started("https://example.com/stale");
    expect(f.changed).toHaveLength(notifications); expect(f.service.credentialsFor(native, challenge)).toBeNull();
    expect(f.service.isRegisteredBrowser(native)).toBe(true); await f.service.dispose();
  });
  it.each(["blur", "hide"])("a queued layout cannot undo %s until trusted restoration", async event => {
    const f = fixture(), opened = await f.service.dispatch(f.sender, { kind: "open", url: "https://example.com/" });
    if (!opened.ok || !opened.value) throw Error("page missing");
    const command = { kind: "layout", browserId: opened.value.browserId, bounds: { x: 1, y: 2, width: 100, height: 100 } };
    await f.service.dispatch(f.sender, command);
    (f.host as unknown as EventEmitter).emit(event);
    const before = f.effects.filter(effect => effect === "attach").length;
    await f.service.dispatch(f.sender, command); expect(f.effects.filter(effect => effect === "attach")).toHaveLength(before);
    (f.host as unknown as EventEmitter).emit(event === "blur" ? "focus" : "show");
    await f.service.dispatch(f.sender, command); expect(f.effects.filter(effect => effect === "attach")).toHaveLength(before + 1); await f.service.dispose();
  });
  it("clips negative-origin rectangles by their original edges and detaches fully offscreen layouts", async () => {
    const f = fixture(), opened = await f.service.dispatch(f.sender, { kind: "open", url: "https://example.com/" });
    if (!opened.ok || !opened.value) throw Error("page missing");
    await f.service.dispatch(f.sender, { kind: "layout", browserId: opened.value.browserId, bounds: { x: -200, y: 0, width: 100, height: 100 } });
    expect(f.effects).not.toContain("attach");
    await f.service.dispatch(f.sender, { kind: "layout", browserId: opened.value.browserId, bounds: { x: -20, y: -30, width: 100, height: 100 } });
    expect(f.effects).toContain('bounds:{"x":0,"y":0,"width":80,"height":70}'); await f.service.dispose();
  });
});

const scope = { hosts: ["example.com"], actions: ["navigate", "observe", "click", "type"] };
describe("Main-owned bounded session permission", () => {
  it("does not allocate before confirmation and opens the exact scope after native approval", async () => {
    const approved = deferred<boolean>(), f = fixture(false, () => approved.promise), service = f.service as any;
    expect(service.dispatchPermission).toBeTypeOf("function");
    expect(await service.dispatchPermission(f.sender, { kind: "get" })).toMatchObject({ ok: true, value: { status: "required" } });
    const pending = service.dispatchPermission(f.sender, { kind: "request", scope });
    await Promise.resolve(); await Promise.resolve();
    expect(f.effects).toEqual([]);
    expect(await service.dispatchPermission(f.sender, { kind: "get" })).toMatchObject({ ok: true, value: { status: "pending" } });
    expect(await service.dispatch(f.sender, { kind: "open", url: "https://example.com/" })).toEqual({ ok: false, code: "permission_denied" });
    approved.resolve(true);
    expect(await pending).toMatchObject({ ok: true, value: { status: "granted", scope } });
    expect((await service.dispatch(f.sender, { kind: "open", url: "https://example.com/" })).ok).toBe(true);
    expect(await service.dispatch(f.sender, { kind: "get" })).toMatchObject({ ok: true, value: { url: "https://example.com/" } });
    await service.dispose();
  });
  it("denial, forged grant fields and unlisted scopes never grant or allocate", async () => {
    const confirm = vi.fn(async () => false), f = fixture(false, confirm), service = f.service as any;
    expect(service.dispatchPermission).toBeTypeOf("function");
    expect(await service.dispatchPermission(f.sender, { kind: "request", scope: { ...scope, hosts: ["evil.example"] }, allow: true })).toEqual({ ok: false, code: "permission_denied" });
    expect(confirm).not.toHaveBeenCalled();
    expect(await service.dispatchPermission(f.sender, { kind: "request", scope, allow: true })).toMatchObject({ ok: true, value: { status: "denied" } });
    expect(await service.dispatch(f.sender, { kind: "open", url: "https://example.com/", allow: true })).toEqual({ ok: false, code: "permission_denied" });
    expect(f.effects).toEqual([]); await service.dispose();
  });
  it("repeated pending requests share one native decision; revoke fences a late approval and allows a new prompt", async () => {
    const first = deferred<boolean>(), second = deferred<boolean>();
    const confirm = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise), f = fixture(false, confirm), service = f.service as any;
    expect(service.dispatchPermission).toBeTypeOf("function");
    const one = service.dispatchPermission(f.sender, { kind: "request", scope });
    const two = service.dispatchPermission(f.sender, { kind: "request", scope });
    for (let i=0;i<8;i++) await Promise.resolve();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(await service.dispatchPermission(f.sender, { kind: "revoke" })).toMatchObject({ ok: true, value: { status: "required" } });
    expect(await one).toEqual({ ok: false, code: "cancelled" }); expect(await two).toEqual({ ok: false, code: "cancelled" });
    const newer = service.dispatchPermission(f.sender, { kind: "request", scope });
    for (let i=0;i<8;i++) await Promise.resolve();
    first.resolve(true); await Promise.resolve();
    expect(await service.dispatchPermission(f.sender, { kind: "get" })).toMatchObject({ ok: true, value: { status: "pending" } });
    second.resolve(true); expect(await newer).toMatchObject({ ok: true, value: { status: "granted" } });
    await service.dispose();
  });
  it("scope is checked for navigation and login destinations and close consumes the grant", async () => {
    const f = fixture(false, async () => true), service = f.service as any;
    expect(service.dispatchPermission).toBeTypeOf("function");
    await service.dispatchPermission(f.sender, { kind: "request", scope });
    expect(await service.dispatch(f.sender, { kind: "open", url: "https://github.com/" })).toEqual({ ok: false, code: "blocked_url" });
    const open = await service.dispatch(f.sender, { kind: "open", url: "https://example.com/" });
    expect(open.ok).toBe(true);
    expect(await service.dispatch(f.sender, { kind: "navigate", browserId: open.value.browserId, url: "https://example.com/login" })).toEqual({ ok: false, code: "blocked_url" });
    for (const path of ["join", "register", "login.php", "checkout", "wp-login.php", "oauth2/authorize"]) {
      expect(await service.dispatch(f.sender, { kind: "navigate", browserId: open.value.browserId, url: `https://example.com/${path}` })).toEqual({ ok: false, code: "blocked_url" });
    }
    expect(f.callbacks[0].allowsNavigation("https://github.com/")).toBe(false);
    await service.dispatch(f.sender, { kind: "close", browserId: open.value.browserId });
    expect(await service.dispatchPermission(f.sender, { kind: "get" })).toMatchObject({ ok: true, value: { status: "required" } });
    await service.dispose();
  });
  it("session switching invalidates a pending native result without resurrecting the old owner", async () => {
    const decision = deferred<boolean>(), f = fixture(false, () => decision.promise), service = f.service as any;
    expect(service.dispatchPermission).toBeTypeOf("function");
    const pending = service.dispatchPermission(f.sender, { kind: "request", scope });
    for (let i=0;i<6;i++) await Promise.resolve();
    f.swap();
    expect(await service.dispatchPermission(f.sender, { kind: "get" })).toMatchObject({ ok: true, value: { status: "required", conversationId: "b" } });
    decision.resolve(true); expect(await pending).toEqual({ ok: false, code: "cancelled" });
    expect(f.effects).toEqual([]); await service.dispose();
  });
});

describe("Agent operations require the presented page", () => {
  it("cannot read an opened page before its first native layout", async () => {
    const f = fixture(false, async () => true);
    const run = { conversationId: "a", runId: "run", signal: new AbortController().signal, isCurrent: () => true };
    try {
      await f.service.dispatchPermission(f.sender, { kind: "request", scope });
      await f.service.executeAgent(f.owner(), { operation: "open", url: "https://example.com/" }, run);
      expect(await f.service.executeAgent(f.owner(), { operation: "observe" }, run)).toEqual({ ok: false, code: "permission_denied" });
      expect(f.effects).not.toContain("observe");
    } finally { await f.service.dispose(); }
  });
  it.each(["null-layout", "offscreen", "blur", "hide", "overlay"])("blocks background work after %s and still permits cleanup", async reason => {
    const f = fixture(false, async () => true);
    const run = { conversationId: "a", runId: "run", signal: new AbortController().signal, isCurrent: () => true };
    try {
      await f.service.dispatchPermission(f.sender, { kind: "request", scope });
      const page = await f.service.executeAgent(f.owner(), { operation: "open", url: "https://example.com/" }, run);
      if (!page.ok || !page.value || !("browserId" in page.value)) throw new Error("missing page");
      await showPage(f); await f.service.executeAgent(f.owner(), { operation: "observe" }, run);
      if (reason === "null-layout") await f.service.dispatch(f.sender, { kind: "layout", browserId: page.value.browserId, bounds: null });
      else if (reason === "offscreen") await f.service.dispatch(f.sender, { kind: "layout", browserId: page.value.browserId, bounds: { x: 900, y: 0, width: 100, height: 100 } });
      else if (reason === "overlay") f.service.setTrustedOverlay(f.host, true);
      else (f.host as unknown as EventEmitter).emit(reason);
      const before = [...f.effects];
      for (const operation of ["observe", "click", "type", "navigate", "back", "forward", "reload"]) {
        expect(await f.service.executeAgent(f.owner(), { operation, snapshotId: "observed", ref: "1", text: "query", url: "https://example.com/next" }, run)).toEqual({ ok: false, code: "permission_denied" });
      }
      expect(f.effects).toEqual(before);
      expect(await f.service.executeAgent(f.owner(), { operation: "close" }, run)).toMatchObject({ ok: true });
    } finally { await f.service.dispose(); }
  });
  it("a hide/show cycle invalidates both stored snapshots and pending observations", async () => {
    const f = fixture(false, async () => true), wait = deferred<void>();
    const run = { conversationId: "a", runId: "run", signal: new AbortController().signal, isCurrent: () => true };
    try {
      await f.service.dispatchPermission(f.sender, { kind: "request", scope });
      const page = await f.service.executeAgent(f.owner(), { operation: "open", url: "https://example.com/" }, run);
      if (!page.ok || !page.value || !("browserId" in page.value)) throw new Error("missing page");
      const browserId = page.value.browserId;
      const hide = () => f.service.dispatch(f.sender, { kind: "layout", browserId, bounds: null });
      await showPage(f); await f.service.executeAgent(f.owner(), { operation: "observe" }, run);
      await hide(); await showPage(f);
      expect(await f.service.executeAgent(f.owner(), { operation: "click", snapshotId: "observed", ref: "1" }, run)).toEqual({ ok: false, code: "permission_denied" });
      f.delayObservation(() => wait.promise);
      const pending = f.service.executeAgent(f.owner(), { operation: "observe" }, run);
      await Promise.resolve(); await hide(); await showPage(f); wait.resolve();
      expect(await pending).toEqual({ ok: false, code: "cancelled" });
      expect(await f.service.executeAgent(f.owner(), { operation: "click", snapshotId: "observed", ref: "1" }, run)).toEqual({ ok: false, code: "permission_denied" });
      f.delayObservation(async () => {});
      expect(await f.service.executeAgent(f.owner(), { operation: "observe" }, run)).toMatchObject({ ok: true });
      expect(await f.service.executeAgent(f.owner(), { operation: "click", snapshotId: "observed", ref: "1" }, run)).toMatchObject({ ok: true });
    } finally { wait.resolve(); await f.service.dispose(); }
  });
});

describe("trusted current run controls the same browser page", () => {
  it("requires user permission, blocks self-authorization and returns actual guest observation", async () => {
    const f = fixture(false, async () => true), service = f.service as any, abort = new AbortController();
    expect(service.executeAgent).toBeTypeOf("function");
    await service.dispatchPermission(f.sender, { kind: "get" });
    const run = { conversationId: "a", runId: "run-one", signal: abort.signal, isCurrent: () => true };
    expect(await service.executeAgent(f.owner(), { operation: "open", url: "https://example.com/" }, run)).toEqual({ ok: false, code: "permission_denied" });
    expect(await service.executeAgent(f.owner(), { operation: "requestPermission", scope }, run)).toEqual({ ok: false, code: "permission_denied" });
    await service.dispatchPermission(f.sender, { kind: "request", scope });
    const page = await service.executeAgent(f.owner(), { operation: "open", url: "https://example.com/" }, run);
    expect(page).toMatchObject({ ok: true, value: { url: "https://example.com/" } });
    await showPage(f);
    const observation = await service.executeAgent(f.owner(), { operation: "observe" }, run);
    expect(observation).toMatchObject({ ok: true, value: { text: "Public text", snapshotId: "observed" } });
    expect(await service.executeAgent(f.owner(), { operation: "click", ref: "1", snapshotId: "observed" }, run)).toMatchObject({ ok: true });
    expect(f.effects).toContain("click:1"); await service.dispose();
  });
  it("rejects other sessions, inactive runs, stale observations and extra authority fields", async () => {
    const f = fixture(false, async () => true), service = f.service as any;
    expect(service.executeAgent).toBeTypeOf("function");
    await service.dispatchPermission(f.sender, { kind: "request", scope });
    const run = { conversationId: "a", runId: "one", signal: new AbortController().signal, isCurrent: () => true };
    await service.executeAgent(f.owner(), { operation: "open", url: "https://example.com/" }, run);
    await showPage(f);
    for (const badRun of [{ ...run, conversationId: "b" }, { ...run, isCurrent: () => false }])
      expect(await service.executeAgent(f.owner(), { operation: "observe" }, badRun)).toEqual({ ok: false, code: "owner_mismatch" });
    expect(await service.executeAgent(f.owner(), { operation: "observe", owner: f.owner(), allow: true }, run)).toEqual({ ok: false, code: "permission_denied" });
    await service.executeAgent(f.owner(), { operation: "observe" }, run);
    expect(await service.executeAgent(f.owner(), { operation: "click", snapshotId: "observed", ref: "1" }, { ...run, runId: "two" })).toEqual({ ok: false, code: "permission_denied" });
    await service.executeAgent(f.owner(), { operation: "navigate", url: "https://example.com/next" }, run);
    expect(await service.executeAgent(f.owner(), { operation: "click", snapshotId: "observed", ref: "1" }, run)).toEqual({ ok: false, code: "permission_denied" });
    expect(f.effects).not.toContain("click:1"); await service.dispose();
  });
  it("run abort closes outstanding DOM work and a late observation cannot publish or be used", async () => {
    const f = fixture(false, async () => true), service = f.service as any, abort = new AbortController(), wait = deferred<void>();
    expect(service.executeAgent).toBeTypeOf("function");
    await service.dispatchPermission(f.sender, { kind: "request", scope });
    const run = { conversationId: "a", runId: "one", signal: abort.signal, isCurrent: () => !abort.signal.aborted };
    await service.executeAgent(f.owner(), { operation: "open", url: "https://example.com/" }, run);
    await showPage(f);
    f.delayObservation(() => wait.promise);
    const pending = service.executeAgent(f.owner(), { operation: "observe" }, run);
    await Promise.resolve(); abort.abort();
    expect(await pending).toEqual({ ok: false, code: "cancelled" });
    wait.resolve(); await Promise.resolve();
    expect(await service.dispatchPermission(f.sender, { kind: "get" })).toMatchObject({ ok: true, value: { status: "required" } });
    expect(f.effects).toContain("destroy"); await service.dispose();
  });
});

it("native dialog failures reset pending permission and a later request can be retried", async () => {
  const confirm = vi.fn().mockRejectedValueOnce(new Error("dialog unavailable")).mockResolvedValueOnce(true), f = fixture(false, confirm), service = f.service as any;
  expect(await service.dispatchPermission(f.sender, { kind: "request", scope })).toEqual({ ok: false, code: "permission_denied" });
  expect(await service.dispatchPermission(f.sender, { kind: "get" })).toMatchObject({ ok: true, value: { status: "required" } });
  expect(await service.dispatchPermission(f.sender, { kind: "request", scope })).toMatchObject({ ok: true, value: { status: "granted" } });
  await service.dispose();
});
it("revoking permission promptly settles a never-resolving observation", async () => {
  const f = fixture(false, async () => true), service = f.service as any, wait = deferred<void>();
  await service.dispatchPermission(f.sender, { kind: "request", scope });
  const run = { conversationId: "a", runId: "one", signal: new AbortController().signal, isCurrent: () => true };
  await service.executeAgent(f.owner(), { operation: "open", url: "https://example.com/" }, run);
  await showPage(f);
  f.delayObservation(() => wait.promise);
  const pending = service.executeAgent(f.owner(), { operation: "observe" }, run);
  await Promise.resolve(); await service.dispatchPermission(f.sender, { kind: "revoke" });
  const result = await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve("hung"), 100))]);
  expect(result).toEqual({ ok: false, code: "cancelled" });
  wait.resolve(); await service.dispose();
});

it("late action completion after a session change does not return success or regain permission", async () => {
  const f = fixture(false, async () => true), service = f.service as any, wait = deferred<void>();
  await service.dispatchPermission(f.sender, { kind: "request", scope });
  const run = { conversationId: "a", runId: "one", signal: new AbortController().signal, isCurrent: () => true };
  await service.executeAgent(f.owner(), { operation: "open", url: "https://example.com/" }, run);
  await showPage(f);
  await service.executeAgent(f.owner(), { operation: "observe" }, run); f.delayAction(() => wait.promise);
  const pending = service.executeAgent(f.owner(), { operation: "click", ref: "1", snapshotId: "observed" }, run);
  await Promise.resolve(); f.swap();
  expect(await service.dispatchPermission(f.sender, { kind: "get" })).toMatchObject({ ok: true, value: { conversationId: "b", status: "required" } });
  expect(await pending).toEqual({ ok: false, code: "owner_mismatch" });
  wait.resolve(); await Promise.resolve();
  expect(await service.dispatch(f.sender, { kind: "get" })).toEqual({ ok: true, value: null }); await service.dispose();
});
it("a late action after run abort settles cancelled and cannot continue", async () => {
  const f = fixture(false, async () => true), service = f.service as any, wait = deferred<void>(), abort = new AbortController();
  await service.dispatchPermission(f.sender, { kind: "request", scope });
  const run = { conversationId: "a", runId: "one", signal: abort.signal, isCurrent: () => !abort.signal.aborted };
  await service.executeAgent(f.owner(), { operation: "open", url: "https://example.com/" }, run);
  await showPage(f);
  await service.executeAgent(f.owner(), { operation: "observe" }, run); f.delayAction(() => wait.promise);
  const pending = service.executeAgent(f.owner(), { operation: "click", ref: "1", snapshotId: "observed" }, run);
  await Promise.resolve(); abort.abort(); expect(await pending).toEqual({ ok: false, code: "cancelled" });
  wait.resolve(); await Promise.resolve();
  expect(await service.executeAgent(f.owner(), { operation: "observe" }, run)).toEqual({ ok: false, code: "cancelled" });
  await service.dispose();
});

const manualScope = (host = "public.example", resourceHosts: string[] = []) => ({ mode: "manual", hosts: [host], resourceHosts, actions: ["navigate"] });
describe("manual exact public site permissions", () => {
  it("accepts a new public site only after native consent and rejects every agent operation", async () => {
    const decision = deferred<boolean>(), confirm = vi.fn(() => decision.promise), f = fixture(false, confirm, true);
    expect(await f.service.dispatchPermission(f.sender, { kind: "get" })).toMatchObject({ ok: true, value: { scope: { mode: "manual", hosts: [] } } });
    const approval = f.service.dispatchPermission(f.sender, { kind: "request", scope: manualScope() });
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(f.sessions).toHaveLength(0);
    decision.resolve(true); expect(await approval).toMatchObject({ ok: true, value: { status: "granted" } });
    const opened = await f.service.dispatch(f.sender, { kind: "open", url: "https://public.example/page" });
    expect(opened).toMatchObject({ ok: true, value: { url: "https://public.example/page" } });
    const run = { conversationId: "a", runId: "trusted-run", signal: new AbortController().signal, isCurrent: () => true };
    for (const operation of ["open", "navigate", "observe", "click", "type", "back", "forward", "reload", "close"]) {
      expect(await f.service.executeAgent(f.owner(), { operation, url: "https://public.example/" }, run)).toEqual({ ok: false, code: "permission_denied" });
    }
    expect(f.effects).not.toContain("observe"); expect(f.effects).not.toContain("click:1");
    await f.service.dispose();
  });
  it("separates exact resource grants from navigation and reports blocked hosts without prompting", async () => {
    const confirm = vi.fn(async () => true), f = fixture(false, confirm, true);
    await f.service.dispatchPermission(f.sender, { kind: "request", scope: manualScope() });
    const first = await f.service.dispatch(f.sender, { kind: "open", url: "https://public.example/" });
    if (!first.ok || !first.value) throw Error("missing page");
    f.requests[0]({ method: "GET", resourceType: "script", url: "https://cdn.example/app.js" });
    await f.service.dispatchPermission(f.sender, { kind: "request", scope: { ...manualScope("public.example", ["cdn.example"]), sourceBrowserId: first.value.browserId, sourceRequestId: first.value.requestId } });
    const opened = await f.service.dispatch(f.sender, { kind: "open", url: "https://public.example/" });
    expect(opened.ok).toBe(true);
    const request = { method: "GET", resourceType: "script", url: "https://cdn.example/app.js", webContentsId: 21 };
    expect(f.requests[1](request)).toBe(true);
    expect(f.requests[1]({ ...request, resourceType: "mainFrame" })).toBe(false);
    expect(f.requests[1]({ ...request, resourceType: "subFrame" })).toBe(false);
    expect(f.requests[1]({ ...request, url: "https://unapproved.example/script.js?private=not-retained" })).toBe(false);
    expect(f.changed.at(-1)).toMatchObject({ blockedResourceHosts: ["unapproved.example"] });
    expect(JSON.stringify(f.changed)).not.toContain("private=not-retained");
    expect(f.callbacks[1].allowsNavigation("https://elsewhere.example/article")).toBe(false);
    expect(f.changed.at(-1)).toMatchObject({ blockedNavigationUrl: "https://elsewhere.example/", error: "blocked_url" });
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(f.requests[1]({ ...request, method: "POST" })).toBe(false);
    expect(f.changed.at(-1)).toMatchObject({ blockedRequest: true });
    await f.service.dispose();
  });
  it.each([
    manualScope("127.0.0.1"), manualScope("[::1]"), manualScope("user@public.example"), manualScope("public.example:8443"),
    manualScope("*.example"), { ...manualScope(), actions: ["navigate", "observe"] },
    { ...manualScope(), hosts: ["a.example", "b.example"] }, manualScope("public.example", ["10.1.1.1"]),
  ])("rejects invalid or broader scope before asking %#", async scope => {
    const confirm = vi.fn(async () => true), f = fixture(false, confirm, true);
    expect(await f.service.dispatchPermission(f.sender, { kind: "request", scope })).toEqual({ ok: false, code: "permission_denied" });
    expect(confirm).not.toHaveBeenCalled(); expect(f.sessions).toHaveLength(0); await f.service.dispose();
  });
  it("supersedes a pending site confirmation and cannot use its late approval", async () => {
    const first = deferred<boolean>(), second = deferred<boolean>();
    const confirm = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise), f = fixture(false, confirm, true);
    const older = f.service.dispatchPermission(f.sender, { kind: "request", scope: manualScope("first.example") });
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    const newer = f.service.dispatchPermission(f.sender, { kind: "request", scope: manualScope("second.example") });
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(2));
    expect(await older).toEqual({ ok: false, code: "cancelled" });
    first.resolve(true); second.resolve(true);
    expect(await newer).toMatchObject({ ok: true, value: { status: "granted", scope: { hosts: ["second.example"] } } });
    expect(await f.service.dispatch(f.sender, { kind: "open", url: "https://first.example/" })).toEqual({ ok: false, code: "blocked_url" });
    await f.service.dispose();
  });
  it("rebuilds the session after resource approval and keeps the old request handler denied", async () => {
    const f = fixture(false, async () => true, true);
    await f.service.dispatchPermission(f.sender, { kind: "request", scope: manualScope() });
    const opened = await f.service.dispatch(f.sender, { kind: "open", url: "https://public.example/article" });
    if (!opened.ok || !opened.value) throw Error("missing page");
    f.requests[0]({ method: "GET", resourceType: "script", url: "https://cdn.example/app.js" });
    await f.service.dispatchPermission(f.sender, { kind: "request", scope: { ...manualScope("public.example", ["cdn.example"]), sourceBrowserId: opened.value.browserId, sourceRequestId: opened.value.requestId } });
    expect(f.effects).toContain("storage"); expect(f.effects).toContain("proxyRevoke");
    expect(f.changed.at(-1)).toMatchObject({ closed: true, canGoBack: false, canGoForward: false });
    expect(f.requests[0]({ method: "GET", resourceType: "mainFrame", url: "https://public.example/" })).toBe(false);
    expect(await f.service.dispatch(f.sender, { kind: "open", url: "https://public.example/article" })).toMatchObject({ ok: true });
    expect(f.sessions).toHaveLength(2); expect(f.sessions[0]).not.toBe(f.sessions[1]); await f.service.dispose();
  });
  it("revoke cancels a manual site confirmation without resurrecting it", async () => {
    const decision = deferred<boolean>(), f = fixture(false, () => decision.promise, true);
    const pending = f.service.dispatchPermission(f.sender, { kind: "request", scope: manualScope() });
    await Promise.resolve(); await Promise.resolve();
    await f.service.dispatchPermission(f.sender, { kind: "revoke" });
    decision.resolve(true); expect(await pending).toEqual({ ok: false, code: "cancelled" });
    expect(await f.service.dispatchPermission(f.sender, { kind: "get" })).toMatchObject({ ok: true, value: { status: "required" } });
    expect(f.sessions).toHaveLength(0); await f.service.dispose();
  });
});


it("manual resource consent rejects stale navigation identity and resets discovery on navigation", async () => {
  const confirm = vi.fn(async () => true), f = fixture(false, confirm, true);
  await f.service.dispatchPermission(f.sender, { kind: "request", scope: manualScope() });
  const opened = await f.service.dispatch(f.sender, { kind: "open", url: "https://public.example/article" });
  if (!opened.ok || !opened.value) throw Error("missing page");
  const { browserId, requestId } = opened.value;
  f.requests[0]({ method: "GET", resourceType: "script", url: "https://cdn.example/app.js" });
  expect(await f.service.dispatchPermission(f.sender, { kind: "request", scope: { ...manualScope("public.example", ["cdn.example"]), sourceBrowserId: browserId, sourceRequestId: requestId - 1 } })).toEqual({ ok: false, code: "permission_denied" });
  expect(confirm).toHaveBeenCalledTimes(1);
  await f.service.dispatch(f.sender, { kind: "navigate", browserId, url: "https://public.example/new" });
  expect(f.changed.at(-1)).toMatchObject({ blockedResourceHosts: [] });
  expect(await f.service.dispatchPermission(f.sender, { kind: "request", scope: { ...manualScope("public.example", ["cdn.example"]), sourceBrowserId: browserId, sourceRequestId: requestId } })).toEqual({ ok: false, code: "permission_denied" });
  await f.service.dispose();
});

it("manual resource reports are capped, deduplicated and cannot grant unknown or foreign-page domains", async () => {
  const confirm = vi.fn(async () => true), f = fixture(false, confirm, true);
  await f.service.dispatchPermission(f.sender, { kind: "request", scope: manualScope() });
  const opened = await f.service.dispatch(f.sender, { kind: "open", url: "https://public.example/" });
  if (!opened.ok || !opened.value) throw Error("missing page");
  const request = { method: "GET", resourceType: "script", webContentsId: 20 };
  f.requests[0]({ ...request, webContentsId: 999, url: "https://foreign.example/x" });
  for (let i = 0; i < 24; i++) f.requests[0]({ ...request, url: `https://cdn${i}.example/x?synthetic-secret=1` });
  f.requests[0]({ ...request, url: "https://cdn0.example/repeated" });
  const reported = f.changed.at(-1) as { blockedResourceHosts: string[] };
  expect(reported.blockedResourceHosts).toHaveLength(16);
  expect(reported.blockedResourceHosts).not.toContain("foreign.example");
  for (const source of [{ sourceBrowserId: "another-page", sourceRequestId: opened.value.requestId }, { sourceBrowserId: opened.value.browserId, sourceRequestId: opened.value.requestId }]) {
    expect(await f.service.dispatchPermission(f.sender, { kind: "request", scope: { ...manualScope("public.example", ["undiscovered.example"]), ...source } })).toEqual({ ok: false, code: "permission_denied" });
  }
  expect(confirm).toHaveBeenCalledTimes(1); await f.service.dispose();
});

it("manual denial and owner replacement cannot leave or recreate a browsing grant", async () => {
  const confirm = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false), f = fixture(false, confirm, true);
  await f.service.dispatchPermission(f.sender, { kind: "request", scope: manualScope() });
  await f.service.dispatch(f.sender, { kind: "open", url: "https://public.example/" });
  expect(await f.service.dispatchPermission(f.sender, { kind: "request", scope: manualScope("second.example") })).toMatchObject({ ok: true, value: { status: "denied" } });
  expect(f.effects).toContain("storage"); expect(await f.service.dispatch(f.sender, { kind: "get" })).toEqual({ ok: true, value: null });
  expect(await f.service.dispatch(f.sender, { kind: "open", url: "https://public.example/" })).toEqual({ ok: false, code: "permission_denied" });
  f.swap(); expect(await f.service.dispatchPermission(f.sender, { kind: "get" })).toMatchObject({ ok: true, value: { status: "required", scope: { mode: "manual" } } });
  await f.service.dispose();
});

it("canonical public IPv6 manual sites survive policy snapshot without widening scope", async () => {
  const f = fixture(false, async () => true, true), host = "[2606:4700::1111]";
  expect(await f.service.dispatchPermission(f.sender, { kind: "request", scope: manualScope(host) })).toMatchObject({ ok: true, value: { status: "granted" } });
  expect(await f.service.dispatch(f.sender, { kind: "open", url: `https://${host}/` })).toMatchObject({ ok: true });
  expect(f.requests[0]({ method: "GET", resourceType: "mainFrame", url: `https://${host}/` })).toBe(true);
  expect(f.requests[0]({ method: "GET", resourceType: "mainFrame", url: "https://[2606:4700::1001]/" })).toBe(false);
  await f.service.dispose();
});

it("rejects a stale session revoke and preserves the current session grant and page", async () => {
    const f = fixture(false, async () => true);
    const scope = { hosts: ["example.com"], actions: ["navigate"] };
    await f.service.dispatchPermission(f.sender, { kind: "request", scope });
    f.swap();
    await f.service.dispatchPermission(f.sender, { kind: "request", scope });
    const opened = await f.service.dispatch(f.sender, { kind: "open", url: "https://example.com/" });
    expect(opened.ok).toBe(true);
    expect(await f.service.dispatchPermission(f.sender, { kind: "revoke", conversationId: "a" })).toEqual({ ok: false, code: "owner_mismatch" });
    expect(await f.service.dispatchPermission(f.sender, { kind: "get" })).toMatchObject({ ok: true, value: { conversationId: "b", status: "granted" } });
    expect(await f.service.dispatch(f.sender, { kind: "get" })).toMatchObject({ ok: true, value: { conversationId: "b", closed: false } });
    expect(await f.service.dispatchPermission(f.sender, { kind: "revoke", conversationId: "b" })).toMatchObject({ ok: true, value: { status: "required" } });
    await f.service.dispose();
  });

it("revokes a grant without a page and cancels a late native approval", async () => {
    const approval = deferred<boolean>();
    const f = fixture(false, () => approval.promise);
    const request = f.service.dispatchPermission(f.sender, { kind: "request", scope: { hosts: ["example.com"], actions: ["navigate"] } });
    await vi.waitFor(async () => expect(await f.service.dispatchPermission(f.sender, { kind: "get" })).toMatchObject({ ok: true, value: { status: "pending" } }));
    expect(await f.service.dispatchPermission(f.sender, { kind: "revoke", conversationId: "a" })).toMatchObject({ ok: true, value: { status: "required" } });
    approval.resolve(true);
    expect(await request).toEqual({ ok: false, code: "cancelled" });
    expect(await f.service.dispatchPermission(f.sender, { kind: "get" })).toMatchObject({ ok: true, value: { status: "required" } });
    expect(await f.service.dispatch(f.sender, { kind: "open", url: "https://example.com/" })).toEqual({ ok: false, code: "permission_denied" });
    await f.service.dispose();
  });


describe("explicit exact-site Agent grants", () => {
  const scope = { mode: "agent", site: true, hosts: ["developer.mozilla.org"], resourceHosts: ["static.example.org"], actions: ["navigate", "observe", "click", "type"] };
  it("advertises capability, requires native approval and separates resource hosts from navigation", async () => {
    const confirm = vi.fn(async () => true), f = fixture(false, confirm, true, false, true);
    expect(await f.service.dispatchPermission(f.sender, {kind:"get"})).toMatchObject({ok:true,value:{agentSiteSelection:true}});
    expect(await f.service.dispatchPermission(f.sender, {kind:"request",scope})).toMatchObject({ok:true,value:{status:"granted",scope}});
    expect(confirm).toHaveBeenCalledOnce();
    expect(await f.service.execute(f.owner(), {kind:"open",url:"https://developer.mozilla.org/"})).toMatchObject({ok:true});
    const request = { method:"GET",resourceType:"script",url:"https://static.example.org/app.js",webContentsId:20 };
    expect(f.requests[0](request)).toBe(true);
    expect(f.requests[0]({...request,resourceType:"mainFrame"})).toBe(false);
    expect(f.requests[0]({...request,resourceType:"subFrame"})).toBe(false);
    expect(f.requests[0]({...request,method:"POST"})).toBe(false);
    expect(f.requests[0]({...request,url:"https://unknown.example/app.js"})).toBe(false);
    expect(await f.service.execute(f.owner(), {kind:"open",url:"https://static.example.org/"})).toMatchObject({ok:false,code:"blocked_url"});
  });
  it("does not change legacy service policy or permit self authorization", async () => {
    const confirm = vi.fn(async () => true), f = fixture(false, confirm, true);
    expect(await f.service.dispatchPermission(f.sender, {kind:"request",scope})).toMatchObject({ok:false});
    expect(confirm).not.toHaveBeenCalled();
  });
  it.each([ ["127.0.0.1"], ["*.example.org"], ["example.org:443"], ["user@example.org"], ["example.org/path"], ["EXAMPLE.ORG"], ["192.168.1.1"], ["example.org."], ["example.org#x"], ["example.org?x"], [], Array.from({length:9}, (_,i) => `site${i}.example`) ])("rejects invalid exact navigation hosts %j", async hosts => {
    const confirm = vi.fn(async () => true), f = fixture(false, confirm, true, false, true);
    expect(await f.service.dispatchPermission(f.sender, {kind:"request",scope:{...scope,hosts}})).toMatchObject({ok:false});
    expect(confirm).not.toHaveBeenCalled();
  });
  it("keeps denied grants inactive and retires old pages on scope switch and revoke", async () => {
    const confirm = vi.fn(async () => false), f = fixture(false, confirm, true, false, true);
    expect(await f.service.dispatchPermission(f.sender,{kind:"request",scope})).toMatchObject({ok:true,value:{status:"denied"}});
    expect(await f.service.execute(f.owner(),{kind:"open",url:"https://developer.mozilla.org/"})).toMatchObject({ok:false});
    confirm.mockResolvedValue(true);
    await f.service.dispatchPermission(f.sender,{kind:"request",scope});
    const opened = await f.service.execute(f.owner(),{kind:"open",url:"https://developer.mozilla.org/"});
    expect(opened).toMatchObject({ok:true});
    await f.service.dispatchPermission(f.sender,{kind:"request",scope:{...scope,hosts:["www.wikipedia.org"]}});
    expect(f.effects).toContain("destroy"); expect(f.effects).toContain("storage");
    expect(await f.service.execute(f.owner(),{kind:"open",url:"https://developer.mozilla.org/"})).toMatchObject({ok:false});
    await f.service.revoke(f.owner());
    expect(await f.service.execute(f.owner(),{kind:"open",url:"https://www.wikipedia.org/"})).toMatchObject({ok:false});
  });
});


it.each([
  {resourceHosts:["127.0.0.1"]}, {resourceHosts:Array.from({length:17},(_,i)=>`cdn${i}.example`)},
  {actions:["execute"]}, {web:true}, {sourceBrowserId:"spoof"}, {site:false},
])("rejects malformed exact Agent proposals %j", extra => {
  const confirm = vi.fn(async()=>true), f = fixture(false,confirm,true,false,true);
  return f.service.dispatchPermission(f.sender,{kind:"request",scope:{mode:"agent",site:true,hosts:["developer.mozilla.org"],actions:["navigate"],...extra}}).then(reply => {
    expect(reply).toMatchObject({ok:false}); expect(confirm).not.toHaveBeenCalled();
  });
});
it("never grants exact Agent sites to a manual workspace owner", async () => {
  const confirm=vi.fn(async()=>true), f=fixture(false,confirm,true,true,true);
  expect(await f.service.dispatchPermission(f.sender,{kind:"request",scope:{mode:"agent",site:true,hosts:["developer.mozilla.org"],actions:["navigate"]}})).toMatchObject({ok:false});
  expect(confirm).not.toHaveBeenCalled();
});
it("discards late exact-site confirmation after revocation", async () => {
  const pending=deferred<boolean>(), f=fixture(false,()=>pending.promise,true,false,true);
  const grant=f.service.dispatchPermission(f.sender,{kind:"request",scope:{mode:"agent",site:true,hosts:["developer.mozilla.org"],actions:["navigate"]}});
  await new Promise(resolve=>setTimeout(resolve,0));
  await f.service.revoke(f.owner()); pending.resolve(true);
  expect(await grant).toMatchObject({ok:false});
  expect(await f.service.execute(f.owner(),{kind:"open",url:"https://developer.mozilla.org/"})).toMatchObject({ok:false});
});
