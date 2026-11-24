import { describe, expect, it } from 'vitest'
import {
  PLUGIN_TO_HOST_METHODS,
  parseFrame,
  PluginError,
  type PluginToHostParams,
  type PluginToHostResults,
} from './plugin-protocol'

const valid = [
  { type: 'req', id: '1', method: 'activate', params: { bytes: new Uint8Array([1]) }, deadline: 123 },
  { type: 'res', id: '1', ok: true, value: undefined },
  { type: 'res', id: '1', ok: false, error: { code: 'ERR_PERMISSION', message: 'Denied', retryable: false } },
  { type: 'cancel', id: '1' }, { type: 'chunk', id: '1', value: ['a'] }, { type: 'end', id: '1' }
]

describe('parseFrame', () => {
  it.each(valid)('accepts $type with its exact payload', (frame) => expect(parseFrame(frame)).toEqual(frame))
  it.each(valid)('rejects extra fields in $type', (frame) => expect(parseFrame({ ...frame, unexpected: true })).toBeNull())
  it.each([
    null, [], {}, { type: 'unknown', id: '1' }, ...valid.map(frame => ({ ...frame, id: 1 })),
    ...valid.map(frame => ({ ...frame, id: '' })),
    { type: 'req', id: '1', method: '', params: {}, deadline: 1 },
    { type: 'req', id: '1', method: 'a', deadline: 1 },
    ...[NaN, Infinity, -1, '123'].map(deadline => ({ type: 'req', id: '1', method: 'a', params: {}, deadline })),
    { type: 'res', id: '1', ok: true },
    { type: 'res', id: '1', ok: 'true', value: 1 },
    { type: 'res', id: '1', ok: false, error: { code: 'ERR_FAKE', message: '', retryable: false } },
    { type: 'res', id: '1', ok: false, error: { code: 'ERR_INTERNAL', message: '', retryable: 'false' } },
    { type: 'res', id: '1', ok: false, error: { code: 'ERR_INTERNAL', message: 1, retryable: false } },
    { type: 'res', id: '1', ok: false, error: { code: 'ERR_INTERNAL', message: '', retryable: false, stack: 'secret' } },
    { type: 'chunk', id: '1' },
    { type: 'chunk', id: '1', value: { nested: () => 'secret' } },
    { type: 'req', id: '1', method: 'a', params: Symbol('x'), deadline: 1 }
  ])('rejects malformed or non-data frame %#', (frame) => expect(parseFrame(frame)).toBeNull())
  it('does not invoke payload accessors or throw for hostile objects', () => {
    let reads = 0
    expect(parseFrame({ type: 'chunk', id: '1', value: { get secret() { reads++; throw Error('secret') } } })).toBeNull()
    expect(reads).toBe(0)
    expect(parseFrame(new Proxy({}, { ownKeys() { throw Error('secret') } }))).toBeNull()
  })
  it.each(['ERR_UNDECLARED', 'ERR_PERMISSION', 'ERR_REJECTED', 'ERR_CANCELLED', 'ERR_TIMEOUT', 'ERR_INVALID_ARGUMENT', 'ERR_RATE_LIMITED', 'ERR_UNAVAILABLE', 'ERR_INTERNAL'])('accepts documented error %s', code => {
    const frame = { type: 'res', id: '1', ok: false, error: { code, message: 'Public', retryable: true } }
    expect(parseFrame(frame)).toEqual(frame)
  })
  it('carries the public error code, retryability, and optional cause', () => {
    const rootCause = new Error('boom')
    const error = new PluginError('ERR_UNAVAILABLE', 'No service', true, rootCause)
    expect(error).toMatchObject({ name: 'PluginError', code: 'ERR_UNAVAILABLE', message: 'No service', retryable: true, cause: rootCause })

    const withOptions = new PluginError('ERR_INTERNAL', 'Wrapped', { retryable: true, cause: rootCause })
    expect(withOptions).toMatchObject({ name: 'PluginError', code: 'ERR_INTERNAL', message: 'Wrapped', retryable: true, cause: rootCause })

    const withoutCause = new PluginError('ERR_INVALID_ARGUMENT', 'Plain')
    expect('cause' in withoutCause).toBe(false)
  })

  it('provides typed parameter and result maps for every PLUGIN_TO_HOST_METHODS entry', () => {
    const sampleParams: PluginToHostParams['events.subscribe'] = { type: 'run.ended' }
    const sampleUnregister: PluginToHostParams['tools.unregister'] = { name: 'echo' }
    const sampleResult: PluginToHostResults['workspace.info'] = {
      sessionId: 's1',
      mode: 'work',
      root: null,
      name: null,
    }
    expect(PLUGIN_TO_HOST_METHODS.toolsUnregister).toBe('tools.unregister')
    expect(PLUGIN_TO_HOST_METHODS.contextUnregister).toBe('context.unregister')
    expect(sampleParams.type).toBe('run.ended')
    expect(sampleUnregister.name).toBe('echo')
    expect(sampleResult?.mode).toBe('work')
  })
})
