import {createHmac,hkdfSync,randomUUID} from "node:crypto";
import type {DatabaseSync} from "node:sqlite";
import type {BoundSourceRef,SourceRef} from "../../shared/memory-contracts";
import {objectFields,parseInternalId,parseSourceRef,positiveRevision} from "./command-validation";
import {canonicalJson} from "./repository-types";
import {executeTransaction,type TransactionFault} from "./command-transactions";
import {RecordCodec} from "./record-codec";
import {Suppression} from "./suppression";
import type {SourceIdentity,SourceObservation,SourceHead} from "./source-contracts";

export function parseSourceIdentity(value:unknown):SourceIdentity {
 const v=objectFields(value,["providerId","sessionId","messageId"]);
 return {providerId:parseInternalId(v.providerId),sessionId:parseInternalId(v.sessionId),messageId:parseInternalId(v.messageId)};
}
export function parseSourceObservation(value:unknown):SourceObservation {
 const v=objectFields(value,["providerId","sessionId","messageId","contentRevision","generation","state","role","trust","fingerprint"],["occurredAt","timeZone"]);
 const identity=parseSourceIdentity({providerId:v.providerId,sessionId:v.sessionId,messageId:v.messageId});
 if(v.occurredAt!==undefined&&(!Number.isSafeInteger(v.occurredAt)||(v.occurredAt as number)<0))throw new Error("MEMORY_TIME_INVALID");
 if(v.timeZone!==undefined)parseSourceTimeZone(v.timeZone);
 if(!["live","deleted"].includes(v.state as string)||!["user","assistant","system"].includes(v.role as string)
  ||!["direct-user-event","history","imported","model","system"].includes(v.trust as string)
  ||typeof v.fingerprint!=="string"||!/^[a-f0-9]{64}$/.test(v.fingerprint))throw new Error("MEMORY_SOURCE_INVALID");
 return {...identity,contentRevision:positiveRevision(v.contentRevision),generation:parseInternalId(v.generation),
  state:v.state as SourceObservation["state"],role:v.role as SourceObservation["role"],trust:v.trust as SourceObservation["trust"],fingerprint:v.fingerprint,...(v.occurredAt!==undefined?{occurredAt:v.occurredAt as number}:{}),...(v.timeZone!==undefined?{timeZone:v.timeZone as string}:{})};
}
export function parseSourceTimeZone(value:unknown):string {
 if(typeof value!=="string"||!value||value.length>100)throw Error("MEMORY_TIME_INVALID");
 try{new Intl.DateTimeFormat("en-US",{timeZone:value})}catch{throw Error("MEMORY_TIME_INVALID")}
 return value;
}
function referenceIdentity(ref:SourceRef):string {
 const {span,...identity}=parseSourceRef(ref);return canonicalJson(identity);
}
/** All writes share the repository transaction and encrypted command receipt. */
export class SourceLedger {
 private readonly codec:RecordCodec;
 constructor(private readonly db:DatabaseSync,private readonly key:Uint8Array,private readonly fault?:TransactionFault){this.codec=new RecordCodec(key)}
 private locatorIndex(scope:string,identity:SourceIdentity):Buffer {
  const derived=Buffer.from(hkdfSync("sha256",this.key,Buffer.alloc(0),"FireflyMemorySourceLocator-v1",32));
  try{return createHmac("sha256",derived).update(canonicalJson({scope,identity})).digest()}finally{derived.fill(0)}
 }
 private generationIndex(scope:string,sourceId:string,generation:string):Buffer {
  const derived=Buffer.from(hkdfSync("sha256",this.key,Buffer.alloc(0),"FireflyMemorySourceGeneration-v1",32));
  try{return createHmac("sha256",derived).update(canonicalJson({scope,sourceId,generation})).digest()}finally{derived.fill(0)}
 }
 private decode(scope:string,row:Record<string,unknown>):SourceHead {
  const head=this.codec.open<SourceHead>("source-head",scope,row.source_id as string,row.payload);
  if(head.sourceId!==row.source_id||head.state!==row.state||!["ready","pending","deleted"].includes(head.state))throw new Error("MEMORY_DATA_INVALID");
  const index=this.locatorIndex(scope,parseSourceIdentity(head.identity));
  if(!(row.locator_index instanceof Uint8Array)||!Buffer.from(row.locator_index).equals(index))throw new Error("MEMORY_DATA_INVALID");
  if(head.ref!==null){const ref=parseSourceRef(head.ref);if(!ref.binding||ref.sourceId!==head.sourceId)throw new Error("MEMORY_DATA_INVALID")}
  if(head.published!==null)parseSourceObservation(head.published);
  for(const value of [head.captureSuppressionGeneration,head.observedSuppressionGeneration,head.firstObservedSuppressionGeneration])if(value!==undefined&&(!Number.isSafeInteger(value)||value<0))throw new Error("MEMORY_DATA_INVALID");
  if(head.state==="pending"){parseInternalId(head.operationId)}else if(head.operationId!==null)throw new Error("MEMORY_DATA_INVALID");
  return head;
 }
 private byIdentity(scope:string,identity:SourceIdentity):SourceHead|null {
  const row=this.db.prepare("SELECT * FROM source_heads WHERE scope_key=? AND locator_index=?").get(scope,this.locatorIndex(scope,identity));
  return row?this.decode(scope,row):null;
 }
 private bySource(scope:string,sourceId:string):SourceHead|null {
  const row=this.db.prepare("SELECT * FROM source_heads WHERE scope_key=? AND source_id=?").get(scope,sourceId);
  return row?this.decode(scope,row):null;
 }
 private save(scope:string,head:SourceHead):void {
  this.db.prepare("INSERT INTO source_heads(scope_key,locator_index,source_id,state,payload) VALUES(?,?,?,?,?) ON CONFLICT(scope_key,locator_index) DO UPDATE SET state=excluded.state,payload=excluded.payload")
   .run(scope,this.locatorIndex(scope,head.identity),head.sourceId,head.state,this.codec.seal("source-head",scope,head.sourceId,head));
  this.fault?.("after-record");
 }
 isManaged(scope:string,sourceId:string):boolean{return this.bySource(scope,sourceId)!==null}
 /** Legacy sources are allowed only when no managed ledger exists. */
 assertCurrent(scope:string,value:SourceRef):SourceHead|null {
  parseInternalId(scope);const ref=parseSourceRef(value),head=this.bySource(scope,ref.sourceId);
  if(!head){if(ref.binding)throw new Error("MEMORY_SOURCE_INVALID");return null}
  if(head.state==="pending")throw new Error("MEMORY_SOURCE_PENDING");
  if(head.state==="deleted")throw new Error("MEMORY_SOURCE_DELETED");
  if(!ref.binding)throw new Error("MEMORY_SOURCE_BINDING_REQUIRED");
  if(!head.ref||referenceIdentity(ref)!==referenceIdentity(head.ref))throw new Error("MEMORY_SOURCE_STALE");
  return head;
 }
 execute(value:unknown):unknown {
  const cmd=objectFields(value,["kind","scopeKey","body"],["commandId"]),scope=parseInternalId(cmd.scopeKey);
  if(cmd.kind==="pending"){
   const body=objectFields(cmd.body,["identity"]),head=this.byIdentity(scope,parseSourceIdentity(body.identity));
   if(!head||head.state!=="pending")throw new Error("MEMORY_SOURCE_NOT_PENDING");return head;
  }
  if(cmd.kind==="validate"){
   const body=objectFields(cmd.body,["sourceRef"]),head=this.assertCurrent(scope,parseSourceRef(body.sourceRef));
   if(!head||!head.published)throw new Error("MEMORY_SOURCE_INVALID");return head.published;
  }
  if(cmd.kind!=="reserve"&&cmd.kind!=="finish")throw new Error("MEMORY_INPUT_INVALID");
  const commandId=parseInternalId(cmd.commandId);
  return executeTransaction({db:this.db,key:this.key,scope,commandId,request:value,fault:this.fault,apply:()=>
   cmd.kind==="reserve"?this.reserve(scope,cmd.body):this.finish(scope,cmd.body)});
 }
 private reserve(scope:string,value:unknown):SourceHead {
  const v=objectFields(value,["identity","expectedRef"]),identity=parseSourceIdentity(v.identity);
  let head=this.byIdentity(scope,identity);
  if(head?.state==="pending")throw new Error("MEMORY_SOURCE_PENDING");
  if(v.expectedRef!==null){
   const ref=parseSourceRef(v.expectedRef);this.assertCurrent(scope,ref);
   if(!head||!head.ref||referenceIdentity(ref)!==referenceIdentity(head.ref))throw new Error("MEMORY_SOURCE_STALE");
  }
  if(!head){
   const sourceId=randomUUID();head={sourceId,identity,state:"pending",ref:null,published:null,operationId:null};
   const sourceRef={sourceId,revision:1};
   this.db.prepare("INSERT INTO sources(id,scope_key,revision,source_id,parent_id,state,payload) VALUES(?,?,1,NULL,NULL,'pending',?)")
    .run(sourceId,scope,this.codec.seal("sources",scope,sourceId,{sourceRef,kind:"system",intent:"statement",candidateId:null,factId:null}));
  }else this.db.prepare("UPDATE sources SET state='pending' WHERE id=? AND scope_key=?").run(head.sourceId,scope);
  head={...head,state:"pending",operationId:randomUUID(),captureSuppressionGeneration:new Suppression(this.db,this.key).generation(scope)};this.save(scope,head);return head;
 }
 private finish(scope:string,value:unknown):BoundSourceRef {
  const v=objectFields(value,["sourceId","operationId","observation"]),sourceId=parseInternalId(v.sourceId),operationId=parseInternalId(v.operationId);
  const head=this.bySource(scope,sourceId),observation=parseSourceObservation(v.observation);
  if(!head||head.state!=="pending"||head.operationId!==operationId)throw new Error("MEMORY_SOURCE_OPERATION_CONFLICT");
  if(canonicalJson(head.identity)!==canonicalJson(parseSourceIdentity({providerId:observation.providerId,sessionId:observation.sessionId,messageId:observation.messageId})))throw new Error("MEMORY_SOURCE_INVALID");
  const previous=head.published;
  const generationIndex=this.generationIndex(scope,sourceId,observation.generation);
  if(previous?.generation!==observation.generation&&this.db.prepare("SELECT 1 FROM source_generations WHERE scope_key=? AND source_id=? AND generation_index=?").get(scope,sourceId,generationIndex))throw new Error("MEMORY_SOURCE_GENERATION_REUSED");
  if(previous&&previous.generation===observation.generation){
   if(previous.state==="deleted"&&observation.state==="live")throw new Error("MEMORY_SOURCE_GENERATION_REUSED");
   if(observation.contentRevision<previous.contentRevision)throw new Error("MEMORY_SOURCE_STALE");
   if(observation.contentRevision===previous.contentRevision&&canonicalJson(previous)!==canonicalJson(observation))throw new Error("MEMORY_SOURCE_VERSION_MISMATCH");
  }
  const same=previous&&canonicalJson(previous)===canonicalJson(observation);
  const revision=head.ref?(same?head.ref.revision:head.ref.revision+1):1;
  if(!Number.isSafeInteger(revision))throw new Error("MEMORY_SOURCE_VERSION_MISMATCH");
  const ref:BoundSourceRef={sourceId,revision,binding:{...head.identity,contentRevision:observation.contentRevision,generation:observation.generation}};
  const state=observation.state==="deleted"?"deleted":"ready";
  const observedSuppressionGeneration=same?head.observedSuppressionGeneration:head.captureSuppressionGeneration;
   const published:SourceHead={...head,ref,published:observation,state,operationId:null,
    firstObservedSuppressionGeneration:head.firstObservedSuppressionGeneration??(previous?0:head.captureSuppressionGeneration??0),
    ...(observedSuppressionGeneration===undefined?{}:{observedSuppressionGeneration})};
  this.db.prepare("UPDATE sources SET revision=?,state=?,payload=? WHERE id=? AND scope_key=?")
   .run(revision,state==="ready"?"recorded":"invalidated",this.codec.seal("sources",scope,sourceId,{sourceRef:ref,kind:observation.role,intent:"statement",candidateId:null,factId:null}),sourceId,scope);
  this.save(scope,published);
  this.db.prepare("INSERT OR IGNORE INTO source_generations(scope_key,source_id,generation_index) VALUES(?,?,?)").run(scope,sourceId,generationIndex);
  return ref;
 }
}
