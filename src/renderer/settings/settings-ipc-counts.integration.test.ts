// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanupSettingsPage, flushMicrotasks, mountSettingsPage } from "./settings-harness.test-support";

afterEach(cleanupSettingsPage);

it("keeps the baseline cold-start bridge call counts while hydrating API and general domains", async () => {
  const { settings } = await mountSettingsPage({ settings: { listModelProfiles: vi.fn(async () => ({ profiles: [] })) } });
  await flushMicrotasks(30);
  const counts = Object.fromEntries(Object.entries(settings)
    .filter(([, value]) => vi.isMockFunction(value) && value.mock.calls.length)
    .map(([name, value]) => [name, vi.mocked(value as () => unknown).mock.calls.length]));
  expect(counts).toEqual({ getGeneral: 8, getConfig: 1, getTimeoutSettings: 1, onSwitchSection: 1, listMcpServers: 1, channelsGetConfig: 1, channelsLogGet: 1, channelsContextBindingsGet: 1, onChannelsInstallProgress: 1, onChannelsWechatQrcode: 1, onChannelsWechatLoginDone: 1, channelsGetStatus: 2, onChannelsStatusChanged: 2, listModelProfiles: 1 });
  expect(settings.getConfig).toHaveBeenCalledTimes(1);
});
