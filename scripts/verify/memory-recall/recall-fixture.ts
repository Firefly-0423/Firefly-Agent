import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {randomBytes,randomUUID} from "node:crypto";
import {openMemoryRepository} from "../../../src/main/memory-core/repository";
import {createMainActorAuthority} from "../../../src/main/memory-core/main-actor-authority";
import {createMainSourceRegistry} from "../../../src/main/memory-sources/source-registry";
import {createMainPolicy} from "../../../src/main/memory-policy/main-policy";
import {SyntheticSourceProvider} from "../memory-sources/synthetic-provider";
/** Test/probe fixture only; creates owned synthetic data, never product userData. */
export function recallFixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"recall-m-")),key=randomBytes(32),databasePath=path.join(root,"memory.sqlite");let now=Date.now(),faultKind="",currentKind="";const commands:unknown[]=[];
 const repositoryOptions={databasePath,key,clock:()=>now,fault:()=>{if(faultKind&&currentKind===faultKind)throw new Error("MEMORY_RECALL_INJECTED_FAULT")}};let repo=openMemoryRepository(repositoryOptions);
 const authority=createMainActorAuthority({resolveActor:()=>"actor-a"}),transport={sourceCommand:async(c:any)=>{currentKind="source";return repo.sourceCommand(c)},policyCommand:async(c:any)=>{currentKind="policy";return repo.policyCommand(c)},contextCommand:async(c:any)=>{currentKind=c.kind;return repo.contextCommand(c)},recallCommand:async(c:any)=>{currentKind=c.kind;commands.push(c);return repo.recallCommand(c)}};
 const registry=createMainSourceRegistry(transport,{coordinate:authority.coordinate}),provider=new SyntheticSourceProvider(path.join(root,"provider.json"),"scope-a"),access=registry.authority.access("scope-a"),identity={providerId:"synthetic",sessionId:"session-a",messageId:"binding"},policy=createMainPolicy({registry,transport,resolveActor:()=>"actor-a",actorAuthority:authority}),actor=policy.bindActor(access,provider.adapter,identity);
 const owner={actorKey:"actor-a",providerId:"synthetic",sessionId:"session-a",bootId:"boot-a"};
 async function source(text:string){const id={...identity,messageId:randomUUID()};provider.write(id,{text,role:"user",trust:"direct-user-event"});return {id,ref:await registry.capture(access,provider.adapter,id)}}
 async function active(text="I prefer bash"){const s=await source(text),result=await policy.ingest(actor,s.ref);return {...s,...result}}
 const command=(kind:string,body:object={},commandId?:string)=>transport.recallCommand({kind,scopeKey:"scope-a",...(commandId?{commandId}:{}),body:{...owner,...body}});
 function reopen(){repo.close();repo=openMemoryRepository(repositoryOptions)}
 function close(){repo.close();key.fill(0);fs.rmSync(root,{recursive:true,force:true})}
 return {root,key,databasePath,repositoryOptions,get repo(){return repo},authority,transport,registry,provider,access,identity,policy,actor,owner,commands,source,active,command,reopen,close,now:()=>now,advance:(ms:number)=>{now+=ms},setClock:(value:number)=>{now=value},setFault:(kind:string)=>{faultKind=kind}};
}
