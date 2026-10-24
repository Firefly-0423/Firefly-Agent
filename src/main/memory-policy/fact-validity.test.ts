import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {afterEach,expect,it,vi} from "vitest";
// Real SQLite / filesystem integration cases: the 5 s default is too tight on CI runners, so this file allows 30 s. Other files keep the default.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
import type {FactTime} from "../../shared/memory-contracts";
import {createSmhFixture} from "../memory-context/smh-fixture.test-support";

const owned:ReturnType<typeof createSmhFixture>[]=[];
afterEach(()=>{for(const f of owned.splice(0)){f.close();fs.rmSync(f.root,{recursive:true,force:true})}});
function fixture(){let now=Date.now();const f=createSmhFixture(fs.mkdtempSync(path.join(os.tmpdir(),"m-validity-")),{clock:()=>now});owned.push(f);return {...f,now:()=>now,advance:(ms:number)=>{now+=ms}}}
async function timed(f:ReturnType<typeof fixture>,time:FactTime){
 const s=await f.source("我默认用 PowerShell",{occurredAt:f.now()-1000}),a=(await f.policy.integrate(f.actor,s.ref)).items[0];
 const statement=await f.source("我默认用 PowerShell",{occurredAt:f.now()-500}),previous=f.repo.current("scope-a")[0];
 f.repo.execute({kind:"correctFact",scopeKey:"scope-a",commandId:randomUUID(),body:{factId:a.factId,expectedRevision:1,sourceRef:statement.ref,fact:{subjectKey:previous.subjectKey,assertion:previous.assertion,assertionKind:"user-statement",time}}});
 const confirmation=await f.source("确认所选偏好",{occurredAt:f.now()-100});
 await f.policy.act(f.actor,await f.policy.event(f.actor,{kind:"confirmFact",nonce:randomUUID(),factId:a.factId,revision:2,sourceRef:confirmation.ref}));
 return {factId:a.factId!,revision:2};
}
it.each(["unknown","starts-now","future","ends-now","expired","negative-start","negative-end"] as const)("canonical validity: %s",async kind=>{
 const f=fixture(),now=f.now(),time:FactTime={validFrom:null,validTo:null,referenceTime:null};
 if(kind==="starts-now")time.validFrom=now;
 if(kind==="future")time.validFrom=now+1;
 if(kind==="ends-now")time.validTo=now;
 if(kind==="expired"){time.validFrom=now-100;time.validTo=now-1}
 if(kind==="negative-start"){time.validFrom=-1000;time.referenceTime=-1000}
 if(kind==="negative-end"){time.validFrom=-2000;time.validTo=-1000;time.referenceTime=-2000}
 await timed(f,time);const expected=["unknown","starts-now","negative-start"].includes(kind)?1:0;
 expect(await f.policy.recall(f.actor)).toHaveLength(expected);
 expect((await f.recall.rank(f.actor)).items).toHaveLength(expected);
 expect(f.repo.current("scope-a")).toHaveLength(1);
 expect(f.repo.current("scope-a")[0].time).toEqual(time);
});
it("rank before expiry cannot authorize a later claim",async()=>{
 const f=fixture(),r=await timed(f,{validFrom:null,validTo:f.now()+100,referenceTime:null}),question=await f.source("给我终端命令");
 expect((await f.recall.rank(f.actor)).items).toHaveLength(1);
 const snapshot=await f.context.assemble(f.actor,{sessionId:"session-a",sourceRefs:[question.ref],factRefs:[r]});
 const permit=await f.context.validateForDispatch(f.actor,snapshot);f.advance(100);let sent=0;
 await expect(f.context.dispatch(f.actor,permit,()=>{sent++;return "offline"})).rejects.toThrow("MEMORY_CONTEXT_FACT_STALE");
 expect(sent).toBe(0);
});
it("future provider event uses injected transaction time, not wall clock",async()=>{
 const f=fixture();f.advance(-86400000);
 const s=await f.source("我默认用 PowerShell",{occurredAt:f.now()+1});
 expect((await f.policy.integrate(f.actor,s.ref)).items[0]).toMatchObject({status:"candidate",reason:"future-source"});
 expect(f.repo.current("scope-a")).toEqual([]);
});
it("recall takes exactly one trusted clock sample for nested policy/support checks",async()=>{
 let now=Date.now(),calls=0;const f=createSmhFixture(fs.mkdtempSync(path.join(os.tmpdir(),"m-clock-")),{clock:()=>{calls++;return now}});owned.push(f);
 const s=await f.source("我默认用 PowerShell",{occurredAt:now-1000});await f.policy.integrate(f.actor,s.ref);
 calls=0;await f.recall.rank(f.actor);expect(calls).toBe(1);now++;
 calls=0;await f.policy.recall(f.actor);expect(calls).toBe(1);
});