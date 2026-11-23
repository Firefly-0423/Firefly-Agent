import { lstat, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { checkRelativePathShape } from "../../../shared/plugin-manifest";
import { PluginError } from "../../../shared/plugin-protocol";
import { escapesRoot } from "../package/boundary";

export const PLUGIN_UI_SCHEME = "firefly-plugin-ui";

/**
 * Strict CSP enforced on every plugin UI response:
 * - Only self-origin scripts/styles/assets inside the owning plugin's package root are permitted.
 * - External scripts, inline scripts, eval, frames, objects, and external connections are prohibited.
 */
export const STRICT_PLUGIN_UI_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "frame-src 'none'",
  "worker-src 'self'",
].join("; ");

const PLUGIN_ID_PATTERN = /^[a-z0-9]+(\.[a-z0-9-]+){2,}$/;

const MIME_BY_EXTENSION: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

export type PluginUiAssetResponse =
  | { status: 200; contentType: string; headers: Record<string, string>; body: Buffer }
  | { status: 403 | 404; headers: Record<string, string> };

export function buildPluginUiResponseHeaders(contentType?: string): Record<string, string> {
  return {
    ...(contentType ? { "Content-Type": contentType } : {}),
    "Content-Security-Policy": STRICT_PLUGIN_UI_CSP,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  };
}

function isInsideRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== "" && !escapesRoot(relative);
}

function safePathSegment(encoded: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    return null;
  }
  if (
    decoded === ""
    || decoded === "."
    || decoded === ".."
    || decoded.includes("/")
    || decoded.includes("\\")
    || decoded.includes("\0")
    || /^[a-zA-Z]:/.test(decoded)
  ) {
    return null;
  }
  return decoded;
}

function hasRawPathEscape(rawUrl: string): boolean {
  const schemeIdx = rawUrl.indexOf("://");
  if (schemeIdx < 0) return true;
  const afterScheme = rawUrl.slice(schemeIdx + 3);
  const slashIdx = afterScheme.indexOf("/");
  if (slashIdx < 0) return true;
  const rawPath = afterScheme.slice(slashIdx + 1).split(/[?#]/)[0] ?? "";
  return rawPath.split(/[\\/]/).some((segment) => {
    if (segment === "." || segment === "..") return true;
    try {
      const decoded = decodeURIComponent(segment);
      return decoded === "." || decoded === "..";
    } catch {
      return true;
    }
  });
}

function parsePluginUiUrlParts(rawUrl: string, expectedPluginId: string): string[] | null {
  if (hasRawPathEscape(rawUrl)) return null;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${PLUGIN_UI_SCHEME}:`) return null;
  if (parsed.username !== "" || parsed.password !== "" || parsed.port !== "") return null;
  if (!PLUGIN_ID_PATTERN.test(expectedPluginId) || parsed.hostname !== expectedPluginId) return null;
  const rawSegments = parsed.pathname.split("/");
  if (rawSegments[0] !== "") return null;
  const parts: string[] = [];
  for (const rawSegment of rawSegments.slice(1)) {
    const segment = safePathSegment(rawSegment);
    if (segment === null) return null;
    parts.push(segment);
  }
  return parts.length > 0 ? parts : null;
}

export function isAllowedPluginUiUrl(rawUrl: string, expectedPluginId: string): boolean {
  return parsePluginUiUrlParts(rawUrl, expectedPluginId) !== null;
}

export function buildPluginWindowUrl(pluginId: string, entryRelativePath: string): string {
  if (!PLUGIN_ID_PATTERN.test(pluginId)) {
    throw new PluginError("ERR_INVALID_ARGUMENT", `Invalid plugin id: ${pluginId}`);
  }
  const shapeError = checkRelativePathShape(entryRelativePath);
  if (shapeError) {
    throw new PluginError("ERR_INVALID_ARGUMENT", `Invalid window entry path: ${entryRelativePath}`);
  }
  const segments = entryRelativePath.split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => segment === "." || segment === "..")) {
    throw new PluginError("ERR_INVALID_ARGUMENT", `Invalid window entry path: ${entryRelativePath}`);
  }
  const encodedPath = segments.map((segment) => encodeURIComponent(segment)).join("/");
  return `${PLUGIN_UI_SCHEME}://${pluginId}/${encodedPath}`;
}

async function hasSymlinkSegment(root: string, segments: readonly string[]): Promise<boolean> {
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink()) return true;
  }
  return false;
}

export async function resolvePluginUiAsset(
  rawUrl: string,
  expectedPluginId: string,
  packageRoot: string,
): Promise<PluginUiAssetResponse> {
  const parts = parsePluginUiUrlParts(rawUrl, expectedPluginId);
  if (!parts) {
    return { status: 403, headers: buildPluginUiResponseHeaders() };
  }

  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(packageRoot);
  } catch {
    return { status: 404, headers: buildPluginUiResponseHeaders() };
  }

  try {
    if (await hasSymlinkSegment(canonicalRoot, parts)) {
      return { status: 403, headers: buildPluginUiResponseHeaders() };
    }
  } catch {
    return { status: 404, headers: buildPluginUiResponseHeaders() };
  }

  const candidate = path.join(canonicalRoot, ...parts);
  let canonicalFile: string;
  try {
    canonicalFile = await realpath(candidate);
  } catch {
    return { status: 404, headers: buildPluginUiResponseHeaders() };
  }

  if (!isInsideRoot(canonicalRoot, canonicalFile)) {
    return { status: 403, headers: buildPluginUiResponseHeaders() };
  }

  let fileStat: Awaited<ReturnType<typeof stat>>;
  try {
    fileStat = await stat(canonicalFile);
  } catch {
    return { status: 404, headers: buildPluginUiResponseHeaders() };
  }
  if (!fileStat.isFile()) {
    return { status: 404, headers: buildPluginUiResponseHeaders() };
  }

  const contentType = MIME_BY_EXTENSION[path.extname(canonicalFile).toLowerCase()];
  if (!contentType) {
    return { status: 403, headers: buildPluginUiResponseHeaders() };
  }

  const body = await readFile(canonicalFile);
  return {
    status: 200,
    contentType,
    headers: buildPluginUiResponseHeaders(contentType),
    body,
  };
}

export function createPluginUiProtocolHandler(
  resolvePackageRoot: (pluginId: string) => string | undefined,
  expectedPluginId?: string,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    let parsed: URL;
    try {
      parsed = new URL(request.url);
    } catch {
      return new Response("Forbidden", { status: 403, headers: buildPluginUiResponseHeaders() });
    }
    const targetPluginId = expectedPluginId ?? parsed.hostname;
    if (parsed.hostname !== targetPluginId) {
      return new Response("Forbidden", { status: 403, headers: buildPluginUiResponseHeaders() });
    }
    const packageRoot = resolvePackageRoot(targetPluginId);
    if (!packageRoot) {
      return new Response("Forbidden", { status: 403, headers: buildPluginUiResponseHeaders() });
    }
    const asset = await resolvePluginUiAsset(request.url, targetPluginId, packageRoot);
    if (asset.status !== 200) {
      return new Response(asset.status === 403 ? "Forbidden" : "Not Found", {
        status: asset.status,
        headers: asset.headers,
      });
    }
    return new Response(new Uint8Array(asset.body), {
      status: 200,
      headers: asset.headers,
    });
  };
}
