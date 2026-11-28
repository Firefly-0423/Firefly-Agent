import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { buildFixedRequest, sanitizeUsage, BODY_SHA256, MODEL, ENDPOINT, BUDGET_NANO_USD, ATTEMPT_RESERVE_NANO_USD } from "./boundary";
import { createSessionProfile } from "./session-profile";
const key="SYNTHETIC-NONCREDENTIAL-ONLY";
const profile=()=>createSessionProfile(key,"synthetic-id");
const envelope={id:"synthetic-result",object:"chat.completion",provider:"DeepSeek",model:"deepseek/deepseek-v4.1-flash",choices:[{index:0,message:{role:"assistant",content:key},finish_reason:"stop"}]};
const usage={is_byok:false,prompt_tokens:100,completion_tokens:20,total_tokens:120,cost:0.000027,completion_tokens_details:{reasoning_tokens:0},prompt_tokens_details:{cached_tokens:10}};
describe("OpenRouter fixed USD experiment boundary",()=>{
 it("locks host, exact Flash model, provider, token and price caps without fallback",()=>{
  const r=buildFixedRequest(profile()); const body=JSON.parse(r.body);
  expect(r.url).toBe("https://openrouter.ai/api/v1/chat/completions");expect(ENDPOINT).toBe(r.url);expect(MODEL).toBe("deepseek/deepseek-v4.1-flash");
  expect(body).toMatchObject({model:MODEL,max_tokens:256,stream:false,reasoning:{enabled:false},provider:{only:["deepseek"],allow_fallbacks:false,require_parameters:true,max_price:{prompt:0.3,completion:1.2,request:0,image:0}},plugins:[]});
  expect(body).not.toHaveProperty("models");expect(body).not.toHaveProperty("preset");expect(r.body).not.toContain(key);
  expect(createHash("sha256").update(r.body).digest("hex")).toBe(BODY_SHA256);expect(Buffer.byteLength(r.body)).toBeLessThan(4096);
  expect(BUDGET_NANO_USD).toBe(1_000_000_000);expect(ATTEMPT_RESERVE_NANO_USD).toBe(314_880_000);expect(2*ATTEMPT_RESERVE_NANO_USD).toBeLessThan(BUDGET_NANO_USD);
 });
 it("rejects altered destination/model/profile and malformed credential without echo",()=>{
  for(const change of [{model:"deepseek/deepseek-chat"},{baseUrl:"https://api.deepseek.com"},{provider:"DeepSeek"},{explicitTransport:"responses"},{apiKey:""}]) expect(()=>buildFixedRequest({...profile(),...change} as ReturnType<typeof profile>)).toThrow("PROFILE_REFUSED");
  for(const value of [null,{},"", "x".repeat(513),"invalid\r\nheader-secret", "with spaces not allowed"]) expect(()=>createSessionProfile(value,"id")).toThrow("KEY_REFUSED");
 });
 it("returns only numeric usage, counted cost and cache/reasoning counters",()=>{
  expect(sanitizeUsage({...envelope,usage})).toEqual({promptTokens:100,completionTokens:20,totalTokens:120,costNanoUsd:27000,upperNanoUsd:54000,cacheHitTokens:10,reasoningTokens:0});
  expect(JSON.stringify(sanitizeUsage({...envelope,usage}))).not.toContain(key);
 });
 it.each([{cost:-1},{cost:NaN},{cost:1},{cost:undefined},{completion_tokens:257},{prompt_tokens:1048577},{total_tokens:121},{completion_tokens_details:{reasoning_tokens:1}},{prompt_tokens_details:{cached_tokens:101}},{is_byok:true},{is_byok:undefined},{is_byok:null},{is_byok:"true"},{is_byok:0},{cost_details:{upstream_inference_cost:2}},{cost_details:{upstream_inference_cost:"0"}},{cost_details:{upstream_inference_cost:-1}},{cost_details:[]},{cost_details:null}])("rejects unsafe billing or usage %j",patch=>{
  expect(sanitizeUsage({...envelope,usage:{...usage,...patch}})).toBeNull();
 });
 it.each([undefined,{}, {upstream_inference_cost:null},{upstream_inference_cost:0}])("accepts supported balance billing detail %j",details=>{
  expect(sanitizeUsage({...envelope,usage:{...usage,cost_details:details}})?.costNanoUsd).toBe(27000);
 });
 it("rejects response from another model/provider, malformed envelope, or raw error",()=>{
  for(const patch of [{model:"deepseek/deepseek-v4-flash"},{provider:"Other"},{object:"error"},{id:""},{choices:[]},{error:{message:key}}])expect(sanitizeUsage({...envelope,usage,...patch})).toBeNull();
 });
});
