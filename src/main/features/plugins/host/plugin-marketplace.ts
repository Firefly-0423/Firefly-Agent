import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, open, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { isValidPluginVersion } from "../../../../shared/version";
import {
  PLUGIN_PERMISSIONS,
  PLUGIN_TOOL_MODES,
  PLUGIN_TOOL_RISKS,
  parseRange,
  parseSemVer,
  satisfiesRange,
} from "../../../../shared/plugin-manifest";
import { PLUGIN_HOST_VERSION } from "../../../../plugins/v2/package/importer";
import type {
  MarketInstallResult,
  MarketListResult,
  MarketPluginEntry,
  MarketSourceStatus,
  MarketToolSummary,
} from "../../../../shared/plugin-management";
import type { PluginV2ImportOptions, PluginV2ImportResult } from "./plugin-v2-services";

// Keep the v2 catalog separate from the legacy v1 directory on main. GitHub Release
// assets remain supported. Repository files are bound to the official v2 catalog.
export const MARKET_V2_REPOSITORY_ROOT = "https://raw.githubusercontent.com/Firefly-0423/firefly-plugins/marketplace-v2/marketplace/";
const REPOSITORY_CATALOG_URL = `${MARKET_V2_REPOSITORY_ROOT}registry.json`;
export const MARKET_REGISTRY_URLS: readonly string[] = [
  REPOSITORY_CATALOG_URL,
];
export const MARKET_ZIP_URL_PREFIXES: readonly string[] = [
  "https://github.com/Firefly-0423/firefly-plugins/releases/download/",
];
export const MARKET_REGISTRY_API_VERSION = 2;
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
  sdk: string;
  compatible: boolean;
  packageUrl: string;
  sha256: string;
  repositoryPackage: boolean;
  source: "bundled" | "remote";
}

export type MarketplaceFetch = (
  input: string,
  init?: { signal?: AbortSignal; redirect?: "manual"; credentials?: "omit" },
) => Promise<Response>;

export interface PluginMarketplaceDeps {
  registryUrls: readonly string[];
  zipUrlPrefixes: readonly string[];
  /** App-owned generated catalog/package directory, never supplied by Renderer or a remote catalog. */
  bundledDir?: string;
  cacheDir: string;
  hostVersion?: string;
  installPackage: (
    packagePath: string,
    opts: PluginV2ImportOptions,
  ) => Promise<PluginV2ImportResult>;
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
const ID_PATTERN = /^[a-z0-9]+(\.[a-z0-9-]+){2,}$/;
const SHA256_PATTERN = /^[0-9a-fA-F]{64}$/;
const BUNDLED_PACKAGE_PATTERN = /^bundled:([a-zA-Z0-9][a-zA-Z0-9.+-]*\.(?:ffplugin|zip))$/;
const ALLOWED_PERMISSIONS = new Set<string>(PLUGIN_PERMISSIONS);
const ALLOWED_RISKS = new Set<string>(PLUGIN_TOOL_RISKS);
const ALLOWED_MODES = new Set<string>(PLUGIN_TOOL_MODES);

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

function parseAuthor(raw: unknown): string | null {
  if (isText(raw, 200)) return raw;
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const name = (raw as { name?: unknown }).name;
    if (isText(name, 200)) return name;
  }
  return null;
}

function parsePermissions(raw: unknown): string[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > PLUGIN_PERMISSIONS.length) return null;
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !ALLOWED_PERMISSIONS.has(item)) return null;
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

function parseTools(raw: unknown): MarketToolSummary[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 100) return null;
  const out: MarketToolSummary[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
    const record = item as Record<string, unknown>;
    if (!isText(record.name, 120) || !isText(record.title, 200)) return null;
    if (!Array.isArray(record.risk) || record.risk.length === 0 || record.risk.some((r) => typeof r !== "string" || !ALLOWED_RISKS.has(r))) return null;
    if (!Array.isArray(record.modes) || record.modes.length === 0 || record.modes.some((m) => typeof m !== "string" || !ALLOWED_MODES.has(m))) return null;
    out.push({
      name: record.name,
      title: record.title,
      risk: [...record.risk] as string[],
      modes: [...record.modes] as string[],
    });
  }
  return out;
}

function validateEntry(
  raw: unknown,
  deps: PluginMarketplaceDeps,
  source: "bundled" | "remote",
  hostVersion: string,
  catalogUrl: string,
): (MarketPluginEntry & MarketSnapshotEntry) | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  const { id, name, version, sdk, description, sha256, homepage, capabilities, license } = entry;
  const packageUrl = entry.package;
  if (typeof id !== "string" || id.length < 6 || id.length > 64 || !ID_PATTERN.test(id)) return null;
  if (!isText(name, 120) || !isText(description)) return null;
  const author = parseAuthor(entry.author);
  if (!author) return null;
  if (typeof version !== "string" || version !== version.trim() || version.length > 100 || !isValidPluginVersion(version)) return null;
  if (!isText(sdk, 100)) return null;
  const parsedRange = parseRange(sdk);
  const parsedHost = parseSemVer(hostVersion);
  if (!parsedRange) return null;
  const compatible = Boolean(parsedHost && satisfiesRange(parsedHost, parsedRange));
  // Spec §4 rule 7 & §9: online/market catalog strictly forbids native: true packages.
  if (entry.native !== false) return null;
  const permissions = parsePermissions(entry.permissions);
  if (!permissions) return null;
  const tools = parseTools(entry.tools);
  if (!tools) return null;
  if (typeof packageUrl !== "string") return null;
  const repositoryPackage = source === "remote" && catalogUrl === REPOSITORY_CATALOG_URL
    && packageUrl === `${MARKET_V2_REPOSITORY_ROOT}packages/${id}-${encodeURIComponent(version)}.ffplugin`;
  if (source === "bundled" ? !BUNDLED_PACKAGE_PATTERN.test(packageUrl)
    : !repositoryPackage && !allowedZipUrl(packageUrl, deps.zipUrlPrefixes)) return null;
  if (typeof sha256 !== "string" || !SHA256_PATTERN.test(sha256)) return null;
  if (homepage !== undefined && !httpsUrl(homepage)) return null;
  if (license !== undefined && !isText(license, 120)) return null;
  if (capabilities !== undefined && (!Array.isArray(capabilities) || capabilities.length > 20
    || !capabilities.every((value) => isText(value, 500)))) return null;
  return {
    id,
    name,
    version,
    sdk,
    description,
    author,
    native: false,
    permissions,
    tools,
    packageUrl,
    sha256,
    repositoryPackage,
    source,
    compatible,
    ...(typeof license === "string" ? { license } : {}),
    ...(capabilities !== undefined ? { capabilities: capabilities as string[] } : {}),
    ...(typeof homepage === "string" ? { homepage } : {}),
  };
}

function validateRegistry(
  data: unknown,
  deps: PluginMarketplaceDeps,
  source: "bundled" | "remote",
  hostVersion: string,
  catalogUrl: string,
) {
  if (typeof data !== "object" || data === null) throw new RegistryFormatError("registry 不是合法的 JSON 对象", "invalid");
  const record = data as Record<string, unknown>;
  if (record.apiVersion !== MARKET_REGISTRY_API_VERSION) {
    throw new RegistryFormatError(`插件市场协议版本不支持: ${String(record.apiVersion)}`, "unsupported");
  }
  if (!Array.isArray(record.plugins)) throw new RegistryFormatError("registry 的 plugins 必须是数组", "invalid");
  const plugins: MarketPluginEntry[] = [];
  const snapshot = new Map<string, MarketSnapshotEntry>();
  for (const raw of record.plugins) {
    const entry = validateEntry(raw, deps, source, hostVersion, catalogUrl);
    if (!entry) {
      // Never print an untrusted URL/body: it can include credentials, signed links or enormous strings.
      console.warn("[plugins] 插件市场条目校验失败，已跳过");
      continue;
    }
    if (snapshot.has(entry.id)) throw new RegistryFormatError(`registry 存在重复插件 id: ${entry.id}`, "invalid");
    const { packageUrl, sha256, repositoryPackage, ...display } = entry;
    plugins.push(display);
    snapshot.set(entry.id, {
      id: entry.id,
      version: entry.version,
      sdk: entry.sdk,
      compatible: entry.compatible ?? false,
      packageUrl,
      sha256,
      repositoryPackage,
      source,
    });
  }
  plugins.sort((a, b) => a.name.localeCompare(b.name, "zh-CN") || a.id.localeCompare(b.id));
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
/** How much of a download may wait in memory, unread, before the response is paused. */
const MARKET_STREAM_BUFFER_BYTES = 1024 * 1024;
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
      // Bounded buffering: once MARKET_STREAM_BUFFER_BYTES are queued and not yet read, the response is paused until the
      // reader catches up, so a fast download onto slow storage cannot pile up in main-process memory.
      // Electron types IncomingMessage as a plain emitter; at runtime it implements Node's Readable, pause and resume included.
      const flow = response as unknown as Pick<NodeJS.ReadableStream, "pause" | "resume">;
      const body = empty ? null : new ReadableStream<Uint8Array>({
        start(controller) {
          response.on("data", (chunk: Buffer) => {
            controller.enqueue(new Uint8Array(chunk));
            if ((controller.desiredSize ?? 1) <= 0) flow.pause();
          });
          response.on("end", () => controller.close());
          response.on("error", (error: Error) => controller.error(error));
        },
        pull() { flow.resume(); },
        cancel() { request.abort(); },
      }, new ByteLengthQueuingStrategy({ highWaterMark: MARKET_STREAM_BUFFER_BYTES }));
      settle(() => resolve(new Response(body, { status: response.statusCode, headers })));
    });
    request.on("error", (error) => settle(() => reject(error)));
    request.end();
  });
}

export function createPluginMarketplaceService(deps: PluginMarketplaceDeps) {
  const fetchImpl: MarketplaceFetch = deps.fetchImpl ?? ((input, init) => electronMarketFetch(input, init));
  const hostVersion = deps.hostVersion ?? PLUGIN_HOST_VERSION;
  const registryTimeoutMs = deps.registryTimeoutMs ?? MARKET_REGISTRY_TIMEOUT_MS;
  const registryGraceMs = deps.registryGraceMs ?? MARKET_REGISTRY_GRACE_MS;
  const registryMaxBytes = deps.registryMaxBytes ?? MARKET_REGISTRY_MAX_BYTES;
  const zipTimeoutMs = deps.zipTimeoutMs ?? MARKET_ZIP_DOWNLOAD_TIMEOUT_MS;
  const zipMaxBytes = deps.zipMaxBytes ?? MARKET_ZIP_MAX_BYTES;
  let snapshot: Map<string, MarketSnapshotEntry> | null = null;
  let listSeq = 0;
  let installInFlight = false;

  async function fetchChecked(url: string, kind: "registry" | "zip", limit: ReturnType<typeof deadline>, repositoryPackage = false): Promise<Response> {
    const first = httpsUrl(url);
    if (!first || (kind === "zip" && !repositoryPackage && !allowedZipUrl(url, deps.zipUrlPrefixes))) throw new Error("插件市场地址不受信任");
    let current = url;
    const githubRelease = first.origin === "https://github.com" && /^\/[^/]+\/[^/]+\/releases\/download\//.test(first.pathname);
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      // net.fetch's response.url is not reliable; enforce policy before each manually followed hop.
      const response = await limit.race(fetchImpl(current, { signal: limit.signal, redirect: "manual", credentials: "omit" }));
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      void response.body?.cancel().catch(() => {});
      if (repositoryPackage) throw new Error("仓库插件包不允许重定向");
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
        const parsed = validateRegistry(probe.data, deps, probe.url === BUNDLED_MARKET_SOURCE ? "bundled" : "remote", hostVersion, probe.url);
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

  async function downloadPackage(entry: MarketSnapshotEntry, tempPath: string): Promise<void> {
    const limit = deadline(zipTimeoutMs, "下载插件包超时");
    try {
      const response = await fetchChecked(entry.packageUrl, "zip", limit, entry.repositoryPackage);
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
      if (!entry.compatible) {
        return { ok: false, error: `插件要求 Firefly ${entry.sdk}，与当前宿主 ${hostVersion} 不兼容` };
      }
      await mkdir(deps.cacheDir, { recursive: true });
      const ext = entry.packageUrl.endsWith(".zip") ? ".zip" : ".ffplugin";
      const tempPath = path.join(deps.cacheDir, `${id}-${randomUUID()}${ext}`);
      try {
        if (entry.source === "bundled") {
          const match = BUNDLED_PACKAGE_PATTERN.exec(entry.packageUrl);
          if (!match) throw new Error("内置插件包地址无效");
          await copyFile(await bundledFile(match[1], zipMaxBytes), tempPath, constants.COPYFILE_EXCL);
        } else { await downloadPackage(entry, tempPath); }
        if (await sha256File(tempPath) !== entry.sha256.toLowerCase()) throw new Error("插件包校验失败（SHA-256 不匹配）");
        if (!entry.sourceId) throw new Error("插件来源快照缺失，请刷新后重试");
        const result = await deps.installPackage(tempPath, {
          expectedIdentity: { id: entry.id, version: entry.version },
          origin: "market",
          sourceKind: entry.source === "bundled" ? "bundled" : "curated-market",
          sourceId: entry.sourceId,
        });
        if (!result.ok) {
          return {
            ok: false,
            error: result.error || "安装插件失败",
            // Market imports are never held for replacement confirmation; treat it as a rejection if it ever occurs.
            installation: "rejected",
            ...(result.installation === "rejected" && result.activation ? { activation: result.activation } : {}),
          };
        }
        return {
          ok: true,
          plugin: result.plugin,
          installation: result.installation,
          activation: result.activation,
        };
      } finally { await rm(tempPath, { force: true }); }
    } catch (error) { return { ok: false, error: errorMessage(error) }; }
    finally { installInFlight = false; }
  }
  return { listMarket, installFromMarket };
}
