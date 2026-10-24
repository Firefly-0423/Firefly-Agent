import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElectronBrowserService } from "./electron-browser-service";
import { createBrowserWorkspaceExecutor } from "./browser-workspace-executor";
import { createBrowserWorkspaceTool } from "../orchestrator/tools/browser-workspace-tool";
import type { BrowserGuestPort, BrowserHostPort, TrustedBrowserOwner } from "./browser-service";
import type { RuntimeProfile } from "../runtime-profile";

const native = vi.hoisted(() => ({ confirm: vi.fn(), effects: [] as string[], cleanup: async () => {} }));
vi.mock("electron", () => ({
  dialog: { showMessageBox: native.confirm },
  session: { fromPartition: () => ({
    storagePath: null, webRequest: { onBeforeRequest() {} }, serviceWorkers: { getAllRunning: () => ({}) },
    setPermissionCheckHandler() {}, setPermissionRequestHandler() {}, setDevicePermissionHandler() {}, on() {},
    setProxy: async () => {}, closeAllConnections: async () => {}, clearStorageData: async () => { await native.cleanup(); },
    clearCache: async () => {}, clearAuthCache: async () => {}, clearHostResolverCache: async () => {},
  }) },
}));
vi.mock("./trusted-browser-resolver", () => ({ createTrustedBrowserProxyFactory: () => async () => ({
  endpoint: { host: "127.0.0.1", port: 1234, realm: "fixture" }, credentialsFor: () => null,
  revoke: async () => { native.effects.push("proxy-revoked"); },
}) }));
vi.mock("./electron-browser-guest", () => ({ createElectronBrowserGuest: (session: object): BrowserGuestPort<object> => {
  let url = "", destroyed = false;
  return {
    contents: { id: 20, session, isDestroyed: () => destroyed },
    loadURL: async target => { url = target; native.effects.push(`load:${target}`); },
    history: async action => { native.effects.push(action); },
    snapshot: () => ({ url, canGoBack: true, canGoForward: true }),
    observe: async () => ({ snapshotId: "snapshot", url, title: "Public page", text: "Actual guest text", elements: [{ ref: "1", tag: "input", role: "textbox", name: "Search" }] }),
    act: async input => { native.effects.push(input.kind); return true; },
    stop() {}, attach() {}, detach() {}, setBounds() {}, installCallbacks() {},
    destroy() { destroyed = true; native.effects.push("destroyed"); },
  };
} }));

const agentScope = { mode: "agent", hosts: ["example.com", "github.com", "github.githubassets.com", "avatars.githubusercontent.com"], actions: ["navigate", "observe", "click", "type"] };
const manualScope = { mode: "manual", hosts: ["example.com"], resourceHosts: [], actions: ["navigate"] };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; }
const services: ReturnType<typeof createElectronBrowserService>[] = [];
function fixture() {
  const profile = {} as RuntimeProfile, ownerAbort = new AbortController(), runAbort = new AbortController();
  const mainFrame = {}, webContents = Object.assign(new EventEmitter(), { id: 10, mainFrame, isDestroyed: () => false });
  const host: BrowserHostPort = Object.assign(new EventEmitter(), { webContents, isDestroyed: () => false, isVisible: () => true, isFocused: () => true,
    getContentSize: () => [800, 600], contentView: { addChildView() {}, removeChildView() {} } });
  const owner: TrustedBrowserOwner = { host, topFrame: mainFrame, profile, conversationId: "conversation", ownerSessionId: "owner", generation: 1, signal: ownerAbort.signal };
  const service = createElectronBrowserService({ profile, trustedResolver: { server: "192.0.2.53", port: 53 } });
  services.push(service); service.registerHost(host, () => owner);
  const sender = { sender: webContents, senderFrame: mainFrame };
  let active = true;
  const tool = createBrowserWorkspaceTool(createBrowserWorkspaceExecutor({ currentOwner: () => owner, service: () => service, isRunCurrent: () => active }));
  const context = { userQuery: "Browse", conversationId: "conversation", runId: "run", signal: runAbort.signal, mode: "work" as const };
  const permission = (scope: unknown) => service.dispatchPermission(sender, { kind: "request", scope });
  const show = async () => {
    const page = await service.dispatch(sender, { kind: "get" });
    if (!page.ok || !page.value) throw new Error("missing page");
    await service.dispatch(sender, { kind: "layout", browserId: page.value.browserId, bounds: { x: 0, y: 0, width: 300, height: 200 } });
  };
  return { service, sender, owner, tool, context, permission, show, ownerAbort, runAbort, stopRun: () => { active = false; } };
}
beforeEach(() => { native.confirm.mockReset(); native.confirm.mockResolvedValue({ response: 1 }); native.effects.length = 0; native.cleanup = async () => {}; });
afterEach(async () => { native.cleanup = async () => {}; await Promise.all(services.splice(0).map(service => service.dispose())); });

describe("production browser composition preserves separate Agent approval", () => {
  it("runs the real browser_workspace tool after native approval of the exact baseline Agent scope", async () => {
    const f = fixture();
    expect(await f.service.dispatchPermission(f.sender, { kind: "get" })).toMatchObject({ ok: true, value: { status: "required", scope: { mode: "manual" }, agentScope } });
    await expect(f.tool.execute({ operation: "open", url: "https://example.com/" }, f.context)).rejects.toMatchObject({ code: "BROWSER_PERMISSION_DENIED" });
    expect(await f.permission(agentScope)).toMatchObject({ ok: true, value: { status: "granted", scope: agentScope } });
    const prompt = native.confirm.mock.calls.at(-1)![1];
    expect(prompt.message).toContain("代理"); expect(prompt.detail).toContain("读取页面文字");
    for (const host of agentScope.hosts) expect(prompt.detail).toContain(host);
    expect(JSON.parse(await f.tool.execute({ operation: "open", url: "https://example.com/" }, f.context))).toMatchObject({ success: true, result: { url: "https://example.com/" } });
    await f.show();
    expect(JSON.parse(await f.tool.execute({ operation: "observe" }, f.context))).toMatchObject({ contentTrust: "untrusted_web_page", result: { text: "Actual guest text" } });
    await f.tool.execute({ operation: "click", snapshotId: "snapshot", ref: "1" }, f.context);
    await f.tool.execute({ operation: "observe" }, f.context);
    await f.tool.execute({ operation: "type", snapshotId: "snapshot", ref: "1", text: "query" }, f.context);
    expect(native.effects).toContain("click"); expect(native.effects).toContain("type");
    expect(JSON.parse(await f.tool.execute({ operation: "navigate", url: "https://github.com/" }, f.context))).toMatchObject({ success: true, result: { url: "https://github.com/" } });
    await expect(f.tool.execute({ operation: "navigate", url: "https://outside.example/" }, f.context)).rejects.toMatchObject({ code: "BROWSER_BLOCKED_URL" });
    f.stopRun(); await expect(f.tool.execute({ operation: "observe" }, f.context)).rejects.toMatchObject({ code: "BROWSER_OWNER_MISMATCH" });
  });

  it("never allows any Agent operation or self-authorization under manual permission", async () => {
    const f = fixture(); await f.permission(manualScope);
    await f.service.dispatch(f.sender, { kind: "open", url: "https://example.com/" });
    for (const operation of ["open", "navigate", "back", "forward", "reload", "observe", "click", "type", "close", "requestPermission"]) {
      await expect(f.tool.execute({ operation, url: "https://example.com/" }, f.context)).rejects.toMatchObject({ code: "BROWSER_PERMISSION_DENIED" });
    }
    expect(native.confirm).toHaveBeenCalledTimes(1);
    expect(native.effects).not.toContain("click"); expect(native.effects).not.toContain("type");
  });

  it("waits for old manual page cleanup and fresh Agent consent before granting Agent access", async () => {
    const f = fixture(); await f.permission(manualScope);
    await f.service.dispatch(f.sender, { kind: "open", url: "https://example.com/" });
    const cleanup = deferred<void>(), decision = deferred<{ response: number }>(); native.cleanup = () => cleanup.promise;
    native.confirm.mockImplementationOnce(() => decision.promise);
    const switching = f.permission(agentScope);
    await vi.waitFor(() => expect(native.effects).toContain("destroyed"));
    expect(native.confirm).toHaveBeenCalledTimes(1);
    await expect(f.tool.execute({ operation: "observe" }, f.context)).rejects.toMatchObject({ code: "BROWSER_PERMISSION_DENIED" });
    cleanup.resolve(); await vi.waitFor(() => expect(native.confirm).toHaveBeenCalledTimes(2));
    await expect(f.tool.execute({ operation: "open", url: "https://example.com/" }, f.context)).rejects.toMatchObject({ code: "BROWSER_PERMISSION_DENIED" });
    decision.resolve({ response: 1 }); expect(await switching).toMatchObject({ ok: true, value: { status: "granted", scope: agentScope } });
    expect(await f.service.dispatch(f.sender, { kind: "get" })).toEqual({ ok: true, value: null });
    await f.tool.execute({ operation: "open", url: "https://example.com/" }, f.context);
  });

  it("switches from Agent to manual with a new page and never reuses Agent snapshots", async () => {
    const f = fixture(); await f.permission(agentScope);
    await f.tool.execute({ operation: "open", url: "https://example.com/" }, f.context);
    await f.show();
    await f.tool.execute({ operation: "observe" }, f.context);
    expect(await f.permission(manualScope)).toMatchObject({ ok: true, value: { status: "granted", scope: manualScope } });
    expect(native.effects).toContain("destroyed");
    await f.service.dispatch(f.sender, { kind: "open", url: "https://example.com/" });
    await expect(f.tool.execute({ operation: "click", ref: "1", snapshotId: "snapshot" }, f.context)).rejects.toMatchObject({ code: "BROWSER_PERMISSION_DENIED" });
    await f.permission(agentScope); await f.tool.execute({ operation: "open", url: "https://example.com/" }, f.context);
    await expect(f.tool.execute({ operation: "click", ref: "1", snapshotId: "snapshot" }, f.context)).rejects.toMatchObject({ code: "BROWSER_PERMISSION_DENIED" });
  });

  it.each(["denied", "revoked"])("does not revive the previous grant after a %s mode switch", async outcome => {
    const f = fixture(); await f.permission(agentScope); await f.tool.execute({ operation: "open", url: "https://example.com/" }, f.context);
    const decision = deferred<{ response: number }>(); native.confirm.mockImplementationOnce(() => decision.promise);
    const switching = f.permission(manualScope); await vi.waitFor(() => expect(native.confirm).toHaveBeenCalledTimes(2));
    if (outcome === "revoked") await f.service.dispatchPermission(f.sender, { kind: "revoke" });
    decision.resolve({ response: outcome === "denied" ? 0 : 1 }); await switching;
    await expect(f.tool.execute({ operation: "open", url: "https://example.com/" }, f.context)).rejects.toMatchObject({ code: "BROWSER_PERMISSION_DENIED" });
    expect(await f.service.dispatch(f.sender, { kind: "get" })).toEqual({ ok: true, value: null });
    expect(await f.service.dispatchPermission(f.sender, { kind: "get" })).toMatchObject({ ok: true, value: { status: outcome === "denied" ? "denied" : "required" } });
  });

  it("rejects fabricated Agent modes, broader domains and manual resource authority without a dialog", async () => {
    const f = fixture();
    for (const scope of [{ ...agentScope, mode: "anything" }, { ...agentScope, hosts: ["outside.example"] },
      { ...agentScope, resourceHosts: ["cdn.example"] }, { ...manualScope, actions: ["navigate", "observe"] }]) {
      expect(await f.permission(scope)).toEqual({ ok: false, code: "permission_denied" });
    }
    expect(native.confirm).not.toHaveBeenCalled();
  });

  it.each(["agent", "manual"])("supersedes pending %s consent with the other mode and ignores late acceptance", async firstMode => {
    const f = fixture(), decision = deferred<{ response: number }>();
    native.confirm.mockImplementationOnce(() => decision.promise);
    const first = firstMode === "agent" ? agentScope : manualScope, next = firstMode === "agent" ? manualScope : agentScope;
    const pending = f.permission(first); await vi.waitFor(() => expect(native.confirm).toHaveBeenCalledTimes(1));
    const signal = native.confirm.mock.calls[0][1].signal as AbortSignal;
    expect(await f.permission(next)).toMatchObject({ ok: true, value: { status: "granted", scope: next } });
    expect(signal.aborted).toBe(true);
    decision.resolve({ response: 1 }); expect(await pending).toEqual({ ok: false, code: "cancelled" });
    expect(await f.service.dispatchPermission(f.sender, { kind: "get" })).toMatchObject({ ok: true, value: { scope: next } });
    if (next.mode === "agent") await f.tool.execute({ operation: "open", url: "https://example.com/" }, f.context);
    else await expect(f.tool.execute({ operation: "open", url: "https://example.com/" }, f.context)).rejects.toMatchObject({ code: "BROWSER_PERMISSION_DENIED" });
  });

  it("aborts native Agent consent when its owner is revoked and ignores an accepted late response", async () => {
    const f = fixture(), decision = deferred<{ response: number }>(); native.confirm.mockImplementationOnce(() => decision.promise);
    const pending = f.permission(agentScope); await vi.waitFor(() => expect(native.confirm).toHaveBeenCalledTimes(1));
    const signal = native.confirm.mock.calls[0][1].signal as AbortSignal;
    f.ownerAbort.abort(); expect(signal.aborted).toBe(true);
    decision.resolve({ response: 1 }); expect(await pending).toEqual({ ok: false, code: "cancelled" });
    await expect(f.tool.execute({ operation: "open", url: "https://example.com/" }, f.context)).rejects.toMatchObject({ code: "BROWSER_OWNER_MISMATCH" });
    expect(native.effects).toEqual([]);
  });
});
