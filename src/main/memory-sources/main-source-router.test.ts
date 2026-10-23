import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {randomBytes} from "node:crypto";
import {afterEach,expect,it} from "vitest";
import {openMemoryRepository} from "../memory-core/repository";
import {createMainActorAuthority} from "../memory-core/main-actor-authority";
import type {SourceIdentity,SourceObservation} from "../memory-core/source-contracts";
import {createMainPolicy} from "../memory-policy/main-policy";
import {createMainUserFactCoordinator} from "../memory-policy/main-user-fact-coordinator";
import {SyntheticSourceProvider} from "../../../scripts/verify/memory-sources/synthetic-provider";
import {createMainSourceProvider,requireMainSourceProvider,type SourceSnapshot} from "./main-source-provider";
import {createMainSourceRegistry} from "./source-registry";
import {createMainSourceRouter} from "./main-source-router";

const providerId="synthetic",scopeKey="scope-a";
const desktop:SourceIdentity={providerId,sessionId:"desktop-session",messageId:"desktop-message"};
const settings:SourceIdentity={providerId,sessionId:"settings-session",messageId:"settings-message"};
const owned:Array<{root:string;repo:ReturnType<typeof openMemoryRepository>;router:ReturnType<typeof createMainSourceRouter>}>=[];
afterEach(async()=>{for(const f of owned.splice(0)){await f.router.close();f.repo.close();fs.rmSync(f.root,{recursive:true,force:true})}});
function deferred<T=void>(){let resolve!:(value:T|PromiseLike<T>)=>void;const promise=new Promise<T>(done=>{resolve=done});return {promise,resolve}}
function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"main-source-router-"));
 const repo=openMemoryRepository({databasePath:path.join(root,"memory.sqlite"),key:randomBytes(32)});
 const transport={sourceCommand:async(command:unknown)=>repo.sourceCommand(command),policyCommand:async(command:unknown)=>repo.policyCommand(command)};
 const actors=createMainActorAuthority({resolveActor:(scope,id)=>scope===scopeKey&&id.providerId===providerId?"same-actor":null});
 const registry=createMainSourceRegistry(transport,{coordinate:actors.coordinate}),access=registry.authority.access(scopeKey);
 const router=createMainSourceRouter({providerId});
 const a=new SyntheticSourceProvider(path.join(root,"desktop.json"),scopeKey),b=new SyntheticSourceProvider(path.join(root,"settings.json"),scopeKey);
 a.write(desktop,{text:"我默认用 PowerShell",role:"user",trust:"direct-user-event",occurredAt:1700000000000});
 b.write(settings,{text:"我默认用 PowerShell",role:"user",trust:"direct-user-event",occurredAt:1700000000000});
 owned.push({root,repo,router});
 return {root,repo,transport,actors,registry,access,router,a,b};
}
function mount(f:ReturnType<typeof fixture>,identity=desktop,sourceToken:object=f.a.adapter,lifetime?:AbortSignal){
 return f.router.register({scopeKey,anchorIdentity:identity,sourceToken,lifetime});
}
function snapshot(identity=desktop):SourceSnapshot{return {...identity,contentRevision:1,generation:"generation-a",state:"live",text:"synthetic body",role:"user",trust:"direct-user-event"}}

it("routes two real sources through one registry and actor authority, including cross-session M supports",async()=>{
 const f=fixture();mount(f);mount(f,settings,f.b.adapter);
 const actorA=f.actors.bindActor(f.access,f.router.token,desktop),actorB=f.actors.bindActor(f.access,f.router.token,settings);
 const a=await f.registry.capture(f.access,f.router.token,desktop),b=await f.registry.capture(f.access,f.router.token,settings);
 const policy=createMainPolicy({registry:f.registry,transport:f.transport,actorAuthority:f.actors,resolveActor:()=>"same-actor"});
 const coordinator=createMainUserFactCoordinator({actorAuthority:f.actors,registry:f.registry,policy});
 const first=await coordinator.onCommittedUserSource(actorA,a),second=await coordinator.onCommittedUserSource(actorB,b);
 expect(second.items[0]).toMatchObject({status:"active",factId:first.items[0].factId,reason:"duplicate-support"});
 const audit=await policy.audit(actorA,first.items[0].factId!);
 expect(audit.supports).toHaveLength(2);
 const actor=f.actors.requireActor(actorA);
 for(const support of audit.supports)expect(await f.registry.readEvidence(actor.access,actor.adapter,support.sourceRef)).toBe("我默认用 PowerShell");
 expect(f.actors.requireActor(actorB).adapter).toBe(actor.adapter);
});

it("requires opaque child and router capabilities and validates child scope without probing source text",async()=>{
 const f=fixture();f.a.failReads=true;
 for(const sourceToken of [{},JSON.parse(JSON.stringify(f.a.adapter)),{providerId,sessionId:desktop.sessionId,entry:"desktop"}]){
  expect(()=>mount(f,desktop,sourceToken)).toThrow("MEMORY_SOURCE_PROVIDER_DENIED");
 }
 expect(()=>f.router.register({scopeKey:"scope-b",anchorIdentity:desktop,sourceToken:f.a.adapter})).toThrow("MEMORY_SOURCE_PROVIDER_DENIED");
 expect(()=>mount(f,{...desktop,providerId:"wrong-provider"})).toThrow();
 mount(f); // Registration authorizes the anchor; it never reads or invents a source receipt.
 await expect(f.registry.capture(f.access,JSON.parse(JSON.stringify(f.router.token)),desktop)).rejects.toThrow("MEMORY_SOURCE_PROVIDER_DENIED");
 await expect(f.registry.capture(f.access,f.router.token,desktop)).rejects.toThrow("SYNTHETIC_READ_FAILED");
});

it("copies the route identity and cannot expand a child's own per-message authorization",async()=>{
 const f=fixture(),anchor={...desktop};let allowed=true,reads=0;
 const token=createMainSourceProvider({providerId,authorize:(scope,id)=>allowed&&scope===scopeKey&&id.sessionId===desktop.sessionId&&id.messageId===desktop.messageId,
  withLease:async(id,run)=>run(async()=>{reads++;return snapshot(id)})});
 mount(f,anchor,token);anchor.sessionId=settings.sessionId;anchor.messageId="forged";
 const ref=await f.registry.capture(f.access,f.router.token,desktop);expect(ref.binding.sessionId).toBe(desktop.sessionId);
 await expect(f.registry.capture(f.access,f.router.token,{...desktop,messageId:"not-authorized"})).rejects.toThrow("MEMORY_SOURCE_PROVIDER_DENIED");
 await expect(f.registry.capture(f.access,f.router.token,settings)).rejects.toThrow("MEMORY_SOURCE_PROVIDER_DENIED");
 allowed=false;const before=reads;
 await expect(f.registry.readEvidence(f.access,f.router.token,ref)).rejects.toThrow("MEMORY_SOURCE_PROVIDER_DENIED");
 expect(reads).toBe(before);
});

it("pins sessions to one scope for the router lifetime and never changes routes during authorize",async()=>{
 const f=fixture(),route=mount(f),scopeB=new SyntheticSourceProvider(path.join(f.root,"other-scope.json"),"scope-b");
 scopeB.write(desktop,{text:"other scope secret",role:"user",trust:"direct-user-event"});
 const allowed=requireMainSourceProvider(f.router.token,scopeKey,desktop);
 expect(()=>f.router.register({scopeKey:"scope-b",anchorIdentity:desktop,sourceToken:scopeB.adapter})).toThrow("MEMORY_SOURCE_ROUTE_CONFLICT");
 expect(()=>requireMainSourceProvider(f.router.token,"scope-b",desktop)).toThrow("MEMORY_SOURCE_PROVIDER_DENIED");
 expect(await allowed.withLease(desktop,async read=>(await read()).text)).toBe("我默认用 PowerShell");
 await f.router.unregister(route);
 expect(()=>f.router.register({scopeKey:"scope-b",anchorIdentity:desktop,sourceToken:scopeB.adapter})).toThrow("MEMORY_SOURCE_ROUTE_CONFLICT");
 mount(f);expect(await f.registry.capture(f.access,f.router.token,desktop)).toHaveProperty("sourceId");
});

it("rejects duplicate mounts and cloned or foreign route tokens; an old token cannot remove a remount",async()=>{
 const f=fixture(),route=mount(f);
 expect(()=>mount(f)).toThrow("MEMORY_SOURCE_ROUTE_CONFLICT");
 expect(()=>mount(f,desktop,f.b.adapter)).toThrow("MEMORY_SOURCE_ROUTE_CONFLICT");
 await expect(f.router.unregister(JSON.parse(JSON.stringify(route)))).rejects.toThrow("MEMORY_SOURCE_ROUTER_DENIED");
 const other=createMainSourceRouter({providerId}),foreign=other.register({scopeKey,anchorIdentity:desktop,sourceToken:f.a.adapter});
 await expect(f.router.unregister(foreign)).rejects.toThrow("MEMORY_SOURCE_ROUTER_DENIED");await other.close();
 await f.router.unregister(route);mount(f);
 await f.router.unregister(route);
 expect(await f.registry.capture(f.access,f.router.token,desktop)).toHaveProperty("sourceId");
});

it("revokes pending reads immediately on lifetime abort and waits for the real child lease to settle",async()=>{
 const f=fixture(),lifetime=new AbortController(),entered=deferred(),readDone=deferred(),cleanup=deferred();let reads=0,cleaned=false;
 const token=createMainSourceProvider({providerId,authorize:scope=>scope===scopeKey,withLease:async(id,run)=>{
  try{return await run(async()=>{reads++;entered.resolve();await readDone.promise;return snapshot(id)})}
  finally{await cleanup.promise;cleaned=true}
 }});
 const route=mount(f,desktop,token,lifetime.signal);
 const capturing=f.registry.capture(f.access,f.router.token,desktop);const result=capturing.catch(error=>error);
 await entered.promise;lifetime.abort();let drained=false;const draining=f.router.unregister(route).then(()=>{drained=true});
 expect(()=>requireMainSourceProvider(f.router.token,scopeKey,desktop)).toThrow("MEMORY_SOURCE_PROVIDER_DENIED");
 expect(()=>mount(f,desktop,token)).toThrow("MEMORY_SOURCE_ROUTE_CONFLICT");
 readDone.resolve();await new Promise(resolve=>setImmediate(resolve));expect(drained).toBe(false);expect(cleaned).toBe(false);
 cleanup.resolve();expect(await result).toMatchObject({message:"MEMORY_SOURCE_ROUTER_DENIED"});await draining;
 expect(cleaned).toBe(true);expect(reads).toBe(1);
 mount(f);const recovered=await f.registry.reconcile(f.access,f.router.token,desktop);
 expect(await f.registry.readEvidence(f.access,f.router.token,recovered)).toBe("我默认用 PowerShell");
});

it("checks child authorization before and after every read, including revoked asynchronous snapshots",async()=>{
 const f=fixture(),started=deferred(),finish=deferred();let authorized=true,reads=0;
 const token=createMainSourceProvider({providerId,authorize:scope=>scope===scopeKey&&authorized,withLease:async(id,run)=>run(async()=>{
  reads++;started.resolve();await finish.promise;return snapshot(id);
 })});
 mount(f,desktop,token);const capturing=f.registry.capture(f.access,f.router.token,desktop),result=capturing.catch(error=>error);
 await started.promise;authorized=false;finish.resolve();
 expect(await result).toMatchObject({message:"MEMORY_SOURCE_PROVIDER_DENIED"});expect(reads).toBe(1);
});

it("does not let a retained read closure escape its lease or revive after a same-scope remount",async()=>{
 const f=fixture(),route=mount(f),provider=requireMainSourceProvider(f.router.token,scopeKey,desktop);let retained!:(()=>Promise<SourceSnapshot>);
 await provider.withLease(desktop,async read=>{retained=read;expect((await read()).text).toBe("我默认用 PowerShell")});
 await expect(retained()).rejects.toThrow("MEMORY_SOURCE_ROUTER_DENIED");
 await f.router.unregister(route);mount(f);
 await expect(retained()).rejects.toThrow("MEMORY_SOURCE_ROUTER_DENIED");
 expect(await f.registry.capture(f.access,f.router.token,desktop)).toHaveProperty("sourceId");
});

it("rejects a late operation callback after the child lease has already settled",async()=>{
 const f=fixture();let late!:(()=>Promise<unknown>),invoked=0;
 const token=createMainSourceProvider({providerId,authorize:scope=>scope===scopeKey,
  async withLease<T>(id:SourceIdentity,run:(read:()=>Promise<SourceSnapshot>)=>Promise<T>):Promise<T>{
   late=()=>run(async()=>snapshot(id));return undefined as T;
  },
 });
 mount(f,desktop,token);const provider=requireMainSourceProvider(f.router.token,scopeKey,desktop);
 await provider.withLease(desktop,async read=>{invoked++;return read()});
 await expect(late()).rejects.toThrow("MEMORY_SOURCE_ROUTER_DENIED");expect(invoked).toBe(0);
});

it("revalidates after a child queue wait and does not hold the shared authority queue while draining",async()=>{
 const f=fixture(),queued=deferred(),release=deferred();let invoked=false;
 const token=createMainSourceProvider({providerId,authorize:scope=>scope===scopeKey,withLease:async(id,run)=>{queued.resolve();await release.promise;return run(async()=>{invoked=true;return snapshot(id)})}});
 const route=mount(f,desktop,token);mount(f,settings,f.b.adapter);
 const provider=requireMainSourceProvider(f.router.token,scopeKey,desktop),operation=provider.withLease(desktop,async read=>read()),result=operation.catch(error=>error);
 await queued.promise;const draining=f.router.unregister(route);
 // A different source still uses the same actual actor queue while this child is pending.
 expect(await f.registry.capture(f.access,f.router.token,settings)).toHaveProperty("sourceId");
 release.resolve();expect(await result).toMatchObject({message:"MEMORY_SOURCE_ROUTER_DENIED"});await draining;expect(invoked).toBe(false);
});

it("close revokes every route synchronously and waits for success and failure cleanup without poisoning other work",async()=>{
 const f=fixture(),entered=deferred(),finish=deferred();let cleaned=false;
 const token=createMainSourceProvider({providerId,authorize:scope=>scope===scopeKey,withLease:async()=>{entered.resolve();try{await finish.promise;throw Error("SYNTHETIC_FAILURE")}finally{cleaned=true}}});
 mount(f,desktop,token);mount(f,settings,f.b.adapter);
 const provider=requireMainSourceProvider(f.router.token,scopeKey,desktop),operation=provider.withLease(desktop,async read=>read()),result=operation.catch(error=>error);
 await entered.promise;let closed=false;const closing=f.router.close().then(()=>{closed=true});
 expect(()=>requireMainSourceProvider(f.router.token,scopeKey,settings)).toThrow("MEMORY_SOURCE_PROVIDER_DENIED");
 expect(()=>mount(f)).toThrow("MEMORY_SOURCE_ROUTER_DENIED");
 await Promise.resolve();expect(closed).toBe(false);finish.resolve();expect(await result).toMatchObject({message:"SYNTHETIC_FAILURE"});
 await closing;expect(cleaned).toBe(true);await f.router.close();
});

it("rejects already-aborted registrations and forwards authenticated previous observations unchanged",async()=>{
 const f=fixture(),lifetime=new AbortController();lifetime.abort();
 expect(()=>mount(f,desktop,f.a.adapter,lifetime.signal)).toThrow("MEMORY_SOURCE_ROUTER_DENIED");
 let previous:Readonly<SourceObservation>|undefined;
 const token=createMainSourceProvider({providerId,authorize:scope=>scope===scopeKey,withLease:async(id,run,prior)=>{previous=prior;return run(async()=>snapshot(id))}});
 mount(f,desktop,token);const ref=await f.registry.capture(f.access,f.router.token,desktop);expect(previous).toBeUndefined();
 expect(await f.registry.readEvidence(f.access,f.router.token,ref)).toBe("synthetic body");
 expect(previous).toMatchObject({...desktop,contentRevision:1,generation:"generation-a",state:"live"});expect(Object.isFrozen(previous)).toBe(true);
});
