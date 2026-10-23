import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {spawnSync} from "node:child_process";
import {policySubjectKey} from "../memory-policy/policy-repository";
import {afterEach,expect,it,vi} from "vitest";
// Real SQLite / filesystem integration cases: the 5 s default is too tight on CI runners, so this file allows 30 s. Other files keep the default.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
import {createSmhFixture} from "../memory-context/smh-fixture.test-support";
import {createMainUserFactCoordinator} from "../memory-policy/main-user-fact-coordinator";
import {createMainFactSelector} from "./main-fact-selector";
const owned:ReturnType<typeof createSmhFixture>[]=[];
afterEach(()=>{for(const f of owned.splice(0)){f.close();fs.rmSync(f.root,{recursive:true,force:true})}});
function fixture(root=fs.mkdtempSync(path.join(os.tmpdir(),"m-selector-")),key?:Uint8Array){const f=createSmhFixture(root,{key});owned.push(f);return {...f,...createMainUserFactCoordinator({actorAuthority:f.actorAuthority,registry:f.registry,policy:f.policy}),...createMainFactSelector({actorAuthority:f.actorAuthority,registry:f.registry,policy:f.policy,recall:f.recall})}}
async function active(f:ReturnType<typeof fixture>,text:string,occurredAt=1700000000000){const s=await f.source(text,{occurredAt});return {...s,result:(await f.onCommittedUserSource(f.actor,s.ref)).items[0]}}
async function select(f:ReturnType<typeof fixture>,text:string,maxFacts=20,sessionId="session-a"){const s=await f.source(text,{sessionId}),actor=sessionId==="session-a"?f.actor:f.actorAuthority.bindActor(f.access,f.adapter,{...f.identity,sessionId});return f.selectFactRefs(actor,s.ref,{maxFacts})}
it("new session after repository reopen selects only canonical fact refs and active source supports",async()=>{
 let f=fixture();const a=await active(f,"我默认用 PowerShell",1699999999000),root=f.root,key=Buffer.from(f.key);
 f.close();
 const index=owned.findIndex(item=>item.root===root);if(index>=0)owned.splice(index,1);
 fs.writeFileSync(path.join(root,"synthetic-key.hex"),key.toString("hex"));
 const child=spawnSync(process.execPath,["-e",`
const fs=require("node:fs"),path=require("node:path"),base=process.argv[1],root=process.argv[2];
const ts=require(path.join(base,"node_modules/typescript"));
require.extensions[".ts"]=(m,file)=>m._compile(ts.transpileModule(fs.readFileSync(file,"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,file);
const {createSmhFixture}=require(path.join(base,"src/main/memory-context/smh-fixture.test-support.ts"));
const {createMainFactSelector}=require(path.join(base,"src/main/memory-recall/main-fact-selector.ts"));
(async()=>{const f=createSmhFixture(root,{key:Buffer.from(fs.readFileSync(path.join(root,"synthetic-key.hex"),"utf8"),"hex")});
try{const actor=f.actorAuthority.bindActor(f.access,f.adapter,{...f.identity,sessionId:"session-b"});
const q=await f.source("给我终端命令",{sessionId:"session-b"}),selector=createMainFactSelector({actorAuthority:f.actorAuthority,registry:f.registry,policy:f.policy,recall:f.recall});
console.log(JSON.stringify(await selector.selectFactRefs(actor,q.ref,{maxFacts:20})));}finally{f.close()}})().catch(e=>{console.error(e);process.exitCode=1});
`,process.cwd(),root],{encoding:"utf8",windowsHide:true});
 expect(child.status,child.stderr).toBe(0);expect(JSON.parse(child.stdout.trim())).toEqual([{factId:a.result.factId,revision:1,sourceRefs:[a.ref]}]);
 f=fixture(root,key);key.fill(0);
 expect(await select(f,"给我终端命令",20,"session-b")).toEqual([{factId:a.result.factId,revision:1,sourceRefs:[a.ref]}]);
 const b=await active(f,"我现在改用 cmd",1699999999500);
 expect(await select(f,"给我终端命令")).toEqual([{factId:a.result.factId,revision:2,sourceRefs:[b.ref]}]);
});
it("base preferences and context-specific shell/programming facts are selected without mixing work/personal",async()=>{
 const f=fixture();await active(f,"我默认用中文");await active(f,"请叫我小林");await active(f,"我偏好简洁回复");
 const paired=await active(f,"我工作用 PowerShell，个人用 bash");await active(f,"我工作用 Python");await active(f,"我个人用 Rust");await active(f,"我会 Python 和 Rust");
 const work=await select(f,"给我工作终端命令");expect(work).toHaveLength(4);
 const values=work.map(r=>f.repo.current("scope-a").find(a=>a.factId===r.factId)!);
 expect(values.some(a=>a.subjectKey===policySubjectKey("actor-a","shell","work","one","powershell"))).toBe(true);
 expect(values.some(a=>a.subjectKey===policySubjectKey("actor-a","shell","personal","one","bash"))).toBe(false);
 const shellIds=(await f.policy.integrate(f.actor,paired.ref)).items.map(i=>i.factId);
 expect(work.filter(r=>shellIds.includes(r.factId))).toHaveLength(1);
 const code=await select(f,"工作上写 Python 代码");expect(code).toHaveLength(6);
 expect(await select(f,"个人终端命令")).toHaveLength(4);
});
it("unrelated query is empty; invalid limits and untrusted current question fail before rank",async()=>{
 const f=fixture();await active(f,"我默认用 PowerShell");expect(await select(f,"今天天气如何")).toEqual([]);
 const q=await f.source("终端命令",{trust:"history"}),before=f.commands.length;
 await expect(f.selectFactRefs(f.actor,q.ref,{maxFacts:3})).rejects.toThrow("MEMORY_USER_SOURCE_DENIED");expect(f.commands).toHaveLength(before);
 const s=await f.source("终端命令");for(const maxFacts of [-1,0,201,1.5])await expect(f.selectFactRefs(f.actor,s.ref,{maxFacts})).rejects.toThrow("MEMORY_RECALL_INPUT_INVALID");
});
it("only currently valid independent supports are returned; selectors do not refresh usage",async()=>{
 const f=fixture(),a=await active(f,"我默认用 PowerShell"),b=await active(f,"我默认用 PowerShell");
 await f.registry.prepareChange(f.access,f.adapter,a.ref);
 expect(await select(f,"终端命令")).toEqual([{factId:a.result.factId,revision:1,sourceRefs:[b.ref]}]);
 for(let i=0;i<3;i++){await select(f,"终端命令");await f.recall.rank(f.actor);await f.recall.metadata(f.actor,[{factId:a.result.factId!,revision:1}])}
 expect((await f.recall.metadata(f.actor,[{factId:a.result.factId!,revision:1}])).targets[0]).toMatchObject({lastAccessAt:null,accessCount:0});
 await f.registry.prepareChange(f.access,f.adapter,b.ref);expect(await select(f,"终端命令")).toEqual([]);
});
it("forget and archive cannot be bypassed by ordinary queries or extra nomination arguments",async()=>{
 const f=fixture(),a=await active(f,"我默认用 PowerShell"),ref={factId:a.result.factId!,revision:1};
 await f.recall.apply(f.actor,await f.recall.preview(f.actor,[ref],"archive"));expect(await select(f,"终端命令")).toEqual([]);
 await f.recall.apply(f.actor,await f.recall.preview(f.actor,[ref],"restore"));
 await f.policy.act(f.actor,await f.policy.event(f.actor,{kind:"forget",nonce:randomUUID(),...ref}));
 expect(await select(f,"PowerShell 终端命令")).toEqual([]);
 const q=await f.source("终端命令");
 await expect(f.selectFactRefs(f.actor,q.ref,{maxFacts:3,factRefs:[ref]} as {maxFacts:number})).rejects.toThrow("MEMORY_INPUT_INVALID");
});
it("temporary and forged actor, partial question and pre-cancel have zero rank I/O",async()=>{
 const f=fixture(),q=await f.source("终端命令"),temporary=f.actorAuthority.bindActor(f.access,f.adapter,f.identity,{sessionMode:"temporary"}),controller=new AbortController();controller.abort();const before=f.commands.length;
 await expect(f.selectFactRefs({},q.ref,{maxFacts:3})).rejects.toThrow("MEMORY_ACTOR_DENIED");
 await expect(f.selectFactRefs(temporary,q.ref,{maxFacts:3})).rejects.toThrow("MEMORY_RECALL_TEMPORARY_UNSUPPORTED");
 await expect(f.selectFactRefs(f.actor,{...q.ref,span:{start:0,end:2}},{maxFacts:3})).rejects.toThrow("MEMORY_POLICY_FULL_SOURCE_REQUIRED");
 await expect(f.selectFactRefs(f.actor,q.ref,{maxFacts:3},controller.signal)).rejects.toThrow("MEMORY_RECALL_CANCELLED");expect(f.commands).toHaveLength(before);
});
it("same category and strength have deterministic factId ordering and bounded count",async()=>{
 const f=fixture();await active(f,"我会 Python 和 Rust");const first=await select(f,"编程能力"),second=await select(f,"编程能力");
 expect(first.map(f=>f.factId)).toEqual(first.map(f=>f.factId).sort());expect(second).toEqual(first);expect(await select(f,"编程能力",1)).toEqual(first.slice(0,1));
});
it("English context and word-boundary topics select the matching preference",async()=>{
 const f=fixture();await active(f,"\u6211\u5de5\u4f5c\u7528 PowerShell\uff0c\u4e2a\u4eba\u7528 bash");
 const work=await select(f,"a command for work"),personal=await select(f,"a command for personal use");
 expect(work).toHaveLength(1);expect(personal).toHaveLength(1);expect(work[0].factId).not.toBe(personal[0].factId);
 expect(await select(f,"a command")).toEqual([]);
});
it("cancellation after reading the current question dispatches no rank",async()=>{
 const f=fixture(),q=await f.source("\u7ec8\u7aef\u547d\u4ee4"),controller=new AbortController(),read=f.registry.readEvidence;
 const spy=vi.spyOn(f.registry,"readEvidence").mockImplementation(async(...args)=>{const text=await read(...args);controller.abort();return text});
 try{await expect(f.selectFactRefs(f.actor,q.ref,{maxFacts:3},controller.signal)).rejects.toThrow("MEMORY_RECALL_CANCELLED");
 expect(f.commands.some(c=>(c as {kind:string}).kind==="rank")).toBe(false)}finally{spy.mockRestore()}
});
it.each(["type Login = { api_key: string; password: string }","Explain api_key and password field validation","The token is a unit of text."])("does not reject ordinary context as a secret during read-only selection: %s",async text=>{
 const f=fixture();await expect(select(f,text)).resolves.toEqual([]);expect(await f.policy.recall(f.actor)).toEqual([]);
});
it("continues rejecting an actual synthetic secret before ranking memory",async()=>{
 const f=fixture(),rank=vi.spyOn(f.recall,"rank");await expect(select(f,"api_key=SYNTHETIC_ONLY_SECRET_VALUE")).rejects.toThrow("MEMORY_POLICY_SECRET");expect(rank).not.toHaveBeenCalled();
});
