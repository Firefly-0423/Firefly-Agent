import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {randomBytes,randomUUID} from "node:crypto";
import {afterEach,expect,it,vi} from "vitest";
// Real SQLite / filesystem integration cases: the 5 s default is too tight on CI runners, so this file allows 30 s. Other files keep the default.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
import {openMemoryRepository} from "../memory-core/repository";
import {createMainSourceRegistry} from "../memory-sources/source-registry";
import {SyntheticSourceProvider} from "../../../scripts/verify/memory-sources/synthetic-provider";
import {createMainPolicy} from "./main-policy";
const cleanups:Array<()=>void>=[];
afterEach(()=>{for(const cleanup of cleanups.splice(0))cleanup()});
function fixture(){
 const root=path.join(os.tmpdir(),`m1-synthetic-${randomUUID()}`),key=randomBytes(32),clock=()=>10000;
 fs.mkdirSync(root,{recursive:true});let repo=openMemoryRepository({databasePath:path.join(root,"memory.sqlite"),key,clock});
 cleanups.push(()=>{repo.close();key.fill(0);fs.rmSync(root,{recursive:true,force:true})});
 let beforePolicy:((command:any)=>Promise<void>)|undefined;
 const provider=new SyntheticSourceProvider(path.join(root,"sources.json"),"scope-a"),transport={sourceCommand:async(c:unknown)=>repo.sourceCommand(c),policyCommand:async(c:unknown)=>{await beforePolicy?.(c);return repo.policyCommand(c)}};
 const registry=createMainSourceRegistry(transport),access=registry.authority.access("scope-a"),policy=createMainPolicy({registry,transport,resolveActor:()=>"actor-a"});
 const base={providerId:"synthetic",sessionId:"session-a",messageId:"actor-binding"},actor=policy.bindActor(access,provider.adapter,base);
 async function source(text:string,occurredAt?:number){const id={...base,messageId:randomUUID()};provider.write(id,{text,role:"user",trust:"direct-user-event",...(occurredAt===undefined?{}:{occurredAt})});return {id,ref:await registry.capture(access,provider.adapter,id)}}
 async function integrate(text:string,at?:number){const s=await source(text,at),result=await policy.integrate(actor,s.ref);return {s,result:result.items[0]}}
 function reopen(){repo.close();repo=openMemoryRepository({databasePath:path.join(root,"memory.sqlite"),key,clock})}
 return {get repo(){return repo},provider,registry,access,policy,actor,source,integrate,reopen,setHook:(hook:typeof beforePolicy)=>{beforePolicy=hook}};
}
it.each(["I prefer bash","I now prefer bash"])("newer same-value support advances ordering without rewriting the declaration: %s",async text=>{
 const f=fixture(),a=await f.integrate("I prefer bash",1000),original=structuredClone(f.repo.current("scope-a")[0]),evidence=f.repo.readRows("evidence","scope-a");
 const same=await f.integrate(text,3000);expect(same.result).toMatchObject({status:"active",factId:a.result.factId,factRevision:1,reason:"duplicate-support"});
 expect(f.repo.current("scope-a")[0]).toEqual(original);expect(f.repo.history("scope-a",original.factId)).toHaveLength(1);expect(f.repo.readRows("evidence","scope-a")).toEqual(evidence);
 f.reopen();const late=await f.integrate("I now prefer cmd instead of bash",2000);expect(late.result).toMatchObject({status:"candidate",reason:"out-of-order"});expect((await f.policy.recall(f.actor))[0]).toEqual({...original,scope:"global"});
 const audit=await f.policy.audit(f.actor,original.factId);expect(audit.supports.filter(s=>s.validity==="valid").map(s=>s.sourceRef.sourceId).sort()).toEqual([a.s.ref.sourceId,same.s.ref.sourceId].sort());
});
it.each([2000,3000])("older or equal-time denial cannot overrule the latest confirmation at 3000: %s",async at=>{
 const f=fixture(),a=await f.integrate("I prefer bash",1000);await f.integrate("I now prefer bash",3000);
 expect((await f.integrate("I no longer use bash",at)).result).toMatchObject({status:"candidate",reason:"out-of-order"});expect((await f.policy.audit(f.actor,a.result.factId!)).reviews).toEqual([]);expect(await f.policy.recall(f.actor)).toHaveLength(1);
});
it("a later different value supersedes once and keeps immutable declaration clocks and provenance",async()=>{
 const f=fixture(),a=await f.integrate("I prefer bash",1000),original=structuredClone(f.repo.current("scope-a")[0]);await f.integrate("I now prefer bash",3000);await f.integrate("I prefer bash",500);
 const changed=await f.integrate("I now prefer cmd instead of bash",4000);expect(changed.result).toMatchObject({status:"active",factId:original.factId,factRevision:2});
 const history=f.repo.history("scope-a",original.factId);expect(history).toHaveLength(2);expect(history[0]).toEqual({...original,supersededAt:expect.any(Number)});expect(history[1]).toMatchObject({time:{validFrom:4000,validTo:null,referenceTime:4000},sourceRef:changed.s.ref});
 expect(history[1].recordedAt).toBeGreaterThan(4000);expect((await f.policy.audit(f.actor,a.result.factId!)).supports.map(s=>s.factRevision).sort()).toEqual([1,1,1,2]);
});
it("a valid later denial retains pending review and cannot be silently cleared by same-value support",async()=>{
 const f=fixture(),a=await f.integrate("I prefer bash",1000);await f.integrate("I now prefer bash",3000);
 expect((await f.integrate("I no longer use bash",4000)).result.status).toBe("pending-review");await f.integrate("I prefer bash",5000);
 expect(await f.policy.recall(f.actor)).toEqual([]);expect((await f.policy.audit(f.actor,a.result.factId!)).status).toBe("pending-review");expect(f.repo.history("scope-a",a.result.factId!)).toHaveLength(1);
});
it.each(["pending","deleted","stale","untrusted"])("revoked latest support no longer controls ordering: %s",async state=>{
 const f=fixture(),a=await f.integrate("I prefer bash",1000),same=await f.integrate("I now prefer bash",3000);await f.registry.prepareChange(f.access,f.provider.adapter,same.s.ref);
 if(state==="deleted"){f.provider.remove(same.s.id);await expect(f.registry.reconcile(f.access,f.provider.adapter,same.s.id)).rejects.toThrow("MEMORY_SOURCE_DELETED")}
 if(state==="stale"||state==="untrusted"){f.provider.write(same.s.id,{text:"I now prefer bash",role:"user",trust:state==="untrusted"?"history":"direct-user-event",occurredAt:3500});await f.registry.reconcile(f.access,f.provider.adapter,same.s.id)}
 expect((await f.policy.audit(f.actor,a.result.factId!)).supports.find(s=>s.sourceRef.sourceId===same.s.ref.sourceId)?.validity).not.toBe("valid");
 expect((await f.integrate("I now prefer cmd instead of bash",2000)).result).toMatchObject({status:"active",factRevision:2});
});
it("deleting the original declaration does not erase a later valid ordering witness",async()=>{
 const f=fixture(),a=await f.integrate("I prefer bash",1000);await f.integrate("I now prefer bash",3000);await f.registry.prepareChange(f.access,f.provider.adapter,a.s.ref);f.provider.remove(a.s.id);await expect(f.registry.reconcile(f.access,f.provider.adapter,a.s.id)).rejects.toThrow("MEMORY_SOURCE_DELETED");
 expect((await f.integrate("I now prefer cmd instead of bash",2000)).result).toMatchObject({status:"candidate",reason:"out-of-order"});expect(await f.policy.recall(f.actor)).toHaveLength(1);
});
it("an invalid newest declaration cannot outrank an older surviving support",async()=>{
 const f=fixture(),a=await f.integrate("I prefer bash",3000);await f.integrate("I prefer bash",1000);await f.registry.prepareChange(f.access,f.provider.adapter,a.s.ref);
 expect((await f.integrate("I now prefer cmd instead of bash",2000)).result).toMatchObject({status:"active",factRevision:2});
});
it("no valid support cannot authorize automatic replacement",async()=>{
 const f=fixture(),a=await f.integrate("I prefer bash",1000),same=await f.integrate("I now prefer bash",3000);for(const s of [a.s,same.s])await f.registry.prepareChange(f.access,f.provider.adapter,s.ref);
 expect((await f.integrate("I now prefer cmd instead of bash",4000)).result).toMatchObject({status:"candidate",reason:"prior-needs-review"});expect(await f.policy.recall(f.actor)).toEqual([]);expect(f.repo.current("scope-a")[0].revision).toBe(1);
});
it("a timed same-value witness can order an initially undated declaration without changing its clocks",async()=>{
 const f=fixture();await f.integrate("I prefer bash");const initial=f.repo.current("scope-a");
 // Unknown-time automatic input remains a candidate; explicitly confirm its canonical source first.
 const candidates=await f.policy.candidates(f.actor,{limit:10}),candidate=candidates.items[0],proof=await f.source("I confirm the selected fact");
 const token=await f.policy.event(f.actor,{kind:"confirm",nonce:randomUUID(),candidateId:candidate.candidateId,revision:1,sourceRef:proof.ref});await f.policy.act(f.actor,token);
 expect(initial).toEqual([]);const original=structuredClone(f.repo.current("scope-a")[0]);expect(original.time.referenceTime).toBeNull();await f.integrate("I prefer bash",3000);expect(f.repo.current("scope-a")[0]).toEqual(original);
 expect((await f.integrate("I now prefer cmd",2000)).result).toMatchObject({status:"candidate",reason:"out-of-order"});
});
it.each(["I now prefer cmd instead of bash","I no longer use bash"])("a queued baseline also observes same-value support committed before its transaction: %s",async text=>{
 const f=fixture();await f.integrate("I prefer bash",1000);const old=await f.source(text,2000);
 let started!:()=>void,release!:()=>void;const ready=new Promise<void>(resolve=>started=resolve),gate=new Promise<void>(resolve=>release=resolve);
 f.setHook(async command=>{if(command.kind==="integrate"&&command.body.sourceRef.sourceId===old.ref.sourceId){started();await gate}});
 const pending=f.policy.integrate(f.actor,old.ref);await ready;
 try{expect((await f.integrate("I now prefer bash",3000)).result.reason).toBe("duplicate-support")}finally{release()}
 expect((await pending).items[0]).toMatchObject({status:"candidate",reason:"out-of-order"});expect((await f.policy.recall(f.actor))[0].assertion).toBe("I prefer bash");
});
