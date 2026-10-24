import {createHash,randomUUID} from "node:crypto";
import type {BoundSourceRef,SourceRef} from "../../shared/memory-contracts";
import {parseSourceRef} from "../memory-core/command-validation";
import {createMainMemoryAuthority,requireMainAccess,type VerifiedSource} from "../memory-core/main-access";
import {canonicalJson} from "../memory-core/repository-types";
import type {SourceIdentity,SourceHead,SourceLedgerTransport} from "../memory-core/source-contracts";
import {parseSourceIdentity,parseSourceObservation} from "../memory-core/source-ledger";
import {requireMainSourceProvider,type SourceSnapshot} from "./main-source-provider";

function identityOf(ref:BoundSourceRef):SourceIdentity {
 return parseSourceIdentity({providerId:ref.binding.providerId,sessionId:ref.binding.sessionId,messageId:ref.binding.messageId});
}
function refKey(value:SourceRef):string {const {span,...ref}=parseSourceRef(value);return canonicalJson(ref)}
function snapshot(value:SourceSnapshot,identity:SourceIdentity):SourceSnapshot {
 // Copy immediately: a provider must not mutate the first observation in place.
 const copy=structuredClone(value);
 if(typeof copy?.text!=="string")throw new Error("MEMORY_SOURCE_INVALID");
 const {text,...metadata}=copy;
 const observation=parseSourceObservation({...metadata,fingerprint:createHash("sha256").update(canonicalJson({text,state:copy.state,role:copy.role,trust:copy.trust})).digest("hex")});
 if(canonicalJson(parseSourceIdentity({providerId:copy.providerId,sessionId:copy.sessionId,messageId:copy.messageId}))!==canonicalJson(identity))throw new Error("MEMORY_SOURCE_INVALID");
 const {fingerprint,...validated}=observation;return {...validated,text};
}
function evidence(text:string,ref:SourceRef,quote?:string):string {
 const span=ref.span;
 if(span){
  const split=(offset:number)=>offset>0&&offset<text.length&&/[\uD800-\uDBFF]/.test(text[offset-1])&&/[\uDC00-\uDFFF]/.test(text[offset]);
  if(span.end>text.length||split(span.start)||split(span.end))throw new Error("MEMORY_SOURCE_SPAN_INVALID");
 }
 const result=span?text.slice(span.start,span.end):text;
 if(quote!==undefined&&result!==quote)throw new Error("MEMORY_SOURCE_QUOTE_MISMATCH");return result;
}
/** Isolated Main registry. No production chats adapter, policy or IPC is installed. */
export function createMainSourceRegistry(transport:SourceLedgerTransport,options:{coordinate?:<T>(operation:()=>Promise<T>|T)=>Promise<T>}={}){
 const mirror=new Map<string,{scope:string;ref:BoundSourceRef;snapshot:SourceSnapshot}>();
 function resolveVerifiedSource(value:SourceRef):VerifiedSource {
  const ref=parseSourceRef(value),entry=mirror.get(ref.sourceId);
  if(!entry||refKey(entry.ref)!==refKey(ref))throw new Error("MEMORY_SOURCE_STALE");
  evidence(entry.snapshot.text,ref);
  return {scopeKey:entry.scope,sourceId:ref.sourceId,revision:ref.revision,kind:entry.snapshot.role,intent:"statement",binding:{...entry.ref.binding},sourceTrust:entry.snapshot.trust};
 }
 const authority=createMainMemoryAuthority({policyVersion:"source-policy-unconfigured",resolveSource:resolveVerifiedSource});
 async function reserve(access:unknown,adapter:unknown,identity:SourceIdentity,expectedRef:SourceRef|null):Promise<SourceHead>{
  const {scopeKey}=requireMainAccess(access);requireMainSourceProvider(adapter,scopeKey,identity);
  const head=await transport.sourceCommand({kind:"reserve",scopeKey,commandId:randomUUID(),body:{identity,expectedRef}}) as SourceHead;
  mirror.delete(head.sourceId);return head;
 }
 async function publish(access:unknown,adapter:unknown,head:SourceHead):Promise<BoundSourceRef>{
  const {scopeKey}=requireMainAccess(access),provider=requireMainSourceProvider(adapter,scopeKey,head.identity);
  mirror.delete(head.sourceId);
  return provider.withLease(head.identity,async read=>{
   const first=snapshot(await read(),head.identity),second=snapshot(await read(),head.identity);
   if(canonicalJson(first)!==canonicalJson(second))throw new Error("MEMORY_SOURCE_CAPTURE_CHANGED");
   const {text,...metadata}=second;
   const observation={...metadata,fingerprint:createHash("sha256").update(canonicalJson({text,state:second.state,role:second.role,trust:second.trust})).digest("hex")};
   const ref=await transport.sourceCommand({kind:"finish",scopeKey,commandId:randomUUID(),body:{sourceId:head.sourceId,operationId:head.operationId,observation}}) as BoundSourceRef;
   if(second.state==="deleted")throw new Error("MEMORY_SOURCE_DELETED");
   mirror.set(ref.sourceId,{scope:scopeKey,ref:structuredClone(ref),snapshot:second});return ref;
  },head.published?Object.freeze(structuredClone(head.published)):undefined);
 }
 async function capture(access:unknown,adapter:unknown,value:unknown):Promise<BoundSourceRef>{
  const identity=parseSourceIdentity(value);return publish(access,adapter,await reserve(access,adapter,identity,null));
 }
 async function prepareChange(access:unknown,adapter:unknown,value:unknown):Promise<SourceHead>{
  const ref=parseSourceRef(value);if(!ref.binding)throw new Error("MEMORY_SOURCE_BINDING_REQUIRED");
  return reserve(access,adapter,identityOf(ref as BoundSourceRef),ref);
 }
 async function reconcile(access:unknown,adapter:unknown,value:unknown):Promise<BoundSourceRef>{
  const identity=parseSourceIdentity(value),{scopeKey}=requireMainAccess(access);requireMainSourceProvider(adapter,scopeKey,identity);
  const head=await transport.sourceCommand({kind:"pending",scopeKey,body:{identity}}) as SourceHead;
  return publish(access,adapter,head);
 }
 async function readEvidence(access:unknown,adapter:unknown,value:unknown,quote?:string):Promise<string>{
  const ref=parseSourceRef(value);if(!ref.binding)throw new Error("MEMORY_SOURCE_BINDING_REQUIRED");
  const head=await reserve(access,adapter,identityOf(ref as BoundSourceRef),ref);
  const fresh=await publish(access,adapter,head);
  if(refKey(ref)!==refKey(fresh))throw new Error("MEMORY_SOURCE_STALE");
  return evidence(mirror.get(fresh.sourceId)!.snapshot.text,ref,quote);
 }
 const coordinate=options.coordinate??(<T>(operation:()=>Promise<T>|T)=>Promise.resolve().then(operation));
 return {authority,coordinator:options.coordinate,
  capture:(...args:Parameters<typeof capture>)=>coordinate(()=>capture(...args)),
  prepareIdentityChange:(access:object,adapter:object,identity:SourceIdentity)=>coordinate(()=>reserve(access,adapter,parseSourceIdentity(identity),null)),
   prepareChange:(...args:Parameters<typeof prepareChange>)=>coordinate(()=>prepareChange(...args)),
  reconcile:(...args:Parameters<typeof reconcile>)=>coordinate(()=>reconcile(...args)),
  readEvidence:(...args:Parameters<typeof readEvidence>)=>coordinate(()=>readEvidence(...args)),resolveVerifiedSource};
}
