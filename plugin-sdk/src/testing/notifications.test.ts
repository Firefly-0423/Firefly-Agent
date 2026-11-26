import { afterEach, expect, it, vi } from 'vitest';
import type { PluginContext } from '../types';
import { createTestHost } from './index';

afterEach(() => vi.useRealTimers());

async function fixture(permissions = ['notifications'], notificationsSupported = true) {
  let ctx!: PluginContext;
  const host = createTestHost({ manifest: { id: 'dev.test.notice', name: '真实插件', permissions }, notificationsSupported });
  await host.activate({ activate(c) { ctx = c; } });
  return { host, ctx };
}

it('records sanitized notifications with the real plugin name prefix', async () => {
  const { host, ctx } = await fixture();
  await expect(ctx.notifications.show({ title: '〔Firefly〕\u202e标题', body: '提\n醒' })).resolves.toEqual({ shown: true });
  expect(host.notifications).toEqual([{ title: '〔真实插件〕〔Firefly〕标题', body: '提醒' }]);
});

it('rejects undeclared and revoked permissions without showing notifications', async () => {
  const undeclared = await fixture([]);
  await expect(undeclared.ctx.notifications.show({ title: 'a', body: 'b' })).rejects.toMatchObject({ code: 'ERR_UNDECLARED' });
  expect(undeclared.host.notifications).toEqual([]);
  const { host, ctx } = await fixture();
  host.revokePermission('notifications');
  await expect(ctx.notifications.show({ title: 'a', body: 'b' })).rejects.toMatchObject({ code: 'ERR_PERMISSION' });
  expect(host.notifications).toEqual([]);
});

it('returns shown false when notifications are unsupported', async () => {
  const { host, ctx } = await fixture(['notifications'], false);
  await expect(ctx.notifications.show({ title: 'a', body: 'b' })).resolves.toEqual({ shown: false });
  expect(host.notifications).toEqual([]);
});

it('rejects overlong notification text without showing or consuming quota', async () => {
  const { host, ctx } = await fixture();
  await expect(ctx.notifications.show({ title: '😀'.repeat(65), body: 'b' })).rejects.toMatchObject({ code: 'ERR_INVALID_ARGUMENT' });
  await expect(ctx.notifications.show({ title: 'a', body: '😀'.repeat(257) })).rejects.toMatchObject({ code: 'ERR_INVALID_ARGUMENT' });
  expect(host.notifications).toEqual([]);
  for (let i = 0; i < 5; i++) await ctx.notifications.show({ title: '😀'.repeat(64), body: '😀'.repeat(256) });
  expect(host.notifications).toHaveLength(5);
});

it('enforces five notifications per minute and prevents stale contexts from showing', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const { host, ctx } = await fixture();
  for (let i = 0; i < 5; i++) await ctx.notifications.show({ title: 'a', body: 'b' });
  await expect(ctx.notifications.show({ title: 'a', body: 'b' })).rejects.toMatchObject({ code: 'ERR_RATE_LIMITED', retryable: true });
  expect(host.notifications).toHaveLength(5);
  vi.setSystemTime(60_000);
  await expect(ctx.notifications.show({ title: 'a', body: 'b' })).resolves.toEqual({ shown: true });
  await host.deactivate();
  await expect(ctx.notifications.show({ title: 'a', body: 'b' })).rejects.toMatchObject({ code: 'ERR_UNAVAILABLE' });
  expect(host.notifications).toHaveLength(6);
});
