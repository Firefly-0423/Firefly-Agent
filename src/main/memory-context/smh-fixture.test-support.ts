import fs from "node:fs";
import path from "node:path";
import {randomBytes,randomUUID} from "node:crypto";
import {openMemoryRepository} from "../memory-core/repository";
import {createMainActorAuthority} from "../memory-core/main-actor-authority";
import {canonicalJson} from "../memory-core/repository-types";
import {createMainSourceProvider,type SourceSnapshot} from "../memory-sources/main-source-provider";
import {createMainSourceRegistry} from "../memory-sources/source-registry";
import type {SourceIdentity,SourceRole,SourceTrust} from "../memory-core/source-contracts";
import {createMainPolicy} from "../memory-policy/main-policy";
import {createMainRecall} from "../memory-recall/main-recall";
import {createMainHistory} from "../memory-history/main-history";
import {createMainContext} from "./main-context";

/** Offline fixture only: caller supplies an explicit synthetic root and owns cleanup. No bootstrap caller. */
export function createSmhFixture(root:string,input:{includeFactSupportMetadata?:boolean;clock?:()=>number;key?:Uint8Array;fault?:(stage:"after-record"|"before-receipt")=>void}={}) {
 if(!path.isAbsolute(root))throw new Error("SMH_SYNTHETIC_ROOT_REQUIRED");
 fs.mkdirSync(root,{recursive:true});
 const key=Buffer.from(input.key??randomBytes(32)),clock=input.clock??(()=>1700000000000),databasePath=path.join(root,"memory.sqlite");
 const repo=openMemoryRepository({databasePath,key,clock,fault:input.fault});
 const commands:unknown[]=[];
 const command=(run:(c:unknown)=>unknown)=>(c:unknown)=>{commands.push(structuredClone(c));return Promise.resolve().then(()=>run(c))};
 const transport={sourceCommand:command(c=>repo.sourceCommand(c)),policyCommand:command(c=>repo.policyCommand(c)),recallCommand:command(c=>repo.recallCommand(c)),historyCommand:command(c=>repo.historyCommand(c)),contextCommand:command(c=>repo.contextCommand(c))};
 const actorAuthority=createMainActorAuthority({resolveActor:(scope,id)=>scope==="scope-a"&&id.providerId==="synthetic"&&["session-a","session-b"].includes(id.sessionId)?"actor-a":null});
 const registry=createMainSourceRegistry(transport,{coordinate:actorAuthority.coordinate}),access=registry.authority.access("scope-a");
 const file=path.join(root,"synthetic-provider.json"),entries:Record<string,SourceSnapshot>=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,"utf8")):{};
 const leases=new Set<string>();let reads=0;
 const adapter=createMainSourceProvider({providerId:"synthetic",authorize:(scope,id)=>scope==="scope-a"&&["session-a","session-b"].includes(id.sessionId),withLease:async(id,run)=>{
  const locator=canonicalJson(id);if(leases.has(locator))throw new Error("SMH_SYNTHETIC_LEASE_BUSY");leases.add(locator);
  try{return await run(async()=>{reads++;const entry=entries[locator];if(!entry)throw new Error("SMH_SYNTHETIC_SOURCE_MISSING");return structuredClone(entry)})}finally{leases.delete(locator)}
 }});
 const identity={providerId:"synthetic",sessionId:"session-a",messageId:"actor-binding"},actor=actorAuthority.bindActor(access,adapter,identity);
 function write(id:SourceIdentity,content:{text:string;role:SourceRole;trust:SourceTrust;occurredAt?:number;timeZone?:string}) {
  const locator=canonicalJson(id);if(leases.has(locator))throw new Error("SMH_SYNTHETIC_LEASE_BUSY");
  const old=entries[locator],generation=old?.generation??randomUUID();
  entries[locator]={...id,...content,generation,contentRevision:(old?.contentRevision??0)+1,state:"live"};
  const staging=file+".tmp";fs.writeFileSync(staging,JSON.stringify(entries));fs.renameSync(staging,file);
 }
 async function source(text:string,options:{messageId?:string;sessionId?:string;role?:SourceRole;trust?:SourceTrust;occurredAt?:number;timeZone?:string}={}) {
  const id={...identity,sessionId:options.sessionId??identity.sessionId,messageId:options.messageId??randomUUID()};
  write(id,{text,role:options.role??"user",trust:options.trust??"direct-user-event",...(options.occurredAt===undefined?{}:{occurredAt:options.occurredAt}),...(options.timeZone===undefined?{}:{timeZone:options.timeZone})});
  return {id,ref:await registry.capture(access,adapter,id)};
 }
 const policy=createMainPolicy({registry,transport,actorAuthority,resolveActor:()=>"actor-a"}),recall=createMainRecall({actorAuthority,transport}),history=createMainHistory({actorAuthority,registry,transport});
 const requestIdentity={providerId:"synthetic",model:"synthetic-model",transport:"synthetic",framingVersion:"v1"};
 const prepare:Parameters<typeof createMainContext>[0]["prepare"]=(units,facts)=>({...requestIdentity,inputTypes:["text"],body:{messages:units.flatMap(u=>u.messages).map(m=>({role:m.role,text:m.text,...(m.toolCalls?{toolCalls:m.toolCalls.map(c=>({...c}))}:{}),...(m.toolCallIds?{toolCallIds:[...m.toolCallIds]}:{}),...(m.toolCallId?{toolCallId:m.toolCallId}:{}),...(m.name?{name:m.name}:{})})),facts:facts.map(f=>f.assertion)}});
 const context=createMainContext({registry,transport,actorAuthority,clock,includeFactSupportMetadata:input.includeFactSupportMetadata,prepare,prepareS:units=>prepare(units,[]),counter:{capability:{...requestIdentity,mode:"exact",inputTypes:["text"]},count:async request=>JSON.stringify(request.body).length},budget:{maxContextTokens:100000,reservedOutputTokens:64,safetyMarginTokens:16,maxSTokens:10000,minRecentCompleteTurns:1}});
 return {root,databasePath,key,repo,transport,commands,actorAuthority,registry,access,adapter,identity,actor,policy,recall,history,context,source,write,get reads(){return reads},close:()=>{repo.close();key.fill(0)}};
}
