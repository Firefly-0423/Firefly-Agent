/**
 * Firefly Plugin SDK 1.2.0 testing host (`@firefly_wu/plugin-sdk/testing`).
 */
import Ajv from "ajv";
import { PluginError } from "../protocol";
import type {
  ChannelAdapter,
  ChannelState,
  Channels,
  ContextProvideRequest,
  ContextProvideResult,
  ContextProviderDefinition,
  ContextProviders,
  DeactivateReason,
  Events,
  HostEvent,
  InboundMessage,
  Mode,
  Model,
  ModelGenerateChunk,
  ModelGenerateRequest,
  ModelGenerateResult,
  ModelRunHandle,
  ModelRunRequest,
  ModelRunResult,
  OutboundMessage,
  Page,
  PluginContext,
  PluginDefinition,
  RunEvent,
  RunSource,
  ScheduleProposalSpec,
  ScheduleTriggerEvent,
  Schedules,
  Secrets,
  SessionSummary,
  Sessions,
  TaskRecord,
  ToolCall,
  ToolCaller,
  ToolDefinition,
  ToolResult,
  ToolRisk,
  Tools,
  Ui,
  UiMessageEvent,
  UiTarget,
  Workspace,
  WorkspaceInfo,
  MessageRecord,
} from "../types";

const AjvCtor = (Ajv as unknown as { default?: typeof Ajv }).default ?? Ajv;

export type PermissionLevel = "read-only" | "per-action" | "full";
export type TestHostStatus = "idle" | "active" | "deactivated" | "crashed";
export type ApprovalVerdict = "allow" | "ask" | "deny";

export interface TestHostManifestTool {
  name: string;
  title?: string;
  risk: ToolRisk[];
  modes: Array<"work" | "code">;
}

export interface TestHostManifestContext {
  id: string;
  title?: string;
  modes: Mode[];
  sources: RunSource[];
}

export interface TestHostManifestChannel {
  id: string;
  title?: string;
}

export interface TestHostManifest {
  id: string;
  name?: string;
  version?: string;
  tools?: TestHostManifestTool[];
  context?: TestHostManifestContext[];
  channels?: TestHostManifestChannel[];
  permissions?: string[];
  ui?: {
    settings?: { entry: string; title?: string };
    windows?: Array<{ id: string; entry?: string; title?: string; width?: number; height?: number }>;
  };
}

export interface RecordedHostCall {
  method: string;
  params: unknown;
  at: number;
}

export interface ApprovalDecisionContext {
  tool: string;
  risks: ToolRisk[];
  args: Record<string, unknown>;
  mode: "work" | "code";
  caller: ToolCaller;
  approval?: { summary: string; target?: string };
}

export interface TestHostOptions {
  manifest: TestHostManifest;
  mode?: Mode;
  level?: PermissionLevel;
  dataDir?: string;
  revokedPermissions?: string[];
  approvalDecision?:
    | "allow"
    | "reject"
    | ((ctx: ApprovalDecisionContext) => "allow" | "reject" | Promise<"allow" | "reject">);
  rateLimitPerMinute?: number;
  model?: {
    generate?: (req: ModelGenerateRequest) => Promise<ModelGenerateResult> | ModelGenerateResult;
    generateStream?: (req: ModelGenerateRequest) => AsyncIterable<ModelGenerateChunk>;
    run?: (req: ModelRunRequest) => ModelRunHandle;
  };
  sessions?: {
    list?: (o?: { cursor?: string; limit?: number; mode?: Mode }) => Promise<Page<SessionSummary>> | Page<SessionSummary>;
    messages?: (sessionId: string, o?: { cursor?: string; limit?: number }) => Promise<Page<MessageRecord>> | Page<MessageRecord>;
  };
  workspace?: WorkspaceInfo | null;
  secrets?: Record<string, string>;
}

export interface CallToolOptions {
  mode?: Mode;
  caller?: ToolCaller;
  sessionId?: string;
  callId?: string;
  signal?: AbortSignal;
}

export interface ProvideContextOptions {
  sessionId?: string;
  mode?: Mode;
  source?: RunSource;
  signal?: AbortSignal;
}

export interface TestHost {
  readonly manifest: TestHostManifest;
  readonly calls: ReadonlyArray<RecordedHostCall>;
  readonly contextSignal: AbortSignal;
  readonly status: TestHostStatus;
  readonly mode: Mode;
  readonly level: PermissionLevel;
  readonly secrets: Map<string, string>;
  readonly schedules: Map<string, TaskRecord>;
  readonly channelStates: Map<string, ChannelState[]>;
  readonly deliveredMessages: Array<{ channelId: string; message: InboundMessage }>;
  readonly uiMessages: Array<{ to: UiTarget; msg: unknown }>;
  readonly openWindows: Map<string, unknown>;
  setMode(mode: Mode): void;
  setLevel(level: PermissionLevel): void;
  grantPermission(permission: string): void;
  revokePermission(permission: string): void;
  activate(plugin: PluginDefinition): Promise<void>;
  deactivate(reason?: DeactivateReason): Promise<void>;
  crash(): Promise<void>;
  callTool(name: string, args: Record<string, unknown>, opts?: CallToolOptions): Promise<ToolResult>;
  cancelTool(callId: string): boolean;
  provideContext(id: string, opts?: ProvideContextOptions): Promise<ContextProvideResult | null>;
  emitEvent(event: HostEvent): void;
  triggerSchedule(taskId: string, payload?: unknown, signal?: AbortSignal): Promise<void>;
  approveSchedule(taskId: string): boolean;
  emitWorkspaceChange(info: WorkspaceInfo | null): void;
  sendUiMessage(event: UiMessageEvent): Promise<unknown>;
  startChannel(id: string): Promise<void>;
  stopChannel(id: string): Promise<void>;
  sendChannel(id: string, msg: OutboundMessage, signal?: AbortSignal): Promise<{ externalMessageId: string }>;
}

const VERDICT_RANK: Record<ApprovalVerdict, number> = { allow: 0, ask: 1, deny: 2 };

/** Spec §7.2 permission level x tool risk matrix (plugin shell under read-only -> ask). */
export function evaluateToolPermission(level: PermissionLevel, risks: readonly ToolRisk[]): ApprovalVerdict {
  if (level === "full") return "allow";
  if (level === "per-action") return "ask";

  let strictest: ApprovalVerdict = "allow";
  for (const risk of risks) {
    let verdict: ApprovalVerdict;
    if (risk === "fs-read" || risk === "network") {
      verdict = "allow";
    } else if (risk === "shell") {
      verdict = "ask";
    } else {
      verdict = "deny";
    }
    if (VERDICT_RANK[verdict] > VERDICT_RANK[strictest]) {
      strictest = verdict;
    }
  }
  return strictest;
}

export function createTestHost(options: TestHostOptions): TestHost {
  const ajv = new AjvCtor({ strict: false });
  const manifest = options.manifest;
  const declaredPermissions = new Set(manifest.permissions ?? []);
  const revokedPermissions = new Set(options.revokedPermissions ?? []);

  let currentMode: Mode = options.mode ?? "work";
  let currentLevel: PermissionLevel = options.level ?? "per-action";
  let currentStatus: TestHostStatus = "idle";
  let currentPlugin: PluginDefinition | undefined;
  let currentWorkspace: WorkspaceInfo | null = options.workspace ?? null;
  let contextAbort = new AbortController();
  let callCounter = 0;
  let taskCounter = 0;
  const modelCallTimes: number[] = [];

  const calls: RecordedHostCall[] = [];
  const registeredTools = new Map<string, { def: ToolDefinition<Record<string, unknown>>; validate: ReturnType<typeof ajv.compile> }>();
  const registeredProviders = new Map<string, ContextProviderDefinition>();
  const registeredChannels = new Map<string, ChannelAdapter>();
  const channelControllers = new Map<string, AbortController>();
  const channelStates = new Map<string, ChannelState[]>();
  const deliveredMessages: Array<{ channelId: string; message: InboundMessage }> = [];
  const uiMessages: Array<{ to: UiTarget; msg: unknown }> = [];
  const openWindows = new Map<string, unknown>();
  const eventListeners = new Map<HostEvent["type"], Set<(e: HostEvent) => void>>();
  const workspaceListeners = new Set<(info: WorkspaceInfo | null) => void>();
  const scheduleTriggerListeners = new Set<(e: ScheduleTriggerEvent) => Promise<void>>();
  const uiMessageListeners = new Set<(e: UiMessageEvent) => Promise<unknown>>();
  const secrets = new Map<string, string>(Object.entries(options.secrets ?? {}));
  const schedules = new Map<string, TaskRecord>();
  const inflightTools = new Map<string, { controller: AbortController; onCrash: () => void }>();

  // Registrations belong to one activation; secrets and schedules are persistent and stay.
  const clearRegistrations = () => {
    registeredTools.clear();
    registeredProviders.clear();
    registeredChannels.clear();
  };

  // Everything one activation owns; secrets and schedules persist across activations.
  const clearTransient = () => {
    clearRegistrations();
    eventListeners.clear();
    workspaceListeners.clear();
    scheduleTriggerListeners.clear();
    uiMessageListeners.clear();
    openWindows.clear();
  };

  const record = (method: string, params: unknown) => {
    calls.push({ method, params, at: Date.now() });
  };

  const ensureActive = () => {
    if (currentStatus === "crashed" || currentStatus === "deactivated") {
      throw new PluginError("ERR_UNAVAILABLE", "Plugin host is not active", true);
    }
  };

  const requirePermission = (permission: string) => {
    ensureActive();
    if (!declaredPermissions.has(permission)) {
      throw new PluginError("ERR_UNDECLARED", `Permission "${permission}" is not declared in manifest`);
    }
    if (revokedPermissions.has(permission)) {
      throw new PluginError("ERR_PERMISSION", `Permission "${permission}" has been revoked`);
    }
  };

  const checkModelRateLimit = () => {
    if (options.rateLimitPerMinute === undefined) return;
    // Sliding one-minute window, like the host: quota comes back as old calls age out.
    const now = Date.now();
    while (modelCallTimes.length > 0 && now - modelCallTimes[0] >= 60_000) modelCallTimes.shift();
    if (modelCallTimes.length >= options.rateLimitPerMinute) {
      throw new PluginError("ERR_RATE_LIMITED", "Plugin model call rate limit exceeded", true);
    }
    modelCallTimes.push(now);
  };

  const toolsApi: Tools = {
    register<A = Record<string, unknown>>(tool: ToolDefinition<A>) {
      record("tools.register", { name: tool.name, description: tool.description, parameters: tool.parameters });
      ensureActive();
      const declared = manifest.tools?.find((t) => t.name === tool.name);
      if (!declared) {
        throw new PluginError("ERR_UNDECLARED", `Tool "${tool.name}" is not declared in manifest`);
      }
      const validate = ajv.compile(tool.parameters);
      const entry = { def: tool as ToolDefinition<Record<string, unknown>>, validate };
      registeredTools.set(tool.name, entry);
      let disposed = false;
      return {
        dispose() {
          if (disposed) return;
          disposed = true;
          if (registeredTools.get(tool.name) === entry) {
            registeredTools.delete(tool.name);
            record("tools.unregister", { name: tool.name });
          }
        },
      };
    },
  };

  const contextApi: ContextProviders = {
    register(provider: ContextProviderDefinition) {
      record("context.register", { id: provider.id, modes: provider.modes, sources: provider.sources });
      ensureActive();
      const declared = manifest.context?.find((c) => c.id === provider.id);
      if (!declared) {
        throw new PluginError("ERR_UNDECLARED", `Context provider "${provider.id}" is not declared in manifest`);
      }
      registeredProviders.set(provider.id, provider);
      let disposed = false;
      return {
        dispose() {
          if (disposed) return;
          disposed = true;
          if (registeredProviders.get(provider.id) === provider) {
            registeredProviders.delete(provider.id);
            record("context.unregister", { id: provider.id });
          }
        },
      };
    },
  };

  const channelsApi: Channels = {
    register(adapter: ChannelAdapter) {
      record("channels.register", { id: adapter.id });
      ensureActive();
      const declared = manifest.channels?.find((c) => c.id === adapter.id);
      if (!declared) {
        throw new PluginError("ERR_UNDECLARED", `Channel "${adapter.id}" is not declared in manifest`);
      }
      registeredChannels.set(adapter.id, adapter);
      return {
        dispose() {
          if (registeredChannels.get(adapter.id) === adapter) {
            registeredChannels.delete(adapter.id);
          }
        },
      };
    },
  };

  const modelApi: Model = {
    async generate(req: ModelGenerateRequest): Promise<ModelGenerateResult> {
      record("model.generate", {
        prompt: req.prompt,
        system: req.system,
        maxOutputTokens: req.maxOutputTokens,
        schema: req.schema,
      });
      requirePermission("model.generate");
      if (req.signal?.aborted || contextAbort.signal.aborted) {
        throw new PluginError("ERR_CANCELLED", "Model request was cancelled");
      }
      checkModelRateLimit();
      if (!options.model?.generate) {
        return { text: "" };
      }
      return await options.model.generate(req);
    },

    async *generateStream(req: ModelGenerateRequest): AsyncIterable<ModelGenerateChunk> {
      record("model.generateStream", {
        prompt: req.prompt,
        system: req.system,
        maxOutputTokens: req.maxOutputTokens,
        schema: req.schema,
      });
      requirePermission("model.generate");
      if (req.signal?.aborted || contextAbort.signal.aborted) {
        throw new PluginError("ERR_CANCELLED", "Model stream was cancelled");
      }
      checkModelRateLimit();
      if (!options.model?.generateStream) {
        return;
      }
      for await (const chunk of options.model.generateStream(req)) {
        if (req.signal?.aborted || contextAbort.signal.aborted) {
          throw new PluginError("ERR_CANCELLED", "Model stream was cancelled");
        }
        yield chunk;
      }
    },

    run(req: ModelRunRequest): ModelRunHandle {
      record("model.run", {
        objective: req.objective,
        mode: req.mode,
        sessionId: req.sessionId,
        allowPartners: req.allowPartners,
      });
      requirePermission("model.run");
      if (req.signal?.aborted || contextAbort.signal.aborted) {
        const err = new PluginError("ERR_CANCELLED", "Model run was cancelled");
        const rejected = Promise.reject(err);
        rejected.catch(() => {});
        return {
          events: (async function* () {
            throw err;
          })(),
          result: rejected,
        };
      }
      checkModelRateLimit();
      if (options.model?.run) {
        return options.model.run(req);
      }
      const emptyEvents: RunEvent[] = [
        { type: "run.started", runId: "test-run-1", sessionId: req.sessionId ?? "test-session", mode: req.mode, at: Date.now() },
        { type: "run.ended", runId: "test-run-1", sessionId: req.sessionId ?? "test-session", outcome: "completed", at: Date.now() },
      ];
      return {
        events: (async function* () {
          for (const event of emptyEvents) {
            yield event;
          }
        })(),
        result: Promise.resolve({
          runId: "test-run-1",
          sessionId: req.sessionId ?? "test-session",
          reply: "",
        }),
      };
    },
  };

  const eventsApi: Events = {
    on<T extends HostEvent["type"]>(type: T, fn: (e: Extract<HostEvent, { type: T }>) => void) {
      record("events.subscribe", { type });
      requirePermission("events");
      let set = eventListeners.get(type);
      if (!set) {
        set = new Set();
        eventListeners.set(type, set);
      }
      const listener = fn as (e: HostEvent) => void;
      set.add(listener);
      return {
        dispose() {
          set?.delete(listener);
        },
      };
    },
  };

  const sessionsApi: Sessions = {
    async list(o) {
      record("sessions.list", o ?? {});
      requirePermission("sessions.read");
      if (options.sessions?.list) {
        return await options.sessions.list(o);
      }
      return { items: [] };
    },
    async messages(sessionId, o) {
      record("sessions.messages", { sessionId, ...(o ?? {}) });
      requirePermission("sessions.read");
      if (options.sessions?.messages) {
        return await options.sessions.messages(sessionId, o);
      }
      return { items: [] };
    },
  };

  const workspaceApi: Workspace = {
    async current(sessionId) {
      record("workspace.info", sessionId !== undefined ? { sessionId } : {});
      requirePermission("workspace.read");
      return currentWorkspace;
    },
    onChange(fn) {
      record("workspace.watch", {});
      requirePermission("workspace.read");
      workspaceListeners.add(fn);
      return {
        dispose() {
          workspaceListeners.delete(fn);
        },
      };
    },
  };

  const schedulesApi: Schedules = {
    async propose(spec: ScheduleProposalSpec) {
      record("schedules.propose", spec);
      requirePermission("schedules");
      const taskId = `task-${++taskCounter}`;
      const now = new Date().toISOString();
      schedules.set(taskId, {
        taskId,
        title: spec.title,
        schedule: spec.schedule,
        action: spec.action,
        status: "pending_approval",
        nextFireAt: null,
        createdAt: now,
        updatedAt: now,
      });
      return { taskId, status: "pending_approval" as const };
    },
    async update(taskId, patch) {
      record("schedules.update", { taskId, patch });
      requirePermission("schedules");
      const existing = schedules.get(taskId);
      if (!existing) {
        throw new PluginError("ERR_INVALID_ARGUMENT", `Schedule task not found: ${taskId}`);
      }
      schedules.set(taskId, {
        ...existing,
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.schedule !== undefined ? { schedule: patch.schedule } : {}),
        ...(patch.action !== undefined ? { action: patch.action } : {}),
        status: "pending_approval",
        updatedAt: new Date().toISOString(),
      });
      return { status: "pending_approval" as const };
    },
    async remove(taskId) {
      record("schedules.remove", { taskId });
      requirePermission("schedules");
      return schedules.delete(taskId);
    },
    async list() {
      record("schedules.list", {});
      requirePermission("schedules");
      return Array.from(schedules.values());
    },
    onTrigger(fn) {
      record("schedules.onTrigger", {});
      requirePermission("schedules");
      scheduleTriggerListeners.add(fn);
      return {
        dispose() {
          scheduleTriggerListeners.delete(fn);
        },
      };
    },
  };

  const secretsApi: Secrets = {
    async set(key, value) {
      record("secrets.set", { key, value });
      requirePermission("secrets");
      secrets.set(key, value);
    },
    async get(key) {
      record("secrets.get", { key });
      requirePermission("secrets");
      return secrets.get(key) ?? null;
    },
    async delete(key) {
      record("secrets.delete", { key });
      requirePermission("secrets");
      return secrets.delete(key);
    },
    async keys() {
      record("secrets.keys", {});
      requirePermission("secrets");
      return Array.from(secrets.keys()).sort();
    },
  };

  const uiApi: Ui = {
    async openWindow(id, state) {
      record("ui.openWindow", { id, state });
      requirePermission("ui.windows");
      if (!manifest.ui?.windows?.some((w) => w.id === id)) {
        throw new PluginError("ERR_UNDECLARED", `UI window "${id}" is not declared in manifest`);
      }
      openWindows.set(id, state ?? null);
      return {
        close: async () => {
          record("ui.closeWindow", { id });
          openWindows.delete(id);
        },
        post: async (msg) => {
          await uiApi.post({ kind: "window", id }, msg);
        },
      };
    },
    onMessage(fn) {
      record("ui.onMessage", {});
      ensureActive();
      const hasUi = declaredPermissions.has("ui.windows") || Boolean(manifest.ui?.settings) || Boolean(manifest.ui?.windows?.length);
      if (!hasUi) {
        throw new PluginError("ERR_UNDECLARED", "UI capability is not declared in manifest");
      }
      if (declaredPermissions.has("ui.windows") && revokedPermissions.has("ui.windows")) {
        throw new PluginError("ERR_PERMISSION", 'Permission "ui.windows" has been revoked');
      }
      uiMessageListeners.add(fn);
      return {
        dispose() {
          uiMessageListeners.delete(fn);
        },
      };
    },
    async post(to, msg) {
      record("ui.post", { to, msg });
      ensureActive();
      if (to.kind === "window") {
        requirePermission("ui.windows");
        if (!manifest.ui?.windows?.some((w) => w.id === to.id)) {
          throw new PluginError("ERR_UNDECLARED", `UI window "${to.id}" is not declared in manifest`);
        }
      } else if (!manifest.ui?.settings) {
        throw new PluginError("ERR_UNDECLARED", "UI settings panel is not declared in manifest");
      }
      uiMessages.push({ to, msg });
    },
  };

  const createContext = (): PluginContext => ({
    id: manifest.id,
    version: manifest.version ?? "1.0.0",
    dataDir: options.dataDir ?? `/mock/plugin-data/${manifest.id}`,
    signal: contextAbort.signal,
    has: (permission: string) => declaredPermissions.has(permission) && !revokedPermissions.has(permission),
    tools: toolsApi,
    context: contextApi,
    channels: channelsApi,
    model: modelApi,
    events: eventsApi,
    sessions: sessionsApi,
    workspace: workspaceApi,
    schedules: schedulesApi,
    secrets: secretsApi,
    ui: uiApi,
  });

  const host: TestHost = {
    manifest,
    calls,
    get contextSignal() {
      return contextAbort.signal;
    },
    get status() {
      return currentStatus;
    },
    get mode() {
      return currentMode;
    },
    get level() {
      return currentLevel;
    },
    secrets,
    schedules,
    channelStates,
    deliveredMessages,
    uiMessages,
    openWindows,
    setMode(mode: Mode) {
      currentMode = mode;
    },
    setLevel(level: PermissionLevel) {
      currentLevel = level;
    },
    grantPermission(permission: string) {
      revokedPermissions.delete(permission);
    },
    revokePermission(permission: string) {
      revokedPermissions.add(permission);
    },
    async activate(plugin: PluginDefinition) {
      if (currentStatus === "active") {
        throw new PluginError("ERR_INTERNAL", "Plugin is already active");
      }
      // A fresh activation starts like a new plugin process: nothing the previous one registered survives.
      clearRegistrations();
      contextAbort = new AbortController();
      currentPlugin = plugin;
      currentStatus = "active";
      try {
        await plugin.activate(createContext());
      } catch (error) {
        currentStatus = "deactivated";
        contextAbort.abort("fault");
        // A failed activation leaves nothing behind, same as a stopped plugin process.
        clearTransient();
        throw error;
      }
    },
    async deactivate(reason: DeactivateReason = "disabled") {
      if (currentStatus === "deactivated" || currentStatus === "idle") return;
      currentStatus = "deactivated";
      contextAbort.abort(reason);
      for (const controller of channelControllers.values()) {
        controller.abort(reason);
      }
      channelControllers.clear();
      try {
        await currentPlugin?.deactivate?.(reason);
      } finally {
        clearTransient();
      }
    },
    async crash() {
      if (currentStatus === "crashed") return;
      currentStatus = "crashed";
      contextAbort.abort("fault");
      for (const controller of channelControllers.values()) {
        controller.abort("fault");
      }
      channelControllers.clear();
      for (const inflight of Array.from(inflightTools.values())) {
        inflight.controller.abort("fault");
        inflight.onCrash();
      }
      inflightTools.clear();
      clearTransient();
    },
    async callTool(name: string, args: Record<string, unknown>, opts: CallToolOptions = {}): Promise<ToolResult> {
      if (currentStatus !== "active") {
        return { status: "not_executed", reason: `Plugin host is ${currentStatus}` };
      }
      const registered = registeredTools.get(name);
      const declared = manifest.tools?.find((t) => t.name === name);
      if (!registered || !declared) {
        throw new PluginError("ERR_UNDECLARED", `Tool "${name}" is not registered or declared`);
      }

      const effectiveMode = opts.mode ?? currentMode;
      if (effectiveMode === "chat" || !declared.modes.includes(effectiveMode)) {
        return { status: "not_executed", reason: `Tool "${name}" is unavailable in ${effectiveMode} mode` };
      }

      if (!registered.validate(args)) {
        return { status: "not_executed", reason: "ERR_INVALID_ARGUMENT: Tool arguments failed schema validation" };
      }

      // The activation this call belongs to; an approval wait must not carry it into a later one.
      const lifecycleSignal = contextAbort.signal;
      const verdict = evaluateToolPermission(currentLevel, declared.risk);
      if (verdict === "deny") {
        return { status: "not_executed", reason: `ERR_PERMISSION: Tool "${name}" denied under ${currentLevel} permission level` };
      }
      if (verdict === "ask") {
        const caller = opts.caller ?? "firefly";
        const approval = registered.def.describeApproval?.(args);
        const decision = typeof options.approvalDecision === "function"
          ? await options.approvalDecision({ tool: name, risks: declared.risk, args, mode: effectiveMode, caller, approval })
          : (options.approvalDecision ?? "allow");
        if (decision === "reject") {
          return { status: "not_executed", reason: "ERR_REJECTED: Tool approval was rejected" };
        }
      }

      if (opts.signal?.aborted) {
        return { status: "not_executed", reason: "ERR_CANCELLED: Tool call was cancelled before execution" };
      }
      if (lifecycleSignal.aborted || lifecycleSignal !== contextAbort.signal) {
        return { status: "not_executed", reason: "ERR_CANCELLED: Plugin was stopped before the tool could run" };
      }

      const callId = opts.callId ?? `call-${++callCounter}`;
      const toolAbort = new AbortController();
      const onExternalAbort = () => toolAbort.abort(opts.signal?.reason ?? "cancelled");
      opts.signal?.addEventListener("abort", onExternalAbort, { once: true });
      // Deactivating the plugin cancels its running tool calls, as the real runtime does.
      const onLifecycleAbort = () => toolAbort.abort(lifecycleSignal.reason ?? "deactivated");
      lifecycleSignal.addEventListener("abort", onLifecycleAbort, { once: true });

      const call: ToolCall = {
        callId,
        sessionId: opts.sessionId ?? "test-session",
        mode: effectiveMode,
        caller: opts.caller ?? "firefly",
        signal: toolAbort.signal,
        progress: (message, percent) => {
          record("tool.progress", { callId, name, message, percent });
        },
      };

      return await new Promise<ToolResult>((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
          inflightTools.delete(callId);
          opts.signal?.removeEventListener("abort", onExternalAbort);
          lifecycleSignal.removeEventListener("abort", onLifecycleAbort);
        };
        inflightTools.set(callId, {
          controller: toolAbort,
          onCrash: () => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve({ status: "unknown", reason: "Plugin process crashed during tool execution" });
          },
        });

        try {
          Promise.resolve(registered.def.execute(args, call)).then(
            (res) => {
              if (settled) return;
              settled = true;
              cleanup();
              resolve(res);
            },
            (err) => {
              if (settled) return;
              settled = true;
              cleanup();
              reject(err);
            },
          );
        } catch (err) {
          if (!settled) {
            settled = true;
            cleanup();
            reject(err);
          }
        }
      });
    },
    cancelTool(callId: string): boolean {
      const inflight = inflightTools.get(callId);
      if (!inflight) return false;
      inflight.controller.abort("cancelled");
      return true;
    },
    async provideContext(id: string, opts: ProvideContextOptions = {}): Promise<ContextProvideResult | null> {
      ensureActive();
      const provider = registeredProviders.get(id);
      const declared = manifest.context?.find((c) => c.id === id);
      if (!provider || !declared) {
        throw new PluginError("ERR_UNDECLARED", `Context provider "${id}" is not registered or declared`);
      }
      const mode = opts.mode ?? currentMode;
      const source = opts.source ?? "user";
      if (!provider.modes.includes(mode) || !provider.sources.includes(source)) {
        return null;
      }
      const controller = new AbortController();
      const onContextAbort = () => controller.abort(contextAbort.signal.reason);
      const onOptAbort = () => controller.abort(opts.signal?.reason);
      if (contextAbort.signal.aborted) controller.abort(contextAbort.signal.reason);
      if (opts.signal?.aborted) controller.abort(opts.signal.reason);
      contextAbort.signal.addEventListener("abort", onContextAbort, { once: true });
      opts.signal?.addEventListener("abort", onOptAbort, { once: true });
      try {
        return await provider.provide({
          sessionId: opts.sessionId ?? "test-session",
          mode,
          source,
          signal: controller.signal,
        });
      } finally {
        contextAbort.signal.removeEventListener("abort", onContextAbort);
        opts.signal?.removeEventListener("abort", onOptAbort);
      }
    },
    emitEvent(event: HostEvent) {
      const set = eventListeners.get(event.type);
      if (!set) return;
      for (const listener of set) {
        listener(event);
      }
    },
    async triggerSchedule(taskId: string, payload?: unknown, signal?: AbortSignal) {
      ensureActive();
      const controller = new AbortController();
      if (signal?.aborted) controller.abort(signal.reason);
      const onAbort = () => controller.abort(signal?.reason);
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        for (const listener of scheduleTriggerListeners) {
          await listener({ taskId, payload, signal: controller.signal });
        }
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    },
    approveSchedule(taskId: string): boolean {
      const existing = schedules.get(taskId);
      if (!existing) return false;
      schedules.set(taskId, {
        ...existing,
        status: "active",
        updatedAt: new Date().toISOString(),
      });
      return true;
    },
    emitWorkspaceChange(info: WorkspaceInfo | null) {
      currentWorkspace = info;
      for (const listener of workspaceListeners) {
        listener(info);
      }
    },
    async sendUiMessage(event: UiMessageEvent): Promise<unknown> {
      ensureActive();
      let result: unknown;
      for (const listener of uiMessageListeners) {
        result = await listener(event);
      }
      return result;
    },
    async startChannel(id: string) {
      ensureActive();
      const adapter = registeredChannels.get(id);
      if (!adapter) {
        throw new PluginError("ERR_UNDECLARED", `Channel "${id}" is not registered`);
      }
      const controller = new AbortController();
      channelControllers.set(id, controller);
      await adapter.start(
        {
          reportState: (s) => {
            record("channels.reportState", { id, state: s });
            const list = channelStates.get(id) ?? [];
            list.push(s);
            channelStates.set(id, list);
          },
          deliver: async (message) => {
            record("channels.deliver", { id, message });
            deliveredMessages.push({ channelId: id, message });
            return { accepted: true, sessionId: `channel:${id}:${message.chat.id}` };
          },
        },
        controller.signal,
      );
    },
    async stopChannel(id: string) {
      const adapter = registeredChannels.get(id);
      if (!adapter) {
        throw new PluginError("ERR_UNDECLARED", `Channel "${id}" is not registered`);
      }
      channelControllers.get(id)?.abort("stopped");
      channelControllers.delete(id);
      await adapter.stop();
    },
    async sendChannel(id: string, msg: OutboundMessage, signal?: AbortSignal) {
      ensureActive();
      const adapter = registeredChannels.get(id);
      if (!adapter) {
        throw new PluginError("ERR_UNDECLARED", `Channel "${id}" is not registered`);
      }
      const controller = new AbortController();
      if (signal?.aborted) controller.abort(signal.reason);
      const onAbort = () => controller.abort(signal?.reason);
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        return await adapter.send(msg, controller.signal);
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };

  return host;
}
