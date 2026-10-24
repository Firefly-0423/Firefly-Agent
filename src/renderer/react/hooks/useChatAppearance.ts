import { useEffect } from "react";
import { normalizeChatAppearance, type ChatAppearanceSettings } from "../../../shared/chat-appearance";
import { applyAppearancePrefs } from "../../ui/appearance-prefs";

export function applyChatAppearance(input: unknown): void {
  const normalized = normalizeChatAppearance(input);
  const rootStyle = document.documentElement.style;
  const properties = [
    ["--ff-chat-line-height", String(normalized.chatLineHeight)],
    ["--ff-chat-para-spacing", normalized.chatParaSpacing + "em"],
    ["--ff-ui-font-size", normalized.uiFontSize + "px"],
    ["--ff-chat-font-size", normalized.chatFontSize + "px"],
    ["--ff-code-font-size", normalized.codeFontSize + "px"],
  ];
  for (const [property, value] of properties) rootStyle.setProperty(property, value);
  applyAppearancePrefs(normalized);
}

export function useChatAppearance(): void {
  useEffect(() => {
    const bridge = window.fireflyAppearance;
    if (!bridge) return;
    let closed = false;
    let changed = false;
    const stop = bridge.onChanged((update: ChatAppearanceSettings) => {
      if (closed) return;
      changed = true;
      applyChatAppearance(update);
    });
    void bridge.get().then((initial) => {
      if (!closed && !changed) applyChatAppearance(initial);
    }).catch((failure: unknown) => {
      console.warn("[ChatAppearance] Failed to load settings:", failure);
    });
    return () => { closed = true; stop(); };
  }, []);
}
