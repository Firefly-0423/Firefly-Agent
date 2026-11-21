import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRpcEndpoint, type RpcTransport } from './plugin-rpc'
import { PluginError, type Frame } from './plugin-protocol'

function pair() {
  const listeners = [new Set<(frame: unknown) => void>(), new Set<(frame: unknown) => void>()]
  const sent: Frame[][] = [[], []]
  const endpoints = [0, 1].map(side => createRpcEndpoint({
    post(frame) { sent[side].push(frame); for (const cb of listeners[1 - side]) cb(structuredClone(frame)) },
    onFrame(cb) { listeners[side].add(cb); return () => { listeners[side].delete(cb) } }
  } satisfies RpcTransport))
  return { a: endpoints[0], b: endpoints[1], sent, listeners }
}
afterEach(() => vi.useRealTimers())

describe('plugin RPC', () => {
  it('routes simultaneous opposite-direction calls with independently allocated IDs', async () => {
    const { a, b } = pair()
    a.handle('echo', value => ({ from: 'a', value }))
    b.handle('echo', value => ({ from: 'b', value }))
    expect(await Promise.all([a.call('echo', 1), b.call('echo', 2)])).toEqual([{ from: 'b', value: 1 }, { from: 'a', value: 2 }])
    a.dispose(); b.dispose()
  })
  it('times out exactly at the deadline and sends cancellation to the handler', async () => {
    vi.useFakeTimers()
    const { a, b, sent } = pair()
    let signal: AbortSignal | undefined
    b.handle('wait', (_, ctx) => { signal = ctx.signal; return new Promise(() => {}) })
    const result = a.call('wait', null, { timeoutMs: 20 }).catch(error => error)
    await vi.advanceTimersByTimeAsync(19)
    expect(signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await result).toMatchObject({ code: 'ERR_TIMEOUT' })
    expect(signal?.aborted).toBe(true)
    expect(sent[0].filter(frame => frame.type === 'cancel')).toEqual([{ type: 'cancel', id: '1' }])
    a.dispose(); b.dispose()
  })
  it('aborts a remote handler when caller cancels and ignores its eventual result', async () => {
    const { a, b, sent } = pair()
    let signal: AbortSignal | undefined
    let finish!: (value: unknown) => void
    b.handle('wait', (_, ctx) => { signal = ctx.signal; return new Promise(resolve => { finish = resolve }) })
    const controller = new AbortController()
    const result = a.call('wait', null, { signal: controller.signal }).catch(error => error)
    controller.abort()
    expect(await result).toMatchObject({ code: 'ERR_CANCELLED' })
    expect(signal?.aborted).toBe(true)
    finish('late'); await Promise.resolve(); await Promise.resolve()
    expect(sent[1]).toEqual([])
    a.dispose(); b.dispose()
  })
  it('does not send a request for an already aborted signal', async () => {
    const { a, b, sent } = pair()
    const controller = new AbortController(); controller.abort()
    await expect(a.call('x', null, { signal: controller.signal })).rejects.toMatchObject({ code: 'ERR_CANCELLED' })
    expect(sent[0]).toEqual([])
    a.dispose(); b.dispose()
  })
  it('returns ERR_UNDECLARED for an unregistered or removed method', async () => {
    const { a, b } = pair()
    const remove = b.handle('x', () => 1); remove()
    await expect(a.call('x', null)).rejects.toMatchObject({ code: 'ERR_UNDECLARED' })
    a.dispose(); b.dispose()
  })
  it('preserves public PluginError but redacts ordinary exception messages and stacks', async () => {
    const { a, b, sent } = pair()
    b.handle('public', () => { throw new PluginError('ERR_PERMISSION', 'Denied', true) })
    b.handle('secret', () => { throw Error('API_KEY=secret') })
    await expect(a.call('public', null)).rejects.toMatchObject({ code: 'ERR_PERMISSION', message: 'Denied', retryable: true })
    await expect(a.call('secret', null)).rejects.toMatchObject({ code: 'ERR_INTERNAL' })
    expect(JSON.stringify(sent[1])).not.toContain('API_KEY')
    expect(sent[1][1]).toEqual({ type: 'res', id: '2', ok: false, error: { code: 'ERR_INTERNAL', message: 'Internal plugin error', retryable: false } })
    a.dispose(); b.dispose()
  })
  it('streams ordered chunks and ends without a scalar response', async () => {
    const { a, b, sent } = pair()
    b.handle('stream', async function* () { yield 'a'; yield new Uint8Array([2]) })
    const chunks: unknown[] = []
    for await (const value of a.stream('stream', null)) chunks.push(value)
    expect(chunks).toEqual(['a', new Uint8Array([2])])
    expect(sent[1]).toEqual([{ type: 'chunk', id: '1', value: 'a' }, { type: 'chunk', id: '1', value: new Uint8Array([2]) }, { type: 'end', id: '1' }])
    a.dispose(); b.dispose()
  })
  it('cancels the remote streaming handler when the consumer returns early', async () => {
    const { a, b, sent } = pair()
    let signal: AbortSignal | undefined
    b.handle('stream', async function* (_, ctx) { signal = ctx.signal; yield 1; await new Promise(() => {}) })
    for await (const value of a.stream('stream', null)) { expect(value).toBe(1); break }
    expect(signal?.aborted).toBe(true)
    expect(sent[0].at(-1)).toEqual({ type: 'cancel', id: '1' })
    a.dispose(); b.dispose()
  })
  it('close rejects calls and stream readers, aborts handlers, removes listeners and timers', async () => {
    vi.useFakeTimers()
    const { a, b, listeners } = pair()
    let signal: AbortSignal | undefined
    a.handle('wait', (_, ctx) => { signal = ctx.signal; return new Promise(() => {}) })
    b.handle('wait', () => new Promise(() => {}))
    const call = a.call('wait', null).catch(error => error)
    const stream = a.stream('wait', null)[Symbol.asyncIterator]().next().catch(error => error)
    const inbound = b.call('wait', null).catch(error => error)
    a.close()
    expect(await call).toMatchObject({ code: 'ERR_UNAVAILABLE' })
    expect(await stream).toMatchObject({ code: 'ERR_UNAVAILABLE' })
    expect(signal?.aborted).toBe(true)
    expect(listeners[0].size).toBe(0)
    await expect(a.call('wait', null)).rejects.toMatchObject({ code: 'ERR_UNAVAILABLE' })
    b.close(); await inbound
    expect(vi.getTimerCount()).toBe(0)
  })
  it('rejects non-data outgoing params without invoking remote handlers', async () => {
    const { a, b, sent } = pair()
    await expect(a.call('x', { f() {} })).rejects.toMatchObject({ code: 'ERR_INVALID_ARGUMENT' })
    expect(sent[0]).toEqual([])
    a.dispose(); b.dispose()
  })
  it('maps a failed transport send to unavailable without disclosing its error', async () => {
    const rpc = createRpcEndpoint({ post() { throw Error('password') }, onFrame() { return () => {} } })
    await expect(rpc.call('x', null)).rejects.toMatchObject({ code: 'ERR_UNAVAILABLE' })
    rpc.dispose()
  })
})
