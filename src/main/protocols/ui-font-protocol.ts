import { isSupportedFontFileName } from "../../shared/ui-font";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Cross-Origin-Resource-Policy": "cross-origin",
} as const;

export function getUiFontResponseHeaders(fileName: string): Record<string, string> {
  const extension = fileName.toLowerCase().endsWith(".otf") ? "otf" : "ttf";
  // 键顺序：Content-Type 在最前
  return { "Content-Type": `font/${extension}`, ...CORS_HEADERS };
}

export function isSafeUiFontRequest(fileName: string): boolean {
  return isSupportedFontFileName(fileName);
}
