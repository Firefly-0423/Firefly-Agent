import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProbeRunner, type ProbeReceipt } from "./runner";
import { EXPERIMENT_ID, BUDGET_NANO_USD, TOTAL_RESERVE_NANO_USD, BODY_SHA256 } from "./boundary";
import { createSessionProfile } from "./session-profile";
const profile=createSessionProfile("SYNTHETIC-SECRET-NOT-REAL","test-id");
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});vi.useRealTimers();});
const now=Date.parse("2026-10-02T09:00:00Z");
function setup(fetch=vi.fn(async()=>response()), extra:Record<string,unknown>={}) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"memory-openrouter-fake-"));roots.push(root);
 const arm={experimentId:EXPERIMENT_ID,priorAttempts:0,budgetNanoUsd:BUDGET_NANO_USD,priceVerifiedAt:now-1000,inputNanoUsdPerToken:300,outputNanoUsdPerToken:1200,currency:"USD",model:"deepseek/deepseek-v4.1-flash",endpoint:"https://openrouter.ai/api/v1/chat/completions",provider:"deepseek",maxAttempts:2,bodySha256:BODY_SHA256,expiresAt:now+3600000,armed:true};
 fs.writeFileSync(path.join(root,"arm.json"),JSON.stringify(arm));
 const runner=createProbeRunner({root,resolveProfile:(id:string)=>id===profile.id?{...profile}:undefined,fetch,now:()=>now,...extra});
 return {runner,fetch,root,arm};
}
function response(usage:unknown={is_byok:false,prompt_tokens:100,completion_tokens:20,total_tokens:120,cost:0.000027},extra:Record<string,unknown>={}) {
 return new Response(JSON.stringify({id:"fake-id",object:"chat.completion",model:"deepseek/deepseek-v4.1-flash",provider:"DeepSeek",usage,choices:[{index:0,message:{role:"assistant",content:profile.apiKey},finish_reason:"stop"}],...extra}),{status:200});
}
function assertSanitized(result:ProbeReceipt) {
 const text=JSON.stringify(result);expect(text).not.toContain(profile.apiKey);expect(text).not.toContain("choices");expect(text).not.toContain("headers");expect(text).not.toContain("stack");
}
describe("durable one-shot Main runner using only simulated network",()=>{
 it("reserves both attempts before fetch and uses identical fixed requests exactly twice",async()=>{
  const {runner,fetch,root}=setup();
  fetch.mockImplementation(async()=>{
   const journal=JSON.parse(fs.readFileSync(path.join(root,"ledger.json"),"utf8"));
   expect(journal.reservedNanoUsd).toBe(TOTAL_RESERVE_NANO_USD);expect(journal.attempts.at(-1).status).toBe("pending");
   return response();
  });
  const result=await runner.start(profile.id);assertSanitized(result);
  expect(result).toMatchObject({status:"completed",attempts:2,upperNanoUsd:108000,costNanoUsd:54000,reservedNanoUsd:TOTAL_RESERVE_NANO_USD});
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[0][1]).toMatchObject({method:"POST",redirect:"error"});
  expect(fetch.mock.calls[0][1].body).toBe(fetch.mock.calls[1][1].body);
  const ledger=fs.readFileSync(path.join(root,"ledger.json"),"utf8");expect(ledger).toContain(BODY_SHA256);expect(ledger).not.toContain(profile.apiKey);expect(ledger).not.toContain(profile.id);
  expect(await runner.start(profile.id)).toEqual(result);expect(fetch).toHaveBeenCalledTimes(2);
 });
 it("shares duplicate clicks and rejects a different ID while running",async()=>{
  let resolve!:(r:Response)=>void;
  const {runner,fetch}=setup(vi.fn(()=>new Promise<Response>(r=>{resolve=r;})));
  const first=runner.start(profile.id),same=runner.start(profile.id);
  expect(same).toBe(first);expect(await runner.start("foreign-id")).toMatchObject({status:"refused",attempts:0});
  resolve(response());await new Promise(r=>setImmediate(r));runner.cancel();resolve(response());
  const result=await first;expect(result.status).toBe("cancelled");assertSanitized(result);expect(fetch.mock.calls.length).toBeLessThanOrEqual(2);
 });
 it("never calls fetch without strict ID, valid price receipt or prearmed admission",async()=>{
  for (const mode of ["unknown","missing-arm","price-expired","over-budget","no-usd-price","damaged-arm"]) {
   const {runner,fetch,root,arm}=setup();
   if(mode==="missing-arm")fs.unlinkSync(path.join(root,"arm.json"));
   if(mode==="damaged-arm")fs.writeFileSync(path.join(root,"arm.json"),"?");
   if(mode==="price-expired")fs.writeFileSync(path.join(root,"arm.json"),JSON.stringify({...arm,expiresAt:now-1}));
   if(mode==="over-budget")fs.writeFileSync(path.join(root,"arm.json"),JSON.stringify({...arm,budgetNanoUsd:1}));
   if(mode==="no-usd-price")fs.writeFileSync(path.join(root,"arm.json"),JSON.stringify({...arm,inputNanoUsdPerToken:null}));
   const result=await runner.start(mode==="unknown"?"unknown":profile.id);expect(result.status).toBe("refused");expect(fetch).not.toHaveBeenCalled();assertSanitized(result);
  }
 });
 it("refuses an existing, damaged or previously spent ledger after restart; cannot reset with another profile",async()=>{
  for(const ledger of ["{}","?"]) {
   const {runner,fetch,root}=setup();fs.writeFileSync(path.join(root,"ledger.json"),ledger);
   expect((await runner.start(profile.id)).status).toBe("refused");expect(fetch).not.toHaveBeenCalled();
  }
  const {runner,fetch,root}=setup();await runner.start(profile.id);
  fs.unlinkSync(path.join(root,"ledger.json"));
  const restarted=createProbeRunner({root,resolveProfile:()=>profile,fetch,now:()=>now});
  expect((await restarted.start("another-id")).status).toBe("refused");expect(fetch).toHaveBeenCalledTimes(2);
 });
 it("allows only one of two Main instances to claim the same task",async()=>{
  const {runner,fetch,root}=setup();const second=createProbeRunner({root,resolveProfile:()=>profile,fetch,now:()=>now});
  const results=await Promise.all([runner.start(profile.id),second.start(profile.id)]);
  expect(results.map(r=>r.status).sort()).toEqual(["completed","refused"]);expect(fetch).toHaveBeenCalledTimes(2);
 });
 it.each(["http","network","missing-usage","model","oversize","malformed","bad-total"])("retains full ambiguous reservation and stops after %s",async mode=>{
  const fetch=vi.fn(async()=>{
   if(mode==="network")throw new Error(profile.apiKey);
   if(mode==="http")return new Response(profile.apiKey,{status:401});
   if(mode==="oversize")return new Response("x".repeat(65537));
   if(mode==="malformed")return new Response("{"+profile.apiKey);
   if(mode==="model")return response(undefined,{model:"deepseek-v4-pro"});
   if(mode==="missing-usage")return new Response(JSON.stringify({model:"deepseek-flash"}));
   return response({prompt_tokens:100,completion_tokens:20,total_tokens:121});
  });
  const {runner,root}=setup(fetch);const result=await runner.start(profile.id);
  expect(result).toMatchObject({status:"uncertain",attempts:1,upperNanoUsd:TOTAL_RESERVE_NANO_USD});expect(fetch).toHaveBeenCalledOnce();assertSanitized(result);
  expect(fs.readFileSync(path.join(root,"ledger.json"),"utf8")).not.toContain(profile.apiKey);
 });
 it.each([{is_byok:undefined},{is_byok:"true"},{is_byok:true},{cost_details:{upstream_inference_cost:2}},{cost_details:[]}])("stops after ambiguous billing source %j and retains the full USD reservation",async patch=>{
  const fetch=vi.fn(async()=>response({prompt_tokens:100,completion_tokens:20,total_tokens:120,cost:0,is_byok:false,...patch}));
  const {runner}=setup(fetch);const result=await runner.start(profile.id);
  expect(result).toMatchObject({status:"uncertain",attempts:1,upperNanoUsd:TOTAL_RESERVE_NANO_USD,reservedNanoUsd:TOTAL_RESERVE_NANO_USD});expect(fetch).toHaveBeenCalledOnce();
 });
 it("cancels before admission with zero fetch and consumes the process permit",async()=>{
  const {runner,fetch}=setup();runner.cancel();expect(await runner.start(profile.id)).toMatchObject({status:"cancelled",failure:{code:"CANCELLED"},costStatus:"unknown",costNanoUsd:null});expect(fetch).not.toHaveBeenCalled();
 });
 it("cancels hanging fetch even if injected transport ignores abort",async()=>{
  const {runner,fetch}=setup(vi.fn(()=>new Promise<Response>(()=>{})));
  const promise=runner.start(profile.id);runner.cancel();const result=await promise;
  expect(result).toMatchObject({status:"cancelled",attempts:1,upperNanoUsd:TOTAL_RESERVE_NANO_USD});expect(fetch).toHaveBeenCalledOnce();assertSanitized(result);
 });
 it("deadline bounds fetch and hanging response stream; no retry",async()=>{
  vi.useFakeTimers();
  for(const mode of ["fetch","body"]) {
   const {runner,fetch}=setup(vi.fn(async()=>mode==="body"?new Response(new ReadableStream({start(){}})):await new Promise<Response>(()=>{})));
   const result=runner.start(profile.id);await vi.advanceTimersByTimeAsync(30001);
   expect(await result).toMatchObject({status:"uncertain",attempts:1,upperNanoUsd:TOTAL_RESERVE_NANO_USD,failure:{code:"DEADLINE_EXCEEDED",stage:mode==="body"?"body":"network"}});expect(fetch).toHaveBeenCalledOnce();
  }
 });
 it("revokes an unused admission after cancel or another boot, including vanished ledger",async()=>{
  const {runner,fetch,root}=setup();runner.cancel();expect((await runner.start(profile.id)).status).toBe("cancelled");
  const restarted=createProbeRunner({root,resolveProfile:()=>profile,fetch,now:()=>now});
  expect((await restarted.start(profile.id)).status).toBe("refused");expect(fetch).not.toHaveBeenCalled();
 });
 it("never accepts an arm introduced after boot",async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"memory-openrouter-cold-"));roots.push(root);const fetch=vi.fn(async()=>response());
  const runner=createProbeRunner({root,resolveProfile:()=>profile,fetch,now:()=>now});
  fs.writeFileSync(path.join(root,"arm.json"),JSON.stringify({experimentId:EXPERIMENT_ID,priorAttempts:0,budgetNanoUsd:BUDGET_NANO_USD,priceVerifiedAt:now-1000,inputNanoUsdPerToken:300,outputNanoUsdPerToken:1200,currency:"USD",model:"deepseek/deepseek-v4.1-flash",endpoint:"https://openrouter.ai/api/v1/chat/completions",provider:"deepseek",maxAttempts:2,bodySha256:BODY_SHA256,expiresAt:now+3600000,armed:true}));
  expect((await runner.start(profile.id)).status).toBe("refused");expect(fetch).not.toHaveBeenCalled();
 });
 it("rechecks arm expiry before the repeat request",async()=>{
  let current=now;const fetch=vi.fn(async()=>{current=now+3600001;return response();});
  const {runner}=setup(fetch,{now:()=>current});
  const result=await runner.start(profile.id);expect(result.status).toBe("uncertain");expect(fetch).toHaveBeenCalledOnce();
 });
 it("stops on a non-completion object with superficially valid numeric usage",async()=>{
  const fetch=vi.fn(async()=>new Response(JSON.stringify({model:"deepseek/deepseek-v4.1-flash",provider:"DeepSeek",usage:{prompt_tokens:0,completion_tokens:0,total_tokens:0}})));
  const {runner}=setup(fetch);expect((await runner.start(profile.id)).status).toBe("uncertain");expect(fetch).toHaveBeenCalledOnce();
 });
 it.each(["http","content-length"])("closes rejected %s response streams and aborts transport",async mode=>{
  let cancelled=false,signal:AbortSignal|undefined;
  const fetch=vi.fn(async(_url:unknown,init?:RequestInit)=>{
   signal=init!.signal as AbortSignal;
   return new Response(new ReadableStream({cancel(){cancelled=true;}}),mode==="http"?{status:401}:{headers:{"Content-Length":"65537"}});
  });
  const {runner}=setup(fetch);expect((await runner.start(profile.id)).status).toBe("uncertain");
  expect(cancelled).toBe(true);expect(signal!.aborted).toBe(true);expect(fetch).toHaveBeenCalledOnce();
 });

 it("cancels a late response body arriving after abort",async()=>{
  let resolve!:(r:Response)=>void,cancelled=false;
  const {runner}=setup(vi.fn(()=>new Promise<Response>(r=>{resolve=r;})));
  const pending=runner.start(profile.id);runner.cancel();expect((await pending).status).toBe("cancelled");
  resolve(new Response(new ReadableStream({cancel(){cancelled=true;}})));
  await new Promise(r=>setImmediate(r));expect(cancelled).toBe(true);
 });

 it.each([
  ["network","NETWORK_FAILED","network",undefined], ["http","HTTP_REJECTED","http",401],
  ["body","BODY_READ_FAILED","body",200], ["oversize","BODY_TOO_LARGE","body",200],
  ["missing-body","BODY_MISSING","body",200], ["json","JSON_INVALID","json",200],
  ["envelope","ENVELOPE_INVALID","response",200], ["identity","IDENTITY_MISMATCH","identity",200],
  ["usage","USAGE_INVALID","usage",200], ["billing","BILLING_SOURCE_INVALID","cost",200],
  ["cost","COST_INVALID","cost",200],
 ])("records only a safe classification for %s",async(mode,code,stage,httpStatus)=>{
  const fetch=vi.fn(async()=>{
   if(mode==="network")throw Object.assign(new Error(profile.apiKey),{code:profile.apiKey,headers:{secret:profile.apiKey}});
   if(mode==="http")return new Response(profile.apiKey,{status:401,headers:{"X-Secret":profile.apiKey}});
   if(mode==="body")return new Response(new ReadableStream({start(c){c.error(new Error(profile.apiKey));}}));
   if(mode==="oversize")return new Response(profile.apiKey.repeat(4000));
   if(mode==="missing-body")return new Response(null);
   if(mode==="json")return new Response("{"+profile.apiKey);
   if(mode==="envelope")return response(undefined,{choices:[]});
   if(mode==="identity")return response(undefined,{model:profile.apiKey});
   if(mode==="usage")return response({prompt_tokens:profile.apiKey});
   if(mode==="billing")return response({is_byok:profile.apiKey,prompt_tokens:100,completion_tokens:20,total_tokens:120,cost:0});
   return response({is_byok:false,prompt_tokens:100,completion_tokens:20,total_tokens:120,cost:profile.apiKey});
  });
  const {runner,root}=setup(fetch);const r=await runner.start(profile.id);
  expect(r).toMatchObject({status:"uncertain",attempts:1,costNanoUsd:null,costStatus:"unknown",upperNanoUsd:TOTAL_RESERVE_NANO_USD,failure:{code,stage,...(httpStatus===undefined?{}:{httpStatus})}});
  expect(Object.keys(r.failure!).sort()).toEqual(httpStatus===undefined?["code","stage"]:["code","httpStatus","stage"]);
  expect(fetch).toHaveBeenCalledOnce();assertSanitized(r);const ledger=fs.readFileSync(path.join(root,"ledger.json"),"utf8");expect(ledger).not.toContain(profile.apiKey);expect(JSON.parse(ledger).receipt).toEqual(r);
 });
 it("keeps a partial confirmed cost when the second attempt fails",async()=>{
  const fetch=vi.fn(async()=>response()).mockResolvedValueOnce(response()).mockRejectedValueOnce(new Error(profile.apiKey));
  const {runner}=setup(fetch);const r=await runner.start(profile.id);
  expect(r).toMatchObject({status:"uncertain",attempts:2,costStatus:"partial",costNanoUsd:27000,upperNanoUsd:TOTAL_RESERVE_NANO_USD,failure:{code:"NETWORK_FAILED",stage:"network"}});expect(r.usage).toHaveLength(1);expect(fetch).toHaveBeenCalledTimes(2);
 });
 it("distinguishes a verified zero cost from missing evidence",async()=>{
  const {runner}=setup(vi.fn(async()=>response({is_byok:false,prompt_tokens:100,completion_tokens:20,total_tokens:120,cost:0})));
  expect(await runner.start(profile.id)).toMatchObject({status:"completed",costStatus:"complete",costNanoUsd:0});
 });
 it("classifies deadlines separately without copying transport errors",async()=>{
  vi.useFakeTimers();const {runner}=setup(vi.fn(()=>new Promise<Response>(()=>{})));const pending=runner.start(profile.id);await vi.advanceTimersByTimeAsync(30001);
  expect(await pending).toMatchObject({failure:{code:"DEADLINE_EXCEEDED",stage:"network"},costStatus:"unknown",costNanoUsd:null});
 });

 it.each([400,403,429,500,503])("preserves only numeric HTTP rejection status %i",async status=>{
  const {runner,fetch}=setup(vi.fn(async()=>new Response(profile.apiKey,{status,statusText:profile.apiKey,headers:{"X-Secret":profile.apiKey}})));
  const r=await runner.start(profile.id);expect(r.failure).toEqual({code:"HTTP_REJECTED",stage:"http",httpStatus:status});assertSanitized(r);expect(fetch).toHaveBeenCalledOnce();
 });
 it("classifies local journal creation failure without releasing its spent reservation",async()=>{
  const {runner,fetch,root}=setup();const original=fs.openSync;const spy=vi.spyOn(fs,"openSync").mockImplementation(((file:any,...args:any[])=>{if(String(file).endsWith("ledger.json"))throw new Error(profile.apiKey);return (original as any)(file,...args);}) as any);
  try {const r=await runner.start(profile.id);expect(r).toMatchObject({status:"uncertain",attempts:0,costStatus:"unknown",costNanoUsd:null,reservedNanoUsd:TOTAL_RESERVE_NANO_USD,failure:{code:"STORAGE_FAILED",stage:"storage"}});expect(fetch).not.toHaveBeenCalled();expect(fs.existsSync(path.join(root,"spent.json"))).toBe(true);assertSanitized(r);}finally{spy.mockRestore();}
 });
 it("rejects invalid content-length without returning its value",async()=>{
  const {runner}=setup(vi.fn(async()=>new Response(profile.apiKey,{headers:{"Content-Length":profile.apiKey}})));const r=await runner.start(profile.id);expect(r.failure).toEqual({code:"BODY_LENGTH_INVALID",stage:"body",httpStatus:200});assertSanitized(r);
 });

});
