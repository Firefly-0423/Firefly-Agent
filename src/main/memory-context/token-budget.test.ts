import {it,expect} from "vitest";

const identity={providerId:"synthetic",model:"synthetic-model",transport:"synthetic",framingVersion:"v1"};
const budget={maxContextTokens:10000,maxInputTokens:10000,reservedOutputTokens:64,safetyMarginTokens:16,maxSTokens:10000,minRecentCompleteTurns:1};
const unit=(id:string,text:string)=>({id,kind:"recent" as const,messages:[{role:"user" as const,text}]});
function fixture(options:Record<string,unknown>={}){
 const prepare=(units:any[])=>({...identity,inputTypes:["text"],body:{system:"fixed",messages:units.flatMap(u=>u.messages)}});
 const prepareS=(units:any[])=>({...identity,inputTypes:["text"],body:{messages:units.flatMap(u=>u.messages)}});
 const counter={capability:{...identity,mode:"exact" as const,inputTypes:["text"]},count:async(request:any)=>JSON.stringify(request.body).length};
 return {counter,budget,prepare,prepareS,units:[unit("old","旧上下文"),unit("new","中文 English 🌱 e\u0301")],...options};
}
it("counts the complete immutable prepared request and preserves Unicode",async()=>{
 const {selectBudget}=await import("./token-budget"),input=fixture(),result=await selectBudget(input);
 expect(result.selectedIds).toEqual(["old","new"]);expect(result.promptTokens).toBe(JSON.stringify(result.request.body).length);
 expect(result.request.body.messages[1].text).toBe("中文 English 🌱 e\u0301");expect(Object.isFrozen(result.request.body.messages[1])).toBe(true);
});
it("recounts whole requests rather than adding nonadditive part counts",async()=>{
 const {selectBudget}=await import("./token-budget");
 const input=fixture({budget:{...budget,maxInputTokens:15},counter:{capability:{...identity,mode:"exact",inputTypes:["text"]},count:async(r:any)=>r.body.messages.length===2?30:10}});
 const r=await selectBudget(input);expect(r.selectedIds).toEqual(["new"]);expect(r.promptTokens).toBe(10);
});
it("accepts exact boundary and removes only complete oldest optional units",async()=>{
 const {selectBudget}=await import("./token-budget"),input=fixture(),limit=JSON.stringify(input.prepare([input.units[1]]).body).length;
 const r=await selectBudget({...input,budget:{...budget,maxInputTokens:limit}});expect(r.selectedIds).toEqual(["new"]);expect(r.promptTokens).toBe(limit);
});
it("reserves actual 32768 output bound instead of the legacy 8192 assumption",async()=>{
 const {selectBudget}=await import("./token-budget"),input=fixture();
 const r=await selectBudget({...input,budget:{...budget,maxContextTokens:35000,reservedOutputTokens:8192,safetyMarginTokens:512},prepare:(u:any[])=>({...input.prepare(u),maxOutputTokens:32768})});
 expect(r.inputLimit).toBe(1720);
});
it("wire output fields override stale reservation metadata",async()=>{
 const {selectBudget}=await import("./token-budget"),input=fixture();
 const r=await selectBudget({...input,budget:{...budget,maxContextTokens:35000,reservedOutputTokens:8192,safetyMarginTokens:512},prepare:(u:any[])=>({...input.prepare(u),maxOutputTokens:8192,body:{...input.prepare(u).body,max_tokens:32768}})});
 expect(r.inputLimit).toBe(1720);
});
it("asynchronous count cannot change the supplied budget policy",async()=>{
 const {selectBudget}=await import("./token-budget"),input=fixture(),local={...budget,maxInputTokens:40};
 await expect(selectBudget({...input,budget:local,counter:{...input.counter,count:async(r:any)=>{local.maxInputTokens=10000;return JSON.stringify(r.body).length}}})).rejects.toMatchObject({code:"MEMORY_CONTEXT_RECENT_OVER_BUDGET"});
});
it.each([-1,NaN,1.5,Infinity])("invalid counter result %s is not accepted",async value=>{
 const {selectBudget}=await import("./token-budget"),input=fixture();await expect(selectBudget({...input,counter:{...input.counter,count:async()=>value}})).rejects.toMatchObject({code:"MEMORY_CONTEXT_COUNT_FAILED"});
});
it.each([undefined,0,-1,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])("unknown or invalid context limit %s has no default fallback",async limit=>{
 const {selectBudget}=await import("./token-budget");await expect(selectBudget(fixture({budget:{...budget,maxContextTokens:limit}}))).rejects.toMatchObject({code:limit===undefined?"MEMORY_CONTEXT_BUDGET_UNKNOWN":"MEMORY_CONTEXT_INPUT_INVALID"});
});
it("fixed mandatory prompt overflow is explicit and never trims it",async()=>{
 const {selectBudget}=await import("./token-budget");await expect(selectBudget(fixture({budget:{...budget,maxInputTokens:1}}))).rejects.toMatchObject({code:"MEMORY_CONTEXT_FIXED_OVER_BUDGET"});
});
it("protected complete recent turns cannot be silently dropped",async()=>{
 const {selectBudget}=await import("./token-budget"),input=fixture(),fixed=JSON.stringify(input.prepare([]).body).length;
 await expect(selectBudget({...input,budget:{...budget,maxInputTokens:fixed+1}})).rejects.toMatchObject({code:"MEMORY_CONTEXT_RECENT_OVER_BUDGET"});
});
it("estimated count is unproven rather than falsely called over budget",async()=>{
 const {selectBudget}=await import("./token-budget"),input=fixture();
 await expect(selectBudget({...input,counter:{...input.counter,capability:{...input.counter.capability,mode:"estimate"}}})).rejects.toMatchObject({code:"MEMORY_CONTEXT_BUDGET_UNPROVEN"});
});
it.each(["model","transport","framingVersion","providerId"])("counter must match final %s",async field=>{
 const {selectBudget}=await import("./token-budget"),input=fixture();await expect(selectBudget({...input,counter:{...input.counter,capability:{...input.counter.capability,[field]:"other"}}})).rejects.toMatchObject({code:"MEMORY_CONTEXT_COUNTER_UNSUPPORTED"});
});
it("image capability must be declared, never substituted by a 4096 estimate",async()=>{
 const {selectBudget}=await import("./token-budget"),input=fixture();await expect(selectBudget({...input,prepare:(u:any[])=>({...input.prepare(u),inputTypes:["image"]})})).rejects.toMatchObject({code:"MEMORY_CONTEXT_COUNTER_UNSUPPORTED"});
});
it("counter exceptions disclose only typed reason without provider payload",async()=>{
 const {selectBudget}=await import("./token-budget"),input=fixture();const p=selectBudget({...input,counter:{...input.counter,count:async()=>{throw new Error("SECRET_CANARY")}}});
 await expect(p).rejects.toMatchObject({code:"MEMORY_CONTEXT_COUNT_FAILED",message:"MEMORY_CONTEXT_COUNT_FAILED"});
});
it("cancellation after async count yields no partial result",async()=>{
 const {selectBudget}=await import("./token-budget"),input=fixture(),controller=new AbortController();await expect(selectBudget({...input,signal:controller.signal,counter:{...input.counter,count:async()=>{controller.abort();return 10}}})).rejects.toMatchObject({code:"MEMORY_CONTEXT_CANCELLED"});
});
it("tool call and result remain one complete unit",async()=>{
 const {selectBudget}=await import("./token-budget"),input=fixture(),tool={id:"tool",kind:"recent" as const,messages:[{role:"assistant" as const,text:"",toolCallIds:["call"]},{role:"tool" as const,text:"result",toolCallId:"call"}]};
 const r=await selectBudget({...input,units:[input.units[0],tool]});expect(r.request.body.messages.slice(-2).map((m:any)=>m.role)).toEqual(["assistant","tool"]);
 await expect(selectBudget({...input,units:[{...tool,messages:tool.messages.slice(0,1)}]})).rejects.toMatchObject({code:"MEMORY_CONTEXT_TOOL_PAIR_INVALID"});
});
it("request identity/body digests differ for cache, tools and transport",async()=>{
 const {selectBudget}=await import("./token-budget"),input=fixture(),a=await selectBudget(input),b=await selectBudget({...input,prepare:(u:any[])=>({...input.prepare(u),body:{...input.prepare(u).body,tools:[{name:"x"}],cache:"v2"}})});
 expect(a.requestDigest).not.toBe(b.requestDigest);
});
it("freezes without changing the prepared serializer's property order", async () => {
 const {freezeRequest,requestDigest}=await import("./token-budget");
 const original={...identity,inputTypes:["text"],body:{model:"synthetic-model",messages:[{role:"user",content:"保留顺序"}],stream:true}};
 const frozen=freezeRequest(original);
 expect(JSON.stringify(frozen.body)).toBe(JSON.stringify(original.body));
 expect(Object.isFrozen(frozen.body.messages[0])).toBe(true);
 expect(requestDigest(frozen)).toBe(requestDigest(original));
});
it("keeps established history metadata valid through its own authoritative parser",async()=>{
 const {parseHistoryDocument}=await import("../memory-history/history-repository");
 const document={id:"history-a",incarnation:"incarnation-a",revision:1,origin:"synthetic-import",sourceDeps:[],messages:[{id:"history-message-a",role:"user",text:"history evidence",occurredAt:1000,timeZone:"Etc/UTC"}],vector:null};
 expect(parseHistoryDocument(document)).toEqual(document);
});
