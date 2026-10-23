import {objectFields,parseInternalId,parseSourceRef,positiveRevision} from "../memory-core/command-validation";
import type {BoundSourceRef} from "../../shared/memory-contracts";
import {contextFail,type ContextUnit} from "./context-contracts";
import {CONTEXT_MESSAGE_FIELDS,validateUnit} from "./token-budget";
export interface TranscriptEventSource {entryDigest?:string;entryId:string;turnId?:string;revision?:number;seq:number;occurredAt:number;suppressionGeneration?:number;role:ContextUnit["messages"][number]["role"]}
export interface TranscriptView {id:string;incarnation:string;revision:number;throughSeq:number;digest:string}
export interface CanonicalTranscript {incarnation:string;revision:number;throughSeq:number;sourceRefs:BoundSourceRef[];unit:ContextUnit;provenance?:TranscriptEventSource[];view?:TranscriptView}
// Real transcript event IDs are metadata, not memory-record IDs or filesystem keys.
function eventId(value:unknown):string {
 if(typeof value!=="string"||!value||value.length>1024||/[\u0000-\u001f\u007f]/.test(value))contextFail("MEMORY_CONTEXT_INPUT_INVALID");
 return value;
}
export function parseTranscriptProvenance(value:unknown):TranscriptEventSource[] {
 if(!Array.isArray(value)||!value.length||value.length>10000)contextFail("MEMORY_CONTEXT_INPUT_INVALID");
 return value.map(raw=>{const e=objectFields(raw,["entryId","seq","occurredAt","role"],["turnId","revision","suppressionGeneration","entryDigest"]);
  if(!Number.isSafeInteger(e.seq)||(e.seq as number)<1||!Number.isSafeInteger(e.occurredAt)||(e.occurredAt as number)<0||!["user","assistant","system","tool"].includes(e.role as string))contextFail("MEMORY_CONTEXT_INPUT_INVALID");
  if(e.suppressionGeneration!==undefined&&(!Number.isSafeInteger(e.suppressionGeneration)||(e.suppressionGeneration as number)<0))contextFail("MEMORY_CONTEXT_INPUT_INVALID");
  if(e.entryDigest!==undefined&&(typeof e.entryDigest!=="string"||! /^[a-f0-9]{64}$/.test(e.entryDigest)))contextFail("MEMORY_CONTEXT_INPUT_INVALID");
  return {...(e.entryDigest?{entryDigest:e.entryDigest as string}:{}),...(e.suppressionGeneration===undefined?{}:{suppressionGeneration:e.suppressionGeneration as number}),entryId:eventId(e.entryId),seq:e.seq as number,occurredAt:e.occurredAt as number,role:e.role as TranscriptEventSource["role"],...(e.turnId===undefined?{}:{turnId:eventId(e.turnId)}),...(e.revision===undefined?{}:{revision:positiveRevision(e.revision)})};
 });
}
interface TranscriptProvider {
 scopeKey:string;providerId:string;sessionId:string;
 /** Main-only lifecycle notification, invoked while the provider lease is held. */
 onCaptured?:(capability:object,locator:string)=>void;
 withLease<T>(id:string,run:(read:()=>Promise<CanonicalTranscript>)=>Promise<T>):Promise<T>;
}
const providers=new WeakMap<object,TranscriptProvider>();
/** Provisioned by trusted Main transcript code only, never by model output or IPC. */
export function createMainTranscriptProvider(options:TranscriptProvider):object {
 parseInternalId(options.scopeKey);parseInternalId(options.providerId);parseInternalId(options.sessionId);
 if(typeof options.withLease!=="function")contextFail("MEMORY_CONTEXT_TRANSCRIPT_DENIED");
 const token=Object.freeze({});providers.set(token,Object.freeze({...options}));return token;
}
export function requireMainTranscriptProvider(value:object,scope:string,session:string):TranscriptProvider {
 const provider=providers.get(value);if(!provider||provider.scopeKey!==scope||provider.sessionId!==session)contextFail("MEMORY_CONTEXT_TRANSCRIPT_DENIED");return provider;
}
export function parseCanonicalTranscript(value:unknown):CanonicalTranscript {
 const v=objectFields(structuredClone(value),["incarnation","revision","throughSeq","sourceRefs","unit"],["provenance","view"]);
 if(!Number.isSafeInteger(v.throughSeq)||(v.throughSeq as number)<0||!Array.isArray(v.sourceRefs)||v.sourceRefs.length>1000)contextFail("MEMORY_CONTEXT_INPUT_INVALID");
 const sourceRefs=v.sourceRefs.map(raw=>{const ref=parseSourceRef(raw);if(!ref.binding||ref.span)contextFail("MEMORY_CONTEXT_INPUT_INVALID");return ref as BoundSourceRef});
 const unit=objectFields(v.unit,["id","kind","messages"]) as unknown as ContextUnit;validateUnit(unit);
 if(unit.messages.some(message=>Object.keys(message).some(key=>!CONTEXT_MESSAGE_FIELDS.includes(key))))contextFail("MEMORY_CONTEXT_INPUT_INVALID");
 const provenance=v.provenance===undefined?undefined:parseTranscriptProvenance(v.provenance);
 if(provenance&&(provenance.length!==unit.messages.length||provenance.some((e,i)=>e.role!==unit.messages[i].role||e.seq>(v.throughSeq as number))))contextFail("MEMORY_CONTEXT_INPUT_INVALID");
 let view:TranscriptView|undefined;
 if(v.view!==undefined){const g=objectFields(v.view,["id","incarnation","revision","throughSeq","digest"]);if(!Number.isSafeInteger(g.throughSeq)||(g.throughSeq as number)<0||typeof g.digest!=="string"||!/^[a-f0-9]{64}$/.test(g.digest))contextFail("MEMORY_CONTEXT_INPUT_INVALID");view={id:parseInternalId(g.id),incarnation:parseInternalId(g.incarnation),revision:positiveRevision(g.revision),throughSeq:g.throughSeq as number,digest:g.digest}}
 return {incarnation:parseInternalId(v.incarnation),revision:positiveRevision(v.revision),throughSeq:v.throughSeq as number,sourceRefs,unit,...(provenance?{provenance}:{}),...(view?{view}:{})};
}
