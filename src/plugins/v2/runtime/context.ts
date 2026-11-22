import {
  HOST_TO_PLUGIN_METHODS as H,
  PLUGIN_TO_HOST_METHODS as P,
  PluginError,
} from "../../../shared/plugin-protocol";
import type { PluginRpc } from "../../../shared/plugin-rpc";

/** Max 32-bit signed timeout accepted by setTimeout / createRpcEndpoint (~24.8 days). */
const MAX_STREAM_TIMEOUT_MS = 2_147_483_647;

export interface Disposable {
  dispose(): void;
}

export interface RuntimeToolCall {
  readonly callId: string;
  readonly sessionId: string;
  readonly mode: "work" | "code";
  readonly caller: "firefly" | { partnerId: string; partnerName: string };
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
  modes: string[];
  sources: string[];
  provide(req: { sessionId: string; mode: string; source: string; signal: AbortSignal }): Promise<unknown>;
}

export interface RuntimeChannelAdapter {
  id: string;
  start(
    host: {
      reportState(s: { state: "disconnected" | "connecting" | "connected" | "error"; detail?: string }): void;
      deliver(msg: unknown): Promise<{ accepted: boolean; sessionId?: string }>;
    },
    signal: AbortSignal,
  ): Promise<void>;
  stop(): Promise<void>;
  send(msg: unknown, signal: AbortSignal): Promise<{ externalMessageId: string }>;
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
    }): Promise<unknown>;
    generateStream(req: {
      prompt: string;
      system?: string;
      maxOutputTokens?: number;
      schema?: Record<string, unknown>;
      signal?: AbortSignal;
    }): AsyncIterable<unknown>;
    run(req: {
      objective: string;
      mode: string;
      sessionId?: string;
      allowPartners?: boolean;
      signal?: AbortSignal;
    }): { events: AsyncIterable<unknown>; result: Promise<unknown> };
  };
  readonly events: {
    on(type: string, fn: (event: unknown) => void): Disposable;
  };
  readonly sessions: {
    list(o?: { cursor?: string; limit?: number; mode?: string }): Promise<unknown>;
    messages(sessionId: string, o?: { cursor?: string; limit?: number }): Promise<unknown>;
  };
  readonly workspace: {
    current(sessionId?: string): Promise<unknown>;
    onChange(fn: (info: unknown) => void): Disposable;
  };
  readonly schedules: {
    propose(spec: unknown): Promise<unknown>;
    update(taskId: string, patch: unknown): Promise<unknown>;
    remove(taskId: string): Promise<boolean>;
    list(): Promise<unknown[]>;
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
    onMessage(
      fn: (e: { from: { kind: "window" | "settings"; id: string }; method: string; params: unknown }) => Promise<unknown>,
    ): Disposable;
    post(to: { kind: "window" | "settings"; id: string }, msg: unknown): Promise<void>;
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
    const tracked = promise.finally(() => {
      pendingRegistrations.delete(tracked);
    });
    // Prevent unhandled rejection before H.activate awaits pendingRegistrations.
    tracked.catch(() => {});
    pendingRegistrations.add(tracked);
  };

  const subscribeStream = (
    method: string,
    params: unknown,
    onChunk: (chunk: unknown, subSignal: AbortSignal) => void | Promise<void>,
  ): Disposable => {
    const { controller, detach } = createChildController(signal);
    activeSubscriptions.add(controller);

    void (async () => {
      try {
        for await (const chunk of rpc.stream(method, params, {
          signal: controller.signal,
          timeoutMs: MAX_STREAM_TIMEOUT_MS,
        })) {
          if (controller.signal.aborted) break;
          await onChunk(chunk, controller.signal);
        }
      } catch {
        // Subscription ended via cancel, deactivation, or host refusal.
      } finally {
        detach();
        activeSubscriptions.delete(controller);
      }
    })();

    return {
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
          progress: () => {},
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
            void rpc.call(P.channelsReportState, { id: adapter.id, state: s }, { signal }).catch(() => {});
          },
          deliver: (msg) =>
            rpc.call<{ accepted: boolean; sessionId?: string }>(
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
        return await adapter.send(params.message, linked.signal);
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
          rpc.call(
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
              void rpc.call(P.toolsUnregister, { name: tool.name }, { signal }).catch(() => {
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
          rpc.call(
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
              void rpc.call(P.contextUnregister, { id: provider.id }, { signal }).catch(() => {
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
          rpc.call(P.channelsRegister, { id: adapter.id }, { signal }),
        );
        return {
          dispose() {
            if (registeredChannels.get(adapter.id) === adapter) {
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
          return await rpc.call(P.modelGenerate, payload, { signal: linked.signal });
        } finally {
          linked.cleanup();
        }
      },

      async *generateStream(req) {
        const { signal: reqSignal, ...payload } = req;
        const linked = linkSignals(signal, reqSignal);
        try {
          for await (const chunk of rpc.stream(P.modelGenerate, { ...payload, stream: true }, { signal: linked.signal })) {
            yield chunk;
          }
        } finally {
          linked.cleanup();
        }
      },

      run(req) {
        const { signal: reqSignal, ...payload } = req;
        const linked = linkSignals(signal, reqSignal);
        const bufferedEvents: unknown[] = [];
        let streamDone = false;
        let streamError: unknown;
        let wakeConsumer: (() => void) | undefined;

        let resolveResult!: (value: unknown) => void;
        let rejectResult!: (err: unknown) => void;
        const resultPromise = new Promise<unknown>((resolve, reject) => {
          resolveResult = resolve;
          rejectResult = reject;
        });
        resultPromise.catch(() => {});

        void (async () => {
          let settledResult = false;
          let lastRunId = "";
          let lastSessionId = payload.sessionId ?? "";
          try {
            for await (const chunk of rpc.stream(P.modelRun, payload, {
              signal: linked.signal,
              timeoutMs: MAX_STREAM_TIMEOUT_MS,
            })) {
              if (isPlainRecord(chunk) && chunk.type === "run.result" && "result" in chunk) {
                settledResult = true;
                resolveResult(chunk.result);
                continue;
              }
              if (isPlainRecord(chunk)) {
                if (typeof chunk.runId === "string") lastRunId = chunk.runId;
                if (typeof chunk.sessionId === "string") lastSessionId = chunk.sessionId;
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

        const events: AsyncIterable<unknown> = {
          async *[Symbol.asyncIterator]() {
            while (!streamDone || bufferedEvents.length > 0) {
              if (bufferedEvents.length > 0) {
                yield bufferedEvents.shift();
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
      list: (o) => rpc.call(P.sessionsList, o ?? {}, { signal }),
      messages: (sessionId, o) => rpc.call(P.sessionsMessages, { sessionId, ...(o ?? {}) }, { signal }),
    },

    workspace: {
      current: (sessionId) =>
        rpc.call(P.workspaceInfo, sessionId !== undefined ? { sessionId } : {}, { signal }),
      onChange(fn) {
        return subscribeStream(P.workspaceWatch, {}, (chunk) => {
          fn(chunk);
        });
      },
    },

    schedules: {
      propose: (spec) => rpc.call(P.schedulesPropose, spec, { signal }),
      update: (taskId, patch) => rpc.call(P.schedulesUpdate, { taskId, patch }, { signal }),
      remove: (taskId) => rpc.call<boolean>(P.schedulesRemove, { taskId }, { signal }),
      list: () => rpc.call<unknown[]>(P.schedulesList, {}, { signal }),
      onTrigger(fn) {
        return subscribeStream(P.schedulesOnTrigger, {}, async (chunk, subSignal) => {
          const event = isPlainRecord(chunk) ? chunk : {};
          await fn({
            taskId: typeof event.taskId === "string" ? event.taskId : "",
            payload: event.payload,
            signal: subSignal,
          });
        });
      },
    },

    secrets: {
      set: (key, value) => rpc.call<void>(P.secretsSet, { key, value }, { signal }),
      get: (key) => rpc.call<string | null>(P.secretsGet, { key }, { signal }),
      delete: (key) => rpc.call<boolean>(P.secretsDelete, { key }, { signal }),
      keys: () => rpc.call<string[]>(P.secretsKeys, {}, { signal }),
    },

    ui: {
      async openWindow(windowId, state) {
        await rpc.call(P.uiOpenWindow, { id: windowId, state }, { signal });
        return {
          close: async () => {
            await rpc.call(P.uiCloseWindow, { id: windowId }, { signal });
          },
          post: async (msg) => {
            await rpc.call(P.uiPost, { to: { kind: "window", id: windowId }, msg }, { signal });
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
          dispose() {
            if (uiMessageHandler === fn) {
              uiMessageHandler = undefined;
            }
            sub.dispose();
          },
        };
      },
      async post(to, msg) {
        await rpc.call(P.uiPost, { to, msg }, { signal });
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
