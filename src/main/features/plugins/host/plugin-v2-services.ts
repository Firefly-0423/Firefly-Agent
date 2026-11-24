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
} from "../../../../shared/plugin-protocol";
import type { PluginRpc } from "../../../../shared/plugin-rpc";
import { createPluginContextService, type PluginContextService } from "../../../../plugins/v2/context";
import {
  createElectronPluginHost,
  PluginHostManager,
  type HostDependencies,
  type PluginHostStatus,
  type StopReason,
} from "../../../../plugins/v2/host";
import { importPluginPackage, PLUGIN_HOST_VERSION } from "../../../../plugins/v2/package/importer";
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
import { resolvePluginSecretsFile } from "../../../../plugins/v2/secrets/paths";
import {
  createPluginHostServices,
  type PublicMessage,
  type PublicSession,
  type ServiceContext,
  type ServicePermission,
} from "../../../../plugins/v2/services";
import {
  createPluginStateStore,
  type PluginOrigin,
  type PluginSourceKind,
  type PluginStateStore,
  type StoredPluginState,
} from "../../../../plugins/v2/state";
import {
  createPluginToolService,
  type PluginToolProgressEvent,
  type PluginToolService,
} from "../../../../plugins/v2/tools";
import {
  createElectronPluginWindowFactory,
  createPluginUiService,
  type CreatePluginWindowOptions,
  type PluginUiService,
  type PluginUiWindowInstance,
} from "../../../../plugins/v2/ui";
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
  hostVersion?: string;
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
  onOverviewChanged?: () => void;
  onRunningStateChange?: (pluginId: string, running: boolean) => void;
  createHostManager?: (deps: HostDependencies) => PluginHostManager;
  createPluginWindow?: (options: CreatePluginWindowOptions) => PluginUiWindowInstance;
  pluginWindowPreloadPath?: string;
}

export interface PluginV2ImportOptions {
  expectedIdentity?: { id: string; version: string };
  origin?: PluginOrigin;
  sourceKind?: PluginSourceKind;
  sourceId?: string;
}

export type PluginV2ImportResult =
  | {
      ok: true;
      installation: "committed";
      activation: "not-requested" | "running";
      plugin: { id: string; name: string; version: string };
    }
  | {
      ok: false;
      installation: "rejected";
      activation?: "rolled-back";
      error: string;
    };

export interface PluginV2Snapshot {
  id: string;
  name: string;
  version: string;
  sdk: string;
  description: string;
  author: string;
  license?: string;
  native: boolean;
  manifest: PluginManifestV1;
  enabled: boolean;
  status: PluginHostStatus;
  grantedPermissions: string[];
  revision: number;
  modelRateLimit: number;
  origin: PluginOrigin;
  sourceKind: PluginSourceKind;
  sourceId?: string;
  installDir: string;
  hasSecrets: boolean;
  hasDataDir: boolean;
  error?: string;
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

  const hostVersion = deps.hostVersion ?? PLUGIN_HOST_VERSION;
  const pluginsRoot = path.join(deps.dataRoot, "plugins");
  const lastErrors = new Map<string, string>();
  let suppressingFaultSync = false;

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
    uiService.notifyAccessChanged(pluginId);
    if (!stateStore.isEnabled(pluginId) || !stateStore.hasPermission(pluginId, "ui.windows")) {
      uiService.closePluginWindows(pluginId);
    }
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

  const windowFactory = deps.createPluginWindow
    ?? createElectronPluginWindowFactory(
      deps.pluginWindowPreloadPath ? { preloadPath: deps.pluginWindowPreloadPath } : {},
    );

  const uiService: PluginUiService = createPluginUiService({
    resolvePlugin(pluginId) {
      const stored = stateStore.get(pluginId);
      if (!stored) return null;
      const installDir = path.resolve(
        stored.installDir ?? path.join(deps.dataRoot, "plugins", pluginId, stored.version),
      );
      const status = hostManagerRef?.status(pluginId) ?? "disabled";
      return {
        packageRoot: installDir,
        manifest: stored.manifest,
        isEnabled: stored.enabled && (status === "enabled" || status === "starting"),
        hasWindowsPermission: stateStore.hasPermission(pluginId, "ui.windows"),
      };
    },
    sendToPlugin: (pluginId, method, params) => hostAdapter.call(pluginId, method, params),
    createWindow: windowFactory,
  });

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
      const runOptions = {
        ...built.options,
        runId,
        signal,
        interactiveTools: false,
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

        sub = agent.runWithEvents(runOptions).subscribe({
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
                case "TOOL_CALL_RESULT": {
                  const ev = packet as { toolCallId?: string; status?: string };
                  if (ev.toolCallId) {
                    const tool = toolNames.get(ev.toolCallId) ?? "unknown";
                    onEvent({
                      type: "tool.completed",
                      callId: ev.toolCallId,
                      tool,
                      status: ev.status === "success" ? "succeeded" : "failed",
                    });
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
    const offUi = uiService.bindRpc(id, rpc);

    return () => {
      offUi();
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

  const offHostStatus = hostManager.onStatusChange(({ id, status }) => {
    if (status === "enabled") {
      lastErrors.delete(id);
    } else {
      if (status === "disabled" || status === "disabled-fault" || status === "stopping" || status === "restarting") {
        uiService.closePluginWindows(id);
      }
      if (status === "disabled-fault" && !suppressingFaultSync) {
        if (!lastErrors.has(id)) {
          lastErrors.set(id, "插件进程多次异常退出，已自动停用");
        }
        if (stateStore.isEnabled(id)) {
          try {
            stateStore.disable(id);
          } catch {
            /* Persisting fault disable cannot interrupt host status updates. */
          }
        }
      }
    }
    deps.onRunningStateChange?.(id, status === "enabled");
    deps.onOverviewChanged?.();
  });

  const stopPlugin = async (id: string, reason: StopReason = "disabled"): Promise<void> => {
    startedPluginIds.delete(id);
    uiService.closePluginWindows(id);
    await hostManager.stop(id, reason);
  };

  const toSnapshot = (stored: StoredPluginState): PluginV2Snapshot => {
    const id = stored.manifest.id;
    const installDir = path.resolve(stored.installDir ?? path.join(pluginsRoot, id, stored.version));
    let hasSecrets = false;
    try {
      hasSecrets = fs.existsSync(resolvePluginSecretsFile(id, deps.dataRoot));
    } catch {
      hasSecrets = false;
    }
    const dataDir = path.join(deps.dataRoot, "plugin-data", id);
    const hasDataDir = fs.existsSync(dataDir);
    return {
      id,
      name: stored.manifest.name,
      version: stored.version,
      sdk: stored.manifest.sdk,
      description: stored.manifest.description ?? "",
      author: stored.manifest.author?.name ?? "",
      ...(stored.manifest.license ? { license: stored.manifest.license } : {}),
      native: stored.manifest.native === true,
      manifest: structuredClone(stored.manifest),
      enabled: stored.enabled,
      status: hostManager.status(id),
      grantedPermissions: [...stored.grantedPermissions],
      revision: stored.revision,
      modelRateLimit: stored.modelRateLimit,
      origin: stored.origin ?? "local",
      sourceKind: stored.sourceKind ?? "local-package",
      ...(stored.sourceId ? { sourceId: stored.sourceId } : {}),
      installDir,
      hasSecrets,
      hasDataDir,
      ...(lastErrors.get(id) ? { error: lastErrors.get(id) } : {}),
    };
  };

  const formatManifestErrors = (errors: ReadonlyArray<{ message: string }>): string =>
    errors.map((entry) => entry.message).filter(Boolean).join("；") || "插件包校验失败";

  const removeDirIfSafe = async (targetDir: string | undefined, expectedBaseDir: string): Promise<void> => {
    if (!targetDir) return;
    const resolvedTarget = path.resolve(targetDir);
    const resolvedBase = path.resolve(expectedBaseDir);
    if (resolvedTarget === resolvedBase || !within(resolvedBase, resolvedTarget)) return;
    await fs.promises.rm(resolvedTarget, { recursive: true, force: true }).catch((err) => {
      logger.warn(LogTag.Plugins, `Failed to remove plugin directory ${resolvedTarget}`, err);
    });
  };

  return {
    stateStore,
    hostManager,
    toolService,
    contextService,
    secretsService,
    scheduleService,
    hostServices,
    uiService,
    async openPluginWindow(id: string, windowId?: string): Promise<void> {
      const stored = stateStore.get(id);
      if (!stored) {
        throw new PluginError("ERR_UNAVAILABLE", `Plugin "${id}" is not installed`);
      }
      const targetId = windowId ?? stored.manifest.ui?.windows?.[0]?.id;
      if (!targetId) {
        throw new PluginError("ERR_UNDECLARED", `Plugin "${id}" has no declared UI windows`);
      }
      await uiService.openWindow(id, targetId);
    },
    closePluginWindows(id: string): number {
      return uiService.closePluginWindows(id);
    },
    listOpenWindows(id: string): string[] {
      return uiService.listOpenWindowIds(id);
    },
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
    listPlugins(): PluginV2Snapshot[] {
      return stateStore.list().map(toSnapshot);
    },
    getPlugin(id: string): PluginV2Snapshot | undefined {
      const stored = stateStore.get(id);
      return stored ? toSnapshot(stored) : undefined;
    },
    installPlugin(manifest: PluginManifestV1, installDir?: string): StoredPluginState {
      const stored = stateStore.install({ manifest, installDir });
      deps.onOverviewChanged?.();
      return stored;
    },
    async importFromPath(sourcePath: string, opts: PluginV2ImportOptions = {}): Promise<PluginV2ImportResult> {
      let imported;
      try {
        imported = await importPluginPackage(sourcePath, {
          pluginsRoot,
          hostVersion,
          allowOverwrite: true,
        });
      } catch (error) {
        return {
          ok: false,
          installation: "rejected",
          error: error instanceof Error ? error.message : String(error),
        };
      }
      if (!imported.ok) {
        return {
          ok: false,
          installation: "rejected",
          error: formatManifestErrors(imported.errors),
        };
      }

      const { manifest, installDir } = imported;
      if (
        opts.expectedIdentity
        && (manifest.id !== opts.expectedIdentity.id || manifest.version !== opts.expectedIdentity.version)
      ) {
        await imported.rollback().catch(() => {});
        return {
          ok: false,
          installation: "rejected",
          error: `插件包身份不匹配：期望 ${opts.expectedIdentity.id}@${opts.expectedIdentity.version}，实际为 ${manifest.id}@${manifest.version}`,
        };
      }

      const origin: PluginOrigin = opts.origin ?? "local";
      const sourceKind: PluginSourceKind = opts.sourceKind ?? imported.sourceKind;
      const sourceId = opts.sourceId;
      const existing = stateStore.get(manifest.id);

      if (!existing) {
        try {
          stateStore.install({
            manifest,
            installDir,
            enabled: false,
            grantedPermissions: [],
            origin,
            sourceKind,
            ...(sourceId ? { sourceId } : {}),
          });
          await imported.commit();
        } catch (error) {
          await imported.rollback().catch(() => {});
          return {
            ok: false,
            installation: "rejected",
            error: error instanceof Error ? error.message : String(error),
          };
        }
        lastErrors.delete(manifest.id);
        deps.onOverviewChanged?.();
        return {
          ok: true,
          installation: "committed",
          activation: "not-requested",
          plugin: { id: manifest.id, name: manifest.name, version: manifest.version },
        };
      }

      const oldInstallDir = path.resolve(
        existing.installDir ?? path.join(pluginsRoot, existing.manifest.id, existing.version),
      );
      const wasActive = existing.enabled || hostManager.status(manifest.id) === "enabled";

      if (!wasActive) {
        try {
          stateStore.install({
            manifest,
            installDir,
            enabled: false,
            origin,
            sourceKind,
            ...(sourceId ? { sourceId } : {}),
          });
          await imported.commit();
          if (oldInstallDir !== path.resolve(installDir)) {
            await removeDirIfSafe(oldInstallDir, path.join(pluginsRoot, manifest.id));
          }
        } catch (error) {
          await imported.rollback().catch(() => {});
          return {
            ok: false,
            installation: "rejected",
            error: error instanceof Error ? error.message : String(error),
          };
        }
        lastErrors.delete(manifest.id);
        deps.onOverviewChanged?.();
        return {
          ok: true,
          installation: "committed",
          activation: "not-requested",
          plugin: { id: manifest.id, name: manifest.name, version: manifest.version },
        };
      }

      // Upgrade while active: stop old -> activate new -> on failure roll back & re-enable old.
      suppressingFaultSync = true;
      try {
        await stopPlugin(manifest.id, "upgrade");
        stateStore.install({
          manifest,
          installDir,
          enabled: true,
          origin,
          sourceKind,
          ...(sourceId ? { sourceId } : {}),
        });
        startedPluginIds.add(manifest.id);
        await hostManager.start(manifest.id);
      } catch (upgradeError) {
        const reason = upgradeError instanceof Error ? upgradeError.message : String(upgradeError);
        await stopPlugin(manifest.id, "upgrade").catch(() => {});
        stateStore.restoreSnapshot(existing);
        await imported.rollback().catch(() => {});
        let rollbackError: string | undefined;
        try {
          startedPluginIds.add(manifest.id);
          await hostManager.start(manifest.id);
        } catch (err) {
          rollbackError = err instanceof Error ? err.message : String(err);
          stateStore.disable(manifest.id);
        } finally {
          suppressingFaultSync = false;
        }
        const message = rollbackError
          ? `新版本启动失败（${reason}），且旧版本恢复失败（${rollbackError}）`
          : `新版本启动失败，已回滚至 v${existing.version}：${reason}`;
        lastErrors.set(manifest.id, message);
        deps.onOverviewChanged?.();
        return {
          ok: false,
          installation: "rejected",
          activation: "rolled-back",
          error: message,
        };
      }
      suppressingFaultSync = false;

      await imported.commit();
      if (oldInstallDir !== path.resolve(installDir)) {
        await removeDirIfSafe(oldInstallDir, path.join(pluginsRoot, manifest.id));
      }
      lastErrors.delete(manifest.id);
      deps.onOverviewChanged?.();
      return {
        ok: true,
        installation: "committed",
        activation: "running",
        plugin: { id: manifest.id, name: manifest.name, version: manifest.version },
      };
    },
    async enablePlugin(id: string, opts?: { grantedPermissions?: readonly string[] }): Promise<StoredPluginState> {
      lastErrors.delete(id);
      const updated = stateStore.enable(id, opts);
      startedPluginIds.add(id);
      try {
        await hostManager.start(id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        lastErrors.set(id, message);
        if (stateStore.isEnabled(id)) {
          try {
            stateStore.disable(id);
          } catch {
            /* Preserve activation failure as primary error. */
          }
        }
        deps.onOverviewChanged?.();
        throw error;
      }
      deps.onOverviewChanged?.();
      return stateStore.get(id) ?? updated;
    },
    async disablePlugin(id: string): Promise<StoredPluginState> {
      const updated = stateStore.disable(id);
      await stopPlugin(id, "disabled");
      lastErrors.delete(id);
      deps.onOverviewChanged?.();
      return updated;
    },
    grantPermission(id: string, permission: string): StoredPluginState {
      const updated = stateStore.grantPermission(id, permission);
      deps.onOverviewChanged?.();
      return updated;
    },
    revokePermission(id: string, permission: string): StoredPluginState {
      const updated = stateStore.revokePermission(id, permission);
      deps.onOverviewChanged?.();
      return updated;
    },
    setModelRateLimit(id: string, limit: number): StoredPluginState {
      const updated = stateStore.setModelRateLimit(id, limit);
      deps.onOverviewChanged?.();
      return updated;
    },
    async uninstallPlugin(
      id: string,
      options: { deleteSecrets?: boolean; deleteData?: boolean } = {},
    ): Promise<void> {
      const existing = stateStore.get(id);
      await stopPlugin(id, "disabled");
      scheduleService.uninstallPlugin(id);
      if (options.deleteSecrets) {
        await secretsService.deleteAll(id).catch((err) => {
          logger.warn(LogTag.Plugins, "Failed to delete plugin secrets on uninstall", err);
        });
      }
      if (options.deleteData) {
        await removeDirIfSafe(path.join(deps.dataRoot, "plugin-data", id), path.join(deps.dataRoot, "plugin-data"));
      }
      await removeDirIfSafe(path.join(pluginsRoot, id), pluginsRoot);
      if (existing?.installDir) {
        await removeDirIfSafe(existing.installDir, pluginsRoot);
      }
      stateStore.uninstall(id);
      lastErrors.delete(id);
      deps.onOverviewChanged?.();
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
            const msg = error instanceof Error ? error.message : String(error);
            lastErrors.set(entry.manifest.id, msg);
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
      offHostStatus();
      unsubState();
      unsubTarget?.();
      unsubWorkspace?.();
      uiService.closeAllWindows();
      hostServices.dispose();
      hostEventListeners.clear();
      borrowingMap.clear();
    },
  };
}

export type PluginV2HostController = ReturnType<typeof createPluginV2HostController>;
