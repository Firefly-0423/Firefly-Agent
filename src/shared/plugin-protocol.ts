/** Transport-neutral SDK protocol. Keep this module free of Node and Electron imports. */
export const PLUGIN_ERROR_CODES = [
  'ERR_UNDECLARED', 'ERR_PERMISSION', 'ERR_REJECTED', 'ERR_CANCELLED', 'ERR_TIMEOUT',
  'ERR_INVALID_ARGUMENT', 'ERR_RATE_LIMITED', 'ERR_UNAVAILABLE', 'ERR_INTERNAL'
] as const
export type PluginErrorCode = typeof PLUGIN_ERROR_CODES[number]
export interface PluginErrorOptions {
  readonly retryable?: boolean
  readonly cause?: unknown
}
export class PluginError extends Error {
  /**
   * The SDK bundle a plugin imports and the host runtime each carry their own copy of this class, so
   * a plain prototype check would fail across that boundary. Any Error named PluginError with a
   * known code counts, which keeps `instanceof` and RPC error replies working in both directions.
   */
  static [Symbol.hasInstance](value: unknown): boolean {
    if (!(value instanceof Error) || value.name !== 'PluginError') return false
    const code = (value as { code?: unknown }).code
    return typeof code === 'string' && (PLUGIN_ERROR_CODES as readonly string[]).includes(code)
  }
  readonly retryable: boolean
  constructor(
    readonly code: PluginErrorCode,
    message: string,
    retryableOrOptions: boolean | PluginErrorOptions = false,
    cause?: unknown,
  ) {
    const retryable = typeof retryableOrOptions === 'boolean'
      ? retryableOrOptions
      : (retryableOrOptions?.retryable ?? false)
    const resolvedCause = typeof retryableOrOptions === 'object' && retryableOrOptions !== null
      ? ('cause' in retryableOrOptions ? retryableOrOptions.cause : cause)
      : cause
    super(message, resolvedCause !== undefined ? { cause: resolvedCause } : undefined)
    this.name = 'PluginError'
    this.retryable = retryable
    if (resolvedCause !== undefined && !('cause' in this)) {
      ;(this as { cause?: unknown }).cause = resolvedCause
    }
  }
}
export const HOST_TO_PLUGIN_METHODS = {
  activate: 'activate', deactivate: 'deactivate', toolExecute: 'tool.execute', contextProvide: 'context.provide',
  channelStart: 'channel.start', channelStop: 'channel.stop', channelSend: 'channel.send',
  uiMessage: 'ui.message'
} as const
export const PLUGIN_TO_HOST_METHODS = {
  toolsRegister: 'tools.register', toolsUnregister: 'tools.unregister',
  contextRegister: 'context.register', contextUnregister: 'context.unregister',
  channelsRegister: 'channels.register', channelsReportState: 'channels.reportState', channelsDeliver: 'channels.deliver',
  modelGenerate: 'model.generate', modelRun: 'model.run',
  eventsSubscribe: 'events.subscribe', sessionsList: 'sessions.list', sessionsMessages: 'sessions.messages',
  workspaceInfo: 'workspace.info', workspaceRead: 'workspace.read', workspaceWatch: 'workspace.watch',
  schedulesPropose: 'schedules.propose', schedulesUpdate: 'schedules.update', schedulesRemove: 'schedules.remove', schedulesList: 'schedules.list', schedulesOnTrigger: 'schedules.onTrigger',
  secretsGet: 'secrets.get', secretsSet: 'secrets.set', secretsDelete: 'secrets.delete', secretsKeys: 'secrets.keys',
  uiOpenWindow: 'ui.openWindow', uiCloseWindow: 'ui.closeWindow', uiOnMessage: 'ui.onMessage', uiPost: 'ui.post'
} as const

export type HostToPluginMethod = typeof HOST_TO_PLUGIN_METHODS[keyof typeof HOST_TO_PLUGIN_METHODS]
export type PluginToHostMethod = typeof PLUGIN_TO_HOST_METHODS[keyof typeof PLUGIN_TO_HOST_METHODS]

export type ProtocolMode = 'chat' | 'work' | 'code'
export type ProtocolRunSource = 'user' | 'schedule' | 'plugin' | 'channel'
export type ProtocolDeactivateReason = 'disabled' | 'quit' | 'upgrade' | 'fault'
export type ProtocolToolCaller = 'firefly' | { partnerId: string; partnerName: string }
export type ProtocolToolResult =
  | { status: 'succeeded'; output: string | Record<string, unknown>; summary?: string }
  | { status: 'failed'; error: string; retryable?: boolean }
  | { status: 'unknown'; reason: string; possibleEffects?: string }
  | { status: 'not_executed'; reason: string }

export interface ProtocolChannelState {
  state: 'disconnected' | 'connecting' | 'connected' | 'error'
  detail?: string
}
export interface ProtocolChannelAttachment {
  kind: 'image' | 'audio' | 'file' | 'video'
  name?: string
  mimeType?: string
  data?: Uint8Array
  url?: string
}
export interface ProtocolChannelChat {
  type: 'private' | 'group'
  id: string
  title?: string
  threadId?: string
}
export interface ProtocolChannelSender {
  id: string
  name?: string
}
export interface ProtocolInboundMessage {
  externalMessageId: string
  chat: ProtocolChannelChat
  sender: ProtocolChannelSender
  text: string
  attachments?: ProtocolChannelAttachment[]
  timestamp: number
}
export interface ProtocolOutboundMessage {
  chat: ProtocolChannelChat
  text: string
  replyToExternalMessageId?: string
  attachments?: ProtocolChannelAttachment[]
}

export interface ProtocolModelGenerateParams {
  prompt: string
  system?: string
  maxOutputTokens?: number
  schema?: Record<string, unknown>
}
export interface ProtocolModelGenerateResult {
  text: string
  usage?: { inputTokens: number; outputTokens: number }
}
export interface ProtocolModelGenerateChunk {
  delta: string
}
export interface ProtocolModelRunParams {
  objective: string
  mode: ProtocolMode
  sessionId?: string
  allowPartners?: boolean
}
export type ProtocolRunEvent =
  | { type: 'run.started'; runId: string; sessionId: string; mode: ProtocolMode; at: number }
  | { type: 'text.delta'; delta: string }
  | { type: 'tool.started'; callId: string; tool: string }
  | { type: 'tool.completed'; callId: string; tool: string; status: ProtocolToolResult['status'] }
  | { type: 'run.ended'; runId: string; sessionId: string; outcome: 'completed' | 'cancelled' | 'failed'; at: number }
export interface ProtocolModelRunResult {
  runId: string
  sessionId: string
  reply: string
}
export type ProtocolModelRunChunk =
  | ProtocolRunEvent
  | { type: 'run.result'; result: ProtocolModelRunResult }

export type ProtocolHostEvent =
  | { type: 'run.started'; runId: string; sessionId: string; mode: ProtocolMode; source: ProtocolRunSource; at: number }
  | { type: 'run.ended'; runId: string; sessionId: string; outcome: 'completed' | 'cancelled' | 'failed'; at: number }
  | { type: 'tool.completed'; runId: string; tool: string; status: ProtocolToolResult['status']; durationMs: number; at: number }
  | { type: 'schedule.completed'; taskId: string; outcome: 'completed' | 'cancelled' | 'failed'; at: number }

export interface ProtocolPage<T> {
  items: T[]
  nextCursor?: string
}
export interface ProtocolSessionSummary {
  id: string
  title: string
  mode: ProtocolMode
  updatedAt: number
}
export interface ProtocolMessageRecord {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  createdAt: number
}
export interface ProtocolWorkspaceInfo {
  sessionId: string
  mode: ProtocolMode
  root: string | null
  name: string | null
}

export type ProtocolSchedule =
  | { kind: 'cron'; expression: string; timezone?: string }
  | { kind: 'once'; at: number }
  | { kind: 'interval'; minutes: number }
export type ProtocolScheduleAction =
  | { type: 'run'; prompt: string; mode: ProtocolMode }
  | { type: 'callback'; payload?: unknown }
export interface ProtocolScheduleProposalSpec {
  title: string
  schedule: ProtocolSchedule
  action: ProtocolScheduleAction
}
export interface ProtocolTaskRecord {
  taskId: string
  title: string
  schedule: ProtocolSchedule
  action: ProtocolScheduleAction
  status: 'pending_approval' | 'active' | 'paused'
  nextFireAt: string | null
  lastFiredAt?: string
  createdAt: string
  updatedAt: string
}
export interface ProtocolScheduleTriggerChunk {
  taskId: string
  payload?: unknown
}
export interface ProtocolUiTarget {
  kind: 'window' | 'settings'
  id: string
}
export interface ProtocolUiMessageEvent {
  from: ProtocolUiTarget
  method: string
  params: unknown
}

export interface HostToPluginParams {
  'activate': { id: string; dataDir: string; main: string; version: string; permissions: string[] }
  'deactivate': ProtocolDeactivateReason | { reason: ProtocolDeactivateReason }
  'tool.execute': { name: string; args: Record<string, unknown>; callId: string; sessionId: string; mode: 'work' | 'code'; caller: ProtocolToolCaller }
  'context.provide': { id: string; sessionId: string; mode: ProtocolMode; source: ProtocolRunSource }
  'channel.start': { id: string }
  'channel.stop': { id: string }
  'channel.send': { id: string; message: ProtocolOutboundMessage }
  'ui.message': ProtocolUiMessageEvent
}

export interface HostToPluginResults {
  'activate': void
  'deactivate': void
  'tool.execute': ProtocolToolResult
  'context.provide': { heading: string; content: string } | null
  'channel.start': void
  'channel.stop': void
  'channel.send': { externalMessageId: string }
  'ui.message': unknown
}

export interface PluginToHostParams {
  'tools.register': { name: string; description: string; parameters: Record<string, unknown> }
  'tools.unregister': { name: string }
  'context.register': { id: string; modes: ProtocolMode[]; sources: ProtocolRunSource[] }
  'context.unregister': { id: string }
  'channels.register': { id: string }
  'channels.reportState': { id: string; state: ProtocolChannelState }
  'channels.deliver': { id: string; message: ProtocolInboundMessage }
  'model.generate': ProtocolModelGenerateParams & { stream?: boolean }
  'model.run': ProtocolModelRunParams
  'events.subscribe': { type: ProtocolHostEvent['type'] }
  'sessions.list': { cursor?: string; limit?: number; mode?: ProtocolMode }
  'sessions.messages': { sessionId: string; cursor?: string; limit?: number }
  'workspace.info': { sessionId?: string }
  'workspace.read': Record<string, unknown>
  'workspace.watch': Record<string, never>
  'schedules.propose': ProtocolScheduleProposalSpec
  'schedules.update': { taskId: string; patch: Partial<ProtocolScheduleProposalSpec> }
  'schedules.remove': { taskId: string }
  'schedules.list': Record<string, never>
  'schedules.onTrigger': Record<string, never>
  'secrets.get': { key: string }
  'secrets.set': { key: string; value: string }
  'secrets.delete': { key: string }
  'secrets.keys': Record<string, never>
  'ui.openWindow': { id: string; state?: unknown }
  'ui.closeWindow': { id: string }
  'ui.onMessage': Record<string, never>
  'ui.post': { to: ProtocolUiTarget; msg: unknown }
}

export interface PluginToHostResults {
  'tools.register': void
  'tools.unregister': void
  'context.register': void
  'context.unregister': void
  'channels.register': void
  'channels.reportState': void
  'channels.deliver': { accepted: boolean; sessionId?: string }
  'model.generate': ProtocolModelGenerateResult
  'model.run': ProtocolModelRunResult
  'events.subscribe': ProtocolHostEvent
  'sessions.list': ProtocolPage<ProtocolSessionSummary>
  'sessions.messages': ProtocolPage<ProtocolMessageRecord>
  'workspace.info': ProtocolWorkspaceInfo | null
  'workspace.read': unknown
  'workspace.watch': ProtocolWorkspaceInfo | null
  'schedules.propose': { taskId: string; status: 'pending_approval' }
  'schedules.update': { status: 'pending_approval' }
  'schedules.remove': boolean
  'schedules.list': ProtocolTaskRecord[]
  'schedules.onTrigger': ProtocolScheduleTriggerChunk
  'secrets.get': string | null
  'secrets.set': void
  'secrets.delete': boolean
  'secrets.keys': string[]
  'ui.openWindow': void
  'ui.closeWindow': void
  'ui.onMessage': ProtocolUiMessageEvent
  'ui.post': void
}

export interface PluginToHostStreamChunks {
  'model.generate': ProtocolModelGenerateChunk
  'model.run': ProtocolModelRunChunk
  'events.subscribe': ProtocolHostEvent
  'workspace.watch': ProtocolWorkspaceInfo | null
  'schedules.onTrigger': ProtocolScheduleTriggerChunk
  'ui.onMessage': ProtocolUiMessageEvent
}

export type PluginToHostStreamMethod = keyof PluginToHostStreamChunks

type AssertExhaustive<M extends string, T extends Record<M, unknown>> = T
type _CheckHostToPluginParams = AssertExhaustive<HostToPluginMethod, HostToPluginParams>
type _CheckHostToPluginResults = AssertExhaustive<HostToPluginMethod, HostToPluginResults>
type _CheckPluginToHostParams = AssertExhaustive<PluginToHostMethod, PluginToHostParams>
type _CheckPluginToHostResults = AssertExhaustive<PluginToHostMethod, PluginToHostResults>
export type Frame =
  | { type: 'req'; id: string; method: string; params: unknown; deadline: number }
  | { type: 'res'; id: string; ok: true; value: unknown }
  | { type: 'res'; id: string; ok: false; error: { code: PluginErrorCode; message: string; retryable: boolean } }
  | { type: 'cancel'; id: string }
  | { type: 'chunk'; id: string; value: unknown }
  | { type: 'end'; id: string }

function record(input: unknown): input is Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false
  const prototype = Object.getPrototypeOf(input)
  return prototype === Object.prototype || prototype === null
}
function exact(input: Record<string, unknown>, keys: string[]): boolean {
  const ownKeys = Reflect.ownKeys(input)
  return ownKeys.length === keys.length && keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    return descriptor !== undefined && 'value' in descriptor
  })
}
function data(input: unknown, seen = new Set<object>()): boolean {
  if (input === null || input === undefined || ['string', 'boolean', 'number', 'bigint'].includes(typeof input)) return true
  if (typeof input !== 'object') return false
  if (seen.has(input)) return true
  seen.add(input)
  if (input instanceof Uint8Array) return true
  if (!Array.isArray(input) && !record(input)) return false
  return Reflect.ownKeys(input).every(key => {
    if (typeof key === 'symbol') return false
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    return descriptor !== undefined && 'value' in descriptor && data(descriptor.value, seen)
  })
}
/** Reject malformed envelopes and non-data payloads without executing accessors. */
export function parseFrame(input: unknown): Frame | null {
  try {
    if (!record(input)) return null
    const descriptors = Object.getOwnPropertyDescriptors(input)
    if (!descriptors.type || !('value' in descriptors.type) || !descriptors.id || !('value' in descriptors.id)) return null
    if (typeof input.id !== 'string' || !input.id) return null
    let valid = false
    switch (input.type) {
      case 'req': valid = exact(input, ['type', 'id', 'method', 'params', 'deadline']) && typeof input.method === 'string' && input.method.length > 0 && typeof input.deadline === 'number' && Number.isFinite(input.deadline) && input.deadline >= 0 && data(input.params); break
      case 'res':
        if (exact(input, ['type', 'id', 'ok', 'value']) && input.ok === true) valid = data(input.value)
        else if (exact(input, ['type', 'id', 'ok', 'error']) && input.ok === false && record(input.error)) {
          valid = exact(input.error, ['code', 'message', 'retryable']) && PLUGIN_ERROR_CODES.includes(input.error.code as PluginErrorCode) && typeof input.error.message === 'string' && typeof input.error.retryable === 'boolean'
        }
        break
      case 'cancel': case 'end': valid = exact(input, ['type', 'id']); break
      case 'chunk': valid = exact(input, ['type', 'id', 'value']) && data(input.value); break
    }
    return valid ? input as Frame : null
  } catch { return null }
}

