import {FactQuery} from "../memory-policy/fact-query";
import {transactionNow,withTransactionClock} from "../memory-core/transaction-clock";
import {createHash} from "node:crypto";
import type {DatabaseSync} from "node:sqlite";
import type {FactView} from "../../shared/memory-contracts";
import {objectFields,parseInternalId,positiveRevision} from "../memory-core/command-validation";
import {executeTransaction,type TransactionFault} from "../memory-core/command-transactions";
import {RecordCodec} from "../memory-core/record-codec";
import {canonicalJson} from "../memory-core/repository-types";
import {Suppression} from "../memory-core/suppression";
import {PolicyRepository} from "../memory-policy/policy-repository";
import {FactSupports} from "../memory-policy/fact-supports";
import {calculateStrength,initializeStrength,transitionPolicy,validateRecallPolicy,refreshStrength,recordAccess,isArchiveCandidate,DEFAULT_RECALL_POLICY} from "./recall-decay";
import {recallFail,type RecallPolicy,type RecallState,type RecallFactRef,type RecallProtection,type StrengthState,type RecallAction,type RecallPreview,type RecallDependency} from "./recall-contracts";

interface PolicyRecord {id:string;actorKey:string;revision:number;configuredAt:number;policy:RecallPolicy}
export interface RecallUseOwner {actorKey:string;providerId:string;sessionId:string;bootId:string}
interface UseRecord extends RecallUseOwner {id:string;revision:number;state:"pending"|"invoked"|"unknown";createdAt:number;invokedAt:number|null;dependencies:RecallDependency[];recorded:number}
function natural(value:unknown):number{if(!Number.isSafeInteger(value)||(value as number)<0)recallFail("MEMORY_RECALL_STATE_INVALID");return value as number}
function strength(s:StrengthState):StrengthState{return {lastAccessAt:s.lastAccessAt,decayAnchorAt:s.decayAnchorAt,lastCalculatedAt:s.lastCalculatedAt,strengthAtLastCalculation:s.strengthAtLastCalculation}}
function opaque(kind:string,values:unknown):string{return "recall-"+kind+"-"+createHash("sha256").update(canonicalJson(values)).digest("hex")}
function refs(value:unknown):RecallFactRef[]{if(!Array.isArray(value)||value.length>200)recallFail("MEMORY_RECALL_INPUT_INVALID");const result=value.map(raw=>{const r=objectFields(raw,["factId","revision"]);return {factId:parseInternalId(r.factId),revision:positiveRevision(r.revision)}});if(new Set(result.map(r=>canonicalJson(r))).size!==result.length)recallFail("MEMORY_RECALL_INPUT_INVALID");return result}
function action(value:unknown):RecallAction{if(!["archive","restore","pin","unpin","maintenance"].includes(value as string))recallFail("MEMORY_RECALL_INPUT_INVALID");return value as RecallAction}
export function parseRecallDependencies(value:unknown):RecallDependency[]{if(!Array.isArray(value)||value.length>200)recallFail("MEMORY_RECALL_INPUT_INVALID");const result=value.map(raw=>{const r=objectFields(raw,["factId","revision","visibilityRevision"]);return {factId:parseInternalId(r.factId),revision:positiveRevision(r.revision),visibilityRevision:natural(r.visibilityRevision)}});refs(result.map(({factId,revision})=>({factId,revision})));return result}
function preview(value:unknown):RecallPreview{
 const p=objectFields(value,["action","generation","policyVersion","policyRevision","expiresAt","targets","requiredFactRefs","candidates","mode"]);
 if(!Array.isArray(p.targets)||p.targets.length>200||!["disabled","dry-run","enabled"].includes(p.mode as string))recallFail("MEMORY_RECALL_INPUT_INVALID");
 const targets=p.targets.map(raw=>{const r=objectFields(raw,["factId","revision","projectionRevision","visibilityRevision"]);return {factId:parseInternalId(r.factId),revision:positiveRevision(r.revision),projectionRevision:positiveRevision(r.projectionRevision),visibilityRevision:natural(r.visibilityRevision)}});refs(targets.map(({factId,revision})=>({factId,revision})));
 return {action:action(p.action),generation:natural(p.generation),policyVersion:parseInternalId(p.policyVersion),policyRevision:positiveRevision(p.policyRevision),expiresAt:natural(p.expiresAt),targets,requiredFactRefs:refs(p.requiredFactRefs),candidates:natural(p.candidates),mode:p.mode as RecallPreview["mode"]};
}

/** Worker-only recall projection. It cannot mutate fact truth or support records. */
export class RecallRepository {
 private readonly codec:RecordCodec;private readonly facts:PolicyRepository;private readonly supports:FactSupports;private readonly suppression:Suppression;
 constructor(private readonly db:DatabaseSync,private readonly key:Uint8Array,private readonly clock:()=>number=Date.now,private readonly fault?:TransactionFault){this.codec=new RecordCodec(key);this.facts=new PolicyRepository(db,key);this.supports=new FactSupports(db,key);this.suppression=new Suppression(db,key)}
 private transaction(){if(!this.db.isTransaction)recallFail("MEMORY_TRANSACTION_REQUIRED")}
 private now():number{return transactionNow(this.db)}
 private read<T extends {id:string;actorKey:string}>(scope:string,id:string,kind:"policy"|"state"|"use",actor:string):T|undefined{
  this.transaction();const row=this.db.prepare("SELECT kind,revision,payload FROM recall_records WHERE scope_key=? AND id=?").get(scope,id);if(!row)return;
  if(row.kind!==kind)recallFail("MEMORY_DATA_INVALID");const record=this.codec.open<T>("recall-"+kind,scope,id,row.payload);
  if(record.id!==id||record.actorKey!==actor)recallFail("MEMORY_DATA_INVALID");
  if(kind==="state"&&(record as unknown as RecallState).projectionRevision!==row.revision)recallFail("MEMORY_DATA_INVALID");
  if((kind==="policy"||kind==="use")&&(record as unknown as PolicyRecord).revision!==row.revision)recallFail("MEMORY_DATA_INVALID");return record;
 }
 private save(scope:string,kind:"policy"|"state"|"use",r:PolicyRecord|RecallState|UseRecord):void{
  this.transaction();const revision="projectionRevision" in r?r.projectionRevision:r.revision;
  this.db.prepare("INSERT INTO recall_records VALUES(?,?,?,?,?) ON CONFLICT(id,scope_key) DO UPDATE SET revision=excluded.revision,payload=excluded.payload WHERE kind=excluded.kind").run(r.id,scope,kind,revision,this.codec.seal("recall-"+kind,scope,r.id,r));this.fault?.("after-record");
 }
 private policy(scope:string,actor:string,now:number):PolicyRecord{
  const id=opaque("policy",actor),r=this.read<PolicyRecord>(scope,id,"policy",actor);
  if(r){objectFields(r,["id","actorKey","revision","configuredAt","policy"]);positiveRevision(r.revision);if(natural(r.configuredAt)>now)recallFail("MEMORY_RECALL_CLOCK_INVALID");return {...r,policy:validateRecallPolicy(r.policy)}}
  const initial={id,actorKey:actor,revision:1,configuredAt:now,policy:{...DEFAULT_RECALL_POLICY}};this.save(scope,"policy",initial);return initial;
 }
 private checkedState(r:RecallState,now:number,policy:RecallPolicy):RecallState{
  objectFields(r,["id","actorKey","factId","factRevision","projectionRevision","visibilityRevision","visibility","pinned","policyVersion","archivedAt","archiveReason","accessCount","lastAccessAt","decayAnchorAt","lastCalculatedAt","strengthAtLastCalculation"]);
  if(r.id!==opaque("state",{actor:r.actorKey,factId:r.factId,revision:r.factRevision}))recallFail("MEMORY_DATA_INVALID");parseInternalId(r.factId);positiveRevision(r.factRevision);positiveRevision(r.projectionRevision);natural(r.visibilityRevision);natural(r.accessCount);
  if(!["normal","archived"].includes(r.visibility)||typeof r.pinned!=="boolean"||r.policyVersion!==policy.version||((r.visibility==="normal")!==(r.archivedAt===null&&r.archiveReason===null)))recallFail("MEMORY_DATA_INVALID");
  if(r.visibility==="archived"&&(!["manual","decay"].includes(r.archiveReason as string)||r.archivedAt===null||natural(r.archivedAt)>now))recallFail("MEMORY_DATA_INVALID");
  calculateStrength(strength(r),now,policy);return r;
 }
 private state(scope:string,actor:string,fact:RecallFactRef,policy:RecallPolicy,now:number):RecallState{
  const id=opaque("state",{actor,factId:fact.factId,revision:fact.revision}),old=this.read<RecallState>(scope,id,"state",actor);
  if(old){this.checkedState(old,now,policy);if(old.factId!==fact.factId||old.factRevision!==fact.revision)recallFail("MEMORY_DATA_INVALID");if(old.lastCalculatedAt===now)return old;
   const next={...old,...calculateStrength(strength(old),now,policy),projectionRevision:old.projectionRevision+1};this.save(scope,"state",next);return next;
  }
  const initial:RecallState={id,actorKey:actor,factId:fact.factId,factRevision:fact.revision,projectionRevision:1,visibilityRevision:0,visibility:"normal",pinned:false,policyVersion:policy.version,archivedAt:null,archiveReason:null,accessCount:0,...initializeStrength(now)};this.save(scope,"state",initial);return initial;
 }
 private protection(scope:string,actor:string,fact:FactView,state:RecallState):RecallProtection{
  const audit=this.supports.audit(scope,actor,fact.factId,fact),pending=this.db.prepare("SELECT id,payload FROM recall_records WHERE scope_key=? AND kind='use'").all(scope).some(row=>{const r=this.codec.open<UseRecord>("recall-use",scope,row.id as string,row.payload);return r.actorKey===actor&&r.state==="pending"&&r.dependencies.some(d=>d.factId===fact.factId&&d.revision===fact.revision)});
  return {pinned:state.pinned,required:pending,explicitConfirmation:audit.status==="eligible"&&audit.supports.some(s=>s.factRevision===fact.revision&&s.validity==="valid"&&s.kind==="explicitUserConfirmed"&&s.proof!==null)};
 }
 visibleFactsWithinTransaction(scope:string,actor:string,factRefs:RecallFactRef[],expected?:RecallDependency[],period?:import("../../shared/memory-contracts").FactTime|null):{facts:FactView[];recallDeps:RecallDependency[]}{
  this.transaction();const selected=refs(factRefs),deps=expected===undefined?undefined:parseRecallDependencies(expected),now=this.now(),policy=this.policy(scope,actor,now).policy,available=this.facts.eligibleFactsWithinTransaction(scope,actor,now,period);
  if(deps&&canonicalJson(deps.map(({factId,revision})=>({factId,revision})))!==canonicalJson(selected))recallFail("MEMORY_RECALL_VISIBILITY_STALE");
  const facts=selected.map(ref=>{const f=available.find(f=>f.factId===ref.factId&&f.revision===ref.revision);if(!f)recallFail("MEMORY_RECALL_FACT_UNAVAILABLE");return f});
  const recallDeps=facts.map((fact,index)=>{const state=this.state(scope,actor,fact,policy,now);if(state.visibility!=="normal")recallFail("MEMORY_RECALL_FACT_ARCHIVED");if(deps&&deps[index].visibilityRevision!==state.visibilityRevision)recallFail("MEMORY_RECALL_VISIBILITY_STALE");return {factId:fact.factId,revision:fact.revision,visibilityRevision:state.visibilityRevision}});return {facts,recallDeps};
 }
 /** H may inspect visibility without initializing policy, recalculating projection or refreshing access. */
 readVisibleFactsWithinTransaction(scope:string,actor:string,factRefs:RecallFactRef[],expected?:RecallDependency[],period?:import("../../shared/memory-contracts").FactTime|null):{facts:FactView[];recallDeps:RecallDependency[]}{
  this.transaction();const selected=refs(factRefs),deps=expected===undefined?undefined:parseRecallDependencies(expected),now=this.now();
  if(deps&&canonicalJson(deps.map(({factId,revision})=>({factId,revision})))!==canonicalJson(selected))recallFail("MEMORY_RECALL_VISIBILITY_STALE");
  const policyRecord=this.read<PolicyRecord>(scope,opaque("policy",actor),"policy",actor);if(policyRecord&&natural(policyRecord.configuredAt)>now)recallFail("MEMORY_RECALL_CLOCK_INVALID");const policy=policyRecord?validateRecallPolicy(policyRecord.policy):DEFAULT_RECALL_POLICY,available=this.facts.eligibleFactsWithinTransaction(scope,actor,now,period);
  const facts=selected.map(ref=>{const f=available.find(f=>f.factId===ref.factId&&f.revision===ref.revision);if(!f)recallFail("MEMORY_RECALL_FACT_UNAVAILABLE");return f});
  const recallDeps=facts.map((fact,index)=>{const old=this.read<RecallState>(scope,opaque("state",{actor,factId:fact.factId,revision:fact.revision}),"state",actor);if(old)this.checkedState(old,now,policy);if(old?.visibility==="archived")recallFail("MEMORY_RECALL_FACT_ARCHIVED");const visibilityRevision=old?.visibilityRevision??0;if(deps&&deps[index].visibilityRevision!==visibilityRevision)recallFail("MEMORY_RECALL_VISIBILITY_STALE");return {factId:fact.factId,revision:fact.revision,visibilityRevision}});return {facts,recallDeps};
 }
 private use(scope:string,owner:RecallUseOwner,id:string):UseRecord{
  const r=this.read<UseRecord>(scope,parseInternalId(id),"use",owner.actorKey);if(!r)recallFail("MEMORY_RECALL_USE_DENIED");objectFields(r,["id","actorKey","providerId","sessionId","bootId","revision","state","createdAt","invokedAt","dependencies","recorded"]);
  for(const k of ["actorKey","providerId","sessionId","bootId"] as const)if(r[k]!==owner[k])recallFail("MEMORY_RECALL_USE_DENIED");
  positiveRevision(r.revision);if(!["pending","invoked","unknown"].includes(r.state)||natural(r.createdAt)>this.now())recallFail("MEMORY_DATA_INVALID");parseRecallDependencies(r.dependencies);if(natural(r.recorded)>r.dependencies.length||(r.state==="invoked")!==(r.invokedAt!==null)||(r.state!=="invoked"&&r.recorded!==0))recallFail("MEMORY_DATA_INVALID");if(r.invokedAt!==null&&(natural(r.invokedAt)<r.createdAt||r.invokedAt>this.now()))recallFail("MEMORY_RECALL_CLOCK_INVALID");return r;
 }
 prepareUseWithinTransaction(scope:string,owner:RecallUseOwner,id:string,dependencies:RecallDependency[],period?:import("../../shared/memory-contracts").FactTime|null):void{
  this.transaction();for(const k of ["actorKey","providerId","sessionId","bootId"] as const)parseInternalId(owner[k]);parseInternalId(id);
  if(this.db.prepare("SELECT id FROM recall_records WHERE scope_key=? AND id=?").get(scope,id))recallFail("MEMORY_RECALL_USE_DENIED");const deps=parseRecallDependencies(dependencies);this.visibleFactsWithinTransaction(scope,owner.actorKey,deps.map(({factId,revision})=>({factId,revision})),deps,period);
  this.save(scope,"use",{...owner,id,revision:1,state:"pending",createdAt:this.now(),invokedAt:null,dependencies:deps,recorded:0});
 }
 confirmUseWithinTransaction(scope:string,owner:RecallUseOwner,id:string,invokedAt:number):{useStatus:"invoked";recorded:number}{
  this.transaction();const ticket=this.use(scope,owner,id),now=this.now();if(ticket.state==="unknown")recallFail("MEMORY_RECALL_USE_UNKNOWN");if(ticket.state==="invoked")return {useStatus:"invoked",recorded:ticket.recorded};
  if(natural(invokedAt)<ticket.createdAt||invokedAt>now)recallFail("MEMORY_RECALL_CLOCK_INVALID");const policy=this.policy(scope,owner.actorKey,now).policy,available=this.facts.eligibleFactsWithinTransaction(scope,owner.actorKey,now);let recorded=0;
  for(const dep of ticket.dependencies){const fact=available.find(f=>f.factId===dep.factId&&f.revision===dep.revision);if(!fact)continue;const state=this.state(scope,owner.actorKey,fact,policy,now);if(state.visibility!=="normal"||state.visibilityRevision!==dep.visibilityRevision)continue;if(state.lastAccessAt!==null&&invokedAt<state.lastAccessAt)recallFail("MEMORY_RECALL_CLOCK_INVALID");
   // A scan after invocation may have advanced its calculation clock. Rebase the
   // observed invocation itself, then decay forward; never invent a later access.
   const observed=calculateStrength(recordAccess(initializeStrength(invokedAt),invokedAt),now,policy);this.save(scope,"state",{...state,...observed,projectionRevision:state.projectionRevision+1,accessCount:state.accessCount+1});recorded++;
  }
  this.save(scope,"use",{...ticket,state:"invoked",invokedAt,recorded,revision:ticket.revision+1});return {useStatus:"invoked",recorded};
 }
 unknownUseWithinTransaction(scope:string,owner:RecallUseOwner,id:string):{useStatus:"unknown"|"invoked"}{this.transaction();const ticket=this.use(scope,owner,id);if(ticket.state==="invoked")return {useStatus:"invoked"};if(ticket.state==="pending")this.save(scope,"use",{...ticket,state:"unknown",revision:ticket.revision+1});return {useStatus:"unknown"}}
 execute(value:unknown):unknown{
  const c=objectFields(value,["kind","scopeKey","body"],["commandId"]),scope=parseInternalId(c.scopeKey),identity=["actorKey","providerId","sessionId","bootId"];
  const b=objectFields(c.body,identity,["factRefs","policy","action","preview","requiredFactRefs","factQuery"]),actor=parseInternalId(b.actorKey);for(const k of identity)parseInternalId(b[k]);
  if(!["rank","metadata","configure","preview","maintenancePreview","commit","recover"].includes(c.kind as string))recallFail("MEMORY_RECALL_INPUT_INVALID");
  const fields:Record<string,string[]>={rank:[],metadata:["factRefs"],configure:["policy"],preview:["factRefs","action"],maintenancePreview:["requiredFactRefs"],commit:["preview"],recover:[]};objectFields(b,[...identity,...fields[c.kind as string]],c.kind==="rank"?["factQuery"]:[]);
  const mutation=["configure","commit","recover"].includes(c.kind as string);if(!mutation&&c.commandId!==undefined)recallFail("MEMORY_RECALL_INPUT_INVALID");
  const apply=()=>{
   const now=this.now(),stored=this.policy(scope,actor,now),policy=stored.policy;
   if(c.kind==="recover"){let unknown=0;for(const row of this.db.prepare("SELECT id,payload FROM recall_records WHERE scope_key=? AND kind='use'").all(scope)){const r=this.codec.open<UseRecord>("recall-use",scope,row.id as string,row.payload);if(r.actorKey===actor&&r.bootId!==b.bootId&&r.state==="pending"){this.use(scope,r,r.id);this.save(scope,"use",{...r,state:"unknown",revision:r.revision+1});unknown++}}return {unknown}}
   if(c.kind==="configure"){
    const next=validateRecallPolicy(b.policy);if(policy.version===next.version&&canonicalJson(policy)!==canonicalJson(next))recallFail("MEMORY_RECALL_POLICY_CONFLICT");
    for(const row of this.db.prepare("SELECT id,payload FROM recall_records WHERE scope_key=? AND kind='state' ORDER BY id").all(scope)){
     const state=this.codec.open<RecallState>("recall-state",scope,row.id as string,row.payload);if(state.actorKey!==actor)continue;
     const r=this.read<RecallState>(scope,row.id as string,"state",actor)!;this.checkedState(r,now,policy);
     this.save(scope,"state",{...r,...transitionPolicy(strength(r),now,policy,next),policyVersion:next.version,projectionRevision:r.projectionRevision+1});
    }
    this.save(scope,"policy",{...stored,revision:stored.revision+1,configuredAt:now,policy:{...next}});return {policyVersion:next.version};
   }
   const query=c.kind==="rank"?new FactQuery(this.db,this.key).resolve(scope,{providerId:b.providerId as string,sessionId:b.sessionId as string},b.factQuery):undefined;
   const available=this.facts.eligibleFactsWithinTransaction(scope,actor,now,query?.time),generation=this.suppression.generation(scope);
   if(c.kind==="preview"||c.kind==="maintenancePreview"){
    const kind=c.kind==="maintenancePreview"?"maintenance":action(b.action);if(c.kind==="preview"&&kind==="maintenance")recallFail("MEMORY_RECALL_INPUT_INVALID");
    const requiredFactRefs=c.kind==="maintenancePreview"?refs(b.requiredFactRefs):[],selected=c.kind==="maintenancePreview"?available.map(f=>({factId:f.factId,revision:f.revision})):refs(b.factRefs);
    for(const r of requiredFactRefs)if(!available.some(f=>f.factId===r.factId&&f.revision===r.revision))recallFail("MEMORY_RECALL_FACT_UNAVAILABLE");
    const states=selected.map(ref=>{const fact=available.find(f=>f.factId===ref.factId&&f.revision===ref.revision);if(!fact)recallFail("MEMORY_RECALL_FACT_UNAVAILABLE");const state=this.state(scope,actor,ref,policy,now);if(kind!=="maintenance")return state;
     const existing=this.protection(scope,actor,fact,state),protection={...existing,required:existing.required||requiredFactRefs.some(r=>r.factId===ref.factId&&r.revision===ref.revision)};return state.visibility==="normal"&&isArchiveCandidate(strength(state),now,policy,protection)?state:null;
    }).filter((s):s is RecallState=>s!==null);
    const targets=(kind==="maintenance"?states.slice(0,policy.batchSize):states).map(s=>({factId:s.factId,revision:s.factRevision,projectionRevision:s.projectionRevision,visibilityRevision:s.visibilityRevision}));
    return {action:kind,generation,policyVersion:policy.version,policyRevision:stored.revision,expiresAt:now+60000,targets,requiredFactRefs,candidates:states.length,mode:policy.maintenanceMode} satisfies RecallPreview;
   }
   if(c.kind==="commit"){
    const p=preview(b.preview);if(p.generation!==generation||p.policyVersion!==policy.version||p.policyRevision!==stored.revision)recallFail("MEMORY_RECALL_STALE");if(now>=p.expiresAt)recallFail("MEMORY_RECALL_PREVIEW_EXPIRED");if(p.expiresAt>now+60000)recallFail("MEMORY_RECALL_CLOCK_INVALID");
    if(p.action==="maintenance"&&(policy.maintenanceMode!=="enabled"||p.mode!=="enabled"||p.targets.length>policy.batchSize))recallFail("MEMORY_RECALL_MAINTENANCE_DENIED");let changed=0;
    for(const target of p.targets){
     const fact=available.find(f=>f.factId===target.factId&&f.revision===target.revision);if(!fact)recallFail("MEMORY_RECALL_FACT_UNAVAILABLE");
     const id=opaque("state",{actor,factId:target.factId,revision:target.revision}),old=this.read<RecallState>(scope,id,"state",actor);if(!old)recallFail("MEMORY_RECALL_STALE");this.checkedState(old,now,policy);
     if(old.projectionRevision!==target.projectionRevision||old.visibilityRevision!==target.visibilityRevision)recallFail("MEMORY_RECALL_STALE");
     if(p.action==="maintenance"){const existing=this.protection(scope,actor,fact,old),protection={...existing,required:existing.required||p.requiredFactRefs.some(r=>r.factId===fact.factId&&r.revision===fact.revision)};if(old.visibility!=="normal"||!isArchiveCandidate(strength(old),now,policy,protection))recallFail("MEMORY_RECALL_STALE")}
     let next={...old,...calculateStrength(strength(old),now,policy)};const archive=p.action==="archive"||p.action==="maintenance";
     if(archive&&old.visibility==="normal")next={...next,visibility:"archived",visibilityRevision:old.visibilityRevision+1,archivedAt:now,archiveReason:p.action==="maintenance"?"decay":"manual"};
     else if(p.action==="restore"&&old.visibility==="archived")next={...next,...refreshStrength(strength(old),now),visibility:"normal",visibilityRevision:old.visibilityRevision+1,archivedAt:null,archiveReason:null};
     else if(p.action==="pin"||p.action==="unpin")next={...next,pinned:p.action==="pin"};
     if(canonicalJson(next)!==canonicalJson(old)){next.projectionRevision++;this.save(scope,"state",next);changed++}
    }
    return {changed};
   }
   if(c.kind==="metadata"){
    const targets=refs(b.factRefs).map(ref=>{if(!available.some(f=>f.factId===ref.factId&&f.revision===ref.revision))recallFail("MEMORY_RECALL_FACT_UNAVAILABLE");return this.state(scope,actor,ref,policy,now)});return {generation,policy,targets};
   }
   const items=available.map(fact=>{const state=this.state(scope,actor,fact,policy,now);return {fact,state,protection:this.protection(scope,actor,fact,state),score:state.strengthAtLastCalculation}}).filter(item=>item.state.visibility==="normal");items.sort((a,b)=>b.score-a.score||a.fact.factId.localeCompare(b.fact.factId));return {generation,policy,items};
  };
  if(mutation)return executeTransaction({db:this.db,key:this.key,scope,commandId:parseInternalId(c.commandId),request:c,fault:this.fault,clock:this.clock,apply});
  this.db.exec("BEGIN IMMEDIATE");try{return withTransactionClock(this.db,this.clock,()=>{const result=apply();this.db.exec("COMMIT");return result})}catch(error){this.db.exec("ROLLBACK");throw error}
 }
}
