import {randomUUID} from "node:crypto";
import type {DatabaseSync} from "node:sqlite";
import {objectFields,parseInternalId} from "../memory-core/command-validation";
import {RecordCodec} from "../memory-core/record-codec";
import {transactionNow} from "../memory-core/transaction-clock";
import type {ContextOwner} from "./context-repository";
import {contextFail} from "./context-contracts";
export const OPENROUTER_BASE="https://openrouter.ai/api/v1",OPENROUTER_MODEL="openai/gpt-6-luna";
export const OPENROUTER_RESERVATION_NANODOLLARS=415284000;
const CEILING=1000000000,SCOPE="desktop-openrouter-budget-v1",ID="openrouter-luna-usd1-v1";
const OWNER={actorKey:"desktop-local-user-v1",providerId:"openrouter-api-v1",sessionId:"openrouter-luna-budget-v1"};
const unproven=()=>contextFail("MEMORY_CONTEXT_COST_UNPROVEN"),uncertain=()=>contextFail("MEMORY_CONTEXT_COST_UNCERTAIN");
function object(value:unknown):Record<string,any>{if(!value||typeof value!=="object"||Array.isArray(value))unproven();return value as Record<string,any>}
function amount(value:unknown,fail:()=>never):number{if(typeof value!=="number"||!Number.isFinite(value)||value<0||!Number.isSafeInteger(Math.ceil(value*1e9)))fail();return Math.ceil((value as number)*1e9)}
/** Reviewed public metadata, 2026-10-05. Drift requires review, never an inferred cheap fallback.
 * https://openrouter.ai/api/v1/models/openai/gpt-6-luna/endpoints
 * https://openrouter.ai/docs/api_reference/limits
 */
export function validateOpenRouterPreflight(metadata:unknown,credit:unknown):number{
 const data=object(object(metadata).data),key=object(object(credit).data);
 if(data.id!==OPENROUTER_MODEL||!Array.isArray(data.endpoints))unproven();
 const routed=data.endpoints.filter((e:any)=>typeof e?.tag==="string"&&(e.tag==="openai"||e.tag.startsWith("openai/")&&!['openai/flex','openai/fast'].includes(e.tag)));
 if(routed.length!==1)unproven();const e=object(routed[0]);
 if(e.tag!=="openai"||e.model_id!==OPENROUTER_MODEL||e.provider_name!=="OpenAI"||e.context_length!==1050000||e.max_prompt_tokens!==922000||e.max_completion_tokens!==128000||e.status!==0||!Array.isArray(e.supported_parameters)||!e.supported_parameters.includes("max_tokens"))unproven();
 const p=object(e.pricing),expected:Record<string,unknown>={prompt:"0.0000001",completion:"0.0000005",input_cache_read:"0.00000001",input_cache_write:"0.000000125",web_search:"0.01",discount:0};
 if(Object.keys(p).some(k=>!Object.hasOwn(expected,k)&&k!=="overrides")||Object.entries(expected).some(([k,v])=>p[k]!==v)||!Array.isArray(p.overrides)||p.overrides.length!==1)unproven();
 const tier=object(p.overrides[0]),tierExpected={min_prompt_tokens:272000,prompt:"0.0000002",completion:"0.00000075",input_cache_read:"0.00000002",input_cache_write:"0.00000025"};
 if(Object.keys(tier).length!==Object.keys(tierExpected).length||Object.entries(tierExpected).some(([k,v])=>tier[k]!==v))unproven();
 const limit=amount(key.limit,unproven),remaining=amount(key.limit_remaining,unproven);
 if(limit<1||limit>CEILING||remaining>limit||remaining<OPENROUTER_RESERVATION_NANODOLLARS||key.limit_reset!==null||key.include_byok_in_limit!==true)unproven();
 // Reserve the provider's entire supported prompt ceiling plus cache writes and capped completion,
 // independently of the labeled memory selection estimate. Units are integer nanodollars.
 return OPENROUTER_RESERVATION_NANODOLLARS;
}
/** Authoritative post-use accounting only. This never proves pre-send token fit. */
export function openRouterUsageCost(value:unknown,outputCap:number):number{
 const r=value as any,u=r?.usage;
 if(!r||r.object!=="response"||r.status!=="completed"||typeof r.id!=="string"||!r.id||r.model!==OPENROUTER_MODEL||(r.provider!==undefined&&r.provider!=="OpenAI")||!u||!Number.isSafeInteger(u.input_tokens)||u.input_tokens<0||u.input_tokens>922000||!Number.isSafeInteger(u.output_tokens)||u.output_tokens<0||u.output_tokens>outputCap||!Number.isSafeInteger(u.total_tokens)||u.total_tokens!==u.input_tokens+u.output_tokens)uncertain();
 if(!Array.isArray(r.output)||r.output.some((item:any)=>!["message","reasoning"].includes(item?.type))||u.server_tool_use_details!=null||u.server_tool_cost!==undefined&&u.server_tool_cost!==0||u.cost_details?.server_tool_cost!==undefined&&u.cost_details.server_tool_cost!==0)uncertain();
 const cost=amount(u.cost,uncertain);if(cost>OPENROUTER_RESERVATION_NANODOLLARS)uncertain();return cost;
}
interface ExpenseLedger extends ContextOwner {id:string;spentNanodollars:number;pending:null|{id:string;bootId:string;reservedAt:number}}
// Funding permits occupy a dedicated scope in the existing permit kind; no schema changes.
export const OPENROUTER_EXPENSE_SCOPE=SCOPE;
/** Called only inside ContextRepository's existing trusted transaction and encrypted receipt. */
export function applyOpenRouterExpense(db:DatabaseSync,key:Uint8Array,scope:string,owner:ContextOwner,kind:string,body:Record<string,unknown>):unknown{
 if(scope!==SCOPE||Object.entries(OWNER).some(([k,v])=>owner[k as keyof typeof OWNER]!==v))contextFail("MEMORY_CONTEXT_COST_DENIED");
 const identity=["actorKey","providerId","sessionId","bootId"];
 objectFields(body,[...identity,"reservationId",...(kind==="expenseSettle"?["costNanodollars"]:[])]);
 const reservationId=parseInternalId(body.reservationId),codec=new RecordCodec(key),row=db.prepare("SELECT kind,payload FROM context_records WHERE scope_key=? AND id=?").get(scope,ID);
 let ledger:ExpenseLedger={...owner,id:ID,spentNanodollars:0,pending:null};
 if(row){if(row.kind!=="permit")contextFail("MEMORY_DATA_INVALID");ledger=codec.open<ExpenseLedger>("context-expense",scope,ID,row.payload);if(ledger.id!==ID||Object.entries(OWNER).some(([k,v])=>ledger[k as keyof typeof OWNER]!==v)||!Number.isSafeInteger(ledger.spentNanodollars)||ledger.spentNanodollars<0||ledger.spentNanodollars>CEILING)contextFail("MEMORY_DATA_INVALID")}
 if(kind==="expenseReserve"){
  if(ledger.pending)uncertain();if(ledger.spentNanodollars+OPENROUTER_RESERVATION_NANODOLLARS>CEILING)contextFail("MEMORY_CONTEXT_COST_LIMIT");
  ledger.pending={id:reservationId,bootId:owner.bootId,reservedAt:transactionNow(db)};
 }else{
  if(!ledger.pending||ledger.pending.id!==reservationId||ledger.pending.bootId!==owner.bootId)contextFail("MEMORY_CONTEXT_COST_DENIED");
  if(kind==="expenseSettle"){if(!Number.isSafeInteger(body.costNanodollars)||(body.costNanodollars as number)<0||(body.costNanodollars as number)>OPENROUTER_RESERVATION_NANODOLLARS)uncertain();ledger.spentNanodollars+=body.costNanodollars as number}
  else if(kind!=="expenseRelease")contextFail("MEMORY_CONTEXT_COMMAND_INVALID");
  ledger.pending=null;
 }
 db.prepare("INSERT INTO context_records VALUES(?,?,?,1,?) ON CONFLICT(id,scope_key) DO UPDATE SET revision=revision+1,payload=excluded.payload WHERE kind=excluded.kind").run(ID,scope,"permit",codec.seal("context-expense",scope,ID,ledger));
 return {spentNanodollars:ledger.spentNanodollars,reservedNanodollars:ledger.pending?OPENROUTER_RESERVATION_NANODOLLARS:0};
}
/** Private Main capability. Tokens are never serialized to Renderer or shared across expense owners. */
export function createOpenRouterExpense(transport:{contextCommand:(c:unknown)=>Promise<unknown>},bootId:string){
 parseInternalId(bootId);const tokens=new WeakMap<object,string>();
 const command=(kind:string,id:string,extra:Record<string,unknown>={})=>transport.contextCommand({kind,scopeKey:SCOPE,commandId:randomUUID(),body:{...OWNER,bootId,reservationId:id,...extra}});
 async function reserve(){const id=randomUUID();await command("expenseReserve",id);const token=Object.freeze({});tokens.set(token,id);return token}
 async function finish(token:object,kind:string,extra:Record<string,unknown>={}){const id=tokens.get(token);if(!id)contextFail("MEMORY_CONTEXT_COST_DENIED");await command(kind,id,extra);tokens.delete(token)}
 return Object.freeze({reserve,release:(token:object)=>finish(token,"expenseRelease"),settle:(token:object,costNanodollars:number)=>finish(token,"expenseSettle",{costNanodollars})});
}
export type OpenRouterExpense=ReturnType<typeof createOpenRouterExpense>;
/** Preserve the SDK stream controller; accounting happens before final completion is observable. */
export async function accountOpenRouterResult(value:any,expense:OpenRouterExpense,token:object,outputCap:number):Promise<any>{
 const response=await value;
 if(response&&typeof response[Symbol.asyncIterator]==="function"){
  let used=false;
  return {controller:response.controller,async *[Symbol.asyncIterator](){
   if(used)uncertain();used=true;let completed=false;
   for await(const event of response){if(completed)uncertain();if(event?.type==="response.completed"){await expense.settle(token,openRouterUsageCost(event.response,outputCap));completed=true}yield event}
   if(!completed)uncertain();
  }};
 }
 await expense.settle(token,openRouterUsageCost(response,outputCap));return response;
}
