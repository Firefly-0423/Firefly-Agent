/** Transport-neutral SDK protocol. Keep this module free of Node and Electron imports. */
export const PLUGIN_ERROR_CODES = [
  'ERR_UNDECLARED', 'ERR_PERMISSION', 'ERR_REJECTED', 'ERR_CANCELLED', 'ERR_TIMEOUT',
  'ERR_INVALID_ARGUMENT', 'ERR_RATE_LIMITED', 'ERR_UNAVAILABLE', 'ERR_INTERNAL'
] as const
export type PluginErrorCode = typeof PLUGIN_ERROR_CODES[number]
export class PluginError extends Error {
  constructor(readonly code: PluginErrorCode, message: string, readonly retryable = false) {
    super(message)
    this.name = 'PluginError'
  }
}
export const HOST_TO_PLUGIN_METHODS = {
  activate: 'activate', deactivate: 'deactivate', toolExecute: 'tool.execute', contextProvide: 'context.provide',
  channelStart: 'channel.start', channelStop: 'channel.stop', channelSend: 'channel.send'
} as const
export const PLUGIN_TO_HOST_METHODS = {
  toolsRegister: 'tools.register', contextRegister: 'context.register', modelGenerate: 'model.generate', modelRun: 'model.run',
  eventsSubscribe: 'events.subscribe', sessionsList: 'sessions.list', sessionsMessages: 'sessions.messages',
  workspaceInfo: 'workspace.info',
  schedulesPropose: 'schedules.propose', schedulesUpdate: 'schedules.update', schedulesRemove: 'schedules.remove', schedulesList: 'schedules.list', schedulesOnTrigger: 'schedules.onTrigger',
  secretsGet: 'secrets.get', secretsSet: 'secrets.set', secretsDelete: 'secrets.delete', secretsKeys: 'secrets.keys',
  uiOpenWindow: 'ui.openWindow', uiOnMessage: 'ui.onMessage', uiPost: 'ui.post'
} as const
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

