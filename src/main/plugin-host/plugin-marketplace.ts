import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, open, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { isValidPluginVersion } from "../../shared/version";
import { CURRENT_PLUGIN_API_VERSION } from "../../plugins/api";
import type {
  MarketInstallResult,
  MarketListResult,
  MarketPluginEntry,
  MarketSourceStatus,
} from "../../shared/plugin-management";
import type { PluginImportResult } from "../../plugins/manager";
import type { PackageSource } from "../../plugins/version-store";

// The catalog is registry.json on the main branch of the Firefly-0423/firefly-plugins repository; packages are that
// repository's GitHub Release assets. Every entry pins its package SHA-256, and downloads are refused on a mismatch.
// Changing either list is a boundary change: the pinned values and this file's reviewed hash in
// skills/external-boundary.test.ts must be updated together.
export const MARKET_REGISTRY_URLS: readonly string[] = [
  "https://raw.githubusercontent.com/Firefly-0423/firefly-plugins/main/registry.json",
];
export const MARKET_ZIP_URL_PREFIXES: readonly string[] = [
  "https://github.com/Firefly-0423/firefly-plugins/releases/download/",
];
export const BUNDLED_MARKET_SOURCE = "bundled:registry";
export const MARKET_REGISTRY_TIMEOUT_MS = 10_000;
/** With a bundled catalog available, the list does not wait longer than this for the online catalog. */
export const MARKET_REGISTRY_GRACE_MS = 3_000;
export const MARKET_REGISTRY_MAX_BYTES = 1024 * 1024;
export const MARKET_ZIP_DOWNLOAD_TIMEOUT_MS = 120_000;
export const MARKET_ZIP_MAX_BYTES = 50 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const GITHUB_RELEASE_ASSET_ORIGIN = "https://release-assets.githubusercontent.com";

/** Only Main owns executable package locations and hashes. Renderer can request an id, never a URL. */
interface MarketSnapshotEntry {
  sourceId?: string;
  id: string;
  version: string;
  zip: string;
  sha256: string;
  pluginApiVersion: number;
  source: "bundled" | "remote";
}

export type MarketplaceFetch = (
  input: string,
  init?: { signal?: AbortSignal; redirect?: "manual"; credentials?: "omit" },
) => Promise<Response>;

export interface PluginMarketplaceDeps {
  registryUrls: readonly string[];
  zipUrlPrefixes: readonly string[];
  /** App-owned generated catalog/ZIP directory, never supplied by Renderer or a remote catalog. */
  bundledDir?: string;
  cacheDir: string;
  installZip: (
    zipPath: string,
    opts: { expectedIdentity: { id: string; version: string }; origin: "market"; packageSource: PackageSource },
  ) => Promise<PluginImportResult>;
  fetchImpl?: MarketplaceFetch;
  /** Test overrides for bounded I/O. */
  registryTimeoutMs?: number;
  registryGraceMs?: number;
  registryMaxBytes?: number;
  zipTimeoutMs?: number;
  zipMaxBytes?: number;
}

class RegistryFormatError extends Error {
  constructor(message: string, readonly kind: "invalid" | "unsupported") { super(message); }
}
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA256_PATTERN = /^[0-9a-fA-F]{64}$/;
const BUNDLED_ZIP_PATTERN = /^bundled:([a-zA-Z0-9][a-zA-Z0-9.+-]*\.zip)$/;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function isText(value: unknown, max = 4000): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}
function httpsUrl(value: unknown): URL | null {
  if (typeof value !== "string" || value !== value.trim() || /[\\\x00-\x20]/.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash ? url : null;
  } catch { return null; }
}

/** Compare parsed origins and directory paths; string prefix checks accept traversal and lookalike hosts. */
function allowedZipUrl(raw: string, prefixes: readonly string[]): boolean {
  const url = httpsUrl(raw);
  if (!url || /%(?:2e|2f|5c|25)/i.test(url.pathname)) return false;
  // Reject literal dot segments too, before URL normalization erases them.
  if (/(?:^|\/)\.{1,2}(?:\/|[?#]|$)/.test(raw)) return false;
  return prefixes.some((prefix) => {
    const base = httpsUrl(prefix);
    return base !== null && !base.search && base.pathname.endsWith("/")
      && url.origin === base.origin && url.pathname.startsWith(base.pathname);
  });
}

function validateEntry(raw: unknown, deps: PluginMarketplaceDeps, source: "bundled" | "remote"):
  (MarketPluginEntry & MarketSnapshotEntry) | null {
  if (typeof raw !== "object" || raw === null) return null;
  const entry = raw as Record<string, unknown>;
  const { id, name, version, description, author, zip, sha256, downloads, homepage, capabilities } = entry;
  const pluginApiVersion = entry.pluginApiVersion ?? CURRENT_PLUGIN_API_VERSION;
  if (typeof id !== "string" || id.length > 100 || !ID_PATTERN.test(id)) return null;
  if (!isText(name, 120) || !isText(description) || !isText(author, 120)) return null;
  if (typeof version !== "string" || version !== version.trim() || version.length > 100 || !isValidPluginVersion(version)) return null;
  if (typeof zip !== "string") return null;
  if (source === "bundled" ? !BUNDLED_ZIP_PATTERN.test(zip) : !allowedZipUrl(zip, deps.zipUrlPrefixes)) return null;
  if (typeof sha256 !== "string" || !SHA256_PATTERN.test(sha256)) return null;
  if (typeof downloads !== "number" || !Number.isSafeInteger(downloads) || downloads < 0) return null;
  if (homepage !== undefined && !httpsUrl(homepage)) return null;
  if (typeof pluginApiVersion !== "number" || !Number.isSafeInteger(pluginApiVersion) || pluginApiVersion < 1) return null;
  if (capabilities !== undefined && (!Array.isArray(capabilities) || capabilities.length > 20
    || !capabilities.every((value) => isText(value, 500)))) return null;
  return {
    id, name, version, description, author, downloads, zip, sha256, pluginApiVersion, source,
    compatible: pluginApiVersion === CURRENT_PLUGIN_API_VERSION,
    capabilities: capabilities as string[] | undefined,
    homepage: typeof homepage === "string" ? homepage : undefined,
  };
}

function validateRegistry(data: unknown, deps: PluginMarketplaceDeps, source: "bundled" | "remote") {
  if (typeof data !== "object" || data === null) throw new RegistryFormatError("registry 不是合法的 JSON 对象", "invalid");
  const record = data as Record<string, unknown>;
  if (record.apiVersion !== 1) throw new RegistryFormatError(`插件市场协议版本不支持: ${String(record.apiVersion)}`, "unsupported");
  if (!Array.isArray(record.plugins)) throw new RegistryFormatError("registry 的 plugins 必须是数组", "invalid");
  const plugins: MarketPluginEntry[] = [];
  const snapshot = new Map<string, MarketSnapshotEntry>();
  for (const raw of record.plugins) {
    const entry = validateEntry(raw, deps, source);
    if (!entry) {
      // Never print an untrusted URL/body: it can include credentials, signed links or enormous strings.
      console.warn("[plugins] 插件市场条目校验失败，已跳过");
      continue;
    }
    if (snapshot.has(entry.id)) throw new RegistryFormatError(`registry 存在重复插件 id: ${entry.id}`, "invalid");
    const { zip, sha256, ...display } = entry;
    plugins.push(display);
    snapshot.set(entry.id, { id: entry.id, version: entry.version, zip, sha256, pluginApiVersion: entry.pluginApiVersion, source });
  }
  plugins.sort((a, b) => b.downloads - a.downloads || a.name.localeCompare(b.name, "zh-CN"));
  return { plugins, snapshot };
}

function deadline(ms: number, message: string) {
  const controller = new AbortController();
  const expired = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
  });
  const timer = setTimeout(() => controller.abort(new Error(message)), ms);
  return {
    signal: controller.signal,
    race: <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, expired]),
    close: () => clearTimeout(timer),
  };
}

/**
 * The default transport. Electron's net.fetch rejects redirect: "manual" with "Redirect was cancelled" instead of
 * handing back the 3xx, which made every GitHub release download fail. net.request reports each redirect as an event,
 * so it is turned into a bodiless 3xx Response here and the policy loop in fetchChecked still decides every hop.
 */
type MarketRequestFactory = (options: Electron.ClientRequestConstructorOptions) => Electron.ClientRequest;
// Delay Electron import so service tests exercise the real I/O pipeline without an app process.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const electronRequest: MarketRequestFactory = (options) => (require("electron") as typeof import("electron")).net.request(options);

export function electronMarketFetch(input: string, init?: { signal?: AbortSignal }, createRequest: MarketRequestFactory = electronRequest): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    if (init?.signal?.aborted) { reject(new Error("插件市场请求已取消")); return; }
    const request = createRequest({ url: input, method: "GET", redirect: "manual", credentials: "omit", useSessionCookies: false });
    let settled = false;
    const settle = (finish: () => void) => { if (!settled) { settled = true; init?.signal?.removeEventListener("abort", onAbort); finish(); } };
    const onAbort = () => { request.abort(); settle(() => reject(new Error("插件市场请求已取消"))); };
    init?.signal?.addEventListener("abort", onAbort, { once: true });
    request.on("redirect", (statusCode, _method, redirectUrl) => {
      request.abort();
      settle(() => resolve(new Response(null, { status: statusCode, headers: { location: redirectUrl } })));
    });
    request.on("response", (response) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(response.headers)) for (const item of ([] as string[]).concat(value)) headers.append(name, item);
      const empty = [204, 205, 304].includes(response.statusCode);
      const body = empty ? null : new ReadableStream<Uint8Array>({
        start(controller) {
          response.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
          response.on("end", () => controller.close());
          response.on("error", (error: Error) => controller.error(error));
        },
        cancel() { request.abort(); },
      });
      settle(() => resolve(new Response(body, { status: response.statusCode, headers })));
    });
    request.on("error", (error) => settle(() => reject(error)));
    request.end();
  });
}

export function createPluginMarketplaceService(deps: PluginMarketplaceDeps) {
  const fetchImpl: MarketplaceFetch = deps.fetchImpl ?? ((input, init) => electronMarketFetch(input, init));
  const registryTimeoutMs = deps.registryTimeoutMs ?? MARKET_REGISTRY_TIMEOUT_MS;
  const registryGraceMs = deps.registryGraceMs ?? MARKET_REGISTRY_GRACE_MS;
  const registryMaxBytes = deps.registryMaxBytes ?? MARKET_REGISTRY_MAX_BYTES;
  const zipTimeoutMs = deps.zipTimeoutMs ?? MARKET_ZIP_DOWNLOAD_TIMEOUT_MS;
  const zipMaxBytes = deps.zipMaxBytes ?? MARKET_ZIP_MAX_BYTES;
  let snapshot: Map<string, MarketSnapshotEntry> | null = null;
  let listSeq = 0;
  let installInFlight = false;

  async function fetchChecked(url: string, kind: "registry" | "zip", limit: ReturnType<typeof deadline>): Promise<Response> {
    const first = httpsUrl(url);
    if (!first || (kind === "zip" && !allowedZipUrl(url, deps.zipUrlPrefixes))) throw new Error("插件市场地址不受信任");
    let current = url;
    const githubRelease = first.origin === "https://github.com" && /^\/[^/]+\/[^/]+\/releases\/download\//.test(first.pathname);
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      // net.fetch's response.url is not reliable; enforce policy before each manually followed hop.
      const response = await limit.race(fetchImpl(current, { signal: limit.signal, redirect: "manual", credentials: "omit" }));
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      void response.body?.cancel().catch(() => {});
      const location = response.headers.get("location");
      if (!location || redirects === MAX_REDIRECTS) throw new Error("插件市场重定向次数过多或缺少地址");
      const nextRaw = new URL(location, current).href;
      const next = httpsUrl(nextRaw);
      const allowed = next && (kind === "registry"
        ? deps.registryUrls.includes(nextRaw)
        : allowedZipUrl(nextRaw, deps.zipUrlPrefixes)
          || (githubRelease && next.origin === GITHUB_RELEASE_ASSET_ORIGIN));
      if (!allowed) throw new Error("插件市场重定向地址不受信任");
      current = nextRaw;
    }
    throw new Error("插件市场重定向次数过多");
  }

  async function consume(response: Response, max: number, limit: ReturnType<typeof deadline>, onChunk: (chunk: Uint8Array) => Promise<void>, label: string) {
    if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new Error(`${label}失败（HTTP ${response.status}）`); }
    if (!response.body) throw new Error(`${label}失败（响应无内容）`);
    const reader = response.body.getReader();
    let received = 0;
    try {
      for (;;) {
        const { done, value } = await limit.race(reader.read());
        if (done) break;
        received += value.byteLength;
        if (received > max) throw new Error(`${label}超过 ${label === "插件包" ? "50 MiB" : "1 MiB"} 限制`);
        await limit.race(onChunk(value));
      }
    } finally { void reader.cancel().catch(() => {}); }
  }

  async function fetchRegistryJson(url: string): Promise<unknown> {
    const limit = deadline(registryTimeoutMs, "获取插件目录超时");
    try {
      const response = await fetchChecked(url, "registry", limit);
      const chunks: Buffer[] = [];
      await consume(response, registryMaxBytes, limit, async (chunk) => { chunks.push(Buffer.from(chunk)); }, "插件目录");
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } finally { limit.close(); }
  }

  async function bundledFile(name: string, maxBytes: number): Promise<string> {
    if (!deps.bundledDir) throw new Error("未配置内置插件目录");
    const root = await realpath(deps.bundledDir);
    const file = path.join(root, name);
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes
      || path.dirname(await realpath(file)) !== root) throw new Error("内置插件资源无效或超出大小限制");
    return file;
  }

  async function listMarket(preferred?: string): Promise<MarketListResult> {
    const seq = ++listSeq;
    snapshot = null; // Invalidate before awaiting; an old UI cannot install from a pending refresh.
    const candidates = [...deps.registryUrls, ...(deps.bundledDir ? [BUNDLED_MARKET_SOURCE] : [])];
    if (!candidates.length) return { ok: false, error: "插件市场未配置；可从本地安装插件", plugins: [], sources: [] };
    const ordered = preferred && candidates.includes(preferred)
      ? [preferred, ...candidates.filter((url) => url !== preferred)] : candidates;
    type Probe = { url: string; data: unknown } | { url: string; failure: string };
    const results: Array<Probe | undefined> = new Array(ordered.length).fill(undefined);
    const tasks = ordered.map(async (url, index) => {
      try {
        const data: unknown = url === BUNDLED_MARKET_SOURCE
          ? JSON.parse(await readFile(await bundledFile("registry.json", registryMaxBytes), "utf8"))
          : await fetchRegistryJson(url);
        results[index] = { url, data };
      } catch (error) { results[index] = { url, failure: errorMessage(error) }; }
    });
    const bundledIndex = ordered.indexOf(BUNDLED_MARKET_SOURCE);
    if (bundledIndex >= 0 && registryGraceMs > 0) {
      // A hanging connection must not hold back the bundled catalog: after the grace period the online
      // probes that have not answered are reported as failed and the bundled data is shown.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const grace = new Promise<void>((resolve) => { timer = setTimeout(resolve, registryGraceMs); });
      await Promise.race([Promise.all(tasks), grace]);
      if (timer) clearTimeout(timer);
      await tasks[bundledIndex];
    } else await Promise.all(tasks);
    const probes: Probe[] = ordered.map((url, index) => results[index] ?? { url, failure: "获取插件目录超时" });
    const sources: MarketSourceStatus[] = [];
    const failures: string[] = [];
    let sawUnsupported = false;
    let chosen: ReturnType<typeof validateRegistry> | null = null;
    let chosenSource = "";
    for (const probe of probes) {
      if ("failure" in probe) {
        sources.push({ url: probe.url, ok: false, used: false });
        failures.push(probe.failure ?? "未知错误");
        continue;
      }
      try {
        const parsed = validateRegistry(probe.data, deps, probe.url === BUNDLED_MARKET_SOURCE ? "bundled" : "remote");
        const used = chosen === null;
        sources.push({ url: probe.url, ok: true, used });
        if (used) { chosen = parsed; chosenSource = probe.url; }
      } catch (error) {
        sources.push({ url: probe.url, ok: false, used: false });
        failures.push(errorMessage(error));
        if (error instanceof RegistryFormatError && error.kind === "unsupported") sawUnsupported = true;
      }
    }
    if (chosen) {
      if (seq === listSeq) snapshot = new Map(Array.from(chosen.snapshot, ([id, entry]) => [id, { ...entry, sourceId: chosenSource }]));
      const mode = chosenSource !== BUNDLED_MARKET_SOURCE ? "online"
        : deps.registryUrls.length && preferred !== BUNDLED_MARKET_SOURCE ? "offline-fallback" : "bundled";
      return { ok: true, plugins: chosen.plugins, sources, mode };
    }
    if (seq === listSeq) snapshot = null;
    return { ok: false, error: sawUnsupported ? "插件市场版本不受当前客户端支持，请更新应用"
      : `暂时无法获取插件列表: ${failures.join("；")}`, plugins: [], sources };
  }

  async function sha256File(file: string): Promise<string> {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest("hex");
  }

  async function downloadZip(url: string, tempPath: string): Promise<void> {
    const limit = deadline(zipTimeoutMs, "下载插件包超时");
    try {
      const response = await fetchChecked(url, "zip", limit);
      const file = await open(tempPath, "wx");
      try {
        await consume(response, zipMaxBytes, limit, (chunk) => file.writeFile(chunk), "插件包");
      } finally { await file.close(); }
    } finally { limit.close(); }
  }

  async function installFromMarket(id: string): Promise<MarketInstallResult> {
    if (installInFlight) return { ok: false, error: "已有插件安装任务进行中，请稍候" };
    installInFlight = true;
    try {
      const entry = snapshot?.get(id);
      if (!entry) return { ok: false, error: "插件市场信息已失效，请刷新后重试" };
      if (entry.pluginApiVersion !== CURRENT_PLUGIN_API_VERSION) return { ok: false, error: `插件 API ${entry.pluginApiVersion} 与当前宿主 API ${CURRENT_PLUGIN_API_VERSION} 不兼容` };
      await mkdir(deps.cacheDir, { recursive: true });
      const tempPath = path.join(deps.cacheDir, `${id}-${randomUUID()}.zip`);
      try {
        if (entry.source === "bundled") {
          const match = BUNDLED_ZIP_PATTERN.exec(entry.zip);
          if (!match) throw new Error("内置插件包地址无效");
          await copyFile(await bundledFile(match[1], zipMaxBytes), tempPath, constants.COPYFILE_EXCL);
        } else { await downloadZip(entry.zip, tempPath); }
        if (await sha256File(tempPath) !== entry.sha256.toLowerCase()) throw new Error("插件包校验失败（SHA-256 不匹配）");
        if (!entry.sourceId) throw new Error("插件来源快照缺失，请刷新后重试");
        const result = await deps.installZip(tempPath, { expectedIdentity: { id: entry.id, version: entry.version }, origin: "market",
          packageSource: { kind: entry.source === "bundled" ? "bundled" : "curated-market", sourceId: entry.sourceId, archiveSha256: entry.sha256.toLowerCase() } });
        if (!result.ok) return { ok: false, error: result.canceled ? "已取消安装插件" : result.error ?? "安装插件失败",
          installation: result.installation, activation: result.activation, overview: result.overview };
        return { ok: true, plugin: result.plugin ?? { id: entry.id, name: entry.id, version: entry.version }, overview: result.overview,
          installation: result.installation === "committed" ? "committed" : undefined, activation: result.activation };
      } finally { await rm(tempPath, { force: true }); }
    } catch (error) { return { ok: false, error: errorMessage(error) }; }
    finally { installInFlight = false; }
  }
  return { listMarket, installFromMarket };
}
