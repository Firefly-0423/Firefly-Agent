import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPluginMarketplaceService, type MarketplaceFetch, type PluginMarketplaceDeps } from "./plugin-marketplace";

const catalogs = ["https://catalog.garden.invalid/primary.json", "https://catalog.garden.invalid/backup.json"];
const prefixes = ["https://packages.garden.invalid/releases/", "https://mirror.garden.invalid/releases/"];
const archive = prefixes[0] + "dev.garden.companion-2.3.4/dev.garden.companion-2.3.4.ffplugin";
const bytes = new Uint8Array([42, 67, 89, 110, 131]);
const roots: string[] = [];
const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

const entry = (patch: Record<string, unknown> = {}) => ({
  id: "dev.garden.companion",
  name: "Garden",
  version: "2.3.4",
  sdk: "^1.2.0",
  description: "Garden companion tools",
  author: "Garden maintainers",
  license: "MIT",
  native: false,
  permissions: ["workspace.read"],
  tools: [{ name: "inspect", title: "Inspect", risk: ["fs-read"], modes: ["work", "code"] }],
  capabilities: ["Inspect local garden files"],
  package: archive,
  sha256: digest(bytes),
  ...patch,
});

const json = (plugins: unknown[], apiVersion = 2) =>
  new Response(JSON.stringify({ apiVersion, plugins }));

function service(fetchImpl: MarketplaceFetch, patch: Partial<PluginMarketplaceDeps> = {}) {
  const root = mkdtempSync(join(tmpdir(), "ff-market-contract-"));
  roots.push(root);
  const installPackage = vi.fn(async (_filename: string, options: { expectedIdentity?: { id: string; version: string } }) => ({
    ok: true as const,
    installation: "committed" as const,
    activation: "not-requested" as const,
    plugin: { id: options.expectedIdentity?.id ?? "dev.garden.companion", version: options.expectedIdentity?.version ?? "2.3.4", name: "Garden" },
  }));
  const deps: PluginMarketplaceDeps = {
    registryUrls: catalogs,
    zipUrlPrefixes: prefixes,
    cacheDir: join(root, "downloads"),
    installPackage,
    fetchImpl,
    ...patch,
  };
  return { api: createPluginMarketplaceService(deps), deps, installPackage };
}

async function ready(entryPatch: Record<string, unknown> = {}, depsPatch: Partial<PluginMarketplaceDeps> = {}) {
  const h = service(async (url) => {
    if (url === catalogs[0]) return json([entry(entryPatch)]);
    if (url === archive) return new Response(bytes);
    throw new Error("Unreachable fixture endpoint");
  }, depsPatch);
  await h.api.listMarket();
  return h;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

it("returns the local-install hint without contacting any unconfigured catalog", async () => {
  const fetcher = vi.fn();
  const h = service(fetcher, { registryUrls: [], zipUrlPrefixes: [] });
  expect(await h.api.listMarket()).toEqual({ ok: false, error: "插件市场未配置；可从本地安装插件", plugins: [], sources: [] });
  expect(fetcher).not.toHaveBeenCalled();
});

it("sorts catalog display entries deterministically by name and id", async () => {
  const h = service(async () => json([
    entry({ id: "dev.garden.sprout", name: "Sprout" }),
    entry({ id: "dev.garden.orchid", name: "Orchid" }),
  ]));
  const listed = await h.api.listMarket();
  expect(listed.ok).toBe(true);
  expect(listed.plugins.map((plugin) => plugin.id)).toEqual(["dev.garden.orchid", "dev.garden.sprout"]);
});

it("falls back from a failed primary source to one valid backup entry", async () => {
  const h = service(async (url) => {
    if (url === catalogs[0]) throw new Error("Primary offline");
    return json([entry()]);
  });
  const listed = await h.api.listMarket();
  expect(listed.ok).toBe(true);
  expect(listed.plugins).toHaveLength(1);
});

it("reports the ordered health of the selected primary and unavailable backup", async () => {
  const h = service(async (url) => {
    if (url === catalogs[0]) return json([entry()]);
    throw new Error("Backup offline");
  });
  const listed = await h.api.listMarket();
  expect(listed.ok).toBe(true);
  expect(listed.sources).toEqual([{ url: catalogs[0], ok: true, used: true }, { url: catalogs[1], ok: false, used: false }]);
});

it("clears a successful installation snapshot when all sources fail during refresh", async () => {
  let online = true;
  const h = service(async () => {
    if (!online) throw new Error("Catalog offline");
    return json([entry()]);
  });
  expect((await h.api.listMarket()).ok).toBe(true);
  online = false;
  const failed = await h.api.listMarket();
  expect(failed.ok).toBe(false);
  expect(failed.sources).toEqual(catalogs.map((url) => ({ url, ok: false, used: false })));
  expect(failed.error).toContain("暂时无法获取插件列表");
  expect(await h.api.installFromMarket("dev.garden.companion")).toMatchObject({ ok: false, error: expect.stringContaining("插件市场信息已失效") });
});

it("explains incompatible legacy apiVersion 1 catalogs", async () => {
  const h = service(async () => json([], 1));
  const listed = await h.api.listMarket();
  expect(listed.ok).toBe(false);
  expect(listed.error).toContain("版本不受当前客户端支持");
});

it("rejects a duplicate-id source as a whole and uses its backup", async () => {
  const h = service(async (url) => json(url === catalogs[0] ? [entry(), entry()] : [entry()]));
  const listed = await h.api.listMarket();
  expect(listed.ok).toBe(true);
  expect(listed.plugins).toHaveLength(1);
});

it("drops invalid reverse-domain ids, versions, native:true, safe tools, URLs, hashes and homepages", async () => {
  const h = service(async () => json([
    entry({ id: "short-id" }),
    entry({ id: "dev.garden.badver", version: "2.3" }),
    entry({ id: "dev.garden.native", native: true }),
    entry({ id: "dev.garden.safetool", tools: [{ name: "t", title: "T", risk: ["safe"], modes: ["work"] }] }),
    entry({ id: "dev.garden.badpkg", package: "https://untrusted.invalid/garden.ffplugin" }),
    entry({ id: "dev.garden.badhash", sha256: "invalid" }),
    entry({ id: "dev.garden.badhome", homepage: "http://garden.invalid" }),
    entry({ id: "dev.garden.valid", name: "Valid garden" }),
  ]));
  const listed = await h.api.listMarket();
  expect(listed.ok).toBe(true);
  expect(listed.plugins.map((plugin) => plugin.id)).toEqual(["dev.garden.valid"]);
});

it("accepts packages from either configured release prefix", async () => {
  const h = service(async () => json([
    entry({ id: "dev.garden.primary", name: "A garden" }),
    entry({ id: "dev.garden.mirror", name: "B garden", package: prefixes[1] + "dev.garden.mirror-2.3.4.ffplugin" }),
  ]));
  const listed = await h.api.listMarket();
  expect(listed.ok).toBe(true);
  expect(listed.plugins.map((plugin) => plugin.id)).toEqual(["dev.garden.primary", "dev.garden.mirror"]);
});

it("promotes a preferred source to first probe and selected data source", async () => {
  const calls: string[] = [];
  const h = service(async (url) => {
    calls.push(url);
    return json([entry()]);
  });
  const listed = await h.api.listMarket(catalogs[1]);
  expect(listed.ok).toBe(true);
  expect(calls[0]).toBe(catalogs[1]);
  expect(listed.sources).toEqual([{ url: catalogs[1], ok: true, used: true }, { url: catalogs[0], ok: true, used: false }]);
});

it("returns a late catalog response to its caller while retaining the newest installation snapshot", async () => {
  let release!: () => void;
  let primaryCalls = 0;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const h = service(async (url) => {
    if (url === archive) return new Response(bytes);
    if (url === catalogs[0]) {
      if (++primaryCalls === 1) {
        await gate;
        return json([entry({ id: "dev.garden.outdated" })]);
      }
      throw new Error("Primary no longer available");
    }
    return json([entry({ id: "dev.garden.current" })]);
  });
  const earlier = h.api.listMarket();
  const latest = h.api.listMarket();
  await latest;
  release();
  expect((await earlier).plugins.map((plugin) => plugin.id)).toEqual(["dev.garden.outdated"]);
  expect(await h.api.installFromMarket("dev.garden.current")).toMatchObject({ ok: true });
  expect(h.deps.installPackage).toHaveBeenCalledWith(expect.any(String), {
    expectedIdentity: { id: "dev.garden.current", version: "2.3.4" },
    origin: "market",
    sourceKind: "curated-market",
    sourceId: catalogs[1],
  });
  expect(await h.api.installFromMarket("dev.garden.outdated")).toMatchObject({ ok: false });
});

it("validates the package before installing its pinned identity and cleans the downloaded file", async () => {
  const h = await ready();
  expect(await h.api.installFromMarket("dev.garden.companion")).toMatchObject({
    ok: true,
    plugin: { id: "dev.garden.companion", version: "2.3.4" },
  });
  expect(h.deps.installPackage).toHaveBeenCalledWith(expect.any(String), {
    expectedIdentity: { id: "dev.garden.companion", version: "2.3.4" },
    origin: "market",
    sourceKind: "curated-market",
    sourceId: catalogs[0],
  });
  expect(readdirSync(h.deps.cacheDir)).toEqual([]);
});

it("preserves rollback outcome from installer", async () => {
  const h = await ready({}, {
    installPackage: async () => ({
      ok: false,
      installation: "rejected",
      activation: "rolled-back",
      error: "rolled back to v1.0.0",
    }),
  });
  expect(await h.api.installFromMarket("dev.garden.companion")).toMatchObject({
    ok: false,
    installation: "rejected",
    activation: "rolled-back",
  });
});

it("rejects installation before any catalog snapshot is loaded", async () => {
  const h = service(async () => { throw new Error("No catalog"); });
  expect(await h.api.installFromMarket("dev.garden.companion")).toMatchObject({
    ok: false,
    error: expect.stringContaining("插件市场信息已失效"),
  });
});

it.each([
  ["hash mismatch", { sha256: "a".repeat(64) }, {}, "SHA-256 不匹配"],
  ["oversized archive", {}, { zipMaxBytes: 3 }, "50 MiB"],
] as const)("cleans temporary files after %s", async (_description, record, limits, reason) => {
  const h = await ready(record, limits);
  expect(await h.api.installFromMarket("dev.garden.companion")).toMatchObject({
    ok: false,
    error: expect.stringContaining(reason),
  });
  expect(readdirSync(h.deps.cacheDir)).toEqual([]);
});

it("interrupts a stalled archive stream at the download timeout and cleans its file", async () => {
  const stalled = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([42])); } });
  const h = service(async (url) => {
    if (url === catalogs[0]) return json([entry()]);
    if (url === archive) return new Response(stalled);
    throw new Error("Backup offline");
  }, { zipTimeoutMs: 70 });
  await h.api.listMarket();
  expect(await h.api.installFromMarket("dev.garden.companion")).toMatchObject({
    ok: false,
    error: expect.stringContaining("超时"),
  });
  expect(readdirSync(h.deps.cacheDir)).toEqual([]);
});

it("propagates installation failure and removes the downloaded archive", async () => {
  const h = await ready({}, {
    installPackage: vi.fn(async () => ({ ok: false as const, installation: "rejected" as const, error: "插件已存在" })),
  });
  expect(await h.api.installFromMarket("dev.garden.companion")).toMatchObject({ ok: false, error: "插件已存在" });
  expect(readdirSync(h.deps.cacheDir)).toEqual([]);
});

it("rejects a concurrent installation while allowing the original request to finish", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const h = await ready({}, {
    installPackage: async () => {
      await gate;
      return {
        ok: true as const,
        installation: "committed" as const,
        activation: "not-requested" as const,
        plugin: { id: "dev.garden.companion", name: "Garden", version: "2.3.4" },
      };
    },
  });
  const first = h.api.installFromMarket("dev.garden.companion");
  expect(await h.api.installFromMarket("dev.garden.companion")).toMatchObject({
    ok: false,
    error: expect.stringContaining("已有插件安装任务进行中"),
  });
  release();
  expect(await first).toMatchObject({ ok: true });
});
