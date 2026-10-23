import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildMarketplace } from "../../scripts/plugin-marketplace/build.mjs";
import { PluginManager } from "../plugins/manager";
import type { PluginTool } from "../plugins/api";
import { createPluginMarketplaceService } from "./plugin-marketplace";

const registryUrl = "https://raw.githubusercontent.com/test/plugins/main/marketplace/registry.json";
const prefix = "https://github.com/test/plugins/releases/download/";
let root: string;
let manager: PluginManager;
let tools: Map<string, PluginTool>;
let enabled: Record<string, boolean>;
let bundledDir: string;
let initialZip: Uint8Array;
let baseEntry: Record<string, unknown>;
let replaceAllowed: boolean;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

beforeEach(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), "firefly-market-loop-"));
  const pluginRoot = path.join(root, "plugins");
  mkdirSync(pluginRoot);
  bundledDir = path.join(root, "bundle");
  const artifacts = await buildMarketplace({ outDir: bundledDir });
  initialZip = new Uint8Array(readFileSync(artifacts.zipPath));
  baseEntry = JSON.parse(readFileSync(artifacts.registryPath, "utf8")).plugins[0];
  tools = new Map(); enabled = {}; replaceAllowed = true;
  manager = new PluginManager({
    scanRoots: [{ path: pluginRoot, source: "user" }],
    storageRoot: path.join(root, "plugin-data"),
    loadEnabledMap: () => ({ ...enabled }), saveEnabledMap: (next) => { enabled = { ...next }; },
    confirmPluginReplace: async () => replaceAllowed,
    runtime: {
      toolRegistry: { register: (tool) => { tools.set(tool.id, tool); }, unregister: (id) => tools.delete(id), getById: (id) => tools.get(id) },
      channelManager: { has: () => false, register() {}, unregister: async () => true, startOne: async () => {} },
      registerIpc() {}, unregisterIpc() {},
    },
  });
  await manager.start();
});
afterEach(async () => { await manager?.stop(); if (root) rmSync(root, { recursive: true, force: true }); });

function localMarket() {
  return createPluginMarketplaceService({ registryUrls: [], zipUrlPrefixes: [], bundledDir,
    cacheDir: path.join(root, "cache"), installZip: (file, opts) => manager.installZip(file, opts),
    fetchImpl: async () => { throw new Error("Bundled install must not contact the network"); },
  });
}
async function zipWith(version: string, apiVersion = 1, traversal = false) {
  const zip = await JSZip.loadAsync(initialZip);
  const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
  zip.file("manifest.json", JSON.stringify({ ...manifest, version, apiVersion }));
  if (traversal) zip.file("../escaped.txt", "outside");
  return new Uint8Array(await zip.generateAsync({ type: "nodebuffer" }));
}
function onlineMarket(bytes: Uint8Array, version: string, extra: Record<string, unknown> = {}) {
  const zipUrl = `${prefix}v${version}/text-stats-${version}.zip`;
  return createPluginMarketplaceService({
    registryUrls: [registryUrl], zipUrlPrefixes: [prefix], cacheDir: path.join(root, "cache"),
    installZip: (file, opts) => manager.installZip(file, opts),
    fetchImpl: async (url) => url === registryUrl
      ? new Response(JSON.stringify({ apiVersion: 1, plugins: [{ ...baseEntry, version, zip: zipUrl, sha256: sha(bytes), ...extra }] }))
      : new Response(bytes),
  });
}
async function installInitial() {
  const market = localMarket();
  expect(await market.listMarket()).toMatchObject({ ok: true, mode: "bundled" });
  expect(await market.installFromMarket("text-stats")).toMatchObject({ ok: true });
  return market;
}

describe("real marketplace / installer / manager loop", () => {
  it("installs disabled, enables the real tool, updates while retaining private data, then disables and removes", async () => {
    await installInitial();
    expect(manager.list()).toEqual([expect.objectContaining({ id: "text-stats", version: "1.0.0", origin: "market", status: "disabled", enabled: false })]);
    expect(tools.size).toBe(0);
    expect(await manager.setEnabled("text-stats", true)).toEqual({ ok: true });
    const tool = tools.get("text-stats_count")!;
    expect(tool).toBeDefined();
    expect(JSON.parse(await tool.execute({ text: "Hi 😀\n\n世界" }, { userQuery: "count" }))).toEqual({ characters: 8, words: 3, nonEmptyLines: 2 });
    const dataDir = path.join(root, "plugin-data", "text-stats");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(path.join(dataDir, "keep.txt"), "private preferences");
    const update = onlineMarket(await zipWith("1.1.0"), "1.1.0");
    expect(await update.listMarket()).toMatchObject({ ok: true, mode: "online" });
    expect(await update.installFromMarket("text-stats")).toMatchObject({ ok: true, plugin: { version: "1.1.0" } });
    expect(manager.list()[0]).toMatchObject({ version: "1.1.0", status: "running", origin: "market" });
    expect(tools.size).toBe(1);
    expect(readFileSync(path.join(dataDir, "keep.txt"), "utf8")).toBe("private preferences");
    expect(await manager.setEnabled("text-stats", false)).toEqual({ ok: true });
    expect(tools.size).toBe(0);
    expect(await manager.uninstall("text-stats")).toMatchObject({ ok: true });
    expect(manager.list()).toEqual([]);
    expect(existsSync(path.join(root, "plugins", "text-stats"))).toBe(false);
    expect(existsSync(path.join(root, "plugin-install-metadata", "text-stats.json"))).toBe(false);
    expect(readdirSync(path.join(root, "cache"))).toEqual([]);
  });
  it.each(["malformed", "api-mismatch", "identity-mismatch", "traversal"])("rejects a %s archive without replacing the enabled plugin", async (kind) => {
    await installInitial(); await manager.setEnabled("text-stats", true);
    const bytes = kind === "malformed" ? new TextEncoder().encode("This is not a ZIP")
      : await zipWith(kind === "identity-mismatch" ? "9.0.0" : "1.1.0", kind === "api-mismatch" ? 2 : 1, kind === "traversal");
    const update = onlineMarket(bytes, "1.1.0"); await update.listMarket();
    expect(await update.installFromMarket("text-stats")).toMatchObject({ ok: false });
    expect(manager.list()[0]).toMatchObject({ version: "1.0.0", status: "running" });
    expect(tools.has("text-stats_count")).toBe(true);
    expect(existsSync(path.join(root, "escaped.txt"))).toBe(false);
    expect(readdirSync(path.join(root, "cache"))).toEqual([]);
    expect(readdirSync(path.join(root, "plugin-install-staging"))).toEqual([]);
  });
  it("leaves the installed enabled version intact when native replacement confirmation is canceled", async () => {
    await installInitial(); await manager.setEnabled("text-stats", true); replaceAllowed = false;
    const update = onlineMarket(await zipWith("1.1.0"), "1.1.0"); await update.listMarket();
    expect(await update.installFromMarket("text-stats")).toMatchObject({ ok: false, error: expect.stringContaining("取消") });
    expect(manager.list()[0]).toMatchObject({ version: "1.0.0", status: "running" });
    expect(readdirSync(path.join(root, "plugin-install-staging"))).toEqual([]);
  });
});

describe("every bundled catalog plugin through the real marketplace / installer / manager loop", () => {
  const catalogIds = ["text-stats", "json-tools", "timezone-tools", "code-language", "text-trim"];
  const sampleCalls: Record<string, [string, Record<string, unknown>, unknown]> = {
    "text-stats": ["text-stats_count", { text: "a b" }, { characters: 3, words: 2, nonEmptyLines: 1 }],
    "json-tools": ["json-tools_compare", { left: '{"a":1,"b":2}', right: '{"b":2,"a":1.0}' }, { equal: true }],
    "timezone-tools": ["timezone-tools_convert", { time: "2026-03-08T12:00:00Z", to: "America/New_York" },
      { instant: "2026-03-08T12:00:00.000Z", to: { zone: "America/New_York", local: "2026-03-08T08:00:00.000", offset: "-04:00" } }],
    "code-language": ["code-language_detect", { paths: ["a/b.ts"] }, { results: [{ path: "a/b.ts", language: "typescript", shortName: "ts" }] }],
    "text-trim": ["text-trim_cap", { text: "abcdef", maxBytes: 2 }, { text: "ab", truncated: true, totalBytes: 6, keptBytes: 2, omittedBytes: 4, notice: "Omitted 4 bytes." }],
  };

  it("lists all plugins, installs each disabled with its pinned hash, runs its real tool once enabled, and removes it", async () => {
    const market = localMarket();
    const listed = await market.listMarket();
    expect(listed).toMatchObject({ ok: true, mode: "bundled" });
    expect(listed.plugins.map((plugin) => plugin.id).sort()).toEqual([...catalogIds].sort());
    for (const plugin of listed.plugins) {
      expect(plugin).toMatchObject({ compatible: true, source: "bundled", pluginApiVersion: 1 });
      expect(plugin.capabilities?.length).toBeGreaterThan(0);
    }
    for (const id of catalogIds) expect(await market.installFromMarket(id), id).toMatchObject({ ok: true, plugin: { id, version: "1.0.0" } });
    expect(manager.list().map((plugin) => plugin.id).sort()).toEqual([...catalogIds].sort());
    for (const plugin of manager.list()) expect(plugin).toMatchObject({ origin: "market", status: "disabled", enabled: false });
    expect(tools.size).toBe(0);
    for (const id of catalogIds) {
      expect(await manager.setEnabled(id, true), id).toEqual({ ok: true });
      const [toolId, args, expected] = sampleCalls[id];
      const tool = tools.get(toolId)!;
      expect(tool, toolId).toBeDefined();
      expect(tool).toMatchObject({ risk: "safe", effectKind: "read" });
      expect(JSON.parse(await tool.execute(args, { userQuery: "check" })), id).toEqual(expected);
    }
    expect([...tools.keys()].sort()).toEqual([
      "code-language_detect", "json-tools_compare", "json-tools_validate", "text-stats_count",
      "text-trim_cap", "timezone-tools_canonicalize", "timezone-tools_convert",
    ]);
    for (const id of catalogIds) {
      expect(await manager.setEnabled(id, false), id).toEqual({ ok: true });
      expect(await manager.uninstall(id), id).toMatchObject({ ok: true });
    }
    expect(tools.size).toBe(0);
    expect(manager.list()).toEqual([]);
    expect(readdirSync(path.join(root, "cache"))).toEqual([]);
  });

  it("refuses a bundled package whose bytes no longer match the catalog hash and installs nothing", async () => {
    const market = localMarket();
    await market.listMarket();
    const zipPath = path.join(bundledDir, "json-tools-1.0.0.zip");
    const original = readFileSync(zipPath);
    const tampered = Buffer.from(original);
    tampered[tampered.length - 1] ^= 0xff;
    writeFileSync(zipPath, tampered);
    expect(await market.installFromMarket("json-tools")).toMatchObject({ ok: false, error: expect.stringContaining("SHA-256") });
    expect(manager.list()).toEqual([]);
    expect(readdirSync(path.join(root, "cache"))).toEqual([]);
    // The hash check runs before the installer is reached, so nothing was even staged.
    expect(existsSync(path.join(root, "plugin-install-staging"))).toBe(false);
    expect(existsSync(path.join(root, "plugins", "json-tools"))).toBe(false);
    // Other plugins are unaffected.
    expect(await market.installFromMarket("text-trim")).toMatchObject({ ok: true });
  });
});
