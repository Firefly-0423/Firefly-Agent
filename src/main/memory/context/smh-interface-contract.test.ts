import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {expect,it,vi} from "vitest";
// Real SQLite / filesystem integration cases: the 5 s default is too tight on CI runners, so this file allows 30 s. Other files keep the default.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
import {createSmhFixture} from "./smh-fixture.test-support";

const base=path.resolve(os.tmpdir(),"firefly-smh-fixtures");
function fixture(clock?:()=>number){fs.mkdirSync(base,{recursive:true});return createSmhFixture(fs.mkdtempSync(path.join(base,"contract-")),{clock})}
function dispose(f:ReturnType<typeof fixture>){f.close();if(path.dirname(f.root)!==base)throw new Error("SMH_CLEANUP_DENIED");fs.rmSync(f.root,{recursive:true,force:true})}

it("a short summary lease uses one clock value within its worker transaction",async()=>{
 let now=1700000000000,calls=0;const f=fixture(()=>{calls++;return now++});
 try{
  const s=await f.source("我默认用 PowerShell"),owner={actorKey:"actor-a",providerId:"synthetic",sessionId:"session-a",bootId:"synthetic-boot"};
  calls=0;
  await expect(f.transport.contextCommand({kind:"summaryLease",scopeKey:"scope-a",commandId:"lease-command",body:{...owner,leaseId:"short-lease",generation:0,sourceDeps:[{sourceRef:s.ref,subjectKeys:null,derivedRefs:null}],inputRefs:[s.ref],leaseMs:1}})).resolves.toEqual({leaseId:"short-lease"});
  expect(calls).toBe(1);
  await expect(f.transport.contextCommand({kind:"summaryLeaseRead",scopeKey:"scope-a",body:{...owner,leaseId:"short-lease"}})).rejects.toThrow("MEMORY_CONTEXT_LEASE_EXPIRED");
  expect(calls).toBe(2);
 }finally{dispose(f)}
});

it("copied actor, source-provider and history tokens acquire no authority or reads",async()=>{
 const f=fixture();
 try{
  const before=f.commands.length,reads=f.reads;
  await expect(f.context.assemble(JSON.parse(JSON.stringify(f.actor)),{sessionId:"session-a",sourceRefs:[]})).rejects.toThrow("MEMORY_ACTOR_DENIED");
  await expect(f.registry.capture(f.access,{},f.identity)).rejects.toThrow("MEMORY_SOURCE_PROVIDER_DENIED");
  await expect(f.context.assemble(f.actor,{sessionId:"session-a",sourceRefs:[{sourceId:"fabricated",revision:1,binding:{...f.identity,contentRevision:1,generation:"fabricated"}}]})).rejects.toThrow("MEMORY_SOURCE_INVALID");
  await expect(f.context.assemble(f.actor,{sessionId:"session-a",sourceRefs:[],historyTokens:[{}]})).rejects.toThrow("MEMORY_HISTORY_EVIDENCE_DENIED");
  await expect(f.history.query(f.actor,{query:"PowerShell",scope:{}})).rejects.toThrow("MEMORY_HISTORY_ACCESS_DENIED");
  expect(f.commands).toHaveLength(before);expect(f.reads).toBe(reads);
 }finally{dispose(f)}
});

it("a command body cannot override the trusted worker clock",async()=>{
 let calls=0;const f=fixture(()=>{calls++;return 1700000000000});
 try{
  await expect(f.transport.contextCommand({kind:"baseline",scopeKey:"scope-a",body:{actorKey:"actor-a",providerId:"synthetic",sessionId:"session-a",bootId:"synthetic-boot",sourceRefs:[],factRefs:[],now:0}})).rejects.toThrow("MEMORY_INPUT_INVALID");
  expect(calls).toBe(0);
 }finally{dispose(f)}
});

it("a synthetic source and transport prepare once and invoke a sender only once",async()=>{
 const f=fixture();
 try{
  const s=await f.source("这是合成原话"),snapshot=await f.context.assemble(f.actor,{sessionId:"session-a",sourceRefs:[s.ref]}),permit=await f.context.validateForDispatch(f.actor,snapshot);let sends=0;
  expect((await f.context.dispatch(f.actor,permit,()=>{sends++;return "synthetic-response"})).status).toBe("sent");
  await expect(f.context.dispatch(f.actor,permit,()=>{sends++;return "duplicate"})).rejects.toThrow("MEMORY_CONTEXT_PERMIT_USED");expect(sends).toBe(1);
 }finally{dispose(f)}
});
