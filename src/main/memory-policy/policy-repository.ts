import {extractMaintenance,MAINTENANCE_VERSION,type MaintenanceClaim,type ContextKey,type MaintenanceExtraction} from "./maintenance-extractor";
import {createHash,randomUUID} from "node:crypto";
import type {DatabaseSync} from "node:sqlite";
import type {BoundSourceRef,FactDraft,SourceRef,TypedUserFact} from "../../shared/memory-contracts";
import type {NaturalAutomationConfig} from "../../shared/memory-automation-contracts";
import {objectFields,parseInternalId,parseSourceRef,positiveRevision,textField} from "../memory-core/command-validation";
import {canonicalJson} from "../memory-core/repository-types";
import {RecordCodec} from "../memory-core/record-codec";
import {SourceLedger} from "../memory-core/source-ledger";
import {Suppression} from "../memory-core/suppression";
import {FactRepository} from "../memory-core/fact-repository";
import {executeTransaction,type TransactionFault} from "../memory-core/command-transactions";
import {extractPreference,type Extraction, type Attribute} from "./extractor";
import type {PolicyCandidate,PolicyOutcome,PolicyBaseline,IntegrationResult} from "./policy-contracts";
import {FactSupports,type ConfirmationProof} from "./fact-supports";
import {transactionNow,withTransactionClock} from "../memory-core/transaction-clock";
import {isFactEffectiveAt} from "./fact-validity";
import {isProjectKey,projectForClaim} from "./project-scope";
import {policySubjectKey as subject} from "./fact-identity";
import {NATURAL_VERSION,assertTypedUserFact,factDigest,naturalAssertion,parseNaturalEdit,typedUserFact,validateNaturalResponse,type NaturalProposal} from "./natural-protocol";
import {NaturalJobRepository} from "./natural-job-repository";
import {automaticNaturalProposal} from "./natural-automation";

const POLICY_VERSION="main-preferences-v1";
const NATURAL_ADD_VERSION="natural-add-v1";
interface Candidate {
 id:string;revision:number;actorKey:string;generation:number;
 state:"candidate"|"active"|"rejected"|"invalidated";
 sourceRef:BoundSourceRef;extraction:Exclude<Extraction,{kind:"rejected"}>;
 contextKey?:ContextKey;cardinality?:"one"|"many";projectKey?:string;
 fact:FactDraft;evidenceId:string|null;reason:string;factId:string|null;
 typed?:TypedUserFact;evidenceSpan?:{start:number;end:number};replaces?:{candidateId:string;revision:number};resolvedBy?:string[];
}
function generation(value:unknown):number {
 if(!Number.isSafeInteger(value)||(value as number)<0)throw new Error("MEMORY_INPUT_INVALID");return value as number;
}
export {subject as policySubjectKey};
/** Every subject key a statement can stand for: the global one and, inside a project, that project's own. Suppression must be at least as wide as the fact it protects. */
export function claimSubjectKeys(actor:string,claim:MaintenanceClaim,project?:string):string[] {
 const scoped=projectForClaim(claim,project),keys=[subject(actor,claim.attribute,claim.context,claim.cardinality,claim.value)];
 if(scoped!==undefined)keys.push(subject(actor,claim.attribute,claim.context,claim.cardinality,claim.value,scoped));
 return keys;
}
function extraction(value:unknown):Extraction {
 const base=objectFields(value,["kind","reason"],["attribute","value","text"]);
 if(base.kind==="rejected"){objectFields(value,["kind","reason"]);if(base.reason!=="secret")throw new Error("MEMORY_INPUT_INVALID");return {kind:"rejected",reason:"secret"};}
 const parsed=extractPreference(base.text as string);
 if(canonicalJson(value)!==canonicalJson(parsed))throw new Error("MEMORY_INPUT_INVALID");return parsed;
}

function parseBaseline(value:unknown):PolicyBaseline[] {
 if(!Array.isArray(value)||value.length>10000)throw new Error("MEMORY_INPUT_INVALID");
 return value.map(item=>{const r=objectFields(item,["factId","revision","subjectKey"]);return {factId:parseInternalId(r.factId),revision:positiveRevision(r.revision),subjectKey:textField(r.subjectKey)}});
}
function matchesBaseline(previous:{factId:string;revision:number;subjectKey:string},baseline:PolicyBaseline[]):boolean {
 const expected=baseline.find(f=>f.subjectKey===previous.subjectKey);return expected?.factId===previous.factId&&expected.revision===previous.revision;
}
/** Worker-only synthetic B2 ledger. All lifecycle writes share a core transaction. */
export class PolicyRepository {
 private readonly codec:RecordCodec;private readonly suppression:Suppression;private readonly ledger:SourceLedger;private readonly facts:FactRepository;
 private readonly supports:FactSupports;
 constructor(private readonly db:DatabaseSync,private readonly key:Uint8Array,private readonly fault?:TransactionFault,private readonly clock:()=>number=Date.now) {
  this.codec=new RecordCodec(key);this.suppression=new Suppression(db,key);this.ledger=new SourceLedger(db,key);this.facts=new FactRepository(db,key,fault);
  this.supports=new FactSupports(db,key);
 }
 /** Context worker reuses policy eligibility in its own transaction; no nested BEGIN. */
 eligibleFactsWithinTransaction(scope:string,actor:string,now:number,period?:import("../../shared/memory-contracts").FactTime|null|"management"):import("../../shared/memory-contracts").FactView[] {
  if(now!==transactionNow(this.db))throw new Error("MEMORY_TRANSACTION_CLOCK_INVALID");
  if(period===null)return [];
  const owners=this.records(scope).filter(r=>r.actorKey===actor&&r.factId!==null);
  return this.facts.current(scope).flatMap(f=>{
   const owner=owners.find(r=>r.factId===f.factId);
   const current=isFactEffectiveAt(f.time,now),effective=period==="management"?true:period?f.time.validFrom!==null&&f.time.validTo!==null&&f.time.validFrom<period.validTo!&&period.validFrom!<f.time.validTo:current;
   if(!owner||!effective||this.supports.audit(scope,actor,f.factId,f).status!=="eligible")return [];
   if(owner.typed){try{this.source(scope,owner.sourceRef)}catch{return []}}
   return [{...f,...(owner.typed?{typed:owner.typed}:{})}];
  });
 }
 private records(scope:string):Candidate[] {
  return this.db.prepare("SELECT id,revision,payload FROM policy_records WHERE scope_key=? ORDER BY id").all(scope).map(row=>{
   const record=this.codec.open<Candidate>("policy-record",scope,row.id as string,row.payload);
   if(record.id!==row.id||record.revision!==row.revision||record.fact.subjectKey!==subject(record.actorKey,record.extraction.attribute,record.contextKey,record.cardinality,record.extraction.value,record.projectKey))throw new Error("MEMORY_DATA_INVALID");
   if(record.typed){assertTypedUserFact(record.actorKey,record.typed);if(record.projectKey!==undefined||record.typed.slotKey!==record.fact.subjectKey||record.typed.legacyAttribute!==record.extraction.attribute||record.typed.canonicalValue!==record.extraction.value)throw Error("MEMORY_DATA_INVALID")}
   return record;
  });
 }
 private save(scope:string,record:Candidate):void {
  this.db.prepare("INSERT INTO policy_records(id,scope_key,revision,payload) VALUES(?,?,?,?) ON CONFLICT(id,scope_key) DO UPDATE SET revision=excluded.revision,payload=excluded.payload")
   .run(record.id,scope,record.revision,this.codec.seal("policy-record",scope,record.id,record));this.fault?.("after-record");
 }
 private source(scope:string,value:unknown,text?:string):BoundSourceRef {
  const ref=parseSourceRef(value);if(!ref.binding||ref.span)throw new Error("MEMORY_POLICY_FULL_SOURCE_REQUIRED");
  const head=this.ledger.assertCurrent(scope,ref);if(!head?.published)throw new Error("MEMORY_SOURCE_INVALID");
  if(text!==undefined){const fingerprint=createHash("sha256").update(canonicalJson({text,state:head.published.state,role:head.published.role,trust:head.published.trust})).digest("hex");if(fingerprint!==head.published.fingerprint)throw new Error("MEMORY_SOURCE_QUOTE_MISMATCH");}
  return ref as BoundSourceRef;
 }
 private currentGeneration(scope:string,expected:unknown):number {
  const value=generation(expected);if(value!==this.suppression.generation(scope))throw new Error("MEMORY_POLICY_SUPPRESSED");return value;
 }
 private candidate(scope:string,actor:string,id:unknown,revision:unknown):Candidate {
  const record=this.records(scope).find(c=>c.id===parseInternalId(id)&&c.actorKey===actor);
  if(!record)throw new Error("MEMORY_CANDIDATE_NOT_FOUND");
  this.currentGeneration(scope,record.generation);
  if(record.revision!==positiveRevision(revision))throw new Error("MEMORY_REVISION_CONFLICT");
  if(record.state!=="candidate")throw new Error("MEMORY_CANDIDATE_NOT_FOUND");
  this.source(scope,record.sourceRef);return record;
 }
 private contentHash(scope:string,r:Candidate):string {return factDigest({version:2,scope,actor:r.actorKey,id:r.id,revision:r.revision,sourceRef:r.sourceRef,fact:r.fact,typed:r.typed??null,project:r.projectKey??null})}
 private invalidateCandidate(scope:string,r:Candidate,resolvedBy:string[]):void {
  r.state="invalidated";r.revision++;r.resolvedBy=resolvedBy;this.save(scope,r);
  this.db.prepare("UPDATE candidates SET state='invalidated' WHERE scope_key=? AND id=?").run(scope,r.id);
 }
 private insertNatural(scope:string,actor:string,gen:number,ref:BoundSourceRef,proposal:NaturalProposal,at:number|null,old?:Candidate):Candidate {
  const typed=typedUserFact(actor,proposal);
  if(this.suppression.subjectBlocked(scope,typed.slotKey)||this.suppression.sourceBlocked(scope,ref))throw Error("MEMORY_POLICY_SUPPRESSED");
  const id=randomUUID(),evidenceId=randomUUID(),assertion=naturalAssertion(typed),fact:FactDraft={subjectKey:typed.slotKey,assertion,assertionKind:"user-statement",time:proposal.time??{validFrom:null,validTo:null,referenceTime:at}};
  this.facts.applyWithinTransaction(scope,"appendEvidence",{evidenceId,sourceRef:ref,text:proposal.quote});
  this.facts.applyWithinTransaction(scope,"proposeCandidate",{candidateId:id,evidenceId,fact});
  const record:Candidate={id,revision:1,actorKey:actor,generation:gen,state:"candidate",sourceRef:ref,extraction:{kind:"direct",attribute:typed.legacyAttribute,value:typed.canonicalValue,text:assertion,reason:NATURAL_VERSION},contextKey:"default",cardinality:typed.cardinality,fact,evidenceId,reason:"model-needs-confirmation",factId:null,typed,evidenceSpan:proposal.span,...(old?{replaces:{candidateId:old.id,revision:old.revision}}:{})};
  this.save(scope,record);return record;
 }
 private naturalSnapshot(scope:string,actor:string,value:unknown):object {
  const ref=this.source(scope,value),head=this.ledger.assertCurrent(scope,ref)!;
  if(head.published?.role!=="user"||head.published.trust!=="direct-user-event")throw Error("MEMORY_USER_SOURCE_DENIED");
  const gen=this.suppression.generation(scope);
  if(this.suppression.sourceBlocked(scope,ref)||head.observedSuppressionGeneration!==gen)return {done:{items:[{status:"suppressed",reason:"forgotten"}]}};
  const related=this.records(scope).filter(r=>r.actorKey===actor&&canonicalJson(r.sourceRef)===canonicalJson(ref));
  const existing=related.filter(r=>r.typed||r.state==="active"||r.state==="rejected");
  if(existing.length)return {done:{items:existing.map(r=>({status:r.state==="invalidated"?"suppressed":r.state,candidateId:r.id,candidateRevision:r.revision,...(r.factId?{factId:r.factId}:{})}))}};
  const old=related.find(r=>r.state==="candidate"&&r.extraction.kind==="candidate");
  return {generation:gen,predecessor:old?{candidateId:old.id,revision:old.revision}:null};
 }
 private proposeNatural(scope:string,actor:string,gen:number,input:Record<string,unknown>,automation?:{captured:NaturalAutomationConfig;current:NaturalAutomationConfig}):IntegrationResult {
  const b=objectFields(input,["actorKey","generation","sourceRef","sourceText","raw","predecessor","policyVersion"]);
  if(b.policyVersion!==NATURAL_VERSION||typeof b.sourceText!=="string"||b.sourceText.length>4000)throw Error("MEMORY_INPUT_INVALID");
  const ref=this.source(scope,b.sourceRef,b.sourceText),head=this.ledger.assertCurrent(scope,ref)!;
  if(head.published?.role!=="user"||head.published.trust!=="direct-user-event")throw Error("MEMORY_USER_SOURCE_DENIED");
  if(head.observedSuppressionGeneration!==gen||this.suppression.sourceBlocked(scope,ref))throw Error("MEMORY_POLICY_SUPPRESSED");
  const at=head.published.occurredAt??null;if(at!==null&&at>transactionNow(this.db))throw Error("MEMORY_POLICY_FUTURE");
  let old:Candidate|undefined;
  if(b.predecessor!==null){const p=objectFields(b.predecessor,["candidateId","revision"]);old=this.candidate(scope,actor,p.candidateId,p.revision);if(canonicalJson(old.sourceRef)!==canonicalJson(ref))throw Error("MEMORY_SOURCE_STALE")}
  const proposals=validateNaturalResponse(b.raw,b.sourceText,ref.binding.messageId,head.published),created:Candidate[]=[],items:PolicyOutcome[]=[];
  // This context is constructed only by the journal's local-application callback.
  // Public/model proposals cannot supply an authorization field.
  const automatic=automation&&automation.captured.revision===automation.current.revision?automaticNaturalProposal(b.sourceText,proposals):null;
  for(const proposal of proposals){
   const typed=typedUserFact(actor,proposal);
   if(this.suppression.subjectBlocked(scope,typed.slotKey)){items.push({status:"suppressed",reason:"forgotten"});continue}
   const flag=typed.attribute==="language"?"language":typed.attribute==="response-style"?"responseStyle":null;
   const permitted=automatic!==null&&flag!==null&&automation!.captured[flag]&&automation!.current[flag];
   if(permitted){
    const previous=this.facts.current(scope).find(f=>f.subjectKey===typed.slotKey);
    if(!previous){
     const record=this.insertNatural(scope,actor,gen,ref,proposal,at,old);created.push(record);items.push(this.active(scope,record,"policyAccepted",ref,undefined,NATURAL_ADD_VERSION));continue;
    }
    const eligible=this.eligibleFactsWithinTransaction(scope,actor,transactionNow(this.db)).find(f=>f.factId===previous.factId);
    const owner=this.records(scope).find(r=>r.actorKey===actor&&r.state==="active"&&r.factId===previous.factId);
    const audit=this.supports.audit(scope,actor,previous.factId,previous);
    if(eligible?.typed?.assertionKey===typed.assertionKey&&owner&&!audit.supports.some(s=>s.sourceRef.sourceId===ref.sourceId)){
     this.supports.add(scope,actor,previous,ref,"automatic");created.push(owner);items.push({status:"active",factId:previous.factId,factRevision:previous.revision,reason:"duplicate-support"});continue;
    }
   }
   const record=this.insertNatural(scope,actor,gen,ref,proposal,at,old);created.push(record);items.push({status:"candidate",candidateId:record.id,candidateRevision:1,reason:record.reason});
  }
  if(old&&created.length)this.invalidateCandidate(scope,old,created.map(r=>r.id));
  return {items};
 }
 private draft(actor:string,parsed:Exclude<Extraction,{kind:"rejected"}>,context:ContextKey="default",cardinality:"one"|"many"="one",referenceTime:number|null=null,validFrom:number|null=null,project?:string):FactDraft {
  return {subjectKey:subject(actor,parsed.attribute,context,cardinality,parsed.value,project),assertion:parsed.kind==="direct"?parsed.text:"",assertionKind:parsed.kind==="direct"?"user-statement":"inference",time:{validFrom,validTo:null,referenceTime}};
 }
 private insert(scope:string,actor:string,gen:number,ref:BoundSourceRef,parsed:Exclude<Extraction,{kind:"rejected"}>,reason:string,context:ContextKey="default",cardinality:"one"|"many"="one",referenceTime:number|null=null,project?:string):Candidate {
  const id=randomUUID(),evidenceId=parsed.kind==="direct"?randomUUID():null,fact=this.draft(actor,parsed,context,cardinality,referenceTime,null,project);
  if(evidenceId!==null){
   this.facts.applyWithinTransaction(scope,"appendEvidence",{evidenceId,sourceRef:ref,text:parsed.text});
   this.facts.applyWithinTransaction(scope,"proposeCandidate",{candidateId:id,evidenceId,fact});
  }
  // Unknown/sensitive/free-form text may contain an unlabelled secret. Keep a
  // review reference and reason, never a second copy of its arbitrary body.
  const stored=parsed.kind==="direct"?parsed:{...parsed,text:""};
  const record:Candidate={id,revision:1,actorKey:actor,generation:gen,state:"candidate",sourceRef:ref,extraction:stored,contextKey:context,cardinality,...(project!==undefined?{projectKey:project}:{}),fact,evidenceId,reason,factId:null};this.save(scope,record);return record;
 }
 private active(scope:string,record:Candidate,reason:"policyAccepted"|"explicitUserConfirmed",event:SourceRef,support?:{sourceRef:BoundSourceRef;proof:ConfirmationProof},policyVersion=POLICY_VERSION):PolicyOutcome {
  if(record.extraction.kind!=="direct")throw new Error("MEMORY_POLICY_UNRESOLVED");
  const occurredAt=this.ledger.assertCurrent(scope,record.sourceRef)?.published?.occurredAt;
  if(occurredAt!==undefined&&occurredAt>transactionNow(this.db))throw new Error("MEMORY_POLICY_FUTURE");
  const result=this.facts.applyWithinTransaction(scope,"activateCandidate",{candidateId:record.id,authorization:{reason,sourceRef:event,policyVersion:reason==="policyAccepted"?policyVersion:null}});
  record.state="active";record.factId=result.id;record.revision++;this.save(scope,record);
  const view=this.facts.current(scope).find(f=>f.factId===result.id)!;
  if(reason==="policyAccepted")this.supports.add(scope,record.actorKey,view,record.sourceRef,"automatic");
  else{if(!support)throw new Error("MEMORY_EVENT_DENIED");this.supports.add(scope,record.actorKey,view,support.sourceRef,"explicitUserConfirmed",support.proof);}
  return {status:"active",candidateId:record.id,candidateRevision:record.revision,factId:result.id,factRevision:result.revision};
 }
 private eventSource(scope:string,commandId:string,intent:string,target?:{candidateId?:string;factId?:string}):SourceRef {
  const sourceRef={sourceId:commandId,revision:1};
  this.facts.applyWithinTransaction(scope,"registerSource",{sourceRef,kind:"user",intent,...target});return sourceRef;
 }
 private integrate(scope:string,actor:string,gen:number,input:Record<string,unknown>):IntegrationResult {
  const b=objectFields(input,["actorKey","generation","sourceRef","extraction","baseline","policyVersion"],["projectKey"]);
  if(b.projectKey!==undefined&&!isProjectKey(b.projectKey))throw new Error("MEMORY_PROJECT_INVALID");
  const project=b.projectKey as string|undefined;
  if(b.policyVersion!==MAINTENANCE_VERSION)throw new Error("MEMORY_POLICY_VERSION_INVALID");
  const e=objectFields(b.extraction,["kind"],["reason","attribute","value","text","claims"]);
  let parsed:MaintenanceExtraction;
  if(e.kind==="rejected"){const rejected=extraction(b.extraction);if(rejected.kind!=="rejected")throw new Error("MEMORY_INPUT_INVALID");parsed=rejected;}
  else parsed=extractMaintenance(e.text as string);
  if(canonicalJson(parsed)!==canonicalJson(b.extraction))throw new Error("MEMORY_INPUT_INVALID");
  const ref=this.source(scope,b.sourceRef,parsed.kind==="rejected"?undefined:parsed.text);
  const baseline=parseBaseline(b.baseline);
  if(parsed.kind==="rejected")return {items:[{status:"rejected",reason:"secret"}]};
  if(parsed.kind==="candidate"){
   if(this.suppression.sourceBlocked(scope,ref))return {items:[{status:"suppressed",reason:"forgotten"}]};
   const record=this.insert(scope,actor,gen,ref,parsed,parsed.reason);return {items:[{status:"candidate",candidateId:record.id,candidateRevision:1,reason:parsed.reason}]};
  }
  const observed=this.ledger.assertCurrent(scope,ref)!.published!;
  return {items:parsed.claims.map(claim=>this.integrateClaim(scope,actor,gen,ref,parsed.text,claim,observed.occurredAt??null,observed.role==="user"&&observed.trust==="direct-user-event",baseline,project))};
 }
 private integrateClaim(scope:string,actor:string,gen:number,ref:BoundSourceRef,text:string,claim:MaintenanceClaim,at:number|null,trusted:boolean,baseline:PolicyBaseline[],projectOfSession?:string):PolicyOutcome {
  const parsed:Exclude<Extraction,{kind:"rejected"}>={kind:"direct",attribute:claim.attribute,value:claim.value,reason:"direct-preference",text};
  const project=projectForClaim(claim,projectOfSession);
  const key=subject(actor,claim.attribute,claim.context,claim.cardinality,claim.value,project);
  if(this.suppression.sourceBlocked(scope,ref)||this.suppression.subjectBlocked(scope,key))return {status:"suppressed",reason:"forgotten"};
  const sameSlot=this.facts.current(scope).filter(f=>f.subjectKey===key),previous=sameSlot.find(f=>isFactEffectiveAt(f.time,transactionNow(this.db)));
  const owner=previous?this.records(scope).find(r=>r.actorKey===actor&&r.factId===previous.factId&&r.state==="active"):undefined;
  const candidate=(reason:string):PolicyOutcome=>{const record=this.insert(scope,actor,gen,ref,parsed,reason,claim.context,claim.cardinality,at,project);return {status:"candidate",candidateId:record.id,candidateRevision:1,reason}};
  if(!previous&&sameSlot.length)return candidate("temporal-conflict");
  if(!trusted)return candidate("untrusted-origin");
  if(at===null)return candidate("unknown-time");
  if(at>transactionNow(this.db))return candidate("future-source");
  // Check even equivalent values: a queued old source must not support a later manual revision.
  if(previous&&!matchesBaseline(previous,baseline))return candidate("stale-base");
  if(claim.operation==="change"&&previous){
   if(this.supports.audit(scope,actor,previous.factId,previous).reason==="no-valid-support")return candidate("prior-needs-review");
   const priorTime=this.supports.orderingTime(scope,actor,previous);
   if(priorTime===null)return candidate("unknown-prior-time");
   if(at<=priorTime)return candidate("out-of-order");
  }
  if(claim.operation==="deny"){
   if(!previous||!owner||owner.extraction.value!==claim.value)return candidate("denial-unmatched");
   const priorTime=this.supports.orderingTime(scope,actor,previous);
   if(priorTime===null)return candidate("unknown-prior-time");
   if(at<=priorTime)return candidate("out-of-order");
   if(owner.typed?.polarity==="negative"){this.supports.add(scope,actor,previous,ref,"automatic");return {status:"active",factId:previous.factId,factRevision:previous.revision,reason:"duplicate-support"};}
   this.supports.deny(scope,actor,previous,ref,randomUUID());return {status:"pending-review",factId:previous.factId,factRevision:previous.revision,reason:"explicit-denial"};
  }
  if(previous&&owner?.extraction.value===claim.value&&owner.typed?.polarity!=="negative"){this.supports.add(scope,actor,previous,ref,"automatic");return {status:"active",factId:previous.factId,factRevision:previous.revision,reason:"duplicate-support"};}
  if(previous){
   if(claim.operation!=="change"||claim.cardinality!=="one"||!owner)return candidate("conflict");
   if(claim.previousValue&&claim.previousValue!==owner.extraction.value)return candidate("change-old-mismatch");
   if(this.supports.audit(scope,actor,previous.factId,previous).status!=="eligible")return candidate("prior-needs-review");
   const fact=this.draft(actor,parsed,claim.context,claim.cardinality,at,at,project);
   const changed=this.facts.applyWithinTransaction(scope,"correctFact",{factId:previous.factId,expectedRevision:previous.revision,sourceRef:ref,fact,policyVersion:MAINTENANCE_VERSION});
   owner.fact=fact;owner.sourceRef=ref;owner.extraction=parsed;owner.revision++;if(owner.typed)owner.typed=typedUserFact(actor,{attribute:owner.typed.attribute,value:claim.value,polarity:"positive"});this.save(scope,owner);
   this.supports.add(scope,actor,this.facts.current(scope).find(f=>f.factId===previous.factId)!,ref,"automatic");
   return {status:"active",factId:previous.factId,factRevision:changed.revision,reason:"clear-current-change"};
  }
  // Inside a project an explicit change without a project value of its own is that project's first statement; it must not rewrite the global one.
  if(claim.operation==="change"&&project===undefined)return candidate("change-without-prior");
  const record=this.insert(scope,actor,gen,ref,parsed,"direct-preference",claim.context,claim.cardinality,at,project);
  return this.active(scope,record,"policyAccepted",ref,undefined,MAINTENANCE_VERSION);
 }
 execute(value:unknown):unknown {
  const cmd=objectFields(value,["kind","scopeKey","body"],["commandId"]),scope=parseInternalId(cmd.scopeKey);
  if(cmd.kind==="naturalJob")return new NaturalJobRepository(this.db,this.key,{
   snapshot:(scope,actor,ref)=>this.naturalSnapshot(scope,actor,ref),
   apply:(scope,actor,binding,text,proposals,current)=>this.proposeNatural(scope,actor,binding.generation,{actorKey:actor,generation:binding.generation,sourceRef:binding.sourceRef,sourceText:text,predecessor:binding.predecessor,policyVersion:NATURAL_VERSION,raw:JSON.stringify({facts:proposals.map(p=>({subject:"user",attribute:p.attribute==="address"?"form-of-address":p.attribute,value:p.value,polarity:p.polarity,quote:p.quote,status:"asserted",reason:"Validated saved user proposal"}))})},{captured:binding.consent,current}),
  },this.fault,this.clock).execute(value);
  const input=objectFields(cmd.body,["actorKey"],["generation","sourceRef","extraction","policyVersion","kind","nonce","candidateId","factId","revision","limit","after","baseline","projectKey","contentHash","scopeBinding","sourceText","raw","predecessor","naturalEdit"]),actor=parseInternalId(input.actorKey);
  if(cmd.kind==="generation"){objectFields(input,["actorKey"]);return this.suppression.generation(scope);}
  if(cmd.kind==="naturalSnapshot"||cmd.kind==="candidateBinding"||cmd.kind==="editBinding"){
   objectFields(input,cmd.kind==="naturalSnapshot"?["actorKey","sourceRef"]:cmd.kind==="candidateBinding"?["actorKey","candidateId","revision"]:["actorKey","revision"],["candidateId","factId"]);
   this.db.exec("BEGIN IMMEDIATE");try{return withTransactionClock(this.db,this.clock,()=>{
    let result:object;
    if(cmd.kind==="naturalSnapshot")result=this.naturalSnapshot(scope,actor,input.sourceRef);
    else if(cmd.kind==="candidateBinding")result={contentHash:this.contentHash(scope,this.candidate(scope,actor,input.candidateId,input.revision)),scopeBinding:scope};
    else{
     const owner=input.candidateId?this.candidate(scope,actor,input.candidateId,input.revision):this.records(scope).find(r=>r.actorKey===actor&&r.state==="active"&&r.factId===parseInternalId(input.factId));
     if(!owner)throw Error("MEMORY_FACT_NOT_FOUND");
     if(input.factId&&!this.facts.current(scope).some(f=>f.factId===owner.factId&&f.revision===positiveRevision(input.revision)))throw Error("MEMORY_REVISION_CONFLICT");
     result={typed:owner.typed??null};
    }
    this.db.exec("COMMIT");return result;
   })}catch(error){this.db.exec("ROLLBACK");throw error}
  }
  if(cmd.kind==="baseline"){
   objectFields(input,["actorKey"]);this.db.exec("BEGIN");
   try{return withTransactionClock(this.db,this.clock,()=>{
    const ids=new Set(this.records(scope).filter(r=>r.actorKey===actor&&r.factId!==null).map(r=>r.factId));
    const result=this.facts.current(scope).filter(f=>ids.has(f.factId)).map(f=>({factId:f.factId,revision:f.revision,subjectKey:f.subjectKey}));
    this.db.exec("COMMIT");return result;
   });}catch(error){this.db.exec("ROLLBACK");throw error}
  }
  if(cmd.kind==="recall"||cmd.kind==="manage"||cmd.kind==="audit"){
   objectFields(input,["actorKey",...(cmd.kind==="audit"?["factId"]:[])]);
   this.db.exec("BEGIN IMMEDIATE");
   try{return withTransactionClock(this.db,this.clock,()=>{
    const owners=this.records(scope).filter(r=>r.actorKey===actor&&r.factId!==null),facts=this.facts.current(scope);
    let result:unknown;
    if(cmd.kind==="audit"){const id=parseInternalId(input.factId);if(!owners.some(r=>r.factId===id))throw new Error("MEMORY_FACT_NOT_FOUND");result=this.supports.audit(scope,actor,id,facts.find(f=>f.factId===id));}
    else result=this.eligibleFactsWithinTransaction(scope,actor,transactionNow(this.db),cmd.kind==="manage"?"management":undefined).map(f=>({...f,scope:(owners.find(r=>r.factId===f.factId)?.projectKey!==undefined?"project":"global") as "global"|"project",...(owners.find(r=>r.factId===f.factId)?.projectKey!==undefined?{projectKey:owners.find(r=>r.factId===f.factId)!.projectKey}:{})}));
    this.db.exec("COMMIT");return result;
   });}catch(error){this.db.exec("ROLLBACK");throw error}
  }
  if(cmd.kind==="candidates"){
   const body=objectFields(input,["actorKey","generation","limit","after"]),gen=this.currentGeneration(scope,body.generation);
   if(!Number.isSafeInteger(body.limit)||(body.limit as number)<1||(body.limit as number)>101||typeof body.after!=="string")throw new Error("MEMORY_INPUT_INVALID");
   if(body.after)parseInternalId(body.after);
   // Hide pending/stale/deleted records. Confirmed M recall is unchanged.
   return this.records(scope).filter(r=>r.actorKey===actor&&r.generation===gen&&r.state==="candidate"&&r.id>(body.after as string)).flatMap(r=>{
    try {
     this.source(scope,r.sourceRef);
     if(this.suppression.subjectBlocked(scope,r.fact.subjectKey)||this.suppression.sourceBlocked(scope,r.sourceRef))return [];
     // Metadata comes from the current authenticated source, never a model or the read clock.
     return [{record:r,occurredAt:this.ledger.assertCurrent(scope,r.sourceRef)?.published?.occurredAt??null}];
    } catch { return []; } // One stale/pending/deleted source must not take down the panel.
   }).slice(0,body.limit as number).map(({record:r,occurredAt}):PolicyCandidate=>({candidateId:r.id,revision:r.revision,attribute:r.extraction.attribute,value:r.typed?.value??r.extraction.value,reason:r.reason,sourceRef:r.sourceRef,assertion:r.fact.assertion,reviewState:r.extraction.kind==="direct"&&r.fact.assertion.trim()?"ready":"reference-only",occurredAt,...(r.fact.time.validFrom!==null||r.fact.time.validTo!==null?{time:r.fact.time}:{}),contentHash:this.contentHash(scope,r),...(r.typed?{typed:r.typed}:{}),...(r.projectKey!==undefined?{projectKey:r.projectKey}:{})}));
  }
  if(cmd.kind!=="ingest"&&cmd.kind!=="event"&&cmd.kind!=="reconcileSupports"&&cmd.kind!=="integrate"&&cmd.kind!=="proposeNatural")throw new Error("MEMORY_INPUT_INVALID");
  const commandId=parseInternalId(cmd.commandId);
  // Baseline is an execution precondition, not a new intent. Exact source retries
  // replay the durable receipt across Main restarts rather than attach old input to a new revision.
  const {baseline:ignoredBaseline,...intentBody}=input;
  const request=cmd.kind==="ingest"||cmd.kind==="integrate"?{...cmd,body:intentBody}:value;
  return executeTransaction({db:this.db,key:this.key,scope,commandId,request,fault:this.fault,clock:this.clock,apply:()=>{
   const gen=this.currentGeneration(scope,input.generation);
   if(cmd.kind==="proposeNatural")return this.proposeNatural(scope,actor,gen,input);
   if(cmd.kind==="reconcileSupports"){objectFields(input,["actorKey","generation"]);const ids=new Set(this.records(scope).filter(r=>r.actorKey===actor&&r.factId!==null).map(r=>r.factId));const facts=this.facts.current(scope).filter(f=>ids.has(f.factId));this.supports.reconcile(scope,actor,facts);return {reconciled:facts.length};}
   if(cmd.kind==="integrate")return this.integrate(scope,actor,gen,input);
   if(cmd.kind==="ingest"){
    const b=objectFields(input,["actorKey","sourceRef","generation","extraction","policyVersion","baseline"]);
    if(b.policyVersion!==POLICY_VERSION)throw new Error("MEMORY_POLICY_VERSION_INVALID");
    const baseline=parseBaseline(b.baseline);
    const parsed=extraction(b.extraction),ref=this.source(scope,b.sourceRef,parsed.kind==="rejected"?undefined:parsed.text);
    if(parsed.kind==="rejected")return {status:"rejected",reason:"secret"};
    const fact=this.draft(actor,parsed);
    if(this.suppression.sourceBlocked(scope,ref)||this.suppression.subjectBlocked(scope,fact.subjectKey))return {status:"suppressed",reason:"forgotten"};
    const previous=this.facts.current(scope).find(f=>f.subjectKey===fact.subjectKey),conflict=previous!==undefined;
    const stale=previous&&!matchesBaseline(previous,baseline);
    const observed=this.ledger.assertCurrent(scope,ref)!.published!;
    const at=observed.occurredAt??null;
    if(at!==null&&at>transactionNow(this.db)){
     const record=this.insert(scope,actor,gen,ref,parsed,"future-source","default","one",at);
     return {status:"candidate",candidateId:record.id,candidateRevision:1,reason:"future-source"};
    }
    const direct=parsed.kind==="direct"&&observed.role==="user"&&observed.trust==="direct-user-event";
    const duplicate=direct&&!stale?this.records(scope).find(r=>r.actorKey===actor&&r.state==="active"&&r.fact.subjectKey===fact.subjectKey&&r.extraction.value===parsed.value&&r.typed?.polarity!=="negative"):undefined;
    if(duplicate?.factId){const current=this.facts.current(scope).find(f=>f.factId===duplicate.factId);if(current&&isFactEffectiveAt(current.time,transactionNow(this.db))){this.supports.add(scope,actor,current,ref,"automatic");return {status:"active",factId:current.factId,factRevision:current.revision,reason:"duplicate-support"};}}
    const reason=stale?"stale-base":conflict?"conflict":!direct&&parsed.kind==="direct"?"untrusted-origin":parsed.reason;
    const record=this.insert(scope,actor,gen,ref,parsed,reason,"default","one",at);
    return direct&&!conflict?this.active(scope,record,"policyAccepted",ref):{status:"candidate",candidateId:record.id,candidateRevision:1,reason};
   }
   const kind=input.kind,nonce=parseInternalId(input.nonce);
   if(kind==="confirm"||kind==="reject"||kind==="revise"||kind==="resolve"){
    objectFields(input,["actorKey","generation","kind","nonce","candidateId","revision",...(kind==="confirm"?["sourceRef"]:[])],["revise","resolve"].includes(kind as string)?["sourceRef","extraction","naturalEdit","sourceText"]:kind==="confirm"?["contentHash","scopeBinding"]:[]);
    const record=this.candidate(scope,actor,input.candidateId,input.revision);
    if(kind==="confirm"&&(record.typed||input.contentHash!==undefined)&&(input.scopeBinding!==scope||input.contentHash!==this.contentHash(scope,record)))throw Error("MEMORY_CONFIRMATION_STALE");
    if(kind==="confirm"){if(record.fact.time.referenceTime!==null&&record.fact.time.referenceTime>transactionNow(this.db))throw new Error("MEMORY_POLICY_FUTURE");const ref=this.source(scope,input.sourceRef);if(ref.sourceId===record.sourceRef.sourceId)throw new Error("MEMORY_CONFIRMATION_NOT_INDEPENDENT");return this.active(scope,record,"explicitUserConfirmed",this.eventSource(scope,commandId,"confirmation",{candidateId:record.id}),{sourceRef:ref,proof:{nonce,targetId:record.id,targetRevision:record.revision,action:"confirm",contentHash:this.contentHash(scope,record),scopeBinding:scope}});}
    if(kind==="reject"){
     record.state="rejected";record.revision++;this.save(scope,record);this.db.prepare("UPDATE candidates SET state='invalidated',revision=? WHERE scope_key=? AND id=?").run(record.revision,scope,record.id);
     return {status:"rejected",candidateId:record.id,candidateRevision:record.revision};
    }
    if(kind==="revise"&&input.naturalEdit!==undefined){
     if(!record.typed||typeof input.sourceText!=="string"||input.extraction!==undefined)throw Error("MEMORY_POLICY_UNRESOLVED");
     const proposal=parseNaturalEdit(input.sourceText,record.typed.attribute);if(canonicalJson(input.naturalEdit)!==canonicalJson(proposal))throw Error("MEMORY_INPUT_INVALID");
     const ref=this.source(scope,input.sourceRef,input.sourceText),head=this.ledger.assertCurrent(scope,ref)!.published!;
     if(head.role!=="user"||head.trust!=="direct-user-event")throw Error("MEMORY_EVENT_DENIED");
     const next=this.insertNatural(scope,actor,gen,ref,{...proposal,time:{...record.fact.time,referenceTime:head.occurredAt??null}},head.occurredAt??null,record);this.invalidateCandidate(scope,record,[next.id]);
     return {status:"candidate",candidateId:next.id,candidateRevision:1};
    }
    const parsed=extraction(input.extraction);if(parsed.kind!=="direct")throw new Error("MEMORY_POLICY_UNRESOLVED");
    const ref=this.source(scope,input.sourceRef,parsed.text),observed=this.ledger.assertCurrent(scope,ref)!.published!;
    if(observed.role!=="user"||observed.trust!=="direct-user-event")throw new Error("MEMORY_EVENT_DENIED");
    if(kind==="resolve"){
     if(this.suppression.sourceBlocked(scope,ref)||this.suppression.subjectBlocked(scope,subject(actor,parsed.attribute)))throw Error("MEMORY_POLICY_SUPPRESSED");
     const next=this.insert(scope,actor,gen,ref,parsed,"explicit-resolution",record.contextKey,record.cardinality,observed.occurredAt??null,record.projectKey);
     next.replaces={candidateId:record.id,revision:record.revision};this.save(scope,next);this.invalidateCandidate(scope,record,[next.id]);
     return {status:"candidate",candidateId:next.id,candidateRevision:1};
    }
    if(parsed.attribute!==record.extraction.attribute)throw new Error("MEMORY_POLICY_ATTRIBUTE_MISMATCH");
    if(this.suppression.sourceBlocked(scope,ref)||this.suppression.subjectBlocked(scope,record.fact.subjectKey))throw new Error("MEMORY_POLICY_SUPPRESSED");
    record.revision++;record.sourceRef=ref;record.extraction=parsed;record.fact=this.draft(actor,parsed,record.contextKey,record.cardinality,observed.occurredAt??null,null,record.projectKey);record.reason="explicit-revision";if(record.typed)record.typed=typedUserFact(actor,{attribute:record.typed.attribute,value:parsed.value!,polarity:"positive"});
    record.evidenceId=randomUUID();this.facts.applyWithinTransaction(scope,"appendEvidence",{evidenceId:record.evidenceId,sourceRef:ref,text:parsed.text});
    this.db.prepare("UPDATE candidates SET revision=?,source_id=?,parent_id=?,payload=? WHERE scope_key=? AND id=?").run(record.revision,ref.sourceId,record.evidenceId,this.codec.seal("candidates",scope,record.id,{sourceRef:ref,fact:record.fact}),scope,record.id);
    this.save(scope,record);return {status:"candidate",candidateId:record.id,candidateRevision:record.revision};
   }
   if(kind==="correct"||kind==="forget"||kind==="confirmFact"||kind==="deny"){
    objectFields(input,["actorKey","generation","kind","nonce","factId","revision"],kind==="correct"?["sourceRef","extraction","naturalEdit","sourceText"]:["confirmFact","deny"].includes(kind as string)?["sourceRef"]:[]);
    const factId=parseInternalId(input.factId),revision=positiveRevision(input.revision);
    const owner=this.records(scope).find(r=>r.actorKey===actor&&r.factId===factId&&r.state==="active");
    if(!owner)throw new Error("MEMORY_FACT_NOT_FOUND");
    const previous=this.facts.current(scope).find(f=>f.factId===factId);if(!previous)throw new Error("MEMORY_FACT_NOT_FOUND");
    if(previous.revision!==revision)throw new Error("MEMORY_REVISION_CONFLICT");
    if(kind==="confirmFact"||kind==="deny"){
     const ref=this.source(scope,input.sourceRef);if(ref.sourceId===owner.sourceRef.sourceId)throw new Error("MEMORY_CONFIRMATION_NOT_INDEPENDENT");
     if(kind==="deny"){this.supports.deny(scope,actor,previous,ref,nonce);return {status:"pending-review",factId,factRevision:revision,reason:"explicit-denial"};}
     this.supports.add(scope,actor,previous,ref,"explicitUserConfirmed",{nonce,targetId:factId,targetRevision:revision,action:"confirmFact"});return {status:"active",factId,factRevision:revision,reason:"explicit-support"};
    }
    if(kind==="forget"){
     const ref=this.eventSource(scope,commandId,"forget",{factId});
     const owned=new Set(this.records(scope).filter(r=>r.actorKey===actor&&r.fact.subjectKey===owner.fact.subjectKey&&r.factId).map(r=>r.factId));
     for(const sibling of this.facts.current(scope).filter(f=>owned.has(f.factId))){
      this.facts.applyWithinTransaction(scope,"forgetFact",{factId:sibling.factId,expectedRevision:sibling.revision,sourceRef:ref});
      this.suppression.includeOrigins(scope,sibling.factId,this.supports.forget(scope,actor,sibling.factId));
     }
     for(const r of this.records(scope)){if(r.fact.subjectKey===owner.fact.subjectKey){r.state="invalidated";r.revision++;this.save(scope,r);this.db.prepare("UPDATE candidates SET state='invalidated' WHERE scope_key=? AND id=?").run(scope,r.id);}}
     return {status:"forgotten",factId,factRevision:revision};
    }
    if(input.naturalEdit!==undefined){
     if(!owner.typed||typeof input.sourceText!=="string"||input.extraction!==undefined)throw Error("MEMORY_POLICY_UNRESOLVED");
     const proposal=parseNaturalEdit(input.sourceText,owner.typed.attribute);if(canonicalJson(input.naturalEdit)!==canonicalJson(proposal))throw Error("MEMORY_INPUT_INVALID");
     const source=this.source(scope,input.sourceRef,input.sourceText),observation=this.ledger.assertCurrent(scope,source)!.published!;
     if(observation.role!=="user"||observation.trust!=="direct-user-event"||this.suppression.sourceBlocked(scope,source))throw Error("MEMORY_EVENT_DENIED");
     const typed=typedUserFact(actor,proposal),fact:FactDraft={subjectKey:typed.slotKey,assertion:naturalAssertion(typed),assertionKind:"user-statement",time:{...owner.fact.time,referenceTime:observation.occurredAt??null}};
     const changed=this.facts.applyWithinTransaction(scope,"correctFact",{factId,expectedRevision:revision,sourceRef:source,fact});
     owner.typed=typed;owner.fact=fact;owner.sourceRef=source;owner.cardinality=typed.cardinality;owner.extraction={kind:"direct",attribute:typed.legacyAttribute,value:typed.canonicalValue,reason:NATURAL_VERSION,text:fact.assertion};owner.revision++;owner.evidenceSpan=proposal.span;this.save(scope,owner);
     this.supports.add(scope,actor,this.facts.current(scope).find(f=>f.factId===factId)!,source,"explicitUserConfirmed",{nonce,targetId:factId,targetRevision:revision,action:"correct"});
     return {status:"active",factId,factRevision:changed.revision};
    }
    const parsed=extraction(input.extraction);if(parsed.kind!=="direct"||parsed.attribute!==owner.extraction.attribute)throw new Error("MEMORY_POLICY_UNRESOLVED");
    const source=this.source(scope,input.sourceRef,parsed.text),observation=this.ledger.assertCurrent(scope,source)!.published!;
    if(observation.role!=="user"||observation.trust!=="direct-user-event")throw new Error("MEMORY_EVENT_DENIED");
    if(this.suppression.sourceBlocked(scope,source))throw new Error("MEMORY_POLICY_SUPPRESSED");
    // Correct's provenance points at the actual statement, not a synthetic event.
    const changed=this.facts.applyWithinTransaction(scope,"correctFact",{factId,expectedRevision:revision,sourceRef:source,fact:this.draft(actor,parsed,owner.contextKey,owner.cardinality,observation.occurredAt??null,null,owner.projectKey)});
    owner.fact=this.draft(actor,parsed,owner.contextKey,owner.cardinality,observation.occurredAt??null,null,owner.projectKey);owner.sourceRef=source;owner.extraction=parsed;owner.revision++;if(owner.typed)owner.typed=typedUserFact(actor,{attribute:owner.typed.attribute,value:parsed.value!,polarity:"positive"});this.save(scope,owner);
    this.supports.add(scope,actor,this.facts.current(scope).find(f=>f.factId===factId)!,source,"explicitUserConfirmed",{nonce,targetId:factId,targetRevision:revision,action:"correct"});
    return {status:"active",factId,factRevision:changed.revision};
   }
   if(kind==="remember"){
    objectFields(input,["actorKey","generation","kind","nonce","sourceRef","extraction"]);
    const parsed=extraction(input.extraction);if(parsed.kind!=="direct")throw new Error("MEMORY_POLICY_UNRESOLVED");
    const ref=this.source(scope,input.sourceRef,parsed.text),observation=this.ledger.assertCurrent(scope,ref)!.published!;
    if(observation.role!=="user"||observation.trust!=="direct-user-event")throw new Error("MEMORY_EVENT_DENIED");
    if(!this.suppression.subjectBlocked(scope,subject(actor,parsed.attribute))||this.suppression.sourceBlocked(scope,ref)||this.ledger.assertCurrent(scope,ref)!.observedSuppressionGeneration!==gen||this.records(scope).some(r=>r.sourceRef.sourceId===ref.sourceId&&r.generation<gen))throw new Error("MEMORY_POLICY_SUPPRESSED");
    const record=this.insert(scope,actor,gen,ref,parsed,"explicit-remember");
    return this.active(scope,record,"explicitUserConfirmed",this.eventSource(scope,commandId,"remember",{candidateId:record.id}),{sourceRef:ref,proof:{nonce,targetId:record.id,targetRevision:1,action:"remember"}});
   }
   throw new Error("MEMORY_EVENT_DENIED");
  }});
 }
}
