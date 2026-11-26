import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { checkRelativePathShape } from "../../../shared/plugin-manifest";
import { PluginError } from "../../../shared/plugin-protocol";
import { escapesRoot } from "../package/boundary";

export interface AssetFsOps {
  lstat: typeof lstat;
  open: typeof open;
  realpath: typeof realpath;
}

const DEFAULT_ASSET_FS: AssetFsOps = {
  lstat,
  open,
  realpath,
};

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

const UTF8 = "; charset=utf-8";

/** Only these extensions are served; anything else answers 404 so a package cannot expose arbitrary files. */
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  // Pages, scripts and data, always declared as UTF-8.
  ".html": `text/html${UTF8}`, ".htm": `text/html${UTF8}`,
  ".js": `text/javascript${UTF8}`, ".mjs": `text/javascript${UTF8}`,
  ".css": `text/css${UTF8}`, ".json": `application/json${UTF8}`, ".txt": `text/plain${UTF8}`,
  // Images.
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  // Fonts and WebAssembly.
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
  ".wasm": "application/wasm",
});

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

/** Names that would point at the current or parent directory instead of a file inside the package. */
const DIRECTORY_NAMES = new Set(["", ".", ".."]);
/** A separator or NUL left over after decoding, or a Windows drive prefix, would leave the segment. */
const SEGMENT_ESCAPE = /[\\/\0]|^[a-zA-Z]:/;

function decodeOnce(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/**
 * Decodes one URL path segment exactly once (so `%252e` stays a literal `%2e` name) and returns null for anything that
 * is not a plain file or folder name.
 */
function safePathSegment(encoded: string): string | null {
  const name = decodeOnce(encoded);
  if (name === null || DIRECTORY_NAMES.has(name) || SEGMENT_ESCAPE.test(name)) return null;
  return name;
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

function normalizeCompare(targetPath: string): string {
  return process.platform === "win32" ? targetPath.toLowerCase() : targetPath;
}

function isMissingError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

type DirectoryChainResult =
  | { ok: true; canonical: string }
  | { ok: false; status: 403 | 404 };

async function validateDirectoryChain(
  targetDir: string,
  fsOps: AssetFsOps,
): Promise<DirectoryChainResult> {
  const resolved = path.resolve(targetDir);
  const parsedRoot = path.parse(resolved).root;
  const parts = path.relative(parsedRoot, resolved).split(path.sep).filter(Boolean);

  let current = parsedRoot;
  for (const segment of parts) {
    current = path.join(current, segment);
    let info;
    try {
      info = await fsOps.lstat(current, { bigint: true });
    } catch (error) {
      return { ok: false, status: isMissingError(error) ? 404 : 403 };
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      return { ok: false, status: 403 };
    }
  }

  let canonical: string;
  try {
    canonical = await fsOps.realpath(resolved);
  } catch (error) {
    return { ok: false, status: isMissingError(error) ? 404 : 403 };
  }
  return { ok: true, canonical };
}

type RelativeSegmentsResult =
  | { ok: true; filePath: string; fileStat: Awaited<ReturnType<typeof lstat>> & { dev: bigint; ino: bigint } }
  | { ok: false; status: 403 | 404 };

async function validateRelativeSegments(
  root: string,
  segments: readonly string[],
  fsOps: AssetFsOps,
): Promise<RelativeSegmentsResult> {
  let current = root;
  for (let i = 0; i < segments.length; i += 1) {
    current = path.join(current, segments[i]);
    let info;
    try {
      info = await fsOps.lstat(current, { bigint: true });
    } catch (error) {
      return { ok: false, status: isMissingError(error) ? 404 : 403 };
    }
    if (info.isSymbolicLink()) {
      return { ok: false, status: 403 };
    }
    const isLast = i === segments.length - 1;
    if (isLast) {
      if (!info.isFile()) {
        return { ok: false, status: 404 };
      }
      return {
        ok: true,
        filePath: current,
        fileStat: info as Awaited<ReturnType<typeof lstat>> & { dev: bigint; ino: bigint },
      };
    }
    if (!info.isDirectory()) {
      return { ok: false, status: 404 };
    }
  }
  return { ok: false, status: 404 };
}

export async function resolvePluginUiAsset(
  rawUrl: string,
  expectedPluginId: string,
  packageRoot: string,
  options: { fs?: Partial<AssetFsOps> } = {},
): Promise<PluginUiAssetResponse> {
  const fsOps: AssetFsOps = { ...DEFAULT_ASSET_FS, ...options.fs };
  const parts = parsePluginUiUrlParts(rawUrl, expectedPluginId);
  if (!parts) {
    return { status: 403, headers: buildPluginUiResponseHeaders() };
  }

  const rootCheck = await validateDirectoryChain(packageRoot, fsOps);
  if (!rootCheck.ok) {
    return { status: rootCheck.status, headers: buildPluginUiResponseHeaders() };
  }
  const canonicalRoot = rootCheck.canonical;

  const initialSegments = await validateRelativeSegments(canonicalRoot, parts, fsOps);
  if (!initialSegments.ok) {
    return { status: initialSegments.status, headers: buildPluginUiResponseHeaders() };
  }

  const candidate = initialSegments.filePath;
  let canonicalFile: string;
  try {
    canonicalFile = await fsOps.realpath(candidate);
  } catch (error) {
    return { status: isMissingError(error) ? 404 : 403, headers: buildPluginUiResponseHeaders() };
  }

  if (!isInsideRoot(normalizeCompare(canonicalRoot), normalizeCompare(canonicalFile))) {
    return { status: 403, headers: buildPluginUiResponseHeaders() };
  }

  const contentType = MIME_BY_EXTENSION[path.extname(canonicalFile).toLowerCase()];
  if (!contentType) {
    return { status: 403, headers: buildPluginUiResponseHeaders() };
  }

  const expectedStat = initialSegments.fileStat;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    try {
      handle = await fsOps.open(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    } catch (error) {
      return { status: isMissingError(error) ? 404 : 403, headers: buildPluginUiResponseHeaders() };
    }

    const openedStat = await handle.stat({ bigint: true });
    if (!openedStat.isFile()) {
      return { status: 403, headers: buildPluginUiResponseHeaders() };
    }
    if (openedStat.dev !== expectedStat.dev || openedStat.ino !== expectedStat.ino) {
      return { status: 403, headers: buildPluginUiResponseHeaders() };
    }

    const recheckedRoot = await validateDirectoryChain(packageRoot, fsOps);
    if (!recheckedRoot.ok || normalizeCompare(recheckedRoot.canonical) !== normalizeCompare(canonicalRoot)) {
      return { status: 403, headers: buildPluginUiResponseHeaders() };
    }
    const recheckedSegments = await validateRelativeSegments(recheckedRoot.canonical, parts, fsOps);
    if (
      !recheckedSegments.ok
      || recheckedSegments.fileStat.dev !== openedStat.dev
      || recheckedSegments.fileStat.ino !== openedStat.ino
    ) {
      return { status: 403, headers: buildPluginUiResponseHeaders() };
    }

    const body = await handle.readFile();
    return {
      status: 200,
      contentType,
      headers: buildPluginUiResponseHeaders(contentType),
      body,
    };
  } finally {
    await handle?.close().catch(() => {});
  }
}

export function createPluginUiProtocolHandler(
  resolvePackageRoot: (pluginId: string) => string | undefined,
  expectedPluginId?: string,
  options: { fs?: Partial<AssetFsOps> } = {},
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    let parsed: URL;
    try {
      parsed = new URL(request.url);
    } catch {
      return new Response(null, { status: 403, headers: buildPluginUiResponseHeaders() });
    }
    const targetPluginId = expectedPluginId ?? parsed.hostname;
    if (parsed.hostname !== targetPluginId) {
      return new Response(null, { status: 403, headers: buildPluginUiResponseHeaders() });
    }
    const packageRoot = resolvePackageRoot(targetPluginId);
    if (!packageRoot) {
      return new Response(null, { status: 403, headers: buildPluginUiResponseHeaders() });
    }
    const asset = await resolvePluginUiAsset(request.url, targetPluginId, packageRoot, options);
    if (asset.status !== 200) {
      return new Response(null, {
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
