import type {AgentLoopResult} from "../orchestrator/firefly-agent";
import type {ControlledStreamTarget} from "../orchestrator/controlled-responses";
import {contextFail} from "./context-contracts";

const invalid=():never=>contextFail("MEMORY_CONTEXT_STREAM_INVALID");
/** Consumes the actual SDK iterable; does not construct requests, retry, or synthesize tool results. */
export async function consumeSResponseStream(input:{stream:unknown;target:ControlledStreamTarget;signal?:AbortSignal;validate:()=>Promise<void>;afterCommit:()=>void;commit:(text:string)=>Promise<void>}):Promise<AgentLoopResult>{
 const stream=input.stream as AsyncIterable<any>&{controller?:AbortController};
 if(!stream||typeof stream[Symbol.asyncIterator]!=="function")invalid();
 const iterator=stream[Symbol.asyncIterator]();let stage=0,sequence=-1,events=0,responseId="",itemId="",text="",textDone=false,terminal=false,started=false,eof=false;
 const check=async()=>{if(input.signal?.aborted)contextFail("MEMORY_CONTEXT_CANCELLED");if(!input.target.isCurrent())contextFail("MEMORY_CONTEXT_RUN_STALE");await input.validate();if(input.signal?.aborted)contextFail("MEMORY_CONTEXT_CANCELLED");if(!input.target.isCurrent())contextFail("MEMORY_CONTEXT_RUN_STALE")};
 function item(value:any,complete:boolean):string {
  if(!value||value.type!=="message"||value.role!=="assistant")contextFail("MEMORY_CONTEXT_STREAM_OUTPUT_UNSUPPORTED");
  if(typeof value.id!=="string"||!value.id||itemId&&itemId!==value.id||value.status!==(complete?"completed":"in_progress")||!Array.isArray(value.content))invalid();itemId=value.id;
  if(value.content.length>1)contextFail("MEMORY_CONTEXT_STREAM_OUTPUT_UNSUPPORTED");
  return value.content.map((part:any)=>{if(part.type!=="output_text"||typeof part.text!=="string"||!Array.isArray(part.annotations)||part.annotations.length||part.logprobs?.length)contextFail("MEMORY_CONTEXT_STREAM_OUTPUT_UNSUPPORTED");return part.text}).join("");
 }
 function part(value:any):string {if(!value||value.type!=="output_text"||typeof value.text!=="string"||!Array.isArray(value.annotations)||value.annotations.length)contextFail("MEMORY_CONTEXT_STREAM_OUTPUT_UNSUPPORTED");return value.text}
 function anchor(event:any){if(event.output_index!==0||event.content_index!==0||typeof event.item_id!=="string"||!event.item_id||itemId&&event.item_id!==itemId)invalid();itemId=event.item_id}
 async function next():Promise<IteratorResult<any>>{
  if(input.signal?.aborted)contextFail("MEMORY_CONTEXT_CANCELLED");
  return new Promise((resolve,reject)=>{
   const abort=()=>{stream.controller?.abort();reject(Error("MEMORY_CONTEXT_CANCELLED"))};
   input.signal?.addEventListener("abort",abort,{once:true});
   Promise.resolve().then(()=>iterator.next()).then(value=>{input.signal?.removeEventListener("abort",abort);resolve(value)},error=>{input.signal?.removeEventListener("abort",abort);reject(error)});
  });
 }
 try{
  input.target.onEvent({type:"step_started",stepName:"chat"});
  for(;;){
   const read=await next();if(read.done){eof=true;break}await check();const event=read.value;
   if(!event||!Number.isSafeInteger(event.sequence_number)||event.sequence_number<0||event.sequence_number<=sequence||++events>10000||terminal)invalid();sequence=event.sequence_number;
   if(event.type==="response.failed"||event.type==="error")contextFail("MEMORY_CONTEXT_STREAM_SERVER_ERROR");
   if(event.type==="response.incomplete")contextFail("MEMORY_CONTEXT_STREAM_INCOMPLETE");
   if(event.type==="response.created"){
    if(stage!==0||responseId||typeof event.response?.id!=="string"||!event.response.id||event.response.status!=="in_progress"||!Array.isArray(event.response.output)||event.response.output.length)invalid();responseId=event.response.id;stage=1;continue;
   }
   if(!responseId)invalid();
   switch(event.type){
    case "response.in_progress":if(stage!==1||event.response?.id!==responseId||event.response.status!=="in_progress"||!Array.isArray(event.response.output)||event.response.output.length)invalid();stage=2;break;
    case "response.output_item.added":if((stage!==1&&stage!==2)||event.output_index!==0||item(event.item,false)!=="")invalid();stage=3;break;
    case "response.content_part.added":if(stage!==3)invalid();anchor(event);if(part(event.part)!=="")invalid();stage=4;break;
    case "response.output_text.delta":
     if(stage!==4)invalid();anchor(event);if(textDone||typeof event.delta!=="string"||event.logprobs?.length)invalid();text+=event.delta;if(Buffer.byteLength(text)>8*1024*1024)invalid();
     if(event.delta){if(!started){input.target.onEvent({type:"text_message_start",messageId:input.target.assistantTurnId,role:"assistant"});started=true}input.target.onEvent({type:"text_message_content",messageId:input.target.assistantTurnId,delta:event.delta})}break;
    case "response.output_text.done":if(stage!==4)invalid();anchor(event);if(textDone||event.text!==text||event.logprobs?.length)invalid();textDone=true;stage=5;break;
    case "response.content_part.done":if(stage!==5)invalid();anchor(event);if(part(event.part)!==text)invalid();stage=6;break;
    case "response.output_item.done":if(stage!==6||event.output_index!==0||item(event.item,true)!==text)invalid();stage=7;break;
    case "response.completed":
     if(stage!==7||event.response?.id!==responseId||event.response.status!=="completed"||!Array.isArray(event.response.output)||event.response.output.length!==1||item(event.response.output[0],true)!==text||!text.trim())invalid();terminal=true;break;
    default:contextFail("MEMORY_CONTEXT_STREAM_OUTPUT_UNSUPPORTED");
   }
  }
  if(!terminal)invalid();await check();await input.commit(text);
  // Own append invalidates the captured sources. After I/O only the run/config/abort guards apply.
  if(input.signal?.aborted)contextFail("MEMORY_CONTEXT_CANCELLED");input.afterCommit();
  input.target.onEvent({type:"text_message_end",messageId:input.target.assistantTurnId});input.target.onEvent({type:"step_finished",stepName:"chat"});
  return {reply:text,toolResults:[],completionReason:"no_tool",terminal:{status:"success",externalEffectsMayContinue:false}};
 }catch(error){stream.controller?.abort();if(error instanceof Error&&/^MEMORY_CONTEXT_[A-Z_]+$/.test(error.message))throw error;return contextFail("MEMORY_CONTEXT_STREAM_FAILED")}
 finally{if(!eof){try{void Promise.resolve(iterator.return?.()).catch(()=>{})}catch{}}}
}
