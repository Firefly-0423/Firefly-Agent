// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initSenderPanels, parseSenderIds } from "./sender-panel";
import type { SettingsApi } from "../shared/types";

function makeSettings(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    channelsSaveConfig: vi.fn().mockResolvedValue({}),
    channelsGetConfig: vi.fn().mockResolvedValue({ wechat: { allowAnyPrivate: false, allowedSenderIds: ["new@im.wechat"] } }),
    channelsSenderResolve: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  } as unknown as SettingsApi & {
    channelsSaveConfig: ReturnType<typeof vi.fn>;
    channelsSenderResolve: ReturnType<typeof vi.fn>;
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  document.body.innerHTML = '<div id="channels-wechat-senders"></div><div id="channels-feishu-senders"></div>';
});

describe("parseSenderIds", () => {
  it("splits on whitespace and commas, dedupes and drops malformed ids", () => {
    expect(parseSenderIds("a@im.wechat, b@im.wechat\na@im.wechat <x> ou_1")).toEqual(["a@im.wechat", "b@im.wechat", "ou_1"]);
  });
});

describe("sender panel", () => {
  it("shows stranger names as plain text, never as markup", () => {
    const settings = makeSettings();
    const panels = initSenderPanels(settings);
    panels.renderStatus({
      wechat: { detail: { pendingSenders: [{ senderId: "x@im.wechat", senderName: "<img src=x onerror=alert(1)>", at: 1 }] } },
    });
    const root = document.getElementById("channels-wechat-senders")!;
    expect(root.querySelector("img")).toBeNull();
    expect(root.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(document.getElementById("channels-feishu-senders")!.textContent).toContain("暂无待批准");
  });

  it("approves through IPC and refreshes the allowlist", async () => {
    const settings = makeSettings();
    const panels = initSenderPanels(settings);
    panels.renderStatus({ wechat: { detail: { pendingSenders: [{ senderId: "new@im.wechat", at: 1 }] } } });
    const approve = [...document.querySelectorAll<HTMLButtonElement>("#channels-wechat-senders button")]
      .find((b) => b.textContent === "批准")!;
    approve.click();
    await flush();
    expect(settings.channelsSenderResolve).toHaveBeenCalledWith({ channel: "wechat", senderId: "new@im.wechat", action: "approve" });
    const textarea = document.querySelector<HTMLTextAreaElement>("#channels-wechat-senders textarea")!;
    expect(textarea.value).toBe("new@im.wechat");
  });

  it("saves the toggle and allowlist for the right channel", async () => {
    const settings = makeSettings();
    const panels = initSenderPanels(settings);
    panels.fillConfig({ feishu: { allowAnyPrivate: true, allowedSenderIds: [] } });
    const root = document.getElementById("channels-feishu-senders")!;
    expect(root.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true);
    root.querySelector<HTMLTextAreaElement>("textarea")!.value = "ou_a\nou_b";
    root.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked = false;
    root.querySelector<HTMLButtonElement>('button[data-role="save"]')!.click();
    await flush();
    expect(settings.channelsSaveConfig).toHaveBeenCalledWith({ feishu: { allowAnyPrivate: false, allowedSenderIds: ["ou_a", "ou_b"] } });
  });
});
