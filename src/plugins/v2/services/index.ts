import type { PluginRpc } from "../../../shared/plugin-rpc";
import { PluginError, PLUGIN_TO_HOST_METHODS as P } from "../../../shared/plugin-protocol";
import { createRateLimiter } from "./rate-limit";

export type Mode = "chat" | "work" | "code";
export type ServicePermission = "model.generate" | "model.run" | "events" | "sessions.read" | "workspace.read";
export interface ServiceAccess {
  name: string;
  declared: readonly string[];
  granted: ReadonlySet<string>;
  /** Increment on revoke/regrant, disable, upgrade, or a change to the installed manifest. */
  revision: number;
}
export interface ServiceContext { sessionId: string; mode: Mode; workspaceRoot: string | null; workspaceName: string | null; revision: number }
export interface PublicSession {
  id: string; mode: Mode; title: string; createdAt: number; updatedAt: number;
  workspaceRoot: string | null; pluginId?: string;
}
/** Public transcript only: no tool/context messages, attachments, paths, or other-plugin payloads. */
export interface PublicMessage { id: string; role: "user" | "assistant"; text: string; at: number; pluginId?: string }
export interface GenerateRequest { prompt: string; system?: string; maxOutputTokens?: number; schema?: Record<string, unknown> }
export interface GenerateResult { text: string; usage?: { inputTokens: number; outputTokens: number } }
export interface RunRequest { objective: string; mode: Mode; sessionId: string; allowPartners: boolean; source: "plugin"; pluginId: string; pluginName: string }
export interface RunResult { runId: string; sessionId: string; reply: string }
export type EventType = "run.started" | "run.ended" | "tool.completed" | "schedule.completed";
export interface ServiceDependencies {
  /** Resolve from installed manifest and live user grants, never from RPC parameters. */
  access(pluginId: string): ServiceAccess | null;
  /** Host-owned active conversation binding, not a plugin-selected directory. */
  context(pluginId: string): ServiceContext | null;
  /** Must notify synchronously on access/binding changes, including disabling a plugin. */
  onAccessChange(pluginId: string, listener: () => void): () => void;
  /** Store approved grant revisions across process restarts; revocations and upgrades must advance the revision. */
  confirmations: {
    get(pluginId: string, permission: ServicePermission): number | undefined;
    set(pluginId: string, permission: ServicePermission, revision: number): void;
  };
  confirm(request: { pluginId: string; pluginName: string; permission: ServicePermission; signal: AbortSignal }): Promise<boolean>;
  currentModel(): Promise<object | null>;
  generate(request: GenerateRequest, profile: object, signal: AbortSignal): Promise<GenerateResult>;
  /** Adapter enters the normal run controller and its permission/approval path. Never call a raw agent loop. */
  run(request: RunRequest, profile: object, signal: AbortSignal): Promise<RunResult>;
  /** Show plugin borrowing indication and wire its stop button to cancel. Dispose hides indication. */
  borrowing(request: { pluginId: string; pluginName: string; cancel(): void }): () => void;
  sessions(context: ServiceContext, signal: AbortSignal): Promise<readonly PublicSession[]>;
  messages(sessionId: string, context: ServiceContext, signal: AbortSignal): Promise<readonly PublicMessage[]>;
  /** Host must remove real secrets and paths outside context. Regex alone is insufficient. */
  redact(text: string, context: ServiceContext): string;
  /** Events include trusted sessionId/pluginId scope metadata, stripped before delivery. */
  subscribe(listener: (event: unknown) => void): () => void;
  modelLimitPerMinute?(pluginId: string): number;
}
const invalid = () => new PluginError("ERR_INVALID_ARGUMENT", "Invalid service arguments");
const unavailable = () => new PluginError("ERR_UNAVAILABLE", "Host context is unavailable");
const permission = () => new PluginError("ERR_PERMISSION", "Plugin permission is not granted");
const cancelled = () => new PluginError("ERR_CANCELLED", "Plugin request cancelled");
const modes = new Set(["chat", "work", "code"]);
function object(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some(key => !allowed.includes(key))) throw invalid();
  return result;
}
function text(value: unknown, max = 100_000): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw invalid();
  return value;
}
function contextEqual(a: ServiceContext, b: ServiceContext | null) {
  return b !== null && a.revision === b.revision && a.sessionId === b.sessionId && a.workspaceRoot === b.workspaceRoot && a.mode === b.mode && a.workspaceName === b.workspaceName;
}
function page<T>(items: readonly T[], params: Record<string, unknown>) {
  const limit = params.limit ?? 50;
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 100) throw invalid();
  const cursor = params.cursor ?? "0";
  if (typeof cursor !== "string" || !/^(0|[1-9][0-9]{0,8})$/.test(cursor)) throw invalid();
  const offset = Number(cursor), end = offset + (limit as number);
  return { items: items.slice(offset, end), nextCursor: end < items.length ? String(end) : null };
}
function eventDto(input: unknown, pluginId: string, types: Set<string>) {
  if (!input || typeof input !== "object") return null;
  const e = input as Record<string, unknown>;
  if (typeof e.type !== "string" || !types.has(e.type) || typeof e.at !== "number" || !Number.isFinite(e.at)) return null;
  if (e.pluginId !== undefined && e.pluginId !== pluginId) return null;
  const str = (key: string) => typeof e[key] === "string" && (e[key] as string).length > 0;
  if (e.type === "run.started" && str("runId") && str("sessionId") && modes.has(String(e.mode)) && ["user", "schedule", "plugin", "channel"].includes(String(e.source)))
    return { type: e.type, runId: e.runId, sessionId: e.sessionId, mode: e.mode, source: e.source, at: e.at };
  if (e.type === "run.ended" && str("runId") && str("sessionId") && ["completed", "cancelled", "failed"].includes(String(e.outcome)))
    return { type: e.type, runId: e.runId, sessionId: e.sessionId, outcome: e.outcome, at: e.at };
  if (e.type === "tool.completed" && str("runId") && str("tool") && ["succeeded", "failed", "unknown", "not_executed"].includes(String(e.status)) && typeof e.durationMs === "number" && Number.isFinite(e.durationMs) && e.durationMs >= 0)
    return { type: e.type, runId: e.runId, tool: e.tool, status: e.status, durationMs: e.durationMs, at: e.at };
  if (e.type === "schedule.completed" && str("taskId") && ["completed", "cancelled", "failed"].includes(String(e.outcome)))
    return { type: e.type, taskId: e.taskId, outcome: e.outcome, at: e.at };
  return null;
}

/** Composition entry for HostDependencies.configureRpc. No v0 host or installation data is consulted. */
export function createPluginHostServices(deps: ServiceDependencies) {
  const pending = new Map<string, Promise<boolean>>();
  const disposers = new Set<() => void>();
  const limit = createRateLimiter(deps.modelLimitPerMinute);
  let disposed = false;
  function configureRpc(pluginId: string, rpc: PluginRpc): () => void {
    if (disposed) throw unavailable();
    const active = new Set<AbortController>();
    const eventStops = new Set<() => void>();
    const unregister: Array<() => void> = [];
    let closed = false;
    const check = (required: ServicePermission) => {
      const grant = deps.access(pluginId);
      if (!grant || !grant.declared.includes(required)) throw new PluginError("ERR_UNDECLARED", "Plugin permission is not declared");
      if (!grant.granted.has(required)) throw permission();
      return grant;
    };
    const changed = deps.onAccessChange(pluginId, () => {
      // Context-bound operations stop on rebind; event streams only stop on permission loss.
      for (const controller of active) controller.abort();
      const access = deps.access(pluginId);
      if (!access?.declared.includes("events") || !access.granted.has("events")) {
        for (const stop of eventStops) stop();
      }
    });
    function begin(required: ServicePermission, signal: AbortSignal) {
      const access = check(required), ctx = deps.context(pluginId);
      if (!ctx) throw unavailable();
      const snapshot = { ...ctx };
      const revision = access.revision;
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      active.add(controller);
      const guard = () => {
        const current = check(required);
        if (current.revision !== revision) throw permission();
        if (!contextEqual(snapshot, deps.context(pluginId))) throw unavailable();
        if (closed || controller.signal.aborted) throw cancelled();
      };
      const wait = <T>(promise: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
        const onAbort = () => { try { guard(); } catch (error) { reject(error); } };
        controller.signal.addEventListener("abort", onAbort, { once: true });
        promise.then(resolve, reject).finally(() => controller.signal.removeEventListener("abort", onAbort));
        if (controller.signal.aborted) onAbort();
      });
      return { access, ctx: snapshot, signal: controller.signal, controller, guard, wait,
        cleanup: () => { signal.removeEventListener("abort", abort); active.delete(controller); } };
    }
    type Operation = ReturnType<typeof begin>;
    async function confirm(required: ServicePermission, op: Operation) {
      const key = `${pluginId}:${op.access.revision}:${op.ctx.revision}`;
      if (deps.confirmations.get(pluginId, required) === op.access.revision) { op.guard(); return; }
      const pendingKey = `${key}:${required}`;
      let request = pending.get(pendingKey);
      if (!request) {
        request = deps.confirm({ pluginId, pluginName: op.access.name, permission: required, signal: op.signal });
        pending.set(pendingKey, request);
        void request.finally(() => { if (pending.get(pendingKey) === request) pending.delete(pendingKey); }).catch(() => {});
      }
      const accepted = await op.wait(request);
      op.guard();
      if (!accepted) throw new PluginError("ERR_REJECTED", "User declined plugin access");
      deps.confirmations.set(pluginId, required, op.access.revision);
    }
    function register(method: string, required: ServicePermission, action: (params: unknown, op: Operation) => Promise<unknown>, needsConfirmation = false) {
      unregister.push(rpc.handle(method, async (params, { signal }) => {
        const op = begin(required, signal);
        try {
          op.guard();
          if (needsConfirmation) await confirm(required, op);
          op.guard();
          const result = await action(params, op); op.guard(); return result;
        } finally { op.cleanup(); }
      }));
    }
    const scopedSessions = async (op: Operation) => {
      const rows = await op.wait(deps.sessions(op.ctx, op.signal)); op.guard();
      return rows.filter(row => row.workspaceRoot === op.ctx.workspaceRoot && (!row.pluginId || row.pluginId === pluginId));
    };
    register(P.sessionsList, "sessions.read", async (input, op) => {
      const params = object(input ?? {}, ["cursor", "limit", "mode"]);
      page([], params);
      if (params.mode !== undefined && !modes.has(String(params.mode))) throw invalid();
      const rows = (await scopedSessions(op)).filter(row => params.mode === undefined || row.mode === params.mode);
      return page(rows.map(row => ({ id: row.id, mode: row.mode, title: deps.redact(row.title, op.ctx), createdAt: row.createdAt, updatedAt: row.updatedAt })), params);
    }, true);
    register(P.sessionsMessages, "sessions.read", async (input, op) => {
      const params = object(input, ["sessionId", "cursor", "limit"]); const id = text(params.sessionId, 256); page([], params);
      if (!(await scopedSessions(op)).some(row => row.id === id)) throw permission();
      const rows = await op.wait(deps.messages(id, op.ctx, op.signal)); op.guard();
      return page(rows.filter(row => (row.role === "user" || row.role === "assistant") && (!row.pluginId || row.pluginId === pluginId)).map(row => ({ id: row.id, role: row.role, text: deps.redact(row.text, op.ctx), at: row.at })), params);
    }, true);
    const model = async (input: unknown, op: Operation, run: boolean) => {
      const params = object(input, run ? ["objective", "mode", "sessionId", "allowPartners"] : ["prompt", "system", "maxOutputTokens", "schema"]);
      let request: GenerateRequest | RunRequest;
      if (run) {
        const objective = text(params.objective);
        if (!modes.has(String(params.mode)) || (params.allowPartners !== undefined && typeof params.allowPartners !== "boolean")) throw invalid();
        if (params.sessionId !== undefined && params.sessionId !== op.ctx.sessionId) throw permission();
        request = { objective, mode: params.mode as Mode, allowPartners: params.allowPartners === true, sessionId: op.ctx.sessionId, source: "plugin", pluginId, pluginName: op.access.name };
      } else {
        request = { prompt: text(params.prompt) };
        if (params.system !== undefined) request.system = text(params.system);
        if (params.maxOutputTokens !== undefined) {
          if (!Number.isInteger(params.maxOutputTokens) || (params.maxOutputTokens as number) < 1 || (params.maxOutputTokens as number) > 1_000_000) throw invalid();
          request.maxOutputTokens = params.maxOutputTokens as number;
        }
        if (params.schema !== undefined) {
          if (!params.schema || typeof params.schema !== "object" || Array.isArray(params.schema)) throw invalid();
          request.schema = params.schema as Record<string, unknown>;
        }
      }
      const profile = await op.wait(deps.currentModel()); op.guard(); if (!profile) throw unavailable();
      limit(pluginId);
      const hide = deps.borrowing({ pluginId, pluginName: op.access.name, cancel: () => op.controller.abort() });
      try {
        op.guard();
        if (run) {
          const result = await op.wait(deps.run(request as RunRequest, profile, op.signal)); op.guard();
          if (result.sessionId !== op.ctx.sessionId) throw permission();
          return { runId: result.runId, sessionId: result.sessionId, reply: deps.redact(result.reply, op.ctx) };
        }
        const result = await op.wait(deps.generate(request as GenerateRequest, profile, op.signal)); op.guard();
        return { text: deps.redact(result.text, op.ctx), ...(result.usage ? { usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens } } : {}) };
      } finally { hide(); }
    };
    register(P.modelGenerate, "model.generate", (params, op) => model(params, op, false));
    register(P.modelRun, "model.run", (params, op) => model(params, op, true), true);
    register(P.workspaceInfo, "workspace.read", async (input, op) => {
      const params = object(input ?? {}, ["sessionId"]);
      if (params.sessionId !== undefined && params.sessionId !== op.ctx.sessionId) throw permission();
      // Path is intentionally disclosed only for the approved, currently bound workspace.
      return { sessionId: op.ctx.sessionId, mode: op.ctx.mode, root: op.ctx.workspaceRoot, name: op.ctx.workspaceName === null ? null : deps.redact(op.ctx.workspaceName, op.ctx) };
    }, true);
    unregister.push(rpc.handle(P.eventsSubscribe, (input, { signal }) => {
      check("events");
      const params = object(input ?? {}, ["types"]);
      const allowed = ["run.started", "run.ended", "tool.completed", "schedule.completed"];
      if (params.types !== undefined && (!Array.isArray(params.types) || params.types.length === 0 || params.types.some(t => !allowed.includes(t)))) { throw invalid(); }
      const types = new Set<string>(params.types as string[] ?? allowed);
      return (async function* () {
        check("events");
        const queue: unknown[] = [];
        let wake = () => {};
        let failure: PluginError | undefined;
        let unsubscribe = () => {};
        const detach = () => {
          const off = unsubscribe;
          unsubscribe = () => {};
          off();
        };
        const stop = (error: PluginError) => {
          failure ??= error;
          queue.length = 0;
          detach();
          wake();
        };
        const revoke = () => stop(permission());
        const cancel = () => stop(cancelled());
        const guard = () => {
          if (failure) throw failure;
          if (closed || signal.aborted) throw cancelled();
          const access = deps.access(pluginId);
          if (!access?.declared.includes("events") || !access.granted.has("events")) throw permission();
        };
        eventStops.add(revoke);
        signal.addEventListener("abort", cancel, { once: true });
        try {
          guard();
          unsubscribe = deps.subscribe(input => {
            try {
              guard();
              const dto = eventDto(input, pluginId, types);
              if (dto) { if (queue.length >= 100) queue.shift(); queue.push(dto); wake(); }
            } catch (error) {
              stop(error instanceof PluginError ? error : permission());
            }
          });
          if (failure) detach();
          while (true) {
            guard();
            if (!queue.length) await new Promise<void>(resolve => { wake = resolve; });
            guard();
            while (queue.length) { guard(); yield queue.shift(); }
          }
        } finally {
          detach();
          eventStops.delete(revoke);
          signal.removeEventListener("abort", cancel);
        }
      })();
    }));
    const dispose = () => {
      if (closed) return; closed = true;
      for (const controller of active) controller.abort();
      for (const stop of eventStops) stop();
      changed(); unregister.forEach(stop => stop()); disposers.delete(dispose);
    };
    disposers.add(dispose); return dispose;
  }
  return { configureRpc, dispose() { disposed = true; for (const dispose of [...disposers]) dispose(); pending.clear(); } };
}
