import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {afterEach,expect,it,vi} from "vitest";
import {createSmhFixture} from "../memory-context/smh-fixture.test-support";
import {createMainUserFactCoordinator} from "./main-user-fact-coordinator";
import {createMainSourceProvider,type SourceSnapshot} from "../memory-sources/main-source-provider";
import {canonicalJson} from "../memory-core/repository-types";

const owned:ReturnType<typeof createSmhFixture>[]=[];
afterEach(()=>{for(const f of owned.splice(0)){f.close();fs.rmSync(f.root,{recursive:true,force:true})}});
function fixture(){const f=createSmhFixture(fs.mkdtempSync(path.join(os.tmpdir(),"m-user-")));owned.push(f);return {...f,source:(text:string,options:Parameters<typeof f.source>[1]={})=>f.source(text,{occurredAt:1700000000000,...options}),...createMainUserFactCoordinator({actorAuthority:f.actorAuthority,registry:f.registry,policy:f.policy})}}
it("committed direct Chinese preference is idempotent; independent source adds support",async()=>{
 const f=fixture(),a=await f.source("我默认用 PowerShell"),b=await f.source("我默认用 PowerShell");
 const result=await f.onCommittedUserSource(f.actor,a.ref);expect(result.items[0].status).toBe("active");
 expect(await f.onCommittedUserSource(f.actor,a.ref)).toEqual(result);
 const again=await f.onCommittedUserSource(f.actor,b.ref);expect(again.items[0]).toMatchObject({status:"active",factId:result.items[0].factId,reason:"duplicate-support"});
 expect((await f.policy.audit(f.actor,result.items[0].factId!)).supports).toHaveLength(2);
});
it.each(["history","imported","model","system"] as const)("coordinator denies %s before policy writes",async trust=>{
 const f=fixture(),s=await f.source("我默认用 PowerShell",{trust}),before=f.commands.length;
 await expect(f.onCommittedUserSource(f.actor,s.ref)).rejects.toThrow("MEMORY_USER_SOURCE_DENIED");
 expect(f.commands).toHaveLength(before);expect(f.repo.current("scope-a")).toEqual([]);
});
it.each(["assistant","system"] as const)("coordinator denies source role %s",async role=>{
 const f=fixture(),s=await f.source("我默认用 PowerShell",{role});await expect(f.onCommittedUserSource(f.actor,s.ref)).rejects.toThrow("MEMORY_USER_SOURCE_DENIED");
});
it("forged/temporary/cross-session/span sources fail before policy writes",async()=>{
 const f=fixture(),s=await f.source("我默认用 PowerShell"),other=await f.source("我默认用 PowerShell",{sessionId:"session-b"}),before=f.commands.length;
 const temporary=f.actorAuthority.bindActor(f.access,f.adapter,f.identity,{sessionMode:"temporary"});
 await expect(f.onCommittedUserSource({},s.ref)).rejects.toThrow("MEMORY_ACTOR_DENIED");
 await expect(f.onCommittedUserSource(temporary,s.ref)).rejects.toThrow("MEMORY_POLICY_TEMPORARY_UNSUPPORTED");
 await expect(f.onCommittedUserSource(f.actor,other.ref)).rejects.toThrow("MEMORY_ACTOR_DENIED");
 await expect(f.onCommittedUserSource(f.actor,{...s.ref,span:{start:0,end:3}})).rejects.toThrow("MEMORY_POLICY_FULL_SOURCE_REQUIRED");
 expect(f.commands).toHaveLength(before);
});
it.each(['他说“我默认用 PowerShell”',"如果我现在改用 cmd","我今天想用 cmd","我有糖尿病"] as const)("ambiguous/sensitive direct source stays candidate: %s",async text=>{
 const f=fixture(),s=await f.source(text);expect((await f.onCommittedUserSource(f.actor,s.ref)).items[0].status).toBe("candidate");expect(f.repo.current("scope-a")).toEqual([]);
});
it("secret refusal does not persist its body and pre-cancel makes no I/O",async()=>{
 const f=fixture(),s=await f.source("密码是 SYNTHETIC_CANARY_M"),controller=new AbortController();controller.abort();const before=f.commands.length,reads=f.reads;
 await expect(f.onCommittedUserSource(f.actor,s.ref,controller.signal)).rejects.toThrow("MEMORY_POLICY_CANCELLED");
 expect(f.commands).toHaveLength(before);expect(f.reads).toBe(reads);
 expect((await f.onCommittedUserSource(f.actor,s.ref)).items).toEqual([{status:"rejected",reason:"secret"}]);
 expect(f.repo.readRows("evidence","scope-a")).toEqual([]);
 expect(f.repo.readRows("candidates","scope-a")).toEqual([]);
});
it("clear sourced change, correction, forget and fresh remember retain existing authority",async()=>{
 const f=fixture(),a=await f.source("我默认用 PowerShell",{occurredAt:1699999999000}),active=(await f.onCommittedUserSource(f.actor,a.ref)).items[0];
 const b=await f.source("我现在改用 cmd",{occurredAt:1699999999500});
 expect((await f.onCommittedUserSource(f.actor,b.ref)).items[0]).toMatchObject({factId:active.factId,factRevision:2});
 const c=await f.source("我默认用 bash",{occurredAt:1699999999600});
 await f.policy.act(f.actor,await f.policy.event(f.actor,{kind:"correct",nonce:randomUUID(),factId:active.factId,revision:2,sourceRef:c.ref}));
 expect((await f.onCommittedUserSource(f.actor,b.ref)).items[0].factRevision).toBe(2);
 expect(f.repo.current("scope-a")[0]).toMatchObject({revision:3,assertion:"我默认用 bash"});
 await f.policy.act(f.actor,await f.policy.event(f.actor,{kind:"forget",nonce:randomUUID(),factId:active.factId,revision:3}));
 expect((await f.onCommittedUserSource(f.actor,a.ref)).items[0].status).toBe("suppressed");
 const repeat=await f.source("我默认用 bash");expect((await f.onCommittedUserSource(f.actor,repeat.ref)).items[0].status).toBe("suppressed");
 const fresh=await f.source("我默认用 bash");expect((await f.policy.act(f.actor,await f.policy.event(f.actor,{kind:"remember",nonce:randomUUID(),sourceRef:fresh.ref}))).status).toBe("active");
 expect((await f.onCommittedUserSource(f.actor,a.ref)).items[0].status).toBe("suppressed");
});
it("pending source change blocks extraction",async()=>{
 const f=fixture(),s=await f.source("我默认用 PowerShell");await f.registry.prepareChange(f.access,f.adapter,s.ref);
 await expect(f.onCommittedUserSource(f.actor,s.ref)).rejects.toThrow("MEMORY_SOURCE_INVALID");
});
it("cancellation during leased source read prevents extraction writes",async()=>{
 const f=fixture(),q=await f.source("\u6211\u9ed8\u8ba4\u7528 PowerShell"),controller=new AbortController(),read=f.registry.readEvidence;
 const spy=vi.spyOn(f.registry,"readEvidence").mockImplementation(async(...args)=>{const text=await read(...args);controller.abort();return text});
 try{await expect(f.onCommittedUserSource(f.actor,q.ref,controller.signal)).rejects.toThrow("MEMORY_POLICY_CANCELLED");
 expect(f.commands.some(c=>(c as {kind:string}).kind==="integrate")).toBe(false);expect(f.repo.current("scope-a")).toEqual([])}finally{spy.mockRestore()}
});

it("a reconciled provider deletion cannot enter automatic extraction",async()=>{
 const f=fixture(),q=await f.source("\u6211\u9ed8\u8ba4\u7528 PowerShell");
 const saved=JSON.parse(fs.readFileSync(path.join(f.root,"synthetic-provider.json"),"utf8"))[canonicalJson(q.id)] as SourceSnapshot;
 const deleted=createMainSourceProvider({providerId:"synthetic",authorize:()=>true,withLease:async(_id,run)=>run(async()=>({...saved,state:"deleted",text:"",contentRevision:saved.contentRevision+1}))});
 await f.registry.prepareChange(f.access,f.adapter,q.ref);
 await expect(f.registry.reconcile(f.access,deleted,q.id)).rejects.toThrow("MEMORY_SOURCE_DELETED");
 const before=f.commands.length;await expect(f.onCommittedUserSource(f.actor,q.ref)).rejects.toThrow("MEMORY_SOURCE_INVALID");
 expect(f.commands).toHaveLength(before);expect(f.repo.current("scope-a")).toEqual([]);
});

it("an untimed first preference stays candidate; explicit confirmation preserves null validity",async()=>{
 const f=fixture(),s=await f.source("\u6211\u9ed8\u8ba4\u7528 PowerShell",{occurredAt:undefined});
 const item=(await f.onCommittedUserSource(f.actor,s.ref)).items[0];
 expect(item).toMatchObject({status:"candidate",reason:"unknown-time"});expect(f.repo.current("scope-a")).toEqual([]);
 const proof=await f.source("I confirm the selected preference",{occurredAt:1000});
 await f.policy.act(f.actor,await f.policy.event(f.actor,{kind:"confirm",nonce:randomUUID(),candidateId:item.candidateId,revision:1,sourceRef:proof.ref}));
 expect(f.repo.current("scope-a")[0].time).toEqual({validFrom:null,validTo:null,referenceTime:null});
 expect(await f.policy.recall(f.actor)).toHaveLength(1);
});
it("an untimed independent duplicate remains candidate and cannot add automatic support",async()=>{
 const f=fixture(),s=await f.source("\u6211\u9ed8\u8ba4\u7528 PowerShell",{occurredAt:1000});
 const a=(await f.onCommittedUserSource(f.actor,s.ref)).items[0],before=f.repo.current("scope-a");
 const duplicate=await f.source("\u6211\u9ed8\u8ba4\u7528 PowerShell",{occurredAt:undefined});
 expect((await f.onCommittedUserSource(f.actor,duplicate.ref)).items[0]).toMatchObject({status:"candidate",reason:"unknown-time"});
 expect(f.repo.current("scope-a")).toEqual(before);expect((await f.policy.audit(f.actor,a.factId!)).supports.map(s=>s.sourceRef)).toEqual([s.ref]);
});
