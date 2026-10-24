// M2c：影子抽取的设置页 IPC。只接受设置窗口主 frame 的调用；返回值只有开关、次数和计数，不含任何消息内容。
// 导出由主进程弹出保存对话框并写文件，渲染端拿不到记录内容。
import type {IpcMainInvokeEvent} from 'electron';
import {IPC} from '../../shared/ipc-channels';
import type {ShadowExportOutcome,ShadowPanelError,ShadowPanelOutcome,ShadowPanelState} from '../../shared/memory-panel-contracts';
import type {ShadowService} from './shadow-service';
import {SHADOW_COUNTERS,SHADOW_STORE_LIMITS,type ShadowExportRecord,type ShadowStatus} from './shadow-store-contracts';

export const SHADOW_EXPORT_FORMAT='firefly-shadow-memory-export-v1';

export interface ShadowSettingsIpcOptions {
 ipc:{handle(channel:string,listener:(event:IpcMainInvokeEvent,...args:any[])=>unknown):void};
 /** 调用必须来自设置窗口的主 frame（由装配处注入）。 */
 authorize(event:IpcMainInvokeEvent):boolean;
 /** 该构建没有影子存储时返回 null。 */
 service():Promise<ShadowService|null>;
 /** 弹出保存对话框；用户取消返回 undefined。 */
 chooseExportPath(defaultName:string):Promise<string|undefined>;
 writeFile(filePath:string,content:string):Promise<void>;
 clock?:()=>number;
}

const COUNTER_KEYS=new Set<string>(SHADOW_COUNTERS);
const UNAVAILABLE:ShadowPanelState={available:false,enabled:false,dailyCap:SHADOW_STORE_LIMITS.defaultDailyCap,revision:0,day:'',used:0,stopped:null,records:0,counters:{}};

/** 只带出白名单字段和已知的计数名。 */
export function shadowPanelState(status:ShadowStatus):ShadowPanelState {
 const counters:Record<string,number>={};
 for(const [key,value] of Object.entries(status.counters))if(COUNTER_KEYS.has(key)&&Number.isSafeInteger(value))counters[key]=value as number;
 return {available:true,enabled:status.enabled,dailyCap:status.dailyCap,revision:status.revision,day:status.day,used:status.used,stopped:status.stopped,records:status.records,counters};
}

/** 导出文件内容：候选、来源引用、理由、状态、提示词版本。不含聊天原文，只有被引用的那一小段。 */
export function buildShadowExport(records:ShadowExportRecord[],now:number):string {
 return JSON.stringify({
  format:SHADOW_EXPORT_FORMAT,
  exportedAt:new Date(now).toISOString(),
  note:'Shadow records are for reviewing extraction quality only. They are not used in answers.',
  records:records.map(({candidate,sourceRef,profile,promptVersion,recordedAt})=>({
   attribute:candidate.attribute,value:candidate.value,polarity:candidate.polarity,status:candidate.status,
   quote:candidate.evidence.quote,reason:candidate.reason,sourceRef,profile,promptVersion,recordedAt,
  })),
 },null,2);
}

function failure(error:unknown):ShadowPanelError {
 const code=error instanceof Error?error.message:'';
 return code==='MEMORY_REVISION_CONFLICT'?'SHADOW_REVISION_CONFLICT':code==='MEMORY_SHADOW_INPUT_INVALID'||code==='MEMORY_INPUT_INVALID'?'SHADOW_INPUT_INVALID':'SHADOW_FAILED';
}

export function createShadowSettingsIpc(options:ShadowSettingsIpcOptions) {
 const clock=options.clock??Date.now;
 async function withService<T>(event:IpcMainInvokeEvent,run:(service:ShadowService)=>Promise<T>):Promise<T|{ok:false;error:ShadowPanelError}> {
  if(!options.authorize(event))return {ok:false,error:'SHADOW_FORBIDDEN'};
  try{
   const service=await options.service();
   if(!service)return {ok:false,error:'SHADOW_UNAVAILABLE'};
   return await run(service);
  }catch(error){return {ok:false,error:failure(error)}}
 }
 return {
  async state(event:IpcMainInvokeEvent):Promise<ShadowPanelOutcome> {
   if(!options.authorize(event))return {ok:false,error:'SHADOW_FORBIDDEN'};
   try{
    const service=await options.service();
    return {ok:true,state:service?shadowPanelState(await service.status()):UNAVAILABLE};
   }catch(error){return {ok:false,error:failure(error)}}
  },
  configure(event:IpcMainInvokeEvent,value:unknown):Promise<ShadowPanelOutcome> {
   const input=value as {enabled?:unknown;dailyCap?:unknown;expectedRevision?:unknown}|null;
   const keys=input&&typeof input==='object'&&!Array.isArray(input)?Object.keys(input):[];
   const valid=!!input&&keys.length===3&&keys.every(k=>['enabled','dailyCap','expectedRevision'].includes(k))
    &&typeof input.enabled==='boolean'&&Number.isSafeInteger(input.dailyCap)&&(input.dailyCap as number)>=1&&(input.dailyCap as number)<=SHADOW_STORE_LIMITS.maxDailyCap
    &&Number.isSafeInteger(input.expectedRevision)&&(input.expectedRevision as number)>=0;
   if(!options.authorize(event))return Promise.resolve({ok:false,error:'SHADOW_FORBIDDEN'});
   if(!valid)return Promise.resolve({ok:false,error:'SHADOW_INPUT_INVALID'});
   return withService(event,async service=>({ok:true as const,state:shadowPanelState(await service.configure({enabled:input!.enabled as boolean,dailyCap:input!.dailyCap as number,expectedRevision:input!.expectedRevision as number}))})) as Promise<ShadowPanelOutcome>;
  },
  clear(event:IpcMainInvokeEvent):Promise<ShadowPanelOutcome> {
   return withService(event,async service=>({ok:true as const,state:shadowPanelState(await service.clear())})) as Promise<ShadowPanelOutcome>;
  },
  exportRecords(event:IpcMainInvokeEvent):Promise<ShadowExportOutcome> {
   return withService(event,async service=>{
    const records=await service.exportRecords();
    const now=clock(),stamp=new Date(now).toISOString().slice(0,10);
    const target=await options.chooseExportPath(`firefly-shadow-memory-${stamp}.json`);
    if(!target)return {ok:true as const,canceled:true as const};
    await options.writeFile(target,buildShadowExport(records,now));
    return {ok:true as const,canceled:false as const,count:records.length};
   }) as Promise<ShadowExportOutcome>;
  },
 };
}

export function registerShadowSettingsIpc(options:ShadowSettingsIpcOptions) {
 const handlers=createShadowSettingsIpc(options);
 options.ipc.handle(IPC.MEMORY_SHADOW_STATE,handlers.state);
 options.ipc.handle(IPC.MEMORY_SHADOW_CONFIGURE,handlers.configure);
 options.ipc.handle(IPC.MEMORY_SHADOW_EXPORT,handlers.exportRecords);
 options.ipc.handle(IPC.MEMORY_SHADOW_CLEAR,handlers.clear);
 return handlers;
}
