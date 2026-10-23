// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { applyChatAppearance } from "./useChatAppearance";

afterEach(() => {
  document.documentElement.removeAttribute("style");
  for (const name of Object.keys(document.documentElement.dataset)) delete document.documentElement.dataset[name];
});
describe("Chat appearance applied to the window", () => {
  it("supplies font defaults for saved preferences that predate font sizing", () => {
    applyChatAppearance({ chatLineHeight: 1.9 });
    const css = document.documentElement.style;
    expect(["ui", "chat", "code"].map(part => css.getPropertyValue(`--ff-${part}-font-size`)))
      .toStrictEqual(["16px", "14px", "13px"]);
  });
  it("publishes spacing and all three independent font sizes", () => {
    applyChatAppearance({ chatLineHeight: 1.8, chatParaSpacing: 0.9, uiFontSize: 17, chatFontSize: 18, codeFontSize: 14 });
    const values = ["line-height", "para-spacing"].map(part => document.documentElement.style.getPropertyValue(`--ff-chat-${part}`));
    expect(values).toStrictEqual(["1.8", "0.9em"]);
    expect(["ui", "chat", "code"].map(part => document.documentElement.style.getPropertyValue(`--ff-${part}-font-size`)))
      .toStrictEqual(["17px", "18px", "14px"]);
    expect(document.documentElement.dataset).not.toHaveProperty("assistantBubble");
  });
});
