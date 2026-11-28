import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserAuthorizationDomainRegistry } from "./browser-authorization-domain";
import { createBrowserNetworkController, createElectronBrowserSessionPort, type BrowserSessionPort } from "./browser-network-binding";
import type { BrowserRequestDetails } from "./browser-request-policy";
import type { ConnectProxy } from "./authenticated-connect-proxy";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
function fixture(gateOpen = true) {
  const events: string[] = [], session = {}, abort = new AbortController(), owner = {}, profile = {};
  let current = true, handler: (request: BrowserRequestDetails) => boolean = () => true;
  const context = { owner, profile, conversationId: "c", browserId: "b", generation: 0, signal: abort.signal };
  const port: BrowserSessionPort<object> = {
    session, persistent: false,
    installRequestHandler: vi.fn((next) => { events.push("deny"); handler = next; }),
    denyPermissions: vi.fn(() => { events.push("permissions"); }),
    setProxy: vi.fn(async () => { events.push("setProxy"); }),
    closeAllConnections: vi.fn(async () => { events.push("connections"); }),
    clearStorageData: vi.fn(async () => { events.push("storage"); }),
    clearCache: vi.fn(async () => { events.push("cache"); }),
    clearAuthCache: vi.fn(async () => { events.push("auth"); }),
    clearHostResolverCache: vi.fn(async () => { events.push("resolver"); }),
    runningWorkerCount: vi.fn(() => 0),
  };
  let destroyed = false;
  const contents = { id: 22, session, isDestroyed: () => destroyed };
  const view = { contents, destroy: vi.fn(() => { events.push("destroy"); destroyed = true; }) };
  const raw: ConnectProxy = { endpoint: { host: "127.0.0.1", port: 12345, realm: "test" }, credentialsFor: () => ({ username: "u", password: "p" }), revoke: vi.fn(async () => { events.push("proxyRevoke"); }) };
  const registry = createBrowserAuthorizationDomainRegistry({ gateOpen, isOwnerCurrent: (value) => current && value.owner === owner && value.profile === profile && value.conversationId === "c" && value.generation === 0 });
  const dependencies = { createSession: vi.fn((partition: string) => { events.push("session"); expect(partition.startsWith("persist:")).toBe(false); return port; }),
    createView: vi.fn(() => { events.push("view"); expect(handler({ url: "https://example.com", method: "GET", resourceType: "xhr" })).toBe(false); return view; }),
    proxyFactory: vi.fn(async () => { events.push("proxy"); return raw; }), cleanupTimeoutMs: 100, workerStopTimeoutMs: 40 };
  const controller = createBrowserNetworkController(registry, dependencies);
  return { controller, registry, dependencies, context, abort, events, port, contents, view, raw, stale: () => { current = false; }, allowed: () => handler({ url: "https://example.com", method: "GET", resourceType: "xhr" }) };
}
afterEach(() => vi.useRealTimers());
describe("offline browser prepare/dispose", () => {
  it("bounds per-domain disposal during a never-settling prepare and refuses mismatched context", async () => {
    const test = fixture(), wait = deferred<void>();
    vi.mocked(test.port.setProxy).mockImplementationOnce(() => wait.promise);
    const preparing = test.controller.prepare(test.context);
    for (let n = 0; n < 8; n++) await Promise.resolve();
    expect(await test.controller.disposeContext({ ...test.context, profile: {} })).toEqual({ ok: false, code: "owner_mismatch" });
    expect(test.contents.isDestroyed()).toBe(false);
    expect(await test.controller.disposeContext(test.context)).toEqual({ ok: false, code: "cleanup_failed" });
    expect(test.contents.isDestroyed()).toBe(true); expect(test.port.clearStorageData).toHaveBeenCalledTimes(1); expect(test.allowed()).toBe(false);
    wait.resolve(); expect(await preparing).toEqual({ ok: false, code: "cleanup_failed" });
  });
  it("maps real Session APIs to fail-closed permissions, sole proxy, and all cleanup operations", async () => {
    let request: ((details: BrowserRequestDetails, callback: (response: { cancel: boolean }) => void) => void) | undefined;
    let check: (() => boolean) | undefined, device: (() => boolean) | undefined;
    let permission: ((contents: unknown, name: string, callback: (allowed: boolean) => void) => void) | undefined;
    let download: ((event: { preventDefault(): void }) => void) | undefined;
    const native = {
      storagePath: null,
      webRequest: { onBeforeRequest: vi.fn((handler: NonNullable<typeof request>) => { request = handler; }) },
      setPermissionCheckHandler: vi.fn((handler: NonNullable<typeof check> | null) => { check = handler ?? undefined; }),
      setPermissionRequestHandler: vi.fn((handler: NonNullable<typeof permission> | null) => { permission = handler ?? undefined; }),
      setDevicePermissionHandler: vi.fn((handler: NonNullable<typeof device> | null) => { device = handler ?? undefined; }),
      on: vi.fn((_event: "will-download", listener: NonNullable<typeof download>) => { download = listener; }),
      setProxy: vi.fn(async () => {}), closeAllConnections: vi.fn(async () => {}), clearStorageData: vi.fn(async () => {}), clearCache: vi.fn(async () => {}),
      clearAuthCache: vi.fn(async () => {}), clearHostResolverCache: vi.fn(async () => {}), serviceWorkers: { getAllRunning: () => ({ 42: { renderProcessId: 2, scope: "https://example.com/", scriptUrl: "https://example.com/sw.js", versionId: 42 } }) },
    };
    const port = createElectronBrowserSessionPort(native);
    expect(port.session).toBe(native); expect(port.persistent).toBe(false);
    port.installRequestHandler(() => { throw new Error("fail"); });
    const callback = vi.fn(); request?.({ url: "https://example.com", method: "GET", resourceType: "xhr" }, callback);
    expect(callback).toHaveBeenCalledWith({ cancel: true });
    port.denyPermissions(); expect(check?.()).toBe(false); expect(device?.()).toBe(false);
    permission?.({}, "camera", callback); expect(callback).toHaveBeenCalledWith(false);
    const preventDefault = vi.fn(); download?.({ preventDefault }); expect(preventDefault).toHaveBeenCalledTimes(1);
    await port.setProxy({ host: "127.0.0.1", port: 32123, realm: "realm" });
    expect(native.setProxy).toHaveBeenCalledWith({ mode: "fixed_servers", proxyRules: "http://127.0.0.1:32123", proxyBypassRules: "<-loopback>" });
    expect(port.runningWorkerCount()).toBe(1);
    for (const operation of [port.closeAllConnections, port.clearStorageData, port.clearCache, port.clearAuthCache, port.clearHostResolverCache]) await operation();
    for (const operation of [native.closeAllConnections, native.clearStorageData, native.clearCache, native.clearAuthCache, native.clearHostResolverCache]) expect(operation).toHaveBeenCalledTimes(1);
    expect(createElectronBrowserSessionPort({ ...native, storagePath: "real-user-data" }).persistent).toBe(true);
  });
  it("lets an installed handler accept a download, and refuses everything else", () => {
    let listener: ((event: { preventDefault(): void }, item: unknown) => void) | undefined;
    const native = {
      storagePath: null, webRequest: { onBeforeRequest: vi.fn() }, setPermissionCheckHandler: vi.fn(), setPermissionRequestHandler: vi.fn(), setDevicePermissionHandler: vi.fn(),
      on: vi.fn((_event: "will-download", next: NonNullable<typeof listener>) => { listener = next; }),
      setProxy: vi.fn(), closeAllConnections: vi.fn(), clearStorageData: vi.fn(), clearCache: vi.fn(), clearAuthCache: vi.fn(), clearHostResolverCache: vi.fn(),
      serviceWorkers: { getAllRunning: () => ({}) },
    };
    const port = createElectronBrowserSessionPort(native as never);
    port.denyPermissions();
    const item = { name: "item" }, refused = vi.fn();
    listener?.({ preventDefault: refused }, item); expect(refused).toHaveBeenCalledTimes(1); // no handler yet
    const handler = vi.fn(() => true); port.installDownloadHandler?.(handler);
    const accepted = vi.fn(); listener?.({ preventDefault: accepted }, item);
    expect(handler).toHaveBeenCalledWith(item); expect(accepted).not.toHaveBeenCalled();
    handler.mockReturnValueOnce(false); const declined = vi.fn(); listener?.({ preventDefault: declined }, item); expect(declined).toHaveBeenCalledTimes(1);
    handler.mockImplementationOnce(() => { throw new Error("boom"); }); const thrown = vi.fn(); listener?.({ preventDefault: thrown }, item); expect(thrown).toHaveBeenCalledTimes(1);
  });
  it("keeps closed gate and unregistered owners at zero factory calls", async () => {
    const test = fixture(false);
    expect(await test.controller.prepare(test.context)).toEqual({ ok: false, code: "permission_denied" });
    expect(test.events).toEqual([]);
    const other = fixture();
    expect(await other.controller.prepare({ ...other.context, owner: {} })).toEqual({ ok: false, code: "permission_denied" });
    expect(other.events).toEqual([]);
  });
  it("installs deny/permissions before hidden view, activates only after proxy and connection closure", async () => {
    const test = fixture(), result = await test.controller.prepare(test.context, { hosts: ["example.com"] });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("binding missing");
    expect(test.events).toEqual(["session", "deny", "permissions", "view", "proxy", "setProxy", "connections"]);
    expect(test.allowed()).toBe(true);
    expect(test.port.setProxy).toHaveBeenCalledWith(test.raw.endpoint);
    const cleanup = result.value.dispose();
    expect(test.allowed()).toBe(false);
    expect(test.view.destroy).toHaveBeenCalledTimes(1);
    expect(result.value.dispose()).toBe(cleanup);
    expect(await cleanup).toEqual({ ok: true, value: undefined });
    expect(test.events.slice(-5)).toEqual(["connections", "storage", "cache", "auth", "resolver"]);
  });
  it("removes the exact parent abort listener after successful cleanup", async () => {
    const test = fixture(), add = vi.spyOn(test.abort.signal, "addEventListener"), remove = vi.spyOn(test.abort.signal, "removeEventListener");
    const result = await test.controller.prepare(test.context);
    if (!result.ok) throw new Error("binding missing");
    const listeners = add.mock.calls.filter(([event]) => event === "abort").map(([, listener]) => listener);
    await result.value.dispose();
    for (const listener of listeners) expect(remove.mock.calls.some(([event, removed]) => event === "abort" && removed === listener)).toBe(true);
    test.abort.abort(); expect(test.view.destroy).toHaveBeenCalledTimes(1);
  });
  it("rejects persistent/reused Session without changing or cleaning its resources", async () => {
    const persistent = fixture();
    persistent.port.persistent = true;
    expect((await persistent.controller.prepare(persistent.context)).ok).toBe(false);
    expect(persistent.events).toEqual(["session"]);
    const reused = fixture(), first = await reused.controller.prepare(reused.context);
    if (!first.ok) throw new Error("binding missing");
    await first.value.dispose(); reused.events.length = 0;
    expect((await reused.controller.prepare(reused.context)).ok).toBe(false);
    expect(reused.events).toEqual(["session"]);
  });
  it("permanently retires a cancelled allocation across controllers sharing the registry", async () => {
    const test = fixture();
    test.dependencies.createSession.mockImplementationOnce(() => { test.abort.abort(); return test.port; });
    vi.mocked(test.port.clearStorageData).mockRejectedValueOnce(new Error("old storage remains"));
    expect(await test.controller.prepare(test.context)).toEqual({ ok: false, code: "cleanup_failed" });
    expect(test.registry.hasSeenSession(test.port.session)).toBe(true);
    test.events.length = 0;
    const second = createBrowserNetworkController(test.registry, test.dependencies);
    const next = { ...test.context, signal: new AbortController().signal };
    expect(await second.prepare(next)).toEqual({ ok: false, code: "permission_denied" });
    expect(test.events).toEqual(["session"]);
    expect(test.port.installRequestHandler).toHaveBeenCalledTimes(1);
    expect(test.port.clearStorageData).toHaveBeenCalledTimes(1);
  });
  it("reserves the owner/browser before the first await; concurrent prepare cannot start", async () => {
    const test = fixture(), wait = deferred<ConnectProxy>();
    test.dependencies.proxyFactory.mockImplementation(() => wait.promise);
    const preparing = test.controller.prepare(test.context);
    expect(await test.controller.prepare(test.context)).toEqual({ ok: false, code: "closed" });
    expect(test.dependencies.createSession).toHaveBeenCalledTimes(1);
    wait.resolve(test.raw); const ready = await preparing;
    if (ready.ok) await ready.value.dispose();
  });
  it.each(["proxy", "setProxy", "connections"])("cancellation across %s await prevents activation and later preparation effects", async (boundary) => {
    const test = fixture(), wait = deferred<void>(), proxyWait = deferred<ConnectProxy>();
    if (boundary === "proxy") test.dependencies.proxyFactory.mockImplementation(() => proxyWait.promise);
    if (boundary === "setProxy") vi.mocked(test.port.setProxy).mockImplementationOnce(() => wait.promise);
    if (boundary === "connections") vi.mocked(test.port.closeAllConnections).mockImplementationOnce(() => wait.promise);
    const preparing = test.controller.prepare(test.context);
    for (let i = 0; i < 8; i++) await Promise.resolve();
    test.abort.abort(); proxyWait.resolve(test.raw); wait.resolve();
    const result = await preparing;
    expect(result).toEqual({ ok: false, code: "cancelled" });
    expect(test.allowed()).toBe(false); expect(test.view.destroy).toHaveBeenCalledTimes(1);
    expect(test.raw.revoke).toHaveBeenCalledTimes(1);
    if (boundary === "proxy") expect(test.port.setProxy).not.toHaveBeenCalled();
    expect(test.port.clearStorageData).toHaveBeenCalledTimes(1);
  });
  it("rechecks after synchronous factories too, and snapshots caller policy before them", async () => {
    const test = fixture(); test.dependencies.createSession.mockImplementationOnce(() => { test.abort.abort(); return test.port; });
    expect(await test.controller.prepare(test.context)).toEqual({ ok: false, code: "cancelled" });
    expect(test.dependencies.createView).not.toHaveBeenCalled();
    expect(test.port.clearStorageData).toHaveBeenCalledTimes(1);
    const other = fixture(), hosts = ["example.com"];
    other.dependencies.createSession.mockImplementationOnce(() => { hosts.push("example.org"); return other.port; });
    const ready = await other.controller.prepare(other.context, { hosts });
    if (!ready.ok) throw new Error("binding missing");
    expect(ready.value.epoch.policy.hosts).toEqual(["example.com"]); await ready.value.dispose();
  });
  it("stale generation after an await permanently denies the binding", async () => {
    const test = fixture(), wait = deferred<void>();
    vi.mocked(test.port.setProxy).mockImplementationOnce(() => wait.promise);
    const preparing = test.controller.prepare(test.context);
    for (let i = 0; i < 8; i++) await Promise.resolve();
    test.stale(); wait.resolve();
    expect(await preparing).toEqual({ ok: false, code: "owner_mismatch" });
    expect(test.allowed()).toBe(false);
  });
  it("preserves owner_mismatch when the proxy adapter detects a stale owner after await", async () => {
    const test = fixture(), wait = deferred<ConnectProxy>();
    test.dependencies.proxyFactory.mockImplementationOnce(() => wait.promise);
    const preparing = test.controller.prepare(test.context);
    test.stale(); wait.resolve(test.raw);
    expect(await preparing).toEqual({ ok: false, code: "owner_mismatch" });
    expect(test.port.setProxy).not.toHaveBeenCalled(); expect(test.raw.revoke).toHaveBeenCalledTimes(1);
  });
  it("attempts all cleanup despite destroy/storage failures, keeps failure sticky", async () => {
    const test = fixture(), ready = await test.controller.prepare(test.context);
    if (!ready.ok) throw new Error("binding missing");
    test.view.destroy.mockImplementationOnce(() => { throw new Error("private"); });
    vi.mocked(test.port.clearStorageData).mockRejectedValueOnce(new Error("private storage"));
    const result = await ready.value.dispose();
    expect(result).toEqual({ ok: false, code: "cleanup_failed" });
    expect(await ready.value.dispose()).toBe(result);
    for (const operation of [test.port.closeAllConnections, test.port.clearCache, test.port.clearAuthCache, test.port.clearHostResolverCache]) expect(operation).toHaveBeenCalled();
    expect(await test.controller.prepare(test.context)).toEqual({ ok: false, code: "closed" });
  });
  it("revokeAll cancels pending preparation; a late proxy is reclaimed", async () => {
    const test = fixture(), wait = deferred<ConnectProxy>();
    test.dependencies.proxyFactory.mockImplementationOnce(() => wait.promise);
    const pending = test.controller.prepare(test.context);
    test.controller.revokeAll(); expect(test.view.destroy).toHaveBeenCalledTimes(1);
    wait.resolve(test.raw);
    expect(await pending).toEqual({ ok: false, code: "closed" });
    expect(test.raw.revoke).toHaveBeenCalledTimes(1); expect(test.port.setProxy).not.toHaveBeenCalled();
  });
  it("reports late proxy cleanup rejection as cleanup_failed rather than successful cancellation", async () => {
    const test = fixture(), wait = deferred<ConnectProxy>();
    test.dependencies.proxyFactory.mockImplementationOnce(() => wait.promise);
    vi.mocked(test.raw.revoke).mockRejectedValueOnce(new Error("private cleanup"));
    const preparing = test.controller.prepare(test.context);
    test.abort.abort(); wait.resolve(test.raw);
    expect(await preparing).toEqual({ ok: false, code: "cleanup_failed" });
    expect(await test.controller.disposeAll()).toEqual({ ok: false, code: "cleanup_failed" });
    expect(test.port.clearStorageData).toHaveBeenCalledTimes(1);
  });
  it("times out unknown late resources without claiming successful dispose; late proxy still closes", async () => {
    vi.useFakeTimers(); const test = fixture(), wait = deferred<ConnectProxy>();
    test.dependencies.proxyFactory.mockImplementationOnce(() => wait.promise);
    const pending = test.controller.prepare(test.context), cleanup = test.controller.disposeAll();
    await vi.advanceTimersByTimeAsync(101);
    expect(await cleanup).toEqual({ ok: false, code: "cleanup_failed" });
    expect(test.port.clearStorageData).toHaveBeenCalledTimes(1);
    wait.resolve(test.raw); expect(await pending).toEqual({ ok: false, code: "cleanup_failed" });
    expect(test.raw.revoke).toHaveBeenCalledTimes(1);
  });
  it("bounds each cleanup promise and worker quiescence, still attempts other operations", async () => {
    vi.useFakeTimers(); const test = fixture(), ready = await test.controller.prepare(test.context);
    if (!ready.ok) throw new Error("binding missing");
    vi.mocked(test.port.clearStorageData).mockImplementationOnce(() => new Promise(() => {}));
    vi.mocked(test.port.runningWorkerCount).mockReturnValue(1);
    const cleanup = ready.value.dispose(); await vi.advanceTimersByTimeAsync(101);
    expect(await cleanup).toEqual({ ok: false, code: "cleanup_failed" });
    expect(test.port.clearCache).toHaveBeenCalledTimes(1); expect(test.allowed()).toBe(false);
  });
  it("does not declare cleanup complete when destroy silently leaves native contents alive", async () => {
    vi.useFakeTimers(); const test = fixture(), ready = await test.controller.prepare(test.context);
    if (!ready.ok) throw new Error("binding missing");
    test.view.destroy.mockImplementationOnce(() => {});
    const cleanup = ready.value.dispose(); await vi.advanceTimersByTimeAsync(41);
    expect(await cleanup).toEqual({ ok: false, code: "cleanup_failed" });
    expect(test.port.clearStorageData).toHaveBeenCalledTimes(1);
  });
  it("observes worker termination after clear rather than treating clear resolution as zero workers", async () => {
    vi.useFakeTimers(); const test = fixture(), ready = await test.controller.prepare(test.context);
    if (!ready.ok) throw new Error("binding missing");
    vi.mocked(test.port.runningWorkerCount).mockReturnValueOnce(1).mockReturnValue(0);
    const cleanup = ready.value.dispose(); await vi.advanceTimersByTimeAsync(20);
    expect(await cleanup).toEqual({ ok: true, value: undefined });
    expect(test.port.runningWorkerCount).toHaveBeenCalledTimes(2);
  });
  it("disposeAll synchronously revokes all domains and attempts B even when A fails", async () => {
    const test = fixture(), secondSession = {}, second = { ...test.port, session: secondSession, clearStorageData: vi.fn(async () => {}) };
    test.dependencies.createSession.mockReturnValueOnce(test.port).mockReturnValueOnce(second);
    let secondDestroyed = false;
    test.dependencies.createView.mockReturnValueOnce(test.view).mockReturnValueOnce({ contents: { id: 23, session: secondSession, isDestroyed: () => secondDestroyed }, destroy: vi.fn(() => { secondDestroyed = true; }) });
    const a = await test.controller.prepare(test.context), b = await test.controller.prepare({ ...test.context, browserId: "b2" });
    if (!a.ok || !b.ok) throw new Error("bindings missing");
    vi.mocked(test.port.clearStorageData).mockRejectedValueOnce(new Error("private"));
    const cleanup = test.controller.disposeAll();
    expect(a.value.isCurrent()).toBe(false); expect(b.value.isCurrent()).toBe(false);
    expect(await cleanup).toEqual({ ok: false, code: "cleanup_failed" });
    expect(second.clearStorageData).toHaveBeenCalledTimes(1);
  });
});
