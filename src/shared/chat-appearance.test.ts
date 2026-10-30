import { describe, expect, it } from "vitest";
import { CODE_FONT_STACKS, DEFAULT_CHAT_APPEARANCE, normalizeChatAppearance, normalizeChatDisplay } from "./chat-appearance";

describe("normalizeChatAppearance", () => {
  it("keeps in-range values and drops fields it does not know about", () => {
    expect(normalizeChatAppearance({
      chatLineHeight: 1.6,
      chatParaSpacing: 0.8,
      uiFontSize: 15,
      chatFontSize: 16,
      codeFontSize: 12,
      assistantBubbleEnabled: true,
    })).toEqual({
      chatLineHeight: 1.6,
      chatParaSpacing: 0.8,
      uiFontSize: 15,
      chatFontSize: 16,
      codeFontSize: 12,
      reduceMotion: "system",
      codeFont: "system",
      fullWidthChat: false,
      diffMarkers: "color",
      pointerCursor: false,
      smartPunctuation: false,
      codeThemeLight: "firefly",
      codeThemeDark: "firefly",
    });
  });

  it("uses the current real defaults for invalid input", () => {
    expect(normalizeChatAppearance(null)).toEqual(DEFAULT_CHAT_APPEARANCE);
    expect(normalizeChatAppearance({ chatLineHeight: "wide", uiFontSize: Number.NaN })).toEqual(DEFAULT_CHAT_APPEARANCE);
    expect(DEFAULT_CHAT_APPEARANCE).toEqual({
      chatLineHeight: 1.75,
      chatParaSpacing: 0.5,
      uiFontSize: 16,
      chatFontSize: 14,
      codeFontSize: 13,
      reduceMotion: "system",
      codeFont: "system",
      fullWidthChat: false,
      diffMarkers: "color",
      pointerCursor: false,
      smartPunctuation: false,
      codeThemeLight: "firefly",
      codeThemeDark: "firefly",
    });
  });

  it("shows Chat replies as segments unless the stored switch is off", () => {
    expect(normalizeChatDisplay({ segmentedChatEnabled: false }).segmentedChat).toBe(false);
    expect(normalizeChatDisplay({ segmentedChatEnabled: true }).segmentedChat).toBe(true);
    expect(normalizeChatDisplay({}).segmentedChat).toBe(true);
    // Preload normalizes and the renderer normalizes the result again; the choice must survive both.
    expect(normalizeChatDisplay(normalizeChatDisplay({ segmentedChatEnabled: false })).segmentedChat).toBe(false);
  });

  it("keeps segmented output out of the appearance settings, so an appearance reset cannot change it", () => {
    expect(DEFAULT_CHAT_APPEARANCE).not.toHaveProperty("segmentedChat");
    expect(normalizeChatAppearance({ segmentedChatEnabled: false })).not.toHaveProperty("segmentedChat");
  });

  it("clamps the font sizes to their supported ranges", () => {
    expect(normalizeChatAppearance({ uiFontSize: 4 }).uiFontSize).toBe(12);
    expect(normalizeChatAppearance({ uiFontSize: 99 }).uiFontSize).toBe(20);
    expect(normalizeChatAppearance({ chatFontSize: 1 }).chatFontSize).toBe(12);
    expect(normalizeChatAppearance({ chatFontSize: 99 }).chatFontSize).toBe(22);
    expect(normalizeChatAppearance({ codeFontSize: 1 }).codeFontSize).toBe(11);
    expect(normalizeChatAppearance({ codeFontSize: 99 }).codeFontSize).toBe(20);
  });

  it("rounds font sizes to whole pixels and clamps spacing to its slider range", () => {
    expect(normalizeChatAppearance({ chatFontSize: 14.6 }).chatFontSize).toBe(15);
    expect(normalizeChatAppearance({ chatParaSpacing: 0 }).chatParaSpacing).toBe(0.2);
    expect(normalizeChatAppearance({ chatParaSpacing: 3 }).chatParaSpacing).toBe(1.2);
    expect(normalizeChatAppearance({ chatLineHeight: 9 }).chatLineHeight).toBe(3);
  });

  it("reads a legacy archive that only stored the line height and fills in the rest", () => {
    expect(normalizeChatAppearance({ chatLineHeight: 1.6, windowCornerRadius: 24 })).toEqual({
      ...DEFAULT_CHAT_APPEARANCE,
      chatLineHeight: 1.6,
    });
  });

  it("keeps the advanced preferences it knows and falls back for anything else", () => {
    expect(normalizeChatAppearance({ reduceMotion: "on", codeFont: "jetbrains", fullWidthChat: true, diffMarkers: "signs", pointerCursor: true, smartPunctuation: true }))
      .toMatchObject({ reduceMotion: "on", codeFont: "jetbrains", fullWidthChat: true, diffMarkers: "signs", pointerCursor: true, smartPunctuation: true });
    expect(normalizeChatAppearance({ reduceMotion: "always", codeFont: "Comic Sans", fullWidthChat: "yes", diffMarkers: 1 }))
      .toMatchObject({ reduceMotion: "system", codeFont: "system", fullWidthChat: false, diffMarkers: "color" });
  });
});

it("keeps a known code theme for each scheme and falls back to Firefly's own for anything else", () => {
  expect(normalizeChatAppearance({ codeThemeLight: "github", codeThemeDark: "nord" })).toMatchObject({ codeThemeLight: "github", codeThemeDark: "nord" });
  // A dark-only theme is not a light choice, and unknown names fall back.
  expect(normalizeChatAppearance({ codeThemeLight: "dracula", codeThemeDark: "monokai" })).toMatchObject({ codeThemeLight: "firefly", codeThemeDark: "firefly" });
});

describe("code font choices", () => {
  it("lead the JetBrains choice with the bundled variable face, so it works without an installed copy", () => {
    // ui/fonts.css registers @fontsource-variable/jetbrains-mono under this family name.
    expect(CODE_FONT_STACKS.jetbrains.startsWith('"JetBrains Mono Variable", "JetBrains Mono"')).toBe(true);
  });
});
