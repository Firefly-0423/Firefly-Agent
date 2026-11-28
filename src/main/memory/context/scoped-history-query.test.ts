import { expect, it, vi } from "vitest";
import { queryScopedHistory } from "./scoped-history-query";
it('keeps proven recovered evidence while declaring partial source coverage',async()=>{
 const evidence={},result=await queryScopedHistory({actors:[{}],assertCurrent:()=>{},capture:async()=>({status:'captured',coverage:'partial',diagnostics:['MEMORY_HISTORY_ORIGIN_UNPROVEN']}),query:async()=>({evidence,status:'ok'})});
 expect(result.tokens).toEqual([evidence]);expect(result.coverage).toMatchObject({status:'insufficient',covered:1});expect(result.notice).toContain('MEMORY_HISTORY_ORIGIN_UNPROVEN');
});
it("returns actual covered evidence with an explicit missing-snapshot notice",async()=>{
 const a={},b={},evidence={},query=vi.fn(async()=>({evidence,status:"ok" as const}));
 const result=await queryScopedHistory({actors:[a,b],assertCurrent:()=>{},capture:async actor=>actor===a?{status:"captured",diagnostics:[]}:{status:"coverage-insufficient",diagnostics:["MEMORY_HISTORY_SNAPSHOT_MISSING"]},query});
 expect(query).toHaveBeenCalledWith([a]);expect(result.tokens).toEqual([evidence]);expect(result.coverage).toMatchObject({status:"insufficient",selected:2,covered:1});expect(result.notice).toContain("MEMORY_HISTORY_SNAPSHOT_MISSING");expect(result.notice).toContain("不能据此断言历史不存在");
});
it("a missing native helper leaves a clear coverage gap rather than an empty-history claim",async()=>{
 const query=vi.fn();const result=await queryScopedHistory({actors:[{}],assertCurrent:()=>{},capture:async()=>{throw Error("MEMORY_HISTORY_NATIVE_UNAVAILABLE")},query});
 expect(query).not.toHaveBeenCalled();expect(result.tokens).toEqual([]);expect(result.notice).toContain("MEMORY_HISTORY_NATIVE_UNAVAILABLE");expect(result.coverage.status).toBe("insufficient");
});
it.each(["MEMORY_ACTOR_DENIED","MEMORY_HISTORY_STALE","private raw failure"])("never hides an authorization or integrity failure as partial coverage: %s",async code=>{
 await expect(queryScopedHistory({actors:[{}],assertCurrent:()=>{},capture:async()=>{throw Error(code)},query:vi.fn()})).rejects.toThrow(code);
});
it("a forgotten actor is a reported coverage gap: nothing is read for it and the turn is not failed",async()=>{
 const a={},b={},evidence={},query=vi.fn(async()=>({evidence,status:"ok" as const}));
 const result=await queryScopedHistory({actors:[a,b],assertCurrent:()=>{},capture:async actor=>actor===a?{status:"captured",diagnostics:[]}:{status:"coverage-insufficient",diagnostics:["MEMORY_HISTORY_COVERAGE_INSUFFICIENT","MEMORY_HISTORY_DISABLED_BY_FORGET"]},query});
 expect(query).toHaveBeenCalledWith([a]);expect(result.coverage).toMatchObject({status:"insufficient",selected:2,covered:1});
 expect(result.coverage.diagnostics).toContain("MEMORY_HISTORY_DISABLED_BY_FORGET");expect(result.notice).toContain("遗忘");expect(result.notice).toContain("不能据此断言历史不存在");
});
it("when every actor is forgotten there is no retrieval and the answer proceeds on the current context",async()=>{
 const query=vi.fn();const result=await queryScopedHistory({actors:[{}],assertCurrent:()=>{},capture:async()=>({status:"coverage-insufficient",diagnostics:["MEMORY_HISTORY_DISABLED_BY_FORGET"]}),query});
 expect(query).not.toHaveBeenCalled();expect(result.tokens).toEqual([]);expect(result.coverage.status).toBe("insufficient");expect(result.notice).toContain("遗忘");
});
it("bounds actual reads while reporting the entire authorized selection",async()=>{
 const actors=Array.from({length:40},()=>({})),capture=vi.fn(async()=>({status:"captured" as const,diagnostics:[]}));
 const result=await queryScopedHistory({actors,assertCurrent:()=>{},capture,query:async()=>({evidence:{},status:"ok" as const})});expect(capture).toHaveBeenCalledTimes(31);expect(result.coverage).toMatchObject({selected:40,covered:31,status:"insufficient"});expect(result.notice).toContain("MEMORY_HISTORY_SELECTION_BUDGET_EXHAUSTED");
});
const captured=async()=>({status:"captured" as const,diagnostics:[]});
it("a fully covered selection with a complete retrieval stays complete and carries no notice",async()=>{
 const result=await queryScopedHistory({actors:[{},{}],assertCurrent:()=>{},capture:captured,query:async()=>({evidence:{},status:"ok"})});
 expect(result.coverage).toMatchObject({status:"complete",selected:2,covered:2,retrieval:"complete"});expect(result.coverage.diagnostics).toEqual([]);expect(result.notice).toBeUndefined();
});
it.each([["index-budget-exhausted","MEMORY_HISTORY_INDEX_BUDGET_EXHAUSTED"],["excerpt-budget-exhausted","MEMORY_HISTORY_EXCERPT_BUDGET_EXHAUSTED"]] as const)("a %s retrieval is never reported as complete even when every source was read",async(status,code)=>{
 const evidence={},result=await queryScopedHistory({actors:[{}],assertCurrent:()=>{},capture:captured,query:async()=>({evidence,status})});
 expect(result.tokens).toEqual([evidence]);
 expect(result.coverage).toMatchObject({status:"insufficient",selected:1,covered:1,retrieval:status});expect(result.coverage.diagnostics).toContain(code);
 expect(result.notice).toContain(code);expect(result.notice).toContain("历史检索结果不完整");expect(result.notice).toContain("不能据此断言历史不存在");
});
it("an incomplete source selection and an exhausted retrieval budget are both reported",async()=>{
 const a={},b={},result=await queryScopedHistory({actors:[a,b],assertCurrent:()=>{},capture:async actor=>actor===a?{status:"captured",diagnostics:[]}:{status:"coverage-insufficient",diagnostics:["MEMORY_HISTORY_SNAPSHOT_MISSING"]},query:async()=>({evidence:{},status:"excerpt-budget-exhausted"})});
 expect(result.coverage).toMatchObject({status:"insufficient",selected:2,covered:1,retrieval:"excerpt-budget-exhausted"});
 for(const code of ["MEMORY_HISTORY_SNAPSHOT_MISSING","MEMORY_HISTORY_EXCERPT_BUDGET_EXHAUSTED"])expect(result.coverage.diagnostics).toContain(code);
 expect(result.notice).toContain("历史检索覆盖不足");expect(result.notice).toContain("历史检索结果不完整");
});
it("no covered session means no retrieval and no retrieval claim",async()=>{
 const result=await queryScopedHistory({actors:[{}],assertCurrent:()=>{},capture:async()=>({status:"coverage-insufficient",diagnostics:[]}),query:vi.fn()});
 expect(result.coverage.retrieval).toBe("complete");expect(result.coverage.status).toBe("insufficient");
});
const label="上周（2026-10-05 至 2026-10-11，时区 Asia/Shanghai）";
it("tells the model which time window was applied without calling the result incomplete",async()=>{
 const result=await queryScopedHistory({actors:[{}],assertCurrent:()=>{},capture:captured,timeIntent:{label},query:async()=>({evidence:{},status:"ok",temporal:{kind:"range",status:"applied",unknownDocuments:0}})});
 expect(result.coverage).toMatchObject({status:"complete",retrieval:"complete",temporal:"applied"});expect(result.coverage.diagnostics).toEqual([]);
 expect(result.notice).toContain("已按时间限定检索历史");expect(result.notice).toContain(label);expect(result.notice).not.toContain("不完整");
});
it.each([["partial",2,"MEMORY_HISTORY_TEMPORAL_PARTIAL"],["unavailable",3,"MEMORY_HISTORY_TEMPORAL_UNAVAILABLE"]] as const)("a %s time filter is a gap: documents without provable time were excluded",async(status,unknownDocuments,code)=>{
 const result=await queryScopedHistory({actors:[{}],assertCurrent:()=>{},capture:captured,timeIntent:{label},query:async()=>({evidence:{},status:"ok",temporal:{kind:"range",status,unknownDocuments}})});
 expect(result.coverage).toMatchObject({status:"insufficient",temporal:status});expect(result.coverage.diagnostics).toContain(code);
 expect(result.notice).toContain(String(unknownDocuments));expect(result.notice).toContain("缺少可证明的时间");expect(result.notice).toContain("不能据此断言该时间段没有相关历史");
});
it("without a time intent nothing about time is reported",async()=>{
 const result=await queryScopedHistory({actors:[{}],assertCurrent:()=>{},capture:captured,query:async()=>({evidence:{},status:"ok"})});
 expect(result.coverage.temporal).toBeUndefined();expect(result.notice).toBeUndefined();
});
it("rechecks live authority and does not query after cancellation",async()=>{
 let live=true;const query=vi.fn();await expect(queryScopedHistory({actors:[{}],assertCurrent:()=>{if(!live)throw Error("MEMORY_RUN_CANCELLED")},capture:async()=>{live=false;return {status:"captured",diagnostics:[]}},query})).rejects.toThrow("MEMORY_RUN_CANCELLED");expect(query).not.toHaveBeenCalled();
});
it("an excerpted hit is a complete retrieval of that hit but partial content, and the notice says so instead of reporting plain complete",async()=>{
 const result=await queryScopedHistory({actors:[{}],assertCurrent:()=>{},capture:captured,query:async()=>({evidence:{},status:"ok",excerpted:2})});
 expect(result.coverage).toMatchObject({status:"complete",selected:1,covered:1,retrieval:"complete",excerpted:2});expect(result.coverage.diagnostics).toEqual([]);
 expect(result.notice).toContain("2 份");expect(result.notice).toContain("连续消息");expect(result.notice).toContain("消息范围和总条数");expect(result.notice).toContain("并非完整会话");expect(result.notice).toContain("不能据此断言片段之外没有相关内容");
 expect(result.notice).toContain('"excerpted":2');expect(result.notice).not.toContain("历史检索结果不完整");
});
it.each([undefined,0])("no excerpt note and no excerpted count when excerpted is %s",async excerpted=>{
 const result=await queryScopedHistory({actors:[{}],assertCurrent:()=>{},capture:captured,query:async()=>({evidence:{},status:"ok",...(excerpted===undefined?{}:{excerpted})})});
 expect(result.notice).toBeUndefined();expect(result.coverage.excerpted).toBeUndefined();expect(Object.keys(result.coverage)).not.toContain("excerpted");
});
it("an excerpt note never hides an exhausted budget: both are reported",async()=>{
 const result=await queryScopedHistory({actors:[{}],assertCurrent:()=>{},capture:captured,query:async()=>({evidence:{},status:"excerpt-budget-exhausted",excerpted:1})});
 expect(result.coverage).toMatchObject({status:"insufficient",retrieval:"excerpt-budget-exhausted",excerpted:1});expect(result.notice).toContain("历史检索结果不完整");expect(result.notice).toContain("并非完整会话");
});
