import { DEFAULT_UI_COLORS, normalizeUiColors, uiColorSet, uiColorTokens, type UiColorScheme } from "../../shared/ui-colors";
const properties = Object.keys(uiColorTokens({ ...DEFAULT_UI_COLORS, enabled: true }));
/** Which custom colour set the window shows: the dark one under Firefly's dark theme. */
export function activeColorScheme(root = document.documentElement): UiColorScheme {
  return root.dataset.uiTheme === "firefly-dark" ? "dark" : "light";
}
export function applyUiColors(input: unknown, root = document.documentElement): void {
  const scheme = activeColorScheme(root), colors = normalizeUiColors(input), tokens = uiColorTokens(colors, scheme);
  for (const name of properties) {
    if (tokens[name]) root.style.setProperty(name, tokens[name]); else root.style.removeProperty(name);
  }
  const set = uiColorSet(colors, scheme);
  if (colors.enabled) root.dataset.uiColors = `${set.accent}:${set.background}:${set.foreground}`;
  else delete root.dataset.uiColors;
}
export interface UiColorsApi { getColors(): Promise<unknown>; onColorsChanged(callback: (value: unknown) => void): () => void }
export function connectUiColors(api: UiColorsApi, root = document.documentElement): () => void {
  let disposed = false, changed = false, latest: unknown;
  const apply = (value: unknown) => { latest = value; applyUiColors(value, root); };
  const off = api.onColorsChanged(value => { if (!disposed) { changed = true; apply(value); } });
  void api.getColors().then(value => { if (!disposed && !changed) apply(value); }).catch(() => {});
  // Switching between light and dark swaps in that theme's own set.
  const watch = typeof MutationObserver === "function"
    ? new MutationObserver(() => { if (!disposed && latest !== undefined) applyUiColors(latest, root); }) : undefined;
  watch?.observe(root, { attributes: true, attributeFilter: ["data-ui-theme"] });
  return () => { disposed = true; off(); watch?.disconnect(); };
}
