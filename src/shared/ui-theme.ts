/** 浅色「冷灰蓝」与深色「流萤」两套主题；未知或缺失的配置一律回到浅色。 */
export const UI_THEMES = ["pearl-white", "firefly-dark"] as const;
export type UiTheme = (typeof UI_THEMES)[number];
export const DEFAULT_UI_THEME: UiTheme = "pearl-white";

export function normalizeUiTheme(value: unknown): UiTheme {
  return typeof value === "string" && (UI_THEMES as readonly string[]).includes(value) ? (value as UiTheme) : DEFAULT_UI_THEME;
}

export function isDarkUiTheme(theme: UiTheme): boolean {
  return theme === "firefly-dark";
}
