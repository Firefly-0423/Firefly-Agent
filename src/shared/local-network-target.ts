/** Pure syntax for private-network browser targets. Main remains the only authority.
 * Accepted: `localhost`, `[::1]`, and canonical IPv4 literals in 127/8, 10/8, 172.16/12, 192.168/16.
 * Rejected on purpose: link-local (cloud metadata), CGNAT, 0.0.0.0, multicast, other hostnames
 * (their DNS answers cannot be pinned) and every IPv4-mapped IPv6 spelling.
 */
export interface LocalAuthority { host: string; port: number }
export interface BrowserTarget { network: "public" | "local"; /** Public: hostname. Local: `host:port`. */ key: string; url: string }

const DEFAULT_PORTS: Readonly<Record<string, number>> = Object.freeze({ "http:": 80, "https:": 443, "ws:": 80, "wss:": 443 });

function privateIPv4(host: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return false;
  const parts = match.slice(1);
  if (parts.some(part => part.length > 1 && part.startsWith("0"))) return false;
  const [a, b] = parts.map(Number);
  if (parts.some(part => Number(part) > 255)) return false;
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
function allowedHost(host: string): boolean { return host === "localhost" || host === "[::1]" || privateIPv4(host); }
function validPort(port: number): boolean { return Number.isInteger(port) && port >= 1 && port <= 65535; }

/** Canonical `host:port` key to grant, or null. */
export function parseLocalAuthority(value: unknown): LocalAuthority | null {
  if (typeof value !== "string" || value.length > 64) return null;
  const match = /^(\[::1\]|localhost|[0-9.]+):(\d{1,5})$/.exec(value);
  if (!match || !allowedHost(match[1]) || (match[2].length > 1 && match[2].startsWith("0"))) return null;
  const port = Number(match[2]);
  return validPort(port) ? { host: match[1], port } : null;
}
export function localAuthorityKey(authority: LocalAuthority): string { return `${authority.host}:${authority.port}`; }

/** Key for a parsed URL whose protocol is http, https, ws or wss. */
export function localAuthorityFromUrl(url: URL): string | null {
  const fallback = DEFAULT_PORTS[url.protocol];
  if (fallback === undefined || url.username || url.password || !allowedHost(url.hostname)) return null;
  const port = url.port === "" ? fallback : Number(url.port);
  return validPort(port) ? `${url.hostname}:${port}` : null;
}
/** Navigable local page URL: http or https only. */
export function parseLocalBrowserUrl(input: unknown): { key: string; url: string } | null {
  if (typeof input !== "string" || input.length === 0 || input.length > 8192) return null;
  try {
    const url = new URL(input);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const key = localAuthorityFromUrl(url);
    return key ? { key, url: url.href } : null;
  } catch { return null; }
}
export function sameLocalHost(a: string, b: string): boolean {
  const left = parseLocalAuthority(a), right = parseLocalAuthority(b);
  return !!left && !!right && left.host === right.host;
}

/** Scheme-less private-network input such as `localhost:5173` or `192.168.1.5:3000/app` gets `http://`.
 * Anything else, including bare public names, is returned unchanged. */
export function normalizeTypedAddress(input: string): string {
  const text = input.trim();
  if (!/^(?:localhost|\d{1,3}(?:\.\d{1,3}){3}|\[::1\])(?::\d{1,5})?(?:[/?#]|$)/i.test(text)) return text;
  // Only an address the private-network rules accept gets http://; a public IP stays for the HTTPS path.
  return parseLocalBrowserUrl(`http://${text}`) ? `http://${text}` : text;
}

export const DEFAULT_SEARCH_URL = "https://www.bing.com/search?q=";
const BARE_HOST = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d{1,5})?(?:[/?#]\S*)?$/i;
const BARE_IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?(?:[/?#]\S*)?$/;

/** What the address bar does with typed text: a private authority, a bare public host, an explicit URL, or a search.
 * Explicit schemes are returned untouched so unsupported ones (file:, javascript:, http: to a public host) stay refused. */
export function resolveAddressInput(input: string, searchUrl: string = DEFAULT_SEARCH_URL): string {
  const text = input.trim();
  if (!text) return text;
  const typed = normalizeTypedAddress(text);
  if (typed !== text) return typed;
  if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(text)) return text;
  if (/\s/.test(text)) return `${searchUrl}${encodeURIComponent(text)}`;
  if (BARE_HOST.test(text) || BARE_IPV4.test(text)) return `https://${text}`;
  return `${searchUrl}${encodeURIComponent(text)}`;
}

/** Address-bar classification used by the renderer to build a proposal. Presentation only. */
export function manualBrowserTarget(input: unknown): BrowserTarget | null {
  if (typeof input !== "string" || input.length === 0 || input.length > 8192) return null;
  const local = parseLocalBrowserUrl(input);
  if (local) return { network: "local", key: local.key, url: local.url };
  try {
    const url = new URL(input);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password || (url.port && url.port !== "443")) return null;
    return { network: "public", key: url.hostname, url: url.href };
  } catch { return null; }
}
