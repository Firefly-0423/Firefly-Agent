import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import {Worker} from "node:worker_threads";
import {DatabaseSync} from "node:sqlite";
import {createHash,randomUUID} from "node:crypto";
import {app} from "electron";
import {canonicalPath,within,resolveRuntimeProfile,applyElectronPaths} from "../../../src/main/runtime-profile";
import {createStorageContext} from "../../../src/main/storage-context";
import {createWindowsKeyProtection} from "../../../src/main/memory-core/windows-dpapi";
import {MemoryClient} from "../../../src/main/memory-core/worker-client";
import {createMainActorAuthority} from "../../../src/main/memory-core/main-actor-authority";
import {createMainPolicy} from "../../../src/main/memory-policy/main-policy";
import {createMainSourceRegistry} from "../../../src/main/memory-sources/source-registry";
import {createMainContext} from "../../../src/main/memory-context/main-context";
import {createMainRecall} from "../../../src/main/memory-recall/main-recall";
import {SyntheticSourceProvider} from "../memory-sources/synthetic-provider";

const arg=(name:string)=>process.argv.find(v=>v.startsWith(name+"="))?.slice(name.length+1);
const cwd=process.cwd(),root=arg("--recall-probe-root"),mode=arg("--recall-probe-mode");
if(cwd!==process.env.FIREFLY_RECALL_VERIFY_WORKSPACE||path.parse(cwd).root.toUpperCase()!=="E:\\"||!root||!path.isAbsolute(root)||!within(canonicalPath(path.join(cwd,"output","memory-m")),canonicalPath(root)))throw new Error("RECALL_PROBE_ROOT_INVALID");
const ownedRoot=root;
app.disableHardwareAcceleration();app.commandLine.appendSwitch("disable-software-rasterizer");
const isolation=path.join(root,"isolation"),production=path.join(root,"synthetic-production");fs.mkdirSync(isolation,{recursive:true});fs.mkdirSync(production,{recursive:true});
const profile=resolveRuntimeProfile({argv:["--firefly-profile=test","--firefly-isolation-root="+isolation],env:{},isPackaged:app.isPackaged,productionAppData:production});applyElectronPaths(app,profile);app.setPath("temp",path.join(root,"temp"));
const storage=createStorageContext(profile),identity={providerId:"synthetic",sessionId:"recall-session",messageId:"binding"};
const hash=(file:string)=>createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const bytes=(folder:string)=>fs.readdirSync(folder).sort().map(name=>({name,bytes:fs.readFileSync(path.join(folder,name))}));

async function migrateAndRollback(){
 const folder=path.join(ownedRoot,"v7-"+mode),backup=path.join(ownedRoot,"v7-backup-"+mode);fs.mkdirSync(folder);fs.mkdirSync(backup);const file=path.join(folder,"memory.sqlite"),key=Buffer.alloc(32,7);
 for(const suffix of ["",".auth"]){const source=path.join(__dirname,"v7-fixture","memory.sqlite"+suffix);fs.copyFileSync(source,file+suffix);fs.copyFileSync(source,path.join(backup,"memory.sqlite"+suffix))}
 assert.equal(hash(file),"abe66d5aabccf0dcba143f8184b5ae41a029de9dbcabea889bfd3d17ff818434");
 const before=new DatabaseSync(file);assert.equal(before.prepare("PRAGMA user_version").get()?.user_version,7);const payload=before.prepare("SELECT payload FROM sources WHERE id='actual-v7-source'").get()?.payload;before.close();
 const worker=new Worker(path.join(__dirname,"worker.cjs"),{workerData:{databasePath:file,key},execArgv:[]});let sequence=0;
 const exited=new Promise<number>(resolve=>worker.once("exit",resolve));await new Promise<void>((resolve,reject)=>{worker.once("message",m=>m.type==="ready"?resolve():reject(new Error("PROBE_WORKER_PROTOCOL")));worker.once("error",reject);worker.once("exit",()=>reject(new Error("PROBE_WORKER_EARLY_EXIT")))});
 const request=(type:string,body:unknown)=>new Promise<any>((resolve,reject)=>{const id=++sequence,handler=(m:any)=>{if(m.id!==id)return;worker.off("message",handler);m.ok?resolve(m.result):reject(new Error(m.error))};worker.on("message",handler);worker.postMessage({id,type,body})});
 try{assert.deepEqual((await request("rows",{table:"sources",scopeKey:"scope-a"}))[0].payload,{text:"ACTUAL_V7_SYNTHETIC_RECORD"});await request("close",{});assert.equal(await exited,0)}finally{await worker.terminate();key.fill(0)}
 let db=new DatabaseSync(file);assert.equal(db.prepare("PRAGMA user_version").get()?.user_version,9);assert.deepEqual(db.prepare("SELECT payload FROM sources WHERE id='actual-v7-source'").get()?.payload,payload);db.close();
 if(mode==="rollback"){
  // Exact v7 writer from the retained pre-v8 bundle, never a current writer with
  // dropped tables/reset PRAGMA. Roll back into a new owned root from full backup.
  const old=require(path.join(__dirname,"v7-writer.cjs")) as typeof import("../../../src/main/memory-core/repository");const snapshot=bytes(folder),testKey=Buffer.alloc(32,7);
  assert.throws(()=>{const opened=old.openMemoryRepository({databasePath:file,key:testKey});opened.close()},/MEMORY_SCHEMA_UNSUPPORTED/);assert.deepEqual(bytes(folder),snapshot);
  const restored=path.join(ownedRoot,"restored-v7");fs.mkdirSync(restored);for(const suffix of ["",".auth"])fs.copyFileSync(path.join(backup,"memory.sqlite"+suffix),path.join(restored,"memory.sqlite"+suffix));assert.equal(hash(path.join(restored,"memory.sqlite")),"abe66d5aabccf0dcba143f8184b5ae41a029de9dbcabea889bfd3d17ff818434");
  const repo=old.openMemoryRepository({databasePath:path.join(restored,"memory.sqlite"),key:testKey});assert.deepEqual(repo.readRows("sources","scope-a")[0].payload,{text:"ACTUAL_V7_SYNTHETIC_RECORD"});repo.close();testKey.fill(0);db=new DatabaseSync(path.join(restored,"memory.sqlite"));assert.equal(db.prepare("PRAGMA user_version").get()?.user_version,7);db.close();
 }
 return {actualV7Writer:true,migratedVersion:9,encryptedSourceUnchanged:true,backupRollback:mode==="rollback"};
}

(async()=>{let client:MemoryClient|undefined;try{
 await app.whenReady();let evidence:object;
 if(mode==="migrate"||mode==="rollback")evidence=await migrateAndRollback();else{
  client=await MemoryClient.open({storage,keyProtection:createWindowsKeyProtection(storage.memory.tempRoot),workerFactory:data=>new Worker(path.join(__dirname,"worker.cjs"),{workerData:data,execArgv:[]})});const active=client,commands:any[]=[],transport={sourceCommand:(c:unknown)=>active.sourceCommand(c),policyCommand:(c:unknown)=>active.policyCommand(c),recallCommand:(c:unknown)=>active.recallCommand(c),contextCommand:(c:unknown)=>{commands.push(c);return active.contextCommand(c)}};
  const authority=createMainActorAuthority({resolveActor:()=>"actor-a"}),registry=createMainSourceRegistry(transport,{coordinate:authority.coordinate}),access=registry.authority.access("scope-a"),provider=new SyntheticSourceProvider(path.join(ownedRoot,"provider.json"),"scope-a"),policy=createMainPolicy({registry,transport,resolveActor:()=>"actor-a",actorAuthority:authority}),actor=policy.bindActor(access,provider.adapter,identity),recall=createMainRecall({actorAuthority:authority,transport});
  const requestIdentity={providerId:"synthetic",model:"synthetic",transport:"synthetic",framingVersion:"v1"},prepare=(units:any[],facts:any[]=[])=>({...requestIdentity,inputTypes:["text"],body:{messages:units.flatMap(u=>u.messages),facts:facts.map(f=>f.assertion)}}),options={registry,transport,actorAuthority:authority,counter:{capability:{...requestIdentity,mode:"exact" as const,inputTypes:["text"]},count:async(r:any)=>JSON.stringify(r.body).length},budget:{maxContextTokens:10000,reservedOutputTokens:64,safetyMarginTokens:16,maxSTokens:5000,minRecentCompleteTurns:1},prepare,prepareS:(u:any[])=>prepare(u)},context=createMainContext(options),savedFile=path.join(ownedRoot,"recall-state.json");
  async function action(fact:any,kind:"archive"|"restore"){return recall.apply(actor,await recall.preview(actor,[fact],kind))}
  async function permit(fact:any){return context.validateForDispatch(actor,await context.assemble(actor,{sessionId:identity.sessionId,sourceRefs:[],factRefs:[fact]}))}
  if(mode==="create"){
   const id={...identity,messageId:"bash"};provider.write(id,{text:"I prefer bash",role:"user",trust:"direct-user-event"});const sourceRef=await registry.capture(access,provider.adapter,id),memory=await policy.ingest(actor,sourceRef),fact={factId:memory.factId!,revision:1};assert.equal((await recall.rank(actor)).items.length,1);
   const oldPermit=await permit(fact);await action(fact,"archive");assert.equal((await recall.rank(actor)).items.length,0);assert.equal((await policy.recall(actor)).length,1);await action(fact,"restore");let sends=0;await assert.rejects(context.dispatch(actor,oldPermit,()=>{sends++;return "bad"}),/MEMORY_RECALL_VISIBILITY_STALE/);assert.equal(sends,0);
   assert.equal((await context.dispatch(actor,await permit(fact),()=>{sends++;return "local-success"})).status,"sent");assert.equal((await context.dispatch(actor,await permit(fact),()=>{sends++;return Promise.reject(new Error("SYNTHETIC_FAILURE"))})).status,"result-unknown");assert.equal(sends,2);
   const uncertain=createMainContext({...options,transport:{contextCommand:async(c:any)=>{const result=await transport.contextCommand(c);if(c.kind==="claim")throw new Error("MEMORY_WORKER_FAILED");return result}}}),s=await uncertain.assemble(actor,{sessionId:identity.sessionId,sourceRefs:[],factRefs:[fact]}),p=await uncertain.validateForDispatch(actor,s);await assert.rejects(uncertain.dispatch(actor,p,()=>{sends++;return "bad"}),/MEMORY_WORKER_FAILED/);assert.equal(sends,2);
   const state=(await recall.metadata(actor,[fact])).targets[0];assert.equal(state.accessCount,2);assert.equal(await recall.recover(actor).then(r=>r.unknown),0);const claim=commands.filter(c=>c.kind==="claim").at(-1);fs.writeFileSync(savedFile,JSON.stringify({fact,sourceRef,lastAccessAt:state.lastAccessAt,visibilityRevision:state.visibilityRevision,pending:{actorKey:claim.body.actorKey,providerId:claim.body.providerId,sessionId:claim.body.sessionId,bootId:claim.body.bootId,processBootId:claim.body.processBootId,useTicketId:claim.body.useTicketId}}));evidence={localInvocations:2,accessCount:2,stalePermitBlocked:true,pendingTicket:true};
  }else if(mode==="reopen"){
   const saved=JSON.parse(fs.readFileSync(savedFile,"utf8"));assert.equal((await recall.recover(actor)).unknown,1);assert.equal((await recall.recover(actor)).unknown,0);let state=(await recall.metadata(actor,[saved.fact])).targets[0];assert.equal(state.accessCount,2);assert.equal(state.lastAccessAt,saved.lastAccessAt);assert.equal(state.visibilityRevision,saved.visibilityRevision);await assert.rejects(active.contextCommand({kind:"confirmUse",scopeKey:"scope-a",commandId:"late-electron-confirm",body:{...saved.pending,invokedAt:Date.now()}}),/MEMORY_RECALL_USE_UNKNOWN/);
   let sends=0;assert.equal((await context.dispatch(actor,await permit(saved.fact),()=>{sends++;return "local-success"})).status,"sent");assert.equal(sends,1);state=(await recall.metadata(actor,[saved.fact])).targets[0];assert.equal(state.accessCount,3);
   await policy.act(actor,await policy.event(actor,{kind:"forget",nonce:randomUUID(),...saved.fact}));assert.equal((await recall.rank(actor)).items.length,0);await assert.rejects(recall.preview(actor,[saved.fact],"restore"),/MEMORY_RECALL_FACT_UNAVAILABLE/);evidence={unknownRecovered:1,recoveryDidNotRefresh:true,lateConfirmDenied:true,accessCountBeforeForget:3,forgetDominates:true};
  }else throw new Error("RECALL_PROBE_MODE_INVALID");
  await client.close();client=undefined;
 }
 const result={ok:true,mode,packaged:app.isPackaged,versions:{electron:process.versions.electron,node:process.versions.node,sqlite:process.versions.sqlite},syntheticCounter:true,...evidence};fs.writeFileSync(path.join(ownedRoot,"result-"+mode+".json"),JSON.stringify(result));console.log(JSON.stringify(result));app.exit(0);
}catch(error){fs.writeFileSync(path.join(ownedRoot,"result-"+mode+".json"),JSON.stringify({ok:false,error:error instanceof Error?error.message:String(error)}));await client?.close().catch(()=>{});app.exit(1)}})();
