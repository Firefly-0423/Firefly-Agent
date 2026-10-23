import type {SourceRef,FactDraft,FactTime} from "../../shared/memory-contracts";
import {internalId} from "./repository-types";
export function objectFields(value:unknown,required:readonly string[],optional:readonly string[]=[]):Record<string,unknown>{
 if(!value||typeof value!=="object"||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw new Error("MEMORY_INPUT_INVALID");
 const keys=Reflect.ownKeys(value),allowed=[...required,...optional];
 if(keys.some(key=>typeof key!=="string"||!allowed.includes(key))||required.some(key=>!Object.hasOwn(value,key)))throw new Error("MEMORY_INPUT_INVALID");
 for(const key of keys)if(!Object.getOwnPropertyDescriptor(value,key)?.enumerable||!Object.hasOwn(Object.getOwnPropertyDescriptor(value,key)!,"value"))throw new Error("MEMORY_INPUT_INVALID");
 return value as Record<string,unknown>;
}
export function parseInternalId(value:unknown):string{internalId(value);return value}
export function positiveRevision(value:unknown):number{
 if(typeof value!=="number"||!Number.isSafeInteger(value)||value<1)throw new Error("MEMORY_INPUT_INVALID");
 return value;
}
export function parseSourceRef(value:unknown):SourceRef{
 const input=objectFields(value,["sourceId","revision"],["span","binding"]),sourceId=parseInternalId(input.sourceId),revision=positiveRevision(input.revision);
 let binding:import("../../shared/memory-contracts").SourceBinding|undefined;
 if(input.binding!==undefined){
  const b=objectFields(input.binding,["providerId","sessionId","messageId","contentRevision","generation"]);
  binding={providerId:parseInternalId(b.providerId),sessionId:parseInternalId(b.sessionId),messageId:parseInternalId(b.messageId),contentRevision:positiveRevision(b.contentRevision),generation:parseInternalId(b.generation)};
 }
 const ref={sourceId,revision,...(binding?{binding}:{})};
 if(input.span===undefined)return ref;
 const span=objectFields(input.span,["start","end"]);
 if(typeof span.start!=="number"||typeof span.end!=="number"||!Number.isSafeInteger(span.start)||!Number.isSafeInteger(span.end)||span.start<0||span.end<=span.start)throw new Error("MEMORY_INPUT_INVALID");
 return{...ref,span:{start:span.start,end:span.end}};
}
export function textField(value:unknown):string{
 if(typeof value!=="string"||value.trim().length===0||Buffer.byteLength(value)>65536)throw new Error("MEMORY_INPUT_INVALID");
 return value;
}
export function parseFact(value:unknown):FactDraft{
 const fact=objectFields(value,["subjectKey","assertion","assertionKind","time"]);
 if(!["user-statement","inference"].includes(fact.assertionKind as string))throw new Error("MEMORY_INPUT_INVALID");
 const time=objectFields(fact.time,["validFrom","validTo","referenceTime"]);
 for(const value of Object.values(time))if(value!==null&&(typeof value!=="number"||!Number.isSafeInteger(value)))throw new Error("MEMORY_TIME_INVALID");
 const parsed=time as unknown as FactTime;
 if(parsed.validFrom!==null&&parsed.validTo!==null&&parsed.validFrom>=parsed.validTo)throw new Error("MEMORY_TIME_INVALID");
 return{subjectKey:textField(fact.subjectKey),assertion:textField(fact.assertion),assertionKind:fact.assertionKind as FactDraft["assertionKind"],time:{...parsed}};
}
