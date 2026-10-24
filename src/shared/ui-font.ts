export type UiFont = { kind: "source-han" } | { displayName: string; fileName: string; kind: "custom" };
export const DEFAULT_UI_FONT: UiFont = { kind: "source-han" };
const acceptedFontName = /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.(?:ttf|otf)$/i;

export function isSupportedFontFileName(fileName: string): boolean {
  return acceptedFontName.test(fileName);
}
export function normalizeUiFont(value: unknown): UiFont {
  if (!value || typeof value !== "object") return DEFAULT_UI_FONT;
  const font = value as { kind?: unknown; fileName?: unknown; displayName?: unknown };
  if (font.kind !== "custom") return DEFAULT_UI_FONT;
  if (typeof font.fileName !== "string" || !acceptedFontName.test(font.fileName)) return DEFAULT_UI_FONT;
  if (typeof font.displayName !== "string" || !font.displayName.trim()) return DEFAULT_UI_FONT;
  return { kind: "custom", fileName: font.fileName, displayName: font.displayName.trim().slice(0, 80) };
}
