import {
  HOST_TO_PLUGIN_METHODS as H,
  PLUGIN_TO_HOST_METHODS as P,
  PluginError,
  type PluginToHostMethod,
  type PluginToHostParams,
  type PluginToHostResults,
  type PluginToHostStreamChunks,
  type PluginToHostStreamMethod,
  type ProtocolChannelState,
  type ProtocolHostEvent,
  type ProtocolInboundMessage,
  type ProtocolMessageRecord,
  type ProtocolMode,
  type ProtocolModelGenerateChunk,
  type ProtocolModelGenerateResult,
  type ProtocolModelRunResult,
  type ProtocolOutboundMessage,
  type ProtocolPage,
  type ProtocolRunEvent,
  type ProtocolRunSource,
  type ProtocolScheduleProposalSpec,
  type ProtocolSessionSummary,
  type ProtocolTaskRecord,
  type ProtocolToolCaller,
  type ProtocolUiMessageEvent,
  type ProtocolUiTarget,
  type ProtocolWorkspaceInfo,
} from "../../../shared/plugin-protocol";
import type { PluginRpc, RpcOptions } from "../../../shared/plugin-rpc";

/** Max 32-bit signed timeout accepted by setTimeout / createRpcEndpoint (~24.8 days). */
const MAX_STREAM_TIMEOUT_MS = 2_147_483_647;

export interface Disposable {
  dispose(): void;
  readonly closed?: Promise<void>;
}

export interface RuntimeToolCall {
  readonly callId: string;
  readonly sessionId: string;
  readonly mode: "work" | "code";
  readonly caller: ProtocolToolCaller;
  readonly signal: AbortSignal;
  progress(message: string, percent?: number): void;
}

export interface RuntimeToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  describeApproval?(args: Record<string, unknown>): { summary: string; target?: string };
  execute(args: Record<string, unknown>, call: RuntimeToolCall): Promise<unknown>;
}

export interface RuntimeContextProviderDefinition {
  id: string;
  modes: ProtocolMode[];
  sources: ProtocolRunSource[];
  provide(req: { sessionId: string; mode: string; source: string; signal: AbortSignal }): Promise<unknown>;
}

export interface RuntimeChannelAdapter {
  id: string;
  start(
    host: {
      reportState(s: ProtocolChannelState): void;
      deliver(msg: ProtocolInboundMessage): Promise<{ accepted: boolean; sessionId?: string }>;
    },
    signal: AbortSignal,
  ): Promise<void>;
  stop(): Promise<void>;
  send(msg: ProtocolOutboundMessage, signal: AbortSignal): Promise<{ externalMessageId: string }>;
}

export interface RuntimePluginContext {
  readonly id: string;
  readonly version: string;
  readonly dataDir: string;
  readonly signal: AbortSignal;
  has(permission: string): boolean;
  readonly tools: {
    register(tool: RuntimeToolDefinition): Disposable;
  };
  readonly context: {
    register(provider: RuntimeContextProviderDefinition): Disposable;
  };
  readonly channels: {
    register(adapter: RuntimeChannelAdapter): Disposable;
  };
  readonly model: {
    generate(req: {
      prompt: string;
      system?: string;
      maxOutputTokens?: number;
      schema?: Record<string, unknown>;
      signal?: AbortSignal;
    }): Promise<ProtocolModelGenerateResult>;
    generateStream(req: {
      prompt: string;
      system?: string;
      maxOutputTokens?: number;
      schema?: Record<string, unknown>;
      signal?: AbortSignal;
    }): AsyncIterable<ProtocolModelGenerateChunk>;
    run(req: {
      objective: string;
      mode: ProtocolMode;
      sessionId?: string;
      allowPartners?: boolean;
      signal?: AbortSignal;
    }): { events: AsyncIterable<ProtocolRunEvent>; result: Promise<ProtocolModelRunResult> };
  };
  readonly events: {
    on(type: ProtocolHostEvent["type"], fn: (event: ProtocolHostEvent) => void): Disposable;
  };
  readonly sessions: {
    list(o?: { cursor?: string; limit?: number; mode?: ProtocolMode }): Promise<ProtocolPage<ProtocolSessionSummary>>;
    messages(sessionId: string, o?: { cursor?: string; limit?: number }): Promise<ProtocolPage<ProtocolMessageRecord>>;
  };
  readonly workspace: {
    current(sessionId?: string): Promise<ProtocolWorkspaceInfo | null>;
    onChange(fn: (info: ProtocolWorkspaceInfo | null) => void): Disposable;
  };
  readonly schedules: {
    propose(spec: ProtocolScheduleProposalSpec): Promise<{ taskId: string; status: "pending_approval" }>;
    update(taskId: string, patch: Partial<ProtocolScheduleProposalSpec>): Promise<{ status: "pending_approval" }>;
    remove(taskId: string): Promise<boolean>;
    list(): Promise<ProtocolTaskRecord[]>;
    onTrigger(fn: (e: { taskId: string; payload?: unknown; signal: AbortSignal }) => Promise<void>): Disposable;
  };
  readonly secrets: {
    set(key: string, value: string): Promise<void>;
    get(key: string): Promise<string | null>;
    delete(key: string): Promise<boolean>;
    keys(): Promise<string[]>;
  };
  readonly ui: {
    openWindow(id: string, state?: unknown): Promise<{ close(): Promise<void>; post(msg: unknown): Promise<void> }>;
    onMessage(fn: (e: ProtocolUiMessageEvent) => Promise<unknown>): Disposable;
    post(to: ProtocolUiTarget, msg: unknown): Promise<void>;
  };
}

export interface PluginContextProxyOptions {
  id: string;
  version: string;
  dataDir: string;
  permissions: readonly string[];
  signal: AbortSignal;
  rpc: PluginRpc;
}

export interface PluginContextRuntime {
  ctx: RuntimePluginContext;
  awaitPendingRegistrations(): Promise<void>;
  dispose(): void;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function linkSignals(base: AbortSignal, extra?: AbortSignal): { signal: AbortSignal; cleanup(): void } {
  if (!extra) {
    return { signal: base, cleanup: () => {} };
  }
  const controller = new AbortController();
  const abortFromBase = () => controller.abort(base.reason);
  const abortFromExtra = () => controller.abort(extra.reason);
  if (base.aborted) {
    controller.abort(base.reason);
    return { signal: controller.signal, cleanup: () => {} };
  }
  if (extra.aborted) {
    controller.abort(extra.reason);
    return { signal: controller.signal, cleanup: () => {} };
  }
  base.addEventListener("abort", abortFromBase, { once: true });
  extra.addEventListener("abort", abortFromExtra, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      base.removeEventListener("abort", abortFromBase);
      extra.removeEventListener("abort", abortFromExtra);
    },
  };
}

function createChildController(parent: AbortSignal): { controller: AbortController; detach(): void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent.reason);
  if (parent.aborted) {
    controller.abort(parent.reason);
    return { controller, detach: () => {} };
  }
  parent.addEventListener("abort", onAbort, { once: true });
  return {
    controller,
    detach: () => parent.removeEventListener("abort", onAbort),
  };
}

export function createPluginContextProxy(options: PluginContextProxyOptions): PluginContextRuntime {
  const { id, version, dataDir, signal, rpc } = options;
  const permissionSet = new Set(options.permissions);

  const registeredTools = new Map<string, RuntimeToolDefinition>();
  const registeredProviders = new Map<string, RuntimeContextProviderDefinition>();
  const registeredChannels = new Map<string, RuntimeChannelAdapter>();
  const channelAbortControllers = new Map<string, AbortController>();
  const activeSubscriptions = new Set<AbortController>();
  const pendingRegistrations = new Set<Promise<unknown>>();
  let uiMessageHandler:
    | ((e: { from: { kind: "window" | "settings"; id: string }; method: string; params: unknown }) => Promise<unknown>)
    | undefined;

  const trackRegistration = (promise: Promise<unknown>): void => {
    // Only successful registrations leave the set: a refusal that arrives while activate() is still
    // awaiting its own setup must stay visible to awaitPendingRegistrations() and fail activation.
    const tracked = promise.then(() => {
      pendingRegistrations.delete(tracked);
    });
    // Prevent unhandled rejection before H.activate awaits pendingRegistrations.
    tracked.catch(() => {});
    pendingRegistrations.add(tracked);
  };

  const callHost = <M extends PluginToHostMethod>(
    method: M,
    params: PluginToHostParams[M],
    callOptions?: RpcOptions,
  ): Promise<PluginToHostResults[M]> => rpc.call<PluginToHostResults[M]>(method, params, callOptions);

  const streamHost = <M extends PluginToHostStreamMethod>(
    method: M,
    params: PluginToHostParams[M],
    callOptions?: RpcOptions,
  ): AsyncIterable<PluginToHostStreamChunks[M]> => rpc.stream<PluginToHostStreamChunks[M]>(method, params, callOptions);

  const subscribeStream = <M extends PluginToHostStreamMethod>(
    method: M,
    params: PluginToHostParams[M],
    onChunk: (chunk: PluginToHostStreamChunks[M], subSignal: AbortSignal) => void | Promise<void>,
  ): Disposable => {
    const { controller, detach } = createChildController(signal);
    activeSubscriptions.add(controller);

    let resolveClosed!: () => void;
    let rejectClosed!: (error: unknown) => void;
    const closed = new Promise<void>((resolve, reject) => {
      resolveClosed = resolve;
      rejectClosed = reject;
    });
    // Prevent unhandledRejection crashes when callers ignore `sub.closed`,
    // while keeping `closed` rejected for callers that await or catch it.
    closed.catch(() => {});

    void (async () => {
      try {
        for await (const chunk of streamHost(method, params, {
          signal: controller.signal,
          timeoutMs: MAX_STREAM_TIMEOUT_MS,
        })) {
          if (controller.signal.aborted) break;
          await onChunk(chunk, controller.signal);
        }
        resolveClosed();
      } catch (error) {
        if (controller.signal.aborted) {
          resolveClosed();
        } else {
          console.warn(`[plugin-runtime] Stream subscription "${method}" failed:`, error);
          rejectClosed(error);
        }
      } finally {
        detach();
        activeSubscriptions.delete(controller);
      }
    })();

    return {
      closed,
      dispose() {
        controller.abort("disposed");
        detach();
        activeSubscriptions.delete(controller);
      },
    };
  };

  const unhandles: Array<() => void> = [];

  unhandles.push(
    rpc.handle(H.toolExecute, async (params, { signal: callSignal }) => {
      if (!isPlainRecord(params) || typeof params.name !== "string") {
        throw new PluginError("ERR_INVALID_ARGUMENT", "Invalid tool.execute payload");
      }
      const tool = registeredTools.get(params.name);
      if (!tool) {
        throw new PluginError("ERR_UNDECLARED", `Tool "${params.name}" is not registered`);
      }
      const args = isPlainRecord(params.args) ? params.args : {};
      const callId = typeof params.callId === "string" ? params.callId : "";
      const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
      const mode = params.mode === "code" ? "code" : "work";
      const caller =
        params.caller === "firefly"
        || (isPlainRecord(params.caller)
          && typeof params.caller.partnerId === "string"
          && typeof params.caller.partnerName === "string")
          ? (params.caller as RuntimeToolCall["caller"])
          : "firefly";

      const linked = linkSignals(signal, callSignal);
      try {
        const call: RuntimeToolCall = {
          callId,
          sessionId,
          mode,
          caller,
          signal: linked.signal,
          // Progress is advisory: fire-and-forget, and a host that ignores it cannot fail the tool.
          progress: (message, percent) => {
            if (typeof message !== "string" || linked.signal.aborted) return;
            const report = percent === undefined || !Number.isFinite(percent)
              ? { callId, message }
              : { callId, message, percent: Math.min(100, Math.max(0, percent)) };
            void callHost(P.toolsProgress, report, { signal: linked.signal }).catch(() => {});
          },
        };
        return await tool.execute(args, call);
      } finally {
        linked.cleanup();
      }
    }),
  );

  unhandles.push(
    rpc.handle(H.contextProvide, async (params, { signal: reqSignal }) => {
      if (!isPlainRecord(params) || typeof params.id !== "string") {
        throw new PluginError("ERR_INVALID_ARGUMENT", "Invalid context.provide payload");
      }
      const provider = registeredProviders.get(params.id);
      if (!provider) {
        throw new PluginError("ERR_UNDECLARED", `Context provider "${params.id}" is not registered`);
      }
      const turn = isPlainRecord(params.turn) ? params.turn : params;
      const sessionId = typeof turn.sessionId === "string" ? turn.sessionId : "";
      const mode = typeof turn.mode === "string" ? turn.mode : "work";
      const source = typeof turn.source === "string" ? turn.source : "user";

      const linked = linkSignals(signal, reqSignal);
      try {
        return await provider.provide({ sessionId, mode, source, signal: linked.signal });
      } finally {
        linked.cleanup();
      }
    }),
  );

  unhandles.push(
    rpc.handle(H.channelStart, async (params) => {
      if (!isPlainRecord(params) || typeof params.id !== "string") {
        throw new PluginError("ERR_INVALID_ARGUMENT", "Invalid channel.start payload");
      }
      const adapter = registeredChannels.get(params.id);
      if (!adapter) {
        throw new PluginError("ERR_UNDECLARED", `Channel "${params.id}" is not registered`);
      }
      channelAbortControllers.get(params.id)?.abort("restarted");
      const { controller, detach } = createChildController(signal);
      channelAbortControllers.set(params.id, controller);
      controller.signal.addEventListener("abort", detach, { once: true });

      await adapter.start(
        {
          reportState: (s) => {
            void callHost(P.channelsReportState, { id: adapter.id, state: s }, { signal }).catch(() => {});
          },
          deliver: (msg) =>
            callHost(
              P.channelsDeliver,
              { id: adapter.id, message: msg },
              { signal },
            ),
        },
        controller.signal,
      );
      return null;
    }),
  );

  unhandles.push(
    rpc.handle(H.channelStop, async (params) => {
      if (!isPlainRecord(params) || typeof params.id !== "string") {
        throw new PluginError("ERR_INVALID_ARGUMENT", "Invalid channel.stop payload");
      }
      const adapter = registeredChannels.get(params.id);
      if (!adapter) {
        throw new PluginError("ERR_UNDECLARED", `Channel "${params.id}" is not registered`);
      }
      channelAbortControllers.get(params.id)?.abort("stopped");
      channelAbortControllers.delete(params.id);
      await adapter.stop();
      return null;
    }),
  );

  unhandles.push(
    rpc.handle(H.channelSend, async (params, { signal: reqSignal }) => {
      if (!isPlainRecord(params) || typeof params.id !== "string") {
        throw new PluginError("ERR_INVALID_ARGUMENT", "Invalid channel.send payload");
      }
      const adapter = registeredChannels.get(params.id);
      if (!adapter) {
        throw new PluginError("ERR_UNDECLARED", `Channel "${params.id}" is not registered`);
      }
      const linked = linkSignals(signal, reqSignal);
      try {
        return await adapter.send(params.message as ProtocolOutboundMessage, linked.signal);
      } finally {
        linked.cleanup();
      }
    }),
  );

  unhandles.push(
    rpc.handle(H.uiMessage, async (params) => {
      if (!isPlainRecord(params) || !isPlainRecord(params.from) || typeof params.method !== "string") {
        throw new PluginError("ERR_INVALID_ARGUMENT", "Invalid ui.message payload");
      }
      if (!uiMessageHandler) {
        throw new PluginError("ERR_UNAVAILABLE", "No ui.onMessage handler registered");
      }
      return await uiMessageHandler({
        from: params.from as { kind: "window" | "settings"; id: string },
        method: params.method,
        params: params.params,
      });
    }),
  );

  const ctx: RuntimePluginContext = {
    id,
    version,
    dataDir,
    signal,
    has: (permission: string) => permissionSet.has(permission),

    tools: {
      register(tool) {
        registeredTools.set(tool.name, tool);
        trackRegistration(
          callHost(
            P.toolsRegister,
            {
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            },
            { signal },
          ),
        );
        let disposed = false;
        return {
          dispose() {
            if (disposed) return;
            disposed = true;
            if (registeredTools.get(tool.name) === tool) {
              registeredTools.delete(tool.name);
              void callHost(P.toolsUnregister, { name: tool.name }, { signal }).catch(() => {
                // Ignore unregister failure if the plugin is already deactivated or transport is closed.
              });
            }
          },
        };
      },
    },

    context: {
      register(provider) {
        registeredProviders.set(provider.id, provider);
        trackRegistration(
          callHost(
            P.contextRegister,
            {
              id: provider.id,
              modes: provider.modes,
              sources: provider.sources,
            },
            { signal },
          ),
        );
        let disposed = false;
        return {
          dispose() {
            if (disposed) return;
            disposed = true;
            if (registeredProviders.get(provider.id) === provider) {
              registeredProviders.delete(provider.id);
              void callHost(P.contextUnregister, { id: provider.id }, { signal }).catch(() => {
                // Ignore unregister failure if the plugin is already deactivated or transport is closed.
              });
            }
          },
        };
      },
    },

    channels: {
      register(adapter) {
        registeredChannels.set(adapter.id, adapter);
        trackRegistration(
          callHost(P.channelsRegister, { id: adapter.id }, { signal }),
        );
        return {
          dispose() {
            if (registeredChannels.get(adapter.id) === adapter) {
              // A started channel is stopped before its registration goes away; otherwise its
              // start() signal would never abort and channel.stop could no longer find it.
              const running = channelAbortControllers.get(adapter.id);
              if (running) {
                running.abort("disposed");
                channelAbortControllers.delete(adapter.id);
                void Promise.resolve().then(() => adapter.stop()).catch(() => {});
              }
              registeredChannels.delete(adapter.id);
            }
          },
        };
      },
    },

    model: {
      async generate(req) {
        const { signal: reqSignal, ...payload } = req;
        const linked = linkSignals(signal, reqSignal);
        try {
          // Model calls can legitimately run far past the RPC default; cancellation stays on the signal.
          return await callHost(P.modelGenerate, payload, { signal: linked.signal, timeoutMs: MAX_STREAM_TIMEOUT_MS });
        } finally {
          linked.cleanup();
        }
      },

      async *generateStream(req) {
        const { signal: reqSignal, ...payload } = req;
        const linked = linkSignals(signal, reqSignal);
        try {
          for await (const chunk of streamHost(P.modelGenerate, { ...payload, stream: true }, { signal: linked.signal, timeoutMs: MAX_STREAM_TIMEOUT_MS })) {
            yield chunk;
          }
        } finally {
          linked.cleanup();
        }
      },

      run(req) {
        const { signal: reqSignal, ...payload } = req;
        const linked = linkSignals(signal, reqSignal);
        const bufferedEvents: ProtocolRunEvent[] = [];
        let streamDone = false;
        let streamError: unknown;
        let wakeConsumer: (() => void) | undefined;

        let resolveResult!: (value: ProtocolModelRunResult) => void;
        let rejectResult!: (err: unknown) => void;
        const resultPromise = new Promise<ProtocolModelRunResult>((resolve, reject) => {
          resolveResult = resolve;
          rejectResult = reject;
        });
        resultPromise.catch(() => {});

        void (async () => {
          let settledResult = false;
          let lastRunId = "";
          let lastSessionId = payload.sessionId ?? "";
          try {
            for await (const chunk of streamHost(P.modelRun, payload, {
              signal: linked.signal,
              timeoutMs: MAX_STREAM_TIMEOUT_MS,
            })) {
              if (isPlainRecord(chunk) && chunk.type === "run.result" && "result" in chunk) {
                settledResult = true;
                resolveResult(chunk.result);
                continue;
              }
              if (isPlainRecord(chunk)) {
                if ("runId" in chunk && typeof chunk.runId === "string") lastRunId = chunk.runId;
                if ("sessionId" in chunk && typeof chunk.sessionId === "string") lastSessionId = chunk.sessionId;
              }
              bufferedEvents.push(chunk);
              wakeConsumer?.();
            }
            if (!settledResult) {
              settledResult = true;
              resolveResult({ runId: lastRunId, sessionId: lastSessionId, reply: "" });
            }
          } catch (error) {
            streamError = error;
            if (!settledResult) {
              settledResult = true;
              rejectResult(error);
            }
          } finally {
            streamDone = true;
            wakeConsumer?.();
            linked.cleanup();
          }
        })();

        const events: AsyncIterable<ProtocolRunEvent> = {
          async *[Symbol.asyncIterator]() {
            while (!streamDone || bufferedEvents.length > 0) {
              if (bufferedEvents.length > 0) {
                yield bufferedEvents.shift()!;
              } else if (!streamDone) {
                await new Promise<void>((resolve) => {
                  wakeConsumer = resolve;
                });
                wakeConsumer = undefined;
              }
            }
            if (streamError !== undefined) {
              throw streamError;
            }
          },
        };

        return { events, result: resultPromise };
      },
    },

    events: {
      on(type, fn) {
        return subscribeStream(P.eventsSubscribe, { type }, (chunk) => {
          fn(chunk);
        });
      },
    },

    sessions: {
      list: (o) => callHost(P.sessionsList, o ?? {}, { signal }),
      messages: (sessionId, o) => callHost(P.sessionsMessages, { sessionId, ...(o ?? {}) }, { signal }),
    },

    workspace: {
      current: (sessionId) =>
        callHost(P.workspaceInfo, sessionId !== undefined ? { sessionId } : {}, { signal }),
      onChange(fn) {
        return subscribeStream(P.workspaceWatch, {}, (chunk) => {
          fn(chunk);
        });
      },
    },

    schedules: {
      propose: (spec) => callHost(P.schedulesPropose, spec, { signal }),
      update: (taskId, patch) => callHost(P.schedulesUpdate, { taskId, patch }, { signal }),
      remove: (taskId) => callHost(P.schedulesRemove, { taskId }, { signal }),
      list: () => callHost(P.schedulesList, {}, { signal }),
      onTrigger(fn) {
        return subscribeStream(P.schedulesOnTrigger, {}, async (chunk, subSignal) => {
          const event: Record<string, unknown> = isPlainRecord(chunk) ? chunk : {};
          await fn({
            taskId: typeof event.taskId === "string" ? event.taskId : "",
            payload: event.payload,
            signal: subSignal,
          });
        });
      },
    },

    secrets: {
      set: (key, value) => callHost(P.secretsSet, { key, value }, { signal }),
      get: (key) => callHost(P.secretsGet, { key }, { signal }),
      delete: (key) => callHost(P.secretsDelete, { key }, { signal }),
      keys: () => callHost(P.secretsKeys, {}, { signal }),
    },

    ui: {
      async openWindow(windowId, state) {
        await callHost(P.uiOpenWindow, { id: windowId, state }, { signal });
        return {
          close: async () => {
            await callHost(P.uiCloseWindow, { id: windowId }, { signal });
          },
          post: async (msg) => {
            await callHost(P.uiPost, { to: { kind: "window", id: windowId }, msg }, { signal });
          },
        };
      },
      onMessage(fn) {
        uiMessageHandler = fn;
        const sub = subscribeStream(P.uiOnMessage, {}, async (chunk) => {
          if (!isPlainRecord(chunk) || !isPlainRecord(chunk.from) || typeof chunk.method !== "string") {
            return;
          }
          await fn({
            from: chunk.from as { kind: "window" | "settings"; id: string },
            method: chunk.method,
            params: chunk.params,
          });
        });
        return {
          closed: sub.closed,
          dispose() {
            if (uiMessageHandler === fn) {
              uiMessageHandler = undefined;
            }
            sub.dispose();
          },
        };
      },
      async post(to, msg) {
        await callHost(P.uiPost, { to, msg }, { signal });
      },
    },
  };

  return {
    ctx,
    async awaitPendingRegistrations() {
      if (pendingRegistrations.size === 0) return;
      await Promise.all([...pendingRegistrations]);
    },
    dispose() {
      for (const unhandle of unhandles.splice(0)) {
        unhandle();
      }
      for (const controller of activeSubscriptions) {
        controller.abort("disposed");
      }
      activeSubscriptions.clear();
      for (const controller of channelAbortControllers.values()) {
        controller.abort("disposed");
      }
      channelAbortControllers.clear();
      registeredTools.clear();
      registeredProviders.clear();
      registeredChannels.clear();
      uiMessageHandler = undefined;
    },
  };
}
