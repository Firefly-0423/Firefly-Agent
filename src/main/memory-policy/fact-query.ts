import {createHash} from "node:crypto";
import type {DatabaseSync} from "node:sqlite";
import type {BoundSourceRef,FactTime} from "../../shared/memory-contracts";
import {objectFields,parseSourceRef} from "../memory-core/command-validation";
import {SourceLedger} from "../memory-core/source-ledger";
import {Suppression} from "../memory-core/suppression";
import {canonicalJson} from "../memory-core/repository-types";
import {transactionNow} from "../memory-core/transaction-clock";
import {parseFactTimeQuery,hasFactTimeQuery} from "./fact-temporal";

export interface FactQueryInput {sourceRef:BoundSourceRef;text:string}
/** Stored only after source text was checked. No second stored copy of question text. */
export interface FactQueryBinding {sourceRef:BoundSourceRef;time:FactTime|null}
type Owner={providerId:string;sessionId:string};
export class FactQuery {
 constructor(private readonly db:DatabaseSync,private readonly key:Uint8Array){}
 private source(scope:string,owner:Owner,value:unknown){
  const ref=parseSourceRef(value);
  if(!ref.binding||ref.span||ref.binding.providerId!==owner.providerId||ref.binding.sessionId!==owner.sessionId)throw Error("MEMORY_FACT_QUERY_DENIED");
  const observed=new SourceLedger(this.db,this.key).assertCurrent(scope,ref)?.published;
  if(!observed||observed.role!=="user"||observed.trust!=="direct-user-event"||new Suppression(this.db,this.key).sourceBlocked(scope,ref))throw Error("MEMORY_FACT_QUERY_DENIED");
  if(observed.occurredAt!==undefined&&observed.occurredAt>transactionNow(this.db))throw Error("MEMORY_FACT_QUERY_DENIED");
  return {ref:ref as BoundSourceRef,observed};
 }
 resolve(scope:string,owner:Owner,value:unknown):FactQueryBinding|undefined {
  if(value===undefined)return;
  const input=objectFields(value,["sourceRef","text"]);
  if(typeof input.text!=="string")throw Error("MEMORY_FACT_QUERY_DENIED");
  // Ordinary input receives the existing context source checks, not temporal authority.
  if(!hasFactTimeQuery(input.text))return;
  const {ref,observed}=this.source(scope,owner,input.sourceRef);
  const fingerprint=createHash("sha256").update(canonicalJson({text:input.text,state:observed.state,role:observed.role,trust:observed.trust})).digest("hex");
  if(fingerprint!==observed.fingerprint)throw Error("MEMORY_FACT_QUERY_DENIED");
  return {sourceRef:ref,time:input.text.length>4000?null:parseFactTimeQuery(input.text,observed)??null};
 }
 /** Recheck immutable source provenance and suppression at every snapshot/permit/send. */
 validate(scope:string,owner:Owner,binding:FactQueryBinding|undefined):FactTime|null|undefined {
  if(!binding)return;
  objectFields(binding,["sourceRef","time"]);const {observed}=this.source(scope,owner,binding.sourceRef);if(binding.time===null)return null;
  const t=objectFields(binding.time,["validFrom","validTo","referenceTime"]);
  if(!Number.isSafeInteger(t.validFrom)||!Number.isSafeInteger(t.validTo)||(t.validFrom as number)<0||(t.validFrom as number)>=(t.validTo as number)||t.referenceTime!==observed.occurredAt)throw Error("MEMORY_FACT_QUERY_DENIED");
  return binding.time;
 }
}
