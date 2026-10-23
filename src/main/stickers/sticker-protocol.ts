import * as path from "path";

export function buildLocalStickerUrl(file: string): string {
  return `local-sticker:///${encodeURIComponent(file)}`;
}

function hasPathSeparator(name: string): boolean {
  return name.includes("/") || name.includes("\\");
}

export function parseLocalStickerFileFromUrl(rawUrl: string): string | null {
  // 含 .. 路径段（含百分号编码形式）一律拒绝
  if (/(?:^|[\\/])(?:\.\.|%2e%2e)(?:[\\/]|$)/i.test(rawUrl)) return null;

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }

  const encodedName = parsed.pathname.replace(/^\/+/, "") || parsed.host;
  if (!encodedName) return null;

  let name: string;
  try {
    name = decodeURIComponent(encodedName);
  } catch {
    return null;
  }

  if (!name || name === "." || name === "..") return null;
  return hasPathSeparator(name) ? null : name;
}

export function resolveLocalStickerPath(stickersDir: string, file: string): string | null {
  if (!file || hasPathSeparator(file)) return null;

  const root = path.resolve(stickersDir);
  const target = path.resolve(root, file);
  const rel = path.relative(root, target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return target;
}
