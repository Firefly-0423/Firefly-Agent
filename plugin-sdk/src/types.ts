/**
 * Firefly Plugin SDK 1.2.0 public contract types (Spec §6).
 */

export type Mode = "chat" | "work" | "code";
export type RunSource = "user" | "schedule" | "plugin" | "channel";
export type ToolRisk = "fs-read" | "fs-write" | "shell" | "network" | "input-control";
export type DeactivateReason = "disabled" | "quit" | "upgrade" | "fault";

export type PluginPermission =
  | "model.generate"
  | "model.run"
  | "events"
  | "sessions.read"
  | "workspace.read"
  | "schedules"
  | "secrets"
  | "ui.windows";

export interface Disposable {
  dispose(): void;
  /** Optional promise settling when an underlying stream subscription ends (rejects on host error). */
  readonly closed?: Promise<void>;
}

export interface JSONSchemaProperty {
  type?: string | string[];
  description?: string;
  enum?: ReadonlyArray<string | number | boolean | null>;
  const?: unknown;
  default?: unknown;
  items?: JSONSchemaProperty;
  properties?: Record<string, JSONSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean | JSONSchemaProperty;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  pattern?: string;
  [key: string]: unknown;
}

export interface JSONSchemaObject {
  type: "object";
  properties?: Record<string, JSONSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean | JSONSchemaProperty;
  description?: string;
  [key: string]: unknown;
}

// ───────────────────────── §6.2 Tools ─────────────────────────

export type ToolResult =
  | { status: "succeeded"; output: string | Record<string, unknown>; summary?: string }
  | { status: "failed"; error: string; retryable?: boolean }
  | { status: "unknown"; reason: string; possibleEffects?: string }
  | { status: "not_executed"; reason: string };

export type ToolCaller = "firefly" | { partnerId: string; partnerName: string };

export interface ToolCall {
  readonly callId: string;
  readonly sessionId: string;
  readonly mode: "work" | "code";
  readonly caller: ToolCaller;
  readonly signal: AbortSignal;
  progress(message: string, percent?: number): void;
}

export interface ToolApprovalDescription {
  summary: string;
  target?: string;
}

export interface ToolDefinition<A = Record<string, unknown>> {
  name: string;
  description: string;
  parameters: JSONSchemaObject;
  describeApproval?(args: A): ToolApprovalDescription;
  execute(args: A, call: ToolCall): Promise<ToolResult>;
}

export interface Tools {
  register<A = Record<string, unknown>>(tool: ToolDefinition<A>): Disposable;
}

// ───────────────────────── §6.3 Context ─────────────────────────

export interface ContextProvideRequest {
  sessionId: string;
  mode: Mode;
  source: RunSource;
  signal: AbortSignal;
}

export interface ContextProvideResult {
  heading: string;
  content: string;
}

export interface ContextProviderDefinition {
  id: string;
  modes: Mode[];
  sources: RunSource[];
  provide(req: ContextProvideRequest): Promise<ContextProvideResult | null>;
}

export interface ContextProviders {
  register(provider: ContextProviderDefinition): Disposable;
}

// ───────────────────────── §6.4 Channels ─────────────────────────

export type ChannelConnectionState = "disconnected" | "connecting" | "connected" | "error";

export interface ChannelState {
  state: ChannelConnectionState;
  detail?: string;
}

export interface ChannelAttachment {
  kind: "image" | "audio" | "file" | "video";
  name?: string;
  mimeType?: string;
  data?: Uint8Array;
  url?: string;
}

export interface ChannelChat {
  type: "private" | "group";
  id: string;
  title?: string;
  threadId?: string;
}

export interface ChannelSender {
  id: string;
  name?: string;
}

export interface InboundMessage {
  externalMessageId: string;
  chat: ChannelChat;
  sender: ChannelSender;
  text: string;
  attachments?: ChannelAttachment[];
  timestamp: number;
}

export interface OutboundMessage {
  chat: ChannelChat;
  text: string;
  replyToExternalMessageId?: string;
  attachments?: ChannelAttachment[];
}

export interface ChannelHost {
  reportState(s: ChannelState): void;
  deliver(msg: InboundMessage): Promise<{ accepted: boolean; sessionId?: string }>;
}

export interface ChannelAdapter {
  id: string;
  start(host: ChannelHost, signal: AbortSignal): Promise<void>;
  stop(): Promise<void>;
  send(msg: OutboundMessage, signal: AbortSignal): Promise<{ externalMessageId: string }>;
}

export interface Channels {
  register(adapter: ChannelAdapter): Disposable;
}

// ───────────────────────── §6.5 Model ─────────────────────────

export interface ModelGenerateRequest {
  prompt: string;
  system?: string;
  maxOutputTokens?: number;
  schema?: JSONSchemaObject;
  signal?: AbortSignal;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ModelGenerateResult {
  text: string;
  usage?: ModelUsage;
}

export interface ModelGenerateChunk {
  delta: string;
}

export interface ModelRunRequest {
  objective: string;
  mode: Mode;
  sessionId?: string;
  allowPartners?: boolean;
  signal?: AbortSignal;
}

export type RunEvent =
  | { type: "run.started"; runId: string; sessionId: string; mode: Mode; at: number }
  | { type: "text.delta"; delta: string }
  | { type: "tool.started"; callId: string; tool: string }
  | { type: "tool.completed"; callId: string; tool: string; status: ToolResult["status"] }
  | { type: "run.ended"; runId: string; sessionId: string; outcome: "completed" | "cancelled" | "failed"; at: number };

export interface ModelRunResult {
  runId: string;
  sessionId: string;
  reply: string;
}

export interface ModelRunHandle {
  events: AsyncIterable<RunEvent>;
  result: Promise<ModelRunResult>;
}

export interface Model {
  generate(req: ModelGenerateRequest): Promise<ModelGenerateResult>;
  generateStream(req: ModelGenerateRequest): AsyncIterable<ModelGenerateChunk>;
  run(req: ModelRunRequest): ModelRunHandle;
}

// ───────────────────────── §6.6 Events, Sessions, Workspace ─────────────────────────

export type HostEvent =
  | { type: "run.started"; runId: string; sessionId: string; mode: Mode; source: RunSource; at: number }
  | { type: "run.ended"; runId: string; sessionId: string; outcome: "completed" | "cancelled" | "failed"; at: number }
  | { type: "tool.completed"; runId: string; tool: string; status: ToolResult["status"]; durationMs: number; at: number }
  | { type: "schedule.completed"; taskId: string; outcome: "completed" | "cancelled" | "failed"; at: number };

export interface Events {
  on<T extends HostEvent["type"]>(type: T, fn: (e: Extract<HostEvent, { type: T }>) => void): Disposable;
}

export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  mode: Mode;
  updatedAt: number;
}

export interface MessageRecord {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  createdAt: number;
}

export interface Sessions {
  list(o?: { cursor?: string; limit?: number; mode?: Mode }): Promise<Page<SessionSummary>>;
  messages(sessionId: string, o?: { cursor?: string; limit?: number }): Promise<Page<MessageRecord>>;
}

export interface WorkspaceInfo {
  sessionId: string;
  mode: Mode;
  root: string | null;
  name: string | null;
}

export interface Workspace {
  current(sessionId?: string): Promise<WorkspaceInfo | null>;
  onChange(fn: (b: WorkspaceInfo | null) => void): Disposable;
}

// ───────────────────────── §6.7 Schedules ─────────────────────────

export type Schedule =
  | { kind: "cron"; expression: string; timezone?: string }
  | { kind: "once"; at: number }
  | { kind: "interval"; minutes: number };

export type ScheduleAction =
  | { type: "run"; prompt: string; mode: Mode }
  | { type: "callback"; payload?: unknown };

export interface ScheduleProposalSpec {
  title: string;
  schedule: Schedule;
  action: ScheduleAction;
}

export type TaskStatus = "pending_approval" | "active" | "paused";

export interface TaskRecord {
  taskId: string;
  title: string;
  schedule: Schedule;
  action: ScheduleAction;
  status: TaskStatus;
  nextFireAt: string | null;
  lastFiredAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleTriggerEvent {
  taskId: string;
  payload?: unknown;
  signal: AbortSignal;
}

export interface Schedules {
  propose(spec: ScheduleProposalSpec): Promise<{ taskId: string; status: "pending_approval" }>;
  update(taskId: string, patch: Partial<ScheduleProposalSpec>): Promise<{ status: "pending_approval" }>;
  remove(taskId: string): Promise<boolean>;
  list(): Promise<TaskRecord[]>;
  onTrigger(fn: (e: ScheduleTriggerEvent) => Promise<void>): Disposable;
}

// ───────────────────────── §6.8 Secrets & UI ─────────────────────────

export interface Secrets {
  set(key: string, value: string): Promise<void>;
  get(key: string): Promise<string | null>;
  delete(key: string): Promise<boolean>;
  keys(): Promise<string[]>;
}

export interface UiWindowHandle {
  close(): Promise<void>;
  post(msg: unknown): Promise<void>;
}

export interface UiTarget {
  kind: "window" | "settings";
  id: string;
}

export interface UiMessageEvent {
  from: UiTarget;
  method: string;
  params: unknown;
}

export interface Ui {
  openWindow(id: string, state?: unknown): Promise<UiWindowHandle>;
  onMessage(fn: (e: UiMessageEvent) => Promise<unknown>): Disposable;
  post(to: UiTarget, msg: unknown): Promise<void>;
}

// ───────────────────────── §6.1 Plugin Entry ─────────────────────────

export interface PluginContext {
  readonly id: string;
  readonly version: string;
  readonly dataDir: string;
  readonly signal: AbortSignal;
  has(permission: string): boolean;
  readonly tools: Tools;
  readonly context: ContextProviders;
  readonly channels: Channels;
  readonly model: Model;
  readonly events: Events;
  readonly sessions: Sessions;
  readonly workspace: Workspace;
  readonly schedules: Schedules;
  readonly secrets: Secrets;
  readonly ui: Ui;
}

export interface PluginDefinition {
  activate(ctx: PluginContext): void | Promise<void>;
  deactivate?(reason: DeactivateReason): void | Promise<void>;
}
