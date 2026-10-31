// The "高级" appearance preferences that change how every window behaves (motion, cursor, code font, layout, diff
// markers). They live on the root element as data attributes and one font variable; appearance-prefs.css reads them.
import { CODE_FONT_STACKS, normalizeChatDisplay } from "../../shared/chat-appearance";
import { codePalette, type CodePalette } from "../../shared/code-themes";
import "./appearance-prefs.css";

export function applyAppearancePrefs(input: unknown, root: HTMLElement = document.documentElement): void {
  const prefs = normalizeChatDisplay(input);
  if (prefs.reduceMotion === "system") delete root.dataset.reduceMotion; else root.dataset.reduceMotion = prefs.reduceMotion;
  const flag = (name: "fullWidthChat" | "pointerCursor" | "smartPunctuation" | "segmentedChat", on: boolean) => { if (on) root.dataset[name] = ""; else delete root.dataset[name]; };
  flag("fullWidthChat", prefs.fullWidthChat);
  flag("pointerCursor", prefs.pointerCursor);
  flag("smartPunctuation", prefs.smartPunctuation);
  flag("segmentedChat", prefs.segmentedChat);
  root.dataset.diffMarkers = prefs.diffMarkers;
  if (prefs.codeFont === "system") root.style.removeProperty?.("--rb-font-mono");
  else root.style.setProperty("--rb-font-mono", CODE_FONT_STACKS[prefs.codeFont]);
  applyCodePalette(root, "light", codePalette("light", prefs.codeThemeLight));
  applyCodePalette(root, "dark", codePalette("dark", prefs.codeThemeDark));
}

/** Both code themes sit on the root as --ff-code-light-* and --ff-code-dark-*; appearance-prefs.css picks the set
 *  that matches the window's theme. A theme without its own background keeps the window's code surface. */
function applyCodePalette(root: HTMLElement, scheme: "light" | "dark", palette: CodePalette): void {
  for (const [key, value] of Object.entries(palette) as [keyof CodePalette, string | undefined][]) {
    const name = `--ff-code-${scheme}-${key}`;
    if (value) root.style.setProperty(name, value); else root.style.removeProperty?.(name);
  }
  if (!palette.background) root.style.removeProperty?.(`--ff-code-${scheme}-background`);
  const flag = scheme === "light" ? "codeLightSurface" : "codeDarkSurface";
  if (palette.background) root.dataset[flag] = ""; else delete root.dataset[flag];
}

/** Whether motion should be cut: the user's choice first, then the system setting. */
export function motionReduced(root: HTMLElement = document.documentElement): boolean {
  if (root.dataset.reduceMotion === "on") return true;
  if (root.dataset.reduceMotion === "off") return false;
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}
