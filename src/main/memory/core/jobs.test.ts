import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {randomBytes} from "node:crypto";
import {afterEach,it,expect} from "vitest";
import {openMemoryRepository} from "./repository";
import {createMainMemoryAuthority,type VerifiedSource} from "./main-access";
import {MemoryService} from "./memory-service";
const dirs:string[]=[],repos:any[]=[];
afterEach(()=>{for(const repository of repos.splice(0))repository.close();for(const root of dirs.splice(0))fs.rmSync(root,{recursive:true,force:true})});
const fact={subjectKey:"合成主题",assertion:"中文 English 🌱",assertionKind:"user-statement" as const,time:{validFrom:null,validTo:null,referenceTime:null}};
const proposal=(id:string)=>({candidateId:"candidate-"+id,evidenceId:"evidence-"+id,text:"合成提取",fact});
async function fixture(fault?:(stage:"after-record"|"before-receipt")=>void){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"memory-jobs-"));dirs.push(root);let now=10000;
 const key=randomBytes(32),repository=openMemoryRepository({databasePath:path.join(root,"memory.sqlite"),key,fault,clock:()=>now});repos.push(repository);
 const ref={sourceId:"source-a",revision:1},sources=new Map<string,VerifiedSource>();
 sources.set(ref.sourceId,{...ref,scopeKey:"scope-a",kind:"user",intent:"statement",policyEligibility:{directStatement:true,inferred:false,sensitive:false,conflict:false}});
 const authority=createMainMemoryAuthority({policyVersion:"policy-v1",resolveSource:r=>sources.get(r.sourceId)!}),access=authority.access("scope-a");
 const service=new MemoryService({execute:async command=>repository.execute(command),current:async scope=>repository.current(scope),history:async(scope,id)=>repository.history(scope,id),jobCommand:async command=>repository.jobCommand(command)});
 await service.registerSource(access,"register",ref);
 async function active(){
  await service.appendEvidence(access,{commandId:"evidence-active",evidenceId:"evidence-active",sourceRef:ref,text:"合成用户来源"});
  await service.proposeCandidate(access,{commandId:"propose-active",candidateId:"candidate-active",evidenceId:"evidence-active",fact});
  const token=authority.authorize(access,{candidateId:"candidate-active",sourceRef:ref,reason:"policyAccepted"});
  return service.activateCandidate(access,token,{commandId:"activate",candidateId:"candidate-active"});
 }
 async function forget(factId:string){
  const event={sourceId:"forget-event",revision:1};sources.set(event.sourceId,{...event,scopeKey:"scope-a",kind:"user",intent:"forget",factId});
  await service.registerSource(access,"register-forget",event);
  return service.forgetFact(access,{commandId:"forget",factId,expectedRevision:1,sourceRef:event});
 }
 return{root,key,repository,service,sources,authority,access,ref,active,forget,setNow:(value:number)=>{now=value}};
}
it("commits a leased result as candidates and replays without duplicating records",async()=>{
 const f=await fixture();await f.service.enqueueJob(f.access,{commandId:"enqueue",jobId:"job-a",sourceRef:f.ref});
 const lease=await f.service.claimJob(f.access,{commandId:"claim",jobId:"job-a",leaseMs:1000});
 const input={commandId:"commit",jobId:"job-a",leaseToken:lease.leaseToken,proposals:[proposal("job-a")]};
 const first=await f.service.commitJobResult(f.access,input);expect(await f.service.commitJobResult(f.access,input)).toEqual(first);
 expect(f.repository.readRows("candidates","scope-a")).toHaveLength(1);expect(await f.service.current(f.access)).toEqual([]);
});
it("refuses both queued and running old jobs immediately after forget",async()=>{
 const f=await fixture(),active=await f.active();
 for(const id of ["queued","running"])await f.service.enqueueJob(f.access,{commandId:"enqueue-"+id,jobId:id,sourceRef:f.ref});
 const lease=await f.service.claimJob(f.access,{commandId:"claim",jobId:"running",leaseMs:1000});await f.forget(active.id);
 expect(await f.service.current(f.access)).toEqual([]);
 await expect(f.service.claimJob(f.access,{commandId:"claim-queued",jobId:"queued",leaseMs:1000})).rejects.toThrow("MEMORY_JOB_SUPPRESSED");
 await expect(f.service.commitJobResult(f.access,{commandId:"late",jobId:"running",leaseToken:lease.leaseToken,proposals:[proposal("late")]})).rejects.toThrow("MEMORY_JOB_SUPPRESSED");
 expect(f.repository.readRows("candidates","scope-a")).toHaveLength(1);
 await expect(f.service.enqueueJob(f.access,{commandId:"new-old-source",jobId:"old-source-again",sourceRef:f.ref})).rejects.toThrow("MEMORY_SOURCE_SUPPRESSED");
});
it("rejects extraction from an edited source instead of accepting a late result",async()=>{
 const f=await fixture();await f.service.enqueueJob(f.access,{commandId:"enqueue",jobId:"job-a",sourceRef:f.ref});
 const lease=await f.service.claimJob(f.access,{commandId:"claim",jobId:"job-a",leaseMs:1000});
 const source=f.sources.get(f.ref.sourceId)!;f.sources.set(f.ref.sourceId,{...source,revision:2});
 await f.service.registerSource(f.access,"source-edit",{...f.ref,revision:2});
 await expect(f.service.commitJobResult(f.access,{commandId:"late",jobId:"job-a",leaseToken:lease.leaseToken,proposals:[proposal("late")]})).rejects.toThrow("MEMORY_JOB_SOURCE_STALE");
 expect(f.repository.readRows("candidates","scope-a")).toEqual([]);
});
it("expires a lease at its half-open endpoint and only accepts a newly claimed token",async()=>{
 const f=await fixture();await f.service.enqueueJob(f.access,{commandId:"enqueue",jobId:"job-a",sourceRef:f.ref});
 const old=await f.service.claimJob(f.access,{commandId:"claim",jobId:"job-a",leaseMs:1000});
 f.setNow(old.leaseExpiresAt);
 await expect(f.service.commitJobResult(f.access,{commandId:"expired",jobId:"job-a",leaseToken:old.leaseToken,proposals:[proposal("old")]})).rejects.toThrow("MEMORY_JOB_LEASE_INVALID");
 const current=await f.service.claimJob(f.access,{commandId:"reclaim",jobId:"job-a",leaseMs:1000});expect(current.leaseToken).not.toBe(old.leaseToken);
 await expect(f.service.commitJobResult(f.access,{commandId:"old-token",jobId:"job-a",leaseToken:old.leaseToken,proposals:[proposal("old")]})).rejects.toThrow("MEMORY_JOB_LEASE_INVALID");
 await f.service.commitJobResult(f.access,{commandId:"commit",jobId:"job-a",leaseToken:current.leaseToken,proposals:[proposal("current")]});
 expect(f.repository.readRows("candidates","scope-a")).toHaveLength(1);
});
it("makes competing claims exclusive and rejects changed command replays",async()=>{
 const f=await fixture();await f.service.enqueueJob(f.access,{commandId:"enqueue",jobId:"job-a",sourceRef:f.ref});
 const result=await Promise.allSettled([0,1].map(id=>f.service.claimJob(f.access,{commandId:"claim-"+id,jobId:"job-a",leaseMs:1000})));
 expect(result.filter(r=>r.status==="fulfilled")).toHaveLength(1);expect((result.find(r=>r.status==="rejected") as PromiseRejectedResult).reason.message).toBe("MEMORY_JOB_BUSY");
 await expect(f.service.enqueueJob(f.access,{commandId:"enqueue",jobId:"job-b",sourceRef:f.ref})).rejects.toThrow("MEMORY_COMMAND_CONFLICT");
});
it("keeps old jobs invalid after a new trusted remember event and preserves tombstones",async()=>{
 const f=await fixture(),active=await f.active();await f.service.enqueueJob(f.access,{commandId:"enqueue",jobId:"old-job",sourceRef:f.ref});
 const old=await f.service.claimJob(f.access,{commandId:"claim",jobId:"old-job",leaseMs:1000});await f.forget(active.id);
 const remember={sourceId:"remember-event",revision:1};f.sources.set(remember.sourceId,{...remember,scopeKey:"scope-a",kind:"user",intent:"remember",candidateId:"candidate-remember"});
 await f.service.registerSource(f.access,"register-remember",remember);
 await f.service.appendEvidence(f.access,{commandId:"evidence-remember",evidenceId:"evidence-remember",sourceRef:remember,text:"新的可信用户事件"});
 await f.service.proposeCandidate(f.access,{commandId:"propose-remember",candidateId:"candidate-remember",evidenceId:"evidence-remember",fact});
 const token=f.authority.authorize(f.access,{candidateId:"candidate-remember",sourceRef:remember,reason:"explicitUserConfirmed"});
 await f.service.activateCandidate(f.access,token,{commandId:"remember",candidateId:"candidate-remember"});
 expect(await f.service.current(f.access)).toHaveLength(1);expect(f.repository.readRows("deletion_markers","scope-a")).toHaveLength(1);
 await expect(f.service.commitJobResult(f.access,{commandId:"old-job-after-remember",jobId:"old-job",leaseToken:old.leaseToken,proposals:[proposal("late")]})).rejects.toThrow("MEMORY_JOB_SUPPRESSED");
 await f.service.enqueueJob(f.access,{commandId:"enqueue-new",jobId:"new-job",sourceRef:remember});
 const next=await f.service.claimJob(f.access,{commandId:"claim-new",jobId:"new-job",leaseMs:1000});expect(next.suppressionGeneration).toBeGreaterThan(old.suppressionGeneration);
});
it("does not let ordinary confirmation or policy acceptance resurrect a forgotten subject",async()=>{
 const f=await fixture(),active=await f.active();await f.forget(active.id);
 const ref={sourceId:"new-statement",revision:1};f.sources.set(ref.sourceId,{...ref,scopeKey:"scope-a",kind:"user",intent:"statement",policyEligibility:{directStatement:true,inferred:false,sensitive:false,conflict:false}});
 await f.service.registerSource(f.access,"register-new",ref);await f.service.appendEvidence(f.access,{commandId:"evidence-new",evidenceId:"evidence-new",sourceRef:ref,text:"新来源"});
 await f.service.proposeCandidate(f.access,{commandId:"propose-new",candidateId:"candidate-new",evidenceId:"evidence-new",fact});
 const token=f.authority.authorize(f.access,{candidateId:"candidate-new",sourceRef:ref,reason:"policyAccepted"});
 await expect(f.service.activateCandidate(f.access,token,{commandId:"unauthorized-remember",candidateId:"candidate-new"})).rejects.toThrow("MEMORY_SUBJECT_SUPPRESSED");
 expect(await f.service.current(f.access)).toEqual([]);
});
it("rolls back partial job proposals and the receipt together",async()=>{
 let armed=false;const f=await fixture(stage=>{if(armed&&stage==="before-receipt")throw new Error("INJECTED")});
 await f.service.enqueueJob(f.access,{commandId:"enqueue",jobId:"job-a",sourceRef:f.ref});const lease=await f.service.claimJob(f.access,{commandId:"claim",jobId:"job-a",leaseMs:1000});
 const input={commandId:"commit",jobId:"job-a",leaseToken:lease.leaseToken,proposals:[proposal("a"),proposal("b")]};armed=true;
 await expect(f.service.commitJobResult(f.access,input)).rejects.toThrow("INJECTED");expect(f.repository.readRows("candidates","scope-a")).toEqual([]);expect(f.repository.readRows("evidence","scope-a")).toEqual([]);
 armed=false;await f.service.commitJobResult(f.access,input);expect(f.repository.readRows("candidates","scope-a")).toHaveLength(2);
});
it("rejects serialized Main capabilities, cross-scope jobs and model confirmation fields",async()=>{
 const f=await fixture();await expect(f.service.enqueueJob({scopeKey:"scope-a"},{commandId:"enqueue",jobId:"job-a",sourceRef:f.ref})).rejects.toThrow("MEMORY_ACCESS_DENIED");
 await f.service.enqueueJob(f.access,{commandId:"enqueue",jobId:"job-a",sourceRef:f.ref});
 await expect(f.service.claimJob(f.authority.access("scope-b"),{commandId:"cross",jobId:"job-a",leaseMs:1000})).rejects.toThrow("MEMORY_JOB_NOT_FOUND");
 const lease=await f.service.claimJob(f.access,{commandId:"claim",jobId:"job-a",leaseMs:1000});
 await expect(f.service.commitJobResult(f.access,{commandId:"fake-confirmed",jobId:"job-a",leaseToken:lease.leaseToken,proposals:[{...proposal("a"),userConfirmed:true}]} as any)).rejects.toThrow("MEMORY_INPUT_INVALID");
 expect(f.repository.readRows("candidates","scope-a")).toEqual([]);
});

it("rejects ordinary explicit confirmation after forget, not just policy acceptance",async()=>{
 const f=await fixture(),active=await f.active();await f.forget(active.id);
 const ref={sourceId:"fresh-source",revision:1},candidateId="fresh-candidate";
 f.sources.set(ref.sourceId,{...ref,scopeKey:"scope-a",kind:"user",intent:"statement"});
 await f.service.registerSource(f.access,"register-fresh",ref);
 await f.service.appendEvidence(f.access,{commandId:"fresh-e",evidenceId:"fresh-e",sourceRef:ref,text:"synthetic fresh statement"});
 await f.service.proposeCandidate(f.access,{commandId:"fresh-c",candidateId,evidenceId:"fresh-e",fact});
 const confirmation={sourceId:"confirmation",revision:1};
 f.sources.set(confirmation.sourceId,{...confirmation,scopeKey:"scope-a",kind:"user",intent:"confirmation",candidateId});
 await f.service.registerSource(f.access,"register-confirmation",confirmation);
 const token=f.authority.authorize(f.access,{candidateId,sourceRef:confirmation,reason:"explicitUserConfirmed"});
 await expect(f.service.activateCandidate(f.access,token,{commandId:"ordinary-confirmation",candidateId})).rejects.toThrow("MEMORY_SUBJECT_SUPPRESSED");
});
it("does not mutate trusted source intent in an already registered revision",async()=>{
 const f=await fixture(),source=f.sources.get(f.ref.sourceId)!;
 f.sources.set(f.ref.sourceId,{...source,intent:"remember",candidateId:"target"});
 await expect(f.service.registerSource(f.access,"mutated-source",f.ref)).rejects.toThrow("MEMORY_SOURCE_INVALID");
});
it("retains every assertion and activation source in the forget barrier after correction",async()=>{
 const f=await fixture(),active=await f.active(),correction={sourceId:"correction-event",revision:1};
 f.sources.set(correction.sourceId,{...correction,scopeKey:"scope-a",kind:"user",intent:"correction",factId:active.id});
 await f.service.registerSource(f.access,"register-correction",correction);
 await f.service.correctFact(f.access,{commandId:"correct",factId:active.id,expectedRevision:1,sourceRef:correction,fact:{...fact,assertion:"synthetic correction"}});
 const event={sourceId:"forget-event",revision:1};
 f.sources.set(event.sourceId,{...event,scopeKey:"scope-a",kind:"user",intent:"forget",factId:active.id});
 await f.service.registerSource(f.access,"register-forget",event);
 await f.service.forgetFact(f.access,{commandId:"forget-revision2",factId:active.id,expectedRevision:2,sourceRef:event});
 for(const ref of [f.ref,correction])await expect(f.service.enqueueJob(f.access,{commandId:"late-"+ref.sourceId,jobId:"job-"+ref.sourceId,sourceRef:ref})).rejects.toThrow("MEMORY_SOURCE_SUPPRESSED");
});
it("rolls back a forget barrier and generation together when its receipt fails",async()=>{
 let armed=false;const f=await fixture(stage=>{if(armed&&stage==="before-receipt")throw new Error("INJECTED")}),active=await f.active();
 await f.service.enqueueJob(f.access,{commandId:"enqueue",jobId:"job-a",sourceRef:f.ref});
 const lease=await f.service.claimJob(f.access,{commandId:"claim",jobId:"job-a",leaseMs:1000});
 const event={sourceId:"forget-event",revision:1};f.sources.set(event.sourceId,{...event,scopeKey:"scope-a",kind:"user",intent:"forget",factId:active.id});
 await f.service.registerSource(f.access,"register-forget",event);
 armed=true;await expect(f.service.forgetFact(f.access,{commandId:"failed-forget",factId:active.id,expectedRevision:1,sourceRef:event})).rejects.toThrow("INJECTED");
 expect(f.repository.readRows("deletion_markers","scope-a")).toEqual([]);expect(await f.service.current(f.access)).toHaveLength(1);
 armed=false;await f.service.commitJobResult(f.access,{commandId:"commit-after-rollback",jobId:"job-a",leaseToken:lease.leaseToken,proposals:[proposal("after-rollback")]});
});
it("rejects a late result after close and reopen with the durable barrier intact",async()=>{
 const f=await fixture(),active=await f.active();
 await f.service.enqueueJob(f.access,{commandId:"enqueue",jobId:"job-a",sourceRef:f.ref});
 const lease=await f.service.claimJob(f.access,{commandId:"claim",jobId:"job-a",leaseMs:1000});await f.forget(active.id);f.repository.close();
 const reopened=openMemoryRepository({databasePath:path.join(f.root,"memory.sqlite"),key:f.key,clock:()=>10000});repos.push(reopened);
 expect(()=>reopened.jobCommand({kind:"commit",scopeKey:"scope-a",commandId:"late-reopen",body:{jobId:"job-a",leaseToken:lease.leaseToken,proposals:[proposal("reopen")]}})).toThrow("MEMORY_JOB_SUPPRESSED");
 expect(reopened.current("scope-a")).toEqual([]);expect(reopened.readRows("deletion_markers","scope-a")).toHaveLength(1);
});
