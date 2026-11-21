import type { ActiveChatTargetRegistry } from "../interaction/active-chat-target";
import type { ConversationMode } from "../../../shared/chat-types";
import type { BrowserHostPort, BrowserInvokeEvent, BrowserRunLease, TrustedBrowserOwner, createBrowserService } from "./browser-service";
import { randomUUID } from "node:crypto";
/** Consumes the existing Main target registry; browser commands contain no session authority.
 * Caller refreshes after CHATS_SET_ACTIVE_SESSION set/clear, because that registry
 * deliberately does not invalidate voice leases on an ordinary session switch.
 */
export function registerBrowserHostOwner<S extends object>(options: {
  host: BrowserHostPort;
  profile: object;
  targets: ActiveChatTargetRegistry;
  service: ReturnType<typeof createBrowserService<S>>;
  readSession(id: string): { id: string; mode?: ConversationMode } | null;
  validateSession?(id: string): boolean;
  isRunActive?(conversationId: string, runId: string): boolean;
}) {
  // Native host properties may throw in the destroyed notification. Keep the
  // registered identity so that notification still revokes the owner signal.
  const hostWebContentsId = options.host.webContents.id;
  let owner: TrustedBrowserOwner | null = null, abort: AbortController | undefined, generation = 0, targetKey = "", disposed = false;
  const deleted = new Set<string>();
  const leases = new Map<string, { lease: BrowserRunLease; abort: AbortController; conversationId: string; runId: string; mode: ConversationMode }>();
  const retiredRuns = new Set<string>();
  const runKey = (conversationId: string, runId: string) => `${conversationId}\0${runId}`;

  function sessionValid(id: string, expectedMode?: ConversationMode): boolean {
    if (disposed || deleted.has(id)) return false;
    try {
      const session = options.readSession(id);
      if (!session || session.id !== id) return false;
      if (expectedMode !== undefined && (session.mode ?? "chat") !== expectedMode) return false;
      if (options.validateSession && options.validateSession(id) !== true) return false;
      return true;
    } catch { return false; }
  }

  function releaseRunLease(conversationId: string, runId: string): void {
    const key = runKey(conversationId, runId);
    retiredRuns.add(key);
    const entry = leases.get(key);
    if (!entry) return;
    leases.delete(key);
    entry.abort.abort();
    options.service.releaseRunLease(entry.lease);
  }

  function retainRunLease(pageOwner: TrustedBrowserOwner, input: { conversationId: string; runId: string }): BrowserRunLease | null {
    if (disposed || !input.conversationId || !input.runId) return null;
    refresh();
    if (!owner || pageOwner !== owner || pageOwner.signal.aborted || pageOwner.conversationId !== input.conversationId) return null;
    const key = runKey(input.conversationId, input.runId);
    if (retiredRuns.has(key) || leases.has(key)) return null;
    const target = options.targets.getActive();
    if (!target || target.webContentsId !== hostWebContentsId || target.sessionId !== input.conversationId) return null;
    if (!sessionValid(input.conversationId, target.mode)) return null;
    if (options.isRunActive && options.isRunActive(input.conversationId, input.runId) !== true) return null;
    const leaseAbort = new AbortController();
    const mode = target.mode;
    const revokeThisLease = () => releaseRunLease(input.conversationId, input.runId);
    const lease: BrowserRunLease = Object.freeze({
      kind: "run",
      leaseId: randomUUID(),
      conversationId: input.conversationId,
      runId: input.runId,
      profile: options.profile,
      host: options.host,
      signal: leaseAbort.signal,
      isCurrent: () => {
        if (disposed || leaseAbort.signal.aborted || !leases.has(key)) return false;
        if (!sessionValid(input.conversationId, mode)) { revokeThisLease(); return false; }
        if (options.isRunActive && options.isRunActive(input.conversationId, input.runId) !== true) { revokeThisLease(); return false; }
        return true;
      },
      revoke: revokeThisLease,
    });
    leases.set(key, { lease, abort: leaseAbort, conversationId: input.conversationId, runId: input.runId, mode });
    if (!options.service.attachRunLease(pageOwner, lease)) {
      leases.delete(key);
      leaseAbort.abort();
      return null;
    }
    return lease;
  }

  function getRunLease(conversationId: string, runId: string): BrowserRunLease | null {
    const entry = leases.get(runKey(conversationId, runId));
    if (!entry) return null;
    return entry.lease.isCurrent() ? entry.lease : null;
  }

  function invalidate(): void {
    const previous = owner; owner = null; targetKey = "";
    abort?.abort(); if (previous) options.service.detachPageOwner(previous);
  }
  function refresh(): void {
    if (disposed) return;
    for (const entry of [...leases.values()]) {
      if (!entry.lease.isCurrent()) releaseRunLease(entry.conversationId, entry.runId);
    }
    try {
      const target = options.targets.getActive();
      const session = target ? options.readSession(target.sessionId) : null;
      if (!target || target.webContentsId !== options.host.webContents.id || !session || session.id !== target.sessionId
        || (session.mode ?? "chat") !== target.mode || deleted.has(target.sessionId)
        || (options.validateSession && options.validateSession(target.sessionId) !== true)
        || options.host.isDestroyed() || options.host.webContents.isDestroyed()) { invalidate(); return; }
      const key = JSON.stringify([target.sessionId, target.mode, target.rendererTargetId]);
      if (owner && key === targetKey && owner.topFrame === options.host.webContents.mainFrame && !owner.signal.aborted) return;
      invalidate(); abort = new AbortController(); targetKey = key;
      owner = Object.freeze({ host: options.host, topFrame: options.host.webContents.mainFrame, profile: options.profile,
        conversationId: target.sessionId, ownerSessionId: randomUUID(), generation: generation++, signal: abort.signal });
    } catch { invalidate(); }
  }
  function resolveOwner(event: BrowserInvokeEvent): TrustedBrowserOwner | null {
    if (disposed || event.sender !== options.host.webContents || event.senderFrame !== options.host.webContents.mainFrame) return null;
    refresh(); return owner;
  }
  const offHost = options.service.registerHost(options.host, resolveOwner);
  const offInvalidation = options.targets.onInvalidated((_reason, affected) => { if (!affected || affected.webContentsId === hostWebContentsId) invalidate(); });
  const offDeleted = options.targets.onSessionDeleted(id => {
    deleted.add(id);
    for (const entry of [...leases.values()]) {
      if (entry.conversationId === id) releaseRunLease(entry.conversationId, entry.runId);
    }
    options.service.revokeConversation(id);
    if (owner?.conversationId === id) invalidate();
  });
  return Object.freeze({
    refresh,
    resolveOwner,
    getCurrentOwner() { refresh(); return owner; },
    retainRunLease,
    getRunLease,
    releaseRunLease,
    listLeasedConversations() { return [...new Set([...leases.values()].map(entry => entry.conversationId))]; },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const entry of [...leases.values()]) releaseRunLease(entry.conversationId, entry.runId);
      invalidate();
      offInvalidation();
      offDeleted();
      offHost();
    },
  });
}

/** A manual workspace needs no chat target. Only native window/frame lifetime owns it. */
export function registerManualBrowserHostOwner<S extends object>(options: {
  host: BrowserHostPort; profile: object; service: Pick<ReturnType<typeof createBrowserService<S>>, "registerHost" | "revoke">;
}) {
  const contents = options.host.webContents;
  let owner: TrustedBrowserOwner | null = null, cancellation: AbortController | undefined;
  let generation = 0, disposed = false, navigating = false;
  function invalidate(): void {
    const previous = owner; owner = null; cancellation?.abort();
    if (previous) options.service.revoke(previous);
  }
  function refresh(): void {
    if (disposed || navigating) return;
    try {
      if (options.host.isDestroyed() || contents.isDestroyed()) { invalidate(); return; }
      if (owner?.topFrame === contents.mainFrame && !owner.signal.aborted) return;
      invalidate(); cancellation = new AbortController();
      owner = Object.freeze({ host: options.host, topFrame: contents.mainFrame, profile: options.profile,
        conversationId: null, workspaceId: randomUUID(), ownerSessionId: randomUUID(),
        generation: generation++, signal: cancellation.signal });
    } catch { invalidate(); }
  }
  function resolveOwner(event: BrowserInvokeEvent): TrustedBrowserOwner | null {
    try {
      if (disposed || navigating || event.sender !== contents || event.senderFrame !== contents.mainFrame) return null;
      refresh(); return owner;
    } catch { invalidate(); return null; }
  }
  const offHost = options.service.registerHost(options.host, resolveOwner);
  // Electron passes a details event first; the positional (url, isInPlace, isMainFrame)
  // arguments are deprecated. Prefer details and fall back so removal cannot silently skip revocation.
  const onNavigation = (...args: unknown[]) => {
    const details = args[0] as { isMainFrame?: unknown; isSameDocument?: unknown } | null | undefined;
    const isMainFrame = typeof details?.isMainFrame === "boolean" ? details.isMainFrame : args[3] === true;
    const isSameDocument = typeof details?.isSameDocument === "boolean" ? details.isSameDocument : args[2] === true;
    if (isMainFrame && !isSameDocument) { navigating = true; invalidate(); }
  };
  const onLoaded = () => { navigating = false; };
  const onCrash = () => { navigating = true; invalidate(); };
  function dispose(): void {
    if (disposed) return; disposed = true; invalidate();
    contents.removeListener("did-start-navigation", onNavigation); contents.removeListener("did-finish-load", onLoaded);
    contents.removeListener("render-process-gone", onCrash);
    contents.removeListener("destroyed", dispose); options.host.removeListener("closed", dispose); offHost();
  }
  contents.on("did-start-navigation", onNavigation); contents.on("did-finish-load", onLoaded);
  contents.on("render-process-gone", onCrash);
  contents.on("destroyed", dispose); options.host.on("closed", dispose);
  return Object.freeze({ resolveOwner, getCurrentOwner() { refresh(); return owner; }, dispose });
}

