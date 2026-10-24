import type {HistoryTemporalResult} from "../memory-history/history-temporal";
/** What the history index reported for a query: `ok`, or a budget that cut the result short. */
export type HistoryRetrievalStatus="ok"|"index-budget-exhausted"|"excerpt-budget-exhausted";
export interface ScopedHistoryCoverage {
 /** `complete` only when every selected session was read AND the retrieval itself was not cut short. */
 readonly status:"complete"|"insufficient";
 readonly selected:number;
 readonly covered:number;
 readonly diagnostics:readonly string[];
 /** Whether the retrieval over the covered sessions finished within its budgets. */
 readonly retrieval:"complete"|"index-budget-exhausted"|"excerpt-budget-exhausted";
 /** Present only when the query carried a time intent. Anything but `applied` means some history had no provable time. */
 readonly temporal?:HistoryTemporalResult["status"];
 /** Present only when some hits came back as a fragment of a longer conversation: each such hit is fully retrieved, but its content is partial. Does not make `status` insufficient. */
 readonly excerpted?:number;
}
interface Options {
 actors:readonly object[];
 assertCurrent():void;
 capture(actor:object):Promise<{status:"captured"|"coverage-insufficient";diagnostics:readonly string[];coverage?:"complete"|"partial"}>;
 query(coveredActors:object[]):Promise<{evidence:object;status:HistoryRetrievalStatus;temporal?:HistoryTemporalResult;/** How many returned hits are excerpts of a longer conversation. */excerpted?:number}>;
 /** The time intent the query was limited by, for the notice; the query callback owns applying it. */
 timeIntent?:{label:string};
}
const RETRIEVAL_CODES={"index-budget-exhausted":"MEMORY_HISTORY_INDEX_BUDGET_EXHAUSTED","excerpt-budget-exhausted":"MEMORY_HISTORY_EXCERPT_BUDGET_EXHAUSTED"} as const;
/** Partial availability never relaxes actor/source validation or invokes a legacy fallback. */
export async function queryScopedHistory(options:Options):Promise<{tokens:object[];coverage:ScopedHistoryCoverage;notice?:string}> {
 options.assertCurrent();
 let partialSources=false;
 const actors=[...options.actors],covered:object[]=[],diagnostics=new Set<string>();
 if(actors.length>31)diagnostics.add("MEMORY_HISTORY_SELECTION_BUDGET_EXHAUSTED");
 for(const actor of actors.slice(0,31)){
  options.assertCurrent();
  try{
   const result=await options.capture(actor);options.assertCurrent();
   if(result.status==="captured"){covered.push(actor);if(result.coverage==="partial"){partialSources=true;diagnostics.add("MEMORY_HISTORY_COVERAGE_INSUFFICIENT");for(const code of result.diagnostics)if(/^MEMORY_[A-Z0-9_]{1,100}$/.test(code))diagnostics.add(code)}}
   else if(result.status==="coverage-insufficient"){
    diagnostics.add("MEMORY_HISTORY_COVERAGE_INSUFFICIENT");
    for(const code of result.diagnostics)if(/^MEMORY_[A-Z0-9_]{1,100}$/.test(code))diagnostics.add(code);
   }else throw Error("MEMORY_HISTORY_CAPTURE_INVALID");
  }catch(error){
   options.assertCurrent();
   if(!(error instanceof Error)||!["MEMORY_HISTORY_NATIVE_UNAVAILABLE","MEMORY_HISTORY_COVERAGE_INSUFFICIENT"].includes(error.message))throw error;
   diagnostics.add(error.message);
  }
 }
 options.assertCurrent();
 const tokens:object[]=[];let retrieval:ScopedHistoryCoverage["retrieval"]="complete",temporal:HistoryTemporalResult|undefined,excerpted=0;
 if(covered.length){
  const outcome=await options.query(covered);options.assertCurrent();
  tokens.push(outcome.evidence);
  // A budget that cut the retrieval short is a gap in the result, however many sources were read.
  if(outcome.status!=="ok"){retrieval=outcome.status;diagnostics.add(RETRIEVAL_CODES[outcome.status])}
  temporal=outcome.temporal;excerpted=outcome.excerpted??0;
  // A time filter drops history whose time cannot be proved; that is a gap, not an empty answer.
  if(temporal&&temporal.status!=="applied")diagnostics.add(temporal.status==="partial"?"MEMORY_HISTORY_TEMPORAL_PARTIAL":"MEMORY_HISTORY_TEMPORAL_UNAVAILABLE");
 }
 const sourcesComplete=covered.length===actors.length&&!partialSources,timeComplete=!temporal||temporal.status==="applied";
 const coverage:ScopedHistoryCoverage=Object.freeze({status:sourcesComplete&&retrieval==="complete"&&timeComplete?"complete":"insufficient",selected:actors.length,covered:covered.length,diagnostics:Object.freeze([...diagnostics]),retrieval,...(temporal?{temporal:temporal.status}:{}),...(excerpted>0?{excerpted}:{})});
 const parts:string[]=[];
 if(!sourcesComplete)parts.push("历史检索覆盖不足，仅检索了已授权且来源可验证的会话；不能据此断言历史不存在。未修复或改写原会话，也未回退旧检索。");
 if(diagnostics.has("MEMORY_HISTORY_DISABLED_BY_FORGET"))parts.push("你执行过遗忘，被遗忘范围内的原始会话历史不再读取；本轮仅依据当前上下文回答，不能据此断言历史不存在。");
if(retrieval!=="complete")parts.push("历史检索结果不完整："+(retrieval==="index-budget-exhausted"?"候选历史超出索引预算，未能返回任何历史证据":"部分命中因摘录预算用尽被省略，只返回了其余命中")+"；不能据此断言历史不存在或已检索完整。");
 if(excerpted>0)parts.push("历史检索命中的 "+excerpted+" 份会话篇幅过长，只返回了其中与问题最相关的一段连续消息（证据里标明了消息范围和总条数），并非完整会话；这些会话的其余部分未被读取，不能据此断言片段之外没有相关内容。");
 if(temporal&&options.timeIntent){
  parts.push("已按时间限定检索历史："+options.timeIntent.label+"；该时间段之外的历史未被检索。");
  if(temporal.status!=="applied")parts.push("时间限定只部分生效："+temporal.unknownDocuments+" 份历史缺少可证明的时间，已被排除；不能据此断言该时间段没有相关历史。");
 }
 const notice=parts.length?parts.join("")+(coverage.status==="insufficient"||temporal||excerpted>0?"覆盖状态："+JSON.stringify(coverage):""):undefined;
 return {tokens,coverage,...(notice?{notice}:{})};
}
