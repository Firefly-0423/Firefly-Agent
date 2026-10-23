import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import {Worker} from "node:worker_threads";
import {app} from "electron";
import {canonicalPath,within,resolveRuntimeProfile,applyElectronPaths} from "../../../src/main/runtime-profile";
import {createStorageContext} from "../../../src/main/storage-context";
import {createWindowsKeyProtection} from "../../../src/main/memory-core/windows-dpapi";
import {MemoryClient} from "../../../src/main/memory-core/worker-client";
import {createMainSourceRegistry} from "../../../src/main/memory-sources/source-registry";
import {SyntheticSourceProvider} from "./synthetic-provider";
const argument=(name:string)=>process.argv.find(v=>v.startsWith(name+"="))?.slice(name.length+1);
const cwd=process.cwd(),root=argument("--source-probe-root"),mode=argument("--source-probe-mode");
if(cwd!==process.env.FIREFLY_SOURCE_VERIFY_WORKSPACE||!root||!path.isAbsolute(root)||!within(canonicalPath(path.join(cwd,"output","memory-b1")),canonicalPath(root)))throw new Error("SOURCE_PROBE_ROOT_INVALID");
const ownedRoot=root;
// Headless storage probe only; does not validate renderer/GPU behavior.
// https://www.electronjs.org/docs/latest/api/app#appdisablehardwareacceleration
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-software-rasterizer");
const isolation=path.join(root,"isolation"),production=path.join(root,"synthetic-production");
fs.mkdirSync(isolation,{recursive:true});fs.mkdirSync(production,{recursive:true});
const profile=resolveRuntimeProfile({argv:["--firefly-profile=test","--firefly-isolation-root="+isolation],env:{},isPackaged:app.isPackaged,productionAppData:production});
applyElectronPaths(app,profile);app.setPath("temp",path.join(root,"temp"));
const storage=createStorageContext(profile),identity={providerId:"synthetic",sessionId:"electron-session",messageId:"electron-message"};
(async()=>{
 let client:MemoryClient|undefined;
 try{
  await app.whenReady();
  client=await MemoryClient.open({storage,keyProtection:createWindowsKeyProtection(storage.memory.tempRoot),workerFactory:data=>new Worker(path.join(__dirname,"worker.cjs"),{workerData:data,execArgv:[]})});
  const provider=new SyntheticSourceProvider(path.join(ownedRoot,"provider.json"),"scope-a"),registry=createMainSourceRegistry(client),access=registry.authority.access("scope-a");
  const refFile=path.join(ownedRoot,"original-ref.json");
  if(mode==="capture"){
   provider.write(identity,{text:"B1 中文 English 😀 before",role:"user",trust:"direct-user-event"});
   const ref=await registry.capture(access,provider.adapter,identity);
   assert.equal(await registry.readEvidence(access,provider.adapter,ref),"B1 中文 English 😀 before");
   await client.jobCommand({kind:"enqueue",scopeKey:"scope-a",commandId:"enqueue",body:{jobId:"old-job",sourceRef:ref}});
   const lease=await client.jobCommand({kind:"claim",scopeKey:"scope-a",commandId:"claim",body:{jobId:"old-job",leaseMs:60000}});
   fs.writeFileSync(refFile,JSON.stringify({ref,lease}));
  }else if(mode==="pending-write"){
   const {ref}=JSON.parse(fs.readFileSync(refFile,"utf8"));
   const captured=await registry.capture(access,provider.adapter,identity);assert.deepEqual(captured,ref);
   await registry.prepareChange(access,provider.adapter,ref);
   provider.write(identity,{text:"B1 中文 English 😀 after",role:"user",trust:"direct-user-event"});
   await assert.rejects(client.jobCommand({kind:"enqueue",scopeKey:"scope-a",commandId:"pending-job",body:{jobId:"blocked-job",sourceRef:ref}}),/MEMORY_SOURCE_PENDING/);
   console.log("SOURCE_PENDING_DURABLE");await new Promise<void>(()=>{});
  }else if(mode==="recover"){
   const {ref,lease}=JSON.parse(fs.readFileSync(refFile,"utf8"));
   await assert.rejects(registry.capture(access,provider.adapter,identity),/MEMORY_SOURCE_PENDING/);
   const fresh=await registry.reconcile(access,provider.adapter,identity);
   assert.equal(await registry.readEvidence(access,provider.adapter,fresh),"B1 中文 English 😀 after");
   await assert.rejects(registry.readEvidence(access,provider.adapter,ref),/MEMORY_SOURCE_STALE/);
   await assert.rejects(client.jobCommand({kind:"commit",scopeKey:"scope-a",commandId:"late-commit",body:{jobId:"old-job",leaseToken:lease.leaseToken,proposals:[{candidateId:"old-candidate",evidenceId:"old-evidence",text:"old source",fact:{subjectKey:"synthetic",assertion:"old",assertionKind:"user-statement",time:{validFrom:null,validTo:null,referenceTime:null}}}]}}),/MEMORY_SOURCE_STALE/);
   assert.deepEqual(await client.readRows("evidence","scope-a"),[]);
  }else throw new Error("SOURCE_PROBE_MODE_INVALID");
  await client.close();client=undefined;
  const result={ok:true,mode,packaged:app.isPackaged,versions:{electron:process.versions.electron,node:process.versions.node,sqlite:process.versions.sqlite}};
  fs.writeFileSync(path.join(ownedRoot,"result-"+mode+".json"),JSON.stringify(result));console.log(JSON.stringify(result));app.exit(0);
 }catch(error){
  fs.writeFileSync(path.join(ownedRoot,"result-"+mode+".json"),JSON.stringify({ok:false,error:error instanceof Error?error.message:String(error)}));
  await client?.close().catch(()=>{});app.exit(1);
 }
})();
