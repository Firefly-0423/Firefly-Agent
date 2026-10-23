import { randomUUID } from "node:crypto";
import type { createBrowserService, BrowserHostPort, BrowserInvokeEvent, BrowserToolTarget, TrustedBrowserOwner } from "./browser-service";
import { parseBrowserToolRequest, type BrowserToolErrorCode, type BrowserToolReply, type BrowserToolRequest } from "../../shared/browser-tools";
import type { BrowserOwnedPageDto, BrowserReply, BrowserWorkspacePageDto, BrowserWorkspacePermissionDto, BrowserWorkspaceStateDto } from "../../shared/manual-browser";

type Service = ReturnType<typeof createBrowserService<object>>;
interface Tab { id: string; owner: TrustedBrowserOwner; cancel: AbortController; service: Service; off(): void }
interface Host { host: BrowserHostPort; resolve(event: BrowserInvokeEvent): TrustedBrowserOwner | null; owner?: TrustedBrowserOwner; tabs: Map<string, Tab>; active: string | null; transition: boolean }
const fail = (code: "owner_mismatch" | "closed" | "tab_limit" | "cleanup_failed" | "permission_denied" | "cancelled"): BrowserReply<never> => ({ ok: false, code });
const toolFail = (code: BrowserToolErrorCode): BrowserToolReply<never> => ({ ok: false, code });
/** Main composition of the window-browser tools (see browser-tools-hub). The workspace only routes and authorises. */
export interface BrowserToolsPort {
  tab(target: BrowserToolTarget, request: BrowserToolRequest, tabId: string): Promise<unknown>;
  global(host: BrowserHostPort, request: BrowserToolRequest): Promise<unknown>;
}

/** Each tab reuses the existing single-page security service with a distinct
 * native owner/session. Window routing never merges grants or network contexts. */
export function createManualBrowserWorkspace(options: {
  createService(onChanged: (owner: TrustedBrowserOwner, page: BrowserOwnedPageDto) => void): Service;
  onChanged(owner: TrustedBrowserOwner, page: BrowserWorkspacePageDto): void;
  tools?: BrowserToolsPort;
}) {
  const hosts = new Map<BrowserHostPort, Host>(), services = new Set<Service>();
  const tabsByOwner = new Map<TrustedBrowserOwner, { host: Host; tab: Tab }>();
  const browserTabs = new Map<string, Tab>();
  let stopping = false;
  const publish = (owner: TrustedBrowserOwner, page: BrowserOwnedPageDto) => {
    const entry = tabsByOwner.get(owner);
    if (!entry || stopping || entry.host.owner?.signal.aborted || entry.host.tabs.get(entry.tab.id) !== entry.tab
      || page.conversationId !== null || page.workspaceId !== entry.host.owner?.workspaceId) return;
    browserTabs.set(page.browserId, entry.tab);
    options.onChanged(entry.host.owner, { ...page, tabId: entry.tab.id });
  };
  let spare: Service | undefined = options.createService(publish); services.add(spare);
  const available = spare.isEnabled();
  async function closeTab(host: Host, tab: Tab): Promise<BrowserReply<null>> {
    tab.cancel.abort(); tab.service.revoke(tab.owner);
    const reply = await tab.service.dispose();
    if (!reply.ok) return fail("cleanup_failed");
    for (const [id, owner] of browserTabs) if (owner === tab) browserTabs.delete(id);
    tab.off(); services.delete(tab.service); tabsByOwner.delete(tab.owner); host.tabs.delete(tab.id);
    if (host.active === tab.id) host.active = host.tabs.keys().next().value ?? null;
    return { ok: true, value: null };
  }
  async function closeTabs(host: Host): Promise<BrowserReply<null>> {
    const replies = await Promise.all([...host.tabs.values()].map(tab => closeTab(host, tab)));
    return replies.every(reply => reply.ok) ? { ok: true, value: null } : fail("cleanup_failed");
  }
  async function resolve(event: BrowserInvokeEvent): Promise<BrowserReply<Host>> {
    const host = [...hosts.values()].find(value => value.host.webContents === event.sender);
    if (stopping || !host || host.host.isDestroyed() || host.host.webContents.isDestroyed()
      || event.senderFrame !== host.host.webContents.mainFrame || host.transition) return fail("owner_mismatch");
    let owner: TrustedBrowserOwner | null;
    try { owner = host.resolve(event); } catch { return fail("owner_mismatch"); }
    if (!owner || owner.signal.aborted || owner.host !== host.host || owner.topFrame !== event.senderFrame
      || owner.conversationId !== null || !owner.workspaceId) return fail("owner_mismatch");
    if (host.owner !== owner) {
      host.transition = true;
      try {
        const closed = await closeTabs(host); if (!closed.ok) return closed;
        if (stopping || owner.signal.aborted || host.resolve(event) !== owner) return fail("owner_mismatch");
        host.owner = owner;
      } finally { host.transition = false; }
    }
    return { ok: true, value: host };
  }
  function addTab(host: Host): BrowserReply<Tab> {
    if (!host.owner || host.owner.signal.aborted || stopping) return fail("owner_mismatch");
    if (host.tabs.size >= 8) return fail("tab_limit");
    const id = randomUUID(), cancel = new AbortController(), parent = host.owner;
    const onAbort = () => cancel.abort(); parent.signal.addEventListener("abort", onAbort, { once: true });
    const owner = Object.freeze({ ...parent, ownerSessionId: randomUUID(), signal: cancel.signal });
    const service = spare ?? options.createService(publish); spare = undefined; services.add(service);
    let off: () => void;
    try { off = service.registerHost(host.host, event => host.owner === parent && host.resolve(event) === parent && !cancel.signal.aborted ? owner : null); }
    catch { parent.signal.removeEventListener("abort", onAbort); void service.dispose(); return fail("owner_mismatch"); }
    const tab: Tab = { id, owner, cancel, service, off: () => { off(); parent.signal.removeEventListener("abort", onAbort); } };
    host.tabs.set(id, tab); host.active = id; tabsByOwner.set(owner, { host, tab });
    return { ok: true, value: tab };
  }
  function tabFor(host: Host, tabId: unknown): BrowserReply<Tab> {
    if (tabId !== undefined && typeof tabId !== "string") return fail("owner_mismatch");
    if (!host.tabs.size && tabId === undefined) return addTab(host);
    const tab = host.tabs.get(typeof tabId === "string" ? tabId : host.active ?? "");
    return tab ? { ok: true, value: tab } : fail("closed");
  }
  const workspacePage = (host: Host, tab: Tab, page: BrowserOwnedPageDto): BrowserReply<BrowserWorkspacePageDto> =>
    page.conversationId === null && page.workspaceId === host.owner?.workspaceId
      ? { ok: true, value: { ...page, tabId: tab.id } } : fail("owner_mismatch");
  async function state(host: Host, event: BrowserInvokeEvent): Promise<BrowserReply<BrowserWorkspaceStateDto>> {
    const tabs: BrowserWorkspaceStateDto["tabs"][number][] = [];
    for (const tab of host.tabs.values()) {
      const reply = await tab.service.dispatch(event, { kind: "get" });
      if (!reply.ok) return reply;
      let page: BrowserWorkspacePageDto | null = null;
      if (reply.value) { const result = workspacePage(host, tab, reply.value); if (!result.ok) return result; page = result.value; }
      tabs.push({ tabId: tab.id, page });
    }
    if (stopping || host.owner?.signal.aborted || host.resolve(event) !== host.owner) return fail("owner_mismatch");
    return { ok: true, value: { workspaceId: host.owner!.workspaceId!, activeTabId: host.active, tabs } };
  }
  async function dispatch(event: BrowserInvokeEvent, input: unknown): Promise<BrowserReply<BrowserWorkspacePageDto | null>> {
    const resolved = await resolve(event); if (!resolved.ok) return resolved;
    if (!input || typeof input !== "object" || Array.isArray(input)) return fail("permission_denied");
    const { tabId, ...command } = input as Record<string, unknown>;
    const result = tabFor(resolved.value, tabId); if (!result.ok) return result;
    const tab = result.value;
    if (typeof command.browserId === "string" && browserTabs.has(command.browserId) && browserTabs.get(command.browserId) !== tab) return fail("owner_mismatch");
    if (command.kind === "layout" && command.bounds !== null && resolved.value.active !== tab.id) return fail("owner_mismatch");
    const reply = await tab.service.dispatch(event, command);
    if (!reply.ok) return reply;
    if (reply.value === null) return { ok: true, value: null };
    return workspacePage(resolved.value, tab, reply.value);
  }
  /** Window-browser tools. The payload is parsed strictly; tab tools need a live ordinary-browsing tab of this window,
   * window-wide ones (downloads, settings) only need the window itself. */
  async function dispatchTool(event: BrowserInvokeEvent, command: Record<string, unknown>): Promise<BrowserToolReply<unknown>> {
    if (!options.tools) return toolFail("unsupported");
    if (Object.keys(command).some(key => key !== "kind" && key !== "tabId" && key !== "request")) return toolFail("permission_denied");
    const request = parseBrowserToolRequest(command.request);
    if (!request || (command.tabId !== undefined && typeof command.tabId !== "string")) return toolFail("permission_denied");
    const resolved = await resolve(event);
    if (!resolved.ok) return toolFail(resolved.code === "cancelled" || resolved.code === "closed" ? resolved.code : "owner_mismatch");
    const host = resolved.value, tools = options.tools;
    try {
      if (request.tool === "download" || request.tool === "settings") return { ok: true, value: await tools.global(host.host, request) };
      const found = tabFor(host, command.tabId);
      if (!found.ok) return toolFail(found.code === "closed" ? "closed" : "owner_mismatch");
      const tab = found.value;
      return await tab.service.useTab(event, target => tools.tab(target, request, tab.id));
    } catch { return toolFail("failed"); }
  }
  async function dispatchWorkspace(event: BrowserInvokeEvent, input: unknown): Promise<BrowserReply<BrowserWorkspaceStateDto | BrowserWorkspacePageDto | null> | BrowserToolReply<unknown>> {
    if (!input || typeof input !== "object" || Array.isArray(input)) return fail("permission_denied");
    const command = input as Record<string, unknown>;
    if (command.kind === "tool") return dispatchTool(event, command);
    if (!["tabs", "new-tab", "select-tab", "close-tab"].includes(String(command.kind))) return dispatch(event, input);
    if (Object.keys(command).some(key => key !== "kind" && key !== "tabId")) return fail("permission_denied");
    const resolved = await resolve(event); if (!resolved.ok) return resolved;
    const host = resolved.value;
    if (command.kind === "tabs") { if (!host.tabs.size) { const added = addTab(host); if (!added.ok) return added; } }
    else if (command.kind === "new-tab") {
      const added = addTab(host); if (!added.ok) return added;
      // Native guests are detached before the renderer gives the selected tab bounds.
      for (const tab of host.tabs.values()) if (tab !== added.value) {
        const page = await tab.service.dispatch(event, { kind: "get" });
        if (page.ok && page.value) await tab.service.dispatch(event, { kind: "layout", browserId: page.value.browserId, bounds: null });
      }
    } else {
      if (typeof command.tabId !== "string") return fail("owner_mismatch");
      const result = tabFor(host, command.tabId); if (!result.ok) return result;
      if (command.kind === "close-tab") { const closed = await closeTab(host, result.value); if (!closed.ok) return closed; }
      else {
        for (const tab of host.tabs.values()) if (tab.id !== command.tabId) {
          const page = await tab.service.dispatch(event, { kind: "get" });
          if (page.ok && page.value) await tab.service.dispatch(event, { kind: "layout", browserId: page.value.browserId, bounds: null });
        }
        host.active = command.tabId;
      }
    }
    return state(host, event);
  }
  async function dispatchPermission(event: BrowserInvokeEvent, input: unknown): Promise<BrowserReply<BrowserWorkspacePermissionDto>> {
    const resolved = await resolve(event); if (!resolved.ok) return resolved;
    const host = resolved.value;
    if (!input || typeof input !== "object" || Array.isArray(input)) return fail("permission_denied");
    const { tabId, workspaceId, ...command } = input as Record<string, unknown>;
    if ("conversationId" in command || (workspaceId !== undefined && workspaceId !== host.owner?.workspaceId)) return fail("owner_mismatch");
    if (Object.keys(command).some(key => key !== "kind" && key !== "scope")) return fail("permission_denied");
    if (command.kind === "revoke" && tabId === undefined) {
      const closed = await closeTabs(host); if (!closed.ok) return closed;
      return { ok: true, value: { conversationId: null, workspaceId: host.owner!.workspaceId!, status: "required", scope: { mode: "manual", hosts: [], resourceHosts: [], actions: ["navigate"] }, requestId: null } };
    }
    const result = tabFor(host, tabId); if (!result.ok) return result;
    const reply = await result.value.service.dispatchPermission(event, command);
    if (!reply.ok) return reply;
    if (reply.value.conversationId !== null || reply.value.workspaceId !== host.owner?.workspaceId) return fail("owner_mismatch");
    return { ok: true, value: { ...reply.value, tabId: result.value.id } };
  }
  function revoke(owner: TrustedBrowserOwner): void {
    for (const host of hosts.values()) if (host.owner === owner) for (const tab of host.tabs.values()) { tab.cancel.abort(); tab.service.revoke(tab.owner); }
  }
  const revokeAll = () => { stopping = true; for (const service of services) service.revokeAll(); };
  async function closeHost(host: BrowserHostPort): Promise<BrowserReply<null>> {
    const entry = hosts.get(host); if (!entry) return { ok: true, value: null };
    if (entry.owner) revoke(entry.owner); hosts.delete(host);
    return closeTabs(entry);
  }
  async function dispose(signal?: AbortSignal): Promise<BrowserReply<null>> {
    revokeAll(); const replies = await Promise.all([...services].map(service => service.dispose(signal)));
    for (const host of hosts.values()) for (const tab of host.tabs.values()) tab.off();
    hosts.clear(); tabsByOwner.clear(); browserTabs.clear();
    return replies.every(reply => reply.ok) ? { ok: true, value: null } : fail("cleanup_failed");
  }
  return Object.freeze({ dispatch, dispatchWorkspace, dispatchPermission, revoke, revokeAll, closeHost, dispose,
    registerHost(host: BrowserHostPort, resolveOwner: Host["resolve"]) {
      if (stopping || hosts.has(host) || host.isDestroyed()) throw Error("browser host unavailable");
      hosts.set(host, { host, resolve: resolveOwner, tabs: new Map(), active: null, transition: false });
      return () => { void closeHost(host); };
    },
    execute: async (_owner: TrustedBrowserOwner, _command: unknown): Promise<BrowserReply<BrowserOwnedPageDto | null>> => fail("permission_denied"),
    /** Tools are routed per tab by dispatchWorkspace; the workspace itself owns no single page. */
    useTab: async (): Promise<BrowserToolReply<never>> => toolFail("owner_mismatch"),
    executeAgent: async (): Promise<BrowserReply<never>> => fail("owner_mismatch"),
    isEnabled: () => !stopping && available,
    isRegisteredBrowser: (contents: object) => [...services].some(service => service.isRegisteredBrowser(contents)),
    credentialsFor: (contents: object, challenge: Parameters<Service["credentialsFor"]>[1]) => {
      for (const service of services) { const value = service.credentialsFor(contents, challenge); if (value) return value; }
      return null;
    },
    setTrustedOverlay(host: BrowserHostPort, visible: boolean) { for (const service of services) service.setTrustedOverlay(host, visible); },
  });
}
