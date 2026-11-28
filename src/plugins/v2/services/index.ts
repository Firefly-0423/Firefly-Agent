import type { PluginRpc } from "../../../shared/plugin-rpc";
import { PluginError, PLUGIN_TO_HOST_METHODS as P, type PluginToHostParams, type PluginToHostResults, type PluginToHostStreamChunks, type ProtocolRunEvent, type ProtocolPage } from "../../../shared/plugin-protocol";
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
  generateStream(request: GenerateRequest, profile: object, signal: AbortSignal): AsyncIterable<PluginToHostStreamChunks["model.generate"]>;
  watchWorkspace(pluginId: string, listener: () => void): () => void;
  /** Adapter enters the normal run controller and its permission/approval path. Never call a raw agent loop. */
  run(request: RunRequest, profile: object, signal: AbortSignal, onEvent: (event: ProtocolRunEvent) => void): Promise<RunResult>;
  /** Show plugin borrowing indication and wire its stop button to cancel. Dispose hides indication. */
  borrowing(request: { pluginId: string; pluginName: string; cancel(): void }): () => void;
  sessions(context: ServiceContext, signal: AbortSignal): Promise<readonly PublicSession[]>;
  messages(sessionId: string, context: ServiceContext, signal: AbortSignal): Promise<readonly PublicMessage[]>;
  /** Host must remove real secrets and paths outside context. Regex alone is insufficient. */
  redact(text: string, context: ServiceContext): string;
  /** Per-stream redactor must retain undecidable suffixes across pushes and emit only safe text.
   * finish releases the sanitized tail; callers never flush after cancellation or access loss.
   * Wiring must fail closed when no streaming secret/path redactor is available.
   */
  createStreamRedactor(context: ServiceContext): { push(text: string): string; finish(): string };
  /** Events include trusted sessionId/pluginId scope metadata, stripped before delivery. */
  subscribe(listener: (event: unknown) => void): () => void;
  modelLimitPerMinute?(pluginId: string): number;
  /** Called once per approved model.generate (plain or streaming), for the plugin call statistics. */
  onModelCall?(pluginId: string): void;
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
function page<T>(items: readonly T[], params: Record<string, unknown>): ProtocolPage<T> {
  const limit = params.limit ?? 50;
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 100) throw invalid();
  const cursor = params.cursor ?? "0";
  if (typeof cursor !== "string" || !/^(0|[1-9][0-9]{0,8})$/.test(cursor)) throw invalid();
  const offset = Number(cursor), end = offset + (limit as number);
  return { items: items.slice(offset, end), ...(end < items.length ? { nextCursor: String(end) } : {}) };
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
  type PendingConfirmation = {
    controller: AbortController;
    promise: Promise<boolean>;
    waiters: Set<symbol>;
    settled: boolean;
  };
  const pending = new Map<string, PendingConfirmation>();
  const disposers = new Set<() => void>();
  const limit = createRateLimiter(deps.modelLimitPerMinute);
  let disposed = false;
  function configureRpc(pluginId: string, rpc: PluginRpc): () => void {
    if (disposed) throw unavailable();
    const active = new Map<AbortController, () => void>();
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
      for (const [controller, validate] of active) { try { validate(); } catch { controller.abort(); } }
      const access = deps.access(pluginId);
      if (!access?.declared.includes("events") || !access.granted.has("events")) {
        for (const stop of eventStops) stop();
      }
    });
    type Operation = {
      access: ServiceAccess;
      ctx: ServiceContext;
      signal: AbortSignal;
      controller: AbortController;
      guard: () => void;
      wait: <T>(promise: Promise<T>) => Promise<T>;
      cleanup: () => void;
    };
    type OptionalContextOperation = Omit<Operation, "ctx"> & { ctx: ServiceContext | null };
    function begin(required: ServicePermission, signal: AbortSignal, bindContext?: true): Operation;
    function begin(required: ServicePermission, signal: AbortSignal, bindContext: boolean, requireContext: false): OptionalContextOperation;
    function begin(required: ServicePermission, signal: AbortSignal, bindContext = true, requireContext = true): Operation | OptionalContextOperation {
      const access = check(required), ctx = deps.context(pluginId);
      if (!ctx && requireContext) throw unavailable();
      const snapshot = ctx ? { ...ctx } : null;
      const revision = access.revision;
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      const guard = () => {
        const current = check(required);
        if (current.revision !== revision) throw permission();
        if (bindContext && snapshot && !contextEqual(snapshot, deps.context(pluginId))) throw unavailable();
        if (closed || controller.signal.aborted) throw cancelled();
      };
      active.set(controller, guard);
      const wait = <T>(promise: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
        const onAbort = () => { try { guard(); } catch (error) { reject(error); } };
        controller.signal.addEventListener("abort", onAbort, { once: true });
        promise.then(resolve, reject).finally(() => controller.signal.removeEventListener("abort", onAbort));
        if (controller.signal.aborted) onAbort();
      });
      return { access, ctx: snapshot, signal: controller.signal, controller, guard, wait,
        cleanup: () => { signal.removeEventListener("abort", abort); active.delete(controller); } };
    }
    async function confirm(required: ServicePermission, op: Operation | OptionalContextOperation) {
      const key = `${pluginId}:${op.access.revision}:${op.ctx?.revision ?? "unbound"}`;
      if (deps.confirmations.get(pluginId, required) === op.access.revision) { op.guard(); return; }
      const pendingKey = `${key}:${required}`;
      let entry = pending.get(pendingKey);
      if (!entry) {
        const controller = new AbortController();
        entry = {
          controller,
          promise: deps.confirm({ pluginId, pluginName: op.access.name, permission: required, signal: controller.signal }),
          waiters: new Set(),
          settled: false,
        };
        pending.set(pendingKey, entry);
        void entry.promise.finally(() => {
          entry!.settled = true;
          if (pending.get(pendingKey) === entry) pending.delete(pendingKey);
        }).catch(() => {});
      }
      const waiter = Symbol();
      entry.waiters.add(waiter);
      try {
        const accepted = await op.wait(entry.promise);
        op.guard();
        if (!accepted) throw new PluginError("ERR_REJECTED", "User declined plugin access");
        deps.confirmations.set(pluginId, required, op.access.revision);
      } finally {
        entry.waiters.delete(waiter);
        if (!entry.waiters.size && !entry.settled && pending.get(pendingKey) === entry) {
          pending.delete(pendingKey);
          entry.controller.abort();
        }
      }
    }
    function register<M extends keyof PluginToHostParams>(method: M, required: ServicePermission, action: (params: PluginToHostParams[M], op: Operation) => Promise<PluginToHostResults[M]>, needsConfirmation = false) {
      unregister.push(rpc.handle(method, async (params, { signal }) => {
        const op = begin(required, signal);
        try {
          op.guard();
          if (needsConfirmation) await confirm(required, op);
          op.guard();
          const result = await action(params as PluginToHostParams[M], op); op.guard(); return result;
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
      return page(rows.map(row => ({ id: row.id, mode: row.mode, title: deps.redact(row.title, op.ctx), updatedAt: row.updatedAt })), params);
    }, true);
    register(P.sessionsMessages, "sessions.read", async (input, op) => {
      const params = object(input, ["sessionId", "cursor", "limit"]); const id = text(params.sessionId, 256); page([], params);
      if (!(await scopedSessions(op)).some(row => row.id === id)) throw permission();
      const rows = await op.wait(deps.messages(id, op.ctx, op.signal)); op.guard();
      return page(rows.filter(row => (row.role === "user" || row.role === "assistant") && (!row.pluginId || row.pluginId === pluginId)).map(row => ({ id: row.id, role: row.role, content: deps.redact(row.text, op.ctx), createdAt: row.at })), params);
    }, true);
    const prepareModel = async (input: unknown, op: Operation, run: boolean) => {
      const params = object(input, run ? ["objective", "mode", "sessionId", "allowPartners"] : ["prompt", "system", "maxOutputTokens", "schema", "stream"]);
      let request: GenerateRequest | RunRequest;
      if (run) {
        const objective = text(params.objective);
        if (!modes.has(String(params.mode)) || (params.allowPartners !== undefined && typeof params.allowPartners !== "boolean")) throw invalid();
        if (params.sessionId !== undefined && params.sessionId !== op.ctx.sessionId) throw permission();
        request = { objective, mode: params.mode as Mode, allowPartners: params.allowPartners === true, sessionId: op.ctx.sessionId, source: "plugin", pluginId, pluginName: op.access.name };
      } else {
        if (params.stream !== undefined && typeof params.stream !== "boolean") throw invalid();
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
      return { request, profile, hide };
    };
    const runResult = (result: RunResult, op: Operation): PluginToHostResults["model.run"] => {
      op.guard();
      if (result.sessionId !== op.ctx.sessionId) throw permission();
      return { runId: result.runId, sessionId: result.sessionId, reply: deps.redact(result.reply, op.ctx) };
    };
    function streamModel<M extends "model.generate" | "model.run">(method: M, input: PluginToHostParams[M], signal: AbortSignal): AsyncIterable<PluginToHostStreamChunks[M]> {
      return (async function* () {
        const isRun = method === P.modelRun;
        const op = begin(isRun ? "model.run" : "model.generate", signal);
        let hide = () => {};
        try {
          op.guard();
          if (isRun) await confirm("model.run", op);
          op.guard();
          const prepared = await prepareModel(input, op, isRun);
          hide = prepared.hide;
          op.guard();
          const redactor = deps.createStreamRedactor(op.ctx);
          if (!isRun) {
            deps.onModelCall?.(pluginId);
            const iterator = deps.generateStream(prepared.request as GenerateRequest, prepared.profile, op.signal)[Symbol.asyncIterator]();
            try {
              while (true) {
                const next = await op.wait(iterator.next()); op.guard();
                if (next.done) break;
                const delta = redactor.push(next.value.delta); op.guard();
                if (delta) yield { delta } as PluginToHostStreamChunks[M];
              }
            } finally {
              // A provider which ignores cancellation must not prevent RPC cleanup.
              void Promise.resolve(iterator.return?.()).catch(() => {});
            }
            op.guard(); const tail = redactor.finish(); op.guard();
            if (tail) yield { delta: tail } as PluginToHostStreamChunks[M];
          } else {
            const queue: ProtocolRunEvent[] = [];
            let wake = () => {}, done = false;
            let result: RunResult | undefined, failure: unknown;
            const emit = (event: ProtocolRunEvent) => {
              try {
                op.guard();
                if (queue.length >= 100) throw new PluginError("ERR_UNAVAILABLE", "Run event queue overflow");
                let dto: ProtocolRunEvent;
                switch (event.type) {
                  case "run.started":
                    if (event.sessionId !== op.ctx.sessionId) throw permission();
                    dto = { type: event.type, runId: event.runId, sessionId: event.sessionId, mode: event.mode, at: event.at }; break;
                  case "run.ended":
                    if (event.sessionId !== op.ctx.sessionId) throw permission();
                    dto = { type: event.type, runId: event.runId, sessionId: event.sessionId, outcome: event.outcome, at: event.at }; break;
                  case "text.delta": {
                    const delta = redactor.push(event.delta);
                    if (!delta) return;
                    dto = { type: event.type, delta }; break;
                  }
                  case "tool.started": dto = { type: event.type, callId: event.callId, tool: event.tool }; break;
                  case "tool.completed": dto = { type: event.type, callId: event.callId, tool: event.tool, status: event.status }; break;
                  default: throw invalid();
                }
                queue.push(dto); wake();
              } catch (error) { failure ??= error; queue.length = 0; op.controller.abort(); wake(); }
            };
            void op.wait(deps.run(prepared.request as RunRequest, prepared.profile, op.signal, emit)).then(
              value => { result = value; }, error => { failure ??= error; },
            ).finally(() => { done = true; wake(); });
            while (!done || queue.length) {
              if (failure) throw failure;
              op.guard();
              if (queue.length) yield queue.shift()! as PluginToHostStreamChunks[M];
              else await new Promise<void>(resolve => { wake = resolve; });
            }
            if (failure) throw failure;
            op.guard();
            if (!result) throw unavailable();
            const tail = redactor.finish(); op.guard();
            if (tail) yield { type: "text.delta", delta: tail } as PluginToHostStreamChunks[M];
            op.guard();
            yield { type: "run.result", result: runResult(result, op) } as PluginToHostStreamChunks[M];
          }
          op.guard();
        } finally { op.controller.abort(); hide(); op.cleanup(); }
      })();
    }
    unregister.push(rpc.handle(P.modelGenerate, (input, { signal }) => {
      const params = object(input, ["prompt", "system", "maxOutputTokens", "schema", "stream"]);
      if (params.stream === true) return streamModel(P.modelGenerate, params as unknown as PluginToHostParams["model.generate"], signal);
      return (async (): Promise<PluginToHostResults["model.generate"]> => {
        const op = begin("model.generate", signal);
        let hide = () => {};
        try {
          op.guard();
          const prepared = await prepareModel(params, op, false); hide = prepared.hide;
          op.guard();
          deps.onModelCall?.(pluginId);
          const result = await op.wait(deps.generate(prepared.request as GenerateRequest, prepared.profile, op.signal)); op.guard();
          return { text: deps.redact(result.text, op.ctx), ...(result.usage ? { usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens } } : {}) };
        } finally { hide(); op.cleanup(); }
      })();
    }));
    unregister.push(rpc.handle(P.modelRun, (input, { signal }) => streamModel(P.modelRun, input as PluginToHostParams["model.run"], signal)));
    unregister.push(rpc.handle(P.workspaceInfo, (input, { signal }) => {
      return (async (): Promise<PluginToHostResults["workspace.info"]> => {
        const op = begin("workspace.read", signal, true, false);
        try {
          const params = object(input ?? {}, ["sessionId"]);
          if (params.sessionId !== undefined && op.ctx?.sessionId !== params.sessionId) throw permission();
          op.guard(); await confirm("workspace.read", op); op.guard();
          if (!op.ctx) return null;
          // Path is intentionally disclosed only for the approved, currently bound workspace.
          return { sessionId: op.ctx.sessionId, mode: op.ctx.mode, root: op.ctx.workspaceRoot, name: op.ctx.workspaceName === null ? null : deps.redact(op.ctx.workspaceName, op.ctx) };
        } finally { op.cleanup(); }
      })();
    }));
    unregister.push(rpc.handle(P.eventsSubscribe, (input, { signal }) => {
      check("events");
      const params = object(input ?? {}, ["type"]);
      const allowed = ["run.started", "run.ended", "tool.completed", "schedule.completed"];
      if (typeof params.type !== "string" || !allowed.includes(params.type)) throw invalid();
      const types = new Set([params.type]);
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
    unregister.push(rpc.handle(P.workspaceWatch, (input, { signal }) => {
      object(input ?? {}, []);
      return (async function* (): AsyncIterable<PluginToHostStreamChunks["workspace.watch"]> {
        const op = begin("workspace.read", signal, false, false);
        let unsubscribe = () => {};
        let wake = () => {}, dirty = false;
        const changed = () => { dirty = true; wake(); };
        const abort = () => wake();
        op.signal.addEventListener("abort", abort);
        try {
          op.guard(); await confirm("workspace.read", op); op.guard();
          unsubscribe = deps.watchWorkspace(pluginId, changed);
          while (true) {
            op.guard();
            if (!dirty) await new Promise<void>(resolve => { wake = resolve; });
            op.guard(); dirty = false;
            const ctx = deps.context(pluginId);
            yield ctx ? { sessionId: ctx.sessionId, mode: ctx.mode, root: ctx.workspaceRoot, name: ctx.workspaceName === null ? null : deps.redact(ctx.workspaceName, ctx) } : null;
          }
        } finally { unsubscribe(); op.signal.removeEventListener("abort", abort); op.cleanup(); }
      })();
    }));
    const dispose = () => {
      if (closed) return; closed = true;
      for (const controller of active.keys()) controller.abort();
      for (const stop of eventStops) stop();
      changed(); unregister.forEach(stop => stop()); disposers.delete(dispose);
    };
    disposers.add(dispose); return dispose;
  }
  return {
    configureRpc,
    dispose() {
      disposed = true;
      for (const dispose of [...disposers]) dispose();
      for (const entry of pending.values()) entry.controller.abort();
      pending.clear();
    },
  };
}
