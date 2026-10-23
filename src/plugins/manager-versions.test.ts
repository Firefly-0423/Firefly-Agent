import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { spawnSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { PluginManager } from "./manager";
import { PluginVersionStore } from "./version-store";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const done of cleanup.splice(0)) await done(); });
async function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "firefly-managed-")), userRoot = path.join(root, "plugins"); mkdirSync(userRoot);
  let enabled: Record<string, boolean> = {};
  const ipc = new Map<string, (...args: unknown[]) => unknown>();
  const store = new PluginVersionStore(userRoot);
  const manager = new PluginManager({ scanRoots: [{ path: userRoot, source: "user" }], storageRoot: path.join(root, "data"), versionStore: store,
    loadEnabledMap: () => enabled, saveEnabledMap: value => { enabled = value; }, confirmPluginReplace: async () => true,
    runtime: { toolRegistry: { register() {}, unregister: () => true }, channelManager: { has: () => false, register() {}, unregister: async () => true, startOne: async () => {} },
      registerIpc: (id, handler) => { ipc.set(id, handler); }, unregisterIpc: id => { ipc.delete(id); } },
  });
  cleanup.push(async () => { await manager.stop(); rmSync(root, { recursive: true, force: true }); });
  await manager.start();
  const zip = async (version: string) => {
    const archive = new JSZip();
    archive.file("manifest.json", JSON.stringify({ apiVersion: 1, id: "fixture", name: "Fixture", description: "fixture", author: "test", version, entry: "index.cjs", defaultEnabled: true }));
    archive.file("index.cjs", `module.exports={register(ctx){ctx.registerIpc('version',()=>${JSON.stringify(version)})}};`);
    const file = path.join(root, version + ".zip"); writeFileSync(file, await archive.generateAsync({ type: "nodebuffer" })); return file;
  };
  return { manager, store, zip, root, ipc, userRoot };
}

function restart(root: string, cancelAtCommit = false, enableAfterStart = false, stayDisabled = false) {
  const script = `
    const fs=require('node:fs'),path=require('node:path'),ts=require('typescript');
    require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f);
    const {PluginManager}=require('./src/plugins/manager.ts');
    const {PluginVersionStore}=require('./src/plugins/version-store.ts');
    const root=process.argv[1], ipc=new Map(),store=new PluginVersionStore(path.join(root,'plugins'));
    const mgr=new PluginManager({scanRoots:[{path:path.join(root,'plugins'),source:'user'}],storageRoot:path.join(root,'data'),versionStore:store,
      loadEnabledMap:()=>({fixture:process.argv[3]==='normal'}),saveEnabledMap:()=>{},runtime:{toolRegistry:{register(){},unregister(){return true}},channelManager:{has(){return false},register(){},async unregister(){return true},async startOne(){}},registerIpc:(id,fn)=>ipc.set(id,fn),unregisterIpc:id=>ipc.delete(id)}});
    if(process.argv[2]==='cancel'){const finish=store.finishActivation.bind(store);store.finishActivation=async id=>{const state=await finish(id);void mgr.setEnabled(id,false);return state;};}
    (async()=>{await mgr.start();if(process.argv[3]==='enable-later')await mgr.setEnabled('fixture',true);console.log('RESULT:'+JSON.stringify({overview:mgr.overview(),value:ipc.get('plugin:fixture:version')?.()}));await mgr.stop()})().catch(e=>{console.error(e);process.exitCode=1});`;
  const result = spawnSync(process.execPath, ["-e", script, root, cancelAtCommit ? "cancel" : "normal", stayDisabled ? "disabled" : enableAfterStart ? "enable-later" : "normal"], { cwd: process.cwd(), encoding: "utf8", timeout: 30000, windowsHide: true });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  const line = result.stdout.split(/\r?\n/).find(line => line.startsWith("RESULT:"));
  expect(line, result.stdout + result.stderr).toBeTruthy();
  return JSON.parse(line!.slice(7));
}

it("loads changed ESM child modules only in a fresh process", async () => {
  const f = await fixture();
  const make = async (version: string, value: string) => {
    const file = await f.zip(version), zip = await JSZip.loadAsync(readFileSync(file));
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
    zip.file("manifest.json", JSON.stringify({ ...manifest, entry: "index.mjs" }));
    zip.file("index.mjs", "import {value} from './helper.mjs'; export default {register(ctx){ctx.registerIpc('version',()=>value)}};");
    zip.file("helper.mjs", `export const value=${JSON.stringify(value)};`);
    writeFileSync(file, await zip.generateAsync({ type: "nodebuffer" })); return file;
  };
  await f.manager.installZip(await make("1.0.0", "old")); await f.manager.setEnabled("fixture", true);
  await f.manager.installZip(await make("2.0.0", "new"));
  expect(f.ipc.get("plugin:fixture:version")!()).toBe("old");
  const result = restart(f.root);
  expect(result.value).toBe("new");
  expect(result.overview.plugins[0]).toMatchObject({ selectedVersion: "2.0.0", activeVersion: "2.0.0", pendingVersion: null });
});

it("restores selection after candidate activation failure and loads old code only on the following restart", async () => {
  const f = await fixture();
  await f.manager.installZip(await f.zip("1.0.0")); await f.manager.setEnabled("fixture", true);
  const file = await f.zip("2.0.0"), zip = await JSZip.loadAsync(readFileSync(file));
  zip.file("index.cjs", "module.exports={register(){throw Error('fixture candidate failed')}};");
  writeFileSync(file, await zip.generateAsync({ type: "nodebuffer" }));
  await f.manager.installZip(file);
  const failed = restart(f.root);
  expect(failed.value).toBeUndefined();
  expect(failed.overview.plugins[0]).toMatchObject({ version: "1.0.0", status: "failed", selectedVersion: "1.0.0", activeVersion: null, restartRequired: true });
  expect(f.store.read("fixture")?.pending).toBeNull();
  const restored = restart(f.root);
  expect(restored.value).toBe("1.0.0");
});

it.each([false, true])("keeps all displayed metadata on the selected package after candidate registration (fails=%s)", async fails => {
  const f = await fixture();
  const make = async (version: string, label: string, fail: boolean) => {
    const file = await f.zip(version), zip = await JSZip.loadAsync(readFileSync(file));
    const metadata = { name: `${label} name`, description: `${label} description`, author: `${label} author`, entry: `${label}.cjs`, defaultEnabled: label === "old", icon: "icon.svg" };
    const icon = `<svg xmlns="http://www.w3.org/2000/svg"><text>${label}</text></svg>`;
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
    zip.file("manifest.json", JSON.stringify({ ...manifest, ...metadata })); zip.remove("index.cjs");
    zip.file(metadata.entry, fail ? "module.exports={register(){throw Error('different metadata rejected')}};"
      : `module.exports={register(ctx){ctx.registerIpc('version',()=>${JSON.stringify(version)})}};`);
    zip.file(metadata.icon, icon);
    writeFileSync(file, await zip.generateAsync({ type: "nodebuffer" }));
    return { file, metadata, icon: `data:image/svg+xml;base64,${Buffer.from(icon).toString("base64")}` };
  };
  const old = await make("1.0.0", "old", false);
  await f.manager.installZip(old.file); await f.manager.setEnabled("fixture", true);
  const oldPath = f.manager.list()[0].path;
  const next = await make("2.0.0", "new", fails);
  await f.manager.installZip(next.file);
  const pending = f.store.read("fixture")!.pending!;
  const expected = fails ? { ...old.metadata, version: "1.0.0", path: oldPath, icon: old.icon }
    : { ...next.metadata, version: "2.0.0", path: f.store.packageDir("fixture", pending.key), icon: next.icon };
  const restarted = restart(f.root);
  expect(restarted.overview.plugins[0]).toMatchObject(expected);
  if (fails) {
    expect(restarted.value).toBeUndefined();
    expect(restarted.overview.plugins[0]).toMatchObject({ status: "failed", activeVersion: null, restartRequired: true });
  } else expect(restarted.value).toBe("2.0.0");
  const following = restart(f.root);
  expect(following.overview.plugins[0]).toMatchObject({ ...expected, status: "running" });
  expect(following.value).toBe(expected.version);
});

it("installs disabled and stages updates without replacing active code or its directory", async () => {
  const f = await fixture();
  expect(await f.manager.installZip(await f.zip("1.0.0"))).toMatchObject({ ok: true, installation: "committed", activation: "not-requested" });
  expect(f.manager.list()[0]).toMatchObject({ configuredEnabled: false, installedVersion: "1.0.0", activeVersion: null });
  await f.manager.setEnabled("fixture", true);
  const active = f.manager.list()[0].path;
  const oldBytes = readFileSync(path.join(active, "index.cjs"), "utf8");
  expect(await f.manager.installZip(await f.zip("2.0.0"))).toMatchObject({ ok: true, installation: "committed", activation: "restart-required" });
  expect(f.manager.list()[0]).toMatchObject({ installedVersion: "2.0.0", selectedVersion: "1.0.0", activeVersion: "1.0.0", pendingVersion: "2.0.0", restartRequired: true, path: active });
  expect(f.ipc.get("plugin:fixture:version")!()).toBe("1.0.0");
  expect(readFileSync(path.join(active, "index.cjs"), "utf8")).toBe(oldBytes);
  await f.manager.rescan();
  expect(f.ipc.get("plugin:fixture:version")!()).toBe("1.0.0");
});

it("retains private data on uninstall and refuses same-process reinstall activation", async () => {
  const f = await fixture();
  await f.manager.installZip(await f.zip("1.0.0")); await f.manager.setEnabled("fixture", true);
  const privateDir = path.join(f.root, "data", "fixture"); mkdirSync(privateDir, { recursive: true }); writeFileSync(path.join(privateDir, "keep"), "private");
  expect(await f.manager.uninstall("fixture")).toMatchObject({ ok: true });
  expect(f.manager.list()).toEqual([]);
  expect(readFileSync(path.join(privateDir, "keep"), "utf8")).toBe("private");
  expect(await f.manager.installZip(await f.zip("2.0.0"))).toMatchObject({ activation: "restart-required" });
  expect(await f.manager.setEnabled("fixture", true)).toMatchObject({ ok: false });
  expect(f.ipc.has("plugin:fixture:version")).toBe(false);
});

it("reports a committed package and blocks activation when selection persistence fails", async () => {
  const f = await fixture();
  vi.spyOn(f.store, "finishActivation").mockRejectedValueOnce(new Error("fixture persistence failure"));
  expect(await f.manager.installZip(await f.zip("1.0.0"))).toMatchObject({ ok: false, installation: "committed", activation: "failed" });
  expect(f.store.read("fixture")?.pending?.version).toBe("1.0.0");
  expect(await f.manager.setEnabled("fixture", true)).toMatchObject({ ok: false });
  expect(f.ipc.has("plugin:fixture:version")).toBe(false);
});

it("restores the previous selection when disabling races with activation finalization", async () => {
  const f = await fixture();
  await f.manager.installZip(await f.zip("1.0.0")); await f.manager.setEnabled("fixture", true);
  await f.manager.installZip(await f.zip("2.0.0"));
  const result = restart(f.root, true);
  expect(result.value).toBeUndefined();
  expect(f.store.read("fixture")?.selected?.version).toBe("1.0.0");
});

it("restores the old selection when a disabled update is first enabled after restart and fails", async () => {
  const f = await fixture();
  await f.manager.installZip(await f.zip("1.0.0"));
  const file = await f.zip("2.0.0"), zip = await JSZip.loadAsync(readFileSync(file));
  zip.file("index.cjs", "module.exports={register(){throw Error('disabled candidate failed')}};");
  writeFileSync(file, await zip.generateAsync({ type: "nodebuffer" }));
  await f.manager.installZip(file);
  expect(restart(f.root, false, false, true).overview.plugins[0]).toMatchObject({ status: "disabled", restartRequired: false });
  expect(f.store.read("fixture")?.pending?.version).toBe("2.0.0");
  const failed = restart(f.root, false, true);
  expect(failed.value).toBeUndefined();
  expect(f.store.read("fixture")?.selected?.version).toBe("1.0.0");
  expect(failed.overview.plugins[0]).toMatchObject({ status: "failed", restartRequired: true });
  expect(restart(f.root).value).toBe("1.0.0");
});

it("allows a pending reinstall with no prior selection to be enabled after a fresh disabled startup", async () => {
  const f = await fixture();
  await f.manager.installZip(await f.zip("1.0.0")); await f.manager.setEnabled("fixture", true);
  await f.manager.uninstall("fixture"); await f.manager.installZip(await f.zip("2.0.0"));
  expect(restart(f.root, false, true).value).toBe("2.0.0");
  expect(f.store.read("fixture")?.pending).toBeNull();
});

it("collects an interrupted first-copy package with no state on fresh manager startup", async () => {
  const f = await fixture();
  const marker = `${f.store.recordPath("fixture")}.pending`;
  mkdirSync(path.dirname(marker), { recursive: true }); writeFileSync(marker, "");
  const orphan = f.store.packageDir("fixture", "00000000-0000-0000-0000-000000000000");
  mkdirSync(orphan, { recursive: true }); writeFileSync(path.join(orphan, "partial"), "interrupted");
  expect(restart(f.root).overview.plugins).toEqual([]);
  expect(existsSync(orphan)).toBe(false);
  expect(existsSync(marker)).toBe(false);
});
