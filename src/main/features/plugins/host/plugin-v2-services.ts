import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { BaseEvent } from "@ag-ui/core";
import { within } from "../../../base/identity/runtime-profile";
import { isAbortError } from "../../../base/utils/abort-utils";
import { logger, LogTag } from "../../../base/logging/logger";
import { runWithUsageAttribution } from "../../../base/storage/usage-attribution";
import { recordRequest, recordUsage } from "../../../base/storage/token-usage-store";
import { resolveModelSettingsProfile, type ModelSettings } from "../../../model/config/model-settings";
import { createSseReader, getAdapterForConfig } from "../../../model/providers";
import { vendorConfigFromSettings } from "../../../model/providers/vendor-config";
import { createVisibleStreamFilter } from "../../../model/text/chat-stream-utils";
import type { LlmClient } from "../../../agent/services/llm/llm-client";
import { FireflyAgent } from "../../../agent/runtime/firefly-agent";
import type { BuildOptionsFn } from "../../../agent/runtime/run-input-types";
import { cancelPendingApprovalsForRun } from "../../../platform/permission/permission";
import type { ToolRegistry } from "../../../tooling/registry/tool-registry";
import type { ChatSession, ChatSessionMeta, ConversationMode } from "../../../../shared/chat-types";
import type { PluginManifestV1, PluginRunSource } from "../../../../shared/plugin-manifest";
import {
  PluginError,
  type ProtocolHostEvent,
  type ProtocolRunEvent,
  type ProtocolToolResult,
} from "../../../../shared/plugin-protocol";
import type { ToolCallOutcome } from "../../../../shared/tool-call-outcome";
import type { PluginRpc } from "../../../../shared/plugin-rpc";
import { createPluginContextService, type PluginContextService } from "../../../../plugins/v2/context";
import {
  createElectronPluginHost,
  PluginHostManager,
  type HostDependencies,
  type PluginHostStatus,
  type StopReason,
} from "../../../../plugins/v2/host";
import {
  bindPluginScheduleRpc,
  createPluginScheduleService,
  type PluginScheduleService,
  type PluginSchedulerStorePort,
} from "../../../../plugins/v2/schedules";
import {
  bindPluginSecretsRpc,
  createPluginSecretsService,
  type PluginSecretsService,
  type SafeStorageLike,
} from "../../../../plugins/v2/secrets";
import {
  createPluginHostServices,
  type PublicMessage,
  type PublicSession,
  type ServiceContext,
  type ServicePermission,
} from "../../../../plugins/v2/services";
import {
  createPluginStateStore,
  type PluginStateStore,
  type StoredPluginState,
} from "../../../../plugins/v2/state";
import {
  createPluginToolService,
  type PluginToolProgressEvent,
  type PluginToolService,
} from "../../../../plugins/v2/tools";
import {
  createPluginStreamRedactor,
  redactPluginText,
  type RedactionSettingsSource,
} from "./plugin-v2-redaction";

export interface PluginV2ConfirmRequest {
  id: string;
  pluginId: string;
  pluginName: string;
  permission: "sessions.read" | "workspace.read" | "model.run";
}

export interface PluginV2BorrowingEntry {
  id: string;
  pluginId: string;
  pluginName: string;
}

export interface PluginV2HostDependencies {
  dataRoot: string;
  stateFile?: string;
  scheduleStateFile?: string;
  runtimeEntry?: string;
  toolRegistry?: ToolRegistry;
  safeStorage?: SafeStorageLike | null;
  schedulerStore: PluginSchedulerStorePort;
  llmClient: Pick<LlmClient, "chatNonStream">;
  buildRunOptions: BuildOptionsFn;
  loadModelSettings: () => ModelSettings;
  loadGeneralSettings: () => Record<string, unknown>;
  protectedRoots?: readonly string[];
  listSessions: () => ChatSessionMeta[];
  getSession: (sessionId: string) => ChatSession | null;
  getActiveChatTarget: () => { sessionId: string; mode: ConversationMode } | null;
  onActiveTargetInvalidated?: (listener: () => void) => () => void;
  onWorkspaceBindingChanged?: (listener: (sessionId: string) => void) => () => void;
  confirmFirstUse: (request: {
    pluginId: string;
    pluginName: string;
    permission: ServicePermission;
    signal: AbortSignal;
  }) => Promise<boolean>;
  onBorrowingChanged?: (entries: PluginV2BorrowingEntry[]) => void;
  onToolProgress?: (event: PluginToolProgressEvent) => void;
  createHostManager?: (deps: HostDependencies) => PluginHostManager;
}

const LOCAL_NO_AUTH_SENTINEL = "__FIREFLY_LOCAL_NO_AUTH__";
const GENERATE_TIMEOUT_MS = 120_000;

function resolveDefaultRuntimeEntry(): string {
  const packaged = path.join(__dirname, "..", "..", "..", "..", "plugins", "v2", "runtime", "main.js");
  if (fs.existsSync(packaged)) return packaged;
  return path.resolve(process.cwd(), "dist", "main", "plugins", "v2", "runtime", "main.js");
}

function isModelProfileUsable(profile: ModelSettings | undefined): profile is ModelSettings {
  if (!profile) return false;
  if (typeof profile.model !== "string" || profile.model.trim().length === 0) return false;
  if (typeof profile.baseUrl !== "string" || profile.baseUrl.trim().length === 0) return false;
  const apiKey = typeof profile.apiKey === "string" ? profile.apiKey.trim() : "";
  return apiKey.length > 0 || apiKey === LOCAL_NO_AUTH_SENTINEL;
}

function buildGenerateMessages(request: { prompt: string; system?: string }): Array<{ role: "system" | "user"; content: string }> {
  const messages: Array<{ role: "system" | "user"; content: string }> = [];
  if (request.system) messages.push({ role: "system", content: request.system });
  messages.push({ role: "user", content: request.prompt });
  return messages;
}

function resolveGenerateTimeoutMs(profile: ModelSettings): number {
  return Math.max(1_000, Math.min(GENERATE_TIMEOUT_MS, (profile.chatRequestTimeoutSec || 120) * 1000));
}

function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** The agent loop's tool outcome → the plugin protocol's four tool states. */
const PLUGIN_TOOL_STATUS = {
  success: "succeeded",
  failure: "failed",
  unknown: "unknown",
  not_executed: "not_executed",
} as const satisfies Record<ToolCallOutcome, ProtocolToolResult["status"]>;

export function mapPluginModelRunOutcome(status: string | undefined): "completed" | "cancelled" | "failed" {
  if (status === "success") return "completed";
  if (status === "cancelled") return "cancelled";
  return "failed";
}

export function createPluginV2HostController(deps: PluginV2HostDependencies) {
  const stateStore: PluginStateStore = createPluginStateStore({
    ...(deps.stateFile ? { stateFile: deps.stateFile } : {}),
  });

  const runtimeEntry = deps.runtimeEntry ?? resolveDefaultRuntimeEntry();
  const redactionSource: RedactionSettingsSource = {
    loadModelSettings: deps.loadModelSettings,
    loadGeneralSettings: deps.loadGeneralSettings,
    protectedRoots: [...(deps.protectedRoots ?? []), deps.dataRoot],
  };

  let contextRevision = 1;
  const accessListeners = new Map<string, Set<() => void>>();
  const workspaceWatchers = new Set<() => void>();
  const hostEventListeners = new Set<(event: unknown) => void>();
  const borrowingMap = new Map<string, { id: string; pluginId: string; pluginName: string; cancel: () => void }>();
  const startedPluginIds = new Set<string>();
  let hostManagerRef: PluginHostManager | undefined;

  const notifyBorrowing = (): void => {
    const snapshot: PluginV2BorrowingEntry[] = [...borrowingMap.values()].map(({ id, pluginId, pluginName }) => ({
      id,
      pluginId,
      pluginName,
    }));
    deps.onBorrowingChanged?.(snapshot);
  };

  const notifyAccessFor = (pluginId: string): void => {
    const listeners = accessListeners.get(pluginId);
    if (!listeners) return;
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* Listener failure is isolated. */ }
    }
  };

  const notifyAllContextChanged = (): void => {
    contextRevision += 1;
    for (const pluginId of [...accessListeners.keys()]) {
      notifyAccessFor(pluginId);
    }
    for (const watcher of [...workspaceWatchers]) {
      try { watcher(); } catch { /* Watcher failure is isolated. */ }
    }
  };

  const unsubState = stateStore.onChange((pluginId) => {
    notifyAccessFor(pluginId);
  });
  const unsubTarget = deps.onActiveTargetInvalidated?.(() => notifyAllContextChanged());
  const unsubWorkspace = deps.onWorkspaceBindingChanged?.((sessionId) => {
    const active = deps.getActiveChatTarget();
    if (!active || active.sessionId === sessionId) {
      notifyAllContextChanged();
    }
  });

  const secretsService: PluginSecretsService = createPluginSecretsService({
    safeStorage: deps.safeStorage,
    dataRoot: deps.dataRoot,
  });

  const scheduleService: PluginScheduleService = createPluginScheduleService({
    store: deps.schedulerStore,
    stateFile: deps.scheduleStateFile ?? path.join(deps.dataRoot, "plugin-schedules-state.json"),
  });

  const contextService: PluginContextService = createPluginContextService();

  const toolService: PluginToolService = createPluginToolService({
    ...(deps.toolRegistry ? { registry: deps.toolRegistry } : {}),
    canExecute: (pluginId, toolName) => stateStore.isToolGranted(pluginId, toolName),
    onProgress: deps.onToolProgress,
  });

  const hostAdapter = {
    call: async <T = unknown>(id: string, method: string, params: unknown, opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<T> => {
      if (!hostManagerRef) {
        throw new PluginError("ERR_UNAVAILABLE", "Plugin host manager is not initialized");
      }
      return await hostManagerRef.call<T>(id, method, params, opts) as T;
    },
  };

  const resolveContext = (): ServiceContext | null => {
    const active = deps.getActiveChatTarget();
    if (!active) return null;
    const session = deps.getSession(active.sessionId);
    if (!session) return null;
    return {
      sessionId: session.id,
      mode: session.mode ?? active.mode,
      workspaceRoot: session.workspaceBinding?.workspaceRoot ?? null,
      workspaceName: session.workspaceBinding?.displayName ?? null,
      revision: contextRevision,
    };
  };

  // Single lifetime instance: restarts must not reset sliding-window model quota.
  const hostServices = createPluginHostServices({
    access(pluginId) {
      const stored = stateStore.get(pluginId);
      if (!stored) return null;
      return {
        name: stored.manifest.name,
        declared: stored.manifest.permissions ?? [],
        granted: new Set(stored.enabled ? stored.grantedPermissions : []),
        revision: stored.revision,
      };
    },
    context() {
      return resolveContext();
    },
    onAccessChange(pluginId, listener) {
      let set = accessListeners.get(pluginId);
      if (!set) {
        set = new Set();
        accessListeners.set(pluginId, set);
      }
      set.add(listener);
      return () => {
        set?.delete(listener);
        if (set && set.size === 0) accessListeners.delete(pluginId);
      };
    },
    confirmations: stateStore.confirmations,
    confirm: deps.confirmFirstUse,
    async currentModel() {
      const profile = resolveModelSettingsProfile(deps.loadModelSettings());
      return isModelProfileUsable(profile) ? profile : null;
    },
    async generate(request, profileObj, signal) {
      const profile = profileObj as ModelSettings;
      const timeoutMs = resolveGenerateTimeoutMs(profile);
      const messages = buildGenerateMessages(request);
      try {
        const response = await runWithUsageAttribution({ feature: "plugin" }, () =>
          deps.llmClient.chatNonStream(
            profile,
            messages,
            undefined,
            timeoutMs,
            "plugin:v2:generate",
            undefined,
            {
              ...(request.maxOutputTokens !== undefined ? { maxTokens: request.maxOutputTokens } : {}),
              ...(request.schema !== undefined
                ? { structuredOutput: { mode: "json_schema" as const, name: "plugin_output", schema: request.schema, strict: false } }
                : {}),
            },
            signal,
          ),
        );
        return { text: response.text ?? "" };
      } catch (error) {
        if (isAbortError(error) || signal.aborted) {
          throw new PluginError("ERR_CANCELLED", "Model generate cancelled", { cause: error });
        }
        throw new PluginError("ERR_UNAVAILABLE", "Model generation failed", true, error);
      }
    },
    async *generateStream(request, profileObj, signal) {
      if (signal.aborted) {
        throw new PluginError("ERR_CANCELLED", "Model stream cancelled");
      }
      const profile = profileObj as ModelSettings;
      const timeoutMs = resolveGenerateTimeoutMs(profile);
      const vendor = vendorConfigFromSettings(profile);
      const protocol = getAdapterForConfig(vendor);
      const built = protocol.buildStreamRequest({
        model: vendor.model,
        messages: buildGenerateMessages(request),
        stream: true,
        ...(request.maxOutputTokens !== undefined ? { maxTokens: request.maxOutputTokens } : {}),
        ...(request.schema !== undefined
          ? { structuredOutput: { mode: "json_schema" as const, name: "plugin_output", schema: request.schema, strict: false } }
          : {}),
      }, vendor);

      const streamController = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        streamController.abort();
      }, timeoutMs);
      const onCallerAbort = () => streamController.abort();
      signal.addEventListener("abort", onCallerAbort, { once: true });

      let iterator: AsyncIterator<unknown> | undefined;
      try {
        const reply = await raceWithSignal(
          runWithUsageAttribution({ feature: "plugin" }, () =>
            fetch(built.url, {
              method: "POST",
              signal: streamController.signal,
              headers: built.headers,
              body: built.body,
            }),
          ),
          streamController.signal,
        );
        if (!reply.ok || !reply.body) {
          throw new PluginError("ERR_UNAVAILABLE", `Model stream failed: HTTP ${reply.status}`, true);
        }
        recordRequest(profile.model);
        const visibility = createVisibleStreamFilter();
        let hasMetering = false;
        let inputPeak = 0;
        let outputPeak = 0;
        let cachePeak: number | undefined;
        let cacheWritePeak: number | undefined;

        const sseIterator = createSseReader(protocol, reply.body)[Symbol.asyncIterator]();
        iterator = sseIterator;
        for (;;) {
          if (timedOut) {
            throw new PluginError("ERR_TIMEOUT", "Model stream timed out", true);
          }
          if (signal.aborted) {
            throw new PluginError("ERR_CANCELLED", "Model stream cancelled");
          }
          const step = await raceWithSignal(sseIterator.next(), streamController.signal);
          if (step.done) break;
          const delta = protocol.parseStreamEvent(step.value);
          if (!delta) continue;
          if (delta.error) {
            // The provider failed after HTTP 200. Its message can carry upstream details, so it never reaches the plugin.
            throw new PluginError("ERR_UNAVAILABLE", "Model provider reported an error mid-stream", true);
          }
          if (delta.deltaText) {
            const visible = visibility.push(delta.deltaText);
            if (visible) yield { delta: visible };
          }
          if (delta.usage) {
            hasMetering = true;
            inputPeak = Math.max(inputPeak, delta.usage.input ?? 0);
            outputPeak = Math.max(outputPeak, delta.usage.output ?? 0);
            if (delta.usage.cachedInput !== undefined) cachePeak = Math.max(cachePeak ?? 0, delta.usage.cachedInput);
            if (delta.usage.cacheCreation !== undefined) cacheWritePeak = Math.max(cacheWritePeak ?? 0, delta.usage.cacheCreation);
          }
          if (delta.done) break;
        }
        if (timedOut) {
          throw new PluginError("ERR_TIMEOUT", "Model stream timed out", true);
        }
        if (signal.aborted) {
          throw new PluginError("ERR_CANCELLED", "Model stream cancelled");
        }
        if (hasMetering) {
          void runWithUsageAttribution({ feature: "plugin" }, () => {
            recordUsage(inputPeak, outputPeak, 1, cachePeak, profile.model, cacheWritePeak);
          });
        }
        const tail = visibility.flush();
        if (tail) yield { delta: tail };
      } catch (error) {
        if (error instanceof PluginError) throw error;
        if (timedOut) {
          throw new PluginError("ERR_TIMEOUT", "Model stream timed out", true, error);
        }
        if (signal.aborted || isAbortError(error)) {
          throw new PluginError("ERR_CANCELLED", "Model stream cancelled", { cause: error });
        }
        throw new PluginError("ERR_UNAVAILABLE", "Model stream failed", true, error);
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", onCallerAbort);
        await iterator?.return?.().catch(() => {});
      }
    },
    watchWorkspace(_pluginId, listener) {
      workspaceWatchers.add(listener);
      return () => { workspaceWatchers.delete(listener); };
    },
    async run(request, _profile, signal, onEvent) {
      if (signal.aborted) {
        throw new PluginError("ERR_CANCELLED", "Plugin model run cancelled");
      }
      const runId = `plugin-run-${randomUUID()}`;
      const built = await deps.buildRunOptions({
        sessionId: request.sessionId,
        workspaceBindingSessionId: request.sessionId,
        mode: request.mode,
        executionMode: request.mode === "chat" ? "chat" : "work",
        promptSource: "plugin-agent",
        messages: [{ role: "user", content: request.objective }],
      });
      if (signal.aborted) {
        throw new PluginError("ERR_CANCELLED", "Plugin model run cancelled");
      }
      // A plugin run is not a desktop user turn: it never opens the desktop memory run (that needs the session's
      // run admission and a transcript sink bound to this run id), like scheduled tasks.
      const { openMemoryRun: _openMemoryRun, controlledResponses: _controlledResponses, ...buildable } = built.options;
      const runOptions = {
        ...buildable,
        runId,
        signal,
        // buildRunOptions does not set the conversation mode (the desktop bridge and scheduler add it themselves);
        // without it partner delegation and the code-mode plan path never switch on.
        conversationMode: request.mode,
        executionMode: request.mode === "chat" ? "chat" as const : "work" as const,
        // The run keeps the real session id, so attribute usage to the plugin explicitly.
        usagePluginId: request.pluginId,
        interactiveTools: false,
        // Plugin runs are not registered with the desktop run bridge, so no one could answer an approval card:
        // actions that need approval are refused at once instead of waiting until cancel or timeout.
        approvals: "refuse" as const,
        allowDelegation: request.allowPartners === true,
        ...(request.allowPartners ? {} : {
          tools: (built.options.tools ?? []).filter((tool) => tool.id !== "delegate_agent"),
        }),
      };
      const agent = new FireflyAgent({
        threadId: `plugin-${request.pluginId}-${runId}`,
        description: `插件 ${request.pluginName} 运行`,
      });
      const toolNames = new Map<string, string>();
      let streamedReply = "";

      return new Promise((resolve, reject) => {
        let settled = false;
        let sub: { unsubscribe(): void } | undefined;
        const onAbort = () => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          sub?.unsubscribe();
          cancelPendingApprovalsForRun(runId);
          reject(new PluginError("ERR_CANCELLED", "Plugin model run cancelled"));
        };
        signal.addEventListener("abort", onAbort, { once: true });

        // tool.completed comes from the loop's own outcome: the AG-UI TOOL_CALL_RESULT folds `unknown` and
        // `not_executed` into "failed", and a plugin needs to tell "never ran" from "may have had effects".
        const onToolFinished: NonNullable<typeof runOptions.onToolFinished> = (finished) => {
          onEvent({
            type: "tool.completed",
            callId: finished.toolCallId,
            tool: toolNames.get(finished.toolCallId) ?? finished.toolId,
            status: PLUGIN_TOOL_STATUS[finished.status],
          });
        };
        sub = agent.runWithEvents({ ...runOptions, onToolFinished }).subscribe({
          next(packet: BaseEvent) {
            try {
              switch (packet.type) {
                case "RUN_STARTED":
                  onEvent({
                    type: "run.started",
                    runId,
                    sessionId: request.sessionId,
                    mode: request.mode,
                    at: Date.now(),
                  } satisfies ProtocolRunEvent);
                  break;
                case "TEXT_MESSAGE_CONTENT": {
                  const delta = (packet as { delta?: unknown }).delta;
                  if (typeof delta === "string" && delta.length > 0) {
                    streamedReply += delta;
                    onEvent({ type: "text.delta", delta });
                  }
                  break;
                }
                case "TOOL_CALL_START": {
                  const ev = packet as { toolCallId?: string; toolCallName?: string };
                  if (ev.toolCallId && ev.toolCallName) {
                    toolNames.set(ev.toolCallId, ev.toolCallName);
                    onEvent({ type: "tool.started", callId: ev.toolCallId, tool: ev.toolCallName });
                  }
                  break;
                }
                case "RUN_FINISHED": {
                  const status = (packet as { result?: { status?: string } }).result?.status;
                  onEvent({
                    type: "run.ended",
                    runId,
                    sessionId: request.sessionId,
                    outcome: mapPluginModelRunOutcome(status),
                    at: Date.now(),
                  });
                  break;
                }
              }
            } catch {
              // Event projection failure is isolated; host services handles stream errors.
            }
          },
          error(failure) {
            if (settled) return;
            settled = true;
            signal.removeEventListener("abort", onAbort);
            cancelPendingApprovalsForRun(runId);
            reject(failure);
          },
          complete() {
            if (settled) return;
            settled = true;
            signal.removeEventListener("abort", onAbort);
            cancelPendingApprovalsForRun(runId);
            resolve({
              runId,
              sessionId: request.sessionId,
              reply: agent.lastResult?.reply ?? streamedReply,
            });
          },
        });
        if (signal.aborted && !settled) {
          onAbort();
        }
      });
    },
    borrowing(request) {
      const borrowId = randomUUID();
      borrowingMap.set(borrowId, {
        id: borrowId,
        pluginId: request.pluginId,
        pluginName: request.pluginName,
        cancel: request.cancel,
      });
      notifyBorrowing();
      return () => {
        if (borrowingMap.delete(borrowId)) {
          notifyBorrowing();
        }
      };
    },
    async sessions(_context) {
      return deps.listSessions().map((meta): PublicSession => ({
        id: meta.id,
        mode: meta.mode,
        title: meta.title,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        workspaceRoot: meta.workspaceRoot ?? null,
      }));
    },
    async messages(sessionId) {
      const session = deps.getSession(sessionId);
      if (!session) return [];
      const projected: PublicMessage[] = [];
      for (const msg of session.messages) {
        if (msg.role !== "user" && msg.role !== "model") continue;
        projected.push({
          id: msg.id,
          role: msg.role === "model" ? "assistant" : "user",
          text: msg.content,
          at: msg.at,
        });
      }
      return projected;
    },
    redact(text, context) {
      return redactPluginText(text, context, redactionSource);
    },
    createStreamRedactor(context) {
      return createPluginStreamRedactor(context, redactionSource);
    },
    subscribe(listener) {
      hostEventListeners.add(listener);
      return () => { hostEventListeners.delete(listener); };
    },
    modelLimitPerMinute(pluginId) {
      return stateStore.getModelRateLimit(pluginId);
    },
  });

  const configureRpc = (id: string, rpc: PluginRpc): (() => void) => {
    const stored = stateStore.get(id);
    if (!stored) {
      throw new PluginError("ERR_UNAVAILABLE", `Plugin "${id}" is not registered in state store`);
    }
    const manifest = stored.manifest;
    const declaredPerms = manifest.permissions ?? [];

    const offTools = toolService.bindRpc(manifest, rpc, hostAdapter);
    const offContext = contextService.bindRpc(manifest, rpc, hostAdapter);
    const offSecrets = bindPluginSecretsRpc(
      secretsService,
      {
        pluginId: id,
        declared: declaredPerms.includes("secrets"),
        hasPermission: () => stateStore.hasPermission(id, "secrets"),
      },
      rpc,
    );
    const offSchedules = bindPluginScheduleRpc(
      scheduleService,
      {
        pluginId: id,
        declared: declaredPerms.includes("schedules"),
        hasPermission: () => stateStore.hasPermission(id, "schedules"),
      },
      rpc,
    );
    const offServices = hostServices.configureRpc(id, rpc);

    return () => {
      offServices();
      offSchedules();
      offSecrets();
      offContext();
      offTools();
      toolService.unregisterPlugin(id);
      contextService.unregisterPlugin(id);
    };
  };

  const resolvePluginDefinition = (id: string) => {
    const stored = stateStore.get(id);
    if (!stored) {
      throw new PluginError("ERR_UNAVAILABLE", `Plugin "${id}" is not installed`);
    }
    const installDir = path.resolve(
      stored.installDir ?? path.join(deps.dataRoot, "plugins", id, stored.version),
    );
    const mainPath = path.resolve(installDir, stored.main);
    if (!within(installDir, mainPath)) {
      throw new PluginError("ERR_INVALID_ARGUMENT", `Plugin "${id}" main entry escapes install directory`);
    }
    return {
      entry: runtimeEntry,
      main: mainPath,
      version: stored.version,
      permissions: [...stored.grantedPermissions],
      dataDir: path.join(deps.dataRoot, "plugin-data", id),
    };
  };

  const hostDeps: HostDependencies = {
    resolvePlugin: resolvePluginDefinition,
    fork: () => { throw new Error("Unused when createElectronPluginHost is used"); },
    createChannel: () => { throw new Error("Unused when createElectronPluginHost is used"); },
    getAppMetrics: () => [],
    configureRpc,
  };

  const hostManager = deps.createHostManager
    ? deps.createHostManager(hostDeps)
    : createElectronPluginHost({
        resolvePlugin: resolvePluginDefinition,
        configureRpc,
      });
  hostManagerRef = hostManager;

  const stopPlugin = async (id: string, reason: StopReason = "disabled"): Promise<void> => {
    startedPluginIds.delete(id);
    await hostManager.stop(id, reason);
  };

  return {
    stateStore,
    hostManager,
    toolService,
    contextService,
    secretsService,
    scheduleService,
    hostServices,
    onContextChanged(): void {
      notifyAllContextChanged();
    },
    getBorrowingEntries(): PluginV2BorrowingEntry[] {
      return [...borrowingMap.values()].map(({ id, pluginId, pluginName }) => ({ id, pluginId, pluginName }));
    },
    stopBorrowing(target?: { id?: string; pluginId?: string }): number {
      let stopped = 0;
      for (const entry of [...borrowingMap.values()]) {
        if (target?.id && entry.id !== target.id) continue;
        if (target?.pluginId && entry.pluginId !== target.pluginId) continue;
        try { entry.cancel(); } catch { /* Cancel failure is isolated. */ }
        stopped += 1;
      }
      return stopped;
    },
    publishHostEvent(event: ProtocolHostEvent & { pluginId?: string }): void {
      for (const listener of [...hostEventListeners]) {
        try { listener(event); } catch { /* Observer failure is isolated. */ }
      }
    },
    async collectTurnPluginContext(input: {
      source: PluginRunSource;
      mode: ConversationMode;
      sessionId: string;
      signal?: AbortSignal;
    }): Promise<string> {
      const result = await contextService.collectContext(input);
      return result.promptText;
    },
    installPlugin(manifest: PluginManifestV1, installDir?: string): StoredPluginState {
      return stateStore.install({ manifest, installDir });
    },
    async enablePlugin(id: string, opts?: { grantedPermissions?: readonly string[] }): Promise<StoredPluginState> {
      const updated = stateStore.enable(id, opts);
      startedPluginIds.add(id);
      await hostManager.start(id);
      return updated;
    },
    async disablePlugin(id: string): Promise<StoredPluginState> {
      const updated = stateStore.disable(id);
      await stopPlugin(id, "disabled");
      return updated;
    },
    async uninstallPlugin(id: string): Promise<void> {
      await stopPlugin(id, "disabled");
      scheduleService.uninstallPlugin(id);
      await secretsService.deleteAll(id).catch((err) => {
        logger.warn(LogTag.Plugins, "Failed to delete plugin secrets on uninstall", err);
      });
      stateStore.uninstall(id);
    },
    status(id: string): PluginHostStatus {
      return hostManager.status(id);
    },
    async startEnabled(): Promise<void> {
      const enabled = stateStore.list().filter((entry) => entry.enabled);
      await Promise.allSettled(
        enabled.map(async (entry) => {
          startedPluginIds.add(entry.manifest.id);
          try {
            await hostManager.start(entry.manifest.id);
          } catch (error) {
            logger.warn(LogTag.Plugins, `Failed to start enabled v2 plugin ${entry.manifest.id}`, error);
          }
        }),
      );
    },
    async stopAll(reason: StopReason = "quit"): Promise<void> {
      const ids = new Set<string>([
        ...startedPluginIds,
        ...stateStore.list().map((entry) => entry.manifest.id),
      ]);
      await Promise.allSettled([...ids].map((id) => stopPlugin(id, reason)));
    },
    dispose(): void {
      unsubState();
      unsubTarget?.();
      unsubWorkspace?.();
      hostServices.dispose();
      hostEventListeners.clear();
      borrowingMap.clear();
    },
  };
}

export type PluginV2HostController = ReturnType<typeof createPluginV2HostController>;
