// M2b：影子抽取的运行服务。一轮聊天成功结束后登记任务，串行执行：
// 核对开关 → 构造请求 → 预占额度 → 发送 → 校验 → 写回。所有状态判断都以存储为准，这里不缓存开关。
import {randomUUID} from 'node:crypto';
import type {BoundSourceRef} from '../../shared/memory-contracts';
import type {ShadowTurn} from './shadow-contracts';
import {prepareShadowRequest} from './shadow-prompt';
import type {ShadowModel} from './shadow-model-call';
import type {ShadowCounter,ShadowExportRecord,ShadowStatus} from './shadow-store-contracts';
import {validateShadowResponse} from './shadow-validate';

export type ShadowCancelReason='disabled'|'cleared'|'source-changed'|'restart';

export interface ShadowTask {
 /** 仅用于按会话取消，不进入存储。 */
 sessionId:string;
 /** 已核验的用户消息来源。 */
 sourceRef:BoundSourceRef;
 turn:ShadowTurn;
 /** 这一轮聊天实际绑定的模型配置快照。 */
 model:ShadowModel;
}

export interface ShadowServiceOptions {
 transport:{shadowCommand(command:unknown):Promise<unknown>};
 scopeKey:string;
 actorKey:string;
 maxQueue?:number;
 newId?:()=>string;
 /** 内部失败只上报，不影响聊天。 */
 onError?(error:unknown):void;
}

interface Item {task:ShadowTask;key:string;controller:AbortController;reason?:ShadowCancelReason}
type Record_=Partial<Record<ShadowCounter,number>>;

export function createShadowService(options:ShadowServiceOptions) {
 const {transport,scopeKey,actorKey}=options,maxQueue=options.maxQueue??20,newId=options.newId??randomUUID;
 const queue:Item[]=[],keys=new Set<string>();
 let running:Item|undefined,closed=false;

 const command=<T>(kind:string,body:Record<string,unknown>,write=false):Promise<T>=>
  transport.shadowCommand({kind,scopeKey,...(write?{commandId:newId()}:{}),body:{actorKey,...body}}) as Promise<T>;
 const report=(error:unknown)=>{try{options.onError?.(error)}catch{/* 上报失败也不能影响聊天 */}};
 const tally=(counters:Record_)=>command('tally',{counters},true);

 function abort(item:Item,reason:ShadowCancelReason){if(!item.reason){item.reason=reason;item.controller.abort()}}

 async function run(item:Item):Promise<void> {
  const {task}=item,signal=item.controller.signal;
  // 应用退出（restart）时不写库，连计数也不记。
  const cancelled=async()=>{if(item.reason==='restart')return;await tally({[`cancel:${item.reason??'disabled'}`]:1})};
  if(signal.aborted)return void await cancelled();
  // 关闭时什么都不做：不发送、不写库，连计数也不记。
  const status=await command<ShadowStatus>('status',{});
  if(!status.enabled)return;
  try{task.model.assertCurrent()}catch{return void await tally({'cancel:profile-changed':1})}
  const request=prepareShadowRequest(task.turn);
  if(!request.send)return void await tally({[`skip:${request.reason}`]:1});
  const call=task.model.prepare(request.system,request.user);
  if(!call.ok)return void await tally({'skip:no-output-limit':1});
  const reserved=await command<{status:'reserved'}|{status:'refused'}>('reserve',{clearGeneration:status.clearGeneration,sourceRef:task.sourceRef,promptVersion:request.version},true);
  if(reserved.status!=='reserved')return;
  // 额度已占用：之后无论取消、超时还是失败都不退回。
  if(signal.aborted)return void await cancelled();
  try{task.model.assertCurrent()}catch{return void await tally({'cancel:profile-changed':1})}
  const result=await call.send(signal);
  if(!result.ok){
   if(result.kind==='cancelled')return void await cancelled();
   if(result.kind==='quota'||result.kind==='rate-limit')return void await command('stop',{reason:result.kind},true);
   return void await tally({[`error:${result.kind}`]:1});
  }
  const validation=validateShadowResponse(result.text,task.turn);
  const counters:Record_={};
  for(const [reason,n] of Object.entries(validation.dropped))if(n)counters[`drop:${reason}` as ShadowCounter]=n;
  if(validation.downgraded)counters.downgraded=validation.downgraded;
  await command('record',{clearGeneration:status.clearGeneration,sourceRef:task.sourceRef,profile:{id:task.model.profile.id,revision:task.model.profile.revision},promptVersion:request.version,candidates:validation.candidates,tally:counters},true);
 }

 function pump():void {
  if(running||closed)return;
  const item=queue.shift();if(!item)return;
  running=item;
  void run(item).catch(report).finally(()=>{running=undefined;keys.delete(item.key);pump()});
 }

 function cancelWhere(match:(item:Item)=>boolean,reason:ShadowCancelReason):void {
  for(const item of queue.filter(match)){
   queue.splice(queue.indexOf(item),1);keys.delete(item.key);
   // 还在排队的任务没有占用额度，也没有发送过：直接记一次取消。
   item.reason=reason;void tally({[`cancel:${reason}`]:1}).catch(report);
  }
  if(running&&match(running))abort(running,reason);
 }

 return Object.freeze({
  /** 登记一个任务。同一来源版本在排队或执行中不会重复登记；队列满则丢弃并计数。 */
  submit(task:ShadowTask):void {
   if(closed)return;
   const key=`${task.sourceRef.sourceId}:${task.sourceRef.revision}`;
   if(keys.has(key))return;
   if(queue.length>=maxQueue){void tally({'cancel:queue-full':1}).catch(report);return}
   keys.add(key);queue.push({task,key,controller:new AbortController()});pump();
  },
  /** 会话被删除、或其中的用户消息被编辑/删除时取消该会话的排队和在途任务。 */
  cancelSession(sessionId:string,reason:ShadowCancelReason='source-changed'):void {cancelWhere(item=>item.task.sessionId===sessionId,reason)},
  status:()=>command<ShadowStatus>('status',{}),
  exportRecords:()=>command<ShadowExportRecord[]>('export',{}),
  prune:()=>command<{removedRecords:number;removedStats:number}>('prune',{},true),
  /** 改开关或每日上限。关闭时先取消所有排队和在途任务，再写入。 */
  async configure(body:{enabled:boolean;dailyCap:number;expectedRevision:number}):Promise<ShadowStatus> {
   if(!body.enabled)cancelWhere(()=>true,'disabled');
   return command<ShadowStatus>('configure',body,true);
  },
  async clear():Promise<ShadowStatus> {
   cancelWhere(()=>true,'cleared');
   return command<ShadowStatus>('clear',{},true);
  },
  /** 应用退出：取消全部任务，不写库。 */
  close():void {
   closed=true;
   for(const item of queue.splice(0)){item.reason='restart';keys.delete(item.key)}
   if(running)abort(running,'restart');
  },
  /** 测试用：等当前队列处理完。 */
  idle():Promise<void> {
   return new Promise(resolve=>{const check=()=>{if(!running&&!queue.length)resolve();else setTimeout(check,2)};check()});
  },
 });
}
export type ShadowService=ReturnType<typeof createShadowService>;
