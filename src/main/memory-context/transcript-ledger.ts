import type {DatabaseSync} from "node:sqlite";
import type {BoundSourceRef} from "../../shared/memory-contracts";
import {RecordCodec} from "../memory-core/record-codec";
import {canonicalJson} from "../memory-core/repository-types";
import type {TransactionFault} from "../memory-core/command-transactions";
import {contextFail,type TranscriptDependency} from "./context-contracts";
import {parseTranscriptProvenance,type TranscriptEventSource} from "./main-transcript-provider";
import {objectFields} from "../memory-core/command-validation";
import {Suppression} from "../memory-core/suppression";
import type {ContextOwner} from "./context-repository";
export interface TranscriptHead extends ContextOwner {
 id:string;generation:number;state:"pending"|"ready"|"deleted";operationId:string|null;
 ref:TranscriptDependency|null;incarnation:string|null;contentRevision:number;throughSeq:number;sourceRefs:BoundSourceRef[];retired:string[];provenance?:Array<TranscriptEventSource&{subjectKeys:string[]|null}>;
}
/** Metadata-only canonical tool ledger, sharing the context worker transaction. */
export class TranscriptLedger {
 private readonly codec:RecordCodec;
 constructor(private readonly db:DatabaseSync,private readonly key:Uint8Array,private readonly fault?:TransactionFault){this.codec=new RecordCodec(key)}
 private save(scope:string,head:TranscriptHead):void {
  if(!this.db.isTransaction)contextFail("MEMORY_TRANSACTION_REQUIRED");
  this.db.prepare("INSERT INTO context_records VALUES(?,?,'transcript',1,?) ON CONFLICT(id,scope_key) DO UPDATE SET revision=revision+1,payload=excluded.payload WHERE kind='transcript'")
   .run(head.id,scope,this.codec.seal("context-transcript",scope,head.id,head));this.fault?.("after-record");
 }
 head(scope:string,owner:ContextOwner,id:string):TranscriptHead|null {
  const row=this.db.prepare("SELECT kind,payload FROM context_records WHERE scope_key=? AND id=?").get(scope,id);if(!row)return null;
  if(row.kind!=="transcript")contextFail("MEMORY_CONTEXT_TRANSCRIPT_DENIED");const head=this.codec.open<TranscriptHead>("context-transcript",scope,id,row.payload);
  if(head.id!==id||head.actorKey!==owner.actorKey||head.providerId!==owner.providerId||head.sessionId!==owner.sessionId)contextFail("MEMORY_CONTEXT_TRANSCRIPT_DENIED");return head;
 }
 current(scope:string,owner:ContextOwner,ref:TranscriptDependency):TranscriptHead {
  const head=this.head(scope,owner,ref.headId);if(!head)contextFail("MEMORY_CONTEXT_TRANSCRIPT_DENIED");
  if(head.state==="pending")contextFail("MEMORY_CONTEXT_TRANSCRIPT_PENDING");if(head.state==="deleted")contextFail("MEMORY_CONTEXT_TRANSCRIPT_DELETED");
  if(canonicalJson(head.ref)!==canonicalJson(ref))contextFail("MEMORY_CONTEXT_TRANSCRIPT_STALE");return head;
 }
 reserve(scope:string,owner:ContextOwner,id:string,operationId:string,generation:number,expected:TranscriptDependency|null):void {
  let head=this.head(scope,owner,id);if(expected)this.current(scope,owner,expected);
  if(!head)head={...owner,id,generation,state:"pending",operationId,ref:null,incarnation:null,contentRevision:0,throughSeq:0,sourceRefs:[],retired:[]};
  this.save(scope,{...head,...owner,state:"pending",operationId});
 }
 publish(scope:string,owner:ContextOwner,id:string,operationId:string,data:{incarnation:string;contentRevision:number;throughSeq:number;digest:string;sourceRefs:BoundSourceRef[];provenance?:unknown}):TranscriptDependency {
  const head=this.head(scope,owner,id);if(!head||head.state!=="pending"||head.operationId!==operationId)contextFail("MEMORY_CONTEXT_TRANSCRIPT_OPERATION_CONFLICT");
  if(head.retired.includes(data.incarnation))contextFail("MEMORY_CONTEXT_TRANSCRIPT_REUSED");
  if(head.incarnation===data.incarnation&&(data.contentRevision<head.contentRevision||data.throughSeq<head.throughSeq))contextFail("MEMORY_CONTEXT_TRANSCRIPT_STALE");
  const same=head.incarnation===data.incarnation&&head.contentRevision===data.contentRevision&&head.ref?.digest===data.digest;
  if(head.incarnation===data.incarnation&&head.contentRevision===data.contentRevision&&!same)contextFail("MEMORY_CONTEXT_TRANSCRIPT_VERSION_MISMATCH");
  const ref={headId:id,revision:head.ref?(same?head.ref.revision:head.ref.revision+1):1,digest:data.digest};
  const retired=head.incarnation&&head.incarnation!==data.incarnation?[...head.retired,head.incarnation]:head.retired;if(retired.length>1000)contextFail("MEMORY_CONTEXT_INPUT_INVALID");
  let provenance:TranscriptHead["provenance"];
  if(data.provenance!==undefined){
   if(!Array.isArray(data.provenance))contextFail("MEMORY_CONTEXT_INPUT_INVALID");
   provenance=data.provenance.map(raw=>{const e=objectFields(raw,["entryId","seq","occurredAt","role","subjectKeys"],["turnId","revision","suppressionGeneration","entryDigest"]),{subjectKeys,...envelope}=e,source=parseTranscriptProvenance([envelope])[0];
    if(subjectKeys!==null&&(!Array.isArray(subjectKeys)||subjectKeys.length>64||subjectKeys.some(v=>typeof v!=="string"||!/^actor-attribute-[a-f0-9]{64}$/.test(v))))contextFail("MEMORY_CONTEXT_INPUT_INVALID");
    if((source.suppressionGeneration??0)>new Suppression(this.db,this.key).generation(scope))contextFail("MEMORY_CONTEXT_INPUT_INVALID");
    const previous=head.provenance?.find(e=>source.role==="user"&&source.turnId?e.role==="user"&&e.turnId===source.turnId:e.entryId===source.entryId&&e.seq===source.seq&&e.role===source.role);
    return {...source,suppressionGeneration:previous?.suppressionGeneration??source.suppressionGeneration??0,subjectKeys:subjectKeys as string[]|null};
   });
  }
  // Preserve original event epochs; unknown history remains zero and edits cannot refresh its origin.
  const {provenance:_rawProvenance,...metadata}=data;
  this.save(scope,{...head,...owner,...metadata,...(provenance?{provenance,generation:0}:{}),ref,retired,state:"ready",operationId:null});return ref;
 }
 remove(scope:string,owner:ContextOwner,ref:TranscriptDependency):void {
  const head=this.current(scope,owner,ref);this.save(scope,{...head,state:"deleted",retired:[...new Set([...head.retired,...(head.incarnation?[head.incarnation]:[])])]});
 }
}
