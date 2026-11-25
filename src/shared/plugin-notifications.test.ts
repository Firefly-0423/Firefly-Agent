import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPluginNotificationLimiter, parsePluginNotification } from './plugin-notifications'

afterEach(() => vi.useRealTimers())

describe('plugin notification text', () => {
  it.each([63, 64])('accepts %i Unicode code points in title', length => {
    expect(parsePluginNotification({ title: '😀'.repeat(length), body: '文'.repeat(256) })).toEqual({ title: '😀'.repeat(length), body: '文'.repeat(256) })
  })
  it.each([255, 256])('accepts %i Unicode code points in body', length => {
    expect(parsePluginNotification({ title: '', body: '😀'.repeat(length) })).toEqual({ title: '', body: '😀'.repeat(length) })
  })
  it.each([{ title: '文'.repeat(65), body: '' }, { title: '', body: '😀'.repeat(257) }, { title: 1, body: '' }, { title: '', body: '', icon: 'x' }])('rejects invalid text or unsupported fields: %j', input => {
    expect(() => parsePluginNotification(input)).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARGUMENT' }))
  })
  it('removes control and format characters before measuring text', () => {
    expect(parsePluginNotification({ title: '\u0000\u202e' + '文'.repeat(64), body: 'a\n\t\u007f\u0085\u2066b' })).toEqual({ title: '文'.repeat(64), body: 'ab' })
  })
  it('rejects accessors without executing plugin code', () => {
    const getter = vi.fn(() => 'title')
    expect(() => parsePluginNotification({ get title() { return getter() }, body: '' })).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARGUMENT' }))
    expect(getter).not.toHaveBeenCalled()
  })
})

it('allows five notifications per plugin and restores quota exactly at one minute', () => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  const take = createPluginNotificationLimiter()
  for (let i = 0; i < 5; i++) take('a')
  expect(() => take('a')).toThrow(expect.objectContaining({ code: 'ERR_RATE_LIMITED', retryable: true }))
  expect(() => take('b')).not.toThrow()
  vi.setSystemTime(59_999)
  expect(() => take('a')).toThrow(expect.objectContaining({ code: 'ERR_RATE_LIMITED' }))
  vi.setSystemTime(60_000)
  expect(() => take('a')).not.toThrow()
})
