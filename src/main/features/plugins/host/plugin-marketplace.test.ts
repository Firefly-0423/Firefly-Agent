import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPluginMarketplaceService, type MarketplaceFetch, type PluginMarketplaceDeps } from "./plugin-marketplace";

const catalogs = ["https://catalog.garden.invalid/primary.json", "https://catalog.garden.invalid/backup.json"];
const prefixes = ["https://packages.garden.invalid/releases/", "https://mirror.garden.invalid/releases/"];
const archive = prefixes[0] + "garden-2.3.4.zip", bytes = new Uint8Array([42, 67, 89, 110, 131]);
const roots: string[] = [];
const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const entry = (patch: Record<string, unknown> = {}) => ({ id: "garden", name: "Garden", version: "2.3.4",
  description: "Garden companion tools", author: "Garden maintainers", downloads: 6, zip: archive, sha256: digest(bytes), ...patch });
const json = (plugins: unknown[], apiVersion = 1) => new Response(JSON.stringify({ plugins, apiVersion, updatedAt: "2026-10-20" }));
function service(fetchImpl: MarketplaceFetch, patch: Partial<PluginMarketplaceDeps> = {}) {
  const root = mkdtempSync(join(tmpdir(), "ff-market-contract-")); roots.push(root);
  const installZip = vi.fn(async (_filename: string, options: { expectedIdentity: { id: string; version: string } }) =>
    ({ ok: true, plugin: { ...options.expectedIdentity, name: "Garden" }, overview: undefined }));
  const deps: PluginMarketplaceDeps = { registryUrls: catalogs, zipUrlPrefixes: prefixes, cacheDir: join(root, "downloads"),
    installZip, fetchImpl, ...patch };
  return { api: createPluginMarketplaceService(deps), deps, installZip };
}
async function ready(entryPatch: Record<string, unknown> = {}, depsPatch: Partial<PluginMarketplaceDeps> = {}) {
  const h = service(async url => {
    if (url === catalogs[0]) return json([entry(entryPatch)]);
    if (url === archive) return new Response(bytes);
    throw new Error("Unreachable fixture endpoint");
  }, depsPatch);
  await h.api.listMarket();
  return h;
}
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true }); });
it("returns the local-install hint without contacting any unconfigured catalog", async () => {
  const fetcher = vi.fn();
  const h = service(fetcher, { registryUrls: [], zipUrlPrefixes: [] });
  expect(await h.api.listMarket()).toEqual({ ok: false, error: "插件市场未配置；可从本地安装插件", plugins: [], sources: [] });
  expect(fetcher).not.toHaveBeenCalled();
});
it("sorts catalog display entries by descending downloads", async () => {
  const h = service(async () => json([entry({ id: "sprout", downloads: 3 }), entry({ id: "orchid", downloads: 76 })]));
  const listed = await h.api.listMarket();
  expect(listed.ok).toBe(true);
  expect(listed.plugins.map(plugin => plugin.id)).toEqual(["orchid", "sprout"]);
});
it("falls back from a failed primary source to one valid backup entry", async () => {
  const h = service(async url => { if (url === catalogs[0]) throw new Error("Primary offline"); return json([entry()]); });
  const listed = await h.api.listMarket();
  expect(listed.ok).toBe(true);
  expect(listed.plugins).toHaveLength(1);
});
it("reports the ordered health of the selected primary and unavailable backup", async () => {
  const h = service(async url => { if (url === catalogs[0]) return json([entry()]); throw new Error("Backup offline"); });
  const listed = await h.api.listMarket();
  expect(listed.ok).toBe(true);
  expect(listed.sources).toEqual([{ url: catalogs[0], ok: true, used: true }, { url: catalogs[1], ok: false, used: false }]);
});
it("clears a successful installation snapshot when all sources fail during refresh", async () => {
  let online = true;
  const h = service(async () => { if (!online) throw new Error("Catalog offline"); return json([entry()]); });
  expect((await h.api.listMarket()).ok).toBe(true);
  online = false;
  const failed = await h.api.listMarket();
  expect(failed.ok).toBe(false);
  expect(failed.sources).toEqual(catalogs.map(url => ({ url, ok: false, used: false })));
  expect(failed.error).toContain("暂时无法获取插件列表");
  expect(await h.api.installFromMarket("garden")).toMatchObject({ ok: false, error: expect.stringContaining("插件市场信息已失效") });
});
it("explains incompatible catalog protocol versions", async () => {
  const h = service(async () => json([], 2)), listed = await h.api.listMarket();
  expect(listed.ok).toBe(false);
  expect(listed.error).toContain("版本不受当前客户端支持");
});
it("rejects a duplicate-id source as a whole and uses its backup", async () => {
  const h = service(async url => json(url === catalogs[0] ? [entry(), entry()] : [entry()]));
  const listed = await h.api.listMarket();
  expect(listed.ok).toBe(true);
  expect(listed.plugins).toHaveLength(1);
});
it("drops individually invalid ids, versions, URLs, hashes, counts and homepages", async () => {
  const h = service(async () => json([
    entry({ id: "Garden invalid" }), entry({ id: "invalid-version", version: "2.3" }),
    entry({ id: "invalid-package", zip: "https://untrusted.invalid/garden.zip" }), entry({ id: "invalid-hash", sha256: "invalid" }),
    entry({ id: "invalid-downloads", downloads: -9 }), entry({ id: "invalid-home", homepage: "http://garden.invalid" }),
    entry({ id: "valid-garden", name: "Valid garden" }),
  ]));
  const listed = await h.api.listMarket();
  expect(listed.ok).toBe(true);
  expect(listed.plugins.map(plugin => plugin.id)).toEqual(["valid-garden"]);
});
it("accepts packages from either configured release prefix in display order", async () => {
  const h = service(async () => json([entry({ id: "primary-garden", name: "A garden" }),
    entry({ id: "mirror-garden", name: "B garden", zip: prefixes[1] + "garden-2.3.4.zip" })]));
  const listed = await h.api.listMarket();
  expect(listed.ok).toBe(true);
  expect(listed.plugins.map(plugin => plugin.id)).toEqual(["primary-garden", "mirror-garden"]);
});
it("promotes a preferred source to first probe and selected data source", async () => {
  const calls: string[] = [];
  const h = service(async url => { calls.push(url); return json([entry()]); });
  const listed = await h.api.listMarket(catalogs[1]);
  expect(listed.ok).toBe(true);
  expect(calls[0]).toBe(catalogs[1]);
  expect(listed.sources).toEqual([{ url: catalogs[1], ok: true, used: true }, { url: catalogs[0], ok: true, used: false }]);
});
it("returns a late catalog response to its caller while retaining the newest installation snapshot", async () => {
  let release!: () => void, primaryCalls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const h = service(async url => {
    if (url === archive) return new Response(bytes);
    if (url === catalogs[0]) {
      if (++primaryCalls === 1) { await gate; return json([entry({ id: "outdated-garden" })]); }
      throw new Error("Primary no longer available");
    }
    return json([entry({ id: "current-garden" })]);
  });
  const earlier = h.api.listMarket(), latest = h.api.listMarket();
  await latest;
  release();
  expect((await earlier).plugins.map(plugin => plugin.id)).toEqual(["outdated-garden"]);
  expect(await h.api.installFromMarket("current-garden")).toMatchObject({ ok: true });
  expect(h.deps.installZip).toHaveBeenCalledWith(expect.any(String), {
    expectedIdentity: { id: "current-garden", version: "2.3.4" }, origin: "market",
    packageSource: { kind: "curated-market", sourceId: catalogs[1], archiveSha256: digest(bytes) },
  });
  expect(await h.api.installFromMarket("outdated-garden")).toMatchObject({ ok: false });
});
it("validates the archive before installing its pinned identity and cleans the downloaded file", async () => {
  const h = await ready();
  expect(await h.api.installFromMarket("garden")).toMatchObject({ ok: true, plugin: { id: "garden", version: "2.3.4" } });
  expect(h.deps.installZip).toHaveBeenCalledWith(expect.any(String), { expectedIdentity: { id: "garden", version: "2.3.4" }, origin: "market",
    packageSource: { kind: "curated-market", sourceId: catalogs[0], archiveSha256: digest(bytes) } });
  expect(readdirSync(h.deps.cacheDir)).toEqual([]);
});
it("preserves committed installation with deferred activation", async () => {
  const h = await ready({}, { installZip: async () => ({ ok: true, installation: "committed", activation: "restart-required" }) });
  expect(await h.api.installFromMarket("garden")).toMatchObject({ ok: true, installation: "committed", activation: "restart-required" });
});
it("rejects installation before any catalog snapshot is loaded", async () => {
  const h = service(async () => { throw new Error("No catalog"); });
  expect(await h.api.installFromMarket("garden")).toMatchObject({ ok: false, error: expect.stringContaining("插件市场信息已失效") });
});
it.each([
  ["hash mismatch", { sha256: "a".repeat(64) }, {}, "SHA-256 不匹配"],
  ["oversized archive", {}, { zipMaxBytes: 3 }, "50 MiB"],
] as const)("cleans temporary files after %s", async (_description, record, limits, reason) => {
  const h = await ready(record, limits);
  expect(await h.api.installFromMarket("garden")).toMatchObject({ ok: false, error: expect.stringContaining(reason) });
  expect(readdirSync(h.deps.cacheDir)).toEqual([]);
});
it("interrupts a stalled archive stream at the download timeout and cleans its file", async () => {
  const stalled = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([42])); } });
  const h = service(async url => {
    if (url === catalogs[0]) return json([entry()]);
    if (url === archive) return new Response(stalled);
    throw new Error("Backup offline");
  }, { zipTimeoutMs: 70 });
  await h.api.listMarket();
  expect(await h.api.installFromMarket("garden")).toMatchObject({ ok: false, error: expect.stringContaining("超时") });
  expect(readdirSync(h.deps.cacheDir)).toEqual([]);
});
it("propagates installation failure and removes the downloaded archive", async () => {
  const h = await ready({}, { installZip: vi.fn(async () => ({ ok: false, error: "插件已存在" })) });
  expect(await h.api.installFromMarket("garden")).toMatchObject({ ok: false, error: "插件已存在" });
  expect(readdirSync(h.deps.cacheDir)).toEqual([]);
});
it("rejects a concurrent installation while allowing the original request to finish", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const h = await ready({}, { installZip: async () => { await gate; return { ok: true, plugin: { id: "garden", name: "Garden", version: "2.3.4" } }; } });
  const first = h.api.installFromMarket("garden");
  expect(await h.api.installFromMarket("garden")).toMatchObject({ ok: false, error: expect.stringContaining("已有插件安装任务进行中") });
  release();
  expect(await first).toMatchObject({ ok: true });
});
