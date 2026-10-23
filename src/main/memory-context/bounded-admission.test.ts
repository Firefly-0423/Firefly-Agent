import {afterEach,expect,it} from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import {RecordCodec} from "../memory-core/record-codec";
import {createSmhFixture} from "./smh-fixture.test-support";
import {createMainContext} from "./main-context";
import {countPrepared,selectBudget} from "./token-budget";
const identity={providerId:"openrouter",model:"openai/gpt-6-luna",transport:"responses",framingVersion:"bounded-fixture-v1"};
const budget={maxContextTokens:20000,reservedOutputTokens:512,safetyMarginTokens:1024,maxSTokens:4000,minRecentCompleteTurns:1};
const prepare=(units:any[])=>({...identity,inputTypes:["text"],maxOutputTokens:512,body:{model:identity.model,instructions:"fixed synthetic instruction",input:units.flatMap(u=>u.messages),max_output_tokens:512}});
const counter={capability:{...identity,mode:"estimate" as const,inputTypes:["text"]},count:async(r:any)=>Buffer.byteLength(JSON.stringify(r.body))+1024};
const units=[{id:"u",kind:"recent" as const,messages:[{role:"user" as const,text:"synthetic user"}]}];
const selection=(overrides:any={})=>selectBudget({budget,counter,units,prepare,prepareS:prepare,...overrides});
it("estimates still fail closed in default strict admission",async()=>{await expect(selection()).rejects.toThrow("MEMORY_CONTEXT_BUDGET_UNPROVEN")});
it("explicit bounded selection labels estimates and does not populate exact fields",async()=>{
 const result=await selection({budget:{...budget,admissionMode:"bounded"}});
 expect(result.admissionMode).toBe("bounded");expect(result.estimates).toEqual({estimatedPromptTokens:await counter.count(prepare(units)),estimatedSTokens:await counter.count(prepare(units)),selectionInputLimit:18464});
 for(const name of ["promptTokens","sTokens","inputLimit"])expect(Object.hasOwn(result,name)).toBe(false);
 expect(Object.isFrozen(result.request.body)).toBe(true);
});
it("bounded cannot relabel an exact counter or another provider as a supported estimate",async()=>{
 await expect(selection({budget:{...budget,admissionMode:"bounded"},counter:{...counter,capability:{...counter.capability,mode:"exact"}}})).rejects.toThrow("MEMORY_CONTEXT_BUDGET_UNPROVEN");
 await expect(selection({budget:{...budget,admissionMode:"bounded"},counter:{...counter,capability:{...counter.capability,model:"another"}}})).rejects.toThrow("MEMORY_CONTEXT_COUNTER_UNSUPPORTED");
});
it("strict result stays exact and countPrepared never accepts an estimate",async()=>{
 const result=await selection({counter:{...counter,capability:{...counter.capability,mode:"exact"}}});expect(result.promptTokens).toBe(await counter.count(prepare(units)));expect(result.estimates).toBeUndefined();
 await expect(countPrepared(counter,prepare(units))).rejects.toThrow("MEMORY_CONTEXT_BUDGET_UNPROVEN");
});
const owned:Array<ReturnType<typeof createSmhFixture>>=[];afterEach(()=>{for(const f of owned.splice(0)){f.close();fs.rmSync(f.root,{recursive:true,force:true})}});
function fixture(){const f=createSmhFixture(fs.mkdtempSync(path.join(os.tmpdir(),"firefly-bounded-admission-")));owned.push(f);const context=createMainContext({registry:f.registry,transport:f.transport,actorAuthority:f.actorAuthority,clock:()=>1700000000000,counter,budget:{...budget,admissionMode:"bounded"} as any,prepare:(u)=>prepare(u),prepareS:prepare});return {...f,context,assemble:(refs:any[])=>context.assemble(f.actor,{sessionId:"session-a",sourceRefs:refs})}}
it("Worker stores only labeled estimates and rejects substitution into exact snapshot fields",async()=>{
 const f=fixture(),s=await f.source("synthetic user"),snapshot=await f.assemble([s.ref]),db=new DatabaseSync(f.databasePath);
 try{const row=db.prepare("SELECT payload FROM context_records WHERE id=?").get(snapshot.snapshotId)!;const saved=new RecordCodec(f.key).open<any>("context-snapshot","scope-a",snapshot.snapshotId,row.payload);expect(saved.counterIdentity.mode).toBe("estimate");expect(saved.estimates.estimatedPromptTokens).toBeGreaterThan(0);expect(saved.promptTokens).toBeUndefined();expect(saved.inputLimit).toBeUndefined()}finally{db.close()}
 const command=structuredClone(f.commands.find((c:any)=>c.kind==="snapshot")) as any;command.commandId=randomUUID();command.body.snapshotId=randomUUID();command.body.promptTokens=1;command.body.inputLimit=20000;
 expect(()=>f.repo.contextCommand(command)).toThrow("MEMORY_INPUT_INVALID");
});
it("bounded retains one-use permits and final pending-source denial",async()=>{
 const f=fixture(),s=await f.source("synthetic user"),snapshot=await f.assemble([s.ref]),permit=await f.context.validateForDispatch(f.actor,snapshot);let sends=0;
 expect(await f.context.dispatch(f.actor,permit,()=>{sends++;return "synthetic"})).toMatchObject({status:"sent"});await expect(f.context.dispatch(f.actor,permit,()=>{sends++;return "unexpected"})).rejects.toThrow("MEMORY_CONTEXT_PERMIT_USED");expect(sends).toBe(1);
 const next=await f.assemble([s.ref]),blocked=await f.context.validateForDispatch(f.actor,next);await f.registry.prepareChange(f.access,f.adapter,s.ref);await expect(f.context.dispatch(f.actor,blocked,()=>{sends++;return "unexpected"})).rejects.toThrow();expect(sends).toBe(1);
});
it("bounded summaries reject before opening an exact-benefit lease",async()=>{
 const f=fixture(),s=await f.source("synthetic user");await expect(f.context.prepareSummary(f.actor,{sessionId:"session-a",inputRefs:[s.ref],leaseMs:5000})).rejects.toThrow("MEMORY_CONTEXT_BOUNDED_SUMMARY_UNSUPPORTED");expect(f.commands.some((c:any)=>c.kind==="summaryLease")).toBe(false);
});
