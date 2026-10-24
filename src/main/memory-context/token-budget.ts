import {createHash} from "node:crypto";
import {canonicalJson} from "../memory-core/repository-types";
import {ContextError,contextFail,type BudgetInput,type BudgetResult,type ContextBudget,type ContextMessage,type ContextUnit,type PreparedRequest,type TokenCounter} from "./context-contracts";

const identityKeys=["providerId","model","transport","framingVersion"] as const;
function integer(value:unknown,min=0):number {if(!Number.isSafeInteger(value)||(value as number)<min)contextFail("MEMORY_CONTEXT_INPUT_INVALID");return value as number}
function validateJson(value:unknown,depth=0):void {
 if(depth>32)contextFail("MEMORY_CONTEXT_INPUT_INVALID");
 if(value===null||typeof value==="boolean"||typeof value==="string")return;
 if(typeof value==="number"&&Number.isFinite(value))return;
 if(typeof value!=="object"||value===null||(!Array.isArray(value)&&![Object.prototype,null].includes(Object.getPrototypeOf(value))))contextFail("MEMORY_CONTEXT_INPUT_INVALID");
 const entries=Object.values(value);if(entries.length>10000)contextFail("MEMORY_CONTEXT_INPUT_INVALID");for(const child of entries)validateJson(child,depth+1);
}
function freeze<T>(value:T):T {if(value&&typeof value==="object"){for(const child of Object.values(value))freeze(child);Object.freeze(value)}return value}
export function freezeRequest(value:PreparedRequest):PreparedRequest {
 try{validateJson(value);const json=JSON.stringify(value);if(Buffer.byteLength(json)>8*1024*1024)contextFail("MEMORY_CONTEXT_INPUT_INVALID");
  const result=JSON.parse(json) as PreparedRequest;
  for(const key of identityKeys)if(typeof result[key]!=="string"||!result[key]||result[key].length>1024)contextFail("MEMORY_CONTEXT_INPUT_INVALID");
  if(!result.body||typeof result.body!=="object"||Array.isArray(result.body)||!Array.isArray(result.inputTypes)||result.inputTypes.some(t=>typeof t!=="string"||!t))contextFail("MEMORY_CONTEXT_INPUT_INVALID");
  if(result.maxOutputTokens!==undefined)integer(result.maxOutputTokens);return freeze(result);
 }catch(error){if(error instanceof ContextError)throw error;return contextFail("MEMORY_CONTEXT_INPUT_INVALID")}
}
export function requestDigest(request:PreparedRequest):string {return createHash("sha256").update(canonicalJson(request)).digest("hex")}
function inputLimit(budget:ContextBudget,request:PreparedRequest):number {
 if(budget.maxContextTokens===undefined)contextFail("MEMORY_CONTEXT_BUDGET_UNKNOWN");
 const wireBounds=["max_tokens","max_output_tokens","max_completion_tokens"].flatMap(key=>request.body[key]===undefined?[]:[integer(request.body[key])]);
 const context=integer(budget.maxContextTokens,1),output=Math.max(integer(budget.reservedOutputTokens),request.maxOutputTokens??0,...wireBounds),margin=integer(budget.safetyMarginTokens);
 integer(budget.maxSTokens);integer(budget.minRecentCompleteTurns);
 const result=Math.min(budget.maxInputTokens===undefined?context:integer(budget.maxInputTokens,1),context-output-margin);
 if(!Number.isSafeInteger(result)||result<0)contextFail("MEMORY_CONTEXT_FIXED_OVER_BUDGET");return result;
}
async function count(counter:TokenCounter,request:PreparedRequest,signal?:AbortSignal,mode:"exact"|"estimate"="exact"):Promise<number> {
 if(signal?.aborted)contextFail("MEMORY_CONTEXT_CANCELLED");
 if(!counter?.capability||identityKeys.some(k=>counter.capability[k]!==request[k])||!Array.isArray(counter.capability.inputTypes)||request.inputTypes.some(t=>!counter.capability.inputTypes.includes(t)))contextFail("MEMORY_CONTEXT_COUNTER_UNSUPPORTED");
 if(counter.capability.mode!==mode)contextFail("MEMORY_CONTEXT_BUDGET_UNPROVEN");
 let result:number;try{result=await counter.count(request,...(signal?[{signal}]:[]))}catch{if(signal?.aborted)contextFail("MEMORY_CONTEXT_CANCELLED");contextFail("MEMORY_CONTEXT_COUNT_FAILED")}
 if(signal?.aborted)contextFail("MEMORY_CONTEXT_CANCELLED");if(!Number.isSafeInteger(result)||result<0)contextFail("MEMORY_CONTEXT_COUNT_FAILED");return result;
}
/** Exact whole-input measurement without selection or an assumed additive token model. */
export function countPrepared(counter:TokenCounter,request:PreparedRequest):Promise<number>{return count(counter,freezeRequest(request))}
/** Whole-input count for a declared admission mode. Callers must keep estimates labeled as estimates. */
export function countPreparedForAdmission(counter:TokenCounter,request:PreparedRequest,budget:Pick<ContextBudget,"admissionMode">,signal?:AbortSignal):Promise<number>{
 if(budget.admissionMode!==undefined&&budget.admissionMode!=="bounded")contextFail("MEMORY_CONTEXT_INPUT_INVALID");
 return count(counter,freezeRequest(request),signal,budget.admissionMode==="bounded"?"estimate":"exact");
}
export const CONTEXT_MESSAGE_FIELDS=["role","text","content","toolCallIds","toolCallId","toolCalls","name","thinking","rawAssistant","visibility","internal"];
function fields(value:unknown,allowed:readonly string[],required:readonly string[]=allowed):value is Record<string,unknown> {
 return value!==null&&typeof value==="object"&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value))
  &&Reflect.ownKeys(value).every(key=>typeof key==="string"&&allowed.includes(key))&&required.every(key=>Object.hasOwn(value,key));
}
function validateMessagePayload(message:ContextMessage):void {
 // H validates its own source/temporal metadata before reusing this payload validator.
 if(!fields(message,[...CONTEXT_MESSAGE_FIELDS,"id","occurredAt","timeZone","sourceRef"],["role","text"]))contextFail("MEMORY_CONTEXT_INPUT_INVALID");
 if(message.content!==undefined){
  if(typeof message.content==="string"){
   if(message.content!==message.text)contextFail("MEMORY_CONTEXT_INPUT_INVALID");
  }else{
   if(!Array.isArray(message.content)||message.content.length>10000)contextFail("MEMORY_CONTEXT_INPUT_INVALID");
   const texts:string[]=[];
   for(const block of message.content){
    if(block?.type==="text"&&fields(block,["type","text"])&&typeof block.text==="string")texts.push(block.text);
    else if(!(block?.type==="image_url"&&fields(block,["type","image_url"])&&fields(block.image_url,["url"])&&typeof block.image_url.url==="string"&&block.image_url.url))contextFail("MEMORY_CONTEXT_INPUT_INVALID");
   }
   if(texts.join("\n")!==message.text)contextFail("MEMORY_CONTEXT_INPUT_INVALID");
  }
 }
 if(message.thinking!==undefined&&(message.role!=="assistant"||typeof message.thinking!=="string"))contextFail("MEMORY_CONTEXT_INPUT_INVALID");
 if(message.visibility!==undefined&&!["user","internal"].includes(message.visibility))contextFail("MEMORY_CONTEXT_INPUT_INVALID");
 if(message.internal!==undefined){
  const internal=message.internal;
  if(!fields(internal,["kind","revision","digest","id","runId","createdAt"])||!["run_start","state_delta","recovery"].includes(internal.kind)
   ||!Number.isSafeInteger(internal.revision)||internal.revision<0||!Number.isSafeInteger(internal.createdAt)||internal.createdAt<0
   ||[internal.digest,internal.id,internal.runId].some(value=>typeof value!=="string"||!value))contextFail("MEMORY_CONTEXT_INPUT_INVALID");
 }
 if(message.rawAssistant!==undefined){
  if(message.role!=="assistant"||!Array.isArray(message.rawAssistant))contextFail("MEMORY_CONTEXT_INPUT_INVALID");
  validateJson(message.rawAssistant);
  for(const item of message.rawAssistant){
   if(!item||typeof item!=="object"||Array.isArray(item)||typeof item.type!=="string")contextFail("MEMORY_CONTEXT_INPUT_INVALID");
   if(item.type==="message"&&item.role!=="assistant")contextFail("MEMORY_CONTEXT_INPUT_INVALID");
  }
 }
}
function validateRawToolCalls(message:ContextMessage):void {
 if(message.rawAssistant===undefined)return;
 const rawCalls=(message.rawAssistant as Array<Record<string,unknown>>).filter(item=>item.type==="tool_use"||item.type==="function_call"),calls=message.toolCalls??[];
 if(rawCalls.length!==calls.length||message.toolCallIds!==undefined&&message.toolCallIds.length!==calls.length)contextFail("MEMORY_CONTEXT_TOOL_PAIR_INVALID");
 for(let i=0;i<calls.length;i++){
  const raw=rawCalls[i],call=calls[i],id=raw.type==="tool_use"?raw.id:raw.call_id;
  if(id!==call.id||raw.name!==call.name)contextFail("MEMORY_CONTEXT_TOOL_PAIR_INVALID");
  try{
   if(raw.type==="tool_use"){
    if(canonicalJson(raw.input)!==canonicalJson(JSON.parse(call.arguments)))contextFail("MEMORY_CONTEXT_TOOL_PAIR_INVALID");
   }else if(raw.arguments!==call.arguments)contextFail("MEMORY_CONTEXT_TOOL_PAIR_INVALID");
  }catch{contextFail("MEMORY_CONTEXT_TOOL_PAIR_INVALID")}
 }
}
export function validateUnit(unit:ContextUnit):void {
 if(!unit||typeof unit.id!=="string"||!unit.id||!["recent","summary"].includes(unit.kind)||!Array.isArray(unit.messages)||!unit.messages.length)contextFail("MEMORY_CONTEXT_INPUT_INVALID");
 const pending=new Set<string>(),seen=new Set<string>(),callNames=new Map<string,string>();
 for(const message of unit.messages){
  if(!message||!["user","assistant","system","tool"].includes(message.role)||typeof message.text!=="string")contextFail("MEMORY_CONTEXT_INPUT_INVALID");
  validateMessagePayload(message);
  if(pending.size&&message.role!=="tool"||message.toolCallId!==undefined&&message.role!=="tool")contextFail("MEMORY_CONTEXT_TOOL_PAIR_INVALID");
  if(message.toolCalls!==undefined){
   if(message.role!=="assistant"||!Array.isArray(message.toolCalls)||!message.toolCalls.length||!message.toolCallIds
    ||message.toolCalls.length!==message.toolCallIds.length)contextFail("MEMORY_CONTEXT_TOOL_PAIR_INVALID");
   for(let index=0;index<message.toolCalls.length;index++){
    const call=message.toolCalls[index];
    if(!call||typeof call!=="object"||Array.isArray(call)||Object.keys(call).length!==3
     ||Object.keys(call).some(key=>!["id","name","arguments"].includes(key))
     ||call.id!==message.toolCallIds[index]||typeof call.name!=="string"||!call.name||typeof call.arguments!=="string")contextFail("MEMORY_CONTEXT_TOOL_PAIR_INVALID");
    callNames.set(call.id,call.name);
   }
  }
  validateRawToolCalls(message);
  if(message.name!==undefined&&(message.role!=="tool"||typeof message.name!=="string"||!message.name))contextFail("MEMORY_CONTEXT_TOOL_PAIR_INVALID");
  if(message.toolCallIds!==undefined){if(message.role!=="assistant"||!Array.isArray(message.toolCallIds)||!message.toolCallIds.length)contextFail("MEMORY_CONTEXT_TOOL_PAIR_INVALID");for(const id of message.toolCallIds){if(typeof id!=="string"||!id||seen.has(id))contextFail("MEMORY_CONTEXT_TOOL_PAIR_INVALID");pending.add(id);seen.add(id)}}
  if(message.role==="tool"){
   if(!message.toolCallId||!pending.delete(message.toolCallId)
    ||(message.name!==undefined&&callNames.has(message.toolCallId)&&message.name!==callNames.get(message.toolCallId)))contextFail("MEMORY_CONTEXT_TOOL_PAIR_INVALID");
  }
  else if(pending.size&&message.role!=="assistant")contextFail("MEMORY_CONTEXT_TOOL_PAIR_INVALID");
 }
 if(pending.size)contextFail("MEMORY_CONTEXT_TOOL_PAIR_INVALID");
}
/** Counts every candidate as a whole prepared request; never assumes additivity/monotonicity. */
export async function selectBudget(input:BudgetInput):Promise<BudgetResult> {
 input={...input,budget:structuredClone(input.budget)};
 if(input.budget.admissionMode!==undefined&&input.budget.admissionMode!=="bounded")contextFail("MEMORY_CONTEXT_INPUT_INVALID");
 const bounded=input.budget.admissionMode==="bounded",mode=bounded?"estimate":"exact";
 const units=structuredClone(input.units);if(!Array.isArray(units)||units.length>10000)contextFail("MEMORY_CONTEXT_INPUT_INVALID");units.forEach(validateUnit);
 if(new Set(units.map(u=>u.id)).size!==units.length)contextFail("MEMORY_CONTEXT_INPUT_INVALID");
 const fixed=freezeRequest(input.prepare([])),fixedLimit=inputLimit(input.budget,fixed);
 if(await count(input.counter,fixed,input.signal,mode)>fixedLimit)contextFail("MEMORY_CONTEXT_FIXED_OVER_BUDGET");
 const protectedIds=new Set(units.filter(u=>u.kind==="recent").slice(-integer(input.budget.minRecentCompleteTurns)).map(u=>u.id));
 if(input.budget.minRecentCompleteTurns===0)protectedIds.clear();
 let selected=units;
 for(;;){
  const request=freezeRequest(input.prepare(structuredClone(selected))),limit=inputLimit(input.budget,request),promptTokens=await count(input.counter,request,input.signal,mode);
  const sRequest=freezeRequest(input.prepareS(structuredClone(selected))),sTokens=selected.length?await count(input.counter,sRequest,input.signal,mode):0;
  if(promptTokens<=limit&&sTokens<=input.budget.maxSTokens)return {request,requestDigest:requestDigest(request),selectedIds:selected.map(u=>u.id),...(bounded?{admissionMode:"bounded" as const,estimates:{estimatedPromptTokens:promptTokens,estimatedSTokens:sTokens,selectionInputLimit:limit}}:{promptTokens,sTokens,inputLimit:limit}),counterIdentity:{providerId:request.providerId,model:request.model,transport:request.transport,framingVersion:request.framingVersion}};
  const remove=selected.findIndex(u=>!protectedIds.has(u.id));if(remove<0)contextFail("MEMORY_CONTEXT_RECENT_OVER_BUDGET");selected=selected.filter((_,i)=>i!==remove);
 }
}
