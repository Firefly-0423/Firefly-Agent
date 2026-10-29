import { createBrowserAuthorizationDomainRegistry } from "../browser/browser-authorization-domain";
import { createBrowserService, type BrowserHostPort, type BrowserGuestPort, type TrustedBrowserOwner } from "../browser/browser-service";
import { registerBrowserServiceIpc, registerManualBrowserWorkspaceIpc, installBrowserServiceLifecycle } from "../browser/browser-service-ipc";
import { createManualBrowserWorkspace } from "../browser/manual-browser-workspace";
import { BROWSER_PUBLIC_SCOPE, MANUAL_BROWSER_WORKSPACE_IPC, type BrowserOwnedPageDto, type BrowserPermissionScope } from "../../shared/manual-browser";
import { createShutdownCoordinator } from "../application/shutdown";
import { createStartupReadiness } from "../application/readiness";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import type { WebContents } from "electron";
import { IPC } from "../../shared/ipc-channels";
import { registerExternalSkillsIpc } from "./external-ipc";
import { createExternalSkillService } from "./external-service";
import { isolatedStorageContext } from "./testing/external-fixtures";
import { EXTERNAL_LIMITS, EXTERNAL_SOURCES } from "./external-policy";
import { EXTERNAL_SKILL_REVIEWS } from "./external-reviews";
import { MARKET_REGISTRY_URLS, MARKET_ZIP_URL_PREFIXES } from "../plugin-host/plugin-marketplace";
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const run of cleanup.splice(0).reverse()) await run(); vi.restoreAllMocks(); });
const sourceRoot = path.resolve(import.meta.dirname, "../../..");
const hash = (file: string) => createHash("sha256").update(fs.readFileSync(path.join(sourceRoot, file), "utf8").replace(/\r\n/g, "\n")).digest("hex");
// Canonical LF hashes preserve the reviewed boundaries across CRLF checkouts.
// Keep untouched code boundaries frozen. The domain/IPC files now support a
// separately approved manual window lane; market_browser_* below assert their
// actual authorization, network, IPC and lifecycle invariants instead of bytes.
const unchangedBoundaries = {
  // Reviewed plugin lifecycle update: host-owned provenance and install/activation
  // outcomes only. Exact catalog and repository rename prefixes are independently asserted below.
  // Reviewed marketplace move: the catalog and Release prefix now point only at Firefly-0423/firefly-plugins; size, timeout,
  // redirect, SHA-256 and disabled-install rules are unchanged.
  "src/main/plugin-host/plugin-marketplace.ts": "6f7600e703094d009a13c042dc4c97f9b6be235bbaf2bbee163a7672ad803c8c",
  "src/main/browser/browser-request-policy.ts": "9ce32fdba4722e49b7c96d27ad7a2058fae3d62a4186d44aac98e49d7e62bdf1",
  // Reviewed window-browser tools change: browser-startup-config only forwards the optional acceptDownload callback, and
  // electron-browser-guest only attaches the per-page tools object. No navigation, network or sandbox setting changed here;
  // downloads stay refused unless Main's service sees a current ordinary-browsing page (see docs/browser-tools.md).
  "src/main/browser/browser-startup-config.ts": "08b61ff4e0f654f1bb236bcf19d6f09d3ddcc8d9b2c21d6052fdb55e800f2701",
  // Also reviewed: renderer-crash cancellation and safe native failure/redirect forwarding; native preferences, routing,
  // certificate denial and fixed isolated-world scripts retain their boundaries.
  // See docs/browser-reference-audit-2026-10-15.md (boundary preimage review).
  "src/main/browser/electron-browser-guest.ts": "a71fade70a93bb0c1ab40e7cbee856c2b423e87092bbaf4f3174a3d896de8d21",
  "src/main/permission/permission-policy.ts": "f686d292755780fca07366b96fe432b69e5bff7d8602006e0172a436108b5f40",
  // Reimplemented from observable behavior with identical allow/ask/deny decisions; verified by the policyFor decision-table
  // test (permission-policy.matrix.test.ts) and the approval contract tests (permission.contract.test.ts, permission.test.ts).
  // The only difference is stricter: an unrecognised session level now denies instead of yielding no decision.
  "src/main/permission/permission.ts": "5984d04a0a6c0682d1112364198d178b1eec446de08620660b098d729d212d89",
  "src/main/permission/bootstrap.ts": "e2c6f41a87e947a0838f16fd920f5c31c7a35549ea4e60627f4257059a6aec71",
} as const;
it.each(Object.entries(unchangedBoundaries))("no_execution_or_permission_expansion: %s exactly matches approved boundary preimage", (file, expected) => { expect(hash(file)).toBe(expected); });
it("no_execution_or_permission_expansion native executable marketplace uses exactly the approved catalog and repository rename release prefixes, and fixed source data does not broaden it", () => {
  expect(MARKET_REGISTRY_URLS).toEqual(["https://raw.githubusercontent.com/Firefly-0423/firefly-plugins/main/registry.json"]);
  expect(MARKET_ZIP_URL_PREFIXES).toEqual(["https://github.com/Firefly-0423/firefly-plugins/releases/download/"]);
  // Reviewed source change (2026-10-29, docs/superpowers/specs/2026-10-29-firefly-skills-market-source.md): Firefly's own
  // Skill repository joins as a Claude-catalog source under the Firefly-native policy. Its Firefly metadata (modes,
  // effectKind, tools) is visibility and labelling only; every install still needs an exact per-commit static review and
  // grants no tool permission. Third-party sources keep the instruction-only policy unchanged.
  expect(EXTERNAL_SOURCES).toEqual({
    firefly: { repository: "Firefly-0423/firefly-skills", owner: "Firefly-0423", repo: "firefly-skills", catalogPath: ".claude-plugin/marketplace.json", catalogFormat: "claude-catalog", reviewPolicy: "firefly-native-v1" },
    openai: { repository: "openai/plugins", owner: "openai", repo: "plugins", catalogPath: ".agents/plugins/marketplace.json", catalogFormat: "openai", reviewPolicy: "firefly-instruction-only-v1" },
    anthropic: { repository: "anthropics/skills", owner: "anthropics", repo: "skills", catalogPath: ".claude-plugin/marketplace.json", catalogFormat: "claude-catalog", reviewPolicy: "firefly-instruction-only-v1" },
  });
  expect(Object.isFrozen(EXTERNAL_SOURCES)).toBe(true); expect(Object.values(EXTERNAL_SOURCES).every(Object.isFrozen)).toBe(true);
});
it("no_execution_or_permission_expansion fixed budgets and production reviews cannot grant script or native package execution", () => {
  expect(EXTERNAL_LIMITS).toEqual({ catalogBytes: 1048576, treeBytes: 8388608, files: 200, fileBytes: 1048576, totalBytes: 10485760, requestMs: 15000, prepareMs: 120000, jsonDepth: 32, candidates: 2000, treeEntries: 50000, concurrency: 4, transactions: 1, approvalMs: 600000 });
  expect(EXTERNAL_SKILL_REVIEWS.every(review => review.compatibility === "instruction-only")).toBe(true);
  expect(EXTERNAL_SKILL_REVIEWS.some(review => review.sourceId === "openai")).toBe(false);
});
it("no_execution_or_permission_expansion external production modules have no executable installer, shell, connector or permission mutation dependency", () => {
  for (const name of ["external-service", "external-fetch", "external-sources", "external-review", "external-install", "external-state", "external-scan", "external-ipc"]) {
    const text = fs.readFileSync(path.join(sourceRoot, "src/main/skills", name + ".ts"), "utf8");
    const imports = [...text.matchAll(/(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\()(["'])(.*?)\1/g)].map(match => match[2]);
    expect(imports.filter(target => /(?:child_process|plugins\/(?:manager|installer)|mcp-manager|channels\/|connector|permission|browser\/)/.test(target)), name).toEqual([]);
    expect(text, name).not.toMatch(/\b(?:eval|Function)\s*\(/);
  }
});
function contents(id = 1) { return Object.assign(new EventEmitter(), { id, mainFrame: { processId: 10 + id, routingId: 20 + id, detached: false }, isDestroyed: () => false }); }
function boundary() {
  const f = isolatedStorageContext(); const sentinel = path.join(f.productionSentinelRoot, "keep.txt"); fs.writeFileSync(sentinel, "keep");
  const transport = vi.fn(async () => { throw Error("UNEXPECTED_TRANSPORT"); }), rescan = vi.fn();
  const service = createExternalSkillService({ storage: f.storage, host: { runId: randomUUID(), isPrimaryProcess: () => true }, fetch: transport, now: Date.now, randomToken: () => "a".repeat(64), reviews: [], rescan });
  const host = contents(), handlers = new Map<string, (...args: any[]) => any>();
  const binding = registerExternalSkillsIpc({ ipc: { handle: (channel, handler) => handlers.set(channel, handler) }, getHostWebContents: () => host as unknown as WebContents, service });
  cleanup.push(() => { f.dispose(); fs.rmSync(f.productionSentinelRoot, { recursive: true, force: true }); }, () => binding.dispose());
  return { ...f, transport, rescan, host, handlers, invoke: (channel: string, payload: unknown, event: any = { sender: host, senderFrame: host.mainFrame }) => handlers.get(channel)!(event, payload),
    unchanged: () => { expect(transport).not.toHaveBeenCalled(); expect(rescan).not.toHaveBeenCalled(); expect(fs.readdirSync(f.root)).toEqual([]); expect(fs.readdirSync(f.productionSentinelRoot)).toEqual(["keep.txt"]); expect(fs.readFileSync(sentinel, "utf8")).toBe("keep"); } };
}
const requests = [[IPC.EXTERNAL_SKILLS_LIST, { sourceId: "anthropic" }], [IPC.EXTERNAL_SKILLS_DETAIL, { sourceId: "anthropic", id: "external-anthropic-test" }], [IPC.EXTERNAL_SKILLS_PREPARE, { sourceId: "anthropic", id: "external-anthropic-test" }], [IPC.EXTERNAL_SKILLS_COMMIT, { token: "a".repeat(64) }], [IPC.EXTERNAL_SKILLS_CANCEL, {}]] as const;
it.each(["url", "path", "hash", "target", "owner", "review", "files", "isPrimaryProcess"])("trusted_boundary extra Renderer %s is rejected before transport/filesystem on every channel", async extra => {
  const f = boundary();
  for (const [channel, payload] of requests) expect(await f.invoke(channel, { ...payload, [extra]: "untrusted" })).toMatchObject({ ok: false, code: "FORBIDDEN" }); f.unchanged();
});
it.each(["wrong-window", "subframe", "detached", "missing", "old-document"])("trusted_boundary %s has no service or storage authority on every channel", async kind => {
  const f = boundary(); let event: any = { sender: f.host, senderFrame: f.host.mainFrame };
  if (kind === "wrong-window") event.sender = contents(9);
  if (kind === "subframe") event.senderFrame = { processId: 11, routingId: 22, detached: false };
  if (kind === "detached") f.host.mainFrame.detached = true;
  if (kind === "missing") event = {};
  if (kind === "old-document") { f.host.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false }); f.host.mainFrame = { processId: 12, routingId: 24, detached: false }; }
  for (const [channel, payload] of requests) expect(await f.invoke(channel, payload, event)).toMatchObject({ ok: false, code: "FORBIDDEN" }); f.unchanged();
});
it.each(["https://example.invalid/source", "../openai", "openai/plugins", "__proto__"])("trusted_boundary unsupported source %s cannot reach transport", async sourceId => {
  const f = boundary(); expect(await f.invoke(IPC.EXTERNAL_SKILLS_LIST, { sourceId })).toMatchObject({ code: "FORBIDDEN" }); f.unchanged();
});

function browserDomain(workspace = false) {
  const owner = {}, profile = {}, session = {}, abort = new AbortController();
  const context = { owner, profile, conversationId: workspace ? null : "chat",
    ...(workspace ? { workspaceId: "native-window" } : {}), browserId: "native-browser", generation: 0, signal: abort.signal };
  let live = true, authorized = false;
  const registry = createBrowserAuthorizationDomainRegistry<object>({
    isContextAuthorized: input => authorized && input.owner === owner,
    isOwnerCurrent: input => live && input.owner === owner && input.profile === profile
      && input.browserId === context.browserId && input.generation === context.generation
      && input.conversationId === context.conversationId && input.workspaceId === context.workspaceId,
  });
  const contents = { id: 51, session, isDestroyed: () => false };
  return { context, registry, session, contents, abort, authorize: () => { authorized = true; }, stale: () => { live = false; } };
}
it.each([false, true])("market_browser_domain Main-only authority and native contents stay required (workspace=%s)", workspace => {
  const f = browserDomain(workspace), policy = { hosts: ["public.example"], resourceHosts: ["cdn.example"] };
  const config = { gateOpen: false, isOwnerCurrent: () => true }, closed = createBrowserAuthorizationDomainRegistry(config);
  config.gateOpen = true; expect(closed.create(f.context, {})).toBeNull();
  expect(f.registry.create(f.context, f.session, policy)).toBeNull();
  f.authorize();
  for (const forged of [{ owner: {} }, { profile: {} }, { generation: 1 }, { browserId: "foreign" },
    workspace ? { conversationId: "forged-chat" } : { workspaceId: "forged-workspace" }]) {
    expect(f.registry.create({ ...f.context, ...forged }, {}, policy)).toBeNull();
  }
  const domain = f.registry.create(f.context, f.session, policy)!; expect(domain).not.toBeNull();
  const get = { url: "https://public.example/page", method: "GET", resourceType: "mainFrame" };
  expect(domain.allows(get)).toBe(false); expect(domain.activate()).toBe(false);
  expect(domain.registerContents({ ...f.contents, session: {} })).toBe(false);
  expect(domain.registerContents(f.contents)).toBe(true); expect(domain.allows(get)).toBe(false);
  expect(domain.activate()).toBe(true); expect(domain.allows(get)).toBe(true);
  expect(domain.registerContents({ ...f.contents })).toBe(false);
  expect(domain.ownsContents({ ...f.contents })).toBe(false);
  expect(domain.allows({ ...get, webContentsId: f.contents.id + 1 })).toBe(false);
  domain.revoke(); expect(f.registry.create(f.context, f.session, policy)).toBeNull();
  expect(domain.allows(get)).toBe(false); expect(domain.activate()).toBe(false);
});
it.each([false, true])("market_browser_domain resource consent cannot widen navigation, methods, protocols or immutable epoch (workspace=%s)", workspace => {
  const f = browserDomain(workspace); f.authorize();
  const hosts = ["public.example"], resourceHosts = ["cdn.example"];
  const domain = f.registry.create(f.context, f.session, { hosts, resourceHosts })!;
  domain.registerContents(f.contents); domain.activate();
  hosts.push("injected.example"); resourceHosts.push("injected.example");
  expect(Object.isFrozen(domain.epoch.context)).toBe(true);
  expect(Object.isFrozen(domain.epoch.policy.hosts)).toBe(true); expect(Object.isFrozen(domain.epoch.policy.resourceHosts)).toBe(true);
  const request = { url: "https://public.example/article", method: "GET", resourceType: "mainFrame" };
  expect(domain.allows(request)).toBe(true);
  for (const resourceType of ["script", "stylesheet", "image", "font", "media", "xhr"]) {
    for (const method of ["GET", "HEAD"]) expect(domain.allows({ url: "https://cdn.example/file", resourceType, method })).toBe(true);
  }
  for (const resourceType of ["mainFrame", "subFrame"]) {
    expect(domain.allows({ ...request, url: "https://cdn.example/page", resourceType })).toBe(false);
  }
  for (const url of ["https://sub.public.example/", "https://injected.example/", "https://unlisted.example/",
    "http://public.example/", "file:///private", "data:text/plain,x", "https://user:secret@public.example/",
    "https://public.example:8443/", "https://127.0.0.1/", "https://[::1]/"]) expect(domain.allows({ ...request, url })).toBe(false);
  for (const method of ["POST", "PUT", "DELETE", "OPTIONS", "CONNECT"]) expect(domain.allows({ ...request, method })).toBe(false);
  for (const resourceType of ["webSocket", "ping", "cspReport", "other"]) expect(domain.allows({ ...request, resourceType })).toBe(false);
  expect(f.registry.canPrepare(f.context, { resourceHosts: ["cdn.example"] })).toBe(false);
  for (const host of ["127.0.0.1", "private.example:8443", "user@public.example", "*"]) {
    expect(f.registry.canPrepare(f.context, { hosts: [host] })).toBe(false);
    expect(f.registry.canPrepare(f.context, { hosts: ["public.example"], resourceHosts: [host] })).toBe(false);
  }
  domain.revoke();
});
it.each(["owner", "abort", "native-destroyed"] as const)("market_browser_domain %s loss permanently revokes the epoch", reason => {
  const f = browserDomain(); f.authorize(); let destroyed = false;
  const native = { ...f.contents, isDestroyed: () => destroyed };
  const domain = f.registry.create(f.context, f.session, { hosts: ["public.example"] })!;
  domain.registerContents(native); domain.activate();
  if (reason === "owner") f.stale(); else if (reason === "abort") f.abort.abort(); else destroyed = true;
  expect(domain.allows({ url: "https://public.example/", method: "GET", resourceType: "mainFrame" })).toBe(false);
  expect(domain.signal.aborted).toBe(true); expect(domain.activate()).toBe(false);
});
function browserLanes() {
  const frame = {}, profile = {}, events = new EventEmitter();
  const native = Object.assign(events, { id: 71, mainFrame: frame, isDestroyed: () => false });
  const host: BrowserHostPort = Object.assign(new EventEmitter(), { webContents: native, isDestroyed: () => false,
    isVisible: () => true, isFocused: () => true, getContentSize: () => [800, 600],
    contentView: { addChildView: () => {}, removeChildView: () => {} } });
  const manualAbort = new AbortController(), agentAbort = new AbortController();
  const manualOwner: TrustedBrowserOwner = Object.freeze({ host, topFrame: frame, profile, conversationId: null,
    workspaceId: "manual-window", ownerSessionId: "manual", generation: 0, signal: manualAbort.signal });
  const agentOwner: TrustedBrowserOwner = Object.freeze({ host, topFrame: frame, profile, conversationId: "agent-chat",
    ownerSessionId: "agent", generation: 0, signal: agentAbort.signal });
  const effects: string[] = [], guests: BrowserGuestPort<object>[] = [], confirmations: BrowserPermissionScope[] = [];
  let decide: (scope: BrowserPermissionScope) => Promise<boolean> = async () => true;
  const make = (manualBrowsing: boolean, owner?: TrustedBrowserOwner, onChanged?: (owner: TrustedBrowserOwner, page: BrowserOwnedPageDto) => void) => {
    const service = createBrowserService<object>({ profile, manualBrowsing, onChanged, permissionPolicy: BROWSER_PUBLIC_SCOPE,
      confirmPermission: async (_owner, scope) => { confirmations.push(scope); return decide(scope); },
      createSession: () => {
        effects.push("allocate"); const session = {};
        return { session, persistent: false, installRequestHandler: () => {}, denyPermissions: () => {},
          setProxy: async () => {}, closeAllConnections: async () => {}, clearStorageData: async () => { effects.push("clear"); },
          clearCache: async () => {}, clearAuthCache: async () => {}, clearHostResolverCache: async () => {}, runningWorkerCount: () => 0 };
      },
      createView: session => {
        let destroyed = false, url = "";
        const guest: BrowserGuestPort<object> = { contents: { id: 81 + guests.length, session, isDestroyed: () => destroyed },
          loadURL: async next => { url = next; effects.push("load:" + next); }, history: async () => {},
          snapshot: () => ({ url, canGoBack: false, canGoForward: false }), stop: () => {}, attach: () => {}, detach: () => {},
          setBounds: () => {}, installCallbacks: () => {}, destroy: () => { destroyed = true; effects.push("destroy"); } };
        guests.push(guest); return guest;
      },
      proxyFactory: async () => ({ endpoint: { host: "127.0.0.1", port: 1234, realm: "offline-fixture" },
        credentialsFor: () => null, revoke: async () => {} }),
    });
    if (owner) service.registerHost(host, () => owner); cleanup.push(() => service.dispose()); return service;
  };
  const manual = createManualBrowserWorkspace({ createService: onChanged => make(true, undefined, onChanged), onChanged: () => {} });
  manual.registerHost(host, () => manualOwner); cleanup.push(() => manual.dispose());
  const agent = make(false, agentOwner), handlers = new Map<string, (...args: any[]) => any>();
  const scope = { handle: (channel: string, handler: (...args: any[]) => any) => handlers.set(channel, handler) };
  registerBrowserServiceIpc(scope, agent); registerManualBrowserWorkspaceIpc(scope, manual);
  const event = { sender: native, senderFrame: frame };
  return { manual, agent, manualOwner, agentOwner, manualAbort, agentAbort, native, host, event, effects, guests, confirmations,
    decide: (next: typeof decide) => { decide = next; }, invoke: (channel: string, input: unknown, sender = event) => handlers.get(channel)!(sender, input) };
}
const manualSite = { mode: "manual", hosts: ["public.example"], resourceHosts: [], actions: ["navigate"] } as const;
it("market_browser_ipc renderer gate, owner or target fields cannot open an ungranted browser", async () => {
  const f = browserLanes();
  expect(await f.invoke(MANUAL_BROWSER_WORKSPACE_IPC.command, { kind: "open", url: "https://public.example/", gateOpen: true,
    owner: f.manualOwner, target: "agent", scope: manualSite })).toEqual({ ok: false, code: "permission_denied" });
  expect(await f.invoke(IPC.BROWSER_COMMAND, { kind: "open", url: "https://github.com/", gateOpen: true,
    owner: f.manualOwner, target: "manual" })).toEqual({ ok: false, code: "permission_denied" });
  expect(await f.agent.executeAgent(f.agentOwner, { operation: "open", url: "https://github.com/" },
    { conversationId: "agent-chat", runId: "run", signal: new AbortController().signal, isCurrent: () => true })).toEqual({ ok: false, code: "permission_denied" });
  expect(f.effects).toEqual([]); expect(f.confirmations).toEqual([]);
});
it.each(["foreign-window", "subframe"] as const)("market_browser_ipc %s cannot use either permission lane or allocate native state", async kind => {
  const f = browserLanes(), event = kind === "foreign-window" ? { ...f.event, sender: { ...f.native } } : { ...f.event, senderFrame: {} };
  for (const target of [undefined, "agent"]) {
    expect(await f.invoke(target === "agent" ? IPC.BROWSER_PERMISSION : MANUAL_BROWSER_WORKSPACE_IPC.permission, { kind: "request", target,
      scope: target === "agent" ? { mode: "agent", ...BROWSER_PUBLIC_SCOPE } : manualSite }, event)).toEqual({ ok: false, code: "owner_mismatch" });
  }
  for (const channel of [MANUAL_BROWSER_WORKSPACE_IPC.command, IPC.BROWSER_COMMAND]) {
    expect(await f.invoke(channel, { kind: "open", url: "https://public.example/" }, event)).toEqual({ ok: false, code: "owner_mismatch" });
  }
  expect(f.effects).toEqual([]); expect(f.confirmations).toEqual([]);
});
it("market_browser_ipc requires native consent and never turns a manual grant into Agent authority", async () => {
  const f = browserLanes(); let confirm!: (approved: boolean) => void;
  f.decide(async () => new Promise<boolean>(resolve => { confirm = resolve; }));
  const pending = f.invoke(MANUAL_BROWSER_WORKSPACE_IPC.permission, { kind: "request", scope: manualSite });
  for (let i = 0; i < 10 && !confirm; i++) await new Promise<void>(resolve => setImmediate(resolve));
  expect(confirm).toBeTypeOf("function");
  expect(await f.invoke(MANUAL_BROWSER_WORKSPACE_IPC.permission, { kind: "get" })).toMatchObject({ ok: true, value: { workspaceId: "manual-window", conversationId: null, status: "pending" } });
  expect(await f.invoke(MANUAL_BROWSER_WORKSPACE_IPC.command, { kind: "open", url: "https://public.example/" })).toEqual({ ok: false, code: "permission_denied" });
  expect(f.effects).toEqual([]); confirm(false); expect(await pending).toMatchObject({ ok: true, value: { status: "denied" } });
  f.decide(async () => true);
  expect(await f.invoke(MANUAL_BROWSER_WORKSPACE_IPC.permission, { kind: "request", scope: manualSite })).toMatchObject({ ok: true, value: { scope: manualSite, status: "granted" } });
  expect(await f.invoke(MANUAL_BROWSER_WORKSPACE_IPC.command, { kind: "open", url: "https://public.example/" })).toMatchObject({ ok: true });
  expect(await f.invoke(IPC.BROWSER_PERMISSION, { kind: "get" })).toMatchObject({ ok: true, value: { conversationId: "agent-chat", status: "required" } });
  const before = [...f.effects], run = { conversationId: "agent-chat", runId: "run", signal: new AbortController().signal, isCurrent: () => true };
  expect(await f.agent.executeAgent(f.agentOwner, { operation: "open", url: "https://public.example/" }, run)).toEqual({ ok: false, code: "permission_denied" });
  expect(await f.manual.executeAgent()).toEqual({ ok: false, code: "owner_mismatch" });
  expect(f.effects).toEqual(before);
  expect(await f.invoke(MANUAL_BROWSER_WORKSPACE_IPC.command, { kind: "open", url: "https://github.com/", target: "agent" })).toEqual({ ok: false, code: "blocked_url" });
});
it("market_browser_ipc Agent consent retains exactly four fixed hosts and four actions; resource proposals cannot widen it", async () => {
  const f = browserLanes();
  expect(BROWSER_PUBLIC_SCOPE).toEqual({ hosts: ["example.com", "github.com", "github.githubassets.com", "avatars.githubusercontent.com"],
    actions: ["navigate", "observe", "click", "type"] });
  for (const scope of [
    { mode: "agent", hosts: ["public.example"], actions: ["navigate"] },
    { mode: "agent", hosts: ["github.com"], actions: ["download"] },
    { mode: "agent", hosts: ["github.com"], resourceHosts: ["cdn.example"], actions: ["navigate"] },
    { ...manualSite, resourceHosts: ["cdn.example"], sourceBrowserId: "forged", sourceRequestId: 1 },
  ]) expect(await f.invoke(IPC.BROWSER_PERMISSION, { kind: "request", target: "agent", scope })).toEqual({ ok: false, code: "permission_denied" });
  expect(f.confirmations).toEqual([]); expect(f.effects).toEqual([]);
  expect(await f.invoke(IPC.BROWSER_PERMISSION, { kind: "request", scope: { mode: "agent", ...BROWSER_PUBLIC_SCOPE } })).toMatchObject({ ok: true,
    value: { conversationId: "agent-chat", status: "granted", scope: { mode: "agent", ...BROWSER_PUBLIC_SCOPE } } });
  const run = { conversationId: "agent-chat", runId: "run", signal: new AbortController().signal, isCurrent: () => true };
  expect(await f.agent.executeAgent(f.agentOwner, { operation: "open", url: "https://public.example/" }, run)).toEqual({ ok: false, code: "blocked_url" });
  expect(await f.agent.executeAgent(f.agentOwner, { operation: "download" }, run)).toEqual({ ok: false, code: "permission_denied" });
  expect(await f.invoke(IPC.BROWSER_COMMAND, { kind: "open", url: "https://public.example/",
    gateOpen: true, owner: f.manualOwner })).toEqual({ ok: false, code: "blocked_url" });
  expect(f.effects).toEqual([]);
  expect(await f.invoke(IPC.BROWSER_COMMAND, { kind: "open", url: "https://github.com/" })).toMatchObject({ ok: true,
    value: { conversationId: "agent-chat", url: "https://github.com/" } });
  expect(f.effects.filter(effect => effect.startsWith("load:"))).toEqual(["load:https://github.com/"]);
});
it("market_browser_ipc lifecycle rejects guest authentication and certificates while preserving unrelated consumers", async () => {
  const f = browserLanes(); await f.invoke(MANUAL_BROWSER_WORKSPACE_IPC.permission, { kind: "request", scope: manualSite });
  expect(await f.invoke(MANUAL_BROWSER_WORKSPACE_IPC.command, { kind: "open", url: "https://public.example/" })).toMatchObject({ ok: true });
  const app = new EventEmitter(), readiness = createStartupReadiness(); readiness.transition("shell-ready");
  const shutdown = createShutdownCoordinator({ readiness });
  const stop = installBrowserServiceLifecycle(app as any, f.manual, shutdown, "manual-browser-service"); cleanup.push(stop);
  const native = f.guests[0].contents, preventDefault = vi.fn(), callback = vi.fn();
  app.emit("login", { preventDefault }, native, {}, { isProxy: false, host: "public.example", port: 443 }, callback);
  expect(preventDefault).toHaveBeenCalledOnce(); expect(callback).toHaveBeenLastCalledWith();
  app.emit("certificate-error", { preventDefault }, native, "https://public.example/", "bad-cert", {}, callback);
  expect(callback).toHaveBeenLastCalledWith(false);
  app.emit("select-client-certificate", { preventDefault }, native, "https://public.example/", [], callback);
  expect(callback).toHaveBeenLastCalledWith(); const calls = callback.mock.calls.length, prevents = preventDefault.mock.calls.length;
  for (const name of ["login", "certificate-error", "select-client-certificate"]) app.emit(name, { preventDefault }, { ...native }, "unrelated", {}, {}, callback);
  expect(callback).toHaveBeenCalledTimes(calls); expect(preventDefault).toHaveBeenCalledTimes(prevents);
  stop(); expect(app.listenerCount("login")).toBe(0); expect(app.listenerCount("certificate-error")).toBe(0); expect(app.listenerCount("select-client-certificate")).toBe(0);
});
it("market_browser_ipc both native lanes quiesce and dispose through real shutdown without ID collision", async () => {
  const f = browserLanes(), app = new EventEmitter(), readiness = createStartupReadiness(); readiness.transition("shell-ready");
  await f.invoke(MANUAL_BROWSER_WORKSPACE_IPC.permission, { kind: "request", scope: manualSite });
  expect(await f.invoke(MANUAL_BROWSER_WORKSPACE_IPC.command, { kind: "open", url: "https://public.example/" })).toMatchObject({ ok: true });
  await f.invoke(IPC.BROWSER_PERMISSION, { kind: "request", scope: { mode: "agent", ...BROWSER_PUBLIC_SCOPE } });
  expect(await f.agent.executeAgent(f.agentOwner, { operation: "open", url: "https://github.com/" },
    { conversationId: "agent-chat", runId: "run", signal: new AbortController().signal, isCurrent: () => true })).toMatchObject({ ok: true });
  const shutdown = createShutdownCoordinator({ readiness }), order: string[] = [];
  const observe = (name: string, service: typeof f.manual | typeof f.agent) => ({ ...service,
    revokeAll: () => { order.push(name + ":revoke"); service.revokeAll(); },
    dispose: async (signal?: AbortSignal) => { order.push(name + ":dispose"); return service.dispose(signal); } });
  cleanup.push(installBrowserServiceLifecycle(app as any, observe("agent", f.agent), shutdown),
    installBrowserServiceLifecycle(app as any, observe("manual", f.manual), shutdown, "manual-browser-service"));
  expect(f.guests).toHaveLength(2);
  expect(await shutdown.requestControlledShutdown({ reason: "market-boundary-test", finalAction: () => {
    expect(f.guests.every(guest => guest.contents.isDestroyed())).toBe(true);
    expect(f.effects.filter(effect => effect === "clear")).toHaveLength(2);
    expect(f.manual.isEnabled()).toBe(false); expect(f.agent.isEnabled()).toBe(false);
    expect(order.slice(0, 2).sort()).toEqual(["agent:revoke", "manual:revoke"]);
    expect(order.slice(2).sort()).toEqual(["agent:dispose", "manual:dispose"]);
  } })).toBe(true);
});
