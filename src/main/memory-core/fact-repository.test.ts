import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {randomBytes,createHash} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import {afterEach,it,expect} from "vitest";
import {openMemoryRepository} from "./repository";
import {createMainMemoryAuthority,type VerifiedSource} from "./main-access";
import {MemoryService} from "./memory-service";
import type {SourceRef,FactDraft} from "../../shared/memory-contracts";
const dirs:string[]=[],repos:any[]=[];
afterEach(()=>{for(const repo of repos.splice(0))repo.close();for(const dir of dirs.splice(0))fs.rmSync(dir,{recursive:true,force:true})});
const initial:FactDraft={subjectKey:"合成语言偏好",assertion:"我偏好中文，也使用 English 🌱",assertionKind:"user-statement",time:{validFrom:null,validTo:null,referenceTime:null}};
function fixture(fault?:(stage:"after-record"|"before-receipt")=>void){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"memory-facts-"));dirs.push(root);
 const repository=openMemoryRepository({databasePath:path.join(root,"memory.sqlite"),key:randomBytes(32),fault});repos.push(repository);
 const sources=new Map<string,VerifiedSource>(),ref={sourceId:"source-a",revision:1};
 sources.set(ref.sourceId,{...ref,scopeKey:"scope-a",kind:"user",intent:"statement",policyEligibility:{directStatement:true,inferred:false,sensitive:false,conflict:false}});
 const authority=createMainMemoryAuthority({policyVersion:"policy-v1",resolveSource:r=>sources.get(r.sourceId)!}),access=authority.access("scope-a");
 const service=new MemoryService({execute:async command=>repository.execute(command),current:async scope=>repository.current(scope),history:async(scope,id)=>repository.history(scope,id)});
 async function candidate(id="candidate-a",fact:FactDraft=initial){
  await service.registerSource(access,"register-"+id,ref);
  await service.appendEvidence(access,{commandId:"evidence-"+id,evidenceId:"evidence-"+id,sourceRef:ref,text:"合成用户陈述"});
  await service.proposeCandidate(access,{commandId:"propose-"+id,candidateId:id,evidenceId:"evidence-"+id,fact});return id;
 }
 async function active(){
  const id=await candidate(),token=authority.authorize(access,{candidateId:id,sourceRef:ref,reason:"policyAccepted"});
  return service.activateCandidate(access,token,{commandId:"activate-"+id,candidateId:id});
 }
 async function event(factId:string,intent:"correction"|"forget",scopeKey="scope-a"){
  const sourceRef={sourceId:"source-"+intent+"-"+scopeKey,revision:1},a=scopeKey==="scope-a"?access:authority.access(scopeKey);
  sources.set(sourceRef.sourceId,{...sourceRef,scopeKey,kind:"user",intent,factId});
  await service.registerSource(a,"register-"+sourceRef.sourceId,sourceRef);return{sourceRef,access:a};
 }
 return{root,repository,service,sources,authority,access,ref,candidate,active,event};
}
it("activates only after trusted Main authorization and preserves bilingual text and unknown time",async()=>{
 const f=fixture();await f.candidate();expect(await f.service.current(f.access)).toEqual([]);
 const token=f.authority.authorize(f.access,{candidateId:"candidate-a",sourceRef:f.ref,reason:"policyAccepted"});
 const result=await f.service.activateCandidate(f.access,token,{commandId:"activate",candidateId:"candidate-a"});
 const current=await f.service.current(f.access);expect(current).toHaveLength(1);
 expect(current[0]).toMatchObject({...initial,factId:result.id,revision:1,activationReason:"policyAccepted",policyVersion:"policy-v1",supersededAt:null});
 expect(current[0].recordedAt).toBeGreaterThan(0);expect(current[0].acceptedAt).toBeGreaterThan(0);
});
it("appends correction and supersession without overwriting old ciphertext",async()=>{
 const f=fixture(),active=await f.active(),event=await f.event(active.id,"correction");
 const db=new DatabaseSync(path.join(f.root,"memory.sqlite"),{readOnly:true});
 const originals=db.prepare("SELECT id,payload FROM fact_revisions").all();db.close();
 const changed={...initial,assertion:"现在偏好 English 和中文混合",time:{validFrom:100,validTo:200,referenceTime:null}};
 expect(await f.service.correctFact(f.access,{commandId:"correct",factId:active.id,expectedRevision:1,sourceRef:event.sourceRef,fact:changed})).toEqual({id:active.id,revision:2});
 expect((await f.service.current(f.access))[0]).toMatchObject({...changed,revision:2});
 const history=await f.service.history(f.access,active.id);expect(history.map(r=>r.revision)).toEqual([1,2]);expect(history[0].supersededAt).not.toBeNull();expect(history[1].supersededAt).toBeNull();
 const reopened=new DatabaseSync(path.join(f.root,"memory.sqlite"),{readOnly:true});
 try{for(const row of originals)expect(reopened.prepare("SELECT payload FROM fact_revisions WHERE id=?").get(row.id as string)?.payload).toEqual(row.payload)}finally{reopened.close()}
});
it("rolls back revision, projection, invalidation and receipt as one transaction",async()=>{
 let armed=false;const f=fixture(stage=>{if(armed&&stage==="before-receipt")throw new Error("INJECTED")}),active=await f.active(),event=await f.event(active.id,"correction");
 const input={commandId:"faulted-correct",factId:active.id,expectedRevision:1,sourceRef:event.sourceRef,fact:{...initial,assertion:"新的合成陈述"}};
 const indexBefore=f.repository.readRows("index_state","scope-a");armed=true;
 await expect(f.service.correctFact(f.access,input)).rejects.toThrow("INJECTED");
 expect((await f.service.current(f.access))[0].revision).toBe(1);expect(await f.service.history(f.access,active.id)).toHaveLength(1);expect(f.repository.readRows("index_state","scope-a")).toEqual(indexBefore);
 armed=false;expect((await f.service.correctFact(f.access,input)).revision).toBe(2);
});
it("makes concurrent expectedRevision corrections conflict rather than last-arrival-win",async()=>{
 const f=fixture(),active=await f.active(),event=await f.event(active.id,"correction");
 const results=await Promise.allSettled(["甲","乙"].map((assertion,i)=>f.service.correctFact(f.access,{commandId:"correct-"+i,factId:active.id,expectedRevision:1,sourceRef:event.sourceRef,fact:{...initial,assertion}})));
 expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
 expect((results.find(r=>r.status==="rejected") as PromiseRejectedResult).reason.message).toBe("MEMORY_REVISION_CONFLICT");
 expect((await f.service.current(f.access))[0].revision).toBe(2);
});
it("replays a correction receipt but rejects the same commandId with different content",async()=>{
 const f=fixture(),active=await f.active(),event=await f.event(active.id,"correction");
 const input={commandId:"correct",factId:active.id,expectedRevision:1,sourceRef:event.sourceRef,fact:{...initial,assertion:"新事实"}};
 const first=await f.service.correctFact(f.access,input);expect(await f.service.correctFact(f.access,input)).toEqual(first);
 await expect(f.service.correctFact(f.access,{...input,fact:{...input.fact,assertion:"不同内容"}})).rejects.toThrow("MEMORY_COMMAND_CONFLICT");
 expect(await f.service.history(f.access,active.id)).toHaveLength(2);
});
it("refuses conflicting activation instead of replacing a current fact",async()=>{
 const f=fixture();await f.active();await f.candidate("candidate-b",{...initial,assertion:"冲突陈述"});
 const token=f.authority.authorize(f.access,{candidateId:"candidate-b",sourceRef:f.ref,reason:"policyAccepted"});
 await expect(f.service.activateCandidate(f.access,token,{commandId:"activate-conflict",candidateId:"candidate-b"})).rejects.toThrow("MEMORY_FACT_CONFLICT");
 expect((await f.service.current(f.access))[0].assertion).toBe(initial.assertion);
});
it("rejects an old candidate after source revision advances",async()=>{
 const f=fixture();await f.candidate();const source=f.sources.get(f.ref.sourceId)!;f.sources.set(f.ref.sourceId,{...source,revision:2});
 await f.service.registerSource(f.access,"source-edit",{...f.ref,revision:2});
 expect(()=>f.repository.execute({kind:"activateCandidate",scopeKey:"scope-a",commandId:"late",body:{candidateId:"candidate-a",authorization:{reason:"policyAccepted",sourceRef:f.ref,policyVersion:"policy-v1"}}})).toThrow("MEMORY_SOURCE_STALE");
 expect(await f.service.current(f.access)).toEqual([]);
});
it("filters current/history and refuses corrections across Main scopes",async()=>{
 const f=fixture(),active=await f.active(),other=await f.event(active.id,"correction","scope-b");
 expect(await f.service.current(other.access)).toEqual([]);
 await expect(f.service.history(other.access,active.id)).rejects.toThrow("MEMORY_FACT_NOT_FOUND");
 await expect(f.service.correctFact(other.access,{commandId:"cross-scope",factId:active.id,expectedRevision:1,sourceRef:other.sourceRef,fact:initial})).rejects.toThrow("MEMORY_FACT_NOT_FOUND");
 expect((await f.service.current(f.access))[0].revision).toBe(1);
});
it("stores subject indexes as opaque keyed values and no user text in DB/WAL",async()=>{
 const f=fixture();await f.active();const db=new DatabaseSync(path.join(f.root,"memory.sqlite"),{readOnly:true});
 try{const index=db.prepare("SELECT subject_index FROM current_facts").get()?.subject_index;expect(index).toBeInstanceOf(Uint8Array);expect((index as Uint8Array).length).toBe(32);expect(index).not.toEqual(createHash("sha256").update(initial.subjectKey).digest())}finally{db.close()}
 for(const name of fs.readdirSync(f.root)){const bytes=fs.readFileSync(path.join(f.root,name));expect(bytes.includes(Buffer.from(initial.subjectKey))).toBe(false);expect(bytes.includes(Buffer.from(initial.assertion))).toBe(false)}
});
it("forgets current recall without deleting immutable history or opening a forgotten history read surface",async()=>{
 const f=fixture(),active=await f.active(),event=await f.event(active.id,"forget");
 await f.service.forgetFact(f.access,{commandId:"forget",factId:active.id,expectedRevision:1,sourceRef:event.sourceRef});
 expect(await f.service.current(f.access)).toEqual([]);await expect(f.service.history(f.access,active.id)).rejects.toThrow("MEMORY_FACT_NOT_FOUND");
 expect(f.repository.readRows("fact_revisions","scope-a").length).toBeGreaterThan(1);expect(f.repository.readRows("deletion_markers","scope-a")).toHaveLength(1);
});

it("retains the trusted explicit confirmation source separately from proposed evidence",async()=>{
 const f=fixture(),candidateId=await f.candidate("candidate-inference",{...initial,assertionKind:"inference"});
 const confirmation={sourceId:"source-confirmation",revision:1};
 f.sources.set(confirmation.sourceId,{...confirmation,scopeKey:"scope-a",kind:"user",intent:"confirmation",candidateId});
 await f.service.registerSource(f.access,"register-confirmation",confirmation);
 const token=f.authority.authorize(f.access,{candidateId,sourceRef:confirmation,reason:"explicitUserConfirmed"});
 await f.service.activateCandidate(f.access,token,{commandId:"explicit-activation",candidateId});
 expect((await f.service.current(f.access))[0]).toMatchObject({sourceRef:f.ref,activationReason:"explicitUserConfirmed",policyVersion:null,provenance:{candidateId,evidenceId:"evidence-"+candidateId,activationSourceRef:confirmation}});
});

it('allows adjacent same-slot intervals but rejects overlap and correction expansion atomically',async()=>{
 const f=fixture();
 const activate=async(id:string,from:number,to:number)=>{await f.candidate(id,{...initial,time:{validFrom:from,validTo:to,referenceTime:10}});const token=f.authority.authorize(f.access,{candidateId:id,sourceRef:f.ref,reason:'policyAccepted'});return f.service.activateCandidate(f.access,token,{commandId:'activate-'+id,candidateId:id})};
 const first=await activate('period-a',100,200),second=await activate('period-b',200,300);
 expect((await f.service.current(f.access)).map(f=>f.factId).sort()).toEqual([first.id,second.id].sort());
 await expect(activate('overlap',150,250)).rejects.toThrow('MEMORY_FACT_CONFLICT');
 const event=await f.event(first.id,'correction'),before=f.repository.readRows('index_state','scope-a');
 await expect(f.service.correctFact(f.access,{commandId:'overlap-correction',factId:first.id,expectedRevision:1,sourceRef:event.sourceRef,fact:{...initial,time:{validFrom:100,validTo:201,referenceTime:10}}})).rejects.toThrow('MEMORY_FACT_CONFLICT');
 expect(await f.service.history(f.access,first.id)).toHaveLength(1);expect(f.repository.readRows('index_state','scope-a')).toEqual(before);
});

it('upgrades the slot index transactionally and restores the old unique index on interruption',async()=>{
 const f=fixture(),active=await f.active();f.repository.close();const db=new DatabaseSync(path.join(f.root,'memory.sqlite'));
 const before=db.prepare('SELECT payload FROM current_facts WHERE id=?').get(active.id)?.payload;
 db.exec("DROP TABLE history_origins; DROP INDEX current_subject_identity; CREATE UNIQUE INDEX current_subject_identity ON current_facts(scope_key,subject_index) WHERE state='active' AND subject_index IS NOT NULL; PRAGMA user_version=10");
 const databaseId=db.prepare('SELECT database_id FROM memory_metadata').get()!.database_id as string;
 const {initializeSchema}=await import('./schema');
 const interrupted={prepare:db.prepare.bind(db),exec(sql:string){if(sql.includes('DROP INDEX current_subject_identity')){db.exec('DROP INDEX current_subject_identity');throw Error('SYNTHETIC_MIGRATION_INTERRUPTION')}return db.exec(sql)}};
 expect(()=>initializeSchema(interrupted as unknown as DatabaseSync,databaseId)).toThrow('SYNTHETIC_MIGRATION_INTERRUPTION');
 expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(10);expect(db.prepare("SELECT sql FROM sqlite_master WHERE name='current_subject_identity'").get()?.sql).toContain('UNIQUE');
 initializeSchema(db,databaseId);expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(12);
 expect(db.prepare('SELECT payload FROM current_facts WHERE id=?').get(active.id)?.payload).toEqual(before);db.close();
});
