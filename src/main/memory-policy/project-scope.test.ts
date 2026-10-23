import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {afterEach,expect,it,vi} from "vitest";
vi.setConfig({testTimeout:30_000,hookTimeout:30_000});
import {createSmhFixture} from "../memory-context/smh-fixture.test-support";
import {createMainUserFactCoordinator} from "./main-user-fact-coordinator";
import {createMainFactSelector} from "../memory-recall/main-fact-selector";
import {policySubjectKey,claimSubjectKeys} from "./policy-repository";
import {isProjectKey,projectKeyForWorkspaceRoot,PROJECT_SCOPED_ATTRIBUTES} from "./project-scope";

const owned:ReturnType<typeof createSmhFixture>[]=[];
afterEach(()=>{for(const f of owned.splice(0)){f.close();fs.rmSync(f.root,{recursive:true,force:true})}});
function fixture(){
 const f=createSmhFixture(fs.mkdtempSync(path.join(os.tmpdir(),"m-project-")));owned.push(f);
 return {...f,...createMainUserFactCoordinator({actorAuthority:f.actorAuthority,registry:f.registry,policy:f.policy}),...createMainFactSelector({actorAuthority:f.actorAuthority,registry:f.registry,policy:f.policy,recall:f.recall})};
}
const ALPHA=projectKeyForWorkspaceRoot("C:\\work\\alpha"),BETA=projectKeyForWorkspaceRoot("C:\\work\\beta");
type F=ReturnType<typeof fixture>;
/** A desktop-like session actor: same user, the workspace binding is read lazily at each use. */
function session(f:F,sessionId:string,project:()=>string|undefined){
 return f.actorAuthority.bindActor(f.access,f.adapter,{...f.identity,sessionId},{project});
}
async function say(f:F,actor:object,sessionId:string,text:string,occurredAt=1700000000000){
 const s=await f.source(text,{sessionId,occurredAt});
 const result=(await f.onCommittedUserSource(actor,s.ref)).items[0];
 return {...s,result};
}
async function pick(f:F,actor:object,sessionId:string,question:string,maxFacts=20){
 const s=await f.source(question,{sessionId});
 return f.selectFactRefs(actor,s.ref,{maxFacts});
}
const subjectOf=(f:F,factId:string|undefined)=>f.repo.current("scope-a").find(x=>x.factId===factId)?.subjectKey;

it("projectKeyForWorkspaceRoot is stable, separator/case/trailing-slash insensitive for Windows paths, and distinct per root",()=>{
 expect(isProjectKey(ALPHA)).toBe(true);expect(ALPHA).not.toBe(BETA);
 expect(projectKeyForWorkspaceRoot("c:/Work/Alpha/")).toBe(ALPHA);
 expect(projectKeyForWorkspaceRoot("C:\\WORK\\alpha\\")).toBe(ALPHA);
 expect(isProjectKey("project-xyz")).toBe(false);expect(isProjectKey(undefined)).toBe(false);
 expect(()=>projectKeyForWorkspaceRoot("")).toThrow("MEMORY_PROJECT_INVALID");
});
it("subject keys without a project are byte-identical to the pre-project format, so stored memories keep their identity",()=>{
 expect(policySubjectKey("actor-a","shell")).toBe("actor-attribute-062d21e79bca28939f11f35fee37b7cf6318a284a091e09522ef7ec7e79532ab");
 expect(policySubjectKey("actor-a","programming-usage","work","many","python")).toBe("actor-attribute-9b22a588586e373c5053502de8dc2b95aab8abc30557976a988e26e84e25131a");
 expect(policySubjectKey("actor-a","shell","default","one",null,ALPHA)).not.toBe(policySubjectKey("actor-a","shell"));
 expect(policySubjectKey("actor-a","shell","default","one",null,ALPHA)).not.toBe(policySubjectKey("actor-a","shell","default","one",null,BETA));
});
it("only tool attributes are project scoped; user-level attributes stay global",()=>{
 expect([...PROJECT_SCOPED_ATTRIBUTES].sort()).toEqual(["programming-usage","shell"]);
 const shell={attribute:"shell" as const,value:"bash",context:"default" as const,cardinality:"one" as const,operation:"assert" as const};
 expect(claimSubjectKeys("actor-a",shell,ALPHA)).toEqual([policySubjectKey("actor-a","shell"),policySubjectKey("actor-a","shell","default","one",null,ALPHA)]);
 expect(claimSubjectKeys("actor-a",shell,undefined)).toEqual([policySubjectKey("actor-a","shell")]);
 expect(claimSubjectKeys("actor-a",{...shell,attribute:"language",value:"zh"},ALPHA)).toEqual([policySubjectKey("actor-a","language")]);
 expect(claimSubjectKeys("actor-a",{...shell,context:"work"},ALPHA)).toEqual([policySubjectKey("actor-a","shell","work")]);
});

it("a tool preference learned in a workspace session is stored under that project and does not reach another project or an unbound session",async()=>{
 const f=fixture(),inAlpha=session(f,"session-a",()=>ALPHA),inBeta=session(f,"session-b",()=>BETA),unbound=f.actor;
 const learned=await say(f,inAlpha,"session-a","我默认用 bash");
 expect(learned.result.status).toBe("active");
 expect(subjectOf(f,learned.result.factId)).toBe(policySubjectKey("actor-a","shell","default","one",null,ALPHA));
 expect((await pick(f,inAlpha,"session-a","给我终端命令")).map(r=>r.factId)).toEqual([learned.result.factId]);
 expect(await pick(f,inBeta,"session-b","给我终端命令")).toEqual([]);
 expect(await pick(f,unbound,"session-a","给我终端命令")).toEqual([]);
});
it("policy recall labels each fact with where it applies, so a settings view can show it",async()=>{
 const f=fixture(),inAlpha=session(f,"session-a",()=>ALPHA);
 const shell=await say(f,inAlpha,"session-a","我默认用 bash"),lang=await say(f,inAlpha,"session-a","我默认用中文");
 const scopes=Object.fromEntries((await f.policy.recall(f.actor)).map(fact=>[fact.factId,fact.scope]));
 expect(scopes[shell.result.factId]).toBe("project");expect(scopes[lang.result.factId]).toBe("global");
});
it("two projects keep independent values of the same single-value attribute without conflict",async()=>{
 const f=fixture(),inAlpha=session(f,"session-a",()=>ALPHA),inBeta=session(f,"session-b",()=>BETA);
 const a=await say(f,inAlpha,"session-a","我默认用 bash"),b=await say(f,inBeta,"session-b","我默认用 PowerShell");
 expect(a.result.status).toBe("active");expect(b.result.status).toBe("active");expect(a.result.factId).not.toBe(b.result.factId);
 expect((await pick(f,inAlpha,"session-a","终端命令")).map(r=>r.factId)).toEqual([a.result.factId]);
 expect((await pick(f,inBeta,"session-b","终端命令")).map(r=>r.factId)).toEqual([b.result.factId]);
});
it("user-level preferences stay global even when learned inside a project",async()=>{
 const f=fixture(),inAlpha=session(f,"session-a",()=>ALPHA),inBeta=session(f,"session-b",()=>BETA);
 const lang=await say(f,inAlpha,"session-a","我默认用中文"),call=await say(f,inAlpha,"session-a","请叫我小林");
 expect(subjectOf(f,lang.result.factId)).toBe(policySubjectKey("actor-a","language"));
 expect(subjectOf(f,call.result.factId)).toBe(policySubjectKey("actor-a","address"));
 expect((await pick(f,inBeta,"session-b","hello")).map(r=>r.factId).sort()).toEqual([lang.result.factId,call.result.factId].sort());
});
it("explicit work/personal context claims are not narrowed to a project",async()=>{
 const f=fixture(),inAlpha=session(f,"session-a",()=>ALPHA);
 const paired=await f.onCommittedUserSource(inAlpha,(await f.source("我工作用 PowerShell，个人用 bash",{sessionId:"session-a",occurredAt:1700000000000})).ref);
 const keys=paired.items.map(i=>subjectOf(f,i.factId));
 expect(keys).toContain(policySubjectKey("actor-a","shell","work"));expect(keys).toContain(policySubjectKey("actor-a","shell","personal"));
});
it("a global tool preference stays visible in a project until that project states its own, which then takes precedence",async()=>{
 const f=fixture(),inAlpha=session(f,"session-a",()=>ALPHA),chat=session(f,"session-b",()=>undefined);
 const global=await say(f,chat,"session-b","我默认用 PowerShell",1699999999000);
 expect((await pick(f,inAlpha,"session-a","终端命令")).map(r=>r.factId)).toEqual([global.result.factId]);
 const local=await say(f,inAlpha,"session-a","我默认用 bash");
 expect(local.result.status).toBe("active");
 expect((await pick(f,inAlpha,"session-a","终端命令")).map(r=>r.factId)).toEqual([local.result.factId]);
 expect((await pick(f,chat,"session-b","终端命令")).map(r=>r.factId)).toEqual([global.result.factId]);
});
it("an explicit change inside a project updates that project's fact and leaves the global value untouched",async()=>{
 const f=fixture(),inAlpha=session(f,"session-a",()=>ALPHA),chat=session(f,"session-b",()=>undefined);
 const global=await say(f,chat,"session-b","我默认用 PowerShell",1699999999000);
 const first=await say(f,inAlpha,"session-a","我现在改用 bash",1699999999500);
 expect(first.result.status).toBe("active");expect(first.result.factId).not.toBe(global.result.factId);
 const second=await say(f,inAlpha,"session-a","我现在改用 cmd",1699999999900);
 expect(second.result).toMatchObject({status:"active",factId:first.result.factId,factRevision:2});
 expect(f.repo.current("scope-a").find(x=>x.factId===global.result.factId)).toMatchObject({revision:1});
});
it("binding is read at each use: clearing the workspace turns later preferences back into global facts",async()=>{
 const f=fixture();let project:string|undefined=ALPHA;const live=session(f,"session-a",()=>project);
 const inAlpha=await say(f,live,"session-a","我默认用 bash",1699999999000);
 project=undefined;
 const nowGlobal=await say(f,live,"session-a","我默认用 cmd",1699999999500);
 expect(subjectOf(f,inAlpha.result.factId)).toBe(policySubjectKey("actor-a","shell","default","one",null,ALPHA));
 expect(subjectOf(f,nowGlobal.result.factId)).toBe(policySubjectKey("actor-a","shell"));
});
it("a malformed project binding fails closed before any worker write",async()=>{
 const f=fixture(),bad=session(f,"session-a",()=>"not-a-project");
 const s=await f.source("我默认用 bash",{sessionId:"session-a",occurredAt:1700000000000});
 const before=f.commands.length;
 await expect(f.onCommittedUserSource(bad,s.ref)).rejects.toThrow("MEMORY_PROJECT_INVALID");
 await expect(f.selectFactRefs(bad,s.ref,{maxFacts:3})).rejects.toThrow("MEMORY_PROJECT_INVALID");
 expect(f.commands.slice(before).some(c=>(c as {kind:string}).kind==="integrate")).toBe(false);
});
it("forgetting a project fact does not touch the same preference in another project",async()=>{
 const f=fixture(),inAlpha=session(f,"session-a",()=>ALPHA),inBeta=session(f,"session-b",()=>BETA);
 const a=await say(f,inAlpha,"session-a","我默认用 bash"),b=await say(f,inBeta,"session-b","我默认用 bash");
 expect(a.result.factId).not.toBe(b.result.factId);
 await f.policy.act(f.actor,await f.policy.event(f.actor,{kind:"forget",nonce:"11111111-1111-4111-8111-111111111111",factId:a.result.factId,revision:1}));
 expect(await pick(f,inAlpha,"session-a","终端命令")).toEqual([]);
 expect((await pick(f,inBeta,"session-b","终端命令")).map(r=>r.factId)).toEqual([b.result.factId]);
});
