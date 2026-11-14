// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupSettingsPage, flushMicrotasks, mountSettingsPage } from "./settings-test-harness";

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
}

function deliveryOption(target: "local" | "wechat" | "feishu"): HTMLButtonElement {
  const btn = document.querySelector<HTMLButtonElement>(`#proactive-delivery-select .option-block[data-value="${target}"]`);
  if (!btn) throw new Error(`Missing delivery option ${target}`);
  return btn;
}

function proactiveModeOption(mode: "off" | "on"): HTMLButtonElement {
  const btn = document.querySelector<HTMLButtonElement>(`#proactive-chat-select .option-block[data-value="${mode}"]`);
  if (!btn) throw new Error(`Missing proactive mode option ${mode}`);
  return btn;
}

describe("settings preferences & channels linkage integration (T2)", () => {
  afterEach(() => {
    cleanupSettingsPage();
  });

  it("hydrates chat preferences and submits full saveGeneral payload without implicit writes", async () => {
    const { settings } = await mountSettingsPage({
      general: {
        segmentedChatEnabled: false,
        chatSocialContextEnabled: false,
        proactiveChatMode: "off",
        proactiveDeliveryTarget: "local",
      },
      settings: {
        channelsGetStatus: vi.fn(async () => ({
          wechat: { phase: "running" },
          feishu: { phase: "running" },
        })),
      },
    });

    const form = byId<HTMLFormElement>("preferences-form");
    const segmented = byId<HTMLInputElement>("segmented-chat-enabled");
    const socialContext = byId<HTMLInputElement>("chat-social-context-enabled");
    const deliveryRow = byId<HTMLElement>("proactive-delivery-row");
    const status = byId<HTMLElement>("preferences-save-status");

    expect(segmented.checked).toBe(false);
    expect(socialContext.checked).toBe(false);
    expect(deliveryRow.hidden).toBe(true);
    expect(proactiveModeOption("off").classList.contains("is-active")).toBe(true);
    expect(deliveryOption("local").classList.contains("is-active")).toBe(true);

    segmented.checked = true;
    segmented.dispatchEvent(new Event("change", { bubbles: true }));
    expect(status.textContent).toBe("有未保存的更改");
    expect(settings.saveGeneral).not.toHaveBeenCalled();

    socialContext.checked = true;
    socialContext.dispatchEvent(new Event("change", { bubbles: true }));
    expect(settings.saveGeneral).not.toHaveBeenCalled();

    proactiveModeOption("on").click();
    expect(deliveryRow.hidden).toBe(false);
    expect(settings.saveGeneral).not.toHaveBeenCalled();

    deliveryOption("wechat").click();
    expect(deliveryOption("wechat").classList.contains("is-active")).toBe(true);
    expect(deliveryOption("wechat").getAttribute("aria-pressed")).toBe("true");
    expect(deliveryOption("local").classList.contains("is-active")).toBe(false);
    expect(settings.saveGeneral).not.toHaveBeenCalled();

    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flushMicrotasks();

    expect(settings.saveGeneral).toHaveBeenCalledExactlyOnceWith({
      chatSocialContextEnabled: true,
      segmentedChatEnabled: true,
      proactiveChatMode: "on",
      proactiveDeliveryTarget: "wechat",
      screenshotHotkey: "Alt+Shift+S",
    });
    expect(status.textContent).toBe("已保存");
    expect(status.classList.contains("is-ok")).toBe(true);
    expect(status.classList.contains("is-error")).toBe(false);
  });

  it("reports saveFailed when preferences form submission rejects", async () => {
    const saveGeneral = vi.fn().mockRejectedValueOnce(new Error("disk write error"));
    await mountSettingsPage({
      general: {
        segmentedChatEnabled: true,
        chatSocialContextEnabled: true,
        proactiveChatMode: "on",
        proactiveDeliveryTarget: "local",
      },
      settings: { saveGeneral },
    });

    const form = byId<HTMLFormElement>("preferences-form");
    const segmented = byId<HTMLInputElement>("segmented-chat-enabled");
    const status = byId<HTMLElement>("preferences-save-status");

    segmented.checked = false;
    segmented.dispatchEvent(new Event("change", { bubbles: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flushMicrotasks();

    expect(saveGeneral).toHaveBeenCalledOnce();
    expect(status.textContent).toBe("保存失败");
    expect(status.classList.contains("is-error")).toBe(true);
    expect(status.classList.contains("is-ok")).toBe(false);
  });

  it("syncs proactive delivery button availability from channelsGetStatus and live onChannelsStatusChanged events", async () => {
    const { settings, emitChannelsStatusChanged } = await mountSettingsPage({
      general: {
        proactiveChatMode: "on",
        proactiveDeliveryTarget: "local",
      },
      settings: {
        channelsGetStatus: vi.fn(async () => ({
          wechat: { phase: "offline" },
          feishu: { phase: "running" },
        })),
      },
    });

    const status = byId<HTMLElement>("preferences-save-status");
    const localBtn = deliveryOption("local");
    const wechatBtn = deliveryOption("wechat");
    const feishuBtn = deliveryOption("feishu");

    expect(settings.channelsGetStatus).toHaveBeenCalled();
    expect(localBtn.disabled).toBe(false);
    expect(wechatBtn.disabled).toBe(true);
    expect(feishuBtn.disabled).toBe(false);

    wechatBtn.click();
    expect(localBtn.classList.contains("is-active")).toBe(true);
    expect(wechatBtn.classList.contains("is-active")).toBe(false);
    expect(status.textContent).not.toBe("有未保存的更改");

    emitChannelsStatusChanged({
      wechat: { phase: "running" },
      feishu: { phase: "offline" },
    });

    expect(localBtn.disabled).toBe(false);
    expect(wechatBtn.disabled).toBe(false);
    expect(feishuBtn.disabled).toBe(true);

    feishuBtn.click();
    expect(localBtn.classList.contains("is-active")).toBe(true);
    expect(feishuBtn.classList.contains("is-active")).toBe(false);
    expect(status.textContent).not.toBe("有未保存的更改");

    wechatBtn.click();
    expect(wechatBtn.classList.contains("is-active")).toBe(true);
    expect(wechatBtn.getAttribute("aria-pressed")).toBe("true");
    expect(status.textContent).toBe("有未保存的更改");
  });

  it("keeps only local delivery enabled when startup channelsGetStatus rejects and still updates on live status events", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { emitChannelsStatusChanged } = await mountSettingsPage({
        general: {
          proactiveChatMode: "on",
          proactiveDeliveryTarget: "local",
        },
        settings: {
          channelsGetStatus: vi.fn().mockRejectedValue(new Error("channels offline")),
        },
      });

      expect(deliveryOption("local").disabled).toBe(false);
      expect(deliveryOption("wechat").disabled).toBe(true);
      expect(deliveryOption("feishu").disabled).toBe(true);

      emitChannelsStatusChanged({
        wechat: { phase: "running" },
        feishu: { phase: "offline" },
      });

      expect(deliveryOption("local").disabled).toBe(false);
      expect(deliveryOption("wechat").disabled).toBe(false);
      expect(deliveryOption("feishu").disabled).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
