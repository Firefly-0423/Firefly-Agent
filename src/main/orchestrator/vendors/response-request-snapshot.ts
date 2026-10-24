import type {ChatRequest} from "./types";
import {canonicalJson} from "../../memory-core/repository-types";

/** Pure descriptor snapshot; imports no SDK, settings, storage or runtime service. */
const unsupported=():never=>{throw Error("MEMORY_CONTEXT_COUNTER_UNSUPPORTED")};
export type UndefinedOmission=boolean|((path:readonly string[],key:string)=>boolean);
const optionalRequestFields:readonly string[]=["tools","toolChoiceIntent","temperature","topP","stream"];
const optionalMessageFields:readonly string[]=["toolCalls","toolCallId","name"];
function omitRequestOptional(path:readonly string[],key:string):boolean {
 return path.length===0&&optionalRequestFields.includes(key)
  ||path.length===2&&path[0]==="messages"&&/^(0|[1-9][0-9]*)$/.test(path[1])&&optionalMessageFields.includes(key);
}
function copyJson(value:unknown,depth=0,omitUndefined:UndefinedOmission=false,path:readonly string[]=[],fail:()=>never=unsupported):unknown {
 if(depth>32)fail();
 if(value===null||typeof value==="string"||typeof value==="boolean")return value;
 if(typeof value==="number"&&Number.isFinite(value))return value;
 if(typeof value!=="object"||!value)fail();
 const array=Array.isArray(value),prototype=Object.getPrototypeOf(value);
 if(prototype!==(array?Array.prototype:Object.prototype)||Object.getOwnPropertyDescriptor(prototype,"toJSON"))fail();
 const descriptors=Object.getOwnPropertyDescriptors(value),ownKeys=Reflect.ownKeys(descriptors);
 if(ownKeys.length>10001)fail();
 const output=array?[]:{};
 for(const key of ownKeys){
  if(typeof key!=="string")return fail();const field=descriptors[key];
  if(!("value" in field)||(!field.enumerable&&!(array&&key==="length")))fail();
  if(array&&key==="length")continue;
  if(array&&(!/^(0|[1-9][0-9]*)$/.test(key)||Number(key)>=(value as unknown[]).length))fail();
  if(field.value===undefined&&(omitUndefined===true||typeof omitUndefined==="function"&&omitUndefined(path,key)))continue;
  Object.defineProperty(output,key,{value:copyJson(field.value,depth+1,omitUndefined,[...path,key],fail),enumerable:true,writable:true,configurable:true});
 }
 if(array&&Object.keys(output).length!==(value as unknown[]).length)fail();
 return output;
}
export function copyResponseJson<T>(value:T,omitUndefined:UndefinedOmission=false,fail:()=>never=unsupported):T {
 try{const json=canonicalJson(copyJson(value,0,omitUndefined,[],fail));if(Buffer.byteLength(json)>8*1024*1024)fail();return JSON.parse(json) as T}catch{return fail()}
}
/** Descriptor-checked copy; no accessors or caller-owned serialization hooks run. */
export function copyMainResponsesRequest(request:ChatRequest,fail:()=>never=unsupported):ChatRequest{return copyResponseJson(request,omitRequestOptional,fail)}
