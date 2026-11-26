import { PluginError, type ProtocolNotificationParams } from './plugin-protocol'

/** Plain text only; remove controls, including bidi overrides, before counting Unicode code points. */
export function parsePluginNotification(input: unknown): ProtocolNotificationParams {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new PluginError('ERR_INVALID_ARGUMENT', 'Notification must contain title and body strings')
  }
  const fields = Object.getOwnPropertyDescriptors(input)
  if (Reflect.ownKeys(fields).length !== 2 || !fields.title || !fields.body ||
      !('value' in fields.title) || !('value' in fields.body) ||
      typeof fields.title.value !== 'string' || typeof fields.body.value !== 'string') {
    throw new PluginError('ERR_INVALID_ARGUMENT', 'Notification must contain only title and body strings')
  }
  const title = fields.title.value.replace(/[\p{Cc}\p{Cf}]/gu, '')
  const body = fields.body.value.replace(/[\p{Cc}\p{Cf}]/gu, '')
  if ([...title].length > 64 || [...body].length > 256) {
    throw new PluginError('ERR_INVALID_ARGUMENT', 'Notification title/body exceed 64/256 Unicode code points')
  }
  return { title, body }
}

/** One sliding window per plugin; lifecycle restarts do not reset a plugin's quota. */
export function createPluginNotificationLimiter(): (pluginId: string) => void {
  const windows = new Map<string, number[]>()
  return pluginId => {
    const now = Date.now()
    const recent = (windows.get(pluginId) ?? []).filter(at => now - at < 60_000)
    if (recent.length >= 5) {
      throw new PluginError('ERR_RATE_LIMITED', 'Plugin notification rate limit exceeded', true)
    }
    recent.push(now)
    windows.set(pluginId, recent)
  }
}
