import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {afterEach,expect,it} from "vitest";
import {createSmhFixture} from "../memory-context/smh-fixture.test-support";
import type {ShadowModel} from "../memory-shadow/shadow-model-call";
const now=Date.parse("2026-03-09T12:00:00Z"),owned:ReturnType<typeof createSmhFixture>[]=[];
afterEach(()=>{for(const f of owned.splice(0)){f.close();fs.rmSync(f.root,{recursive:true,force:true})}});
function fixture(){const f=createSmhFixture(fs.mkdtempSync(path.join(os.tmpdir(),"temporal-memory-")),{clock:()=>now,includeFactSupportMetadata:true});owned.push(f);return f}
async function candidate(f:ReturnType<typeof fixture>,text:string,value="English"){
 const source=await f.source(text,{occurredAt:now,timeZone:"UTC"});
 const model:ShadowModel={profile:{id:"fake",revision:1},assertCurrent(){},prepare(){return {ok:true,async send(){return {ok:true,text:JSON.stringify({facts:[{subject:"user",attribute:"language",value,polarity:"positive",status:"asserted",quote:text,reason:"direct statement"}]})}}}}};
 const result=await f.policy.extractNatural(f.actor,source.ref,model);expect(result.items).toHaveLength(1);expect(result.items[0].status).toBe("candidate");return result.items[0];
}
async function confirm(f:ReturnType<typeof fixture>,c:Awaited<ReturnType<typeof candidate>>){const proof=await f.source("Confirm this exact candidate",{occurredAt:now,timeZone:"UTC"});return f.policy.act(f.actor,await f.policy.event(f.actor,{kind:"confirm",nonce:randomUUID(),candidateId:c.candidateId,revision:c.candidateRevision,sourceRef:proof.ref}))}
it("confirms separate dated values in the same slot and preserves the selected period on correction",async()=>{
 const f=fixture(),a=await candidate(f,"2026-01-01 to 2026-01-31, I prefer English"),b=await candidate(f,"2026-02-01 to 2026-02-28, I prefer Chinese","Chinese");
 const first=await confirm(f,a);await confirm(f,b);
 const facts=f.repo.current("scope-a");expect(facts).toHaveLength(2);expect(facts.find(x=>x.factId===first.factId)?.time).toEqual({validFrom:Date.parse("2026-01-01Z"),validTo:Date.parse("2026-02-01Z"),referenceTime:now});
 expect(await f.policy.recall(f.actor)).toEqual([]);
 const correction=await f.source("Chinese",{occurredAt:now,timeZone:"UTC"});
 await f.policy.act(f.actor,await f.policy.event(f.actor,{kind:"correct",nonce:randomUUID(),factId:first.factId,revision:1,sourceRef:correction.ref}));
 expect(f.repo.current("scope-a").find(x=>x.factId===first.factId)).toMatchObject({revision:2,time:facts.find(x=>x.factId===first.factId)!.time});
});
it("serializes overlapping confirmations and prevents forgotten periods from returning",async()=>{
 const f=fixture(),a=await candidate(f,"2026-01-01, I prefer English"),b=await candidate(f,"2026-01-01, I prefer Chinese","Chinese");
 const results=await Promise.allSettled([confirm(f,a),confirm(f,b)]);expect(results.filter(x=>x.status==="fulfilled")).toHaveLength(1);expect(results.filter(x=>x.status==="rejected")).toHaveLength(1);
 const fact=f.repo.current("scope-a")[0];
 await f.policy.act(f.actor,await f.policy.event(f.actor,{kind:"forget",nonce:randomUUID(),factId:fact.factId,revision:fact.revision}));
 expect(await f.policy.recall(f.actor)).toEqual([]);await expect(confirm(f,results[0].status==="fulfilled"?b:a)).rejects.toThrow();
});

it('binds candidate time to confirmation and preserves it when revising the selected value',async()=>{
 const f=fixture(),c=await candidate(f,'2026-01-01, I prefer English');
 const pending=(await f.policy.candidates(f.actor,{limit:100})).items[0];
 expect(pending).toMatchObject({time:{validFrom:Date.parse('2026-01-01Z'),validTo:Date.parse('2026-01-02Z'),referenceTime:now}});
 const proof=await f.source('Confirm this exact candidate',{occurredAt:now,timeZone:'UTC'}),old=await f.policy.event(f.actor,{kind:'confirm',nonce:randomUUID(),candidateId:c.candidateId,revision:c.candidateRevision,sourceRef:proof.ref});
 const edit=await f.source('Chinese',{occurredAt:now,timeZone:'UTC'}),next=await f.policy.act(f.actor,await f.policy.event(f.actor,{kind:'revise',nonce:randomUUID(),candidateId:c.candidateId,revision:c.candidateRevision,sourceRef:edit.ref}));
 await expect(f.policy.act(f.actor,old)).rejects.toThrow();
 const changed=(await f.policy.candidates(f.actor,{limit:100})).items[0];expect(changed.time).toEqual(pending.time);expect(changed.contentHash).not.toBe(pending.contentHash);
 await confirm(f,next);expect(f.repo.current('scope-a')[0].time).toEqual(pending.time);
});

it('does not let a current deterministic statement add support to or replace a past interval',async()=>{
 const f=fixture(),c=await candidate(f,'2026-01-01, I prefer English');await confirm(f,c);const old=f.repo.current('scope-a')[0],before=await f.policy.audit(f.actor,old.factId);
 const statement=await f.source('I prefer English',{occurredAt:now,timeZone:'UTC'});
 const ingest=await f.policy.ingest(f.actor,statement.ref);expect(ingest.status).toBe('candidate');
 expect((await f.policy.audit(f.actor,old.factId)).supports).toEqual(before.supports);
 const change=await f.source('以后用中文回复',{occurredAt:now,timeZone:'UTC'});expect((await f.policy.integrate(f.actor,change.ref)).items[0].status).toBe('candidate');
 expect(f.repo.current('scope-a')).toEqual([old]);
});

it('reopens a confirmed past fact and selects it into a new historical request, then blocks stale correction and forget sends',async()=>{
 let f=fixture();const c=await candidate(f,'2026-01-01, I prefer English'),active=await confirm(f,c),root=f.root,key=Buffer.from(f.key);f.close();owned.splice(owned.indexOf(f),1);
 f=createSmhFixture(root,{key,clock:()=>now,includeFactSupportMetadata:true});owned.push(f);key.fill(0);
 const {createMainFactSelector}=await import('../memory-recall/main-fact-selector');
 const actor=f.actorAuthority.bindActor(f.access,f.adapter,{...f.identity,sessionId:'session-b'}),selector=createMainFactSelector({actorAuthority:f.actorAuthority,registry:f.registry,policy:f.policy,recall:f.recall});
 const select=async(text:string)=>{const q=await f.source(text,{sessionId:'session-b',occurredAt:now,timeZone:'UTC'}),refs=await selector.selectFactRefs(actor,q.ref,{maxFacts:8});const snapshot=await f.context.assemble(actor,{sessionId:'session-b',sourceRefs:[q.ref],currentUserSourceRef:q.ref,factRefs:refs.map(({factId,revision})=>({factId,revision}))});return {q,refs,snapshot}};
 expect((await select('What language do I prefer?')).refs).toEqual([]);
 expect((await select('a'.repeat(4001))).refs).toEqual([]);
 expect((await select('What language did I prefer on 2026-01-01? '+'a'.repeat(4001))).refs).toEqual([]);
 expect((await select("'What language did I prefer on 2026-01-01?'")).refs).toEqual([]);
 expect((await select("‘What language did I prefer on 2026-01-01?’")).refs).toEqual([]);
 const past=await select('What language did I prefer on 2026-01-01?');expect(past.refs.map(r=>r.factId)).toEqual([active.factId]);expect(past.snapshot.request.body.facts).toEqual(['用户回复语言：en']);
 const permit=await f.context.validateForDispatch(actor,past.snapshot),sent:string[]=[];
 expect((await f.context.dispatch(actor,permit,request=>{sent.push(JSON.stringify(request.body));return 'fake';})).status).toBe('sent');expect(sent).toHaveLength(1);
 const stale=await select('What language did I prefer on 2026-01-01?'),stalePermit=await f.context.validateForDispatch(actor,stale.snapshot),edit=await f.source('Chinese',{occurredAt:now,timeZone:'UTC'});
 await f.policy.act(f.actor,await f.policy.event(f.actor,{kind:'correct',nonce:randomUUID(),factId:active.factId,revision:1,sourceRef:edit.ref}));
 await expect(f.context.dispatch(actor,stalePermit,()=>{sent.push('WRONG');})).rejects.toThrow();expect(sent).toHaveLength(1);
 const corrected=await select('What language did I prefer on 2026-01-01?');expect(corrected.snapshot.request.body.facts).toEqual(['用户回复语言：zh']);const forgottenPermit=await f.context.validateForDispatch(actor,corrected.snapshot);
 await f.policy.act(f.actor,await f.policy.event(f.actor,{kind:'forget',nonce:randomUUID(),factId:active.factId,revision:2}));
 await expect(f.context.dispatch(actor,forgottenPermit,()=>{sent.push('WRONG');})).rejects.toThrow();expect(sent).toHaveLength(1);expect((await select('What language did I prefer on 2026-01-01?')).refs).toEqual([]);
});

it('does not answer a historical question using undated facts or a missing source timezone',async()=>{
 const f=fixture(),s=await f.source('I prefer English',{occurredAt:now});await f.policy.ingest(f.actor,s.ref);
 const {createMainFactSelector}=await import('../memory-recall/main-fact-selector'),selector=createMainFactSelector({actorAuthority:f.actorAuthority,registry:f.registry,policy:f.policy,recall:f.recall});
 for(const timeZone of ['UTC',undefined]){const q=await f.source('What language did I prefer yesterday?',{occurredAt:now,...(timeZone?{timeZone}:{})});expect(await selector.selectFactRefs(f.actor,q.ref,{maxFacts:8})).toEqual([]);}
});
it('rejects forged query text, other-session sources and model-role temporal authority',async()=>{
 const f=fixture(),q=await f.source('What language do I prefer?',{occurredAt:now,timeZone:'UTC'});
 await expect(f.recall.rank(f.actor,{sourceRef:q.ref,text:'What language did I prefer yesterday?'})).rejects.toThrow('MEMORY_FACT_QUERY_DENIED');
 for(const opts of [{sessionId:'session-b'},{role:'assistant' as const}]){const s=await f.source('What language did I prefer yesterday?',{...opts,occurredAt:now,timeZone:'UTC'});await expect(f.recall.rank(f.actor,{sourceRef:s.ref,text:'What language did I prefer yesterday?'})).rejects.toThrow('MEMORY_FACT_QUERY_DENIED');}
});
it('invalidates historical context when the original assertion source changes',async()=>{
 const f=fixture(),c=await candidate(f,'2026-01-01, I prefer English'),a=await confirm(f,c),fact=f.repo.current('scope-a')[0],q=await f.source('What language did I prefer on 2026-01-01?',{occurredAt:now,timeZone:'UTC'});
 const snapshot=await f.context.assemble(f.actor,{sessionId:'session-a',sourceRefs:[q.ref],currentUserSourceRef:q.ref,factRefs:[{factId:a.factId!,revision:1}]}),permit=await f.context.validateForDispatch(f.actor,snapshot);
 const binding=fact.sourceRef.binding!;
 f.write({providerId:binding.providerId,sessionId:binding.sessionId,messageId:binding.messageId},{text:'Deleted original assertion',role:'user',trust:'direct-user-event',occurredAt:now,timeZone:'UTC'});
 let calls=0;await expect(f.context.dispatch(f.actor,permit,()=>{calls++})).rejects.toThrow();expect(calls).toBe(0);
});

it('lists historical and future confirmed records for management without granting current recall',async()=>{
 const f=fixture(),past=await candidate(f,'2026-01-01, I prefer English'),future=await candidate(f,'2026-04-01, I prefer Chinese','Chinese');await confirm(f,past);await confirm(f,future);
 expect(await f.policy.recall(f.actor)).toEqual([]);
 expect((await f.policy.manage(f.actor)).map(x=>x.time.validFrom).sort()).toEqual([Date.parse('2026-01-01Z'),Date.parse('2026-04-01Z')]);
});
it('forgets every disjoint interval in the selected canonical slot atomically',async()=>{
 const f=fixture(),a=await confirm(f,await candidate(f,'2026-01-01, I prefer English')),b=await confirm(f,await candidate(f,'2026-02-01, I prefer Chinese','Chinese'));
 expect(await f.policy.manage(f.actor)).toHaveLength(2);
 await f.policy.act(f.actor,await f.policy.event(f.actor,{kind:'forget',nonce:randomUUID(),factId:a.factId,revision:1}));
 expect(await f.policy.manage(f.actor)).toEqual([]);
 expect(f.repo.current('scope-a')).toEqual([]);
 expect((await f.policy.audit(f.actor,b.factId!)).status).toBe('forgotten');
});
