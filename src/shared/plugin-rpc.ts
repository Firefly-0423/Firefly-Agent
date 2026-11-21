import { parseFrame, PluginError, type Frame } from './plugin-protocol'

export interface RpcTransport {
  post(frame: Frame): void
  onFrame(callback: (frame: unknown) => void): () => void
}
export interface RpcOptions { signal?: AbortSignal; timeoutMs?: number }
type Handler = (params: unknown, context: { signal: AbortSignal }) => unknown
export interface PluginRpc {
  call<T = unknown>(method: string, params: unknown, options?: RpcOptions): Promise<T>
  stream<T = unknown>(method: string, params: unknown, options?: RpcOptions): AsyncIterable<T>
  handle(method: string, handler: Handler): () => void
  close(reason?: PluginError): void
  dispose(): void
}
type Reply = Extract<Frame, { type: 'res' | 'chunk' | 'end' }>
type Pending = { receive(frame: Reply): void; fail(error: PluginError): void }
const timeout = () => new PluginError('ERR_TIMEOUT', 'Plugin request timed out', true)
const cancelled = () => new PluginError('ERR_CANCELLED', 'Plugin request cancelled')
const unavailable = () => new PluginError('ERR_UNAVAILABLE', 'Plugin transport unavailable', true)
const internal = () => new PluginError('ERR_INTERNAL', 'Internal plugin error')
const invalid = () => new PluginError('ERR_INVALID_ARGUMENT', 'Invalid plugin request')
const maxDelay = 2_147_483_647

export function createRpcEndpoint(transport: RpcTransport): PluginRpc {
  const handlers = new Map<string, Handler>()
  const outgoing = new Map<string, Pending>()
  const incoming = new Map<string, { controller: AbortController; timer: ReturnType<typeof setTimeout> }>()
  let nextId = 0
  let closed: PluginError | undefined
  function send(frame: Frame): boolean {
    try { transport.post(frame); return true } catch { return false }
  }
  function request(method: string, params: unknown, options: RpcOptions, pending: Pending): () => void {
    if (closed || options.signal?.aborted) { pending.fail(closed ?? cancelled()); return () => {} }
    const duration = options.timeoutMs ?? 10_000
    const id = String(++nextId)
    const frame: Frame = { type: 'req', id, method, params, deadline: Date.now() + duration }
    if (!Number.isFinite(duration) || duration <= 0 || duration > maxDelay || !parseFrame(frame)) {
      pending.fail(invalid()); return () => {}
    }
    const cleanup = () => {
      outgoing.delete(id)
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
    }
    const fail = (error: PluginError, notify: boolean) => {
      if (!outgoing.has(id)) return
      cleanup()
      if (notify) send({ type: 'cancel', id })
      pending.fail(error)
    }
    const abort = () => fail(cancelled(), true)
    const timer = setTimeout(() => fail(timeout(), true), duration)
    options.signal?.addEventListener('abort', abort, { once: true })
    outgoing.set(id, {
      receive(reply) {
        if (reply.type !== 'chunk') cleanup()
        pending.receive(reply)
      },
      fail: error => fail(error, false),
    })
    if (!send(frame)) fail(unavailable(), false)
    return abort
  }

  function errorReply(id: string, error: unknown) {
    const publicError = error instanceof PluginError ? error : internal()
    const frame: Frame = { type: 'res', id, ok: false,
      error: { code: publicError.code, message: publicError.message, retryable: publicError.retryable } }
    send(parseFrame(frame) ? frame : { type: 'res', id, ok: false, error: { code: 'ERR_INTERNAL', message: 'Internal plugin error', retryable: false } })
  }
  function finishIncoming(id: string): void {
    const state = incoming.get(id)
    if (!state) return
    incoming.delete(id)
    clearTimeout(state.timer)
    state.controller.abort()
  }
  async function receiveRequest(frame: Extract<Frame, { type: 'req' }>) {
    if (incoming.has(frame.id)) return
    const remaining = frame.deadline - Date.now()
    if (remaining <= 0) { errorReply(frame.id, timeout()); return }
    const handler = handlers.get(frame.method)
    if (!handler) { errorReply(frame.id, new PluginError('ERR_UNDECLARED', 'Plugin method is not registered')); return }
    const controller = new AbortController()
    const timer = setTimeout(() => {
      finishIncoming(frame.id)
      errorReply(frame.id, timeout())
    }, Math.min(remaining, maxDelay))
    const state = { controller, timer }
    incoming.set(frame.id, state)
    const current = () => incoming.get(frame.id) === state
    const publish = (reply: Frame) => {
      if (!parseFrame(reply) || !send(reply)) throw internal()
    }
    try {
      const result = await handler(frame.params, { signal: controller.signal })
      if (!current()) return
      if (result && typeof (result as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function') {
        for await (const value of result as AsyncIterable<unknown>) {
          if (!current()) return
          publish({ type: 'chunk', id: frame.id, value })
        }
        if (current()) publish({ type: 'end', id: frame.id })
      } else {
        publish({ type: 'res', id: frame.id, ok: true, value: result })
      }
    } catch (error) {
      if (current()) errorReply(frame.id, error)
    } finally {
      if (current()) {
        clearTimeout(state.timer)
        incoming.delete(frame.id)
      }
    }
  }

  const unsubscribe = transport.onFrame(input => {
    if (closed) return
    const frame = parseFrame(input)
    if (!frame) return
    if (frame.type === 'req') void receiveRequest(frame)
    else if (frame.type === 'cancel') finishIncoming(frame.id)
    else outgoing.get(frame.id)?.receive(frame)
  })
  function close(reason = unavailable()): void {
    if (closed) return
    closed = reason
    unsubscribe()
    for (const pending of outgoing.values()) pending.fail(reason)
    for (const id of incoming.keys()) finishIncoming(id)
    handlers.clear()
  }
  return {
    call<T>(method: string, params: unknown, options: RpcOptions = {}) {
      return new Promise<T>((resolve, reject) => {
        let stop: (() => void) | undefined
        stop = request(method, params, options, {
          receive(reply) {
            if (reply.type === 'res' && reply.ok) resolve(reply.value as T)
            else if (reply.type === 'res') reject(new PluginError(reply.error.code, reply.error.message, reply.error.retryable))
            else { reject(invalid()); stop?.() }
          },
          fail: reject,
        })
      })
    },
    async *stream<T>(method: string, params: unknown, options: RpcOptions = {}): AsyncGenerator<T> {
      const values: T[] = []
      let done = false
      let error: PluginError | undefined
      let wake: (() => void) | undefined
      const fail = (failure: PluginError) => { error = failure; done = true; wake?.() }
      const stop = request(method, params, options, {
        receive(reply) {
          if (done) return
          if (reply.type === 'chunk') {
            if (values.length === 256) fail(new PluginError('ERR_RATE_LIMITED', 'Plugin stream buffer is full'))
            else values.push(reply.value as T)
          } else if (reply.type === 'end') done = true
          else if (reply.ok) fail(invalid())
          else fail(new PluginError(reply.error.code, reply.error.message, reply.error.retryable))
          wake?.()
        },
        fail,
      })
      try {
        while (!done || values.length) {
          if (error) throw error
          if (values.length) yield values.shift() as T
          else await new Promise<void>(resolve => { wake = resolve })
        }
        if (error) throw error
      } finally { stop() }
    },
    handle(method, handler) {
      if (closed) throw closed
      if (handlers.has(method)) throw invalid()
      handlers.set(method, handler)
      return () => { if (handlers.get(method) === handler) handlers.delete(method) }
    },
    close,
    dispose: () => close(),
  }
}
