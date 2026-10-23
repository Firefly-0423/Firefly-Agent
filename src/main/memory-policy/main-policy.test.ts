import fs from "node:fs";
import os from "node:os";
import {DatabaseSync} from "node:sqlite";
import path from "node:path";
import {createHash,randomBytes,randomUUID} from "node:crypto";
import {afterEach,it,expect,vi} from "vitest";
// Real SQLite / filesystem integration cases: the 5 s default is too tight on CI runners, so this file allows 30 s. Other files keep the default.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
import {openMemoryRepository} from "../memory-core/repository";
import {MemoryService} from "../memory-core/memory-service";
import {createMainSourceRegistry} from "../memory-sources/source-registry";
import {SyntheticSourceProvider} from "../../../scripts/verify/memory-sources/synthetic-provider";
import {createMainPolicy} from "./main-policy";
import {createMainActorAuthority} from "../memory-core/main-actor-authority";
const roots:string[]=[],repos:ReturnType<typeof openMemoryRepository>[]=[];
afterEach(()=>{for(const r of repos.splice(0))r.close();for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true})});
function fixture(fault?:(stage:"after-record"|"before-receipt")=>void){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"policy-b2-"));roots.push(root);
 const key=randomBytes(32),databasePath=path.join(root,"memory.sqlite");
 let repo=openMemoryRepository({databasePath,key,fault});repos.push(repo);
 const provider=new SyntheticSourceProvider(path.join(root,"provider.json"),"scope-a");
 let beforePolicy:((c:any)=>Promise<void>)|undefined;
 const transport={sourceCommand:async(c:unknown)=>repo.sourceCommand(c),policyCommand:async(c:unknown)=>{await beforePolicy?.(c);return repo.policyCommand(c)}};
 const registry=createMainSourceRegistry(transport),access=registry.authority.access("scope-a");
 let resolved:string|null="opaque-human-a";
 const policy=createMainPolicy({registry,transport,resolveActor:()=>resolved});
 const base={providerId:"synthetic",sessionId:"session-a",messageId:"binding-only"};
 const actor=policy.bindActor(access,provider.adapter,base);
 async function source(text:string,trust="direct-user-event",role="user",sessionId="session-a",occurredAt?:number){
  const id={...base,messageId:randomUUID(),sessionId};provider.write(id,{text,trust:trust as any,role:role as any,...(occurredAt!==undefined?{occurredAt}:{})});
  return {id,ref:await registry.capture(access,provider.adapter,id)};
 }
 async function input(text:string,trust="direct-user-event",role="user"){const s=await source(text,trust,role);return {s,result:await policy.ingest(actor,s.ref)}}
 async function event(kind:string,target:Record<string,unknown>){const confirmation=kind==="confirm"&&!target.sourceRef?await source("I confirm the selected fact"):null;return policy.event(actor,{kind,nonce:randomUUID(),...(confirmation?{sourceRef:confirmation.ref}:{}),...target})}
 function reopen(){repo.close();repo=openMemoryRepository({databasePath,key});repos.push(repo)}
 return {root,get repo(){return repo},provider,registry,access,actor,policy,transport,source,input,event,reopen,setHook:(hook:typeof beforePolicy)=>{beforePolicy=hook},denyIdentity:()=>{resolved=null}};
}
it("Main direct preferences activate with policy provenance and unknown time",async()=>{
 const f=fixture(),{result}=await f.input("我默认用 PowerShell");expect(result.status).toBe("active");
 expect(f.repo.current("scope-a")[0]).toMatchObject({assertion:"我默认用 PowerShell",activationReason:"policyAccepted",policyVersion:"main-preferences-v1",time:{validFrom:null,validTo:null,referenceTime:null}});
});
it.each(["history","imported","model","system"])("role user cannot promote %s trust; explicit confirmation is distinct",async trust=>{
 const f=fixture(),{result}=await f.input("I prefer English",trust);expect(result.status).toBe("candidate");expect(f.repo.current("scope-a")).toEqual([]);
 const token=await f.event("confirm",{candidateId:result.candidateId,revision:1});expect((await f.policy.act(f.actor,token)).status).toBe("active");
 expect(f.repo.current("scope-a")[0]).toMatchObject({activationReason:"explicitUserConfirmed",policyVersion:null});
});
it("third-party, unknown and sensitive candidates have no blanket confirmation override",async()=>{
 const f=fixture();for(const text of ["Alice prefers PowerShell","我有糖尿病","明天可能去上海"]){const {result}=await f.input(text);expect(result.status).toBe("candidate");const token=await f.event("confirm",{candidateId:result.candidateId,revision:1});await expect(f.policy.act(f.actor,token)).rejects.toThrow("MEMORY_POLICY_UNRESOLVED");}
});
it("unresolved candidates persist reference and reason without copying arbitrary raw body",async()=>{
 const f=fixture();for(const text of ["UNLABELLED_HIGH_ENTROPY_CANARY_A12345","我有糖尿病","明天可能去上海"]){expect((await f.input(text)).result.status).toBe("candidate");}
 expect(f.repo.readRows("evidence","scope-a")).toEqual([]);expect(f.repo.readRows("candidates","scope-a")).toEqual([]);
 const page=await f.policy.candidates(f.actor,{limit:10});expect(page.items).toHaveLength(3);for(const item of page.items){expect(item.assertion).toBe("");expect(item.sourceRef.binding).toBeDefined();}
});
it("projects reference-only versus ready content and trustworthy source time without copying unknown bodies",async()=>{
 const f=fixture();
 const unknown=await f.source("帮我检查这个函数","direct-user-event","user","session-a",1700000000000);
 await f.policy.integrate(f.actor,unknown.ref);
 const ready=await f.input("I prefer English","history");
 const items=(await f.policy.candidates(f.actor,{limit:10})).items;
 expect(items.find(item=>item.sourceRef.sourceId===unknown.ref.sourceId)).toMatchObject({assertion:"",reviewState:"reference-only",occurredAt:1700000000000});
 expect(items.find(item=>item.candidateId===ready.result.candidateId)).toMatchObject({assertion:"I prefer English",reviewState:"ready",occurredAt:null});
 expect(f.repo.readRows("evidence","scope-a")).toHaveLength(1);
});
it("omits pending, stale and deleted candidates individually without losing a healthy timestamp",async()=>{
 const f=fixture(),stale=await f.input("I prefer English","history"),healthy=await f.source("ordinary task","direct-user-event","user","session-a",1700000000000);
 await f.policy.integrate(f.actor,healthy.ref);
 const check=async()=>expect((await f.policy.candidates(f.actor,{limit:10})).items).toMatchObject([{sourceRef:{sourceId:healthy.ref.sourceId},occurredAt:1700000000000}]);
 await f.registry.prepareChange(f.access,f.provider.adapter,stale.s.ref);await check();
 f.provider.write(stale.s.id,{text:"I prefer Chinese",role:"user",trust:"history"});const changed=await f.registry.reconcile(f.access,f.provider.adapter,stale.s.id);await check();
 await f.registry.prepareChange(f.access,f.provider.adapter,changed);
 f.provider.remove(stale.s.id);await expect(f.registry.reconcile(f.access,f.provider.adapter,stale.s.id)).rejects.toThrow("MEMORY_SOURCE_DELETED");await check();
});
it.each(["我密码是 SECRET_CANARY_B2","refresh_token=SECRET_CANARY_B2","My passphrase is SECRET_CANARY_B2"])("secret refusals persist no evidence or candidate body: %s",async text=>{
 const f=fixture(),commands:unknown[]=[];f.setHook(async command=>{commands.push(command)});const before=f.repo.readRows("evidence","scope-a");expect((await f.input(text)).result).toEqual({status:"rejected",reason:"secret"});
 expect(JSON.stringify(commands)).not.toContain("SECRET_CANARY_B2");
 expect(f.repo.readRows("evidence","scope-a")).toEqual(before);expect(f.repo.readRows("candidates","scope-a")).toEqual([]);expect((await f.policy.candidates(f.actor,{limit:10})).items).toEqual([]);
 for(const name of fs.readdirSync(f.root).filter(n=>n.startsWith("memory.sqlite")))expect(fs.readFileSync(path.join(f.root,name)).includes(Buffer.from("SECRET_CANARY_B2"))).toBe(false);
});
it("opaque actor rejects JSON forgery, absent identity, provider/session/scope crossings",async()=>{
 const f=fixture(),s=await f.source("I prefer bash");await expect(f.policy.ingest({},s.ref)).rejects.toThrow("MEMORY_ACTOR_DENIED");
 const other=await f.source("I prefer bash","direct-user-event","user","session-b");await expect(f.policy.ingest(f.actor,other.ref)).rejects.toThrow("MEMORY_ACTOR_DENIED");
 expect(()=>f.policy.bindActor({},f.provider.adapter,s.id)).toThrow("MEMORY_ACCESS_DENIED");expect(()=>f.policy.bindActor(f.registry.authority.access("scope-b"),f.provider.adapter,s.id)).toThrow("MEMORY_SOURCE_PROVIDER_DENIED");
 f.denyIdentity();expect(()=>f.policy.bindActor(f.access,f.provider.adapter,s.id)).toThrow("MEMORY_ACTOR_DENIED");
});
it("address aliases do not alter actor and shell conflict stays candidate",async()=>{
 const f=fixture();await f.input("请叫我小林🌟");const initial=(await f.input("I prefer PowerShell")).result;
 const {result}=await f.input("我默认用 cmd");expect(result).toMatchObject({status:"candidate",reason:"conflict"});expect(f.repo.current("scope-a")).toHaveLength(2);
 const token=await f.event("confirm",{candidateId:result.candidateId,revision:1});await expect(f.policy.act(f.actor,token)).rejects.toThrow("MEMORY_FACT_CONFLICT");expect(f.repo.current("scope-a").find(x=>x.factId===initial.factId)?.assertion).toBe("I prefer PowerShell");
});
it("reject/revise bind revision and invalidate stale confirmation, retry is idempotent",async()=>{
 const f=fixture(),{result}=await f.input("I prefer bash","history"),token=await f.event("confirm",{candidateId:result.candidateId,revision:1});
 const fresh=await f.source("I prefer cmd");const revise=await f.event("revise",{candidateId:result.candidateId,revision:1,sourceRef:fresh.ref});
 expect(await f.policy.act(f.actor,revise)).toMatchObject({status:"candidate",candidateRevision:2});await expect(f.policy.act(f.actor,token)).rejects.toThrow("MEMORY_REVISION_CONFLICT");
 const reject=await f.event("reject",{candidateId:result.candidateId,revision:2});const first=await f.policy.act(f.actor,reject);expect(await f.policy.act(f.actor,reject)).toEqual(first);expect(first.status).toBe("rejected");expect((await f.policy.candidates(f.actor,{limit:10})).items).toHaveLength(0);
});
it("synthetic event nonce cannot be reused for another candidate or action",async()=>{
 const f=fixture(),a=(await f.input("I prefer bash","history")).result,b=(await f.input("I prefer English","history")).result,nonce=randomUUID();
 const token=await f.policy.event(f.actor,{kind:"reject",nonce,candidateId:a.candidateId,revision:1});await f.policy.act(f.actor,token);
 const confirmation=await f.source("I confirm the selected fact");const forged=await f.policy.event(f.actor,{kind:"confirm",nonce,candidateId:b.candidateId,revision:1,sourceRef:confirmation.ref});await expect(f.policy.act(f.actor,forged)).rejects.toThrow("MEMORY_COMMAND_CONFLICT");await expect(f.policy.act(f.actor,{})).rejects.toThrow("MEMORY_EVENT_DENIED");
});
it("explicit correction appends immutable revision; forget is a different event",async()=>{
 const f=fixture(),active=(await f.input("I prefer bash")).result,s=await f.source("I prefer cmd");
 const correct=await f.event("correct",{factId:active.factId,revision:1,sourceRef:s.ref});expect(await f.policy.act(f.actor,correct)).toMatchObject({status:"active",factRevision:2});expect(f.repo.history("scope-a",active.factId).map(x=>x.assertion)).toEqual(["I prefer bash","I prefer cmd"]);
 const wrong=await f.source("这条不对");await expect(f.policy.event(f.actor,{kind:"correct",nonce:randomUUID(),factId:active.factId,revision:2,sourceRef:wrong.ref})).rejects.toThrow("MEMORY_POLICY_UNRESOLVED");expect(f.repo.current("scope-a")).toHaveLength(1);
});
it("forget blocks old candidates/captured work/repeated text; new remember does not release old generation",async()=>{
 const f=fixture(),original=await f.input("I prefer bash"),old=(await f.input("I prefer cmd","history")).result;
 const oldToken=await f.event("confirm",{candidateId:old.candidateId,revision:1});const forget=await f.event("forget",{factId:original.result.factId,revision:1});await f.policy.act(f.actor,forget);
 expect(f.repo.current("scope-a")).toEqual([]);expect((await f.policy.candidates(f.actor,{limit:10})).items).toEqual([]);await expect(f.policy.act(f.actor,oldToken)).rejects.toThrow("MEMORY_POLICY_SUPPRESSED");
 expect((await f.policy.ingest(f.actor,original.s.ref)).status).toBe("suppressed");expect((await f.input("I prefer bash")).result.status).toBe("suppressed");
 const fresh=await f.source("I prefer bash"),remember=await f.event("remember",{sourceRef:fresh.ref});expect((await f.policy.act(f.actor,remember)).status).toBe("active");await expect(f.policy.act(f.actor,oldToken)).rejects.toThrow("MEMORY_POLICY_SUPPRESSED");
 expect(await f.registry.readEvidence(f.access,f.provider.adapter,original.s.ref)).toBe("I prefer bash");
});
it("source edit/delete denies late confirmation without choosing confirmed M recall policy",async()=>{
 const f=fixture(),active=await f.input("I prefer English"),pending=await f.input("I prefer cmd","history"),confirm=await f.event("confirm",{candidateId:pending.result.candidateId,revision:1});
 await f.registry.prepareChange(f.access,f.provider.adapter,pending.s.ref);await expect(f.policy.act(f.actor,confirm)).rejects.toThrow("MEMORY_SOURCE_PENDING");
 f.provider.remove(pending.s.id);await expect(f.registry.reconcile(f.access,f.provider.adapter,pending.s.id)).rejects.toThrow("MEMORY_SOURCE_DELETED");await expect(f.policy.act(f.actor,confirm)).rejects.toThrow("MEMORY_SOURCE_DELETED");
 await f.registry.prepareChange(f.access,f.provider.adapter,active.s.ref);expect(f.repo.current("scope-a")).toHaveLength(1);
});
it("candidate cursors are bound to actor, scope and forget generation",async()=>{
 const f=fixture();for(const text of ["a","b","c"] )await f.input(text);
 const page=await f.policy.candidates(f.actor,{limit:1});expect(page.items).toHaveLength(1);expect(page.cursor).not.toBeNull();
 await expect(f.policy.candidates({}, {limit:1,cursor:page.cursor})).rejects.toThrow("MEMORY_ACTOR_DENIED");
 const next=await f.policy.candidates(f.actor,{limit:1,cursor:page.cursor});expect(next.items[0].candidateId).not.toBe(page.items[0].candidateId);
 const active=(await f.input("I prefer bash")).result;await f.policy.act(f.actor,await f.event("forget",{factId:active.factId,revision:1}));await expect(f.policy.candidates(f.actor,{limit:1,cursor:page.cursor})).rejects.toThrow("MEMORY_CURSOR_STALE");
});
it("remember refuses a source captured before forget even if never extracted",async()=>{
 const f=fixture(),active=(await f.input("I prefer bash")).result,old=await f.source("I prefer bash");
 await f.policy.act(f.actor,await f.event("forget",{factId:active.factId,revision:1}));
 const remember=await f.event("remember",{sourceRef:old.ref});await expect(f.policy.act(f.actor,remember)).rejects.toThrow("MEMORY_POLICY_SUPPRESSED");expect(f.repo.current("scope-a")).toEqual([]);
});
it("partial quotes cannot remove negation or change speaker for autoactivation",async()=>{
 const f=fixture(),s=await f.source('Alice said: "I prefer bash"');await expect(f.policy.ingest(f.actor,{...s.ref,span:{start:13,end:26}})).rejects.toThrow("MEMORY_POLICY_FULL_SOURCE_REQUIRED");expect(f.repo.current("scope-a")).toEqual([]);
});
it("transaction fault rolls back candidate, evidence, active fact and receipt; exact retry recovers",async()=>{
 let armed=false;const f=fixture(stage=>{if(armed&&stage==="before-receipt")throw new Error("INJECTED_POLICY_FAULT")}),s=await f.source("I prefer English");
 f.setHook(async c=>{if(c.kind==="ingest")armed=true});await expect(f.policy.ingest(f.actor,s.ref)).rejects.toThrow("INJECTED_POLICY_FAULT");expect(f.repo.current("scope-a")).toEqual([]);expect(f.repo.readRows("evidence","scope-a")).toEqual([]);expect(f.repo.readRows("candidates","scope-a")).toEqual([]);
 f.setHook(undefined);armed=false;const result=await f.policy.ingest(f.actor,s.ref);expect(result.status).toBe("active");expect(await f.policy.ingest(f.actor,s.ref)).toEqual(result);f.reopen();expect(f.repo.current("scope-a")).toHaveLength(1);
});
it("captured late ingest after concurrent forget cannot store evidence or resurrect fact",async()=>{
 const f=fixture(),active=(await f.input("I prefer bash")).result,s=await f.source("I prefer cmd");
 let release!:()=>void,observed!:()=>void;const gate=new Promise<void>(r=>{release=r}),started=new Promise<void>(r=>{observed=r});
 f.setHook(async c=>{if(c.kind==="ingest"){observed();await gate}});const late=f.policy.ingest(f.actor,s.ref);await started;
 await f.policy.act(f.actor,await f.event("forget",{factId:active.factId,revision:1}));const before=f.repo.readRows("evidence","scope-a").length;release();await expect(late).rejects.toThrow("MEMORY_POLICY_SUPPRESSED");expect(f.repo.readRows("evidence","scope-a")).toHaveLength(before);expect(f.repo.current("scope-a")).toEqual([]);
});
it("concurrent candidate edit wins one revision; stale confirm cannot accept another version",async()=>{
 const f=fixture(),c=(await f.input("I prefer bash","history")).result,a=await f.source("I prefer cmd"),b=await f.source("I prefer PowerShell");
 const ea=await f.event("revise",{candidateId:c.candidateId,revision:1,sourceRef:a.ref}),eb=await f.event("revise",{candidateId:c.candidateId,revision:1,sourceRef:b.ref});
 const results=await Promise.allSettled([f.policy.act(f.actor,ea),f.policy.act(f.actor,eb)]);expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);expect((results.find(r=>r.status==="rejected") as PromiseRejectedResult).reason.message).toBe("MEMORY_REVISION_CONFLICT");
});
it("sole automatic support pauses recall when pending/deleted, without rewriting immutable fact",async()=>{
 const f=fixture(),active=await f.input("I prefer bash");expect(await f.policy.recall(f.actor)).toHaveLength(1);
 await f.registry.prepareChange(f.access,f.provider.adapter,active.s.ref);expect(await f.policy.recall(f.actor)).toEqual([]);expect((await f.policy.audit(f.actor,active.result.factId!)).status).toBe("pending-review");expect(f.repo.current("scope-a")).toHaveLength(1);
 f.provider.remove(active.s.id);await expect(f.registry.reconcile(f.access,f.provider.adapter,active.s.id)).rejects.toThrow("MEMORY_SOURCE_DELETED");expect(await f.policy.recall(f.actor)).toEqual([]);
 const audit=await f.policy.audit(f.actor,active.result.factId!);expect(JSON.stringify(audit)).not.toContain("I prefer bash");expect(audit.supports[0]).toMatchObject({kind:"automatic",validity:"deleted"});
});
it("independent same-value automatic supports preserve recall when one disappears",async()=>{
 const f=fixture(),a=await f.input("I prefer bash"),b=await f.input("我默认用 Bash");expect(b.result).toMatchObject({status:"active",factId:a.result.factId,reason:"duplicate-support"});expect(f.repo.current("scope-a")).toHaveLength(1);
 await f.registry.prepareChange(f.access,f.provider.adapter,a.s.ref);expect(await f.policy.recall(f.actor)).toHaveLength(1);expect((await f.policy.audit(f.actor,a.result.factId!)).supports).toHaveLength(2);
 await f.registry.prepareChange(f.access,f.provider.adapter,b.s.ref);expect(await f.policy.recall(f.actor)).toEqual([]);
});
it("an independently sourced explicit confirmation survives original edit but not its own deletion",async()=>{
 const f=fixture(),a=await f.input("I prefer English","history"),confirmation=await f.source("I explicitly confirm this selected preference");
 const confirmed=await f.policy.act(f.actor,await f.event("confirm",{candidateId:a.result.candidateId,revision:1,sourceRef:confirmation.ref}));
 await f.registry.prepareChange(f.access,f.provider.adapter,a.s.ref);expect(await f.policy.recall(f.actor)).toHaveLength(1);expect((await f.policy.audit(f.actor,confirmed.factId!)).supports[0]).toMatchObject({kind:"explicitUserConfirmed",sourceRef:confirmation.ref});
 await f.registry.prepareChange(f.access,f.provider.adapter,confirmation.ref);f.provider.remove(confirmation.id);await expect(f.registry.reconcile(f.access,f.provider.adapter,confirmation.id)).rejects.toThrow("MEMORY_SOURCE_DELETED");expect(await f.policy.recall(f.actor)).toEqual([]);
});
it("confirmation needs an independent live direct source; model flags cannot substitute it",async()=>{
 const f=fixture(),a=await f.input("I prefer bash","history");
 await expect(f.policy.event(f.actor,{kind:"confirm",nonce:randomUUID(),candidateId:a.result.candidateId,revision:1})).rejects.toThrow("MEMORY_INPUT_INVALID");
 await expect(f.policy.act(f.actor,await f.event("confirm",{candidateId:a.result.candidateId,revision:1,sourceRef:a.s.ref}))).rejects.toThrow("MEMORY_CONFIRMATION_NOT_INDEPENDENT");
 const model=await f.source("I confirm the selected preference","model");await expect(f.policy.act(f.actor,await f.event("confirm",{candidateId:a.result.candidateId,revision:1,sourceRef:model.ref}))).rejects.toThrow("MEMORY_EVENT_DENIED");
});
it("confirmFact adds independent support to paused current; duplicates do not manufacture independence",async()=>{
 const f=fixture(),a=await f.input("I prefer cmd"),confirmation=await f.source("This selected preference is correct");
 const input={factId:a.result.factId,revision:1,sourceRef:confirmation.ref};await f.policy.act(f.actor,await f.event("confirmFact",input));await f.policy.act(f.actor,await f.event("confirmFact",input));
 expect((await f.policy.audit(f.actor,a.result.factId!)).supports).toHaveLength(2);await f.registry.prepareChange(f.access,f.provider.adapter,a.s.ref);expect(await f.policy.recall(f.actor)).toHaveLength(1);
});
it("explicit denial enters review, never forget; a trusted correction restores new revision",async()=>{
 const f=fixture(),a=await f.input("I prefer bash"),denial=await f.source("This selected fact is incorrect");
 expect((await f.policy.act(f.actor,await f.event("deny",{factId:a.result.factId,revision:1,sourceRef:denial.ref}))).status).toBe("pending-review");expect(await f.policy.recall(f.actor)).toEqual([]);expect(f.repo.current("scope-a")).toHaveLength(1);expect(f.repo.history("scope-a",a.result.factId!)).toHaveLength(1);
 const corrected=await f.source("I prefer cmd");await f.policy.act(f.actor,await f.event("correct",{factId:a.result.factId,revision:1,sourceRef:corrected.ref}));expect((await f.policy.recall(f.actor))[0].revision).toBe(2);expect((await f.policy.audit(f.actor,a.result.factId!)).status).toBe("eligible");
});
it("forget suppresses alternative supports and late maintenance/job, no alternate-source resurrection",async()=>{
 const f=fixture(),a=await f.input("I prefer bash"),b=await f.input("我默认用 Bash");
 f.repo.jobCommand({kind:"enqueue",scopeKey:"scope-a",commandId:"support-enqueue",body:{jobId:"support-old-job",sourceRef:b.s.ref}});const lease=f.repo.jobCommand({kind:"claim",scopeKey:"scope-a",commandId:"support-claim",body:{jobId:"support-old-job",leaseMs:60000}}) as any;
 await f.policy.act(f.actor,await f.event("forget",{factId:a.result.factId,revision:1}));expect(await f.policy.recall(f.actor)).toEqual([]);expect((await f.policy.audit(f.actor,a.result.factId!)).status).toBe("forgotten");expect((await f.policy.ingest(f.actor,b.s.ref)).status).toBe("suppressed");
 expect(()=>f.repo.jobCommand({kind:"commit",scopeKey:"scope-a",commandId:"support-late",body:{jobId:"support-old-job",leaseToken:lease.leaseToken,proposals:[{candidateId:"late-support-c",evidenceId:"late-support-e",text:"I prefer bash",fact:f.repo.readRows("current_facts","scope-a")[0].payload && {subjectKey:"different-model-key",assertion:"bash",assertionKind:"user-statement",time:{validFrom:null,validTo:null,referenceTime:null}}}]}})).toThrow("MEMORY_JOB_SUPPRESSED");
});
it("stale reconciliation cannot reopen forgotten support state",async()=>{
 const f=fixture(),a=await f.input("I prefer bash");let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>started=r);
 f.setHook(async c=>{if(c.kind==="reconcileSupports"){started();await gate}});const late=f.policy.reconcileSupports(f.actor);await ready;await f.policy.act(f.actor,await f.event("forget",{factId:a.result.factId,revision:1}));release();await expect(late).rejects.toThrow("MEMORY_POLICY_SUPPRESSED");expect(await f.policy.recall(f.actor)).toEqual([]);
});
it("deleted/recreated same locator never validates old support and audit is scoped",async()=>{
 const f=fixture(),a=await f.input("I prefer bash");await f.registry.prepareChange(f.access,f.provider.adapter,a.s.ref);f.provider.remove(a.s.id);await expect(f.registry.reconcile(f.access,f.provider.adapter,a.s.id)).rejects.toThrow();f.provider.write(a.s.id,{text:"I prefer bash",role:"user",trust:"direct-user-event"});await f.registry.capture(f.access,f.provider.adapter,a.s.id);
 expect(await f.policy.recall(f.actor)).toEqual([]);await expect(f.policy.audit({},a.result.factId!)).rejects.toThrow("MEMORY_ACTOR_DENIED");expect((await f.policy.audit(f.actor,a.result.factId!)).supports[0].validity).toBe("stale");
});
it("confirmation edited after Main event issuance fails commit atomically",async()=>{
 const f=fixture(),a=await f.input("I prefer bash","history"),proof=await f.source("I confirm the selected preference"),event=await f.event("confirm",{candidateId:a.result.candidateId,revision:1,sourceRef:proof.ref});
 await f.registry.prepareChange(f.access,f.provider.adapter,proof.ref);await expect(f.policy.act(f.actor,event)).rejects.toThrow("MEMORY_SOURCE_PENDING");expect(f.repo.current("scope-a")).toEqual([]);expect((await f.policy.candidates(f.actor,{limit:10})).items).toHaveLength(1);
});
it("forget also retains denial-source suppression, never audit body",async()=>{
 const f=fixture(),a=await f.input("I prefer bash"),d=await f.source("This selected fact is incorrect");await f.policy.act(f.actor,await f.event("deny",{factId:a.result.factId,revision:1,sourceRef:d.ref}));await f.policy.act(f.actor,await f.event("forget",{factId:a.result.factId,revision:1}));
 const marker=f.repo.readRows("deletion_markers","scope-a")[0].payload as any;expect(marker.origins.some((r:any)=>r.sourceId===d.ref.sourceId)).toBe(true);
 expect(()=>f.repo.jobCommand({kind:"enqueue",scopeKey:"scope-a",commandId:"post-forget-denial",body:{jobId:"denial-resurrect",sourceRef:d.ref}})).toThrow("MEMORY_SOURCE_SUPPRESSED");expect(JSON.stringify(await f.policy.audit(f.actor,a.result.factId!))).not.toContain("This selected fact is incorrect");
});

it("an existing automatic origin cannot masquerade as independent confirmation",async()=>{
 const f=fixture(),a=await f.input("I prefer bash"),b=await f.input("我默认用 Bash");
 await expect(f.policy.act(f.actor,await f.event("confirmFact",{factId:a.result.factId,revision:1,sourceRef:b.s.ref}))).rejects.toThrow("MEMORY_CONFIRMATION_NOT_INDEPENDENT");
 expect((await f.policy.audit(f.actor,a.result.factId!)).supports).toHaveLength(2);
});

it("real v5 automatic provenance bootstraps, unverifiable legacy confirmation stays pending",async()=>{
 const f=fixture(),automatic=await f.input("I prefer bash"),candidate=await f.input("I prefer English","history");
 const confirmed=await f.policy.act(f.actor,await f.event("confirm",{candidateId:candidate.result.candidateId,revision:1}));
 f.repo.close();const db=new DatabaseSync(path.join(f.root,"memory.sqlite"));db.exec("DROP TABLE history_origins; DROP TABLE shadow_records; DROP TABLE history_records; DROP TABLE recall_records; DROP TABLE context_records; DROP TABLE fact_supports; DROP TABLE fact_reviews; PRAGMA user_version=5");db.close();f.reopen();
 expect((await f.policy.recall(f.actor)).map(r=>r.factId)).toEqual([automatic.result.factId]);
 expect((await f.policy.audit(f.actor,confirmed.factId!)).status).toBe("pending-review");expect(f.repo.current("scope-a")).toHaveLength(2);
 const proof=await f.source("I confirm the selected preference again");await f.policy.act(f.actor,await f.event("confirmFact",{factId:confirmed.factId,revision:1,sourceRef:proof.ref}));
 expect(await f.policy.recall(f.actor)).toHaveLength(2);expect(f.repo.history("scope-a",confirmed.factId!)).toHaveLength(1);
});

async function integrate(f:ReturnType<typeof fixture>,text:string,occurredAt?:number,trust="direct-user-event"){
 const s=await f.source(text,trust,"user","session-a",occurredAt);return {s,result:await f.policy.integrate(f.actor,s.ref)};
}
it("clear timed current change supersedes only the matching fact with automatic provenance",async()=>{
 const f=fixture(),a=await integrate(f,"I prefer bash",1000),b=await integrate(f,"I now prefer cmd instead of bash",2000);
 expect(b.result.items[0]).toMatchObject({status:"active",factId:a.result.items[0].factId,factRevision:2,reason:"clear-current-change"});
 const fact=(await f.policy.recall(f.actor))[0];expect(fact).toMatchObject({assertion:"I now prefer cmd instead of bash",activationReason:"policyAccepted",policyVersion:"main-maintenance-v1",time:{validFrom:2000,validTo:null,referenceTime:2000}});
 const history=f.repo.history("scope-a",fact.factId);expect(history).toHaveLength(2);expect(history[0].assertion).toBe("I prefer bash");expect(history[0].supersededAt).not.toBeNull();
 expect((await f.policy.audit(f.actor,fact.factId)).supports.map(r=>r.factRevision).sort()).toEqual([1,2]);
});
it.each([
 ["unknown-time","I now prefer cmd",undefined,1000],
 ["unknown-prior-time","I now prefer cmd",2000,undefined],
 ["out-of-order","我现在默认改用 cmd",500,1000],
 ["out-of-order","I now use cmd",1000,1000],
 ["future-effective","From 2099-01-01 I prefer cmd",2000,1000],
 ["conflict","I prefer cmd",2000,1000],
 ["change-old-mismatch","I now prefer cmd instead of PowerShell",2000,1000],
])("%s remains candidate without arrival overwrite",async(reason,text,time,prior)=>{
 const f=fixture();
 const initial=await integrate(f,"I prefer bash",prior as number|undefined);
 if(prior===undefined){
  expect(initial.result.items[0]).toMatchObject({status:"candidate",reason:"unknown-time"});
  const proof=await f.source("I confirm the selected preference","direct-user-event","user","session-a",1000);
  await f.policy.act(f.actor,await f.event("confirm",{candidateId:initial.result.items[0].candidateId,revision:1,sourceRef:proof.ref}));
 }
 const b=await integrate(f,text as string,time as number|undefined);expect(b.result.items[0]).toMatchObject({status:"candidate",reason});expect(f.repo.current("scope-a")[0].assertion).toBe("I prefer bash");
});
it("work Python, personal Rust and additive abilities coexist without replacing values",async()=>{
 const f=fixture();await integrate(f,"我工作用 Python，个人用 Rust",1000);await integrate(f,"I use Rust for work",2000);await integrate(f,"I know Python and Rust",3000);
 const recall=await f.policy.recall(f.actor);expect(recall).toHaveLength(5);expect(new Set(recall.map(r=>r.subjectKey)).size).toBe(5);expect(recall.every(r=>r.revision===1)).toBe(true);
 const duplicate=await integrate(f,"I use Python for work",4000);expect(duplicate.result.items[0].reason).toBe("duplicate-support");expect(await f.policy.recall(f.actor)).toHaveLength(5);
});
it("a work-context shell change leaves personal and default contexts intact",async()=>{
 const f=fixture();await integrate(f,"I prefer bash",1000);await integrate(f,"I use bash for work",1000);await integrate(f,"I use PowerShell personally",1000);await integrate(f,"I now use cmd for work",2000);
 const recall=await f.policy.recall(f.actor);expect(recall).toHaveLength(3);expect(recall.filter(r=>r.revision===2)).toHaveLength(1);expect(recall.filter(r=>r.revision===1)).toHaveLength(2);
});
it("explicit denial from integration enters review and preserves assertion history",async()=>{
 const f=fixture(),a=await integrate(f,"I prefer bash",1000),b=await integrate(f,"I no longer use bash",2000);expect(b.result.items[0].status).toBe("pending-review");expect(await f.policy.recall(f.actor)).toEqual([]);expect(f.repo.history("scope-a",a.result.items[0].factId!)).toHaveLength(1);
});
it("queued automatic change cannot overrule a concurrent manual correction",async()=>{
 const f=fixture();await integrate(f,"I prefer bash",1000);const s=await f.source("I now use cmd","direct-user-event","user","session-a",2000);
 let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>started=r);f.setHook(async c=>{if(c.kind==="integrate"){started();await gate}});
 const late=f.policy.integrate(f.actor,s.ref);await ready;const old=f.repo.current("scope-a")[0],proof=await f.source("I prefer PowerShell");await f.policy.act(f.actor,await f.event("correct",{factId:old.factId,revision:1,sourceRef:proof.ref}));release();expect((await late).items[0]).toMatchObject({status:"candidate",reason:"stale-base"});expect(f.repo.current("scope-a")[0].assertion).toBe("I prefer PowerShell");
});
it("queued integration loses to forget and stores no evidence",async()=>{
 const f=fixture();await integrate(f,"I prefer bash",1000);const s=await f.source("I now use cmd","direct-user-event","user","session-a",2000);
 let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>started=r);f.setHook(async c=>{if(c.kind==="integrate"){started();await gate}});const late=f.policy.integrate(f.actor,s.ref);await ready;const old=f.repo.current("scope-a")[0];await f.policy.act(f.actor,await f.event("forget",{factId:old.factId,revision:1}));const before=f.repo.readRows("evidence","scope-a").length;release();await expect(late).rejects.toThrow("MEMORY_POLICY_SUPPRESSED");expect(f.repo.readRows("evidence","scope-a")).toHaveLength(before);expect(await f.policy.recall(f.actor)).toEqual([]);
});
it("integration rejects changed source at commit and cannot use unsupported predecessor",async()=>{
 const f=fixture(),a=await integrate(f,"I prefer bash",1000);await f.registry.prepareChange(f.access,f.provider.adapter,a.s.ref);const b=await integrate(f,"I now use cmd",2000);expect(b.result.items[0]).toMatchObject({status:"candidate",reason:"prior-needs-review"});expect(f.repo.current("scope-a")[0].revision).toBe(1);
});
it("future provider occurrence cannot become active before its time",async()=>{
 const f=fixture();const b=await integrate(f,"I prefer bash",Date.now()+86400000);expect(b.result.items[0]).toMatchObject({status:"candidate",reason:"future-source"});expect(await f.policy.recall(f.actor)).toEqual([]);
});
it("secret integration is reason-only before worker body; source raw read remains manual",async()=>{
 const f=fixture(),s=await f.source("I now prefer cmd refresh_token=SECRET_CANARY_B4","direct-user-event","user","session-a",1000),commands:unknown[]=[];f.setHook(async c=>{commands.push(c)});
 expect((await f.policy.integrate(f.actor,s.ref)).items).toEqual([{status:"rejected",reason:"secret"}]);expect(JSON.stringify(commands)).not.toContain("SECRET_CANARY_B4");expect(f.repo.readRows("evidence","scope-a")).toEqual([]);expect(await f.registry.readEvidence(f.access,f.provider.adapter,s.ref)).toContain("SECRET_CANARY_B4");
});
it("occurrence edit increments source revision and invalidates old refs without guessing time",async()=>{
 const f=fixture(),a=await integrate(f,"I prefer bash",1000);await f.registry.prepareChange(f.access,f.provider.adapter,a.s.ref);f.provider.write(a.s.id,{text:"I prefer bash",role:"user",trust:"direct-user-event",occurredAt:2000});const fresh=await f.registry.reconcile(f.access,f.provider.adapter,a.s.id);expect(fresh.revision).toBeGreaterThan(a.s.ref.revision);expect(await f.policy.recall(f.actor)).toEqual([]);await expect(f.policy.integrate(f.actor,a.s.ref)).rejects.toThrow("MEMORY_SOURCE_INVALID");await expect(f.registry.readEvidence(f.access,f.provider.adapter,a.s.ref)).rejects.toThrow("MEMORY_SOURCE_STALE");
});

it.each([
 ["I prefer English","I now prefer Chinese","language"],
 ["I prefer detailed responses","我现在偏好简洁回复","response-style"],
 ["Call me Lin","Please now call me Alex 🐝","address"],
])("clear change retains same attribute: %s -> %s",async(before,after)=>{
 const f=fixture(),a=await integrate(f,before,1000),b=await integrate(f,after,2000);expect(b.result.items[0]).toMatchObject({status:"active",factId:a.result.items[0].factId,factRevision:2});expect(await f.policy.recall(f.actor)).toHaveLength(1);
});
it("concurrent clear changes admit one expected revision, no arrival overwrite",async()=>{
 const f=fixture();await integrate(f,"I prefer bash",1000);const a=await f.source("I now use cmd","direct-user-event","user","session-a",2000),b=await f.source("I now use PowerShell","direct-user-event","user","session-a",3000);
 let release!:()=>void,started!:()=>void,count=0;const gate=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>started=r);f.setHook(async c=>{if(c.kind==="integrate"){if(++count===2)started();await gate}});const pa=f.policy.integrate(f.actor,a.ref),pb=f.policy.integrate(f.actor,b.ref);await ready;release();const result=await Promise.all([pa,pb]);expect(result.flatMap(r=>r.items).filter(r=>r.reason==="clear-current-change")).toHaveLength(1);expect(result.flatMap(r=>r.items).filter(r=>r.reason==="stale-base")).toHaveLength(1);expect(f.repo.current("scope-a")[0].revision).toBe(2);
});
it("source edited during queued integration rejects every claim atomically",async()=>{
 const f=fixture(),s=await f.source("我工作用 Python，个人用 Rust","direct-user-event","user","session-a",1000);let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>started=r);f.setHook(async c=>{if(c.kind==="integrate"){started();await gate}});const late=f.policy.integrate(f.actor,s.ref);await ready;await f.registry.prepareChange(f.access,f.provider.adapter,s.ref);release();await expect(late).rejects.toThrow("MEMORY_SOURCE_PENDING");expect(f.repo.current("scope-a")).toEqual([]);expect(f.repo.readRows("evidence","scope-a")).toEqual([]);
});

it.each(["integrate","ingest"] as const)("queued same-value %s cannot support a later manual revision",async method=>{
 const f=fixture();await integrate(f,"I prefer bash",1000);const s=await f.source(method==="integrate"?"I now use cmd":"I prefer cmd","direct-user-event","user","session-a",2000);
 let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>started=r);f.setHook(async c=>{if(c.kind===method){started();await gate}});const late=f.policy[method](f.actor,s.ref);await ready;const old=f.repo.current("scope-a")[0],proof=await f.source("I prefer cmd");await f.policy.act(f.actor,await f.event("correct",{factId:old.factId,revision:1,sourceRef:proof.ref}));release();const result=await late,items="items" in result?result.items:[result];expect(items[0]).toMatchObject({status:"candidate",reason:"stale-base"});
 await f.registry.prepareChange(f.access,f.provider.adapter,proof.ref);expect(await f.policy.recall(f.actor)).toEqual([]);expect((await f.policy.audit(f.actor,old.factId)).supports.filter(r=>r.factRevision===2)).toHaveLength(1);
});
it.each([undefined,500,1000])("same-value clear change cannot bypass time requirement: %s",async time=>{
 const f=fixture();await integrate(f,"I prefer bash",1000);const b=await integrate(f,"I now use bash",time);expect(b.result.items[0]).toMatchObject({status:"candidate",reason:time===undefined?"unknown-time":"out-of-order"});expect((await f.policy.audit(f.actor,f.repo.current("scope-a")[0].factId)).supports).toHaveLength(1);
});

it("manual correction retains known provider time and never invents a recording-time reference",async()=>{
 const f=fixture();await integrate(f,"I prefer bash",1000);const old=f.repo.current("scope-a")[0],proof=await f.source("I prefer cmd","direct-user-event","user","session-a",2000);await f.policy.act(f.actor,await f.event("correct",{factId:old.factId,revision:1,sourceRef:proof.ref}));expect(f.repo.current("scope-a")[0].time).toEqual({validFrom:null,validTo:null,referenceTime:2000});
});
it("Main capabilities and full-source binding remain mandatory for integration",async()=>{
 const f=fixture(),s=await f.source("I prefer bash","direct-user-event","user","session-a",1000);await expect(f.policy.integrate({},s.ref)).rejects.toThrow("MEMORY_ACTOR_DENIED");await expect(f.policy.integrate(f.actor,{...s.ref,span:{start:0,end:4}})).rejects.toThrow("MEMORY_POLICY_FULL_SOURCE_REQUIRED");await expect(f.policy.integrate(f.actor,{...s.ref,binding:{...s.ref.binding,sessionId:"other"}})).rejects.toThrow("MEMORY_ACTOR_DENIED");expect(f.repo.current("scope-a")).toEqual([]);
});
it("worker re-parses claims and refuses forged attribute, context or subject payload",async()=>{
 const f=fixture(),s=await f.source("I use Python for work","direct-user-event","user","session-a",1000);f.setHook(async c=>{if(c.kind==="integrate")c.body.extraction.claims[0].context="personal"});await expect(f.policy.integrate(f.actor,s.ref)).rejects.toThrow("MEMORY_INPUT_INVALID");expect(f.repo.current("scope-a")).toEqual([]);expect(f.repo.readRows("evidence","scope-a")).toEqual([]);
});

it.each(["ingest","integrate"] as const)("%s receipt survives new Main factory and never attaches old source to a new revision",async method=>{
 const f=fixture(),s=await f.source("I prefer bash","direct-user-event","user","session-a",1000),first=await f.policy[method](f.actor,s.ref);const fact=f.repo.current("scope-a")[0],proof=await f.source("I prefer cmd","direct-user-event","user","session-a",2000);await f.policy.act(f.actor,await f.event("correct",{factId:fact.factId,revision:1,sourceRef:proof.ref}));f.reopen();
 const fresh=createMainPolicy({registry:f.registry,transport:f.transport,resolveActor:()=>"opaque-human-a"}),actor=fresh.bindActor(f.access,f.provider.adapter,{providerId:"synthetic",sessionId:"session-a",messageId:"rebound"});expect(await fresh[method](actor,s.ref)).toEqual(first);expect((await fresh.audit(actor,fact.factId)).supports.filter(r=>r.factRevision===2)).toHaveLength(1);expect(f.repo.current("scope-a")[0].revision).toBe(2);
});

it("future occurrence stays candidate even through confirmation until its occurrence is current",async()=>{
 const f=fixture(),a=await integrate(f,"I prefer bash",Date.now()+86400000),proof=await f.source("I confirm the selected preference");await expect(f.policy.act(f.actor,await f.event("confirm",{candidateId:a.result.items[0].candidateId,revision:1,sourceRef:proof.ref}))).rejects.toThrow("MEMORY_POLICY_FUTURE");expect(await f.policy.recall(f.actor)).toEqual([]);
});
it("multi-claim transaction fault rolls back every fact, support and evidence; retry/reopen recovers",async()=>{
 let armed=false;const f=fixture(stage=>{if(armed&&stage==="before-receipt"){expect(f.repo.current("scope-a")).toHaveLength(2);throw new Error("INJECTED_MULTI_FAULT")}}),s=await f.source("我工作用 Python，个人用 Rust","direct-user-event","user","session-a",1000);f.setHook(async c=>{if(c.kind==="integrate")armed=true});await expect(f.policy.integrate(f.actor,s.ref)).rejects.toThrow("INJECTED_MULTI_FAULT");expect(f.repo.current("scope-a")).toEqual([]);expect(f.repo.readRows("evidence","scope-a")).toEqual([]);expect(f.repo.readRows("candidates","scope-a")).toEqual([]);armed=false;f.setHook(undefined);const first=await f.policy.integrate(f.actor,s.ref);expect(first.items).toHaveLength(2);f.reopen();expect(await f.policy.recall(f.actor)).toHaveLength(2);expect(await f.policy.integrate(f.actor,s.ref)).toEqual(first);
});

it("old ingest cannot activate or confirm a future occurrence",async()=>{
 const f=fixture(),s=await f.source("I prefer bash","direct-user-event","user","session-a",Date.now()+86400000),candidate=await f.policy.ingest(f.actor,s.ref);expect(candidate).toMatchObject({status:"candidate",reason:"future-source"});const proof=await f.source("I confirm this selected preference");await expect(f.policy.act(f.actor,await f.event("confirm",{candidateId:candidate.candidateId,revision:1,sourceRef:proof.ref}))).rejects.toThrow("MEMORY_POLICY_FUTURE");expect(await f.policy.recall(f.actor)).toEqual([]);
});
it.each(["confirmFact","deny"])("a future source cannot authorize %s on a current fact",async kind=>{
 const f=fixture(),a=await f.input("I prefer bash"),proof=await f.source("This selected preference is correct","direct-user-event","user","session-a",Date.now()+86400000);await expect(f.policy.act(f.actor,await f.event(kind,{factId:a.result.factId,revision:1,sourceRef:proof.ref}))).rejects.toThrow("MEMORY_POLICY_FUTURE");expect((await f.policy.audit(f.actor,a.result.factId!)).supports).toHaveLength(1);expect((await f.policy.audit(f.actor,a.result.factId!)).reviews).toEqual([]);
});
it("old ingest future same-value source cannot preserve recall after original becomes pending",async()=>{
 const f=fixture(),a=await f.input("I prefer bash"),s=await f.source("I prefer bash","direct-user-event","user","session-a",Date.now()+86400000);expect(await f.policy.ingest(f.actor,s.ref)).toMatchObject({status:"candidate",reason:"future-source"});await f.registry.prepareChange(f.access,f.provider.adapter,a.s.ref);expect(await f.policy.recall(f.actor)).toEqual([]);
});

it("future confirmation proof rolls back candidate activation",async()=>{
 const f=fixture(),a=await f.input("I prefer bash","history"),proof=await f.source("I confirm this preference","direct-user-event","user","session-a",Date.now()+86400000);await expect(f.policy.act(f.actor,await f.event("confirm",{candidateId:a.result.candidateId,revision:1,sourceRef:proof.ref}))).rejects.toThrow("MEMORY_POLICY_FUTURE");expect(f.repo.current("scope-a")).toEqual([]);expect((await f.policy.candidates(f.actor,{limit:10})).items).toHaveLength(1);
});
it("future manual correction and remember roll back revisions and suppression advancement",async()=>{
 const f=fixture(),a=await f.input("I prefer bash"),future=await f.source("I prefer cmd","direct-user-event","user","session-a",Date.now()+86400000);await expect(f.policy.act(f.actor,await f.event("correct",{factId:a.result.factId,revision:1,sourceRef:future.ref}))).rejects.toThrow("MEMORY_POLICY_FUTURE");expect(f.repo.current("scope-a")[0].revision).toBe(1);
 await f.policy.act(f.actor,await f.event("forget",{factId:a.result.factId,revision:1}));const fresh=await f.source("I prefer cmd","direct-user-event","user","session-a",Date.now()+86400000);await expect(f.policy.act(f.actor,await f.event("remember",{sourceRef:fresh.ref}))).rejects.toThrow("MEMORY_POLICY_FUTURE");expect(f.repo.current("scope-a")).toEqual([]);const current=await f.source("I prefer cmd");expect(await f.policy.act(f.actor,await f.event("remember",{sourceRef:current.ref}))).toMatchObject({status:"active"});expect(await f.policy.recall(f.actor)).toHaveLength(1);
});

it("revise cannot erase future source time then activate through live confirmation",async()=>{
 const f=fixture(),s=await f.source("I prefer bash","direct-user-event","user","session-a",Date.now()+86400000),candidate=await f.policy.ingest(f.actor,s.ref);const revised=await f.policy.act(f.actor,await f.event("revise",{candidateId:candidate.candidateId,revision:1,sourceRef:s.ref})),proof=await f.source("I confirm this preference");expect(revised.candidateRevision).toBe(2);await expect(f.policy.act(f.actor,await f.event("confirm",{candidateId:candidate.candidateId,revision:2,sourceRef:proof.ref}))).rejects.toThrow("MEMORY_POLICY_FUTURE");expect(f.repo.current("scope-a")).toEqual([]);
});

it.each(["ingest","integrate"] as const)("temporary Main actor cannot %s into persistent policy or leave side effects",async method=>{
 const f=fixture(),source=await f.source("I prefer bash");
 const actorAuthority=createMainActorAuthority({resolveActor:()=>"opaque-human-a"});
 const policy=createMainPolicy({registry:f.registry,transport:f.transport,resolveActor:()=>"opaque-human-a",actorAuthority});
 const actor=actorAuthority.bindActor(f.access,f.provider.adapter,source.id,{sessionMode:"temporary"});
 const commands:unknown[]=[];f.setHook(async command=>{commands.push(command)});
 const files=fs.readdirSync(f.root).filter(name=>name.startsWith("memory.sqlite"));
 const snapshot=()=>files.map(name=>({name,digest:createHash("sha256").update(fs.readFileSync(path.join(f.root,name))).digest("hex")}));
 const before=snapshot();
 let evidenceReads=0;f.provider.afterNextRead=()=>{evidenceReads++};
 const result=await policy[method](actor,source.ref).then(value=>({value}),error=>({error:error.message}));
 expect(result).toEqual({error:"MEMORY_POLICY_TEMPORARY_UNSUPPORTED"});
 expect(commands).toEqual([]);
 expect(snapshot()).toEqual(before);
 expect(evidenceReads).toBe(0);
 expect(f.repo.current("scope-a")).toEqual([]);
 expect(f.repo.readRows("evidence","scope-a")).toEqual([]);
 expect(f.repo.readRows("candidates","scope-a")).toEqual([]);
 f.reopen();expect(f.repo.current("scope-a")).toEqual([]);
});
