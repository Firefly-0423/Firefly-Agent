import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import {Worker} from "node:worker_threads";
import {app} from "electron";
import {canonicalPath,within,resolveRuntimeProfile,applyElectronPaths} from "../../../src/main/runtime-profile";
import {createStorageContext} from "../../../src/main/storage-context";
import {createWindowsKeyProtection} from "../../../src/main/memory-core/windows-dpapi";
import {MemoryClient} from "../../../src/main/memory-core/worker-client";
import {createMainActorAuthority} from "../../../src/main/memory-core/main-actor-authority";
import {createMainPolicy} from "../../../src/main/memory-policy/main-policy";
import {createMainSourceRegistry} from "../../../src/main/memory-sources/source-registry";
import {createMainContext} from "../../../src/main/memory-context/main-context";
import {SyntheticSourceProvider} from "../memory-sources/synthetic-provider";
const argument=(name:string)=>process.argv.find(v=>v.startsWith(name+"="))?.slice(name.length+1);
const cwd=process.cwd(),root=argument("--context-probe-root"),mode=argument("--context-probe-mode");
if(cwd!==process.env.FIREFLY_CONTEXT_VERIFY_WORKSPACE||path.parse(cwd).root.toUpperCase()!=="E:\\"||!root||!path.isAbsolute(root)||!within(canonicalPath(path.join(cwd,"output","memory-s")),canonicalPath(root)))throw new Error("CONTEXT_PROBE_ROOT_INVALID");
const ownedRoot=root;
app.disableHardwareAcceleration();app.commandLine.appendSwitch("disable-software-rasterizer");
const isolation=path.join(root,"isolation"),production=path.join(root,"synthetic-production");
fs.mkdirSync(isolation,{recursive:true});fs.mkdirSync(production,{recursive:true});
const profile=resolveRuntimeProfile({argv:["--firefly-profile=test","--firefly-isolation-root="+isolation],env:{},isPackaged:app.isPackaged,productionAppData:production});
applyElectronPaths(app,profile);app.setPath("temp",path.join(root,"temp"));
const storage=createStorageContext(profile),identity={providerId:"synthetic",sessionId:"context-session",messageId:"binding"};
(async()=>{
 let client:MemoryClient|undefined;
 try{
  await app.whenReady();client=await MemoryClient.open({storage,keyProtection:createWindowsKeyProtection(storage.memory.tempRoot),workerFactory:data=>new Worker(path.join(__dirname,"worker.cjs"),{workerData:data,execArgv:[]})});
  const activeClient=client,commands:unknown[]=[],transport={sourceCommand:(c:unknown)=>activeClient.sourceCommand(c),policyCommand:(c:unknown)=>activeClient.policyCommand(c),contextCommand:(c:unknown)=>{commands.push(c);return activeClient.contextCommand(c)}};
  const authority=createMainActorAuthority({resolveActor:()=>"actor-a"}),registry=createMainSourceRegistry(transport,{coordinate:authority.coordinate}),access=registry.authority.access("scope-a"),provider=new SyntheticSourceProvider(path.join(ownedRoot,"provider.json"),"scope-a"),policy=createMainPolicy({registry,transport,resolveActor:()=>"actor-a",actorAuthority:authority}),actor=policy.bindActor(access,provider.adapter,identity);
  const requestIdentity={providerId:"synthetic",model:"synthetic",transport:"synthetic",framingVersion:"v1"},prepare=(units:any[],facts:any[]=[])=>({...requestIdentity,inputTypes:["text"],body:{system:"fixed",messages:units.flatMap(u=>u.messages),facts:facts.map(f=>f.assertion)}});
  const context=createMainContext({registry,transport,actorAuthority:authority,counter:{capability:{...requestIdentity,mode:"exact",inputTypes:["text"]},count:async r=>JSON.stringify(r.body).length},budget:{maxContextTokens:10000,maxSTokens:5000,reservedOutputTokens:64,safetyMarginTokens:16,minRecentCompleteTurns:1},prepare,prepareS:u=>prepare(u)}),file=path.join(ownedRoot,"summary.json");
  if(mode==="create"){
   const refs=[];
   for(const [messageId,text] of [["english","I prefer English"],["detail","I prefer detailed responses"],["bash","I prefer bash"]]){const id={...identity,messageId};provider.write(id,{text,role:"user",trust:"direct-user-event"});refs.push(await registry.capture(access,provider.adapter,id))}
   const memory=await policy.ingest(actor,refs[2]),lease=await context.prepareSummary(actor,{sessionId:identity.sessionId,inputRefs:refs.slice(0,2),leaseMs:60000}),receipt=await context.commitSummary(actor,lease,{segments:[{sourceRef:refs[0],span:{start:0,end:"I prefer English".length}}]});assert.equal(receipt.status,"committed");
   fs.writeFileSync(file,JSON.stringify({receipt,refs,memory,commitCommand:commands.find((c:any)=>c.kind==="summaryCommit")}));
   const snapshot=await context.assemble(actor,{sessionId:identity.sessionId,sourceRefs:[],summaryIds:[receipt.summaryId!]});assert.equal((snapshot.request.body.messages as any[])[0].text,"I prefer English");
   await assert.rejects(context.commitSummary(actor,{}, {segments:[]}),/MEMORY_CONTEXT_LEASE_DENIED/);
  }else if(mode==="reopen"){
   const saved=JSON.parse(fs.readFileSync(file,"utf8"));assert.deepEqual(await client.contextCommand(saved.commitCommand),{receipt:saved.receipt});
   const snapshot=await context.assemble(actor,{sessionId:identity.sessionId,sourceRefs:[],summaryIds:[saved.receipt.summaryId]}),permit=await context.validateForDispatch(actor,snapshot);assert.equal((snapshot.request.body.messages as any[])[0].text,"I prefer English");
   const bash=await registry.capture(access,provider.adapter,{...identity,messageId:"bash"});assert.deepEqual(bash,saved.refs[2]);await policy.act(actor,await policy.event(actor,{kind:"forget",nonce:"electron-forget",factId:saved.memory.factId,revision:1}));
   let sent=0;await assert.rejects(context.dispatch(actor,permit,()=>{sent++;return "bad"}),/MEMORY_CONTEXT_STALE/);assert.equal(sent,0);
   const rebuilt=await context.assemble(actor,{sessionId:identity.sessionId,sourceRefs:[],summaryIds:[saved.receipt.summaryId]});assert.equal((rebuilt.request.body.messages as any[])[0].text,"I prefer English");const freshPermit=await context.validateForDispatch(actor,rebuilt);assert.equal((await context.dispatch(actor,freshPermit,()=>"synthetic-sent")).status,"sent");
   await registry.prepareChange(access,provider.adapter,saved.refs[1]);provider.remove({...identity,messageId:"detail"});await assert.rejects(registry.reconcile(access,provider.adapter,{...identity,messageId:"detail"}),/MEMORY_SOURCE_DELETED/);
   assert.deepEqual((await context.assemble(actor,{sessionId:identity.sessionId,sourceRefs:[],summaryIds:[saved.receipt.summaryId]})).request.body.messages,[]);assert.deepEqual(await client.contextCommand(saved.commitCommand),{receipt:saved.receipt});assert.deepEqual(await policy.recall(actor),[]);
  }else throw new Error("CONTEXT_PROBE_MODE_INVALID");
  await client.close();client=undefined;const result={ok:true,mode,packaged:app.isPackaged,versions:{electron:process.versions.electron,node:process.versions.node,sqlite:process.versions.sqlite},syntheticCounter:true};fs.writeFileSync(path.join(ownedRoot,"result-"+mode+".json"),JSON.stringify(result));console.log(JSON.stringify(result));app.exit(0);
 }catch(error){fs.writeFileSync(path.join(ownedRoot,"result-"+mode+".json"),JSON.stringify({ok:false,error:error instanceof Error?error.message:String(error)}));await client?.close().catch(()=>{});app.exit(1)}
})();
