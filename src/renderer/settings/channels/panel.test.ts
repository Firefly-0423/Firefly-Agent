// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, afterEach, test, expect, vi } from "vitest";
import type { QqListenAuthRequirement } from "../../../shared/qq-listen";

beforeEach(() => {
  vi.resetModules();
  const ids = [...readFileSync(resolve(__dirname, "../index.html"), "utf8").matchAll(/id="([^"]+)"/g)].map(match => match[1]);
  document.body.innerHTML = ids.map(id => `<div id="${id}"></div>`).join("");
  for (const suffix of ["enabled", "custom-host", "token"]) {
    const field = document.createElement("input");
    field.id = `channels-qq-${suffix}`;
    if (suffix === "enabled") field.type = "checkbox";
    document.getElementById(field.id)!.replaceWith(field);
  }
  const selector = document.createElement("select");
  selector.id = "channels-qq-listen-mode";
  selector.innerHTML = ["auto", "wsl", "loopback", "custom"].map(value => `<option value="${value}">${value}</option>`).join("");
  document.getElementById(selector.id)!.replaceWith(selector);
});
afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); });

function connect(requirement: QqListenAuthRequirement) {
  const api = {
    channelsGetConfig: vi.fn(async () => ({ qq: { enabled: true, port: 6431, listenMode: "auto" }, wechat: { enabled: false }, feishu: { enabled: false }, qqbot: { enabled: false } })),
    channelsGetStatus: vi.fn(async () => ({})), channelsLogGet: vi.fn(async () => []), channelsContextBindingsGet: vi.fn(async () => []),
    channelsSaveConfig: vi.fn(async (_config: unknown) => ({})), channelsRestart: vi.fn(async () => ({ ok: true })),
    channelsQqResolveAuthRequirement: vi.fn(async (_request: unknown) => requirement),
    onChannelsInstallProgress: () => () => undefined, onChannelsStatusChanged: () => () => undefined,
    onChannelsWechatQrcode: () => () => undefined, onChannelsWechatLoginDone: () => () => undefined,
  };
  Object.assign(window, { settings: api });
  return api;
}
async function submitQq() {
  const { loadChannelsPanel } = await import("./panel");
  await loadChannelsPanel();
  document.getElementById("channels-qq-save")!.click();
  await new Promise(done => setTimeout(done, 0));
}

test("a missing preload bridge does not poison a subsequent initialization attempt", async () => {
  delete window.settings;
  const module = await import("./panel");
  const { channelsState: state } = await import("./state");
  await expect(module.loadChannelsPanel()).resolves.toEqual(undefined);
  expect(state.initialized).toEqual(false);
  const api = connect({ ok: true, requiresAccessToken: false });
  await module.loadChannelsPanel();
  expect([state.initialized, api.channelsGetConfig.mock.calls.length]).toEqual([true, 1]);
  expect(document.getElementById("channels-overview-summary")!.textContent).toEqual("尚未连接任何渠道");
  expect(document.getElementById("channels-app-status")!.textContent).toEqual("即将推出");
});

test("a required new token is revealed before any config write or restart", async () => {
  const api = connect({ resolvedHost: "172.28.96.1", resolvedMode: "wsl", ok: true, requiresAccessToken: true });
  await submitQq();
  expect(api.channelsQqResolveAuthRequirement.mock.calls).toEqual([[{ customHost: "", listenMode: "auto" }]]);
  const token = document.querySelector<HTMLInputElement>("#channels-qq-token")!.value;
  expect(/^[0-9a-f]{64}$/.test(token)).toBe(true);
  expect(api.channelsSaveConfig.mock.calls).toHaveLength(0);
  expect(api.channelsRestart.mock.calls).toHaveLength(0);
  expect(document.getElementById("channels-qq-feedback")!.textContent).toContain("172.28.96.1");
});

test("a token-free listen address saves the existing mode and port and restarts once", async () => {
  const api = connect({ resolvedHost: "127.0.0.1", resolvedMode: "loopback", ok: true, requiresAccessToken: false });
  await submitQq();
  await vi.waitFor(() => expect(api.channelsRestart).toHaveBeenCalledTimes(1));
  expect(api.channelsSaveConfig).toHaveBeenCalledTimes(1);
  const submitted = api.channelsSaveConfig.mock.calls[0][0] as { qq: Record<string, unknown> };
  expect(submitted.qq).toMatchObject({ port: 6431, listenMode: "auto" });
  expect(submitted.qq.accessToken).toEqual(undefined);
});

test("listen resolution failure explains WSL requirements and blocks persistence", async () => {
  const api = connect({ error: "未检测到 Windows WSL 虚拟网卡 IPv4 地址", ok: false, requiresAccessToken: false });
  await submitQq();
  expect(api.channelsQqResolveAuthRequirement.mock.calls).toHaveLength(1);
  expect(api.channelsSaveConfig.mock.calls).toHaveLength(0);
  expect(document.querySelector("#channels-qq-feedback")!.textContent).toContain("WSL");
});
