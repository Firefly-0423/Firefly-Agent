// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHAT_FONT_SIZE_MAX,
  CHAT_FONT_SIZE_MIN,
  CODE_FONT_SIZE_MAX,
  CODE_FONT_SIZE_MIN,
  UI_FONT_SIZE_MAX,
  UI_FONT_SIZE_MIN,
} from "../../shared/chat-appearance";
import { cleanupSettingsPage, flushMicrotasks, mountSettingsPage } from "./settings-harness.test-support";

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
}

describe("settings appearance integration (T1)", () => {
  afterEach(() => {
    cleanupSettingsPage();
  });

  it("hydrates theme/icon/typography, skips redundant theme clicks, and persists theme & icon patches", async () => {
    const { settings } = await mountSettingsPage({
      general: {
        uiTheme: "pearl-white",
        uiIcon: "firefly",
        uiFontSize: 15,
        chatFontSize: 16,
        codeFontSize: 13,
        chatLineHeight: 1.7,
        chatParaSpacing: 0.6,
      },
    });

    const lightBtn = document.querySelector<HTMLButtonElement>('.appearance-theme-option[data-value="pearl-white"]')!;
    const darkBtn = document.querySelector<HTMLButtonElement>('.appearance-theme-option[data-value="firefly-dark"]')!;
    const iconBtn = document.querySelector<HTMLButtonElement>('.appearance-icon-option[data-icon="firefly"]')!;
    const status = byId<HTMLElement>("appearance-save-status");

    expect(lightBtn.classList.contains("is-active")).toBe(true);
    expect(lightBtn.getAttribute("aria-pressed")).toBe("true");
    expect(darkBtn.classList.contains("is-active")).toBe(false);
    expect(byId<HTMLInputElement>("ui-font-size-input").value).toBe("15");
    expect(byId<HTMLInputElement>("chat-font-size-input").value).toBe("16");
    expect(byId<HTMLInputElement>("code-font-size-input").value).toBe("13");
    expect(byId<HTMLElement>("chat-line-height-val").textContent).toBe("1.70");
    expect(byId<HTMLElement>("chat-para-spacing-val").textContent).toBe("0.60em");

    lightBtn.click();
    await flushMicrotasks();
    expect(settings.saveGeneral).not.toHaveBeenCalled();

    darkBtn.click();
    await flushMicrotasks();
    expect(settings.saveGeneral).toHaveBeenCalledExactlyOnceWith({ uiTheme: "firefly-dark" });
    expect(darkBtn.classList.contains("is-active")).toBe(true);
    expect(darkBtn.getAttribute("aria-checked")).toBe("true");
    expect(darkBtn.getAttribute("aria-pressed")).toBe("true");
    expect(lightBtn.classList.contains("is-active")).toBe(false);
    expect(lightBtn.getAttribute("aria-checked")).toBe("false");
    expect(lightBtn.getAttribute("aria-pressed")).toBe("false");
    expect(status.textContent).toBe("主题已应用");
    expect(status.classList.contains("is-ok")).toBe(true);
    expect(status.classList.contains("is-error")).toBe(false);

    iconBtn.click();
    await flushMicrotasks();
    expect(settings.saveGeneral).toHaveBeenLastCalledWith({ uiIcon: "firefly" });
    expect(iconBtn.classList.contains("is-active")).toBe(true);
    expect(status.textContent).toBe("图标已应用");
    expect(status.classList.contains("is-ok")).toBe(true);
  });

  it("rolls back theme UI and reports failure status when saveGeneral rejects", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const saveGeneral = vi.fn().mockRejectedValueOnce(new Error("disk write failed"));
    await mountSettingsPage({
      general: { uiTheme: "pearl-white" },
      settings: { saveGeneral },
    });

    const lightBtn = document.querySelector<HTMLButtonElement>('.appearance-theme-option[data-value="pearl-white"]')!;
    const darkBtn = document.querySelector<HTMLButtonElement>('.appearance-theme-option[data-value="firefly-dark"]')!;
    const iconBtn = document.querySelector<HTMLButtonElement>('.appearance-icon-option[data-icon="firefly"]')!;
    const status = byId<HTMLElement>("appearance-save-status");

    darkBtn.click();
    await flushMicrotasks();

    expect(saveGeneral).toHaveBeenCalledExactlyOnceWith({ uiTheme: "firefly-dark" });
    expect(lightBtn.classList.contains("is-active")).toBe(true);
    expect(lightBtn.getAttribute("aria-checked")).toBe("true");
    expect(lightBtn.getAttribute("aria-pressed")).toBe("true");
    expect(darkBtn.classList.contains("is-active")).toBe(false);
    expect(darkBtn.getAttribute("aria-checked")).toBe("false");
    expect(status.textContent).toBe("应用主题失败，请重试");
    expect(status.classList.contains("is-error")).toBe(true);
    expect(status.classList.contains("is-ok")).toBe(false);

    saveGeneral.mockRejectedValueOnce(new Error("icon write failed"));
    iconBtn.click();
    await flushMicrotasks();

    expect(saveGeneral).toHaveBeenNthCalledWith(2, { uiIcon: "firefly" });
    expect(status.textContent).toBe("应用图标失败");
    expect(status.classList.contains("is-error")).toBe(true);
    expect(status.classList.contains("is-ok")).toBe(false);
    errorSpy.mockRestore();
  });

  it.each([
    {
      key: "uiFontSize",
      inputId: "ui-font-size-input",
      min: UI_FONT_SIZE_MIN,
      max: UI_FONT_SIZE_MAX,
      initial: 14,
      aboveMax: "99",
      belowMin: "5",
      roundedInput: "15.6",
      roundedExpected: 16,
    },
    {
      key: "chatFontSize",
      inputId: "chat-font-size-input",
      min: CHAT_FONT_SIZE_MIN,
      max: CHAT_FONT_SIZE_MAX,
      initial: 15,
      aboveMax: "99",
      belowMin: "4",
      roundedInput: "17.4",
      roundedExpected: 17,
    },
    {
      key: "codeFontSize",
      inputId: "code-font-size-input",
      min: CODE_FONT_SIZE_MIN,
      max: CODE_FONT_SIZE_MAX,
      initial: 13,
      aboveMax: "99",
      belowMin: "2",
      roundedInput: "14.6",
      roundedExpected: 15,
    },
  ] as const)("clamps, rounds, and validates %s input without saving invalid values", async (spec) => {
    const { settings } = await mountSettingsPage({
      general: {
        uiFontSize: 14,
        chatFontSize: 15,
        codeFontSize: 13,
      },
    });
    const input = byId<HTMLInputElement>(spec.inputId);
    const status = byId<HTMLElement>("appearance-save-status");

    input.value = "16";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(status.textContent).toBe("松开后自动应用");
    if (spec.key === "uiFontSize") {
      expect(document.documentElement.style.getPropertyValue("--ff-ui-font-size")).toBe("16px");
    }
    expect(settings.saveGeneral).not.toHaveBeenCalled();

    input.value = "   ";
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await flushMicrotasks();
    expect(input.value).toBe(String(spec.initial));
    expect(settings.saveGeneral).not.toHaveBeenCalled();

    input.value = spec.aboveMax;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await flushMicrotasks();
    expect(input.value).toBe(String(spec.max));
    expect(settings.saveGeneral).toHaveBeenNthCalledWith(1, { [spec.key]: spec.max });
    expect(status.textContent).toBe("已自动应用");
    expect(status.classList.contains("is-ok")).toBe(true);

    input.value = spec.belowMin;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await flushMicrotasks();
    expect(input.value).toBe(String(spec.min));
    expect(settings.saveGeneral).toHaveBeenNthCalledWith(2, { [spec.key]: spec.min });

    input.value = spec.roundedInput;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await flushMicrotasks();
    expect(input.value).toBe(String(spec.roundedExpected));
    expect(settings.saveGeneral).toHaveBeenNthCalledWith(3, { [spec.key]: spec.roundedExpected });
  });

  it("previews line-height & paragraph-spacing on input and handles change persistence & errors", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { settings } = await mountSettingsPage();
    const status = byId<HTMLElement>("appearance-save-status");

    const lineHeightInput = byId<HTMLInputElement>("chat-line-height");
    const lineHeightVal = byId<HTMLElement>("chat-line-height-val");
    lineHeightInput.value = "1.9";
    lineHeightInput.dispatchEvent(new Event("input", { bubbles: true }));
    expect(lineHeightVal.textContent).toBe("1.90");
    expect(document.documentElement.style.getPropertyValue("--rb-chat-line-height")).toBe("1.9");
    expect(status.textContent).toBe("松开后自动应用");
    expect(settings.saveGeneral).not.toHaveBeenCalled();

    lineHeightInput.dispatchEvent(new Event("change", { bubbles: true }));
    await flushMicrotasks();
    expect(settings.saveGeneral).toHaveBeenCalledExactlyOnceWith({ chatLineHeight: 1.9 });
    expect(status.textContent).toBe("已自动应用");
    expect(status.classList.contains("is-ok")).toBe(true);

    vi.mocked(settings.saveGeneral).mockRejectedValueOnce(new Error("spacing save failed"));
    const paraSpacingInput = byId<HTMLInputElement>("chat-para-spacing");
    const paraSpacingVal = byId<HTMLElement>("chat-para-spacing-val");
    paraSpacingInput.value = "0.95";
    paraSpacingInput.dispatchEvent(new Event("input", { bubbles: true }));
    expect(paraSpacingVal.textContent).toBe("0.95em");
    expect(document.documentElement.style.getPropertyValue("--rb-chat-para-spacing")).toBe("0.95em");

    paraSpacingInput.dispatchEvent(new Event("change", { bubbles: true }));
    await flushMicrotasks();
    expect(settings.saveGeneral).toHaveBeenLastCalledWith({ chatParaSpacing: 0.95 });
    expect(status.textContent).toBe("自动应用失败");
    expect(status.classList.contains("is-error")).toBe(true);
    expect(status.classList.contains("is-ok")).toBe(false);
    errorSpy.mockRestore();
  });

  it("guards canceled font import without calling importUiFont or saveGeneral and handles import/reset flows", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const pickUiFont = vi.fn();
    const importUiFont = vi.fn();
    const resetUiFont = vi.fn();
    const { settings } = await mountSettingsPage({
      settings: { pickUiFont, importUiFont, resetUiFont },
    });

    const importBtn = byId<HTMLButtonElement>("ui-font-import");
    const resetBtn = byId<HTMLButtonElement>("ui-font-reset");
    const fontCurrent = byId<HTMLElement>("ui-font-current");
    const status = byId<HTMLElement>("appearance-save-status");

    pickUiFont.mockResolvedValueOnce(null);
    importBtn.click();
    await flushMicrotasks();

    expect(pickUiFont).toHaveBeenCalledOnce();
    expect(importUiFont).not.toHaveBeenCalled();
    expect(settings.saveGeneral).not.toHaveBeenCalled();
    expect(importBtn.disabled).toBe(false);
    expect(fontCurrent.textContent).toBe("思源黑体（默认）");
    expect(status.classList.contains("is-ok")).toBe(false);
    expect(status.classList.contains("is-error")).toBe(false);

    pickUiFont.mockResolvedValueOnce("C:\\Fonts\\Inter.ttf");
    importUiFont.mockRejectedValueOnce(new Error("corrupt font"));
    importBtn.click();
    await flushMicrotasks();

    expect(importUiFont).toHaveBeenCalledWith("C:\\Fonts\\Inter.ttf");
    expect(settings.saveGeneral).not.toHaveBeenCalled();
    expect(status.textContent).toBe("导入字体失败");
    expect(status.classList.contains("is-error")).toBe(true);
    expect(importBtn.disabled).toBe(false);

    pickUiFont.mockResolvedValueOnce("C:\\Fonts\\JetBrainsMono.ttf");
    importUiFont.mockResolvedValueOnce({
      kind: "custom",
      fileName: "JetBrainsMono.ttf",
      displayName: "JetBrains Mono",
    });
    importBtn.click();
    await flushMicrotasks();

    expect(importUiFont).toHaveBeenNthCalledWith(2, "C:\\Fonts\\JetBrainsMono.ttf");
    expect(settings.saveGeneral).not.toHaveBeenCalled();
    expect(fontCurrent.textContent).toBe("JetBrains Mono");
    expect(resetBtn.hidden).toBe(false);
    expect(status.textContent).toBe("字体已应用");
    expect(status.classList.contains("is-ok")).toBe(true);

    resetUiFont.mockResolvedValueOnce({ kind: "source-han" });
    resetBtn.click();
    await flushMicrotasks();

    expect(resetUiFont).toHaveBeenCalledOnce();
    expect(fontCurrent.textContent).toBe("思源黑体（默认）");
    expect(resetBtn.hidden).toBe(true);
    expect(status.textContent).toBe("已恢复思源黑体");
    expect(status.classList.contains("is-ok")).toBe(true);
    expect(resetBtn.disabled).toBe(false);
    errorSpy.mockRestore();
  });
});
