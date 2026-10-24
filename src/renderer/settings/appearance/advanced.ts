// "高级" appearance preferences in the settings window: segmented choices, switches, and the code appearance card
// (code theme per light/dark theme with a preview, code font).
// Each change saves at once (like the font sizes beside them); the reset button puts every typography and advanced
// preference back to its default.
import { DEFAULT_CHAT_APPEARANCE, type ChatAppearanceSettings } from "../../../shared/chat-appearance";
import { applyAppearancePrefs } from "../../ui/appearance-prefs";
import { renderCodeThemePreview } from "./code-theme-preview";

type Save = (patch: Partial<ChatAppearanceSettings>) => Promise<void>;
type SegKey = "reduceMotion" | "diffMarkers";
type SwitchKey = "fullWidthChat" | "pointerCursor" | "smartPunctuation";

export function bindAppearanceAdvanced(root: ParentNode, save: Save) {
  const segs: Record<SegKey, HTMLElement | null> = { reduceMotion: root.querySelector("#reduce-motion"), diffMarkers: root.querySelector("#diff-markers") };
  const switches: Record<SwitchKey, HTMLInputElement | null> = {
    fullWidthChat: root.querySelector("#full-width-chat"), pointerCursor: root.querySelector("#pointer-cursor"), smartPunctuation: root.querySelector("#smart-punctuation"),
  };
  const codeFont = root.querySelector<HTMLSelectElement>("#code-font-select");
  const codeThemes = {
    codeThemeLight: { select: root.querySelector<HTMLSelectElement>("#code-theme-light"), preview: root.querySelector<HTMLElement>("#code-theme-light-preview"), scheme: "light" },
    codeThemeDark: { select: root.querySelector<HTMLSelectElement>("#code-theme-dark"), preview: root.querySelector<HTMLElement>("#code-theme-dark-preview"), scheme: "dark" },
  } as const;
  const reset = root.querySelector<HTMLButtonElement>("#appearance-reset");
  let current: ChatAppearanceSettings = { ...DEFAULT_CHAT_APPEARANCE };

  const commit = (patch: Partial<ChatAppearanceSettings>) => {
    current = { ...current, ...patch };
    render(current);
    void save(patch);
  };
  function render(settings: ChatAppearanceSettings): void {
    current = settings;
    for (const key of Object.keys(segs) as SegKey[]) {
      segs[key]?.querySelectorAll<HTMLButtonElement>("[data-value]").forEach(button => {
        const active = button.dataset.value === settings[key];
        button.classList.toggle("is-active", active);
        button.setAttribute("aria-checked", String(active));
        button.setAttribute("role", "radio");
      });
    }
    for (const key of Object.keys(switches) as SwitchKey[]) if (switches[key]) switches[key]!.checked = settings[key];
    if (codeFont) codeFont.value = settings.codeFont;
    for (const [key, { select, preview, scheme }] of Object.entries(codeThemes) as [keyof typeof codeThemes, (typeof codeThemes)[keyof typeof codeThemes]][]) {
      if (select) select.value = settings[key];
      if (preview && preview.dataset.theme !== settings[key]) renderCodeThemePreview(preview, scheme, settings[key]);
    }
    // The settings window follows the same motion, cursor and code-font choices.
    applyAppearancePrefs(settings);
  }

  for (const key of Object.keys(segs) as SegKey[]) {
    segs[key]?.addEventListener("click", event => {
      const value = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-value]")?.dataset.value;
      if (value && value !== current[key]) commit({ [key]: value } as Partial<ChatAppearanceSettings>);
    });
  }
  for (const key of Object.keys(switches) as SwitchKey[]) {
    switches[key]?.addEventListener("change", () => commit({ [key]: switches[key]!.checked } as Partial<ChatAppearanceSettings>));
  }
  codeFont?.addEventListener("change", () => commit({ codeFont: codeFont.value as ChatAppearanceSettings["codeFont"] }));
  for (const [key, { select }] of Object.entries(codeThemes) as [keyof typeof codeThemes, (typeof codeThemes)[keyof typeof codeThemes]][]) {
    select?.addEventListener("change", () => { if (select.value !== current[key]) commit({ [key]: select.value } as Partial<ChatAppearanceSettings>); });
  }
  reset?.addEventListener("click", event => {
    // The button sits in the <summary>; it must not also fold the section.
    event.preventDefault();
    event.stopPropagation();
    commit({ ...DEFAULT_CHAT_APPEARANCE });
  });
  return { render, current: () => current };
}
