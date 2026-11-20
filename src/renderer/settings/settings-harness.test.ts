// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupSettingsPage, flushMicrotasks, mountSettingsPage } from "./settings-harness.test-support";

describe("settings harness isolation between mounts", () => {
  afterEach(() => {
    cleanupSettingsPage();
    vi.restoreAllMocks();
  });

  it("stops the select and range observers of a cleaned-up mount", async () => {
    await mountSettingsPage();
    cleanupSettingsPage();

    const select = document.createElement("select");
    select.append(new Option("a", "a"));
    const range = document.createElement("input");
    range.type = "range";
    document.body.append(select, range);
    await flushMicrotasks();

    expect(select.classList.contains("ff-select__source")).toBe(false);
    expect(range.dataset.ffRangeFill).toBeUndefined();
  });

  it("leaves only the current mount's search shortcut on the document", async () => {
    await mountSettingsPage();
    cleanupSettingsPage();
    await mountSettingsPage();

    const select = vi.spyOn(HTMLInputElement.prototype, "select");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));

    expect(select).toHaveBeenCalledTimes(1);
  });

  it("fans out single getGeneral() and getConfig() startup IPC reads across all split panels without extra calls", async () => {
    const listModelProfiles = vi.fn(async () => ({ profiles: [], defaultModelProfileId: undefined }));
    const { settings } = await mountSettingsPage({
      general: {
        language: "en",
        toastSoundEnabled: false,
        launchAtLogin: true,
        uiTheme: "firefly-dark",
        uiIcon: "firefly",
        uiFontSize: 15,
        petVisible: false,
        segmentedChatEnabled: false,
        chatSocialContextEnabled: false,
        proactiveChatMode: "on",
        proactiveDeliveryTarget: "wechat",
      },
      config: {
        thinkingOverride: 1,
        disableMaxToken: true,
        stickerEnabled: false,
        stickerSize: "large",
        stickerSimilarityThreshold: 0.72,
        embeddingDimensions: 1024,
      },
      settings: {
        listModelProfiles,
      },
    });

    // 基线固定 8 次 getGeneral（email/search/timeout/desktop-asr 各 1 次 + plugins 3 次 + settings.ts 单次 fan-out 1 次）；
    // 本次新拆出的 general、appearance、preferences/chat 与 preferences/firefly 不增加额外 IPC 调用。
    expect(settings.getGeneral).toHaveBeenCalledTimes(8);
    expect(settings.getConfig).toHaveBeenCalledTimes(1);
    expect(listModelProfiles).toHaveBeenCalledTimes(1);

    // general/panel.ts
    expect(document.querySelector('#language-select .language-option[data-lang="en"]')?.classList.contains("is-active")).toBe(true);
    expect((document.getElementById("toast-sound-enabled") as HTMLInputElement).checked).toBe(false);
    expect((document.getElementById("launch-at-login") as HTMLInputElement).checked).toBe(true);

    // appearance/panel.ts
    expect(document.querySelector('.appearance-theme-option[data-value="firefly-dark"]')?.classList.contains("is-active")).toBe(true);
    expect(document.querySelector('.appearance-icon-option[data-icon="firefly"]')?.classList.contains("is-active")).toBe(true);
    expect((document.getElementById("ui-font-size-input") as HTMLInputElement).value).toBe("15");
    expect((document.getElementById("pet-visible") as HTMLInputElement).checked).toBe(false);

    // preferences/chat-panel.ts
    expect((document.getElementById("segmented-chat-enabled") as HTMLInputElement).checked).toBe(false);
    expect((document.getElementById("chat-social-context-enabled") as HTMLInputElement).checked).toBe(false);
    expect(document.querySelector('#proactive-chat-select .option-block[data-value="on"]')?.classList.contains("is-active")).toBe(true);
    expect(document.getElementById("proactive-delivery-row")?.hidden).toBe(false);
    expect(document.querySelector('#proactive-delivery-select .option-block[data-value="wechat"]')?.classList.contains("is-active")).toBe(true);

    // preferences/firefly-panel.ts + api global toggles
    expect((document.getElementById("sticker-enabled") as HTMLInputElement).checked).toBe(false);
    expect(document.querySelector('#sticker-size .option-block[data-value="large"]')?.classList.contains("is-active")).toBe(true);
    expect((document.getElementById("sticker-threshold-val") as HTMLElement).textContent).toBe("0.72");
    expect((document.getElementById("embedding-dimensions-input") as HTMLInputElement).value).toBe("1024");
    expect((document.getElementById("toggle-enable-thinking") as HTMLInputElement).checked).toBe(true);
    expect((document.getElementById("toggle-disable-max-token") as HTMLInputElement).checked).toBe(true);
  });

  it("split PR 3 panels (general, appearance, preferences/chat, preferences/firefly) issue zero IPC reads during init and hydrate", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { createDefaultGeneralSettings, createDefaultModelSettings } = await import("./settings-harness.test-support");

    vi.resetModules();
    const rawHtml = fs.readFileSync(path.resolve(__dirname, "index.html"), "utf8");
    const bodyMatch = rawHtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    document.body.innerHTML = (bodyMatch ? bodyMatch[1] : rawHtml).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");

    const getGeneral = vi.fn();
    const getConfig = vi.fn();
    Object.assign(window, {
      settings: {
        getGeneral,
        getConfig,
        saveGeneral: vi.fn(),
        saveConfig: vi.fn(),
        setPetAlwaysOnTop: vi.fn(),
        setPetVisible: vi.fn(),
        setPetZoom: vi.fn(),
        pickUiFont: vi.fn(),
        importUiFont: vi.fn(),
        resetUiFont: vi.fn(),
      },
    });

    const [{ initGeneralPanel, hydrateGeneralSettings }, { initAppearancePanel, hydrateAppearanceSettings }, { initChatPreferencesPanel, hydrateChatPreferences }, { initFireflyPanel, hydrateFireflyConfig }] = await Promise.all([
      import("./general/panel"),
      import("./appearance/panel"),
      import("./preferences/chat-panel"),
      import("./preferences/firefly-panel"),
    ]);

    initGeneralPanel();
    initAppearancePanel();
    initChatPreferencesPanel();
    initFireflyPanel();

    hydrateGeneralSettings(createDefaultGeneralSettings({ language: "en", toastSoundEnabled: false, launchAtLogin: true }));
    hydrateAppearanceSettings(createDefaultGeneralSettings({ uiTheme: "firefly-dark", uiFontSize: 15 }));
    hydrateChatPreferences(createDefaultGeneralSettings({ proactiveChatMode: "on", proactiveDeliveryTarget: "wechat" }));
    hydrateFireflyConfig(createDefaultModelSettings({ stickerEnabled: false, stickerSize: "large", embeddingDimensions: 1024 }));
    await flushMicrotasks();

    expect(getGeneral).not.toHaveBeenCalled();
    expect(getConfig).not.toHaveBeenCalled();
    expect(document.querySelector('#language-select .language-option[data-lang="en"]')?.classList.contains("is-active")).toBe(true);
    expect(document.querySelector('.appearance-theme-option[data-value="firefly-dark"]')?.classList.contains("is-active")).toBe(true);
    expect(document.getElementById("proactive-delivery-row")?.hidden).toBe(false);
    expect((document.getElementById("embedding-dimensions-input") as HTMLInputElement).value).toBe("1024");
  });
});
