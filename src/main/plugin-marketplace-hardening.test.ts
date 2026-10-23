import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginMarketplaceService, MARKET_ZIP_URL_PREFIXES, type MarketplaceFetch, type PluginMarketplaceDeps } from "./plugin-marketplace";
import { probeFileSymlink } from "../../scripts/verify/file-symlink-probe";

const REGISTRY = "https://raw.githubusercontent.com/test/catalog/main/marketplace/registry.json";
const PREFIX = "https://github.com/test/catalog/releases/download/";
const ZIP = `${PREFIX}v1/demo-1.0.0.zip`;
const bytes = new Uint8Array([1, 2, 3]);
const sha = createHash("sha256").update(bytes).digest("hex");
const roots: string[] = [];
const json = (data: unknown) => new Response(JSON.stringify(data));
const entry = (extra: Record<string, unknown> = {}) => ({
  id: "demo", name: "Demo", version: "1.0.0", description: "Offline text tool", author: "Test",
  downloads: 0, zip: ZIP, sha256: sha, pluginApiVersion: 1, capabilities: ["Text processing only"], ...extra,
});
const registry = (entries: unknown[] = [entry()]) => ({ apiVersion: 1, plugins: entries });
function fixture(extra: Partial<PluginMarketplaceDeps> = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "firefly-market-safe-"));
  roots.push(root);
  const deps: PluginMarketplaceDeps = {
    registryUrls: [REGISTRY], zipUrlPrefixes: [PREFIX], cacheDir: path.join(root, "cache"),
    installZip: vi.fn(async () => ({ ok: true, plugin: { id: "demo", name: "Demo", version: "1.0.0" } })),
    fetchImpl: async (url) => url === REGISTRY ? json(registry()) : new Response(bytes),
    ...extra,
  };
  return { root, deps, service: createPluginMarketplaceService(deps) };
}
function bundled(extra: Partial<PluginMarketplaceDeps> = {}, overrides: Record<string, unknown> = {}) {
  const f = fixture(extra);
  const dir = path.join(f.root, "bundle");
  mkdirSync(dir);
  writeFileSync(path.join(dir, "demo-1.0.0.zip"), bytes);
  writeFileSync(path.join(dir, "registry.json"), JSON.stringify(registry([entry({ zip: "bundled:demo-1.0.0.zip", ...overrides })])));
  f.deps.bundledDir = dir;
  return { ...f, dir, service: createPluginMarketplaceService(f.deps) };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("marketplace trusted bundled catalog", () => {
  it("lists and installs a clearly marked bundled entry without a network request", async () => {
    const fetchImpl = vi.fn();
    const f = bundled({ registryUrls: [], fetchImpl });
    const listed = await f.service.listMarket();
    expect(listed).toMatchObject({ ok: true, mode: "bundled", plugins: [{ id: "demo", source: "bundled", pluginApiVersion: 1, compatible: true, capabilities: ["Text processing only"] }] });
    expect(listed.sources).toEqual([{ url: "bundled:registry", ok: true, used: true }]);
    expect(listed.plugins[0]).not.toHaveProperty("zip");
    expect(listed.plugins[0]).not.toHaveProperty("sha256");
    let installed: Buffer | undefined;
    f.deps.installZip = vi.fn(async (file) => { installed = readFileSync(file); return { ok: true }; });
    expect(await f.service.installFromMarket("demo")).toMatchObject({ ok: true });
    expect(installed).toEqual(Buffer.from(bytes));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(readdirSync(f.deps.cacheDir)).toEqual([]);
  });
  it("accepts safe uppercase SemVer prerelease/build metadata in bundled filenames", async () => {
    const name = "demo-1.0.0-RC.1+Build.zip";
    const f = bundled({ registryUrls: [] }, { version: "1.0.0-RC.1+Build", zip: `bundled:${name}` });
    writeFileSync(path.join(f.dir, name), bytes);
    expect((await f.service.listMarket()).plugins[0]).toMatchObject({ version: "1.0.0-RC.1+Build" });
    expect(await f.service.installFromMarket("demo")).toMatchObject({ ok: true });
  });
  it("shows the bundled catalog after the grace period when the online catalog hangs", async () => {
    let aborted = false;
    const hang: MarketplaceFetch = (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }, { once: true });
    });
    const f = bundled({ fetchImpl: hang, registryGraceMs: 40, registryTimeoutMs: 300 });
    const started = Date.now();
    const listed = await f.service.listMarket();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(listed).toMatchObject({ ok: true, mode: "offline-fallback", plugins: [{ id: "demo", source: "bundled" }], sources: [
      { url: REGISTRY, ok: false, used: false }, { url: "bundled:registry", ok: true, used: true },
    ] });
    expect(aborted).toBe(false); // the late probe is simply ignored; it ends at its own deadline
  });

  it("still uses the online catalog when it answers within the grace period", async () => {
    const f = bundled({ registryGraceMs: 1_000, fetchImpl: async () => new Response(JSON.stringify(registry([entry({ id: "online-demo" })])), { headers: { "content-type": "application/json" } }) });
    expect(await f.service.listMarket()).toMatchObject({ ok: true, mode: "online", plugins: [{ id: "online-demo" }] });
  });

  it("waits for the online catalog as before when there is no bundled one", async () => {
    const f = bundled({ registryGraceMs: 20, fetchImpl: () => new Promise<Response>((resolve) => setTimeout(() => resolve(new Response(JSON.stringify(registry([entry({ id: "slow-demo" })])))), 120)) });
    f.deps.bundledDir = undefined;
    expect(await f.service.listMarket()).toMatchObject({ ok: true, mode: "online", plugins: [{ id: "slow-demo" }] });
  });

  it("falls back to bundled data with offline status and keeps remote failure visible", async () => {
    const f = bundled({ fetchImpl: async () => { throw new Error("offline"); } });
    expect(await f.service.listMarket()).toMatchObject({ ok: true, mode: "offline-fallback", sources: [
      { url: REGISTRY, ok: false, used: false }, { url: "bundled:registry", ok: true, used: true },
    ] });
    expect(await f.service.installFromMarket("demo")).toMatchObject({ ok: true });
  });
  it("prefers a healthy online catalog and marks its source honestly", async () => {
    const f = bundled();
    expect(await f.service.listMarket()).toMatchObject({ ok: true, mode: "online", plugins: [{ source: "remote" }] });
  });
  it("rejects changed bundled ZIP bytes before invoking the installer", async () => {
    const f = bundled({ registryUrls: [] });
    await f.service.listMarket();
    writeFileSync(path.join(f.dir, "demo-1.0.0.zip"), "tampered");
    expect(await f.service.installFromMarket("demo")).toMatchObject({ ok: false, error: expect.stringContaining("SHA-256") });
    expect(f.deps.installZip).not.toHaveBeenCalled();
    expect(readdirSync(f.deps.cacheDir)).toEqual([]);
  });
  it.each(["bundled:../escape.zip", "bundled:/escape.zip", "bundled:%2e%2e%2fescape.zip"])("rejects bundled path escape %s", async (zip) => {
    const f = bundled({ registryUrls: [] }, { zip });
    expect((await f.service.listMarket()).plugins).toEqual([]);
    expect(await f.service.installFromMarket("demo")).toMatchObject({ ok: false });
  });
  it("rejects a bundled ZIP symlink outside the trusted directory", async (context) => {
    const f = bundled({ registryUrls: [] });
    await f.service.listMarket();
    const file = path.join(f.dir, "demo-1.0.0.zip");
    const outside = path.join(f.root, "outside.zip");
    writeFileSync(outside, bytes);
    const probe = probeFileSymlink(outside, path.join(f.root, "symlink-probe"));
    if (!probe.supported) context.skip(probe.reason);
    rmSync(file); symlinkSync(outside, file);
    expect(await f.service.installFromMarket("demo")).toMatchObject({ ok: false });
    expect(f.deps.installZip).not.toHaveBeenCalled();
  });
});

describe("marketplace HTTPS and compatibility boundaries", () => {
  it("follows the plugin repository's Release download to its asset CDN", async () => {
    const release = "https://github.com/Firefly-0423/firefly-plugins/releases/download/text-stats-1.0.0/text-stats-1.0.0.zip";
    const asset = "https://release-assets.githubusercontent.com/github-production-release-asset/test";
    const seen: string[] = [];
    const f = fixture({ zipUrlPrefixes: MARKET_ZIP_URL_PREFIXES, fetchImpl: async (url, init) => {
      seen.push(url);
      expect(init).toMatchObject({ redirect: "manual", credentials: "omit" });
      if (url === REGISTRY) return json(registry([entry({ zip: release })]));
      if (url === release) return Response.redirect(asset, 302);
      if (url === asset) return new Response(bytes);
      throw new Error("Unexpected request");
    } });
    await f.service.listMarket();
    expect(await f.service.installFromMarket("demo")).toMatchObject({ ok: true });
    expect(seen).toEqual([REGISTRY, release, asset]);
  });

  it("no longer accepts packages from the application's own repository", async () => {
    const old = "https://github.com/Serendipity-wu02/Firefly_Agent/releases/download/text-stats-1.0.0/text-stats-1.0.0.zip";
    const f = fixture({ zipUrlPrefixes: MARKET_ZIP_URL_PREFIXES, fetchImpl: async () => json(registry([entry({ zip: old })])) });
    expect((await f.service.listMarket()).plugins).toEqual([]);
  });

  it.each([
    "https://github.com/another-owner/firefly-plugins/releases/download/v1/demo.zip",
    "https://github.com/Firefly-0423/another-repository/releases/download/v1/demo.zip",
    "https://github.com/Firefly-0423/firefly-plugins/issues/1",
  ])("still refuses a repository redirect outside the exact Release prefixes: %s", async (target) => {
    const legacy = "https://github.com/Firefly-0423/firefly-plugins/releases/download/v1/demo.zip";
    const seen: string[] = [];
    const f = fixture({ zipUrlPrefixes: MARKET_ZIP_URL_PREFIXES, fetchImpl: async (url) => {
      seen.push(url);
      return url === REGISTRY ? json(registry([entry({ zip: legacy })])) : Response.redirect(target, 301);
    } });
    await f.service.listMarket();
    expect(await f.service.installFromMarket("demo")).toMatchObject({ ok: false });
    expect(seen).toEqual([REGISTRY, legacy]);
    expect(f.deps.installZip).not.toHaveBeenCalled();
  });

  it.each([
    `${PREFIX}../outside.zip`, `${PREFIX}%2e%2e/outside.zip`, `${PREFIX}%2e%2e%2foutside.zip`,
    `${PREFIX}v1%2f..%2f..%2foutside.zip`, `${PREFIX}v1\\..\\..\\outside.zip`,
    "https://github.com.evil.test/test/catalog/releases/download/v1/demo.zip",
    "https://user:secret@github.com/test/catalog/releases/download/v1/demo.zip", "bundled:demo-1.0.0.zip",
  ])("rejects unsafe remote package URL %s", async (zip) => {
    const f = fixture({ fetchImpl: async () => json(registry([entry({ zip })])) });
    expect((await f.service.listMarket()).plugins).toEqual([]);
  });
  it("shows incompatible entries but rejects install before downloading", async () => {
    const fetchImpl = vi.fn(async () => json(registry([entry({ pluginApiVersion: 2 })])));
    const f = fixture({ fetchImpl });
    expect((await f.service.listMarket()).plugins[0]).toMatchObject({ pluginApiVersion: 2, compatible: false });
    expect(await f.service.installFromMarket("demo")).toMatchObject({ ok: false, error: expect.stringContaining("不兼容") });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(f.deps.installZip).not.toHaveBeenCalled();
  });
  it("does not follow registry redirects outside the configured exact sources", async () => {
    const seen: string[] = [];
    const f = fixture({ fetchImpl: async (url) => { seen.push(url); return Response.redirect("https://evil.test/registry.json", 302); } });
    expect((await f.service.listMarket()).ok).toBe(false);
    expect(seen).toEqual([REGISTRY]);
  });
  it("follows a GitHub Release redirect only to its HTTPS asset CDN without credentials", async () => {
    const asset = "https://release-assets.githubusercontent.com/github-production-release-asset/123/file?sig=example";
    const fetchImpl = vi.fn<MarketplaceFetch>(async (url) => {
      if (url === REGISTRY) return json(registry());
      if (url === ZIP) return Response.redirect(asset, 302);
      if (url === asset) return new Response(bytes);
      throw new Error("unexpected request");
    });
    const f = fixture({ fetchImpl }); await f.service.listMarket();
    expect(await f.service.installFromMarket("demo")).toMatchObject({ ok: true });
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([REGISTRY, ZIP, asset]);
    for (const [, init] of fetchImpl.mock.calls) expect(init).toMatchObject({ redirect: "manual", credentials: "omit" });
  });
  it.each(["https://evil.test/payload.zip", "http://release-assets.githubusercontent.com/file", "file:///tmp/secret", "https://release-assets.githubusercontent.com.evil.test/file"])("rejects ZIP redirect %s before fetching it", async (target) => {
    const seen: string[] = [];
    const f = fixture({ fetchImpl: async (url) => { seen.push(url); return url === REGISTRY ? json(registry()) : Response.redirect(target, 302); } });
    await f.service.listMarket();
    expect(await f.service.installFromMarket("demo")).toMatchObject({ ok: false });
    expect(seen).toEqual([REGISTRY, ZIP]);
    expect(f.deps.installZip).not.toHaveBeenCalled();
  });
  it("bounds repeated ZIP redirects", async () => {
    const fetchImpl = vi.fn<MarketplaceFetch>(async (url) => url === REGISTRY ? json(registry()) : Response.redirect(ZIP, 302));
    const f = fixture({ fetchImpl }); await f.service.listMarket();
    expect(await f.service.installFromMarket("demo")).toMatchObject({ ok: false, error: expect.stringContaining("重定向") });
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(7);
  });
  it("aborts a hanging registry stream and rejects oversized registries", async () => {
    const f = fixture({ registryTimeoutMs: 30, fetchImpl: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); } })) });
    expect((await f.service.listMarket()).ok).toBe(false);
    const g = fixture({ registryMaxBytes: 32, fetchImpl: async () => json(registry()) });
    expect((await g.service.listMarket()).ok).toBe(false);
  });
  it("invalidates the old install snapshot immediately when refresh starts", async () => {
    let resolve!: (r: Response) => void;
    let first = true;
    const f = fixture({ fetchImpl: async () => {
      if (first) { first = false; return json(registry()); }
      return new Promise<Response>((r) => { resolve = r; });
    } });
    await f.service.listMarket();
    const refresh = f.service.listMarket();
    expect(await f.service.installFromMarket("demo")).toMatchObject({ ok: false, error: expect.stringContaining("失效") });
    resolve(json(registry())); await refresh;
  });
});
