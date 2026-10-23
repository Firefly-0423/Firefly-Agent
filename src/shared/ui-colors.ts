export interface UiColorSet { accent: string; background: string; foreground: string }
/** One switch, and a colour set per theme as in Codex: the top-level fields are the light set (as stored before), `dark` the dark one. */
export interface UiColors extends UiColorSet { enabled: boolean; dark: UiColorSet }
export type UiColorScheme = "light" | "dark";
const DEFAULT_DARK_COLORS: Readonly<UiColorSet> = Object.freeze({ accent: "#7bd8ae", background: "#192a24", foreground: "#e4eee9" });
export const DEFAULT_UI_COLORS: Readonly<UiColors> = Object.freeze({ enabled: false, accent: "#0285ff", background: "#ffffff", foreground: "#0d0d0d", dark: DEFAULT_DARK_COLORS });
/** The defaults of one theme's set, which "restore default colours" puts back. */
export function defaultUiColorSet(scheme: UiColorScheme): UiColorSet {
  const { accent, background, foreground } = scheme === "dark" ? DEFAULT_DARK_COLORS : DEFAULT_UI_COLORS;
  return { accent, background, foreground };
}
export function normalizeUiColors(input: unknown): UiColors {
  const value = input && typeof input === "object" ? input as Partial<UiColors> : {};
  const color = (v: unknown, fallback: string) => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : fallback;
  const set = (v: unknown, defaults: UiColorSet): UiColorSet => {
    const from = v && typeof v === "object" ? v as Partial<UiColorSet> : {};
    return { accent: color(from.accent, defaults.accent), background: color(from.background, defaults.background), foreground: color(from.foreground, defaults.foreground) };
  };
  return { enabled: value.enabled === true, ...set(value, DEFAULT_UI_COLORS), dark: set(value.dark, DEFAULT_DARK_COLORS) };
}
/** The set that applies under a theme. */
export function uiColorSet(input: unknown, scheme: UiColorScheme): UiColorSet {
  const value = normalizeUiColors(input);
  return scheme === "dark" ? { ...value.dark } : { accent: value.accent, background: value.background, foreground: value.foreground };
}
function rgb(hex: string): number[] { return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)); }
function mix(a: string, b: string, weight: number): string {
  const x = rgb(a), y = rgb(b);
  return "#" + x.map((v, i) => Math.round(v * (1 - weight) + y[i] * weight).toString(16).padStart(2, "0")).join("");
}
function lightness(hex: string): number {
  const [r, g, b] = rgb(hex).map(v => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function uiColorContrast(input: unknown, scheme: UiColorScheme = "light"): number {
  const value = uiColorSet(input, scheme), a = lightness(value.background), b = lightness(value.foreground);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
export function uiColorTokens(input: unknown, scheme: UiColorScheme = "light"): Record<string, string> {
  if (!normalizeUiColors(input).enabled) return {};
  const c = uiColorSet(input, scheme);
  const bg = c.background, fg = c.foreground, accent = c.accent;
  const surface = mix(bg, fg, 0.035), hover = mix(bg, fg, 0.08), border = mix(bg, fg, 0.2), muted = mix(fg, bg, 0.35);
  const out: Record<string, string> = {};
  const set = (keys: string[], value: string) => { for (const key of keys) out[key] = value; };
  set(["--ff-accent", "--ff-pill-border", "--rb-pink-400", "--rb-pink-500", "--rb-pink-600", "--rb-toggle-on", "--rb-slider-fill", "--rb-feedback-info", "--rb-weather-accent", "--ff-glow", "--ff-glow-soft"], accent);
  out["--ff-glow-rgb"] = rgb(accent).join(", ");
  set(["--ff-bg-workspace", "--ff-surface", "--rb-bg-0", "--rb-bg-3", "--rb-bg-elevated", "--rb-card-bg", "--rb-input-bg", "--rb-feedback-surface"], bg);
  set(["--ff-bg-page", "--ff-pill-bg", "--rb-bg-1", "--rb-pink-50"], surface);
  set(["--ff-bg-hover", "--ff-bg-active", "--rb-bg-2", "--rb-pink-100", "--rb-hover-light", "--rb-active-light", "--rb-feedback-details-bg"], hover);
  set(["--ff-text", "--ff-text-primary", "--ff-pill-status", "--rb-text-strong", "--rb-text-default", "--rb-input-text", "--rb-feedback-fg"], fg);
  set(["--ff-text-muted", "--rb-text-muted", "--rb-text-faint", "--rb-input-placeholder", "--rb-feedback-muted"], muted);
  set(["--ff-border", "--rb-border-faint", "--rb-border-soft", "--rb-border-strong", "--rb-input-border", "--rb-feedback-border", "--rb-divider-light", "--rb-slider-track", "--rb-toggle-off"], border);
  set(["--rb-text-on-pink"], lightness(accent) > 0.179 ? "#000000" : "#ffffff");
  set(["--rb-pink-200", "--rb-pink-300", "--rb-pink-glow"], mix(accent, bg, 0.4));
  set(["--rb-pink-700"], mix(accent, fg, 0.25));
  const rgba = `rgba(${rgb(accent).join(", ")}, 0.16)`;
  out["--ff-shadow-control-focus"] = `0 0 0 3px ${rgba}`;
  out["--rb-glow-pink"] = `0 0 12px ${rgba}`;
  out["--rb-shadow-pink"] = `0 4px 16px ${rgba}`;
  out["color-scheme"] = lightness(bg) < 0.179 ? "dark" : "light";
  return out;
}
