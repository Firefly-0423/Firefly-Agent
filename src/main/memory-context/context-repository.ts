import {HistoryOrigins,historyDocumentKey,historyOriginEvent,type HistoryOriginClosure,type HistoryOriginOwner,type HistoryOriginEvent} from '../memory-history/history-origins';
import type {TranscriptEntry} from '../orchestrator/conversation-transcript-types';
import {FactQuery,type FactQueryBinding} from "../memory-policy/fact-query";
import {isProductionEstimateIdentity} from "./model-counting-contract";
import {applyOpenRouterExpense,OPENROUTER_EXPENSE_SCOPE} from "./openrouter-bounded";
import type {DatabaseSync} from "node:sqlite";
import {objectFields,parseInternalId,parseSourceRef,positiveRevision} from "../memory-core/command-validation";
import {executeTransaction,type TransactionFault} from "../memory-core/command-transactions";
import {transactionNow,withTransactionClock} from "../memory-core/transaction-clock";
import {RecordCodec} from "../memory-core/record-codec";
import {SourceLedger} from "../memory-core/source-ledger";
import {Suppression} from "../memory-core/suppression";
import {PolicyRepository} from "../memory-policy/policy-repository";
import {FactSupports} from "../memory-policy/fact-supports";
import type {ContextFact,FactSupportDependency,BoundedEstimates} from "./context-contracts";
import type {BoundSourceRef,FactView} from "../../shared/memory-contracts";
import {contextFail,CONTEXT_CLAIM_WINDOW_MS,type SourceDependency,type FactDependency,type TranscriptDependency,type TokenCounter,type StoredSummary,type SummarySegment,type SummaryReceipt,type SummaryCounting} from "./context-contracts";
import {canonicalJson} from "../memory-core/repository-types";
import {TranscriptLedger} from "./transcript-ledger";
import {RecallRepository,parseRecallDependencies} from "../memory-recall/recall-repository";
import type {RecallDependency} from "../memory-recall/recall-contracts";
import {HistoryRepository,parseHistoryDependencies,isResponseNativeHistoryDocument} from "../memory-history/history-repository";
import type {HistoryDependency} from "../memory-history/history-contracts";

export interface ContextOwner {actorKey:string;providerId:string;sessionId:string;bootId:string}
export interface StoredSnapshot extends ContextOwner {
 factQuery?:FactQueryBinding;
 id:string;generation:number;sourceDeps:SourceDependency[];requiredSources:string[];factRefs:FactDependency[];recallDeps:RecallDependency[];transcriptRefs:TranscriptDependency[];requiredTranscripts:string[];requiredSummaries:string[];
 guardRefs?:TranscriptDependency[];requestDigest:string;promptTokens?:number;inputLimit?:number;admissionMode?:"bounded";estimates?:BoundedEstimates;state:"ready"|"claimed";
 counterIdentity:TokenCounter["capability"];
 historyDeps?:HistoryDependency[];
 factSupportRefs?:FactSupportDependency[];
}
interface StoredPermit extends ContextOwner {id:string;snapshotId:string;state:"ready"|"claimed"}
interface SummaryLease extends ContextOwner {id:string;generation:number;sourceDeps:SourceDependency[];inputRefs:BoundSourceRef[];transcriptRefs?:TranscriptDependency[];inputTranscriptRefs?:TranscriptDependency[];guardRefs?:TranscriptDependency[];expiresAt:number;counterIdentity?:TokenCounter["capability"];completed?:{intent:string;receipt:SummaryReceipt}}
function natural(value:unknown):number {if(!Number.isSafeInteger(value)||(value as number)<0)contextFail("MEMORY_CONTEXT_INPUT_INVALID");return value as number}
function list(value:unknown,max=1000):unknown[] {if(!Array.isArray(value)||value.length>max)contextFail("MEMORY_CONTEXT_INPUT_INVALID");return value}
function bound(value:unknown):BoundSourceRef {const ref=parseSourceRef(value);if(!ref.binding||ref.span)contextFail("MEMORY_CONTEXT_INPUT_INVALID");return ref as BoundSourceRef}
export function parseSourceDependencies(value:unknown):SourceDependency[] {
 return list(value).map(raw=>{
  const d=objectFields(raw,["sourceRef","subjectKeys","derivedRefs"],["excludeReason"]),sourceRef=bound(d.sourceRef);
  const subjectKeys=d.subjectKeys===null?null:list(d.subjectKeys,64).map(s=>{if(typeof s!=="string"||!/^actor-attribute-[a-f0-9]{64}$/.test(s))contextFail("MEMORY_CONTEXT_INPUT_INVALID");return s});
  const derivedRefs=d.derivedRefs===null?null:list(d.derivedRefs,64).map(bound);
  if(d.excludeReason!==undefined&&d.excludeReason!=="secret")contextFail("MEMORY_CONTEXT_INPUT_INVALID");
  return {sourceRef,subjectKeys,derivedRefs,...(d.excludeReason?{excludeReason:"secret" as const}:{})};
 });
}
function factRefs(value:unknown):FactDependency[] {return list(value,200).map(raw=>{const d=objectFields(raw,["factId","revision"]);return {factId:parseInternalId(d.factId),revision:positiveRevision(d.revision)}})}
function factSupportRefs(value:unknown):FactSupportDependency[]{return list(value,200).map(raw=>{const d=objectFields(raw,["factId","revision","sourceRefs"]);return {factId:parseInternalId(d.factId),revision:positiveRevision(d.revision),sourceRefs:list(d.sourceRefs).map(bound)}})}
function transcripts(value:unknown):TranscriptDependency[]{return list(value).map(raw=>{const d=objectFields(raw,["headId","revision","digest"]);if(typeof d.digest!=="string"||! /^[a-f0-9]{64}$/.test(d.digest))contextFail("MEMORY_CONTEXT_INPUT_INVALID");return {headId:parseInternalId(d.headId),revision:positiveRevision(d.revision),digest:d.digest}})}
function counterIdentity(value:unknown,bounded=false):TokenCounter["capability"] {
 const c=objectFields(value,["providerId","model","transport","framingVersion","mode","inputTypes"]);if(c.mode!==(bounded?"estimate":"exact"))contextFail("MEMORY_CONTEXT_BUDGET_UNPROVEN");
 if(bounded){
  const production=isProductionEstimateIdentity(c);
  if(typeof c.framingVersion==="string"&&c.framingVersion.startsWith("firefly-prepared-estimate-")&&!production)contextFail("MEMORY_CONTEXT_COUNTER_UNSUPPORTED");
  if(!production&&(c.providerId!=="openrouter"||c.model!=="openai/gpt-6-luna"||c.transport!=="responses"))contextFail("MEMORY_CONTEXT_COUNTER_UNSUPPORTED");
  if(production&&list(c.inputTypes,64).some(type=>!["text","function-tools","image"].includes(type as string)))contextFail("MEMORY_CONTEXT_COUNTER_UNSUPPORTED");
 }
 const text=(value:unknown)=>{if(typeof value!=="string"||!value||value.length>1024)contextFail("MEMORY_CONTEXT_INPUT_INVALID");return value};
 return {providerId:text(c.providerId),model:text(c.model),transport:text(c.transport),framingVersion:text(c.framingVersion),mode:bounded?"estimate":"exact",inputTypes:list(c.inputTypes,64).map(text)};
}
function parseBoundedEstimates(value:unknown,production=false):BoundedEstimates {
 const e=objectFields(value,["estimatedPromptTokens","estimatedSTokens","selectionInputLimit"]),selectionInputLimit=natural(e.selectionInputLimit);
 if(!production&&selectionInputLimit>922000)contextFail("MEMORY_CONTEXT_INPUT_INVALID");
 return {estimatedPromptTokens:natural(e.estimatedPromptTokens),estimatedSTokens:natural(e.estimatedSTokens),selectionInputLimit};
}
/** Worker-only metadata repository. No source text, prompt body or model output is persisted. */
export class ContextRepository {
 private readonly codec:RecordCodec;private readonly ledger:SourceLedger;private readonly suppression:Suppression;private readonly policy:PolicyRepository;private readonly transcript:TranscriptLedger;
 constructor(private readonly db:DatabaseSync,private readonly key:Uint8Array,private readonly fault?:TransactionFault,private readonly clock:()=>number=Date.now){this.codec=new RecordCodec(key);this.ledger=new SourceLedger(db,key);this.suppression=new Suppression(db,key);this.policy=new PolicyRepository(db,key);this.transcript=new TranscriptLedger(db,key,fault)}
 private owner(body:Record<string,unknown>):ContextOwner {return {actorKey:parseInternalId(body.actorKey),providerId:parseInternalId(body.providerId),sessionId:parseInternalId(body.sessionId),bootId:parseInternalId(body.bootId)}}
 private sameOwner(a:ContextOwner,b:ContextOwner,boot=true):void {if(a.actorKey!==b.actorKey||a.providerId!==b.providerId||a.sessionId!==b.sessionId||(boot&&a.bootId!==b.bootId))contextFail("MEMORY_CONTEXT_ACCESS_DENIED")}
 private read<T extends ContextOwner&{id:string}>(scope:string,id:string,kind:string,owner:ContextOwner,boot=true):T {
  const row=this.db.prepare("SELECT id,kind,payload FROM context_records WHERE scope_key=? AND id=?").get(scope,id);
  if(!row||row.kind!==kind)contextFail("MEMORY_CONTEXT_RECORD_DENIED");
  const record=this.codec.open<T>("context-"+kind,scope,id,row.payload);if(record.id!==id)contextFail("MEMORY_DATA_INVALID");this.sameOwner(record,owner,boot);return record;
 }
 private save(scope:string,kind:string,record:ContextOwner&{id:string}):void {
  this.db.prepare("INSERT INTO context_records VALUES(?,?,?,1,?) ON CONFLICT(id,scope_key) DO UPDATE SET revision=revision+1,payload=excluded.payload WHERE kind=excluded.kind")
   .run(record.id,scope,kind,this.codec.seal("context-"+kind,scope,record.id,record));this.fault?.("after-record");
 }
 private assertGeneration(scope:string,value:unknown):number {const g=natural(value);if(g!==this.suppression.generation(scope))contextFail("MEMORY_CONTEXT_STALE");return g}
 private assertSource(scope:string,owner:ContextOwner,ref:BoundSourceRef){
  if(ref.binding.providerId!==owner.providerId||ref.binding.sessionId!==owner.sessionId)contextFail("MEMORY_CONTEXT_ACCESS_DENIED");
  const head=this.ledger.assertCurrent(scope,ref);if(!head?.published)contextFail("MEMORY_SOURCE_INVALID");return head;
 }
 private sourceState(scope:string,owner:ContextOwner,dep:SourceDependency,deps:SourceDependency[],seen=new Set<string>()):string {
  const head=this.assertSource(scope,owner,dep.sourceRef),id=dep.sourceRef.sourceId;
  if(seen.has(id))return "untraceable-derived";seen=new Set([...seen,id]);
  if(dep.excludeReason)return dep.excludeReason;
  if(this.suppression.sourceBlocked(scope,dep.sourceRef))return "suppressed-source";
  const gen=this.suppression.generation(scope),old=(head.firstObservedSuppressionGeneration??0)<gen;
  if(head.published!.role!=="user"||head.published!.trust!=="direct-user-event"){
   if(gen===0)return "allowed";
   if(!dep.derivedRefs?.length)return "untraceable-derived";
   return dep.derivedRefs.every(ref=>{const origin=deps.find(d=>canonicalJson(d.sourceRef)===canonicalJson(ref));return origin&&this.sourceState(scope,owner,origin,deps,seen)==="allowed"})?"allowed":"untraceable-derived";
  }
  if(!old)return "allowed";
  if(!dep.subjectKeys?.length)return "untraceable-source";
  return dep.subjectKeys.some(subject=>this.suppression.subjectBlocked(scope,subject))?"suppressed-subject":"allowed";
 }
 private checkedFacts(scope:string,owner:ContextOwner,refs:FactDependency[],expected?:RecallDependency[],query?:FactQueryBinding):{facts:ContextFact[];recallDeps:RecallDependency[]} {
  const period=new FactQuery(this.db,this.key).validate(scope,owner,query);
  const available=this.policy.eligibleFactsWithinTransaction(scope,owner.actorKey,transactionNow(this.db),period);
  for(const ref of refs)if(!available.some(f=>f.factId===ref.factId&&f.revision===ref.revision))contextFail("MEMORY_CONTEXT_FACT_STALE");
  const result=new RecallRepository(this.db,this.key,()=>transactionNow(this.db),this.fault).visibleFactsWithinTransaction(scope,owner.actorKey,refs,expected,period),supports=new FactSupports(this.db,this.key);
  return {...result,facts:result.facts.map(fact=>({...fact,...(period?{temporalQuery:{...period,coverage:fact.time.validFrom!<=period.validFrom!&&fact.time.validTo!>=period.validTo!?"full" as const:"partial" as const}}:{}),supportSourceRefs:[...new Map(supports.audit(scope,owner.actorKey,fact.factId,fact).supports.filter(s=>s.factRevision===fact.revision&&s.validity==="valid").map(s=>[canonicalJson(s.sourceRef),s.sourceRef])).entries()].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([,ref])=>ref)}))};
 }
 private responseHead(scope:string,owner:ContextOwner,ref:TranscriptDependency,progress?:{operationId:string;expectedRefs:TranscriptDependency[]}) {
  if(!progress?.expectedRefs.some(expected=>canonicalJson(expected)===canonicalJson(ref)))return this.transcript.current(scope,owner,ref);
  const head=this.transcript.head(scope,owner,ref.headId);
  if(!head||head.state!=="pending"||head.operationId!==progress.operationId||canonicalJson(head.ref)!==canonicalJson(ref))contextFail("MEMORY_CONTEXT_RESPONSE_PROGRESS_STALE");
  return head;
 }
 private transcriptState(scope:string,owner:ContextOwner,ref:TranscriptDependency,deps:SourceDependency[],progress?:{operationId:string;expectedRefs:TranscriptDependency[]}):string {
  const head=this.responseHead(scope,owner,ref,progress);
  for(const sourceRef of head.sourceRefs)this.assertSource(scope,owner,sourceRef);
  if(head.sourceRefs.some(ref=>{const dep=deps.find(d=>canonicalJson(d.sourceRef)===canonicalJson(ref));return !dep||this.sourceState(scope,owner,dep,deps)!=="allowed"}))return "unavailable-root";
  if(this.suppression.generation(scope)===0)return "allowed";
  if(!head.sourceRefs.length){
   if(!head.provenance?.length)return "untraceable-derived";
   const old=head.provenance.filter(e=>(e.suppressionGeneration??0)<this.suppression.generation(scope));
   if(old.some(e=>e.role!=="user"))return "untraceable-derived";
   if(old.some(e=>!e.subjectKeys?.length))return "untraceable-source";
   return old.some(e=>e.subjectKeys!.some(subject=>this.suppression.subjectBlocked(scope,subject)))?"suppressed-subject":"allowed";
  }
  return head.sourceRefs.every(ref=>{const dep=deps.find(d=>canonicalJson(d.sourceRef)===canonicalJson(ref));return dep&&this.sourceState(scope,owner,dep,deps)==="allowed"})?"allowed":"untraceable-derived";
 }
 private checkSnapshot(scope:string,owner:ContextOwner,snapshot:StoredSnapshot,progress?:{operationId:string;expectedRefs:TranscriptDependency[]}):void {
  this.sameOwner(snapshot,owner);this.assertGeneration(scope,snapshot.generation);
  const history=new HistoryRepository(this.db,this.key,undefined,()=>transactionNow(this.db));
  const documents=progress?history.validateResponseWithinTransaction(scope,owner.actorKey,snapshot.historyDeps??[],owner,progress.operationId):history.validateWithinTransaction(scope,owner.actorKey,snapshot.historyDeps??[]);
  if(progress){
   const refs=[...snapshot.transcriptRefs,...(snapshot.guardRefs??[]),...documents.filter(d=>isResponseNativeHistoryDocument(d)&&d.providerId===owner.providerId&&d.sessionId===owner.sessionId&&d.transcriptRef).map(d=>d.transcriptRef!)],exact=new Map<string,TranscriptDependency>();
   for(const ref of refs){const old=exact.get(ref.headId);if(old&&canonicalJson(old)!==canonicalJson(ref))contextFail("MEMORY_CONTEXT_RESPONSE_PROGRESS_DENIED");exact.set(ref.headId,ref)}
   if(new Set(progress.expectedRefs.map(r=>r.headId)).size!==progress.expectedRefs.length||progress.expectedRefs.length!==exact.size||progress.expectedRefs.some(r=>canonicalJson(exact.get(r.headId))!==canonicalJson(r)))contextFail("MEMORY_CONTEXT_RESPONSE_PROGRESS_DENIED");
  }
  for(const ref of snapshot.guardRefs??[])this.responseHead(scope,owner,ref,progress);
  for(const dep of snapshot.sourceDeps){const status=this.sourceState(scope,owner,dep,snapshot.sourceDeps);if(snapshot.requiredSources.includes(dep.sourceRef.sourceId)&&status!=="allowed")contextFail("MEMORY_CONTEXT_SOURCE_UNAVAILABLE")}
  const facts=this.checkedFacts(scope,owner,snapshot.factRefs,parseRecallDependencies(snapshot.recallDeps??[]),snapshot.factQuery).facts;
  if(snapshot.factSupportRefs&&canonicalJson(facts.map(f=>({factId:f.factId,revision:f.revision,sourceRefs:f.supportSourceRefs})))!==canonicalJson(snapshot.factSupportRefs))contextFail("MEMORY_CONTEXT_FACT_SUPPORT_STALE");
  for(const ref of snapshot.transcriptRefs){const status=this.transcriptState(scope,owner,ref,snapshot.sourceDeps,progress);if(snapshot.requiredTranscripts.includes(ref.headId)&&status!=="allowed")contextFail("MEMORY_CONTEXT_SOURCE_UNAVAILABLE")}
  for(const id of snapshot.requiredSummaries)this.checkSummary(scope,owner,this.read<StoredSummary>(scope,id,"summary",owner,false),progress);
 }
 private checkSummary(scope:string,owner:ContextOwner,summary:Pick<StoredSummary,"sourceDeps"|"transcriptRefs">,progress?:{operationId:string;expectedRefs:TranscriptDependency[]}):void {
  for(const dep of summary.sourceDeps)if(this.sourceState(scope,owner,dep,summary.sourceDeps)!=="allowed")contextFail("MEMORY_CONTEXT_SOURCE_UNAVAILABLE");
  for(const ref of summary.transcriptRefs??[])if(this.transcriptState(scope,owner,ref,summary.sourceDeps,progress)!=="allowed")contextFail("MEMORY_CONTEXT_SOURCE_UNAVAILABLE");
 }
 private checkLease(scope:string,owner:ContextOwner,lease:SummaryLease):void {
  this.assertGeneration(scope,lease.generation);if(transactionNow(this.db)>=lease.expiresAt)contextFail("MEMORY_CONTEXT_LEASE_EXPIRED");this.checkSummary(scope,owner,lease);for(const ref of lease.guardRefs??[])this.transcript.current(scope,owner,ref);
 }
 /** Freeze only selected dependencies; mutable transcript head versions are not historical roots. */
 private historyClosure(scope:string,owner:ContextOwner,snapshot:StoredSnapshot,progress?:{operationId:string;expectedRefs:TranscriptDependency[]}):HistoryOriginClosure {
  // Read-only, so every event check shares one origin snapshot; each fresh traversal cost ~0.1 s and the event list grows every round.
  const origins=new HistoryOrigins(this.db,this.key,{snapshot:true}),closure:HistoryOriginClosure={sources:[],events:[],complete:true};
  const addSource=(dep:SourceDependency,deps:SourceDependency[],path=new Set<string>())=>{
   if(path.size>=128||path.has(dep.sourceRef.sourceId)){closure.complete=false;return}
   const head=this.ledger.assertCurrent(scope,dep.sourceRef);if(!head?.published){closure.complete=false;return}
   closure.sources.push(dep.sourceRef);
   if(head.published.role==='user'&&head.published.trust==='direct-user-event')return;
   if(!dep.derivedRefs?.length){closure.complete=false;return}
   for(const ref of dep.derivedRefs){const root=deps.find(d=>canonicalJson(d.sourceRef)===canonicalJson(ref));if(!root)closure.complete=false;else addSource(root,deps,new Set([...path,dep.sourceRef.sourceId]))}
  };
  const addEvent=(eventOwner:HistoryOriginOwner,event:HistoryOriginEvent)=>{if(closure.events.length>=1000){closure.complete=false;return}closure.events.push({...eventOwner,event});if(!origins.valid(scope,eventOwner,event))closure.complete=false};
  const addTranscript=(ref:TranscriptDependency,deps:SourceDependency[])=>{
   const head=this.responseHead(scope,owner,ref,progress);
   if(head.sourceRefs.length){for(const ref of head.sourceRefs){const dep=deps.find(d=>canonicalJson(d.sourceRef)===canonicalJson(ref));if(dep)addSource(dep,deps);else closure.complete=false}return}
   if(!head.provenance?.length){closure.complete=false;return}
   for(const p of head.provenance){if(!p.entryDigest||!['user','assistant','tool'].includes(p.role)){closure.complete=false;continue}addEvent(owner,{originalId:p.entryId,seq:p.seq,turnId:p.turnId??null,revision:p.revision??null,originalRole:p.role as HistoryOriginEvent['originalRole'],digest:p.entryDigest})}
  };
  for(const id of snapshot.requiredSources){const dep=snapshot.sourceDeps.find(d=>d.sourceRef.sourceId===id);if(dep)addSource(dep,snapshot.sourceDeps);else closure.complete=false}
  for(const fact of this.checkedFacts(scope,owner,snapshot.factRefs,snapshot.recallDeps,snapshot.factQuery).facts){
   for(const ref of [fact.sourceRef,fact.provenance.activationSourceRef,...fact.supportSourceRefs]){if(ref.binding&&!ref.span)closure.sources.push(ref as BoundSourceRef);else closure.complete=false}
  }
  for(const ref of snapshot.transcriptRefs.filter(r=>snapshot.requiredTranscripts.includes(r.headId)))addTranscript(ref,snapshot.sourceDeps);
  for(const id of snapshot.requiredSummaries){const summary=this.read<StoredSummary>(scope,id,'summary',owner,false);for(const segment of summary.segments){const dep=summary.sourceDeps.find(d=>canonicalJson(d.sourceRef)===canonicalJson(segment.sourceRef));if(dep)addSource(dep,summary.sourceDeps);else closure.complete=false}for(const ref of summary.transcriptSegments??[])addTranscript(ref,summary.sourceDeps)}
  const history=new HistoryRepository(this.db,this.key),documents=progress?history.validateResponseWithinTransaction(scope,owner.actorKey,snapshot.historyDeps??[],owner,progress.operationId):history.validateWithinTransaction(scope,owner.actorKey,snapshot.historyDeps??[]);
  for(const [i,doc] of documents.entries()){
   (closure.documents??=[]).push({actorKey:doc.actorKey,providerId:doc.providerId,sessionId:doc.sessionId,recordId:historyDocumentKey(this.key,scope,doc,doc.id),incarnation:doc.incarnation});
   const excerpt=snapshot.historyDeps![i].excerpt,messages=excerpt?doc.messages.slice(excerpt.start,excerpt.end):doc.messages,provenance=excerpt?doc.provenance?.slice(excerpt.start,excerpt.end):doc.provenance;
   for(const message of messages){if(message.sourceRef){const dep=doc.sourceDeps.find(d=>canonicalJson(d.sourceRef)===canonicalJson(message.sourceRef));if(dep)addSource(dep,doc.sourceDeps);else closure.complete=false}else if(!provenance?.length)closure.complete=false}
   if(provenance?.length){for(const p of provenance){if(p.seq===null||!['user','assistant','tool'].includes(p.originalRole)){closure.complete=false;continue}addEvent({actorKey:doc.actorKey,providerId:doc.providerId,sessionId:doc.sessionId},{originalId:p.originalId,seq:p.seq,turnId:p.turnId,revision:p.revision,originalRole:p.originalRole as HistoryOriginEvent['originalRole'],digest:p.digest})}}
   else if(!doc.sourceDeps.length)closure.complete=false;
  }
  closure.sources=[...new Map(closure.sources.map(ref=>[canonicalJson(ref),ref])).values()];closure.events=[...new Map(closure.events.map(event=>[canonicalJson(event),event])).values()];
  if(closure.sources.length>1000){closure.complete=false;closure.sources=[]}return closure;
 }
 execute(value:unknown):unknown {
  const command=objectFields(value,["kind","scopeKey","body"],["commandId"]),scope=parseInternalId(command.scopeKey);
  const body=objectFields(command.body,["actorKey","providerId","sessionId","bootId"],["sourceRefs","sourceDeps","factRefs","generation","snapshotId","permitId","requestDigest","promptTokens","inputLimit","requiredSources","transcriptRefs","requiredTranscripts","headId","operationId","expectedRef","incarnation","contentRevision","throughSeq","digest","counterIdentity","requiredSummaries","leaseId","leaseMs","inputRefs","summaryId","intent","segments","beforeTokens","afterTokens","summaryLimit","recallDeps","useTicketId","processBootId","invokedAt","attemptAt","historyDeps","guardRefs","provenance","inputTranscriptRefs","transcriptSegments","expectedRefs","responseProgress","factSupportRefs","admissionMode","estimates","reservationId","costNanodollars","includeCounting","factQuery","sourceRef","entry"]),owner=this.owner(body);
  if(scope===OPENROUTER_EXPENSE_SCOPE&&!["expenseReserve","expenseSettle","expenseRelease"].includes(command.kind as string))contextFail("MEMORY_CONTEXT_COST_DENIED");
  const identity=["actorKey","providerId","sessionId","bootId"];
  const apply=()=>{
   if(command.kind==="historyUserOrigin"){objectFields(body,[...identity,"sourceRef","entry"]);new HistoryOrigins(this.db,this.key).recordUser(scope,owner,body.sourceRef,body.entry as TranscriptEntry);return {recorded:true}}
   if(command.kind==="historyResponseOrigin"){
    objectFields(body,[...identity,'snapshotId','entry'],['responseProgress']);
    const snapshot=this.read<StoredSnapshot>(scope,parseInternalId(body.snapshotId),'snapshot',owner);if(snapshot.state!=='claimed')contextFail('MEMORY_CONTEXT_RESPONSE_UNSENT');
    const raw=body.responseProgress===undefined?undefined:objectFields(body.responseProgress,['operationId','expectedRefs']),progress=raw?{operationId:parseInternalId(raw.operationId),expectedRefs:transcripts(raw.expectedRefs)}:undefined;
    this.checkSnapshot(scope,owner,snapshot,progress);new HistoryOrigins(this.db,this.key).recordResponse(scope,owner,historyOriginEvent(body.entry as TranscriptEntry),snapshot.id,this.historyClosure(scope,owner,snapshot,progress));return {recorded:true};
   }
   if(["expenseReserve","expenseSettle","expenseRelease"].includes(command.kind as string)){const result=applyOpenRouterExpense(this.db,this.key,scope,owner,command.kind as string,body);this.fault?.("after-record");return result}
   if(command.kind==="summaryGet"){
    objectFields(body,[...identity,"summaryId"]);const summary=this.read<StoredSummary>(scope,parseInternalId(body.summaryId),"summary",owner,false);
    try{this.checkSummary(scope,owner,summary)}catch(error){if(error instanceof Error&&["MEMORY_SOURCE_PENDING","MEMORY_SOURCE_STALE","MEMORY_SOURCE_DELETED","MEMORY_SOURCE_INVALID","MEMORY_CONTEXT_SOURCE_UNAVAILABLE","MEMORY_CONTEXT_TRANSCRIPT_PENDING","MEMORY_CONTEXT_TRANSCRIPT_STALE","MEMORY_CONTEXT_TRANSCRIPT_DELETED","MEMORY_CONTEXT_TRANSCRIPT_DENIED"].includes(error.message))return {available:false,reason:error.message};throw error}
    return {available:true,summary};
   }
   if(command.kind==="summaryLease"){
    objectFields(body,[...identity,"leaseId","generation","sourceDeps","inputRefs","leaseMs"],["transcriptRefs","inputTranscriptRefs","guardRefs","counterIdentity","admissionMode"]);const duration=natural(body.leaseMs);if(duration<1||duration>300000)contextFail("MEMORY_CONTEXT_INPUT_INVALID");
    const inputRefs=list(body.inputRefs).map(bound),sourceDeps=parseSourceDependencies(body.sourceDeps);const transcriptRefs=transcripts(body.transcriptRefs??[]),inputTranscriptRefs=transcripts(body.inputTranscriptRefs??[]),guardRefs=transcripts(body.guardRefs??[]);
    if((!inputRefs.length&&!inputTranscriptRefs.length)||(inputRefs.length&&inputTranscriptRefs.length)||new Set(inputRefs.map(r=>r.sourceId)).size!==inputRefs.length||inputRefs.some(r=>!sourceDeps.some(d=>canonicalJson(r)===canonicalJson(d.sourceRef)))||new Set(inputTranscriptRefs.map(r=>r.headId)).size!==inputTranscriptRefs.length||inputTranscriptRefs.some(r=>!transcriptRefs.some(d=>canonicalJson(r)===canonicalJson(d))))contextFail("MEMORY_CONTEXT_INPUT_INVALID");
    if(body.admissionMode!==undefined&&body.admissionMode!=="bounded")contextFail("MEMORY_CONTEXT_INPUT_INVALID");
    const summaryCounter=body.counterIdentity===undefined?undefined:counterIdentity(body.counterIdentity,body.admissionMode==="bounded");
    if(body.admissionMode==="bounded"&&(!summaryCounter||!inputTranscriptRefs.length))contextFail("MEMORY_CONTEXT_BUDGET_UNPROVEN");
    const lease:SummaryLease={...owner,...(summaryCounter?{counterIdentity:summaryCounter}:{}),id:parseInternalId(body.leaseId),generation:this.assertGeneration(scope,body.generation),sourceDeps,inputRefs,transcriptRefs,inputTranscriptRefs,guardRefs,expiresAt:transactionNow(this.db)+duration};this.checkLease(scope,owner,lease);this.save(scope,"summary-lease",lease);return {leaseId:lease.id};
   }
   if(command.kind==="summaryLeaseRead"){
    objectFields(body,[...identity,"leaseId"]);const lease=this.read<SummaryLease>(scope,parseInternalId(body.leaseId),"summary-lease",owner);this.checkLease(scope,owner,lease);return {ready:true};
   }
   if(command.kind==="summaryLeaseState"||command.kind==="summaryCommit"){
    objectFields(body,[...identity,"leaseId","intent"],command.kind==="summaryCommit"?["summaryId","segments","beforeTokens","afterTokens","summaryLimit","transcriptSegments","counterIdentity","admissionMode","estimates","includeCounting"]:[]);
    if(typeof body.intent!=="string"||! /^[a-f0-9]{64}$/.test(body.intent))contextFail("MEMORY_CONTEXT_INPUT_INVALID");const lease=this.read<SummaryLease>(scope,parseInternalId(body.leaseId),"summary-lease",owner);
    if(lease.completed){if(lease.completed.intent!==body.intent)contextFail("MEMORY_CONTEXT_LEASE_USED");return {receipt:lease.completed.receipt}}
    this.checkLease(scope,owner,lease);if(command.kind==="summaryLeaseState")return {ready:true};
    let previous=-1;const segments:SummarySegment[]=list(body.segments).map(raw=>{
     const segment=objectFields(raw,["sourceRef","span","role"]),sourceRef=bound(segment.sourceRef),span=objectFields(segment.span,["start","end"]),start=natural(span.start),end=natural(span.end);
     const index=lease.inputRefs.findIndex(r=>canonicalJson(r)===canonicalJson(sourceRef));if(index<=previous||index<0)contextFail("MEMORY_CONTEXT_SUMMARY_ORDER_INVALID");previous=index;
     const head=this.assertSource(scope,owner,sourceRef);if(segment.role!==head.published!.role||start!==0||end<1)contextFail("MEMORY_CONTEXT_INPUT_INVALID");return {sourceRef,span:{start,end},role:segment.role as SummarySegment["role"]};
    });
    let prior=-1;const transcriptSegments=transcripts(body.transcriptSegments??[]);
    for(const ref of transcriptSegments){const index=(lease.inputTranscriptRefs??[]).findIndex(r=>canonicalJson(r)===canonicalJson(ref));if(index<0||index<=prior)contextFail("MEMORY_CONTEXT_SUMMARY_ORDER_INVALID");prior=index}
    if(segments.length&&transcriptSegments.length)contextFail("MEMORY_CONTEXT_ORDER_REQUIRED");
    if(body.admissionMode!==undefined&&body.admissionMode!=="bounded"||body.includeCounting!==undefined&&body.includeCounting!==true)contextFail("MEMORY_CONTEXT_INPUT_INVALID");
    const bounded=body.admissionMode==="bounded",summaryCounter=body.counterIdentity===undefined?undefined:counterIdentity(body.counterIdentity,bounded);
    if(canonicalJson(summaryCounter??null)!==canonicalJson(lease.counterIdentity??null))contextFail("MEMORY_CONTEXT_REQUEST_CHANGED");
    let before:number,after:number,counting:SummaryCounting|undefined;
    if(bounded){
     if(!summaryCounter||!lease.inputTranscriptRefs?.length||body.beforeTokens!==undefined||body.afterTokens!==undefined)contextFail("MEMORY_CONTEXT_BUDGET_UNPROVEN");
     const estimates=objectFields(body.estimates,["estimatedBeforeTokens","estimatedAfterTokens"]);
     before=natural(estimates.estimatedBeforeTokens);after=natural(estimates.estimatedAfterTokens);
     counting={mode:"estimate",framingVersion:summaryCounter.framingVersion,estimatedBeforeTokens:before,estimatedAfterTokens:after};
    }else{
     if(body.estimates!==undefined)contextFail("MEMORY_CONTEXT_BUDGET_UNPROVEN");
     before=natural(body.beforeTokens);after=natural(body.afterTokens);
     if(body.includeCounting){if(!summaryCounter)contextFail("MEMORY_CONTEXT_BUDGET_UNPROVEN");counting={mode:"exact",framingVersion:summaryCounter.framingVersion,beforeTokens:before,afterTokens:after}}
    }
    const limit=natural(body.summaryLimit),id=parseInternalId(body.summaryId);
    const receipt:SummaryReceipt={...((segments.length||transcriptSegments.length)&&after<before&&after<=limit?{status:"committed" as const,summaryId:id}:{status:"no-benefit" as const,summaryId:null}),...(counting?{counting}:{})};
    if(receipt.status==="committed")this.save(scope,"summary",{...owner,id,generation:lease.generation,sourceDeps:lease.sourceDeps,inputRefs:lease.inputRefs,segments,transcriptRefs:lease.transcriptRefs??[],transcriptSegments,...(counting?{counting}:{})} as StoredSummary);
    lease.completed={intent:body.intent,receipt};this.save(scope,"summary-lease",lease);return {receipt};
   }
   if(command.kind==="confirmUse"||command.kind==="useUnknown"){
    objectFields(body,[...identity,"useTicketId","processBootId",...(command.kind==="confirmUse"?["invokedAt"]:[])]);const useOwner={...owner,bootId:parseInternalId(body.processBootId)},recall=new RecallRepository(this.db,this.key,()=>transactionNow(this.db),this.fault),id=parseInternalId(body.useTicketId);
    return command.kind==="confirmUse"?recall.confirmUseWithinTransaction(scope,useOwner,id,natural(body.invokedAt)):recall.unknownUseWithinTransaction(scope,useOwner,id);
   }
   if(command.kind==="validateResponse"){
    objectFields(body,[...identity,"snapshotId"],["responseProgress"]);const raw=body.responseProgress===undefined?undefined:objectFields(body.responseProgress,["operationId","expectedRefs"]),progress=raw?{operationId:parseInternalId(raw.operationId),expectedRefs:transcripts(raw.expectedRefs)}:undefined;
    const snapshot=this.read<StoredSnapshot>(scope,parseInternalId(body.snapshotId),"snapshot",owner);if(snapshot.state!=="claimed")contextFail("MEMORY_CONTEXT_RESPONSE_UNSENT");this.checkSnapshot(scope,owner,snapshot,progress);return {valid:true};
   }
   if(command.kind==="validateSnapshot"){
    objectFields(body,[...identity,"snapshotId"]);const snapshot=this.read<StoredSnapshot>(scope,parseInternalId(body.snapshotId),"snapshot",owner);this.checkSnapshot(scope,owner,snapshot);if(snapshot.state!=="ready")contextFail("MEMORY_CONTEXT_PERMIT_USED");return {valid:true};
   }
   if(command.kind==="transcriptReserveBatch"){
    objectFields(body,[...identity,"generation","operationId","expectedRefs"]);const generation=this.assertGeneration(scope,body.generation),refs=list(body.expectedRefs,2000).map(ref=>transcripts([ref])[0]),operationId=parseInternalId(body.operationId);
    if(!refs.length||new Set(refs.map(ref=>ref.headId)).size!==refs.length)contextFail("MEMORY_CONTEXT_INPUT_INVALID");
    for(const ref of refs)this.transcript.current(scope,owner,ref);
    for(const ref of refs)this.transcript.reserve(scope,owner,ref.headId,operationId,generation,ref);
    return {reserved:true};
   }
   if(command.kind==="transcriptReserve"){
    objectFields(body,[...identity,"generation","headId","operationId","expectedRef"]);const g=this.assertGeneration(scope,body.generation);
    this.transcript.reserve(scope,owner,parseInternalId(body.headId),parseInternalId(body.operationId),g,body.expectedRef===null?null:transcripts([body.expectedRef])[0]);return {reserved:true};
   }
   if(command.kind==="transcriptPublish"){
    objectFields(body,[...identity,"generation","headId","operationId","incarnation","contentRevision","throughSeq","digest","sourceRefs"],["provenance"]);this.assertGeneration(scope,body.generation);
    if(typeof body.digest!=="string"||! /^[a-f0-9]{64}$/.test(body.digest))contextFail("MEMORY_CONTEXT_INPUT_INVALID");const refs=list(body.sourceRefs).map(bound);for(const ref of refs)this.assertSource(scope,owner,ref);
    return this.transcript.publish(scope,owner,parseInternalId(body.headId),parseInternalId(body.operationId),{incarnation:parseInternalId(body.incarnation),contentRevision:positiveRevision(body.contentRevision),throughSeq:natural(body.throughSeq),digest:body.digest,sourceRefs:refs,...(body.provenance===undefined?{}:{provenance:body.provenance})});
   }
   if(command.kind==="transcriptDelete"){
    objectFields(body,[...identity,"generation","expectedRef"]);this.assertGeneration(scope,body.generation);this.transcript.remove(scope,owner,transcripts([body.expectedRef])[0]);return {deleted:true};
   }
   if(command.kind==="baseline"){
    objectFields(body,[...identity,"sourceRefs","factRefs"],["transcriptRefs","historyDeps","guardRefs","factQuery"]);for(const ref of transcripts(body.guardRefs??[]))this.transcript.current(scope,owner,ref);new HistoryRepository(this.db,this.key,undefined,()=>transactionNow(this.db)).validateWithinTransaction(scope,owner.actorKey,body.historyDeps??[]);for(const ref of list(body.sourceRefs).map(bound))this.assertSource(scope,owner,ref);for(const ref of transcripts(body.transcriptRefs??[]))this.transcript.current(scope,owner,ref);
    return {generation:this.suppression.generation(scope),...this.checkedFacts(scope,owner,factRefs(body.factRefs),undefined,new FactQuery(this.db,this.key).resolve(scope,owner,body.factQuery))};
   }
   if(command.kind==="inspect"){
    objectFields(body,[...identity,"generation","sourceDeps","factRefs"],["transcriptRefs","recallDeps","historyDeps","factQuery"]);new HistoryRepository(this.db,this.key,undefined,()=>transactionNow(this.db)).validateWithinTransaction(scope,owner.actorKey,body.historyDeps??[]);this.assertGeneration(scope,body.generation);const deps=parseSourceDependencies(body.sourceDeps);
    return {generation:body.generation,sourceStates:[...deps.map(dep=>({sourceId:dep.sourceRef.sourceId,reason:this.sourceState(scope,owner,dep,deps)})),...transcripts(body.transcriptRefs??[]).map(ref=>({sourceId:ref.headId,reason:this.transcriptState(scope,owner,ref,deps)}))],...this.checkedFacts(scope,owner,factRefs(body.factRefs),parseRecallDependencies(body.recallDeps??[]),new FactQuery(this.db,this.key).resolve(scope,owner,body.factQuery))};
   }
   if(command.kind==="snapshot"){
    const bounded=body.admissionMode==="bounded";if(body.admissionMode!==undefined&&!bounded)contextFail("MEMORY_CONTEXT_INPUT_INVALID");
    objectFields(body,[...identity,"generation","sourceDeps","factRefs","snapshotId","requiredSources","requestDigest","counterIdentity",...(bounded?["admissionMode","estimates"]:["promptTokens","inputLimit"])],["transcriptRefs","requiredTranscripts","requiredSummaries","recallDeps","historyDeps","guardRefs","factSupportRefs","factQuery"]);
    if(typeof body.requestDigest!=="string"||! /^[a-f0-9]{64}$/.test(body.requestDigest))contextFail("MEMORY_CONTEXT_INPUT_INVALID");
    const checkedCounter=counterIdentity(body.counterIdentity,bounded);
    const record:StoredSnapshot={...owner,id:parseInternalId(body.snapshotId),generation:natural(body.generation),sourceDeps:parseSourceDependencies(body.sourceDeps),factRefs:factRefs(body.factRefs),recallDeps:parseRecallDependencies(body.recallDeps??[]),
     guardRefs:transcripts(body.guardRefs??[]),historyDeps:parseHistoryDependencies(body.historyDeps??[]),requiredSources:list(body.requiredSources).map(parseInternalId),transcriptRefs:transcripts(body.transcriptRefs??[]),requiredTranscripts:list(body.requiredTranscripts??[]).map(parseInternalId),requiredSummaries:list(body.requiredSummaries??[]).map(parseInternalId),counterIdentity:checkedCounter,requestDigest:body.requestDigest,...(bounded?{admissionMode:"bounded" as const,estimates:parseBoundedEstimates(body.estimates,isProductionEstimateIdentity(checkedCounter))}:{promptTokens:natural(body.promptTokens),inputLimit:natural(body.inputLimit)}),state:"ready"};
    if(body.factSupportRefs!==undefined)record.factSupportRefs=factSupportRefs(body.factSupportRefs);
    const factQuery=new FactQuery(this.db,this.key).resolve(scope,owner,body.factQuery);if(factQuery){record.factQuery=factQuery;if(!record.requiredSources.includes(factQuery.sourceRef.sourceId))contextFail("MEMORY_FACT_QUERY_DENIED")}
    if(bounded?record.estimates!.estimatedPromptTokens>record.estimates!.selectionInputLimit:record.promptTokens!>record.inputLimit!)contextFail("MEMORY_CONTEXT_OVER_BUDGET");
    if(record.requiredSources.some(id=>!record.sourceDeps.some(d=>d.sourceRef.sourceId===id)))contextFail("MEMORY_CONTEXT_INPUT_INVALID");
    if(record.requiredTranscripts.some(id=>!record.transcriptRefs.some(r=>r.headId===id)))contextFail("MEMORY_CONTEXT_INPUT_INVALID");
    this.checkSnapshot(scope,owner,record);this.save(scope,"snapshot",record);return {snapshotId:record.id,generation:record.generation};
   }
   if(command.kind==="permit"||command.kind==="claim"){
    objectFields(body,[...identity,"snapshotId","permitId","requestDigest",...(command.kind==="claim"?["useTicketId","processBootId","attemptAt"]:[])]);
    const snapshot=this.read<StoredSnapshot>(scope,parseInternalId(body.snapshotId),"snapshot",owner);
    this.checkSnapshot(scope,owner,snapshot);if(snapshot.state!=="ready")contextFail("MEMORY_CONTEXT_PERMIT_USED");
    if(body.requestDigest!==snapshot.requestDigest)contextFail("MEMORY_CONTEXT_REQUEST_CHANGED");
    const id=parseInternalId(body.permitId);
    if(command.kind==="permit"){this.save(scope,"permit",{...owner,id,snapshotId:snapshot.id,state:"ready"} as StoredPermit);return {permitId:id}}
    const permit=this.read<StoredPermit>(scope,id,"permit",owner);if(permit.snapshotId!==snapshot.id||permit.state!=="ready")contextFail("MEMORY_CONTEXT_PERMIT_USED");
    const claimedAt=transactionNow(this.db);if(!Number.isSafeInteger(body.attemptAt)||(body.attemptAt as number)<0||(body.attemptAt as number)>claimedAt||claimedAt-(body.attemptAt as number)>CONTEXT_CLAIM_WINDOW_MS)contextFail("MEMORY_RECALL_CLOCK_INVALID");
    new RecallRepository(this.db,this.key,()=>transactionNow(this.db),this.fault).prepareUseWithinTransaction(scope,{...owner,bootId:parseInternalId(body.processBootId)},parseInternalId(body.useTicketId),snapshot.recallDeps,new FactQuery(this.db,this.key).validate(scope,owner,snapshot.factQuery));
    permit.state="claimed";snapshot.state="claimed";this.save(scope,"permit",permit);this.save(scope,"snapshot",snapshot);return {claimed:true,claimedAt};
   }
   contextFail("MEMORY_CONTEXT_COMMAND_INVALID");
  };
  if(["baseline","inspect","validateSnapshot","validateResponse","summaryGet","summaryLeaseState","summaryLeaseRead"].includes(command.kind as string)){
   if(command.commandId!==undefined)contextFail("MEMORY_CONTEXT_INPUT_INVALID");this.db.exec("BEGIN IMMEDIATE");try{const result=withTransactionClock(this.db,this.clock,apply);this.db.exec("COMMIT");return result}catch(error){this.db.exec("ROLLBACK");throw error}
  }
  return executeTransaction({db:this.db,key:this.key,scope,commandId:parseInternalId(command.commandId),request:value,fault:this.fault,clock:this.clock,apply});
 }
}
