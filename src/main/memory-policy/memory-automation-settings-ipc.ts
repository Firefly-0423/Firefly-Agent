import type {IpcMainInvokeEvent} from "electron";
import {IPC} from "../../shared/ipc-channels";
import type {MemoryAutomationConfigure,MemoryAutomationResult,MemoryAutomationState} from "../../shared/memory-automation-contracts";
import {objectFields} from "../memory-core/command-validation";
import type {MemorySettingsWindow} from "./memory-settings-ipc";
import {NATURAL_JOB_LIMITS} from "./natural-automation";

export interface MemoryAutomationSettingsHost {
 state(event:IpcMainInvokeEvent):Promise<MemoryAutomationState>;
 configure(event:IpcMainInvokeEvent,input:MemoryAutomationConfigure):Promise<MemoryAutomationState>;
}
interface Options {getSettingsWindow():MemorySettingsWindow|null|undefined;host:MemoryAutomationSettingsHost|null}
const codes=new Set(["MEMORY_SETTINGS_FORBIDDEN","MEMORY_INPUT_INVALID","MEMORY_REVISION_CONFLICT","MEMORY_BACKEND_UNAVAILABLE","MEMORY_SETTINGS_FAILED","MEMORY_CLOSED","MEMORY_NATURAL_CONSENT_DENIED"]);
const reason=(error:unknown)=>error instanceof Error&&codes.has(error.message)?error.message:"MEMORY_SETTINGS_FAILED";
const number=(v:unknown,max=Number.MAX_SAFE_INTEGER)=>{if(typeof v!=="number"||!Number.isSafeInteger(v)||v<0||v>max)throw Error("MEMORY_INPUT_INVALID");return v};
export function parseMemoryAutomationConfigure(value:unknown):MemoryAutomationConfigure {
 const input=objectFields(value,["expectedRevision","language","responseStyle"]);
 if(typeof input.language!=="boolean"||typeof input.responseStyle!=="boolean")throw Error("MEMORY_INPUT_INVALID");
 return {expectedRevision:number(input.expectedRevision),language:input.language,responseStyle:input.responseStyle};
}
function unavailable(code="MEMORY_BACKEND_UNAVAILABLE"):MemoryAutomationState {
 return {available:false,reason:code,config:{revision:0,language:false,responseStyle:false},budget:{day:0,requests:0,units:0,closed:false},counts:{unsent:0,"result-unknown":0,"result-saved":0,applied:0,blocked:0}};
}
/** Strip unknown host metadata; corrupted switches/budgets never become an enabled state. */
function dto(value:unknown):MemoryAutomationState {
 if(!value||typeof value!=="object"||Array.isArray(value))throw Error("MEMORY_INPUT_INVALID");
 const input=objectFields(value,["available"],Object.keys(value).filter(key=>key!=="available"));
 if(input.available===false)return unavailable(typeof input.reason==="string"&&codes.has(input.reason)?input.reason:undefined);
 if(input.available!==true)throw Error("MEMORY_INPUT_INVALID");
 const c=objectFields(input.config,["revision","language","responseStyle"]),budget=objectFields(input.budget,["day","requests","units","closed"]),counts=objectFields(input.counts,["unsent","result-unknown","result-saved","applied","blocked"]);
 if(typeof c.language!=="boolean"||typeof c.responseStyle!=="boolean"||typeof budget.closed!=="boolean")throw Error("MEMORY_INPUT_INVALID");
 return {available:true,config:{revision:number(c.revision),language:c.language,responseStyle:c.responseStyle},budget:{day:number(budget.day),requests:number(budget.requests,NATURAL_JOB_LIMITS.requestsPerDay),units:number(budget.units,NATURAL_JOB_LIMITS.reservedUnitsPerDay),closed:budget.closed},counts:{unsent:number(counts.unsent,NATURAL_JOB_LIMITS.rowsPerActor),"result-unknown":number(counts["result-unknown"],NATURAL_JOB_LIMITS.rowsPerActor),"result-saved":number(counts["result-saved"],NATURAL_JOB_LIMITS.rowsPerActor),applied:number(counts.applied,NATURAL_JOB_LIMITS.rowsPerActor),blocked:number(counts.blocked,NATURAL_JOB_LIMITS.rowsPerActor)}};
}
export function createMemoryAutomationSettingsIpc(options:Options) {
 let tail:Promise<unknown>=Promise.resolve();
 const pending=new WeakMap<object,Map<string,Promise<MemoryAutomationResult>>>();
 function authorize(event:IpcMainInvokeEvent):void {
  const win=options.getSettingsWindow();if(!win||win.isDestroyed()||win.webContents.isDestroyed()||event.sender!==win.webContents||!event.senderFrame||event.senderFrame!==win.webContents.mainFrame)throw Error("MEMORY_SETTINGS_FORBIDDEN");
 }
 async function state(event:IpcMainInvokeEvent):Promise<MemoryAutomationState> {
  authorize(event);if(!options.host)return unavailable();
  try{const result=dto(await options.host.state(event));authorize(event);return result}catch(error){if(reason(error)==="MEMORY_SETTINGS_FORBIDDEN")throw Error("MEMORY_SETTINGS_FORBIDDEN");return unavailable(reason(error))}
 }
 async function configure(event:IpcMainInvokeEvent,value:unknown):Promise<MemoryAutomationResult> {
  let input:MemoryAutomationConfigure;try{authorize(event);input=parseMemoryAutomationConfigure(value)}catch(error){return {status:"rejected",reason:reason(error)}}
  let requests=pending.get(event.sender);if(!requests){requests=new Map();pending.set(event.sender,requests)}
  const key=JSON.stringify(input),existing=requests.get(key);if(existing)return existing;
  const result=tail.then(async():Promise<MemoryAutomationResult>=>{
   try{
    authorize(event);if(!options.host)throw Error("MEMORY_BACKEND_UNAVAILABLE");
    const current=dto(await options.host.state(event));authorize(event);
    if(!current.available)throw Error("MEMORY_BACKEND_UNAVAILABLE");if(current.config.revision!==input.expectedRevision)throw Error("MEMORY_REVISION_CONFLICT");
    const updated=dto(await options.host.configure(event,input));authorize(event);if(!updated.available)throw Error("MEMORY_BACKEND_UNAVAILABLE");return {status:"updated",state:updated};
   }catch(error){return {status:"rejected",reason:reason(error)}}
  });
  requests.set(key,result);tail=result.then(()=>undefined,()=>undefined);void result.finally(()=>{if(requests!.get(key)===result)requests!.delete(key)});return result;
 }
 return {state,configure};
}
export function registerMemoryAutomationSettingsIpc(options:Options&{ipc:{handle(channel:string,handler:(event:IpcMainInvokeEvent,...args:any[])=>unknown):void}}):void {
 const api=createMemoryAutomationSettingsIpc(options);options.ipc.handle(IPC.MEMORY_AUTOMATION_STATE,api.state);options.ipc.handle(IPC.MEMORY_AUTOMATION_CONFIGURE,api.configure);
}
