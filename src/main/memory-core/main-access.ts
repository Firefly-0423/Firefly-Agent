import type {SourceRef,ActivationReason} from "../../shared/memory-contracts";
import {parseInternalId} from "./command-validation";
import {objectFields,parseSourceRef} from "./command-validation";
import {canonicalJson} from "./repository-types";
export interface VerifiedSource {
 scopeKey:string;sourceId:string;revision:number;kind:"user"|"assistant"|"system";
 intent:"statement"|"confirmation"|"correction"|"forget"|"remember";
 candidateId?:string;factId?:string;
 policyEligibility?:{directStatement:boolean;inferred:boolean;sensitive:boolean;conflict:boolean};
 binding?:import("../../shared/memory-contracts").SourceBinding;
 sourceTrust?:import("./source-contracts").SourceTrust;
}
export interface MainAuthorityOptions {resolveSource:(ref:SourceRef)=>VerifiedSource;policyVersion:string}
export interface MainMemoryAuthority {
 access(scopeKey:string):object;
 authorize(access:object,input:{candidateId:string;sourceRef:SourceRef;reason:ActivationReason}):object;
}
interface AccessContext {scopeKey:string;verifySource:(ref:SourceRef)=>VerifiedSource}
interface ActivationContext {access:object;candidateId:string;reason:ActivationReason;sourceRef:SourceRef;policyVersion:string|null}
const accesses=new WeakMap<object,AccessContext>(),activations=new WeakMap<object,ActivationContext>();
export function requireMainAccess(access:unknown):AccessContext{
 const context=access&&typeof access==="object"?accesses.get(access):undefined;
 if(!context)throw new Error("MEMORY_ACCESS_DENIED");
 return context;
}
function validateActivation(source:VerifiedSource,candidateId:string,reason:unknown):asserts reason is ActivationReason{
 if(source.kind!=="user")throw new Error("MEMORY_ACTIVATION_DENIED");
 const eligibility=source.policyEligibility;
 if(reason==="policyAccepted"){
  if(source.intent!=="statement"||!eligibility||eligibility.directStatement!==true||eligibility.inferred!==false||eligibility.sensitive!==false||eligibility.conflict!==false)throw new Error("MEMORY_ACTIVATION_DENIED");
 }else if(reason==="explicitUserConfirmed"){
  if(!["confirmation","remember"].includes(source.intent)||source.candidateId!==candidateId)throw new Error("MEMORY_ACTIVATION_DENIED");
 }else throw new Error("MEMORY_ACTIVATION_DENIED");
}
/** Main-only adapter factory. It is never exported from shared DTOs or exposed over IPC. */
export function createMainMemoryAuthority(options:MainAuthorityOptions):MainMemoryAuthority{
 const policyVersion=parseInternalId(options.policyVersion);
 if(typeof options.resolveSource!=="function")throw new Error("MEMORY_SOURCE_INVALID");
 return {
  access(scope:string){
   const scopeKey=parseInternalId(scope),token=Object.freeze({});
   const verifySource=(value:SourceRef):VerifiedSource=>{
    const ref=parseSourceRef(value);let source:VerifiedSource;
    try{source=options.resolveSource(ref)}catch{throw new Error("MEMORY_SOURCE_INVALID")}
    if(!source||source.scopeKey!==scopeKey||source.sourceId!==ref.sourceId||source.revision!==ref.revision||!["user","assistant","system"].includes(source.kind)||!["statement","confirmation","correction","forget","remember"].includes(source.intent))throw new Error("MEMORY_SOURCE_INVALID");
    if((ref.binding||source.binding)&&canonicalJson(ref.binding??null)!==canonicalJson(source.binding??null))throw new Error("MEMORY_SOURCE_INVALID");
    return {...source,policyEligibility:source.policyEligibility?{...source.policyEligibility}:undefined};
   };
   accesses.set(token,{scopeKey,verifySource});return token;
  },
  authorize(access,input){
   const context=requireMainAccess(access),fields=objectFields(input,["candidateId","sourceRef","reason"]);
   const candidateId=parseInternalId(fields.candidateId),sourceRef=parseSourceRef(fields.sourceRef),source=context.verifySource(sourceRef);
   validateActivation(source,candidateId,fields.reason);
   const token=Object.freeze({});
   activations.set(token,{access,candidateId,reason:fields.reason,sourceRef,policyVersion:fields.reason==="policyAccepted"?policyVersion:null});
   return token;
  }
 };
}
export function requireActivation(access:unknown,authorization:unknown,candidateId:string):Omit<ActivationContext,"access"|"candidateId">{
 const context=requireMainAccess(access),claim=authorization&&typeof authorization==="object"?activations.get(authorization):undefined;
 if(!claim||claim.access!==access||claim.candidateId!==candidateId)throw new Error("MEMORY_ACTIVATION_DENIED");
 validateActivation(context.verifySource(claim.sourceRef),candidateId,claim.reason);
 return{reason:claim.reason,sourceRef:parseSourceRef(claim.sourceRef),policyVersion:claim.policyVersion};
}
