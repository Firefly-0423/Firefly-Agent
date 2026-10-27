import {assertContextSecretFree} from "./source-secret-screen";
import {readHistoryEvidence,validateHistoryEvidence,claimHistoryResponseEvidence,type HistoryResponseBinding,type HistoryResponseEvidence} from "../memory-history/main-history";
import {createHash,randomUUID} from "node:crypto";
import {canonicalJson} from "../memory-core/repository-types";
import type {BoundSourceRef,FactView} from "../../shared/memory-contracts";
import {parseSourceRef,parseInternalId,objectFields} from "../memory-core/command-validation";
import {requireMainAccess} from "../memory-core/main-access";
import type {MainActorAuthority,MainActorContext} from "../memory-core/main-actor-authority";
import type {createMainSourceRegistry} from "../memory-sources/source-registry";
import {extractMaintenance} from "../memory-policy/maintenance-extractor";
import {claimSubjectKeys} from "../memory-policy/policy-repository";
import {resolveProject} from "../memory-policy/project-scope";
import {ContextError,contextFail,CONTEXT_CLAIM_WINDOW_MS,type ContextBudget,type TokenCounter,type ContextUnit,type PreparedRequest,type BudgetResult,type ContextTransport,type SourceDependency,type FactDependency,type TranscriptDependency,type StoredSummary,type SummaryReceipt,type SummaryCounting,type SummarySegment} from "./context-contracts";
import {selectBudget,requestDigest,freezeRequest,countPrepared,countPreparedForAdmission} from "./token-budget";
import {parseCanonicalTranscript,requireMainTranscriptProvider,type TranscriptEventSource} from "./main-transcript-provider";
import type {TranscriptEntry} from "../orchestrator/conversation-transcript-types";
import type {ContextFact} from "./context-contracts";

interface ContextOptions {
 /** Main run grant must authorize each source before source-provider I/O. */
 authorizeSourceRead?:(actor:MainActorContext,ref:BoundSourceRef)=>void;
 clock?:()=>number;
 /** Set only when prepare serializes exact support provenance into the counted body. */
 includeFactSupportMetadata?:boolean;
 registry:ReturnType<typeof createMainSourceRegistry>;transport:ContextTransport;actorAuthority:MainActorAuthority;counter:TokenCounter;budget:ContextBudget;
 prepare:(units:ContextUnit[],facts:ContextFact[])=>PreparedRequest;prepareS:(units:ContextUnit[])=>PreparedRequest;
 /** Trusted Main provenance resolver, never a renderer supplied ancestry declaration. */
 resolveDerivedRefs?:(ref:BoundSourceRef)=>BoundSourceRef[]|null;
}
interface ContextInput {sessionId:string;sourceRefs:BoundSourceRef[];factRefs?:FactDependency[];currentUserSourceRef?:BoundSourceRef;transcriptTokens?:object[];currentTranscript?:{token:object;user?:{turnId:string;revision:number}};summaryIds?:string[];historyTokens?:object[];signal?:AbortSignal}
type Snapshot=BudgetResult&{snapshotId:string;generation:number;excluded:{sourceId:string;reason:string}[]};
interface ResponseProgress {operationId:string;expectedRefs:TranscriptDependency[];check:()=>void}
interface SnapshotState {actorToken:object;actor:MainActorContext;units:ContextUnit[];facts:ContextFact[];snapshot:Snapshot;sourceRefs:BoundSourceRef[];transcripts:TranscriptState[];historyTokens:object[];configuration:string;responseProgress?:ResponseProgress;claimed?:boolean;historyResponse?:HistoryContinuation}
interface HistoryContinuation {cap:object;state:SnapshotState;binding:HistoryResponseBinding;evidence:HistoryResponseEvidence[];phase:number;active:boolean;ticket?:object;observed:boolean;receipt?:object}
interface PermitState {snapshot:SnapshotState;id:string;used:boolean}
interface TranscriptState {actorToken:object;ref:TranscriptDependency;unit:ContextUnit;sourceRefs:BoundSourceRef[];adapter:object;locator:string;guardRefs:TranscriptDependency[];provenance?:TranscriptEventSource[];firstSeq?:number;lastSeq?:number}
interface LeaseState {actorToken:object;id:string;summaryId:string;commandId:string;inputRefs:BoundSourceRef[];transcripts?:TranscriptState[];inputTranscriptRefs?:TranscriptDependency[];beforeUnits?:ContextUnit[];signal?:AbortSignal;includeCounting?:boolean}
/** Isolated Main seam; no IPC, product caller, account request or prompt dump. */
export function createMainContext(options:ContextOptions){
 if(options.registry.coordinator!==options.actorAuthority.coordinate)contextFail("MEMORY_CONTEXT_COORDINATOR_REQUIRED");
 const bootId=randomUUID(),snapshots=new WeakMap<object,SnapshotState>(),permits=new WeakMap<object,PermitState>(),transcriptTokens=new WeakMap<object,TranscriptState>(),transcriptHeads=new Map<string,TranscriptState>(),leases=new WeakMap<object,LeaseState>();
 const changeReceipts=new WeakMap<object,{actorToken:object;generation:number;operationId:string;refs:TranscriptDependency[]}>();
 const continuations=new WeakMap<object,HistoryContinuation>(),activeContinuations=new Map<object,HistoryContinuation>();
 const includeFactSupportMetadata=options.includeFactSupportMetadata===true;
 function actor(token:object):MainActorContext {const a=options.actorAuthority.requireActor(token);if(a.sessionMode==="temporary")contextFail("MEMORY_CONTEXT_TEMPORARY_UNSUPPORTED");return a}
 function owner(a:MainActorContext){return {actorKey:a.actorKey,providerId:a.providerId,sessionId:a.sessionId,bootId}}
 function configuration(){return canonicalJson({budget:options.budget,counter:options.counter.capability,includeFactSupportMetadata})}
 function command<T>(a:MainActorContext,kind:string,body:object,commandId?:string):Promise<T>{return options.transport.contextCommand({kind,scopeKey:a.scopeKey,...(commandId?{commandId}:{}),body:{...owner(a),...body}}) as Promise<T>}
 function checkedRef(a:MainActorContext,value:unknown):BoundSourceRef {
  const ref=parseSourceRef(value);if(!ref.binding||ref.span||ref.binding.providerId!==a.providerId||ref.binding.sessionId!==a.sessionId)contextFail("MEMORY_CONTEXT_ACCESS_DENIED");requireMainAccess(a.access).verifySource(ref);return ref as BoundSourceRef;
 }
 async function readSource(a:MainActorContext,ref:BoundSourceRef):Promise<string>{
  try{options.authorizeSourceRead?.(a,ref);return await options.registry.readEvidence(a.access,a.adapter,ref)}catch(error){if(error instanceof Error&&/^MEMORY_[A-Z0-9_]{1,100}$/.test(error.message))throw error;contextFail("MEMORY_CONTEXT_SOURCE_READ_FAILED")}
 }
 async function readFactSupports(a:MainActorContext,facts:ContextFact[]):Promise<void>{
  if(!includeFactSupportMetadata)return;
  const refs=facts.flatMap(f=>[...f.supportSourceRefs,...(f.typed?[f.sourceRef]:[])]);
  for(const ref of [...new Map(refs.map(ref=>[canonicalJson(ref),ref])).values()]){
   if(!ref.binding||ref.span||ref.binding.providerId!==a.providerId)contextFail("MEMORY_CONTEXT_ACCESS_DENIED");
   const supportActor=options.actorAuthority.requireActor(options.actorAuthority.bindActor(a.access,a.adapter,{providerId:ref.binding.providerId,sessionId:ref.binding.sessionId,messageId:ref.binding.messageId}));
   if(supportActor.actorKey!==a.actorKey||supportActor.scopeKey!==a.scopeKey)contextFail("MEMORY_ACTOR_DENIED");
   await readSource(a,ref as BoundSourceRef);
  }
 }
 function snapshotState(token:object,value:object):SnapshotState {actor(token);const state=snapshots.get(value);if(!state||state.actorToken!==token)contextFail("MEMORY_CONTEXT_SNAPSHOT_DENIED");return state}
 function transcriptState(token:object,value:object):TranscriptState {actor(token);const state=transcriptTokens.get(value);if(!state||state.actorToken!==token)contextFail("MEMORY_CONTEXT_TRANSCRIPT_DENIED");return state}
 async function corpus(a:MainActorContext,refs:BoundSourceRef[]){
  const deps:SourceDependency[]=[],messages=new Map<string,ContextUnit["messages"][number]>();
  async function read(ref:BoundSourceRef):Promise<void>{
   const existing=deps.find(d=>d.sourceRef.sourceId===ref.sourceId);if(existing){if(canonicalJson(existing.sourceRef)!==canonicalJson(ref))contextFail("MEMORY_SOURCE_STALE");return}if(deps.length>=1000)contextFail("MEMORY_CONTEXT_INPUT_INVALID");
   const text=await readSource(a,ref),verified=options.registry.resolveVerifiedSource(ref),parsed=extractMaintenance(text),origins=options.resolveDerivedRefs?.(ref)??null;
   let secret=false;try{assertContextSecretFree(text)}catch(error){if(error instanceof Error&&error.message==="MEMORY_CONTEXT_TRANSCRIPT_SECRET")secret=true;else throw error}
   deps.push({sourceRef:ref,subjectKeys:parsed.kind==="claims"?parsed.claims.flatMap(c=>claimSubjectKeys(a.actorKey,c,resolveProject(a))):null,derivedRefs:origins?origins.map(v=>checkedRef(a,v)):null,...(secret?{excludeReason:"secret" as const}:{})});messages.set(ref.sourceId,{role:verified.kind,text});
   for(const origin of origins??[])await read(checkedRef(a,origin));
  }
  for(const ref of refs)await read(ref);return {deps,messages};
 }
 function statesForSummary(token:object,summary:StoredSummary):TranscriptState[]{
  return (summary.transcriptRefs??[]).map(ref=>{const state=transcriptHeads.get(ref.headId);if(!state||state.actorToken!==token)contextFail("MEMORY_CONTEXT_TRANSCRIPT_DENIED");if(canonicalJson(state.ref)!==canonicalJson(ref))contextFail("MEMORY_CONTEXT_TRANSCRIPT_STALE");return state});
 }
 function ordered(states:TranscriptState[]):void {
  let seq=0;
  for(const state of states){const first=state.unit.messages[0];if(first?.role!=="user")contextFail("MEMORY_CONTEXT_RECENT_INCOMPLETE");
   // Canonical chronological ordering comes from the provider envelopes, never opaque IDs.
   if(state.firstSeq===undefined||state.lastSeq===undefined||state.firstSeq<=seq)contextFail("MEMORY_CONTEXT_ORDER_REQUIRED");seq=state.lastSeq;
  }
 }
 /** Recheck persisted summary dependencies after canonical recapture, without issuing a new lease. */
 async function validateSummaryIds(token:object,ids:string[],signal?:AbortSignal):Promise<{availableIds:string[];excluded:Array<{sourceId:string;reason:string}>}>{
  const a=actor(token);if(!Array.isArray(ids)||ids.length>1000||new Set(ids).size!==ids.length)contextFail("MEMORY_CONTEXT_INPUT_INVALID");
  const availableIds:string[]=[],excluded:Array<{sourceId:string;reason:string}>=[];
  for(const id of ids){
   if(signal?.aborted)contextFail("MEMORY_CONTEXT_CANCELLED");
   const result=await command<{available:boolean;reason?:string;summary?:StoredSummary}>(a,"summaryGet",{summaryId:parseInternalId(id)});
   if(signal?.aborted)contextFail("MEMORY_CONTEXT_CANCELLED");
   if(!result.available){excluded.push({sourceId:id,reason:result.reason??"MEMORY_CONTEXT_SOURCE_UNAVAILABLE"});continue}
   const summary=result.summary!;
   if(!summary.transcriptRefs?.length||!summary.transcriptSegments?.length)contextFail("MEMORY_CONTEXT_ORDER_REQUIRED");
   try{statesForSummary(token,summary)}catch(error){
    if(!(error instanceof Error)||!/^MEMORY_CONTEXT_TRANSCRIPT_(DENIED|STALE)$/.test(error.message))throw error;
    excluded.push({sourceId:id,reason:error.message});continue;
   }
   availableIds.push(id);
  }
  actor(token);return {availableIds,excluded};
 }
 async function prepareTranscriptSummary(token:object,input:{sessionId:string;transcriptTokens?:object[];summaryIds?:string[];inputRefs?:BoundSourceRef[];leaseMs:number},signal?:AbortSignal):Promise<object>{
  if(signal?.aborted)contextFail("MEMORY_CONTEXT_CANCELLED");
  const a=actor(token);if(input.sessionId!==a.sessionId)contextFail("MEMORY_ACTOR_DENIED");
  if(input.inputRefs?.length||!Array.isArray(input.transcriptTokens)||input.transcriptTokens.length>1000||!Array.isArray(input.summaryIds??[])||(input.summaryIds??[]).length>1000)contextFail("MEMORY_CONTEXT_ORDER_REQUIRED");
  const prior:StoredSummary[]=[];
  for(const id of input.summaryIds??[]){const result=await command<{available:boolean;summary?:StoredSummary}>(a,"summaryGet",{summaryId:parseInternalId(id)});if(!result.available)contextFail("MEMORY_CONTEXT_SOURCE_UNAVAILABLE");if(!result.summary!.transcriptSegments?.length)contextFail("MEMORY_CONTEXT_ORDER_REQUIRED");prior.push(result.summary!)}
  const earlier=prior.flatMap(s=>statesForSummary(token,s)),covered=new Map(earlier.map(state=>[state.ref.headId,state.ref]));
  const recent=input.transcriptTokens.map(cap=>transcriptState(token,cap)).filter(state=>{const old=covered.get(state.ref.headId);if(!old)return true;if(canonicalJson(old)!==canonicalJson(state.ref))contextFail("MEMORY_CONTEXT_TRANSCRIPT_STALE");return false});
  const all=[...earlier,...recent];if(!all.length||all.length>1000||new Set(all.map(s=>s.ref.headId)).size!==all.length)contextFail("MEMORY_CONTEXT_INPUT_INVALID");ordered(all);
  const selectable=[...prior.flatMap(s=>s.transcriptSegments!.map(ref=>earlier.find(state=>canonicalJson(state.ref)===canonicalJson(ref))!)),...recent];ordered(selectable);
  const refs=[...new Map(all.flatMap(s=>s.sourceRefs).map(ref=>[ref.sourceId,ref])).values()],transcriptRefs=all.map(s=>s.ref),guardRefs=[...new Map(all.flatMap(s=>s.guardRefs).map(ref=>[ref.headId,ref])).values()];
  const baseline=await command<{generation:number}>(a,"baseline",{sourceRefs:refs,factRefs:[],transcriptRefs,guardRefs}),data=await corpus(a,refs);
  if(data.deps.some(d=>d.excludeReason))contextFail("MEMORY_CONTEXT_SUMMARY_SECRET");
  const id=randomUUID();await options.actorAuthority.coordinate(()=>{if(signal?.aborted)contextFail("MEMORY_CONTEXT_CANCELLED");return command(a,"summaryLease",{leaseId:id,generation:baseline.generation,sourceDeps:data.deps,inputRefs:[],transcriptRefs,inputTranscriptRefs:selectable.map(s=>s.ref),guardRefs,leaseMs:input.leaseMs,counterIdentity:options.counter.capability,...(options.budget.admissionMode==="bounded"?{admissionMode:"bounded"}:{})},randomUUID())});
  const cap=Object.freeze({});leases.set(cap,{actorToken:token,id,summaryId:randomUUID(),commandId:randomUUID(),inputRefs:[],signal,transcripts:all,inputTranscriptRefs:selectable.map(s=>s.ref),beforeUnits:[...prior.map(summary=>({id:summary.id,kind:"summary" as const,messages:summary.transcriptSegments!.flatMap(ref=>structuredClone(earlier.find(s=>canonicalJson(s.ref)===canonicalJson(ref))!.unit.messages))})),...recent.map(s=>structuredClone(s.unit))]});return cap;
 }
 async function readSummaryInput(token:object,value:object,signal?:AbortSignal):Promise<Array<{transcriptRef:TranscriptDependency;messages:ContextUnit["messages"]}>>{
  const a=actor(token),lease=leases.get(value);if(!lease||lease.actorToken!==token||!lease.transcripts)contextFail("MEMORY_CONTEXT_LEASE_DENIED");
  checkSummaryCancellation(lease,signal);await command(a,"summaryLeaseRead",{leaseId:lease.id});checkSummaryCancellation(lease,signal);
  return lease.inputTranscriptRefs!.map(ref=>({transcriptRef:structuredClone(ref),messages:structuredClone(lease.transcripts!.find(s=>canonicalJson(s.ref)===canonicalJson(ref))!.unit.messages)}));
 }
 function checkSummaryCancellation(lease:LeaseState,signal?:AbortSignal):void {if(lease.signal?.aborted||signal?.aborted)contextFail("MEMORY_CONTEXT_CANCELLED")}
 function summaryCounting(before:number,after:number):SummaryCounting {
  const framingVersion=options.counter.capability.framingVersion;
  return options.budget.admissionMode==="bounded"?{mode:"estimate",framingVersion,estimatedBeforeTokens:before,estimatedAfterTokens:after}:{mode:"exact",framingVersion,beforeTokens:before,afterTokens:after};
 }
 async function selectSummaryInput(token:object,value:object,signal?:AbortSignal):Promise<{segments:Array<{transcriptRef:TranscriptDependency}>|null;counting:SummaryCounting}>{
  const input=await readSummaryInput(token,value,signal),lease=leases.get(value)!;
  lease.includeCounting=true;
  const initialConfiguration=configuration(),budget=structuredClone(options.budget);
  if(!Number.isSafeInteger(budget.maxSTokens)||budget.maxSTokens<0||!Number.isSafeInteger(budget.minRecentCompleteTurns)||budget.minRecentCompleteTurns<0)contextFail("MEMORY_CONTEXT_INPUT_INVALID");
  const count=(units:ContextUnit[])=>countPreparedForAdmission(options.counter,options.prepareS(structuredClone(units)),budget,signal??lease.signal);
  const before=await count(lease.beforeUnits!);
  let selected=input,after=before;
  if(before>budget.maxSTokens){
   const minimum=Math.max(1,budget.minRecentCompleteTurns);
   while(selected.length>minimum){
    selected=selected.slice(1);
    after=await count([{id:lease.summaryId,kind:"summary",messages:selected.flatMap(unit=>unit.messages)}]);
    if(after<before&&after<=budget.maxSTokens)break;
   }
  }
  checkSummaryCancellation(lease,signal);
  if(configuration()!==initialConfiguration)contextFail("MEMORY_CONTEXT_REQUEST_CHANGED");
  await readSummaryInput(token,value,signal);
  return {segments:after<before&&after<=budget.maxSTokens?selected.map(unit=>({transcriptRef:unit.transcriptRef})):null,counting:summaryCounting(before,after)};
 }
 async function commitTranscriptSummary(token:object,lease:LeaseState,proposal:unknown,signal?:AbortSignal):Promise<SummaryReceipt>{
  const a=actor(token),parsed=objectFields(proposal,["segments"]);if(!Array.isArray(parsed.segments)||parsed.segments.length>1000)contextFail("MEMORY_CONTEXT_INPUT_INVALID");let previous=-1;
  const selected=parsed.segments.map(raw=>{const segment=objectFields(raw,["transcriptRef"]),index=lease.inputTranscriptRefs!.findIndex(ref=>canonicalJson(ref)===canonicalJson(segment.transcriptRef));if(index<0||index<=previous)contextFail("MEMORY_CONTEXT_SUMMARY_ORDER_INVALID");previous=index;return lease.inputTranscriptRefs![index]});
  const intent=createHash("sha256").update(canonicalJson(selected)).digest("hex"),state=await command<{receipt?:SummaryReceipt}>(a,"summaryLeaseState",{leaseId:lease.id,intent});if(state.receipt)return state.receipt;
  async function refresh(){for(const old of lease.transcripts!){const cap=await captureTranscript(token,old.adapter,old.locator),fresh=transcriptState(token,cap);if(canonicalJson(fresh.ref)!==canonicalJson(old.ref)||canonicalJson(fresh.guardRefs)!==canonicalJson(old.guardRefs))contextFail("MEMORY_CONTEXT_TRANSCRIPT_STALE")}}
  await refresh();
  const beforeUnits=lease.beforeUnits!,afterUnits:ContextUnit[]=selected.length?[{id:lease.summaryId,kind:"summary",messages:selected.flatMap(ref=>structuredClone(lease.transcripts!.find(s=>canonicalJson(s.ref)===canonicalJson(ref))!.unit.messages))}]:[];
  const initialConfiguration=configuration(),beforeRequest=freezeRequest(options.prepareS(structuredClone(beforeUnits))),afterRequest=freezeRequest(options.prepareS(structuredClone(afterUnits)));
  const beforeTokens=await countPreparedForAdmission(options.counter,beforeRequest,options.budget,signal??lease.signal),afterTokens=await countPreparedForAdmission(options.counter,afterRequest,options.budget,signal??lease.signal);
  checkSummaryCancellation(lease,signal);await refresh();
  const result=await options.actorAuthority.coordinate(()=>{
   checkSummaryCancellation(lease,signal);
   if(configuration()!==initialConfiguration||requestDigest(freezeRequest(options.prepareS(structuredClone(beforeUnits))))!==requestDigest(beforeRequest)||requestDigest(freezeRequest(options.prepareS(structuredClone(afterUnits))))!==requestDigest(afterRequest))contextFail("MEMORY_CONTEXT_REQUEST_CHANGED");
   return command<{receipt:SummaryReceipt}>(a,"summaryCommit",{leaseId:lease.id,intent,summaryId:lease.summaryId,segments:[],transcriptSegments:selected,counterIdentity:options.counter.capability,...(options.budget.admissionMode==="bounded"?{admissionMode:"bounded",estimates:{estimatedBeforeTokens:beforeTokens,estimatedAfterTokens:afterTokens}}:{beforeTokens,afterTokens}),...(lease.includeCounting?{includeCounting:true}:{}),summaryLimit:options.budget.maxSTokens},lease.commandId)
  });return result.receipt;
 }
 async function prepareSummary(token:object,input:{sessionId:string;inputRefs?:BoundSourceRef[];transcriptTokens?:object[];summaryIds?:string[];leaseMs:number},signal?:AbortSignal):Promise<object>{
  if(signal?.aborted)contextFail("MEMORY_CONTEXT_CANCELLED");
  if(input.transcriptTokens!==undefined||input.summaryIds?.length)return prepareTranscriptSummary(token,input,signal);
  if(options.budget.admissionMode==="bounded")contextFail("MEMORY_CONTEXT_BOUNDED_SUMMARY_UNSUPPORTED");
  const a=actor(token);if(input.sessionId!==a.sessionId)contextFail("MEMORY_ACTOR_DENIED");if(!Array.isArray(input.inputRefs)||!input.inputRefs.length||input.inputRefs.length>1000)contextFail("MEMORY_CONTEXT_INPUT_INVALID");
  const refs=input.inputRefs!.map(v=>checkedRef(a,v));if(new Set(refs.map(r=>r.sourceId)).size!==refs.length)contextFail("MEMORY_CONTEXT_INPUT_INVALID");
  const baseline=await command<{generation:number}>(a,"baseline",{sourceRefs:refs,factRefs:[]}),data=await corpus(a,refs);if(data.deps.some(d=>d.excludeReason))contextFail("MEMORY_CONTEXT_SUMMARY_SECRET");
  const id=randomUUID();await options.actorAuthority.coordinate(()=>command(a,"summaryLease",{leaseId:id,generation:baseline.generation,sourceDeps:data.deps,inputRefs:refs,leaseMs:input.leaseMs},randomUUID()));
  const cap=Object.freeze({});leases.set(cap,{actorToken:token,id,summaryId:randomUUID(),commandId:randomUUID(),inputRefs:refs});return cap;
 }
 async function commitSummary(token:object,value:object,proposal:unknown,signal?:AbortSignal):Promise<SummaryReceipt>{
  const a=actor(token),lease=leases.get(value);if(!lease||lease.actorToken!==token)contextFail("MEMORY_CONTEXT_LEASE_DENIED");
  checkSummaryCancellation(lease,signal);
  if(lease.transcripts)return commitTranscriptSummary(token,lease,proposal,signal);
  const parsed=objectFields(proposal,["segments"]);if(!Array.isArray(parsed.segments)||parsed.segments.length>1000)contextFail("MEMORY_CONTEXT_INPUT_INVALID");let previous=-1;
  const requested=parsed.segments.map(raw=>{const s=objectFields(raw,["sourceRef","span"]),ref=parseSourceRef(s.sourceRef),span=objectFields(s.span,["start","end"]),index=lease.inputRefs.findIndex(r=>canonicalJson(r)===canonicalJson(ref));if(index<0||index<=previous)contextFail("MEMORY_CONTEXT_SUMMARY_ORDER_INVALID");previous=index;if(!Number.isSafeInteger(span.start)||!Number.isSafeInteger(span.end)||(span.start as number)<0||(span.end as number)<=(span.start as number))contextFail("MEMORY_SOURCE_SPAN_INVALID");return {sourceRef:ref as BoundSourceRef,span:{start:span.start as number,end:span.end as number}}});
  const intent=createHash("sha256").update(canonicalJson(requested)).digest("hex"),state=await command<{receipt?:SummaryReceipt}>(a,"summaryLeaseState",{leaseId:lease.id,intent});if(state.receipt)return state.receipt;
  const data=await corpus(a,lease.inputRefs),segments:SummarySegment[]=requested.map(s=>{const message=data.messages.get(s.sourceRef.sourceId)!,text=message.text,split=(i:number)=>i>0&&i<text.length&&/[\uD800-\uDBFF]/.test(text[i-1])&&/[\uDC00-\uDFFF]/.test(text[i]);if(s.span.end>text.length||split(s.span.start)||split(s.span.end))contextFail("MEMORY_SOURCE_SPAN_INVALID");if(s.span.start!==0||s.span.end!==text.length)contextFail("MEMORY_CONTEXT_SUMMARY_FULL_SOURCE_REQUIRED");return {...s,role:message.role}});
  if(data.deps.some(d=>d.excludeReason))contextFail("MEMORY_CONTEXT_SUMMARY_SECRET");
  const units=(refs:BoundSourceRef[]):ContextUnit[]=>refs.map(r=>({id:r.sourceId,kind:"summary",messages:[data.messages.get(r.sourceId)!]}));
  const initialConfiguration=configuration(),beforeRequest=freezeRequest(options.prepareS(units(lease.inputRefs))),afterRequest=freezeRequest(options.prepareS(units(segments.map(s=>s.sourceRef))));
  const beforeTokens=await countPrepared(options.counter,beforeRequest),afterTokens=await countPrepared(options.counter,afterRequest);
  // Count continuations can interleave edits. Re-materialize every input, including omitted ones.
  await corpus(a,lease.inputRefs);
  const result=await options.actorAuthority.coordinate(()=>{if(configuration()!==initialConfiguration||requestDigest(freezeRequest(options.prepareS(units(lease.inputRefs))))!==requestDigest(beforeRequest)||requestDigest(freezeRequest(options.prepareS(units(segments.map(s=>s.sourceRef)))))!==requestDigest(afterRequest))contextFail("MEMORY_CONTEXT_REQUEST_CHANGED");return command<{receipt:SummaryReceipt}>(a,"summaryCommit",{leaseId:lease.id,intent,summaryId:lease.summaryId,segments,beforeTokens,afterTokens,summaryLimit:options.budget.maxSTokens},lease.commandId)});return result.receipt;
 }
 async function captureTranscript(token:object,adapter:object,value:string):Promise<object>{
  const a=actor(token),provider=requireMainTranscriptProvider(adapter,a.scopeKey,a.sessionId),id=parseInternalId(value);
  const headId="transcript-"+createHash("sha256").update(canonicalJson({scope:a.scopeKey,actor:a.actorKey,provider:provider.providerId,session:a.sessionId,id})).digest("hex");
  try{return await provider.withLease(id,async read=>{
   const operationId=randomUUID(),baseline=await command<{generation:number}>(a,"baseline",{sourceRefs:[],factRefs:[]});
   await options.actorAuthority.coordinate(()=>command(a,"transcriptReserve",{generation:baseline.generation,headId,operationId,expectedRef:null},randomUUID()));
   const first=parseCanonicalTranscript(await read()),snapshot=parseCanonicalTranscript(await read());
   if(canonicalJson(first)!==canonicalJson(snapshot))contextFail("MEMORY_CONTEXT_TRANSCRIPT_CHANGED");
   assertContextSecretFree(snapshot.unit.messages);
   const {view,...content}=snapshot;
   const refs=snapshot.sourceRefs.map(ref=>checkedRef(a,ref)),digest=createHash("sha256").update(canonicalJson(content)).digest("hex"),guardRefs:TranscriptDependency[]=[];
   if(view){
    const guardId="transcript-"+createHash("sha256").update(canonicalJson({scope:a.scopeKey,actor:a.actorKey,provider:provider.providerId,session:a.sessionId,id:view.id})).digest("hex"),guardOperation=randomUUID();
    await options.actorAuthority.coordinate(()=>command(a,"transcriptReserve",{generation:baseline.generation,headId:guardId,operationId:guardOperation,expectedRef:null},randomUUID()));
    guardRefs.push(await options.actorAuthority.coordinate(()=>command<TranscriptDependency>(a,"transcriptPublish",{generation:baseline.generation,headId:guardId,operationId:guardOperation,incarnation:view.incarnation,contentRevision:view.revision,throughSeq:view.throughSeq,digest:view.digest,sourceRefs:[]},randomUUID())));
   }
   const ref=await options.actorAuthority.coordinate(()=>command<TranscriptDependency>(a,"transcriptPublish",{generation:baseline.generation,headId,operationId,incarnation:snapshot.incarnation,contentRevision:snapshot.revision,throughSeq:snapshot.throughSeq,digest,sourceRefs:refs,...(snapshot.provenance?{provenance:snapshot.provenance.map((source,index)=>{const parsed=extractMaintenance(snapshot.unit.messages[index].text);return {...source,subjectKeys:source.role==="user"&&parsed.kind==="claims"?parsed.claims.flatMap(c=>claimSubjectKeys(a.actorKey,c,resolveProject(a))):null}})}:{})},randomUUID()));
   const cap=Object.freeze({});transcriptTokens.set(cap,{actorToken:token,ref,unit:{...snapshot.unit,id:headId},sourceRefs:refs,adapter,locator:id,guardRefs,...(snapshot.provenance?{provenance:snapshot.provenance,firstSeq:Math.min(...snapshot.provenance.map(e=>e.seq)),lastSeq:Math.max(...snapshot.provenance.map(e=>e.seq))}:{})});
   transcriptHeads.set(ref.headId,transcriptTokens.get(cap)!);
   provider.onCaptured?.(cap,id);
   return cap;
  })}catch(error){if(error instanceof ContextError)throw error;contextFail("MEMORY_CONTEXT_TRANSCRIPT_READ_FAILED")}
 }
 async function transcriptGeneration(token:object):Promise<number>{const a=actor(token);return options.actorAuthority.coordinate(async()=>{const result=await command<{generation:number}>(a,"baseline",{sourceRefs:[],factRefs:[]});return result.generation})}
 async function prepareTranscriptChanges(token:object,values:object[]):Promise<object>{
  const a=actor(token),states=values.map(value=>transcriptState(token,value)),baseline=await command<{generation:number}>(a,"baseline",{sourceRefs:[],factRefs:[]});
  const refs=[...new Map(states.flatMap(state=>[state.ref,...state.guardRefs]).map(ref=>[ref.headId,ref])).values()];
  const operationId=randomUUID();
  if(refs.length)await options.actorAuthority.coordinate(()=>command(a,"transcriptReserveBatch",{generation:baseline.generation,operationId,expectedRefs:refs},randomUUID()));
  const receipt=Object.freeze({});changeReceipts.set(receipt,{actorToken:token,generation:baseline.generation,operationId,refs});return receipt;
 }
 async function prepareTranscriptChange(token:object,value:object):Promise<void>{await prepareTranscriptChanges(token,[value])}
 /** Bind only the adapter's opaque invalidation receipt for this original snapshot. */
 function bindResponseProgress(token:object,value:object,receipt:object,check:()=>void):void {
  const state=snapshotState(token,value),change=changeReceipts.get(receipt);
  if(!change||change.actorToken!==token||change.generation!==state.snapshot.generation)contextFail("MEMORY_CONTEXT_RESPONSE_PROGRESS_DENIED");
  const refs=responseRefs(state);
  if(!refs.length||refs.some(ref=>!change.refs.some(r=>canonicalJson(r)===canonicalJson(ref))))contextFail("MEMORY_CONTEXT_RESPONSE_PROGRESS_DENIED");
  check();state.responseProgress={operationId:change.operationId,expectedRefs:refs,check};
 }
 function responseRefs(state:SnapshotState){return [...new Map([...state.transcripts.flatMap(s=>[s.ref,...s.guardRefs]),...(state.historyResponse?.evidence.flatMap(e=>e.witnesses.flatMap(w=>w.refs))??[])].map(r=>[r.headId,r])).values()]}
 function responseWitnesses(c:HistoryContinuation){return [...new Set(c.evidence.flatMap(e=>e.witnesses))]}
 function continuation(token:object,value:object):HistoryContinuation{actor(token);const c=continuations.get(value);if(!c||!c.active||c.state.actorToken!==token||c.state.historyResponse!==c)contextFail('MEMORY_CONTEXT_HISTORY_RESPONSE_DENIED');for(const w of responseWitnesses(c))w.check();return c}
 function endHistoryResponse(token:object,value:object){const c=continuations.get(value);if(!c||c.state.actorToken!==token)contextFail('MEMORY_CONTEXT_HISTORY_RESPONSE_DENIED');c.active=false;c.ticket=undefined;for(const w of responseWitnesses(c))w.retire();if(activeContinuations.get(token)===c)activeContinuations.delete(token)}
 function beginHistoryResponse(token:object,value:object,input:Omit<HistoryResponseBinding,'actorToken'|'bootId'|'providerId'|'sessionId'|'snapshotId'|'requestDigest'|'contentDigest'> & {text:string}):object|undefined{
  const state=snapshotState(token,value);if(!state.claimed||state.historyResponse||activeContinuations.has(token))contextFail('MEMORY_CONTEXT_HISTORY_RESPONSE_DENIED');
  const {text,...owned}=input,binding:HistoryResponseBinding={...owned,actorToken:token,bootId:options.actorAuthority.bootId,providerId:state.actor.providerId,sessionId:state.actor.sessionId,snapshotId:state.snapshot.snapshotId,requestDigest:state.snapshot.requestDigest,contentDigest:createHash('sha256').update(canonicalJson(text)).digest('hex')};
  const evidence:HistoryResponseEvidence[]=[];
  try{for(const cap of state.historyTokens)evidence.push(claimHistoryResponseEvidence(options.actorAuthority,token,cap,binding));if(!evidence.some(e=>e.witnesses.length))return undefined;
   const cap=Object.freeze({}),c:HistoryContinuation={cap,state,binding:Object.freeze(binding),evidence,phase:0,active:true,observed:false};state.historyResponse=c;continuations.set(cap,c);activeContinuations.set(token,c);return cap;
  }catch(error){for(const e of evidence)for(const w of e.witnesses)w.retire();throw error}
 }
 async function prepareHistoryResponseStep(token:object,value:object,signal?:AbortSignal){const c=continuation(token,value);if(c.phase>1||c.ticket||c.observed)contextFail('MEMORY_CONTEXT_HISTORY_RESPONSE_DENIED');for(const e of c.evidence)await e.validateOrdinary();for(const w of responseWitnesses(c))if(w.sessionId!==c.state.actor.sessionId||w.providerId!==c.state.actor.providerId)await w.validate(undefined,signal);continuation(token,value)}
 async function validateHistoryResponseStep(token:object,value:object,ticket:object,signal?:AbortSignal){
  const c=continuation(token,value);if(c.phase>1||c.ticket||c.observed)contextFail('MEMORY_CONTEXT_HISTORY_RESPONSE_DENIED');
  try{for(const w of responseWitnesses(c))await w.validate(ticket,signal);await validateResponse(token,c.state.snapshot,signal);continuation(token,value);c.ticket=ticket}
  catch(error){endHistoryResponse(token,value);throw error}
 }
 function matchesResponse(c:HistoryContinuation,entry:TranscriptEntry){const b=c.binding;if(entry.seq!==b.throughSeq+c.phase+1||entry.runId!==b.runId||entry.turnId!==b.assistantTurnId)return false;
  return c.phase===0?entry.kind==='assistant'&&entry.id===b.assistantEntryId&&entry.sSettlement?.userTurnId===b.userTurnId&&entry.sSettlement?.userRevision===b.userRevision&&createHash('sha256').update(canonicalJson(entry.payload.content)).digest('hex')===b.contentDigest:
   c.phase===1&&entry.kind==='assistant_settlement'&&entry.payload.result==='success'&&entry.payload.binding.assistantEntryId===b.assistantEntryId&&entry.payload.binding.userTurnId===b.userTurnId&&entry.payload.binding.userRevision===b.userRevision;
 }
 async function observeResponseMutation(token:object,kind:string,entry:TranscriptEntry|undefined,ticket:object|undefined,values:object[]):Promise<object|undefined>{
  const c=activeContinuations.get(token);if(!c)return undefined;
  if(kind!=='append'||!entry||!ticket||c.ticket!==ticket||c.observed||!matchesResponse(c,entry)){const responseAttempt=ticket!==undefined&&c.ticket===ticket;endHistoryResponse(token,c.cap);if(responseAttempt)contextFail('MEMORY_CONTEXT_HISTORY_RESPONSE_DENIED');return undefined}
  try{
   continuation(token,c.cap);const refs=responseRefs(c.state),published=values.map(v=>transcriptState(token,v));
   const sRefs=[...new Map(published.flatMap(s=>[s.ref,...s.guardRefs]).map(r=>[r.headId,r])).values()];
   if(c.phase===0){if(sRefs.some(r=>!refs.some(ref=>canonicalJson(ref)===canonicalJson(r))))contextFail('MEMORY_CONTEXT_RESPONSE_PROGRESS_DENIED');
    const operationId=randomUUID();await options.actorAuthority.coordinate(()=>command(c.state.actor,'transcriptReserveBatch',{generation:c.state.snapshot.generation,operationId,expectedRefs:refs},randomUUID()));
    c.receipt=Object.freeze({});changeReceipts.set(c.receipt,{actorToken:token,generation:c.state.snapshot.generation,operationId,refs});
   }else if(sRefs.length||!c.receipt)contextFail('MEMORY_CONTEXT_RESPONSE_PROGRESS_DENIED');
   for(const w of responseWitnesses(c))await w.observe(entry,ticket);
   continuation(token,c.cap);c.observed=true;return c.receipt;
  }catch(error){endHistoryResponse(token,c.cap);throw error}
 }
 function responseBody(state:SnapshotState){const progress=state.responseProgress;progress?.check();return {snapshotId:state.snapshot.snapshotId,...(progress?{responseProgress:{operationId:progress.operationId,expectedRefs:progress.expectedRefs}}:{})}}
 async function deleteTranscript(token:object,value:object):Promise<void>{
  const a=actor(token),state=transcriptState(token,value),baseline=await command<{generation:number}>(a,"baseline",{sourceRefs:[],factRefs:[]});
  await options.actorAuthority.coordinate(()=>command(a,"transcriptDelete",{generation:baseline.generation,expectedRef:state.ref},randomUUID()));
 }
 async function recount(state:SnapshotState,signal?:AbortSignal):Promise<BudgetResult>{
  if(signal?.aborted)contextFail("MEMORY_CONTEXT_CANCELLED");
  await command(state.actor,"validateSnapshot",{snapshotId:state.snapshot.snapshotId});
  for(const cap of state.historyTokens)await validateHistoryEvidence(options.actorAuthority,state.actorToken,cap);
  for(const ref of state.sourceRefs)await readSource(state.actor,ref);
  await readFactSupports(state.actor,state.facts);
  for(const old of state.transcripts){const fresh=await captureTranscript(state.actorToken,old.adapter,old.locator);if(canonicalJson(transcriptState(state.actorToken,fresh).ref)!==canonicalJson(old.ref))contextFail("MEMORY_CONTEXT_TRANSCRIPT_STALE")}
  const prepared=freezeRequest(options.prepare(structuredClone(state.units),structuredClone(state.facts)));
  if(requestDigest(prepared)!==state.snapshot.requestDigest)contextFail("MEMORY_CONTEXT_REQUEST_CHANGED");
  const result=await selectBudget({counter:options.counter,budget:options.budget,units:state.units,prepare:u=>options.prepare(u,structuredClone(state.facts)),prepareS:options.prepareS,signal});
  for(const cap of state.historyTokens)await validateHistoryEvidence(options.actorAuthority,state.actorToken,cap);
  for(const ref of state.sourceRefs)await readSource(state.actor,ref);
  await readFactSupports(state.actor,state.facts);
  await command(state.actor,"validateSnapshot",{snapshotId:state.snapshot.snapshotId});
  if(result.requestDigest!==state.snapshot.requestDigest||result.promptTokens!==state.snapshot.promptTokens||result.inputLimit!==state.snapshot.inputLimit||(result.admissionMode??"exact")!==(state.snapshot.admissionMode??"exact")||canonicalJson(result.estimates??null)!==canonicalJson(state.snapshot.estimates??null))contextFail("MEMORY_CONTEXT_REQUEST_CHANGED");return result;
 }
 async function assemble(token:object,input:ContextInput):Promise<Snapshot>{
  const a=actor(token);if(input.sessionId!==a.sessionId)throw new Error("MEMORY_ACTOR_DENIED");
  if(!Array.isArray(input.sourceRefs)||input.sourceRefs.length>1000)contextFail("MEMORY_CONTEXT_INPUT_INVALID");
  const refs=input.sourceRefs.map(value=>checkedRef(a,value));if(new Set(refs.map(r=>r.sourceId)).size!==refs.length)contextFail("MEMORY_CONTEXT_INPUT_INVALID");
  const selectedFacts=structuredClone(input.factRefs??[]);
  const factQuery=input.currentUserSourceRef?{sourceRef:checkedRef(a,input.currentUserSourceRef),text:await readSource(a,checkedRef(a,input.currentUserSourceRef))}:undefined;
  if(input.historyTokens!==undefined&&(!Array.isArray(input.historyTokens)||input.historyTokens.length>8))contextFail("MEMORY_CONTEXT_INPUT_INVALID");
  for(const cap of input.historyTokens??[])await validateHistoryEvidence(options.actorAuthority,token,cap);
  const historical=(input.historyTokens??[]).map(cap=>readHistoryEvidence(options.actorAuthority,token,cap)),historyDeps=historical.flatMap(h=>h.dependencies);
  if(input.transcriptTokens!==undefined&&(!Array.isArray(input.transcriptTokens)||input.transcriptTokens.length>1000))contextFail("MEMORY_CONTEXT_INPUT_INVALID");
  const suppliedStates=(input.transcriptTokens??[]).map(v=>transcriptState(token,v)),suppliedRefs=suppliedStates.map(s=>s.ref);
  // Current user identity comes from an opaque canonical capability, independently of M facts.
  const current=input.currentTranscript?transcriptState(token,input.currentTranscript.token):undefined;
  if(current){
   const user=current.provenance?.[0],expected=input.currentTranscript!.user;
   if(current!==suppliedStates.at(-1)||user?.role!=="user"||!user.turnId||!user.revision)contextFail("MEMORY_CONTEXT_RECENT_INCOMPLETE");
   if(expected&&(user.turnId!==expected.turnId||user.revision!==expected.revision))contextFail("MEMORY_CONTEXT_STREAM_TURN_STALE");
  }
  if(suppliedStates.some(s=>s.firstSeq!==undefined))ordered(suppliedStates);
  if(new Set(suppliedRefs.map(r=>r.headId)).size!==suppliedRefs.length)contextFail("MEMORY_CONTEXT_INPUT_INVALID");
  let toolStates=suppliedStates,toolRefs=suppliedRefs;
  if(refs.length&&toolStates.length)contextFail("MEMORY_CONTEXT_ORDER_REQUIRED");
  if(new Set(toolRefs.map(r=>r.headId)).size!==toolRefs.length)contextFail("MEMORY_CONTEXT_INPUT_INVALID");
  if(input.summaryIds!==undefined&&(!Array.isArray(input.summaryIds)||input.summaryIds.length>1000||new Set(input.summaryIds).size!==input.summaryIds.length))contextFail("MEMORY_CONTEXT_INPUT_INVALID");
  const summaries:StoredSummary[]=[],summaryExcluded:{sourceId:string;reason:string}[]=[];
  for(const id of input.summaryIds??[]){const result=await command<{available:boolean;reason?:string;summary?:StoredSummary}>(a,"summaryGet",{summaryId:parseInternalId(id)});if(!result.available){summaryExcluded.push({sourceId:id,reason:result.reason!});continue}const summary=result.summary!;
   if(summary.transcriptRefs?.length){
    if(refs.length)contextFail("MEMORY_CONTEXT_ORDER_REQUIRED");
    try{statesForSummary(token,summary)}catch(error){if(!(error instanceof Error)||!/^MEMORY_CONTEXT_TRANSCRIPT_(DENIED|STALE)$/.test(error.message))throw error;summaryExcluded.push({sourceId:id,reason:error.message});continue}
   }
   let changed=false;for(const dep of summary.sourceDeps){try{options.registry.resolveVerifiedSource(dep.sourceRef)}catch(error){if(!(error instanceof Error)||error.message!=="MEMORY_SOURCE_STALE")throw error;const fresh=await options.registry.capture(a.access,a.adapter,{providerId:dep.sourceRef.binding.providerId,sessionId:dep.sourceRef.binding.sessionId,messageId:dep.sourceRef.binding.messageId});if(canonicalJson(fresh)!==canonicalJson(dep.sourceRef)){changed=true;break}}checkedRef(a,dep.sourceRef)}
   if(changed){summaryExcluded.push({sourceId:id,reason:"MEMORY_SOURCE_STALE"});continue}summaries.push(summary);
  }
  const summaryStates=summaries.flatMap(s=>statesForSummary(token,s)),covered=new Set(summaryStates.map(s=>s.ref.headId));
  toolStates=toolStates.filter(s=>!covered.has(s.ref.headId));toolRefs=toolStates.map(s=>s.ref);
  if(summaryStates.length){ordered([...summaryStates,...toolStates]);if(summaries.some(s=>!s.transcriptRefs?.length))contextFail("MEMORY_CONTEXT_ORDER_REQUIRED")}
  const dependencyStates=[...new Map([...summaryStates,...toolStates].map(s=>[s.ref.headId,s])).values()],dependencyRefs=dependencyStates.map(s=>s.ref),guardRefs=[...new Map(dependencyStates.flatMap(s=>s.guardRefs).map(ref=>[ref.headId,ref])).values()];
  const allRefs=[...new Map([...refs,...(input.currentUserSourceRef?[checkedRef(a,input.currentUserSourceRef)]:[]),...dependencyStates.flatMap(s=>s.sourceRefs),...summaries.flatMap(s=>s.sourceDeps.map(d=>d.sourceRef))].map(r=>[r.sourceId,r])).values()];
  const baseline=await command<{generation:number;facts:ContextFact[];recallDeps:import("../memory-recall/recall-contracts").RecallDependency[]}>(a,"baseline",{sourceRefs:allRefs,factRefs:selectedFacts,...(factQuery?{factQuery}:{}),transcriptRefs:dependencyRefs,guardRefs,historyDeps});
  await readFactSupports(a,baseline.facts);
  const data=await corpus(a,allRefs),deps=data.deps,units:ContextUnit[]=[],unitSources=new Map<string,string[]>();
  units.push(...historical.filter(h=>h.dependencies.length).map(h=>h.unit));
  for(const summary of summaries)units.push({id:summary.id,kind:"summary",messages:summary.transcriptSegments?.length
   ?summary.transcriptSegments.flatMap(ref=>structuredClone(summaryStates.find(state=>canonicalJson(state.ref)===canonicalJson(ref))!.unit.messages))
   :summary.segments.map(s=>{const message=data.messages.get(s.sourceRef.sourceId)!;if(s.role!==message.role||s.span.start!==0||s.span.end!==message.text.length)contextFail("MEMORY_CONTEXT_SUMMARY_FULL_SOURCE_REQUIRED");return message})});
  // Main provides ordered recent refs. Group a user and its following assistant messages as one turn.
  const recent:ContextUnit[]=[];
  for(const ref of refs){const message=data.messages.get(ref.sourceId)!,last=recent.at(-1);if(message.role==="assistant"&&last?.messages[0].role==="user"){last.messages.push(message);unitSources.get(last.id)!.push(ref.sourceId)}else{recent.push({id:ref.sourceId,kind:"recent",messages:[message]});unitSources.set(ref.sourceId,[ref.sourceId])}}
  units.push(...recent);
  for(const state of toolStates)units.push(structuredClone(state.unit));
  const inspected=await command<{generation:number;sourceStates:{sourceId:string;reason:string}[];facts:ContextFact[]}>(a,"inspect",{generation:baseline.generation,sourceDeps:deps,factRefs:selectedFacts,...(factQuery?{factQuery}:{}),recallDeps:baseline.recallDeps,transcriptRefs:toolRefs,historyDeps});
  if(input.currentUserSourceRef&&inspected.sourceStates.some(s=>s.sourceId===input.currentUserSourceRef!.sourceId&&s.reason!=="allowed"))contextFail("MEMORY_CONTEXT_SOURCE_UNAVAILABLE");
  const supports=inspected.facts.map(f=>({factId:f.factId,revision:f.revision,sourceRefs:f.supportSourceRefs}));
  const excluded=[...summaryExcluded,...inspected.sourceStates.filter(s=>s.reason!=="allowed")],allowed=units.filter(u=>!excluded.some(e=>e.sourceId===u.id)&&!(unitSources.get(u.id)??[]).some(id=>excluded.some(e=>e.sourceId===id))&&!summaries.some(s=>s.id===u.id&&s.sourceDeps.some(d=>excluded.some(e=>e.sourceId===d.sourceRef.sourceId))));
  if(current&&!allowed.some(u=>u.id===current.ref.headId))contextFail("MEMORY_CONTEXT_SOURCE_UNAVAILABLE");
  if(allowed.some(u=>unitSources.has(u.id)&&u.messages[0].role==="assistant"))contextFail("MEMORY_CONTEXT_RECENT_INCOMPLETE");
  const result=await selectBudget({counter:options.counter,budget:options.budget,units:allowed,prepare:u=>options.prepare(u,structuredClone(inspected.facts)),prepareS:options.prepareS,signal:input.signal});
  if(current&&!result.selectedIds.includes(current.ref.headId))contextFail("MEMORY_CONTEXT_RECENT_INCOMPLETE");
  for(const [index,h] of historical.entries())if(result.selectedIds.includes(h.unit.id))await validateHistoryEvidence(options.actorAuthority,token,input.historyTokens![index]);
  const snapshotId=randomUUID();
  await options.actorAuthority.coordinate(()=>command(a,"snapshot",{snapshotId,generation:baseline.generation,sourceDeps:deps,factRefs:selectedFacts,...(factQuery?{factQuery}:{}),...(includeFactSupportMetadata?{factSupportRefs:supports}:{}),recallDeps:baseline.recallDeps,transcriptRefs:dependencyRefs,guardRefs,historyDeps:historical.filter(h=>result.selectedIds.includes(h.unit.id)).flatMap(h=>h.dependencies),requiredSummaries:result.selectedIds.filter(id=>summaries.some(s=>s.id===id)),requiredTranscripts:result.selectedIds.filter(id=>toolRefs.some(r=>r.headId===id)),requiredSources:[...result.selectedIds.flatMap(id=>unitSources.get(id)??[]),...(input.currentUserSourceRef?[input.currentUserSourceRef.sourceId]:[])],counterIdentity:{...result.counterIdentity,mode:options.counter.capability.mode,inputTypes:[...options.counter.capability.inputTypes]},requestDigest:result.requestDigest,...(result.admissionMode==="bounded"?{admissionMode:"bounded",estimates:result.estimates}:{promptTokens:result.promptTokens,inputLimit:result.inputLimit})},randomUUID()));
  const snapshot=Object.freeze({...result,snapshotId,generation:baseline.generation,excluded:structuredClone(excluded)});
  snapshots.set(snapshot,{actorToken:token,actor:a,units:allowed.filter(u=>result.selectedIds.includes(u.id)),facts:inspected.facts,snapshot,sourceRefs:deps.map(d=>d.sourceRef),transcripts:dependencyStates,historyTokens:(input.historyTokens??[]).filter((_cap,index)=>result.selectedIds.includes(historical[index].unit.id)),configuration:configuration()});return snapshot;
 }
 async function validateForDispatch(token:object,value:object,signal?:AbortSignal):Promise<object>{
  const state=snapshotState(token,value),result=await recount(state,signal),id=randomUUID();
  await options.actorAuthority.coordinate(()=>{if(signal?.aborted)contextFail("MEMORY_CONTEXT_CANCELLED");return command(state.actor,"permit",{snapshotId:state.snapshot.snapshotId,permitId:id,requestDigest:result.requestDigest},randomUUID())});
  const permit=Object.freeze({});permits.set(permit,{snapshot:state,id,used:false});return permit;
 }
 async function validateResponse(token:object,value:object,signal?:AbortSignal):Promise<void>{
  const state=snapshotState(token,value);if(signal?.aborted)contextFail("MEMORY_CONTEXT_CANCELLED");
  if(configuration()!==state.configuration)contextFail("MEMORY_CONTEXT_REQUEST_CHANGED");
  if(state.historyResponse){const c=continuation(token,state.historyResponse.cap);for(const e of c.evidence)await e.validateOrdinary()}else for(const cap of state.historyTokens)await validateHistoryEvidence(options.actorAuthority,token,cap);
  for(const ref of state.sourceRefs)await readSource(state.actor,ref);
  await readFactSupports(state.actor,state.facts);
  await command(state.actor,"validateResponse",responseBody(state));state.responseProgress?.check();
  if(signal?.aborted)contextFail("MEMORY_CONTEXT_CANCELLED");
 }
 /** Only the guarded canonical store may supply write, after its observer invalidation. */
 async function commitResponse<T>(token:object,value:object,write:()=>Promise<T>,signal:AbortSignal|undefined,check:()=>void,entry?:TranscriptEntry):Promise<T>{
  const state=snapshotState(token,value);if(!state.responseProgress)contextFail("MEMORY_CONTEXT_RESPONSE_PROGRESS_DENIED");
  await validateResponse(token,value,signal);
  return options.actorAuthority.coordinate(async()=>{
   await command(state.actor,"validateResponse",responseBody(state));
   if(configuration()!==state.configuration||requestDigest(freezeRequest(options.prepare(structuredClone(state.units),structuredClone(state.facts))))!==state.snapshot.requestDigest)contextFail("MEMORY_CONTEXT_REQUEST_CHANGED");
   state.responseProgress!.check();check();if(signal?.aborted)contextFail("MEMORY_CONTEXT_CANCELLED");
   // Linearization is append dispatch: no await between final guards and file append.
   const c=state.historyResponse;
   if(c){continuation(token,c.cap);if(!c.ticket||!c.observed||c.phase>1)contextFail('MEMORY_CONTEXT_HISTORY_RESPONSE_DENIED');c.phase++;c.ticket=undefined;c.observed=false;try{const result=await write();if(entry)await command(state.actor,'historyResponseOrigin',{...responseBody(state),entry},randomUUID());return result}catch(error){endHistoryResponse(token,c.cap);throw error}}
   const result=await write();if(entry)await command(state.actor,'historyResponseOrigin',{...responseBody(state),entry},randomUUID());return result;
  });
 }
 const networkAttempts=new WeakSet<object>();
 /** Final network invocation, after SDK serialization. Never hold the queue for I/O settlement. */
 /** retry: the same claimed request again after its connection dropped; it is admitted under the same checks as the first send. */
 async function invokeClaimedRequest<T>(token:object,value:object,send:()=>Promise<T>,signal:AbortSignal|undefined,check:()=>void,retry=false):Promise<T>{
  const state=snapshotState(token,value);
  // A synchronous SDK callback may enter before dispatch records claimed=true.
  // Wait for that admission operation and its durable confirmation to settle.
  await options.actorAuthority.coordinate(()=>undefined);
  if(!state.claimed)contextFail("MEMORY_CONTEXT_PERMIT_DENIED");
  if(retry){if(!networkAttempts.has(value))contextFail("MEMORY_CONTEXT_PERMIT_DENIED")}
  else{if(networkAttempts.has(value))contextFail("MEMORY_CONTEXT_PERMIT_USED");networkAttempts.add(value)}
  await validateResponse(token,value,signal);
  const admitted=await options.actorAuthority.coordinate(async()=>{
   await command(state.actor,"validateResponse",responseBody(state));
   if(configuration()!==state.configuration||requestDigest(freezeRequest(options.prepare(structuredClone(state.units),structuredClone(state.facts))))!==state.snapshot.requestDigest)contextFail("MEMORY_CONTEXT_REQUEST_CHANGED");
   check();if(signal?.aborted)contextFail("MEMORY_CONTEXT_CANCELLED");
   const pending=Promise.resolve(send());void pending.catch(()=>{});return {pending};
  });
  return admitted.pending;
 }
 // "sent" means the local sender callback completed successfully; neither this
 // result nor the durable invocation ticket proves remote delivery.
 async function dispatch<T>(token:object,value:object,send:(request:PreparedRequest)=>Promise<T>|T,signal?:AbortSignal):Promise<{status:"sent";requestDigest:string;result:T}|{status:"result-unknown";requestDigest:string}>{
  actor(token);const permit=permits.get(value);if(!permit||permit.snapshot.actorToken!==token)contextFail("MEMORY_CONTEXT_PERMIT_DENIED");if(permit.used)contextFail("MEMORY_CONTEXT_PERMIT_USED");
  const state=permit.snapshot,result=await recount(state,signal);
  const sent=await options.actorAuthority.coordinate(async()=>{
   if(signal?.aborted)contextFail("MEMORY_CONTEXT_CANCELLED");
   if(configuration()!==state.configuration||requestDigest(freezeRequest(options.prepare(structuredClone(state.units),structuredClone(state.facts))))!==result.requestDigest)contextFail("MEMORY_CONTEXT_REQUEST_CHANGED");
   if(permit.used)contextFail("MEMORY_CONTEXT_PERMIT_USED");const attemptAt=(options.clock??Date.now)();if(!Number.isSafeInteger(attemptAt)||attemptAt<0)contextFail("MEMORY_RECALL_CLOCK_INVALID");permit.used=true;
   const useTicketId="use-"+randomUUID(),processBootId=options.actorAuthority.bootId;
   const claim=await command<{claimedAt:number}>(state.actor,"claim",{snapshotId:state.snapshot.snapshotId,permitId:permit.id,requestDigest:result.requestDigest,useTicketId,processBootId,attemptAt},randomUUID());
   if(signal?.aborted){await command(state.actor,"useUnknown",{useTicketId,processBootId},"unknown-"+useTicketId).catch(()=>{});contextFail("MEMORY_CONTEXT_CANCELLED")}
   // Invocation is the application linearization point. No await/dump between claim and send.
   const invokedAt=(options.clock??Date.now)();if(!Number.isSafeInteger(invokedAt)||!Number.isSafeInteger(claim.claimedAt)||invokedAt<claim.claimedAt||invokedAt-claim.claimedAt>CONTEXT_CLAIM_WINDOW_MS){await command(state.actor,"useUnknown",{useTicketId,processBootId},"unknown-"+useTicketId).catch(()=>{});contextFail("MEMORY_RECALL_CLOCK_INVALID")}
   if(signal?.aborted)contextFail("MEMORY_CONTEXT_CANCELLED");
   let response:Promise<T>|null;
   try{response=Promise.resolve(send(result.request));state.claimed=true;void response.catch(()=>{})}catch{response=null}
   try{await command(state.actor,"confirmUse",{useTicketId,processBootId,invokedAt},"confirm-"+useTicketId)}catch{
    // The callback already ran. Durable confirmation failure cannot trigger a
    // resend or be described as an unsent request; preserve an unknown ticket.
    await command(state.actor,"useUnknown",{useTicketId,processBootId},"unknown-"+useTicketId).catch(()=>{});return {result:null};
   }
   return {result:response};
  });
  if(sent.result===null)return {status:"result-unknown",requestDigest:result.requestDigest};
  try{return {status:"sent",requestDigest:result.requestDigest,result:await sent.result}}catch{return {status:"result-unknown",requestDigest:result.requestDigest}};
 }
 // Trusted producer already read the committed source before taking its canonical store lease.
 // Never re-enter provider I/O here: channel providers share that non-reentrant store lease.
 async function recordHistoryUser(token:object,sourceRef:BoundSourceRef,entry:TranscriptEntry){const a=actor(token);checkedRef(a,sourceRef);return options.actorAuthority.coordinate(()=>command(a,'historyUserOrigin',{sourceRef,entry},randomUUID()))}
 return {recordHistoryUser,invokeClaimedRequest,beginHistoryResponse,prepareHistoryResponseStep,validateHistoryResponseStep,observeResponseMutation,endHistoryResponse,assemble,validateForDispatch,validateResponse,commitResponse,bindResponseProgress,dispatch,captureTranscript,prepareTranscriptChange,prepareTranscriptChanges,transcriptGeneration,deleteTranscript,prepareSummary,commitSummary,readSummaryInput,selectSummaryInput,validateSummaryIds};
}
