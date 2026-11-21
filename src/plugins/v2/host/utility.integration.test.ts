import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSync } from "esbuild";
import { expect, it } from "vitest";

const require = createRequire(import.meta.url);
let electron: string | undefined;
try { electron = require("electron") as string; } catch { /* Electron binary is optional on test-only machines. */ }

it.skipIf(!electron || !existsSync(electron))("real Electron utilityProcess (requires an installed Electron binary)", () => {
  const directory = mkdtempSync(join(tmpdir(), "firefly-plugin-host-"));
  try {
    const entry = join(directory, "plugin.cjs");
    const runner = join(directory, "runner.cjs");
    const dataDir = join(directory, "data");
    mkdirSync(dataDir);
    writeFileSync(entry, `
process.parentPort.once("message", ({ ports }) => {
  const [port] = ports;
  port.on("message", ({data}) => {
    if (data.type === "cancel") {
      if (data.id === waiting) cancelled = true;
      return;
    }
    if (data.type !== "req") return;
    if (data.method === "wait") { waiting=data.id; return; }
    if (data.method === "cancel-observed") { port.postMessage({type:"res",id:data.id,ok:true,value:cancelled}); return; }
    if (data.method === "tool.execute") { process.exit(23); }
    port.postMessage({type:"res",id:data.id,ok:true,value:data.method === "probe" ? {
      cwd:process.cwd(), secret:process.env.FIREFLY_TEST_SECRET ?? null
    } : undefined});
  });
  let waiting, cancelled = false;
  port.start();
});
`);
    const source = `
const assert=require("node:assert/strict");
const {app}=require("electron");
const {createElectronPluginHost}=require("./src/plugins/v2/host/index.ts");
app.setPath("userData",${JSON.stringify(dataDir)});
app.whenReady().then(async()=>{
  const host=createElectronPluginHost({resolvePlugin:()=>({entry:${JSON.stringify(entry)},dataDir:${JSON.stringify(dataDir)}})});
  try {
    await host.start("fixture");
    assert.equal(host.status("fixture"),"enabled");
    assert.deepEqual(await host.call("fixture","probe",null),{cwd:${JSON.stringify(dataDir)},secret:null});
    const cancel=new AbortController();
    const requested=host.call("fixture","wait",null,{signal:cancel.signal});
    cancel.abort();
    await assert.rejects(requested,{code:"ERR_CANCELLED"});
    assert.equal(await host.call("fixture","cancel-observed",null), true);
    assert.deepEqual(await host.call("fixture","tool.execute",null),{status:"unknown",reason:"Plugin process exited during tool execution"});
    assert.equal(host.status("fixture"),"restarting");
    console.log("UTILITY_PROCESS_OK");
  } finally { await host.stop("fixture"); }
}).then(()=>app.exit(0),error=>{console.error(error);app.exit(1)});
`;
    buildSync({ stdin: { contents: source, resolveDir: process.cwd() }, outfile: runner, platform: "node",
      bundle: true, external: ["electron"], format: "cjs" });
    const env = { ...process.env, FIREFLY_TEST_SECRET: "fixture-secret" };
    delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
    const result = spawnSync(electron!, [runner], { env, timeout: 20_000, encoding: "utf8", windowsHide: true });
    expect({ status: result.status, error: result.error?.message, stderr: result.stderr }).toMatchObject({ status: 0, error: undefined });
    expect(result.stdout).toContain("UTILITY_PROCESS_OK");
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 25_000);
