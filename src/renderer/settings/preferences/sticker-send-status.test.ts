// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { setLocale } from "../i18n";
import { renderStickerSendStatus } from "./sticker-send-status";

describe("sticker send status copy follows the switch", () => {
  afterEach(() => setLocale("zh-CN"));

  it("says stickers are allowed when the switch is on and not sent when it is off", () => {
    const status = document.createElement("span");
    renderStickerSendStatus(status, true);
    expect(status.textContent).toBe("发送状态：允许发送表情包");
    expect(status.dataset.i18n).toBe("settings.panel.firefly.sticker.sendEnabled");

    renderStickerSendStatus(status, false);
    expect(status.textContent).toBe("发送状态：不发送表情包");
    expect(status.dataset.i18n).toBe("settings.panel.firefly.sticker.sendDisabled");
  });

  it("keeps the matching English wording after a locale switch", () => {
    setLocale("en");
    const status = document.createElement("span");
    renderStickerSendStatus(status, false);
    expect(status.textContent).toBe("Send status: stickers not sent");
    renderStickerSendStatus(status, true);
    expect(status.textContent).toBe("Send status: stickers allowed");
  });
});
