import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { protocol } from "electron";

const PANEL_SCHEME = "firefly-plugin";
const HOST_RESOURCE_FOLDER = ".firefly";
const HOST_SAFE_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const missing: { status: 404 } = { status: 404 };
const mimeByExtension: Record<string, string> = Object.fromEntries([
  [".html", "text/html; charset=utf-8"], [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"], [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"], [".png", "image/png"],
  [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".gif", "image/gif"],
  [".webp", "image/webp"], [".svg", "image/svg+xml"], [".ico", "image/x-icon"],
  [".woff", "font/woff"], [".woff2", "font/woff2"],
]);
export interface PluginPanelSuccess { status: 200; contentType: string; body: Buffer }
export type PluginPanelResponse = PluginPanelSuccess | { status: 404 };
export type PluginPanelAccessQuery = (pluginId: string) => string | undefined;

function safePathPart(encoded: string): string | null {
  let part: string;
  try { part = decodeURIComponent(encoded); } catch { return null; }
  if (part === "" || part === "." || part === ".." || part.includes("/")
    || part.includes("\\") || part.includes("\0") || /^[a-zA-Z]:/.test(part)) return null;
  return part;
}

// Each filesystem operation keeps its own failure boundary; read errors still reject.
async function readPanelAsset(directory: string, parts: string[]): Promise<PluginPanelResponse> {
  if (parts.length === 0) return missing;
  let canonicalDirectory: string;
  try { canonicalDirectory = await realpath(directory); } catch { return missing; }
  const requestedFile = path.join(canonicalDirectory, ...parts);
  let canonicalFile: string;
  try { canonicalFile = await realpath(requestedFile); } catch { return missing; }
  const relativeFile = path.relative(canonicalDirectory, canonicalFile);
  if (relativeFile === "" || relativeFile === ".." || relativeFile.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativeFile)) return missing;
  let metadata: Awaited<ReturnType<typeof stat>>;
  try { metadata = await stat(canonicalFile); } catch { return missing; }
  if (!metadata.isFile()) return missing;
  const mime = mimeByExtension[path.extname(canonicalFile).toLowerCase()];
  if (!mime) return missing;
  const bytes = await readFile(canonicalFile);
  return { status: 200, contentType: mime, body: bytes };
}

export async function resolvePluginPanelRequest(
  rawUrl: string, query: PluginPanelAccessQuery, assetsRoot: string,
): Promise<PluginPanelResponse> {
  let parsed: URL;
  try { parsed = new URL(rawUrl); } catch { return missing; }
  if (parsed.protocol !== `${PANEL_SCHEME}:`) return missing;
  const encodedParts = parsed.pathname.split("/");
  if (encodedParts[0] !== "") return missing;
  const pathParts: string[] = [];
  for (const encoded of encodedParts.slice(1)) {
    const part = safePathPart(encoded);
    if (part === null) return missing;
    pathParts.push(part);
  }
  if (pathParts.length === 0) return missing;
  if (pathParts[0] === HOST_RESOURCE_FOLDER) {
    if (!HOST_SAFE_ID.test(parsed.hostname) || !query(parsed.hostname)) return missing;
    const resource = await readPanelAsset(assetsRoot, pathParts.slice(1));
    return resource;
  }
  const identity = parsed.hostname;
  if (!HOST_SAFE_ID.test(identity)) return missing;
  const directory = query(identity);
  if (!directory) return missing;
  return readPanelAsset(directory, pathParts);
}

export function registerPluginPanelScheme(): void {
  protocol.registerSchemesAsPrivileged([PANEL_SCHEME].map((name) => ({
    scheme: name, privileges: { standard: true, secure: true },
  })));
}

/** Standard custom origins isolate the iframe from file and localhost host pages. */
export function installPluginPanelProtocol(query: PluginPanelAccessQuery): void {
  const hostAssets = __dirname;
  for (const name of [PANEL_SCHEME]) protocol.handle(name, async (request) => {
    const resource = await resolvePluginPanelRequest(request.url, query, hostAssets);
    if (resource.status === 404) return new Response(null, { status: 404 });
    return new Response(resource.body, { status: 200, headers: {
      "Content-Type": resource.contentType, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store",
    } });
  });
}