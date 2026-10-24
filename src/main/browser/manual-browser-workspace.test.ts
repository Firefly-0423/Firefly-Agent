import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { createBrowserService, type BrowserGuestPort, type BrowserHostPort, type TrustedBrowserOwner } from "./browser-service";
import { createManualBrowserWorkspace } from "./manual-browser-workspace";
import type { BrowserSessionPort } from "./browser-network-binding";

const instances: ReturnType<typeof createManualBrowserWorkspace>[] = [];
function fixture(confirm = vi.fn(async () => true)) {
  const profile = {}, cancel = new AbortController(), frame = {}, effects: string[] = [];
  const contents = Object.assign(new EventEmitter(), { id: 10, mainFrame: frame, isDestroyed: () => false });
  const host: BrowserHostPort = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => false,
    isVisible: () => true, isFocused: () => true, getContentSize: () => [800, 600], contentView: { addChildView() {}, removeChildView() {} } });
  let owner: TrustedBrowserOwner = { host, topFrame: frame, profile, conversationId: null, workspaceId: "window", ownerSessionId: "root", generation: 1, signal: cancel.signal };
  const factory = vi.fn(onChanged => createBrowserService({ profile, manualBrowsing: true, permissionPolicy: { hosts: ["example.com"], actions: ["navigate"] }, confirmPermission: confirm, onChanged,
    createSession: () => ({ session: {}, persistent: false, installRequestHandler() {}, denyPermissions() {}, setProxy: async () => {}, closeAllConnections: async () => {},
      clearStorageData: async () => { effects.push("storage"); }, clearCache: async () => {}, clearAuthCache: async () => {}, clearHostResolverCache: async () => {}, runningWorkerCount: () => 0 } satisfies BrowserSessionPort<object>),
    createView: session => { let url = "", destroyed = false; return {
      contents: { id: 20, session, isDestroyed: () => destroyed }, loadURL: async target => { url = target; }, history: async () => {}, snapshot: () => ({ url, canGoBack: true, canGoForward: false }),
      stop() {}, attach: () => { effects.push("attach"); }, detach: () => { effects.push("detach"); }, setBounds() {}, installCallbacks() {}, destroy: () => { destroyed = true; },
    } satisfies BrowserGuestPort<object>; },
    proxyFactory: async () => ({ endpoint: { host: "127.0.0.1", port: 1234, realm: "fixture" }, credentialsFor: () => null, revoke: async () => {} }),
  }));
  const changed = vi.fn(), service = createManualBrowserWorkspace({ createService: factory, onChanged: changed }); instances.push(service);
  service.registerHost(host, () => owner);
  const event = { sender: contents, senderFrame: frame };
  const command = (input: unknown) => service.dispatchWorkspace(event, input);
  const permission = (input: unknown) => service.dispatchPermission(event, input);
  const grant = (tabId: string, hostname = "example.com") => permission({ kind: "request", tabId, scope: { mode: "manual", hosts: [hostname], resourceHosts: [], actions: ["navigate"] } });
  return { service, event, command, permission, grant, confirm, factory, changed, effects, cancel,
    replaceOwner() { cancel.abort(); owner = { ...owner, workspaceId: "new-window", ownerSessionId: "new", generation: 2, signal: new AbortController().signal }; } };
}
afterEach(async () => { await Promise.all(instances.splice(0).map(service => service.dispose())); });
async function firstTab(f: ReturnType<typeof fixture>) {
  const reply = await f.command({ kind: "tabs" });
  expect(reply).toMatchObject({ ok: true, value: { workspaceId: "window", tabs: [{ page: null }] } });
  return (reply as any).value.tabs[0].tabId as string;
}
it("opens an empty-session window tab only after its own native site consent", async () => {
  const f = fixture(), tabId = await firstTab(f);
  expect(await f.permission({ kind: "get", tabId })).toMatchObject({ ok: true, value: { conversationId: null, workspaceId: "window", tabId, status: "required" } });
  expect(await f.command({ kind: "open", tabId, url: "https://example.com/" })).toMatchObject({ ok: false, code: "permission_denied" });
  await f.grant(tabId);
  expect(await f.command({ kind: "open", tabId, url: "https://example.com/" })).toMatchObject({ ok: true, value: { conversationId: null, workspaceId: "window", tabId, url: "https://example.com/" } });
  expect(f.confirm).toHaveBeenCalledTimes(1);
});
it("keeps per-tab grants and page identities isolated and closing one preserves another", async () => {
  const f = fixture(), a = await firstTab(f); await f.grant(a);
  const page = await f.command({ kind: "open", tabId: a, url: "https://example.com/" });
  const created = await f.command({ kind: "new-tab" }), b = (created as any).value.activeTabId;
  expect(await f.permission({ kind: "get", tabId: b })).toMatchObject({ ok: true, value: { status: "required" } });
  await f.grant(b, "github.com"); await f.command({ kind: "open", tabId: b, url: "https://github.com/" });
  expect(await f.command({ kind: "navigate", tabId: b, browserId: (page as any).value.browserId, url: "https://github.com/" })).toMatchObject({ ok: false, code: "owner_mismatch" });
  expect(await f.command({ kind: "layout", tabId: a, browserId: (page as any).value.browserId, bounds: { x: 1, y: 1, width: 100, height: 100 } })).toMatchObject({ ok: false, code: "owner_mismatch" });
  expect(await f.command({ kind: "close-tab", tabId: a })).toMatchObject({ ok: true });
  expect(await f.permission({ kind: "get", tabId: b })).toMatchObject({ ok: true, value: { status: "granted", scope: { hosts: ["github.com"] } } });
  expect(f.effects).toContain("storage");
});
it("caps native tabs at eight without allocating a ninth service", async () => {
  const f = fixture(); await firstTab(f);
  for (let index = 1; index < 8; ++index) expect(await f.command({ kind: "new-tab" })).toMatchObject({ ok: true });
  expect(await f.command({ kind: "new-tab" })).toEqual({ ok: false, code: "tab_limit" });
  expect(f.factory).toHaveBeenCalledTimes(8);
});
it("cleans the old window owner before accepting a reload and never revives its grant", async () => {
  const f = fixture(), tabId = await firstTab(f); await f.grant(tabId); await f.command({ kind: "open", tabId, url: "https://example.com/" });
  f.replaceOwner();
  expect(await f.command({ kind: "tabs" })).toMatchObject({ ok: true, value: { workspaceId: "new-window", tabs: [{ page: null }] } });
  expect(await f.permission({ kind: "get" })).toMatchObject({ ok: true, value: { status: "required" } });
  expect(await f.command({ kind: "get", tabId })).toEqual({ ok: false, code: "closed" });
});
it("rejects foreign and missing/subframes before resolving tabs or consent", async () => {
  const f = fixture();
  for (const event of [{ ...f.event, senderFrame: null }, { ...f.event, senderFrame: {} }, { sender: {}, senderFrame: {} }]) {
    expect(await f.service.dispatchWorkspace(event as any, { kind: "tabs" })).toEqual({ ok: false, code: "owner_mismatch" });
    expect(await f.service.dispatchPermission(event as any, { kind: "request" })).toEqual({ ok: false, code: "owner_mismatch" });
  }
  expect(f.confirm).not.toHaveBeenCalled();
  expect(f.factory).toHaveBeenCalledTimes(1);
});
it("rejects Agent and conversation identities even under a granted manual tab", async () => {
  const f = fixture(), tabId = await firstTab(f); await f.grant(tabId);
  expect(await f.service.executeAgent()).toEqual({ ok: false, code: "owner_mismatch" });
  expect(await f.permission({ kind: "revoke", tabId, conversationId: "chat" })).toEqual({ ok: false, code: "owner_mismatch" });
  expect(await f.permission({ kind: "revoke", tabId, workspaceId: "foreign" })).toEqual({ ok: false, code: "owner_mismatch" });
  expect(await f.permission({ kind: "request", tabId, scope: { mode: "agent", hosts: ["example.com"], actions: ["navigate"] } })).toEqual({ ok: false, code: "permission_denied" });
});
