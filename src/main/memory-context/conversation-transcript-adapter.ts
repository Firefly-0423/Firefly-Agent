import {createHash,randomUUID} from "node:crypto";
import type {MainActorAuthority} from "../memory-core/main-actor-authority";
import {materializeTranscript,type TranscriptRunReader} from "../orchestrator/conversation-transcript-context";
import type {ConversationTranscriptStore} from "../orchestrator/conversation-transcript-store";
import type {TranscriptSnapshot,TranscriptEntry} from "../orchestrator/conversation-transcript-types";
import {readMainAttachmentProjection,observeMainAttachmentProjection} from "./main-attachment-projection";
import {assertContextSecretFree} from "./source-secret-screen";
import {canonicalJson} from "../memory-core/repository-types";
import {contextFail,type ContextMessage,type ContextUnit} from "./context-contracts";
import type {createMainContext} from "./main-context";
import {createMainTranscriptProvider,type CanonicalTranscript} from "./main-transcript-provider";
import {validateUnit} from "./token-budget";
import {requireRunAdjustmentPermit,type RunAdjustmentPermit} from "../chats/pending-adjustment";
import type {RunAdjustmentMessage} from "../orchestrator/harness/types";

interface AdapterOptions {
 enabled?:boolean;
 /** Opaque Main attachment provider; caller messages never establish authority. */
 attachmentProjection?:object;
 store:ConversationTranscriptStore;
 /** Only the host may supply installed run execution facts. */
 runReader?:TranscriptRunReader;
 actorAuthority:MainActorAuthority;
 actorToken:object;
 context:Pick<ReturnType<typeof createMainContext>,"captureTranscript"|"prepareTranscriptChanges"|"transcriptGeneration"> & Partial<Pick<ReturnType<typeof createMainContext>,"observeResponseMutation">>;
 /** Main-owned fanout; an error aborts the canonical mutation before dispatch. */
 beforeMutation?:(kind:"append"|"delete"|"repair",entry?:TranscriptEntry,ticket?:object)=>Promise<void>;
 /** Main session owner retains only genuinely observed event epochs across per-run adapters. */
 observedEventEpochs?:Map<string,number>;
}
const LOCATOR="conversation";

/** Main-only opt-in seam. No application, IPC, model or settings registration. */
export function createConversationTranscriptAdapter(options:AdapterOptions) {
 if(options.enabled!==true)return null;
 const actor=options.actorAuthority.requireActor(options.actorToken);
 if(actor.sessionMode==="temporary")contextFail("MEMORY_CONTEXT_TEMPORARY_UNSUPPORTED");
 let closed=false,incarnation=randomUUID(),revision=1,mutationEpoch=0;
 const published=new Map<string,object>(),eventEpochs=options.observedEventEpochs??new Map<string,number>();
 // These versions describe Main's S projection, never physical JSONL sequence/user revision.
 const projectionEpochs=new Map<string,number>(),turnVersions=new Map<string,{physicalThroughSeq:number;userRevision:number;projectionEpoch:number;version:number}>();
 type RunBinding={incarnation:string;userTurnId:string;userRevision:number;throughSeq:number};
 const runs=new Map<string,RunBinding>();
 const adjustments=new Map<string,{previous:RunBinding;turnId:string;text:string;throughSeq:number;mutationRevision:number;epoch:number;entry?:TranscriptEntry;writeRevision?:number;writeEpoch?:number}>();
 let mutation:{revision:number;kind:string;entry?:TranscriptEntry;receipt?:object}={revision,kind:"initial"};
 let receipt:object|undefined;
 const hash=(value:unknown)=>createHash("sha256").update(canonicalJson(value)).digest("hex");
 const locator=(turnId:string)=>"turn-"+hash(turnId);
 const assertOpen=()=>{if(closed)contextFail("MEMORY_CONTEXT_TRANSCRIPT_ADAPTER_CLOSED")};
 const invalidate=async()=>{
  if(published.size){receipt=await options.context.prepareTranscriptChanges(options.actorToken,[...published.values()]);published.clear()}
 };
 const releaseAttachmentObserver=options.attachmentProjection?observeMainAttachmentProjection(options.attachmentProjection,actor.sessionId,source=>{
  assertOpen();if(mutationEpoch===Number.MAX_SAFE_INTEGER)contextFail("MEMORY_CONTEXT_INPUT_INVALID");
  mutationEpoch++; // Retire captured wire fences before waiting for the canonical read lease.
  return options.store.withReadLease(actor.sessionId,async()=>{
   assertOpen();if(revision===Number.MAX_SAFE_INTEGER)contextFail("MEMORY_CONTEXT_INPUT_INVALID");
   revision++;projectionEpochs.set(source.userTurnId,(projectionEpochs.get(source.userTurnId)??0)+1);
   mutation={revision,kind:"attachment-projection"};await invalidate();
  });
 }):undefined;
 const releaseObserver=options.store.observeMutations(actor.sessionId,async(kind,entry,ticket)=>{
  if(mutationEpoch===Number.MAX_SAFE_INTEGER)contextFail("MEMORY_CONTEXT_INPUT_INVALID");
  mutationEpoch++; // Invalidate send proofs before the observer first yields.
  const epoch=entry?await options.context.transcriptGeneration(options.actorToken):0;
  const responseReceipt=await options.context.observeResponseMutation?.(options.actorToken,kind,entry,ticket,[...published.values()]);
  if(responseReceipt){receipt=responseReceipt;published.clear()}else await invalidate();
  await options.beforeMutation?.(kind,entry,ticket);
  // Observing a historical backfill write does not make its original event new.
  if(entry&&!entry.id.startsWith("backfill:v1:"))eventEpochs.set(entry.id,epoch);
  if(revision===Number.MAX_SAFE_INTEGER)contextFail("MEMORY_CONTEXT_INPUT_INVALID");
  revision++;
  if(kind==="delete"){incarnation=randomUUID();revision=1;eventEpochs.clear();projectionEpochs.clear();turnVersions.clear()}
  mutation={revision,kind,...(entry?{entry:structuredClone(entry)}:{}),...(receipt?{receipt}:{})};
 });
 let leased:CanonicalTranscript[]|null=null;
 const turns=(snapshot:TranscriptSnapshot,attachmentChecks?:Set<()=>void>)=>{
  const whole=canonical(snapshot,actor.sessionId,incarnation,revision,eventEpochs,options.attachmentProjection,attachmentChecks,options.runReader),result:CanonicalTranscript[]=[];
  for(let i=0;i<whole.unit.messages.length;i++){
   const message=whole.unit.messages[i],source=whole.provenance![i];
   if(message.role==="user"){
    if(!source.turnId||!source.revision)contextFail("MEMORY_CONTEXT_RECENT_INCOMPLETE");
    result.push({incarnation,revision:source.seq,throughSeq:source.seq,sourceRefs:[],unit:{id:locator(source.turnId),kind:"recent",messages:[]},provenance:[]});
   }
   const turn=result.at(-1);if(!turn)contextFail("MEMORY_CONTEXT_RECENT_INCOMPLETE");
   turn.unit.messages.push(message);turn.provenance!.push(source);
   turn.throughSeq=Math.max(turn.throughSeq,source.seq);turn.revision=turn.throughSeq;
  }
  for(const turn of result){
   const turnId=turn.provenance![0].turnId!,rewinds=snapshot.entries.filter(e=>e.kind==="turn_rewind"&&e.payload.anchorUserTurnId===turnId&&e.seq>=turn.provenance![0].seq);
   turn.throughSeq=Math.max(turn.throughSeq,...rewinds.map(e=>e.seq));
   const userRevision=turn.provenance![0].revision!,projectionEpoch=projectionEpochs.get(turnId)??0,previous=turnVersions.get(turnId);
   const changed=previous&&(previous.physicalThroughSeq!==turn.throughSeq||previous.userRevision!==userRevision||previous.projectionEpoch!==projectionEpoch);
   turn.revision=changed?Math.max(turn.throughSeq,previous.version+1):previous?.version??turn.throughSeq;
   if(!Number.isSafeInteger(turn.revision))contextFail("MEMORY_CONTEXT_INPUT_INVALID");
   turnVersions.set(turnId,{physicalThroughSeq:turn.throughSeq,userRevision,projectionEpoch,version:turn.revision});
   validateUnit(turn.unit);turn.view={id:"conversation-view",incarnation,revision,throughSeq:snapshot.throughSeq,digest:hash({incarnation,revision,throughSeq:snapshot.throughSeq})}}
  return result;
 };
 const select=(id:string,snapshots:CanonicalTranscript[])=>{const found=snapshots.find(s=>s.unit.id===id);if(!found)contextFail("MEMORY_CONTEXT_TRANSCRIPT_CHANGED");return found};
 const provider=createMainTranscriptProvider({
  scopeKey:actor.scopeKey,providerId:actor.providerId,sessionId:actor.sessionId,
  onCaptured:(cap,id)=>{published.set(id,cap)},
  withLease:async(id,run)=>{
   assertOpen();if(id!==LOCATOR&&!/^turn-[a-f0-9]{64}$/.test(id))contextFail("MEMORY_CONTEXT_TRANSCRIPT_DENIED");
   if(leased)return run(async()=>{assertOpen();return structuredClone(select(id,leased!))});
   return options.store.withReadLease(actor.sessionId,async read=>{
    assertOpen();
    const raw=await read(),snapshot=id===LOCATOR?canonical(raw,actor.sessionId,incarnation,revision,eventEpochs,options.attachmentProjection,undefined,options.runReader):select(id,turns(raw));
    return run(async()=>{assertOpen();return structuredClone(snapshot)});
   });
  }
 });
 async function captureRun(runId?:string,continuation=false){
   assertOpen();return options.store.withReadLease(actor.sessionId,async read=>{
    assertOpen();const raw=await read();
    const previous=runId?runs.get(runId):undefined;
    if(continuation&&(!previous||previous.incarnation!==incarnation||raw.entries.some(entry=>entry.kind==="interruption"&&entry.runId===runId||entry.seq>previous.throughSeq&&entry.kind==="turn_rewind")))contextFail("MEMORY_CONTEXT_STREAM_RUN_REUSED");
    if(!continuation&&runId&&raw.entries.some(entry=>(entry.kind==="assistant"||entry.kind==="interruption")&&entry.runId===runId))contextFail("MEMORY_CONTEXT_STREAM_RUN_REUSED");
    if(!raw.entries.length)contextFail("MEMORY_CONTEXT_RECENT_INCOMPLETE");const attachmentChecks=new Set<()=>void>(),snapshots=turns(raw,attachmentChecks),caps:object[]=[];if(!snapshots.length||snapshots.length>1000)contextFail("MEMORY_CONTEXT_INPUT_INVALID");leased=snapshots;
    try{
     const current=snapshots.at(-1)!,user=current.provenance![0];
     if(continuation&&(user.turnId!==previous!.userTurnId||user.revision!==previous!.userRevision))contextFail("MEMORY_CONTEXT_STREAM_RUN_REUSED");
     for(const snapshot of snapshots)caps.push(await options.context.captureTranscript(options.actorToken,provider,snapshot.unit.id));
     if(runId&&!continuation)runs.set(runId,{incarnation,userTurnId:user.turnId!,userRevision:user.revision!,throughSeq:raw.throughSeq});
     return {store:options.store,transcriptTokens:caps,throughSeq:raw.throughSeq,userTurnId:user.turnId!,userRevision:user.revision!,userText:canonicalUserText(raw.entries.find(entry=>entry.id===user.entryId)!),mutationRevision:revision,assertCurrent:(()=>{const epoch=mutationEpoch;return ()=>{assertOpen();if(mutationEpoch!==epoch)contextFail("MEMORY_CONTEXT_TRANSCRIPT_STALE");for(const check of attachmentChecks)check()}})()};
    }finally{leased=null}
   });
  }
 async function commitRunAdjustment(
  runId:string,permit:RunAdjustmentPermit,boundary:{throughSeq:number;mutationRevision:number;assertCurrent?:()=>void},
  commitHistory:()=>RunAdjustmentMessage|Promise<RunAdjustmentMessage>,
 ):Promise<RunAdjustmentMessage>{
  assertOpen();boundary.assertCurrent?.();
  const item=requireRunAdjustmentPermit(permit,{sessionId:actor.sessionId,runId});
  const stale=():never=>contextFail("MEMORY_CONTEXT_ADJUSTMENT_STALE");
  let attempt=adjustments.get(runId);
  await options.store.withReadLease(actor.sessionId,async read=>{
   assertOpen();boundary.assertCurrent?.();requireRunAdjustmentPermit(permit,{sessionId:actor.sessionId,runId});
   const previous=runs.get(runId),raw=await read();
   if(!previous||previous.incarnation!==incarnation)return stale();
   if(attempt){
    if(attempt.previous!==previous||attempt.turnId!==item.turnId||attempt.text!==item.text
     ||attempt.throughSeq!==boundary.throughSeq||attempt.mutationRevision!==boundary.mutationRevision
     ||!attempt.entry||revision!==attempt.writeRevision||mutationEpoch!==attempt.writeEpoch||raw.throughSeq!==attempt.entry.seq)return stale();
   }else{
    if(raw.throughSeq!==boundary.throughSeq||revision!==boundary.mutationRevision
     ||raw.entries.some(entry=>entry.kind==="interruption"&&entry.runId===runId||entry.seq>previous.throughSeq&&entry.kind==="turn_rewind")
     ||raw.entries.some(entry=>entry.kind==="user"&&entry.turnId===item.turnId))return stale();
    const current=turns(raw).at(-1)?.provenance?.[0];
    if(!current||current.turnId!==previous.userTurnId||current.revision!==previous.userRevision)return stale();
    attempt={previous,turnId:item.turnId,text:item.text,throughSeq:boundary.throughSeq,mutationRevision:boundary.mutationRevision,epoch:mutationEpoch};
    adjustments.set(runId,attempt);
   }
  });
  const pending=attempt!;
  if(!pending.entry){
   try{
    await options.store.append(actor.sessionId,{id:`user:v1:${item.turnId}:r1`,at:Date.now(),kind:"user",turnId:item.turnId,revision:1,payload:{text:item.text}},{
     throughSeq:pending.throughSeq,
     validate:async()=>{
      assertOpen();boundary.assertCurrent?.();requireRunAdjustmentPermit(permit,{sessionId:actor.sessionId,runId});
      if(runs.get(runId)!==pending.previous||incarnation!==pending.previous.incarnation||revision!==pending.mutationRevision||mutationEpoch!==pending.epoch)return stale();
     },
     commit:async write=>{
      assertOpen();boundary.assertCurrent?.();requireRunAdjustmentPermit(permit,{sessionId:actor.sessionId,runId});
      const entry=mutation.entry;
      if(runs.get(runId)!==pending.previous||mutation.kind!=="append"||revision!==pending.mutationRevision+1||mutationEpoch!==pending.epoch+1
       ||entry?.kind!=="user"||entry.seq!==pending.throughSeq+1||entry.id!==`user:v1:${item.turnId}:r1`||entry.turnId!==item.turnId||entry.revision!==1
       ||canonicalJson(entry.payload)!==canonicalJson({text:item.text}))return stale();
      const written=await write();pending.entry=written;pending.writeRevision=revision;pending.writeEpoch=mutationEpoch;return written;
     },
    });
   }catch(error){if(!pending.entry)adjustments.delete(runId);throw error}
  }
  // The store lease protects the final verification and history/source commit.
  // A failed history write retains only this exact, already-written attempt for
  // retry; unrelated appends/edits/deletes can never adopt its authority.
  return options.store.withReadLease(actor.sessionId,async read=>{
   assertOpen();boundary.assertCurrent?.();requireRunAdjustmentPermit(permit,{sessionId:actor.sessionId,runId});
   const raw=await read();
   if(runs.get(runId)!==pending.previous||incarnation!==pending.previous.incarnation||revision!==pending.writeRevision||mutationEpoch!==pending.writeEpoch
    ||!pending.entry||raw.throughSeq!==pending.entry.seq||canonicalJson(raw.entries.at(-1))!==canonicalJson(pending.entry))return stale();
   boundary.assertCurrent?.();
   const result=await commitHistory();
   runs.set(runId,{incarnation,userTurnId:item.turnId,userRevision:1,throughSeq:pending.entry.seq});adjustments.delete(runId);
   return result;
  });
 }
 return {
  commitRunAdjustment,
  capture:async()=>{assertOpen();return options.context.captureTranscript(options.actorToken,provider,LOCATOR)},
  captureTurns:async()=>{return (await captureRun()).transcriptTokens},
  captureRun:(runId?:string)=>captureRun(runId),
  /** Explicit continuation of a run opened by this adapter; never revives an interrupted/replaced turn. */
  captureRunRound:(runId:string)=>captureRun(runId,true),
  mutationState:()=>({...mutation,...(mutation.entry?{entry:structuredClone(mutation.entry)}:{})}),
  close:async()=>{
   if(closed)return;
   await options.store.withReadLease(actor.sessionId,async()=>{
    if(closed)return;
    await invalidate();closed=true;runs.clear();adjustments.clear();releaseObserver();releaseAttachmentObserver?.();
   });
  }
 };
}

/**
 * Pure per-turn view of a canonical transcript for a temporary run. It carries no source,
 * suppression or ledger state: a temporary conversation has none, and nothing here is persisted.
 */
export function canonicalTurnUnits(snapshot:TranscriptSnapshot,sessionId:string,runReader?:TranscriptRunReader):ContextUnit[] {
 const whole=canonical(snapshot,sessionId,"temporary",1,new Map(),undefined,undefined,runReader),units:ContextUnit[]=[];
 for(let i=0;i<whole.unit.messages.length;i++){
  const message=whole.unit.messages[i],source=whole.provenance![i];
  if(message.role==="user"){
   if(!source.turnId||!source.revision)contextFail("MEMORY_CONTEXT_RECENT_INCOMPLETE");
   units.push({id:"turn-"+createHash("sha256").update(source.turnId!).digest("hex"),kind:"recent",messages:[]});
  }
  const unit=units.at(-1);if(!unit)contextFail("MEMORY_CONTEXT_RECENT_INCOMPLETE");
  unit!.messages.push(message);
 }
 for(const unit of units)validateUnit(unit);
 return units;
}
function canonicalUserText(entry:TranscriptEntry):string {
 const payload=entry.kind==="user"?entry.payload:entry.kind==="turn_rewind"?entry.payload.replacementUser:undefined;
 if(!payload||typeof payload.text!=="string")contextFail("MEMORY_CONTEXT_TRANSCRIPT_FORMAT_UNSUPPORTED");return payload.text;
}
function canonical(snapshot:TranscriptSnapshot,sessionId:string,incarnation:string,revision:number,eventEpochs:Map<string,number>,attachmentProjection?:object,attachmentChecks?:Set<()=>void>,runReader?:TranscriptRunReader):CanonicalTranscript {
 let sequence=0;
 const persistedTools=new Set<object>();
 for(const entry of snapshot.entries){
  if(!Number.isSafeInteger(entry.seq)||entry.seq<=sequence)contextFail("MEMORY_CONTEXT_TRANSCRIPT_CHANGED");
  sequence=entry.seq;
  if(entry.kind==="user"&&(typeof entry.payload.text!=="string"))contextFail("MEMORY_CONTEXT_TRANSCRIPT_FORMAT_UNSUPPORTED");
  if(entry.kind==="turn_rewind"&&entry.payload.replacementUser&&(typeof entry.payload.replacementUser.text!=="string"))contextFail("MEMORY_CONTEXT_TRANSCRIPT_FORMAT_UNSUPPORTED");
  if(entry.kind==="assistant"&&entry.payload.role!=="assistant")contextFail("MEMORY_CONTEXT_INPUT_INVALID");
  if(entry.kind==="tool_result"){
   if(entry.payload.message.role!=="tool"||entry.payload.message.toolCallId!==entry.payload.toolCallId)contextFail("MEMORY_CONTEXT_TOOL_PAIR_INVALID");
   persistedTools.add(entry.payload.message);
  }
 }
 const active=materializeTranscript(snapshot.entries,runReader??{get:()=>null},{missingRunEvidence:"unknown"});
 const latestUser=active.messages.map(message=>message.role).lastIndexOf("user");
 const messages:ContextMessage[]=active.messages.map((message,index)=>{
  const entry=active.messageSources![index],payload=entry.kind==="user"?entry.payload:entry.kind==="turn_rewind"?entry.payload.replacementUser:undefined;
  if(message.role==="user"&&payload?.attachments?.length){
   let projection:ReturnType<typeof readMainAttachmentProjection>=null;
   try{if(attachmentProjection)projection=readMainAttachmentProjection(attachmentProjection,sessionId,entry)}catch(error){
    if(index===latestUser||!(error instanceof Error)||!["MEMORY_ATTACHMENT_DENIED","MEMORY_CONTEXT_CANCELLED"].includes(error.message))throw error;
   }
   if(projection){attachmentChecks?.add(projection.assertCurrent);return projection.message}
   if(index===latestUser)contextFail("MEMORY_ATTACHMENT_DENIED");
   return {role:"user",text:payload.text+"\n[MEMORY_ATTACHMENT_HISTORY_UNAVAILABLE: historical attachment content is unavailable and has not been read.]"};
  }
  if(message.role==="tool"&&!persistedTools.has(message))contextFail("MEMORY_CONTEXT_TOOL_PAIR_INVALID");
  if(Object.keys(message).some(key=>!["role","content","toolCalls","toolCallId","name","thinking","rawAssistant","visibility","internal"].includes(key)))contextFail("MEMORY_CONTEXT_INPUT_INVALID");
  const text=typeof message.content==="string"?message.content:Array.isArray(message.content)?message.content.filter(block=>block?.type==="text"&&typeof block.text==="string").map(block=>block.type==="text"?block.text:"").join("\n"):"";
  const result:ContextMessage={role:message.role,text};
  if(message.content!==undefined&&typeof message.content!=="string")result.content=structuredClone(message.content);
  if(message.thinking!==undefined)result.thinking=message.thinking;
  if(message.rawAssistant!==undefined)result.rawAssistant=structuredClone(message.rawAssistant);
  if(message.visibility!==undefined)result.visibility=message.visibility;
  if(message.internal!==undefined)result.internal=structuredClone(message.internal);
  if(message.toolCalls!==undefined){
   result.toolCalls=structuredClone(message.toolCalls);
   result.toolCallIds=message.toolCalls.map(call=>call.id);
  }
  if(message.toolCallId!==undefined)result.toolCallId=message.toolCallId;
  if(message.name!==undefined)result.name=message.name;
  return result;
 });
 const unit={id:sessionId,kind:"recent" as const,messages};
 validateUnit(unit);
 assertContextSecretFree(messages);
 // Canonical history is context only; it does not mint direct-user M sources.
 const provenance=active.messageSources!.map((entry,i)=>{
  const original=messages[i].role==="user"?snapshot.entries.find(e=>e.kind==="user"&&e.turnId===entry.turnId):entry;
  return {entryDigest:createHash("sha256").update(canonicalJson(entry)).digest("hex"),entryId:entry.id,seq:entry.seq,occurredAt:entry.at,role:messages[i].role,suppressionGeneration:original?(eventEpochs.get(original.id)??0):0,...(entry.turnId?{turnId:entry.turnId}:{}),...(entry.revision?{revision:entry.revision}:{})};
 });
 return {incarnation,revision,throughSeq:snapshot.throughSeq,sourceRefs:[],unit,provenance};
}
