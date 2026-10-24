import type { IpcMainInvokeEvent, WebContents } from "electron";
import type { IpcScope } from "../application/ipc-scope";
import { IPC } from "../../shared/ipc-channels";
import type { ExternalResult, ExternalSkillSourceId } from "../../shared/external-skills";
import type { ExternalOwner } from "./external-types";
import type { createExternalSkillService } from "./external-service";
import { isExternalSkillSelection } from "./external-revisions";

// Shared with the existing enable handler. Navigation must close both mutation routes.
const blockedHosts = new WeakMap<WebContents, { blocked: boolean }>();
const destroyedHosts = new WeakSet<WebContents>();
export function isTrustedExternalMainFrame(event: IpcMainInvokeEvent, host: WebContents | null): boolean {
  try {
    return !!host && !host.isDestroyed() && !destroyedHosts.has(host) && !blockedHosts.get(host)?.blocked
      && event?.sender === host && !!event.senderFrame && !event.senderFrame.detached
      && event.senderFrame === host.mainFrame
      && event.senderFrame.processId === host.mainFrame.processId && event.senderFrame.routingId === host.mainFrame.routingId;
  } catch { return false; }
}
const forbidden = (): ExternalResult<never> => ({ ok: false, code: "FORBIDDEN", error: "External Skill request is not permitted.", retryable: false });
function record(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && required.every(key => Object.hasOwn(value, key))
    && Reflect.ownKeys(value).every(key => typeof key === "string" && (required.includes(key) || optional.includes(key)));
}
const source = (value: unknown): value is ExternalSkillSourceId => value === "openai" || value === "anthropic";
const candidate = (value: unknown): value is string => typeof value === "string" && /^external-(openai|anthropic)-[a-z0-9-]{1,80}$/.test(value) && value.length <= 100;

/** Main-only owner and lifecycle binding. No URL, filesystem path, inventory or approval is accepted. */
export function registerExternalSkillsIpc(deps: {
  ipc: Pick<IpcScope, "handle">;
  getHostWebContents: () => WebContents | null;
  service: ReturnType<typeof createExternalSkillService>;
}): { dispose: () => Promise<void>; refreshHost: () => void } {
  let host: WebContents | null = null, generation = 0, owner: ExternalOwner | undefined, disposed = false;
  let status: { blocked: boolean } | undefined, detach: (() => void) | undefined, disposal: Promise<void> | undefined;
  function invalidate(): void {
    const previous = owner; owner = undefined; generation++;
    // The service retains any failed owned cleanup and retries it during disposal/preparation.
    if (previous) { try { deps.service.invalidate(previous); } catch { /* Do not crash Electron lifecycle or broaden cleanup authority. */ } }
  }
  function refreshHost(): void {
    if (disposed) return;
    let next: WebContents | null;
    try { next = deps.getHostWebContents(); if (next?.isDestroyed() || (next && destroyedHosts.has(next))) next = null; } catch { next = null; }
    if (next === host) return;
    if (host) invalidate(); detach?.(); detach = undefined; host = next;
    if (!host) return;
    const bound = host, state = { blocked: false }; status = state; blockedHosts.set(bound, state);
    const navigate = (details: { isMainFrame?: boolean }, _url: string, _sameDocument: boolean, isMainFrame: boolean) => {
      if ((details?.isMainFrame ?? isMainFrame) !== true) return;
      state.blocked = true; invalidate();
    };
    const resumed = () => { if (host === bound && !disposed && !bound.isDestroyed()) state.blocked = false; };
    const inPage = (_event: unknown, _url: string, isMainFrame: boolean) => { if (isMainFrame) resumed(); };
    const gone = () => { state.blocked = true; invalidate(); };
    const destroyed = () => { state.blocked = true; destroyedHosts.add(bound); invalidate(); detach?.(); detach = undefined; host = null; };
    bound.on("did-start-navigation", navigate);
    bound.on("did-navigate", resumed);
    bound.on("did-navigate-in-page", inPage);
    bound.on("render-process-gone", gone);
    bound.on("destroyed", destroyed);
    detach = () => {
      bound.removeListener("did-start-navigation", navigate);
      bound.removeListener("did-navigate", resumed);
      bound.removeListener("did-navigate-in-page", inPage);
      bound.removeListener("render-process-gone", gone);
      bound.removeListener("destroyed", destroyed);
      // Replaced/disposed workbenches can never use the legacy enable route.
      state.blocked = true;
    };
  }
  function currentOwner(event: IpcMainInvokeEvent): ExternalOwner | undefined {
    if (disposed) return; refreshHost();
    if (!isTrustedExternalMainFrame(event, host) || status?.blocked) return;
    const frame = event.senderFrame!;
    if (owner && (owner.frameProcessId !== frame.processId || owner.frameRoutingId !== frame.routingId)) invalidate();
    owner ??= { webContentsId: host!.id, frameProcessId: frame.processId, frameRoutingId: frame.routingId, generation };
    return { ...owner };
  }
  deps.ipc.handle(IPC.EXTERNAL_SKILLS_LIST, (event: IpcMainInvokeEvent, payload: unknown) => {
    const current = currentOwner(event);
    if (!current || !record(payload, ["sourceId"], ["refresh"]) || !source(payload.sourceId) || (Object.hasOwn(payload, "refresh") && typeof payload.refresh !== "boolean")) return forbidden();
    return deps.service.list(current, payload.sourceId, payload.refresh === true);
  });
  function candidateRequest(event: IpcMainInvokeEvent, payload: unknown, method: "detail" | "prepare") {
    const current = currentOwner(event);
    if (!current || !record(payload, ["sourceId", "id"], ["selection"]) || !source(payload.sourceId) || !candidate(payload.id) ||
      (Object.hasOwn(payload, "selection") && !isExternalSkillSelection(payload.selection))) return forbidden();
    return Object.hasOwn(payload, "selection") ? deps.service[method](current, payload.sourceId, payload.id, payload.selection as import("../../shared/external-skills").ExternalSkillSelection)
      : deps.service[method](current, payload.sourceId, payload.id);
  }
  deps.ipc.handle(IPC.EXTERNAL_SKILLS_DETAIL, (event: IpcMainInvokeEvent, payload: unknown) => candidateRequest(event, payload, "detail"));
  deps.ipc.handle(IPC.EXTERNAL_SKILLS_PREPARE, (event: IpcMainInvokeEvent, payload: unknown) => candidateRequest(event, payload, "prepare"));
  deps.ipc.handle(IPC.EXTERNAL_SKILLS_COMMIT, (event: IpcMainInvokeEvent, payload: unknown) => {
    const current = currentOwner(event);
    if (!current || !record(payload, ["token"]) || typeof payload.token !== "string" || !/^[a-f0-9]{64}$/.test(payload.token)) return forbidden();
    return deps.service.commit(current, payload.token);
  });
  deps.ipc.handle(IPC.EXTERNAL_SKILLS_CANCEL, (event: IpcMainInvokeEvent, payload: unknown) => {
    const current = currentOwner(event);
    if (!current || !record(payload, [])) return forbidden();
    return deps.service.cancel(current);
  });
  refreshHost();
  return {
    refreshHost,
    dispose(): Promise<void> {
      if (disposal) return disposal;
      disposed = true; if (status) status.blocked = true; invalidate(); detach?.(); detach = undefined; host = null;
      disposal = deps.service.dispose(); return disposal;
    },
  };
}
