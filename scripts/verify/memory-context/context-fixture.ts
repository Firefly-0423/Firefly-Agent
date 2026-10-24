import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {randomBytes,randomUUID} from "node:crypto";
import {afterEach} from "vitest";
import {openMemoryRepository} from "../../../src/main/memory-core/repository";
import {createMainSourceRegistry} from "../../../src/main/memory-sources/source-registry";
import {createMainPolicy} from "../../../src/main/memory-policy/main-policy";
import {SyntheticSourceProvider} from "../memory-sources/synthetic-provider";
const roots:string[]=[],repos:ReturnType<typeof openMemoryRepository>[]=[];
afterEach(()=>{for(const r of repos.splice(0))r.close();for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true})});
export async function contextFixture(){
 const {createMainActorAuthority}=await import("../../../src/main/memory-core/main-actor-authority"),{createMainContext}=await import("../../../src/main/memory-context/main-context");
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"context-s-"));roots.push(root);const key=randomBytes(32),databasePath=path.join(root,"memory.sqlite");
 let now=Date.now(),fault=false,faultKind="summaryCommit",faultAfterRecords=1,faultRecordCount=0,currentKind="";const commands:unknown[]=[];
 const repositoryOptions={databasePath,key,clock:()=>now,fault:(step:string)=>{if(fault&&currentKind===faultKind&&step==="after-record"&&++faultRecordCount>=faultAfterRecords)throw new Error("SUMMARY_INJECTED_FAULT")}};
 let repo=openMemoryRepository(repositoryOptions);repos.push(repo);let writes=0,cache="v1",countHook:undefined|(()=>Promise<void>);
 const actorAuthority=createMainActorAuthority({resolveActor:()=>"actor-a"});
 const transport={sourceCommand:async(c:unknown)=>{currentKind="source";commands.push(c);writes++;return repo.sourceCommand(c)},policyCommand:async(c:unknown)=>{currentKind="policy";return repo.policyCommand(c)},contextCommand:async(c:any)=>{currentKind=c.kind;commands.push(c);writes++;return repo.contextCommand(c)}};
 const registry=createMainSourceRegistry(transport,{coordinate:actorAuthority.coordinate});
 const provider=new SyntheticSourceProvider(path.join(root,"provider.json"),"scope-a"),access=registry.authority.access("scope-a"),identity={providerId:"synthetic",sessionId:"session-a",messageId:"binding"};
 const policy=createMainPolicy({registry,transport,resolveActor:()=>"actor-a",actorAuthority}),actor=policy.bindActor(access,provider.adapter,identity);
 const requestIdentity={providerId:"synthetic",model:"synthetic-model",transport:"synthetic",framingVersion:"v1"};
 const counter={capability:{...requestIdentity,mode:"exact" as const,inputTypes:["text"]},count:async(r:any)=>{await countHook?.();return JSON.stringify(r.body).length}};
 const budget={maxContextTokens:100000,reservedOutputTokens:64,safetyMarginTokens:16,maxSTokens:10000,minRecentCompleteTurns:1};
 const prepare=(units:any[],facts:any[]=[])=>({...requestIdentity,inputTypes:["text"],body:{system:"fixed",cache,messages:units.flatMap(u=>u.messages),facts:facts.map(f=>f.assertion)}});
 const options={registry,transport,actorAuthority,clock:()=>now,counter,budget,prepare,prepareS:(u:any[])=>({...requestIdentity,inputTypes:["text"],body:{messages:u.flatMap(x=>x.messages)}})};
 const context=createMainContext(options);
 async function source(text:string,role="user",trust="direct-user-event"){
  const id={...identity,messageId:randomUUID()};provider.write(id,{text,role:role as any,trust:trust as any});return {id,ref:await registry.capture(access,provider.adapter,id)};
 }
 async function active(text="I prefer bash"){const s=await source(text),result=await policy.ingest(actor,s.ref);return {...s,...result}}
 async function forget(factId:string,revision=1){await policy.act(actor,await policy.event(actor,{kind:"forget",nonce:randomUUID(),factId,revision}))}
 const assemble=(refs:any[]=[],facts:any[]=[])=>context.assemble(actor,{sessionId:"session-a",sourceRefs:refs,factRefs:facts});
 function reopen(){repo.close();repo=openMemoryRepository(repositoryOptions);repos.push(repo)}
 return {root,databasePath,key,get repo(){return repo},registry,provider,policy,actor,actorAuthority,access,identity,context,options,transport,source,active,forget,assemble,reopen,commands,advanceClock:(ms:number)=>{now+=ms},setFault:(value:boolean,kind="summaryCommit",afterRecords=1)=>{fault=value;faultKind=kind;faultAfterRecords=afterRecords;faultRecordCount=0},get writes(){return writes},setCache:(value:string)=>{cache=value},setCountHook:(hook:typeof countHook)=>{countHook=hook}};
}
