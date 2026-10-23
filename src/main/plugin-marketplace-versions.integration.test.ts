import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, expect, it, vi } from "vitest";
import { PluginManager } from "../plugins/manager";
import { PluginVersionStore } from "../plugins/version-store";
import { createPluginMarketplaceService } from "./plugin-marketplace";

const REGISTRY = "https://raw.githubusercontent.com/test/catalog/main/registry.json";
const PREFIX = "https://github.com/test/catalog/releases/download/";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const done of cleanup.splice(0)) await done(); });
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function fixture(options: { confirmReplacement?: boolean } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "firefly-managed-market-"));
  const userRoot = path.join(root, "plugins"); mkdirSync(userRoot);
  const store = new PluginVersionStore(userRoot);
  let enabled: Record<string, boolean> = {};
  let replacementAllowed = true;
  const confirm = vi.fn(async (_plugin: { id: string; name: string; version: string }) => replacementAllowed);
  const ipc = new Map<string, (...args: unknown[]) => unknown>();
  const manager = new PluginManager({ versionStore: store, scanRoots: [{ path: userRoot, source: "user" }], storageRoot: path.join(root, "data"),
    loadEnabledMap: () => enabled,
    saveEnabledMap: (next) => { enabled = { ...next }; writeFileSync(path.join(root, "enabled.json"), JSON.stringify(enabled)); },
    confirmPluginReplace: options.confirmReplacement === false ? undefined : confirm,
    runtime: { toolRegistry: { register() {}, unregister: () => true },
      channelManager: { has: () => false, register() {}, unregister: async () => true, startOne: async () => {} },
      registerIpc: (channel, handler) => { ipc.set(channel, handler); }, unregisterIpc: channel => { ipc.delete(channel); } },
  });
  cleanup.push(async () => { await manager.stop(); rmSync(root, { recursive: true, force: true }); });
  await manager.start();
  const archive = async (version: string, fail = false) => {
    const zip = new JSZip();
    zip.file("manifest.json", JSON.stringify({ apiVersion: 1, id: "fixture", name: "Fixture", version, description: "Synthetic only", author: "test", entry: "index.cjs", defaultEnabled: true }));
    zip.file("index.cjs", fail ? "module.exports={register(){throw Error('synthetic candidate failed')}};"
      : `module.exports={register(ctx){ctx.registerIpc('version',()=>${JSON.stringify(version)})}};`);
    return zip.generateAsync({ type: "nodebuffer" });
  };
  const entry = (version: string, bytes: Uint8Array, zip: string) => ({ id: "fixture", name: "Fixture", version, description: "Synthetic only", author: "test", downloads: 0, pluginApiVersion: 1, zip, sha256: sha(bytes) });
  const installInitial = async (kind: "local-zip" | "bundled", running = false) => {
    const bytes = await archive("1.0.0");
    const bundle = path.join(root, "bundle"); mkdirSync(bundle);
    const file = path.join(bundle, "fixture-1.0.0.zip"); writeFileSync(file, bytes);
    if (kind === "local-zip") expect(await manager.installZip(file)).toMatchObject({ ok: true });
    else {
      writeFileSync(path.join(bundle, "registry.json"), JSON.stringify({ apiVersion: 1, plugins: [entry("1.0.0", bytes, "bundled:fixture-1.0.0.zip")] }));
      const market = createPluginMarketplaceService({ registryUrls: [], zipUrlPrefixes: [], bundledDir: bundle, cacheDir: path.join(root, "cache"), installZip: (file, opts) => manager.installZip(file, opts) });
      await market.listMarket(); expect(await market.installFromMarket("fixture")).toMatchObject({ ok: true });
    }
    expect(manager.list()[0]).toMatchObject({ status: "disabled", configuredEnabled: false });
    if (running) expect(await manager.setEnabled("fixture", true)).toEqual({ ok: true });
    const data = path.join(root, "data", "fixture"); mkdirSync(data, { recursive: true }); writeFileSync(path.join(data, "keep"), "private data");
  };
  const online = async (version: string, options: { registry?: string; fail?: boolean; tamper?: boolean } = {}) => {
    const bytes = await archive(version, options.fail);
    const registry = options.registry ?? REGISTRY;
    const zip = `${PREFIX}v${version}/fixture.zip`;
    const plugin = entry(version, bytes, zip);
    const payload = options.tamper ? Buffer.from("tampered synthetic archive") : bytes;
    const market = createPluginMarketplaceService({ registryUrls: [registry], zipUrlPrefixes: [PREFIX], cacheDir: path.join(root, "cache"),
      installZip: (file, opts) => manager.installZip(file, opts),
      fetchImpl: async url => {
        if (url === registry) return new Response(JSON.stringify({ apiVersion: 1, plugins: [plugin] }));
        if (url === zip) return new Response(new Uint8Array(payload));
        throw new Error("Unexpected synthetic request");
      },
    });
    await market.listMarket();
    return { market, bytes, registry };
  };
  return { root, manager, store, ipc, confirm, installInitial, online,
    enabled: () => ({ ...enabled }), allowReplacement: (allowed: boolean) => { replacementAllowed = allowed; } };
}

function restart(root: string, enableAfterStart = false) {
  const script = `
    const fs=require('node:fs'),path=require('node:path'),ts=require('typescript');
    require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f);
    const {PluginManager}=require('./src/plugins/manager.ts'),{PluginVersionStore}=require('./src/plugins/version-store.ts');
    const root=process.argv[1],settings=path.join(root,'enabled.json'),ipc=new Map();
    const manager=new PluginManager({versionStore:new PluginVersionStore(path.join(root,'plugins')),scanRoots:[{path:path.join(root,'plugins'),source:'user'}],storageRoot:path.join(root,'data'),
      loadEnabledMap:()=>JSON.parse(fs.readFileSync(settings,'utf8')),saveEnabledMap:next=>fs.writeFileSync(settings,JSON.stringify(next)),
      runtime:{toolRegistry:{register(){},unregister(){return true}},channelManager:{has(){return false},register(){},async unregister(){return true},async startOne(){}},registerIpc:(id,fn)=>ipc.set(id,fn),unregisterIpc:id=>ipc.delete(id)}});
    (async()=>{await manager.start();if(process.argv[2]==='enable')await manager.setEnabled('fixture',true);console.log('RESULT:'+JSON.stringify({overview:manager.overview(),value:ipc.get('plugin:fixture:version')?.()}));await manager.stop()})().catch(e=>{console.error(e);process.exitCode=1});`;
  const result = spawnSync(process.execPath, ["-e", script, root, enableAfterStart ? "enable" : "normal"], { cwd: process.cwd(), encoding: "utf8", windowsHide: true, timeout: 30_000 });
  expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
  const line = result.stdout.split(/\r?\n/).find(line => line.startsWith("RESULT:"));
  expect(line, result.stdout + result.stderr).toBeTruthy();
  return JSON.parse(line!.slice(7));
}

const replacements = (["local-zip", "bundled"] as const).flatMap(kind => [false, true].map(running => ({ kind, running })));
it.each(replacements)("stages a confirmed $kind to online replacement preserving enabled=$running", async ({ kind, running }) => {
  const f = await fixture(); await f.installInitial(kind, running);
  const before = f.store.read("fixture")!, enabled = f.enabled();
  const { market, bytes } = await f.online("2.0.0");
  expect(await market.installFromMarket("fixture")).toMatchObject({ ok: true, installation: "committed", activation: "restart-required" });
  const to = { kind: "curated-market", sourceId: REGISTRY, archiveSha256: sha(bytes) };
  expect(f.confirm).toHaveBeenCalledWith(expect.objectContaining({ id: "fixture", version: "2.0.0", sourceChange: { from: before.selected!.source, to } }));
  expect(f.store.read("fixture")).toMatchObject({ selected: before.selected, pending: { version: "2.0.0", source: to } });
  expect(f.enabled()).toEqual(enabled);
  expect(f.manager.list()[0]).toMatchObject({ selectedVersion: "1.0.0", pendingVersion: "2.0.0", configuredEnabled: running, activeVersion: running ? "1.0.0" : null });
  expect(readFileSync(path.join(f.root, "data", "fixture", "keep"), "utf8")).toBe("private data");
  if (running) expect(f.ipc.get("plugin:fixture:version")!()).toBe("1.0.0");
});

it.each(["local-zip", "bundled"] as const)("keeps the original %s selection when source replacement is canceled", async kind => {
  const f = await fixture(); await f.installInitial(kind, true); f.allowReplacement(false);
  const before = readFileSync(f.store.recordPath("fixture"), "utf8"), enabled = f.enabled();
  const { market } = await f.online("2.0.0");
  expect(await market.installFromMarket("fixture")).toMatchObject({ ok: false, error: expect.stringContaining("取消") });
  expect(readFileSync(f.store.recordPath("fixture"), "utf8")).toBe(before);
  expect(f.enabled()).toEqual(enabled); expect(f.ipc.get("plugin:fixture:version")!()).toBe("1.0.0");
});

it.each(["local-zip", "bundled"] as const)("requires a confirmation callback before replacing %s", async kind => {
  const f = await fixture({ confirmReplacement: false }); await f.installInitial(kind, true);
  const before = readFileSync(f.store.recordPath("fixture"), "utf8"), enabled = f.enabled();
  const { market } = await f.online("2.0.0");
  expect(await market.installFromMarket("fixture")).toMatchObject({ ok: false, error: expect.stringContaining("取消") });
  expect(f.confirm).not.toHaveBeenCalled();
  expect(readFileSync(f.store.recordPath("fixture"), "utf8")).toBe(before);
  expect(f.enabled()).toEqual(enabled); expect(f.ipc.get("plugin:fixture:version")!()).toBe("1.0.0");
});

it.each(["local-zip", "bundled"] as const)("keeps the original %s selection when confirmation throws", async kind => {
  const f = await fixture(); await f.installInitial(kind, true);
  f.confirm.mockRejectedValueOnce(new Error("synthetic confirmation failure"));
  const before = readFileSync(f.store.recordPath("fixture"), "utf8"), enabled = f.enabled();
  const { market } = await f.online("2.0.0");
  expect(await market.installFromMarket("fixture")).toMatchObject({ ok: false, installation: "rejected", error: "synthetic confirmation failure" });
  expect(readFileSync(f.store.recordPath("fixture"), "utf8")).toBe(before);
  expect(f.enabled()).toEqual(enabled); expect(f.ipc.get("plugin:fixture:version")!()).toBe("1.0.0");
});

it.each(["local-zip", "bundled"] as const)("refuses stale %s authorization after the selected key changes during confirmation", async kind => {
  const f = await fixture(); await f.installInitial(kind, true);
  const selected = f.store.read("fixture")!.selected!, enabled = f.enabled();
  let changed = "";
  f.confirm.mockImplementationOnce(async () => {
    await f.store.stage("fixture", f.store.packageDir("fixture", selected.key), selected.source);
    await f.store.beginActivation("fixture"); await f.store.finishActivation("fixture");
    expect(f.store.read("fixture")!.selected!.key).not.toBe(selected.key);
    changed = readFileSync(f.store.recordPath("fixture"), "utf8");
    return true;
  });
  const { market } = await f.online("2.0.0");
  expect(await market.installFromMarket("fixture")).toMatchObject({ ok: false, installation: "rejected", error: expect.stringContaining("source") });
  expect(changed).not.toBe(""); expect(readFileSync(f.store.recordPath("fixture"), "utf8")).toBe(changed);
  expect(f.store.read("fixture")!.pending).toBeNull();
  expect(f.enabled()).toEqual(enabled); expect(f.ipc.get("plugin:fixture:version")!()).toBe("1.0.0");
});

it.each(["origin", "expectedIdentity"] as const)("does not authorize a source change without market %s evidence", async missing => {
  const f = await fixture(); await f.installInitial("local-zip", true);
  const before = readFileSync(f.store.recordPath("fixture"), "utf8"), enabled = f.enabled();
  const { bytes } = await f.online("2.0.0"), file = path.join(f.root, "incoming.zip"); writeFileSync(file, bytes);
  expect(await f.manager.installZip(file, {
    origin: missing === "origin" ? undefined : "market",
    expectedIdentity: missing === "expectedIdentity" ? undefined : { id: "fixture", version: "2.0.0" },
    packageSource: { kind: "curated-market", sourceId: REGISTRY, archiveSha256: sha(bytes) },
  })).toMatchObject({ ok: false, installation: "rejected", error: expect.stringContaining("source") });
  expect(f.confirm).toHaveBeenCalledWith(expect.objectContaining({ sourceChange: undefined }));
  expect(readFileSync(f.store.recordPath("fixture"), "utf8")).toBe(before);
  expect(f.enabled()).toEqual(enabled); expect(f.ipc.get("plugin:fixture:version")!()).toBe("1.0.0");
});

it.each(["local-zip", "bundled"] as const)("confirms a same-version %s to online source replacement", async kind => {
  const f = await fixture(); await f.installInitial(kind, true);
  const selected = f.store.read("fixture")!.selected!;
  const { market } = await f.online("1.0.0");
  expect(await market.installFromMarket("fixture")).toMatchObject({ ok: true, activation: "restart-required" });
  expect(f.confirm).toHaveBeenCalledOnce();
  expect(f.store.read("fixture")).toMatchObject({ selected, pending: { version: "1.0.0", source: { kind: "curated-market", sourceId: REGISTRY } } });
  expect(f.ipc.get("plugin:fixture:version")!()).toBe("1.0.0");
});

it("verifies the incoming archive before asking to replace its source", async () => {
  const f = await fixture(); await f.installInitial("local-zip");
  const before = readFileSync(f.store.recordPath("fixture"), "utf8");
  const { market } = await f.online("2.0.0", { tamper: true });
  expect(await market.installFromMarket("fixture")).toMatchObject({ ok: false, error: expect.stringContaining("SHA-256") });
  expect(f.confirm).not.toHaveBeenCalled(); expect(readFileSync(f.store.recordPath("fixture"), "utf8")).toBe(before);
});

it("still refuses a different curated catalog even when generic replacement is confirmed", async () => {
  const f = await fixture(), first = await f.online("1.0.0");
  expect(await first.market.installFromMarket("fixture")).toMatchObject({ ok: true });
  const before = readFileSync(f.store.recordPath("fixture"), "utf8");
  const other = await f.online("2.0.0", { registry: "https://raw.githubusercontent.com/test/other/main/registry.json" });
  expect(await other.market.installFromMarket("fixture")).toMatchObject({ ok: false, error: expect.stringContaining("source") });
  expect(readFileSync(f.store.recordPath("fixture"), "utf8")).toBe(before);
});

it.each(["local-zip", "bundled"] as const)("activates the online package replacing %s only in a fresh process", async kind => {
  const f = await fixture(); await f.installInitial(kind, true);
  const { market } = await f.online("2.0.0");
  expect(await market.installFromMarket("fixture")).toMatchObject({ ok: true, activation: "restart-required" });
  const result = restart(f.root);
  expect(result.value).toBe("2.0.0");
  expect(result.overview.plugins[0]).toMatchObject({ status: "running", sourceKind: "curated-market", sourceId: REGISTRY, selectedVersion: "2.0.0", pendingVersion: null });
  expect(f.store.read("fixture")?.previous?.source.kind).toBe(kind);
});

it.each(["local-zip", "bundled"] as const)("restores the original %s package and provenance after online activation fails", async kind => {
  const f = await fixture(); await f.installInitial(kind, true);
  const before = f.store.read("fixture")!.selected!;
  const { market } = await f.online("2.0.0", { fail: true });
  expect(await market.installFromMarket("fixture")).toMatchObject({ ok: true, activation: "restart-required" });
  const failed = restart(f.root);
  expect(failed.value).toBeUndefined();
  expect(failed.overview.plugins[0]).toMatchObject({ status: "failed", selectedVersion: "1.0.0", activeVersion: null, restartRequired: true, sourceKind: kind });
  expect(f.store.read("fixture")?.selected).toEqual(before);
  expect(f.store.read("fixture")?.pending).toBeNull();
  expect(restart(f.root).value).toBe("1.0.0");
  expect(readFileSync(path.join(f.root, "data", "fixture", "keep"), "utf8")).toBe("private data");
  expect(existsSync(path.join(f.root, "enabled.json"))).toBe(true);
});

it.each(["local-zip", "bundled"] as const)("keeps a %s replacement disabled after restart and restores its provenance on first-enable failure", async kind => {
  const f = await fixture(); await f.installInitial(kind);
  const selected = f.store.read("fixture")!.selected!;
  const { market } = await f.online("2.0.0", { fail: true });
  expect(await market.installFromMarket("fixture")).toMatchObject({ ok: true, activation: "restart-required" });
  const disabled = restart(f.root);
  expect(disabled.value).toBeUndefined(); expect(disabled.overview.plugins[0]).toMatchObject({ status: "disabled", configuredEnabled: false });
  expect(f.store.read("fixture")).toMatchObject({ selected, pending: { version: "2.0.0" } });
  const failed = restart(f.root, true);
  expect(failed.value).toBeUndefined(); expect(failed.overview.plugins[0]).toMatchObject({ status: "failed", sourceKind: kind, restartRequired: true });
  expect(f.store.read("fixture")).toMatchObject({ selected, pending: null });
  expect(restart(f.root).value).toBe("1.0.0");
  expect(readFileSync(path.join(f.root, "data", "fixture", "keep"), "utf8")).toBe("private data");
});
