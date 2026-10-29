import { connectUiColors } from "./colors";
import type { UiColors } from "../../shared/ui-colors";
import { DEFAULT_UI_THEME, normalizeUiTheme, type UiTheme } from "../../shared/ui-theme";
import { DEFAULT_UI_FONT, normalizeUiFont, type UiFont } from "../../shared/ui-font";
import type { ChatDisplaySettings } from "../../shared/chat-appearance";

declare global {
  interface Window {
    fireflyTheme?: {
      getColors: () => Promise<UiColors>;
      onColorsChanged: (callback: (colors: UiColors) => void) => () => void;
      get: () => Promise<UiTheme>;
      onChanged: (callback: (theme: UiTheme) => void) => () => void;
    };
    fireflyFont?: {
      get: () => Promise<UiFont>;
      onChanged: (callback: (font: UiFont) => void) => () => void;
    };
    fireflyAppearance?: {
      get: () => Promise<ChatDisplaySettings>;
      onChanged: (callback: (settings: ChatDisplaySettings) => void) => () => void;
    };
  }
}

const THEME_CACHE_KEY = "firefly.uiTheme";

/** The last theme the main process confirmed. Windows boot from it so a dark choice does not flash light first. */
function readCachedTheme(): UiTheme {
  try { return normalizeUiTheme(window.localStorage.getItem(THEME_CACHE_KEY)); } catch { return DEFAULT_UI_THEME; }
}

let themeApplied = false;

function applyTheme(theme: unknown): void {
  const next = normalizeUiTheme(theme);
  const root = document.documentElement;
  const set = () => { root.dataset.uiTheme = next; };
  // A real switch cross-fades the whole window; the first paint (and reduced motion) applies at once.
  const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const fade = themeApplied && root.dataset.uiTheme !== next && !reduced
    && typeof (document as Document & { startViewTransition?: unknown }).startViewTransition === "function";
  themeApplied = true;
  if (fade) (document as Document & { startViewTransition(update: () => void): unknown }).startViewTransition(set);
  else set();
  try { window.localStorage.setItem(THEME_CACHE_KEY, next); } catch { /* storage may be unavailable; the main process stays authoritative */ }
}

const CUSTOM_FONT_STYLE_ID = "firefly-custom-font";
// Fallback chain for the Chinese-first UI: the bundled variable face (fonts.css), then the same family if installed, the
// system faces in priority order, then generic sans-serif. Keep it in step with --rb-font-sans in tokens.css.
const DEFAULT_FONT_STACK = ["\"Noto Sans SC Variable\"", "\"Noto Sans SC\"", "-apple-system", "BlinkMacSystemFont", "\"Segoe UI\"", "\"PingFang SC\"", "\"Microsoft YaHei\"", "sans-serif"].join(", ");

// Custom fonts are injected as a <style> tag so the rule can point at the local-font scheme.
function applyFont(value: unknown): void {
  const font = normalizeUiFont(value);
  const root = document.documentElement;
  const existing = document.getElementById(CUSTOM_FONT_STYLE_ID);
  if (font.kind !== "custom") {
    existing?.remove();
    root.style.setProperty("--rb-font-sans", DEFAULT_FONT_STACK);
    root.dataset.uiFont = "source-han";
    return;
  }
  const holder = existing ?? document.head.appendChild(Object.assign(document.createElement("style"), { id: CUSTOM_FONT_STYLE_ID }));
  const isOpenType = font.fileName.toLowerCase().endsWith(".otf");
  const format = isOpenType ? "opentype" : "truetype";
  holder.textContent = `@font-face { font-family: "Firefly Custom Font"; src: url("local-font://${encodeURIComponent(font.fileName)}") format("${format}"); font-display: swap; }`;
  root.style.setProperty("--rb-font-sans", `"Firefly Custom Font", ${DEFAULT_FONT_STACK}`);
  root.dataset.uiFont = "custom";
}

applyTheme(readCachedTheme());

void window.fireflyTheme?.get()
  .then(applyTheme)
  .catch(() => applyTheme(readCachedTheme()));

window.fireflyTheme?.onChanged((theme) => {
  applyTheme(theme);
});

applyFont(DEFAULT_UI_FONT);
void window.fireflyFont?.get().then(applyFont).catch(() => applyFont(DEFAULT_UI_FONT));
window.fireflyFont?.onChanged((font) => applyFont(font));

if (typeof window.fireflyTheme?.getColors === "function" && typeof window.fireflyTheme.onColorsChanged === "function") connectUiColors(window.fireflyTheme);
