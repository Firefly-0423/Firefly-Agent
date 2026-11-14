// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupSettingsPage, flushMicrotasks, mountSettingsPage } from "./settings-harness.test-support";

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
}

function stickerSizeBtn(size: "small" | "standard" | "large"): HTMLButtonElement {
  const btn = document.querySelector<HTMLButtonElement>(`#sticker-size .option-block[data-value="${size}"]`);
  if (!btn) throw new Error(`Missing sticker size option ${size}`);
  return btn;
}

describe("settings firefly panel integration (T3)", () => {
  afterEach(() => {
    cleanupSettingsPage();
  });

  it("hydrates sticker & embeddingDimensions controls, syncs #sticker-send-status, and saves only on submit", async () => {
    const { settings } = await mountSettingsPage({
      config: {
        stickerEnabled: false,
        stickerSize: "small",
        stickerSimilarityThreshold: 0.4,
        embeddingDimensions: 1536,
      },
    });

    const form = byId<HTMLFormElement>("firefly-panel");
    const enabledInput = byId<HTMLInputElement>("sticker-enabled");
    const sendStatus = byId<HTMLElement>("sticker-send-status");
    const thresholdInput = byId<HTMLInputElement>("sticker-threshold");
    const thresholdVal = byId<HTMLElement>("sticker-threshold-val");
    const dimensionsInput = byId<HTMLInputElement>("embedding-dimensions-input");
    const saveStatus = byId<HTMLElement>("firefly-save-status");

    expect(enabledInput.checked).toBe(false);
    expect(sendStatus.textContent).toBe("发送状态：不发送表情包");
    expect(sendStatus.dataset.i18n).toBe("settings.panel.firefly.sticker.sendDisabled");
    expect(stickerSizeBtn("small").classList.contains("is-active")).toBe(true);
    expect(thresholdInput.value).toBe("0.4");
    expect(thresholdVal.textContent).toBe("0.40");
    expect(dimensionsInput.value).toBe("1536");

    enabledInput.checked = true;
    enabledInput.dispatchEvent(new Event("change", { bubbles: true }));
    expect(sendStatus.textContent).toBe("发送状态：允许发送表情包");
    expect(sendStatus.dataset.i18n).toBe("settings.panel.firefly.sticker.sendEnabled");
    expect(saveStatus.textContent).toBe("有未保存的更改");
    expect(settings.saveConfig).not.toHaveBeenCalled();

    stickerSizeBtn("large").click();
    expect(stickerSizeBtn("large").classList.contains("is-active")).toBe(true);
    expect(stickerSizeBtn("small").classList.contains("is-active")).toBe(false);
    expect(settings.saveConfig).not.toHaveBeenCalled();

    thresholdInput.value = "0.8";
    thresholdInput.dispatchEvent(new Event("input", { bubbles: true }));
    expect(thresholdVal.textContent).toBe("0.80");
    expect(settings.saveConfig).not.toHaveBeenCalled();

    dimensionsInput.value = "1024";
    dimensionsInput.dispatchEvent(new Event("input", { bubbles: true }));
    expect(settings.saveConfig).not.toHaveBeenCalled();

    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flushMicrotasks();

    expect(settings.saveConfig).toHaveBeenCalledExactlyOnceWith({
      stickerEnabled: true,
      stickerSize: "large",
      stickerSimilarityThreshold: 0.8,
      embeddingDimensions: 1024,
    });
    expect(saveStatus.textContent).toBe("已保存");
    expect(saveStatus.classList.contains("is-ok")).toBe(true);
    expect(saveStatus.classList.contains("is-error")).toBe(false);
  });

  it.each([
    { entered: "", expected: undefined },
    { entered: "0", expected: undefined },
    { entered: "-16", expected: undefined },
    { entered: "not-a-number", expected: undefined },
    { entered: "0.4", expected: 1 },
    { entered: "256.7", expected: 257 },
    { entered: "70000", expected: 65536 },
  ])("normalizes embeddingDimensions input $entered to $expected on submit", async ({ entered, expected }) => {
    const { settings } = await mountSettingsPage({
      config: {
        stickerEnabled: true,
        stickerSize: "standard",
        stickerSimilarityThreshold: 0.55,
      },
    });

    const form = byId<HTMLFormElement>("firefly-panel");
    const dimensionsInput = byId<HTMLInputElement>("embedding-dimensions-input");
    dimensionsInput.value = entered;

    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flushMicrotasks();

    expect(settings.saveConfig).toHaveBeenCalledExactlyOnceWith({
      stickerEnabled: true,
      stickerSize: "standard",
      stickerSimilarityThreshold: 0.55,
      embeddingDimensions: expected,
    });
  });

  it("reports saveFailed error state when fireflyPanel submission rejects", async () => {
    const saveConfig = vi.fn().mockRejectedValueOnce(new Error("config write failed"));
    await mountSettingsPage({
      config: {
        stickerEnabled: false,
        stickerSize: "standard",
        stickerSimilarityThreshold: 0.55,
      },
      settings: { saveConfig },
    });

    const form = byId<HTMLFormElement>("firefly-panel");
    const enabledInput = byId<HTMLInputElement>("sticker-enabled");
    const saveStatus = byId<HTMLElement>("firefly-save-status");

    enabledInput.checked = true;
    enabledInput.dispatchEvent(new Event("change", { bubbles: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flushMicrotasks();

    expect(saveConfig).toHaveBeenCalledOnce();
    expect(saveStatus.textContent).toBe("保存失败");
    expect(saveStatus.classList.contains("is-error")).toBe(true);
    expect(saveStatus.classList.contains("is-ok")).toBe(false);
  });
});
