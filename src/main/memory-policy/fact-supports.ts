import {createHash} from "node:crypto";
import type {DatabaseSync} from "node:sqlite";
import type {BoundSourceRef,FactView,SourceRef} from "../../shared/memory-contracts";
import {RecordCodec} from "../memory-core/record-codec";
import {SourceLedger} from "../memory-core/source-ledger";
import {Suppression} from "../memory-core/suppression";
import {canonicalJson} from "../memory-core/repository-types";
import {transactionNow} from "../memory-core/transaction-clock";
export interface ConfirmationProof {nonce:string;targetId:string;targetRevision:number;action:"confirm"|"confirmFact"|"correct"|"remember";contentHash?:string;scopeBinding?:string}
interface Support {id:string;actorKey:string;factId:string;factRevision:number;subjectKey:string;sourceRef:BoundSourceRef;kind:"automatic"|"explicitUserConfirmed";proof:ConfirmationProof|null;state:"supported"|"suppressed";generation:number;checkedValidity?:string}
interface Review {actorKey:string;factId:string;factRevision:number;sourceRef:BoundSourceRef;nonce:string;generation:number;state:"recorded"|"suppressed"}
export interface SupportAudit {factId:string;revision:number|null;status:"eligible"|"pending-review"|"forgotten";reason:string;supports:Array<{sourceRef:BoundSourceRef;kind:Support["kind"];factRevision:number;validity:string;proof:ConfirmationProof|null}>;reviews:Array<{sourceRef:BoundSourceRef;factRevision:number}>}
/** Metadata only. Source validity is recomputed from the ledger in the caller's transaction. */
export class FactSupports {
 private readonly codec:RecordCodec;private readonly ledger:SourceLedger;private readonly suppression:Suppression;
 constructor(private readonly db:DatabaseSync,key:Uint8Array){this.codec=new RecordCodec(key);this.ledger=new SourceLedger(db,key);this.suppression=new Suppression(db,key)}
 private transaction(){if(!this.db.isTransaction)throw new Error("MEMORY_TRANSACTION_REQUIRED")}
 private read(scope:string,factId:string):Support[]{return this.db.prepare("SELECT id,fact_id,fact_revision,payload FROM fact_supports WHERE scope_key=? AND fact_id=? ORDER BY id").all(scope,factId).map(row=>{const r=this.codec.open<Support>("fact-support",scope,row.id as string,row.payload);if(r.id!==row.id||r.factId!==row.fact_id||r.factRevision!==row.fact_revision||!["automatic","explicitUserConfirmed"].includes(r.kind)||!["supported","suppressed"].includes(r.state)||(r.kind==="explicitUserConfirmed")!==(r.proof!==null))throw new Error("MEMORY_DATA_INVALID");return r})}
 private save(scope:string,r:Support){this.transaction();this.db.prepare("INSERT INTO fact_supports(id,scope_key,fact_id,fact_revision,payload) VALUES(?,?,?,?,?) ON CONFLICT(id,scope_key) DO UPDATE SET payload=excluded.payload").run(r.id,scope,r.factId,r.factRevision,this.codec.seal("fact-support",scope,r.id,r))}
 private validity(scope:string,r:Support):string {
  if(r.state==="suppressed"||this.suppression.sourceBlocked(scope,r.sourceRef))return "suppressed";
  try{const head=this.ledger.assertCurrent(scope,r.sourceRef);if(!head?.published||head.published.role!=="user"||head.published.trust!=="direct-user-event")return "untrusted";if(head.published.occurredAt!==undefined&&head.published.occurredAt>transactionNow(this.db))return "future";return "valid"}catch(error){const code=error instanceof Error?error.message:"";if(code==="MEMORY_SOURCE_PENDING")return "pending";if(code==="MEMORY_SOURCE_DELETED")return "deleted";if(code==="MEMORY_SOURCE_STALE")return "stale";throw error}
 }
 add(scope:string,actorKey:string,fact:FactView,sourceRef:BoundSourceRef,kind:Support["kind"],proof:ConfirmationProof|null=null):void {
  this.transaction();const head=this.ledger.assertCurrent(scope,sourceRef);
  if(!head?.published||head.published.role!=="user"||head.published.trust!=="direct-user-event"||this.suppression.sourceBlocked(scope,sourceRef))throw new Error("MEMORY_EVENT_DENIED");
  if(head.published.occurredAt!==undefined&&head.published.occurredAt>transactionNow(this.db))throw new Error("MEMORY_POLICY_FUTURE");
  if((kind==="explicitUserConfirmed")!==(proof!==null))throw new Error("MEMORY_EVENT_DENIED");
  const records=this.read(scope,fact.factId);
  if(kind==="explicitUserConfirmed"&&["confirm","confirmFact"].includes(proof!.action)&&records.some(r=>r.actorKey===actorKey&&r.kind==="automatic"&&r.sourceRef.sourceId===sourceRef.sourceId))throw new Error("MEMORY_CONFIRMATION_NOT_INDEPENDENT");
  const id=createHash("sha256").update(canonicalJson({actorKey,factId:fact.factId,revision:fact.revision,sourceRef})).digest("hex");
  const old=records.find(r=>r.id===id);if(old){if(old.state==="suppressed")throw new Error("MEMORY_POLICY_SUPPRESSED");return}
  this.save(scope,{id,actorKey,factId:fact.factId,factRevision:fact.revision,subjectKey:fact.subjectKey,sourceRef,kind,proof,state:"supported",generation:this.suppression.generation(scope)});
 }
 bootstrap(scope:string,actorKey:string,fact:FactView):void {
  this.transaction();if(this.read(scope,fact.factId).length||fact.activationReason!=="policyAccepted"||!fact.sourceRef.binding)return;
  // Only verifiable B2 automatic provenance can bootstrap. No legacy confirmation checkbox.
  const id=createHash("sha256").update(canonicalJson({actorKey,factId:fact.factId,revision:fact.revision,sourceRef:fact.sourceRef})).digest("hex");
  this.save(scope,{id,actorKey,factId:fact.factId,factRevision:fact.revision,subjectKey:fact.subjectKey,sourceRef:fact.sourceRef as BoundSourceRef,kind:"automatic",proof:null,state:"supported",generation:this.suppression.generation(scope)});
 }
 deny(scope:string,actorKey:string,fact:FactView,sourceRef:BoundSourceRef,nonce:string):void {
  this.transaction();const head=this.ledger.assertCurrent(scope,sourceRef);
  if(!head?.published||head.published.role!=="user"||head.published.trust!=="direct-user-event"||this.suppression.sourceBlocked(scope,sourceRef))throw new Error("MEMORY_EVENT_DENIED");
  if(head.published.occurredAt!==undefined&&head.published.occurredAt>transactionNow(this.db))throw new Error("MEMORY_POLICY_FUTURE");
  const id=createHash("sha256").update(canonicalJson({actorKey,factId:fact.factId,revision:fact.revision,sourceRef,nonce})).digest("hex");
  const value:Review={actorKey,factId:fact.factId,factRevision:fact.revision,sourceRef,nonce,generation:this.suppression.generation(scope),state:"recorded"};
  this.db.prepare("INSERT INTO fact_reviews(id,scope_key,fact_id,payload) VALUES(?,?,?,?)").run(id,scope,fact.factId,this.codec.seal("fact-review",scope,id,value));
 }
 obsoleteOrigins(scope:string,actorKey:string,factId:string,revision:number):BoundSourceRef[] {
  this.transaction();return this.read(scope,factId).filter(r=>r.actorKey===actorKey&&r.factRevision<revision).map(r=>r.sourceRef);
 }
 audit(scope:string,actorKey:string,factId:string,current:FactView|undefined):SupportAudit {
  this.transaction();if(current)this.bootstrap(scope,actorKey,current);
  const records=this.read(scope,factId).filter(r=>r.actorKey===actorKey);
  const reviews=this.db.prepare("SELECT id,payload FROM fact_reviews WHERE scope_key=? AND fact_id=? ORDER BY id").all(scope,factId).map(row=>this.codec.open<Review>("fact-review",scope,row.id as string,row.payload)).filter(r=>r.actorKey===actorKey);
  const valid=records.some(r=>r.factRevision===current?.revision&&this.validity(scope,r)==="valid");
  const denied=reviews.some(r=>r.state==="recorded"&&r.factRevision===current?.revision);
  return {factId,revision:current?.revision??null,status:!current?"forgotten":denied||!valid?"pending-review":"eligible",reason:!current?"forgotten":denied?"explicit-denial":valid?"valid-support":"no-valid-support",
   supports:records.map(r=>({sourceRef:r.sourceRef,kind:r.kind,factRevision:r.factRevision,validity:this.validity(scope,r),proof:r.proof})),reviews:reviews.map(r=>({sourceRef:r.sourceRef,factRevision:r.factRevision}))};
 }
 /** Ordering witnesses are live source events, not the immutable declaration's clocks. */
 orderingTime(scope:string,actorKey:string,fact:FactView):number|null {
  this.transaction();this.bootstrap(scope,actorKey,fact);let latest:number|null=null;
  for(const support of this.read(scope,fact.factId)){
   if(support.actorKey!==actorKey||support.factRevision!==fact.revision||this.validity(scope,support)!=="valid")continue;
   // A generic confirmation authorizes the declaration; its own time does not date it.
   const at=support.kind==="explicitUserConfirmed"&&["confirm","confirmFact"].includes(support.proof!.action)
    ?fact.time.referenceTime:this.ledger.assertCurrent(scope,support.sourceRef)!.published!.occurredAt??null;
   if(at!==null)latest=latest===null?at:Math.max(latest,at);
  }
  return latest;
 }
 reconcile(scope:string,actorKey:string,facts:FactView[]):void {this.transaction();for(const f of facts){this.bootstrap(scope,actorKey,f);for(const r of this.read(scope,f.factId).filter(r=>r.actorKey===actorKey)){r.checkedValidity=this.validity(scope,r);this.save(scope,r)}}}
 forget(scope:string,actorKey:string,factId:string):SourceRef[]{
  this.transaction();const refs:SourceRef[]=[];
  for(const r of this.read(scope,factId).filter(r=>r.actorKey===actorKey)){r.state="suppressed";r.checkedValidity="suppressed";this.save(scope,r);refs.push(r.sourceRef)}
  for(const row of this.db.prepare("SELECT id,payload FROM fact_reviews WHERE scope_key=? AND fact_id=?").all(scope,factId)){
   const r=this.codec.open<Review>("fact-review",scope,row.id as string,row.payload);if(r.actorKey!==actorKey)continue;
   r.state="suppressed";this.db.prepare("UPDATE fact_reviews SET payload=? WHERE scope_key=? AND id=?").run(this.codec.seal("fact-review",scope,row.id as string,r),scope,row.id as string);refs.push(r.sourceRef);
  }
  return refs;
 }
}
