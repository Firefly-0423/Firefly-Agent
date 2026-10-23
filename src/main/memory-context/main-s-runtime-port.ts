import type {ConversationTranscriptStore} from "../orchestrator/conversation-transcript-store";
import {consumeSResponseStream} from "./s-response-stream";
import {factContextMessages} from "./fact-context-messages";
import {controlledSettlement,copyControlledStreamTarget,type ControlledStreamTarget} from "../orchestrator/controlled-responses";
import {classifySAssistantSettlement} from "../orchestrator/conversation-transcript-settlement";
import type {TranscriptEntry,SAssistantBinding} from "../orchestrator/conversation-transcript-types";
import type {BoundSourceRef} from "../../shared/memory-contracts";
import {requireCommittedUserSource,type createMainUserFactCoordinator} from "../memory-policy/main-user-fact-coordinator";
import type {createMainFactSelector} from "../memory-recall/main-fact-selector";
import {requireTranscriptSinkBinding} from "../orchestrator/transcript-sink";
import type {ChatMessage,ChatRequest} from "../orchestrator/vendors/types";
import type {MainActorAuthority} from "../memory-core/main-actor-authority";
import type {createMainSourceRegistry} from "../memory-sources/source-registry";
import {contextFail,type ContextTransport,type ContextUnit} from "./context-contracts";
import {createMainContext} from "./main-context";
import {copyMainResponsesRequest,type createMainResponsesBinding} from "./main-responses-binding";

export interface MainSRuntimeInput {request:ChatRequest;signal?:AbortSignal;stream?:ControlledStreamTarget}
export type MainSRuntimeResult={status:"sent";requestDigest:string;result:unknown}|{status:"result-unknown";requestDigest:string};
export interface MainSRuntimePort {run(input:MainSRuntimeInput):Promise<MainSRuntimeResult>}
interface PortOptions {
 enabled?:boolean;clock?:()=>number;
 registry:ReturnType<typeof createMainSourceRegistry>;transport:ContextTransport;actorAuthority:MainActorAuthority;actorToken:object;
 binding:NonNullable<ReturnType<typeof createMainResponsesBinding>>;
 facts?:{currentUserSource:(binding:{userTurnId:string;userRevision:number})=>Promise<BoundSourceRef>;coordinator:ReturnType<typeof createMainUserFactCoordinator>;selector:ReturnType<typeof createMainFactSelector>;limits:{maxFacts:number}};
 /** Trusted Main query returns genuine opaque evidence; no native reader or renderer grant. */
 history?:{query:(capture:{userTurnId:string;userRevision:number;userText:string},signal?:AbortSignal)=>Promise<object[]>};
 /** Trusted Main adapter ownership; no renderer-provided transcript or source authority. */
 createTranscript:(context:ReturnType<typeof createMainContext>)=>{captureTurns():Promise<object[]>;captureRun?(runId?:string):Promise<{store:ConversationTranscriptStore;transcriptTokens:object[];throughSeq:number;userTurnId:string;userRevision:number;userText:string;mutationRevision:number}>;mutationState?():{revision:number;kind:string;entry?:TranscriptEntry;receipt?:object}};
}
/** Default-off controlled Main boundary. Caller owns lifecycle of injected adapter/Worker resources. */
export function createMainSRuntimePort(options:PortOptions):MainSRuntimePort|null {
 if(options.enabled!==true)return null;
 const actor=options.actorAuthority.requireActor(options.actorToken);
 if(actor.sessionMode==="temporary")contextFail("MEMORY_CONTEXT_TEMPORARY_UNSUPPORTED");
 const binding=options.binding;
 if(binding.budget.minRecentCompleteTurns<1)contextFail("MEMORY_CONTEXT_RECENT_INCOMPLETE");
 const streamRuns=new Set<string>();
 let active:ChatRequest|undefined,tail:Promise<unknown>=Promise.resolve();
 function messages(units:ContextUnit[]):ChatMessage[]{return units.flatMap(unit=>unit.messages.map(m=>({role:m.role,content:m.text,...(m.toolCalls?{toolCalls:m.toolCalls}:{}),...(m.toolCallId!==undefined?{toolCallId:m.toolCallId}:{}),...(m.name!==undefined?{name:m.name}:{})})))}
 function fixed():ChatRequest{if(!active)contextFail("MEMORY_CONTEXT_RUNTIME_INACTIVE");return active}
 const context=createMainContext({includeFactSupportMetadata:true,clock:options.clock,registry:options.registry,transport:options.transport,actorAuthority:options.actorAuthority,counter:binding.counter,budget:binding.budget,
  prepare:(units,facts)=>binding.prepare({...fixed(),messages:[...fixed().messages,...factContextMessages(facts),...messages(units)]}),
  prepareS:units=>{const request=fixed();return binding.prepare({model:request.model,maxTokens:request.maxTokens,stream:false,messages:messages(units)})}
 });
 const transcript=options.createTranscript(context);
 async function run(input:MainSRuntimeInput):Promise<MainSRuntimeResult>{
  const originalSignal=input.signal;if(originalSignal?.aborted)contextFail("MEMORY_CONTEXT_CANCELLED");
  const request=copyMainResponsesRequest(input.request);
  const target=input.stream===undefined?undefined:copyControlledStreamTarget(input.stream);
  if(target){
   if(request.stream!==true||!transcript.captureRun)contextFail("MEMORY_CONTEXT_STREAM_UNSUPPORTED");
   if(request.tools?.length||request.toolChoiceIntent)contextFail("MEMORY_CONTEXT_STREAM_TOOLS_UNSUPPORTED");
   if(target.conversationId!==actor.sessionId)contextFail("MEMORY_ACTOR_DENIED");requireTranscriptSinkBinding(target.sink,target);
   if(!target.isCurrent())contextFail("MEMORY_CONTEXT_RUN_STALE");
   if(streamRuns.has(target.runId))contextFail("MEMORY_CONTEXT_STREAM_RUN_REUSED");
  }else if(request.stream!==false)contextFail("MEMORY_CONTEXT_STREAM_UNSUPPORTED");
  if(!Array.isArray(request.messages)||request.messages.some(message=>message.role!=="system"))contextFail("MEMORY_CONTEXT_ORDER_REQUIRED");
  // Validate the entire schema/output/transport contract before source capture and queue awaits.
  binding.prepare(request);
  if(target)streamRuns.add(target.runId);
  // Own the lifetime of this one SDK stream even if durable send confirmation is uncertain.
  const gate=target?controlledSettlement(target.sink):undefined;
  const controller=target?new AbortController():undefined,cancel=()=>{if(gate?.requestCancel())controller?.abort(originalSignal?.reason)};
  if(controller){if(originalSignal?.aborted)cancel();else originalSignal?.addEventListener("abort",cancel,{once:true})}
  const signal=controller?.signal??originalSignal;
  const pending=tail.then(async()=>{
   if(signal?.aborted)contextFail("MEMORY_CONTEXT_CANCELLED");if(target&&!target.isCurrent())contextFail("MEMORY_CONTEXT_RUN_STALE");active=request;
   try{
    if((options.facts||options.history)&&!transcript.captureRun)contextFail("MEMORY_CONTEXT_STREAM_UNSUPPORTED");
    const capture=transcript.captureRun?await transcript.captureRun(target?.runId):undefined,tokens=capture?.transcriptTokens??await transcript.captureTurns();
    if(target)requireTranscriptSinkBinding(target.sink,target,capture!.store);
    if(target&&capture!.userTurnId!==target.userTurnId)contextFail("MEMORY_CONTEXT_STREAM_TURN_STALE");if(signal?.aborted)contextFail("MEMORY_CONTEXT_CANCELLED");
    if(!tokens.length)contextFail("MEMORY_CONTEXT_RECENT_INCOMPLETE");
    let currentUserSourceRef:BoundSourceRef|undefined,factRefs:import("./context-contracts").FactDependency[]|undefined;
    if(options.facts){
     currentUserSourceRef=await options.facts.currentUserSource({userTurnId:capture!.userTurnId,userRevision:capture!.userRevision});
     const verified=requireCommittedUserSource(options.actorAuthority,options.actorToken,currentUserSourceRef,"MEMORY_CONTEXT_TEMPORARY_UNSUPPORTED");
     if(verified.sourceRef.binding.messageId!==capture!.userTurnId||await options.registry.readEvidence(actor.access,actor.adapter,verified.sourceRef)!==capture!.userText)contextFail("MEMORY_CONTEXT_STREAM_TURN_STALE");
     await capture!.store.withReadLease(actor.sessionId,async read=>{
      const raw=await read();if(raw.throughSeq!==capture!.throughSeq)contextFail('MEMORY_CONTEXT_STREAM_TURN_STALE');const entry=raw.entries.find(e=>(e.kind==='user'||e.kind==='turn_rewind')&&e.turnId===capture!.userTurnId&&e.revision===capture!.userRevision);
      if(!entry)contextFail('MEMORY_CONTEXT_STREAM_TURN_STALE');
      const payload=entry.kind==='user'?entry.payload:entry.kind==='turn_rewind'?entry.payload.replacementUser:undefined;
      if(payload&&!payload.attachments?.length)await context.recordHistoryUser(options.actorToken,currentUserSourceRef!,entry);
     });
     await options.facts.coordinator.onCommittedUserSource(options.actorToken,currentUserSourceRef,signal);
     factRefs=(await options.facts.selector.selectFactRefs(options.actorToken,currentUserSourceRef,options.facts.limits,signal)).map(({factId,revision})=>({factId,revision}));
    }
    const historyTokens=options.history?await options.history.query({userTurnId:capture!.userTurnId,userRevision:capture!.userRevision,userText:capture!.userText},signal):undefined;
    const snapshot=await context.assemble(options.actorToken,{sessionId:actor.sessionId,sourceRefs:[],...(currentUserSourceRef?{currentUserSourceRef}:{}),...(factRefs?{factRefs}:{}),...(historyTokens?{historyTokens}:{}),transcriptTokens:tokens,currentTranscript:{token:tokens.at(-1)!,...(capture?{user:{turnId:capture.userTurnId,revision:capture.userRevision}}:{})},signal});
    if(!snapshot.selectedIds.length)contextFail("MEMORY_CONTEXT_RECENT_INCOMPLETE");
    const permit=await context.validateForDispatch(options.actorToken,snapshot,signal);
    const check=()=>{binding.assertCurrent();if(target&&!target.isCurrent())contextFail("MEMORY_CONTEXT_RUN_STALE")};
    const sent=await binding.dispatch(context,options.actorToken,permit,signal,target?check:undefined);
    if(!target)return sent;if(sent.status!=="sent")contextFail("MEMORY_CONTEXT_SEND_UNKNOWN");
    let historyResponse:object|undefined;
    const validate=async(ticket?:object)=>{check();if(historyResponse&&ticket)await context.validateHistoryResponseStep(options.actorToken,historyResponse,ticket,signal);else await context.validateResponse(options.actorToken,snapshot,signal);check()};
    if(!transcript.mutationState||!Number.isSafeInteger(capture!.userRevision)||capture!.userRevision<1)contextFail("MEMORY_CONTEXT_RESPONSE_PROGRESS_DENIED");
    const owned:SAssistantBinding={runId:target.runId,assistantTurnId:target.assistantTurnId,userTurnId:target.userTurnId,userRevision:capture!.userRevision};
    const assistantEntryId=`${target.runId}:assistant:s-response`,settlementBinding={...owned,assistantEntryId};
    const prove=(seq:number,revision:number,kind:"assistant"|"assistant_settlement",text:string)=>{
     const mutation=transcript.mutationState!(),entry=mutation.entry;
     if(mutation.kind!=="append"||mutation.revision!==revision||!entry||entry.seq!==seq||entry.kind!==kind||entry.runId!==owned.runId||entry.turnId!==owned.assistantTurnId)contextFail("MEMORY_CONTEXT_RESPONSE_PROGRESS_STALE");
     if(entry.kind==="assistant"&&(entry.id!==assistantEntryId||entry.sSettlement?.version!==1||entry.sSettlement.userTurnId!==owned.userTurnId||entry.sSettlement.userRevision!==owned.userRevision||entry.payload.content!==text))contextFail("MEMORY_CONTEXT_RESPONSE_PROGRESS_STALE");
     if(entry.kind==="assistant_settlement"&&(entry.payload.result!=="success"||entry.payload.binding.assistantEntryId!==assistantEntryId||entry.payload.binding.userTurnId!==owned.userTurnId||entry.payload.binding.userRevision!==owned.userRevision))contextFail("MEMORY_CONTEXT_RESPONSE_PROGRESS_STALE");
     return mutation;
    };
    const bindProgress=(seq:number,revision:number,kind:"assistant"|"assistant_settlement",text:string)=>{
     const mutation=prove(seq,revision,kind,text);if(!mutation.receipt)contextFail("MEMORY_CONTEXT_RESPONSE_PROGRESS_DENIED");
     context.bindResponseProgress(options.actorToken,snapshot,mutation.receipt,()=>{prove(seq,revision,kind,text)});
    };
    const result=await consumeSResponseStream({stream:sent.result,target,signal,validate,afterCommit:()=>{if(gate!.get()!=="success")contextFail("MEMORY_CONTEXT_SETTLEMENT_UNKNOWN")},commit:async text=>{
     let dispatched=false,committedAssistant:TranscriptEntry|undefined;
     try{
      historyResponse=context.beginHistoryResponse(options.actorToken,snapshot,{...owned,assistantEntryId,throughSeq:capture!.throughSeq,text});
      if(historyResponse)await context.prepareHistoryResponseStep(options.actorToken,historyResponse,signal);
      await target.sink.appendSAssistant({message:{role:"assistant",content:text},binding:owned,guard:{throughSeq:capture!.throughSeq,validate,commit:write=>{
       bindProgress(capture!.throughSeq+1,capture!.mutationRevision+1,"assistant",text);
       committedAssistant=prove(capture!.throughSeq+1,capture!.mutationRevision+1,"assistant",text).entry;
       return context.commitResponse(options.actorToken,snapshot,()=>{dispatched=true;return write()},signal,check);
      }}});
      if(historyResponse)await context.prepareHistoryResponseStep(options.actorToken,historyResponse,signal);
      await target.sink.settleSAssistant({binding:settlementBinding,result:"success",safeReason:"completed",guard:{throughSeq:capture!.throughSeq+1,validate,commit:write=>{
       bindProgress(capture!.throughSeq+2,capture!.mutationRevision+2,"assistant_settlement",text);
       return context.commitResponse(options.actorToken,snapshot,()=>{if(!gate!.reserve("success"))contextFail("MEMORY_CONTEXT_CANCELLED");return write()},signal,check,committedAssistant);
      }}});
      if(!gate!.confirm("success"))contextFail("MEMORY_CONTEXT_SETTLEMENT_UNKNOWN");
     }catch(error){
      if(historyResponse){context.endHistoryResponse(options.actorToken,historyResponse);historyResponse=undefined}
      // A reserved result may only be confirmed by its sink, never replaced by cancellation.
      if(gate!.get()==="success_reserved"||gate!.get()==="unknown"){gate!.markUnknown();contextFail("MEMORY_CONTEXT_SETTLEMENT_UNKNOWN")}
      if(!dispatched)throw error;
      const raw=await capture!.store.read(actor.sessionId).catch(()=>contextFail("MEMORY_CONTEXT_SETTLEMENT_UNKNOWN")),matches=raw.entries.filter(e=>e.id===assistantEntryId);
      if(matches.length===1){
       const entry=matches[0];if(entry.kind!=="assistant"||entry.runId!==owned.runId||entry.turnId!==owned.assistantTurnId||entry.sSettlement?.userTurnId!==owned.userTurnId||entry.sSettlement?.userRevision!==owned.userRevision||entry.payload.content!==text||classifySAssistantSettlement(raw.entries,assistantEntryId)!=="pending")contextFail("MEMORY_CONTEXT_SETTLEMENT_UNKNOWN");
       try{
        await target.sink.settleSAssistant({binding:settlementBinding,result:"interrupted",safeReason:signal?.aborted?"cancelled":"response_invalidated",guard:{throughSeq:raw.throughSeq,validate:async()=>{},commit:write=>{if(!gate!.reserve("interrupted"))contextFail("MEMORY_CONTEXT_SETTLEMENT_UNKNOWN");return write()}}});
        if(!gate!.confirm("interrupted"))contextFail("MEMORY_CONTEXT_SETTLEMENT_UNKNOWN");
       }catch{gate!.markUnknown();contextFail("MEMORY_CONTEXT_SETTLEMENT_UNKNOWN")}
      }else if(dispatched)contextFail("MEMORY_CONTEXT_SETTLEMENT_UNKNOWN");
      throw error;
     }finally{if(historyResponse){context.endHistoryResponse(options.actorToken,historyResponse);historyResponse=undefined}}
    }});
    return {status:"sent" as const,requestDigest:sent.requestDigest,result};
   }finally{active=undefined}
  }).catch(error=>{controller?.abort();throw error}).finally(()=>{originalSignal?.removeEventListener("abort",cancel)});
  tail=pending.catch(()=>{});return pending;
 }
 return Object.freeze({run});
}
