import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { createBrowserService, type BrowserGuestPort, type BrowserHostPort, type BrowserToolTarget, type TrustedBrowserOwner } from "./browser-service";
import { createManualBrowserWorkspace, type BrowserToolsPort } from "./manual-browser-workspace";
import type { BrowserSessionPort } from "./browser-network-binding";
import type { BrowserGuestTools } from "./browser-guest-tools";
import type { DownloadItemLike } from "./browser-downloads";

const instances: ReturnType<typeof createManualBrowserWorkspace>[] = [];
const WEB = { mode: "manual", web: true, hosts: [], resourceHosts: [], actions: ["navigate"] };

function fixture(options: { tools?: boolean; fakeTools?: boolean } = {}) {
  const profile = {}, cancel = new AbortController(), frame = {};
  const downloadHandlers: Array<(item: DownloadItemLike) => boolean> = [];
  const contents = Object.assign(new EventEmitter(), { id: 10, mainFrame: frame, isDestroyed: () => false });
  const host: BrowserHostPort = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => false,
    isVisible: () => true, isFocused: () => true, getContentSize: () => [800, 600], contentView: { addChildView() {}, removeChildView() {} } });
  const owner: TrustedBrowserOwner = { host, topFrame: frame, profile, conversationId: null, workspaceId: "window", ownerSessionId: "root", generation: 1, signal: cancel.signal };
  const tools = { state: () => ({ zoomPercent: 100, device: "off", find: null }), subscribe: () => () => {} } as unknown as BrowserGuestTools;
  const acceptDownload = vi.fn(() => true);
  const factory = vi.fn(onChanged => createBrowserService({ profile, manualBrowsing: true, permissionPolicy: { hosts: ["example.com"], actions: ["navigate"] },
    confirmPermission: async () => true, onChanged, acceptDownload,
    createSession: () => ({ session: {}, persistent: false, installRequestHandler() {}, installDownloadHandler: handler => { downloadHandlers.push(handler); }, denyPermissions() {},
      setProxy: async () => {}, closeAllConnections: async () => {}, clearStorageData: async () => {}, clearCache: async () => {}, clearAuthCache: async () => {},
      clearHostResolverCache: async () => {}, runningWorkerCount: () => 0 } satisfies BrowserSessionPort<object>),
    createView: session => { let url = "", destroyed = false; return {
      contents: { id: 20, session, isDestroyed: () => destroyed }, ...(options.fakeTools === false ? {} : { tools }),
      loadURL: async target => { url = target; }, history: async () => {}, snapshot: () => ({ url, canGoBack: false, canGoForward: false }),
      stop() {}, attach() {}, detach() {}, setBounds() {}, installCallbacks() {}, destroy: () => { destroyed = true; },
    } satisfies BrowserGuestPort<object>; },
    proxyFactory: async () => ({ endpoint: { host: "127.0.0.1", port: 1234, realm: "fixture" }, credentialsFor: () => null, revoke: async () => {} }),
  }));
  const hubTab = vi.fn(async (_target: BrowserToolTarget, request: { tool: string }, tabId: string) => ({ ran: request.tool, tabId }));
  const hubGlobal = vi.fn(async (_host: BrowserHostPort, request: { tool: string }) => ({ global: request.tool }));
  const port: BrowserToolsPort = { tab: hubTab as never, global: hubGlobal as never };
  const service = createManualBrowserWorkspace({ createService: factory, onChanged: vi.fn(), ...(options.tools === false ? {} : { tools: port }) });
  instances.push(service); service.registerHost(host, () => owner);
  const event = { sender: contents, senderFrame: frame };
  const command = (input: unknown) => service.dispatchWorkspace(event, input);
  const permission = (input: unknown) => service.dispatchPermission(event, input);
  const tool = (request: unknown, tabId?: string) => command({ kind: "tool", ...(tabId === undefined ? {} : { tabId }), request });
  return { service, event, command, permission, tool, hubTab, hubGlobal, acceptDownload, downloadHandlers, cancel };
}
afterEach(async () => { await Promise.all(instances.splice(0).map(service => service.dispose())); });

async function openPage(f: ReturnType<typeof fixture>, scope: unknown = WEB, url = "https://example.com/") {
  const reply = await f.command({ kind: "tabs" });
  const tabId = (reply as any).value.tabs[0].tabId as string;
  expect(await f.permission({ kind: "request", tabId, scope })).toMatchObject({ ok: true, value: { status: "granted" } });
  expect(await f.command({ kind: "open", tabId, url })).toMatchObject({ ok: true });
  return tabId;
}

it("answers a tab tool for an ordinary-browsing page, passing the page's own tools, window and address", async () => {
  const f = fixture(), tabId = await openPage(f);
  expect(await f.tool({ tool: "zoom", op: "in" }, tabId)).toEqual({ ok: true, value: { ran: "zoom", tabId } });
  const [target, request, id] = f.hubTab.mock.calls[0];
  expect(request).toEqual({ tool: "zoom", op: "in" }); expect(id).toBe(tabId);
  expect(target.url).toBe("https://example.com/"); expect(target.tools).toBeDefined(); expect(target.host).toBeDefined();
  expect(await f.tool({ tool: "state" })).toMatchObject({ ok: true, value: { ran: "state", tabId } }); // active tab by default
});

it("refuses tab tools for a host-limited manual grant", async () => {
  const f = fixture(), tabId = await openPage(f, { mode: "manual", hosts: ["example.com"], resourceHosts: [], actions: ["navigate"] });
  expect(await f.tool({ tool: "zoom", op: "in" }, tabId)).toEqual({ ok: false, code: "permission_denied" });
  expect(f.hubTab).not.toHaveBeenCalled();
});

it("reports a closed tab when no page has been opened, and an unknown tab as closed", async () => {
  const f = fixture(); const reply = await f.command({ kind: "tabs" }); const tabId = (reply as any).value.tabs[0].tabId as string;
  expect(await f.tool({ tool: "state" }, tabId)).toEqual({ ok: false, code: "closed" });
  expect(await f.tool({ tool: "state" }, "no-such-tab")).toEqual({ ok: false, code: "closed" });
  expect(f.hubTab).not.toHaveBeenCalled();
});

it("is unsupported when the guest offers no tools, and when the composition has no hub", async () => {
  const bare = fixture({ fakeTools: false }), tabId = await openPage(bare);
  expect(await bare.tool({ tool: "state" }, tabId)).toEqual({ ok: false, code: "unsupported" });
  const none = fixture({ tools: false });
  expect(await none.tool({ tool: "state" })).toEqual({ ok: false, code: "unsupported" });
});

it("refuses a malformed tool command before doing anything", async () => {
  const f = fixture(); await openPage(f);
  for (const input of [
    { kind: "tool" }, { kind: "tool", request: { tool: "eval" } }, { kind: "tool", request: { tool: "state" }, extra: true },
    { kind: "tool", tabId: 5, request: { tool: "state" } }, { kind: "tool", request: { tool: "find", text: "", forward: true, next: false } },
    { kind: "tool", request: { tool: "clear-data", kinds: ["cache"], domain: "example.com" } },
  ]) expect(await f.command(input), JSON.stringify(input)).toEqual({ ok: false, code: "permission_denied" });
  expect(f.hubTab).not.toHaveBeenCalled(); expect(f.hubGlobal).not.toHaveBeenCalled();
});

it("answers window-wide tools without needing a page, but only for the window's own renderer", async () => {
  const f = fixture();
  expect(await f.tool({ tool: "download", op: "list" })).toEqual({ ok: true, value: { global: "download" } });
  expect(await f.tool({ tool: "settings", patch: { askWhereToSave: true } })).toEqual({ ok: true, value: { global: "settings" } });
  const stranger = { sender: { id: 99, mainFrame: {}, isDestroyed: () => false }, senderFrame: {} };
  expect(await f.service.dispatchWorkspace(stranger as never, { kind: "tool", request: { tool: "download", op: "list" } })).toEqual({ ok: false, code: "owner_mismatch" });
  expect(f.hubGlobal).toHaveBeenCalledTimes(2);
});

it("maps a failing tool to a failed reply instead of throwing", async () => {
  const f = fixture(), tabId = await openPage(f);
  f.hubTab.mockRejectedValueOnce(new Error("boom"));
  expect(await f.tool({ tool: "print" }, tabId)).toEqual({ ok: false, code: "failed" });
});

it("offers a download to the composition only for a current ordinary-browsing page", async () => {
  const web = fixture(); await openPage(web);
  expect(web.downloadHandlers).toHaveLength(1);
  expect(web.downloadHandlers[0]({} as DownloadItemLike)).toBe(true);
  expect(web.acceptDownload).toHaveBeenCalledTimes(1);
  web.acceptDownload.mockReturnValueOnce(false);
  expect(web.downloadHandlers[0]({} as DownloadItemLike)).toBe(false);

  const limited = fixture(); await openPage(limited, { mode: "manual", hosts: ["example.com"], resourceHosts: [], actions: ["navigate"] });
  expect(limited.downloadHandlers[0]({} as DownloadItemLike)).toBe(false);
  expect(limited.acceptDownload).not.toHaveBeenCalled();
});

it("refuses downloads after the page's owner is revoked", async () => {
  const f = fixture(); await openPage(f);
  f.cancel.abort();
  expect(f.downloadHandlers[0]({} as DownloadItemLike)).toBe(false);
  expect(f.acceptDownload).not.toHaveBeenCalled();
});
