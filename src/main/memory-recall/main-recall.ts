import {randomUUID} from "node:crypto";
import type {MainActorAuthority,MainActorContext} from "../memory-core/main-actor-authority";
import {recallFail,type RecallTransport,type RecallFactRef,type RecallPolicy,type RecallAction,type RecallPreview,type RecallRank,type RecallMetadata} from "./recall-contracts";
import {validateRecallPolicy} from "./recall-decay";
import type {FactQueryInput} from "../memory-policy/fact-query";

/** Trusted Main-only seam. No IPC registration, model event or production scheduler. */
export function createMainRecall(options:{actorAuthority:MainActorAuthority;transport:RecallTransport;maxBatches?:number}){
 const previews=new WeakMap<object,{actor:object;preview:RecallPreview;used:boolean;commandId:string}>();
 const maxBatches=options.maxBatches??10;if(!Number.isSafeInteger(maxBatches)||maxBatches<1||maxBatches>100)recallFail("MEMORY_RECALL_INPUT_INVALID");
 function actor(token:object):MainActorContext{const a=options.actorAuthority.requireActor(token);if(a.sessionMode==="temporary")recallFail("MEMORY_RECALL_TEMPORARY_UNSUPPORTED");return a}
 function command<T>(a:MainActorContext,kind:string,body:object,commandId?:string):Promise<T>{return options.transport.recallCommand({kind,scopeKey:a.scopeKey,...(commandId?{commandId}:{}),body:{actorKey:a.actorKey,providerId:a.providerId,sessionId:a.sessionId,bootId:options.actorAuthority.bootId,...body}}) as Promise<T>}
 async function preview(token:object,factRefs:RecallFactRef[],action:Exclude<RecallAction,"maintenance">):Promise<object>{const a=actor(token);const value=await options.actorAuthority.coordinate(()=>command<RecallPreview>(a,"preview",{factRefs:structuredClone(factRefs),action}));const cap=Object.freeze({});previews.set(cap,{actor:token,preview:value,used:false,commandId:randomUUID()});return cap}
 async function apply(token:object,cap:object):Promise<{changed:number}>{const a=actor(token),state=previews.get(cap);if(!state||state.actor!==token)recallFail("MEMORY_RECALL_PREVIEW_DENIED");if(state.used)recallFail("MEMORY_RECALL_PREVIEW_USED");state.used=true;return options.actorAuthority.coordinate(()=>command(a,"commit",{preview:state.preview},state.commandId))}
 async function maintain(token:object,settings:{requiredFactRefs?:RecallFactRef[];signal?:AbortSignal;onBatch?:(count:number)=>void|Promise<void>}={}){
  const a=actor(token),requiredFactRefs=structuredClone(settings.requiredFactRefs??[]);let archived=0,batches=0,candidates=0,mode:RecallPolicy["maintenanceMode"]="disabled";
  for(let index=0;index<maxBatches;index++){
   if(settings.signal?.aborted)return {mode,candidates,archived,batches,cancelled:true};
   const batch=await options.actorAuthority.coordinate(async()=>{if(index===0)await command(a,"recover",{},randomUUID());const p=await command<RecallPreview>(a,"maintenancePreview",{requiredFactRefs});if(settings.signal?.aborted)return {p,changed:0,cancelled:true};if(p.mode!=="enabled"||!p.targets.length)return {p,changed:0,cancelled:false};const result=await command<{changed:number}>(a,"commit",{preview:p},randomUUID());return {p,changed:result.changed,cancelled:false}});
   mode=batch.p.mode;candidates=Math.max(candidates,batch.p.candidates);if(batch.cancelled)return {mode,candidates,archived,batches,cancelled:true};
   if(!batch.changed)return {mode,candidates,archived,batches,cancelled:false};archived+=batch.changed;batches++;await settings.onBatch?.(batches);
  }
  return {mode,candidates,archived,batches,cancelled:!!settings.signal?.aborted};
 }
 return {preview,apply,maintain,
  async recover(token:object):Promise<{unknown:number}>{const a=actor(token);return options.actorAuthority.coordinate(()=>command(a,"recover",{},randomUUID()))},
  async rank(token:object,factQuery?:FactQueryInput):Promise<RecallRank>{const a=actor(token);return options.actorAuthority.coordinate(()=>command(a,"rank",factQuery?{factQuery:structuredClone(factQuery)}:{}))},
  async metadata(token:object,factRefs:RecallFactRef[]):Promise<RecallMetadata>{const a=actor(token);return options.actorAuthority.coordinate(()=>command(a,"metadata",{factRefs:structuredClone(factRefs)}))},
  async configure(token:object,policy:RecallPolicy):Promise<{policyVersion:string}>{const a=actor(token),validated=validateRecallPolicy(policy);return options.actorAuthority.coordinate(()=>command(a,"configure",{policy:validated},randomUUID()))}
 };
}
