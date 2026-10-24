// Worker-only：影子记录的加密存储。不读写正式事实库；所有写入都在事务里重新核对开关、清空版本和来源。
import {createHmac} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {BoundSourceRef} from '../../shared/memory-contracts';
import {objectFields,parseInternalId,parseSourceRef,positiveRevision} from '../memory-core/command-validation';
import {executeTransaction,type TransactionFault} from '../memory-core/command-transactions';
import {RecordCodec} from '../memory-core/record-codec';
import {canonicalJson} from '../memory-core/repository-types';
import {SourceLedger} from '../memory-core/source-ledger';
import {Suppression} from '../memory-core/suppression';
import {transactionNow} from '../memory-core/transaction-clock';
import {SHADOW_ATTRIBUTES,SHADOW_LIMITS,type ShadowAttribute,type ShadowCandidate} from './shadow-contracts';
import {SHADOW_COUNTERS,SHADOW_STOP_REASONS,SHADOW_STORE_LIMITS,type ShadowCounter,type ShadowExportRecord,type ShadowRecordResult,type ShadowRefusal,type ShadowReserveResult,type ShadowStatus,type ShadowStopReason} from './shadow-store-contracts';

type Kind='control'|'record'|'attempt'|'stats';
interface Control {actorKey:string;revision:number;enabled:boolean;dailyCap:number;clearGeneration:number}
interface Stats {actorKey:string;day:string;used:number;stopped:ShadowStopReason|null;counters:Partial<Record<ShadowCounter,number>>}
/** 预占记录。只能写回一次：写回成功后标为 recorded；清空版本不同的预占不能写回。 */
interface Attempt {actorKey:string;clearGeneration:number;state:'reserved'|'recorded'}
interface StoredRecord extends ShadowExportRecord {actorKey:string;clearGeneration:number}

function fail(code='MEMORY_SHADOW_INPUT_INVALID'):never {throw new Error(code)}
const short=(v:unknown,max:number):string=>{if(typeof v!=='string'||!v.trim()||v.length>max)fail();return v};
const natural=(v:unknown):number=>{if(!Number.isSafeInteger(v)||(v as number)<0)fail();return v as number};
/** 本地日期。worker 与主进程同一时区；日期由 worker 的事务时钟决定，调用方不能指定。 */
export function shadowDay(now:number):string {const d=new Date(now);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`}

function boundRef(v:unknown):BoundSourceRef {const r=parseSourceRef(v);if(!r.binding||r.span)fail();return r as BoundSourceRef}
function candidate(v:unknown,ref:BoundSourceRef):ShadowCandidate {
 const c=objectFields(v,['attribute','value','polarity','status','evidence','reason']),e=objectFields(c.evidence,['messageId','quote']);
 if(!SHADOW_ATTRIBUTES.includes(c.attribute as ShadowAttribute)||!['positive','negative'].includes(c.polarity as string)||!['asserted','needs-confirmation'].includes(c.status as string))fail();
 if(e.messageId!==ref.binding.messageId)fail('MEMORY_SHADOW_SOURCE_MISMATCH');
 return {attribute:c.attribute as ShadowAttribute,value:short(c.value,SHADOW_LIMITS.maxValueChars),polarity:c.polarity as ShadowCandidate['polarity'],status:c.status as ShadowCandidate['status'],
  evidence:{messageId:e.messageId as string,quote:short(e.quote,SHADOW_LIMITS.maxQuoteChars)},reason:short(c.reason,SHADOW_LIMITS.maxReasonChars)};
}
function counters(v:unknown):Partial<Record<ShadowCounter,number>> {
 const raw=objectFields(v,[],SHADOW_COUNTERS),out:Partial<Record<ShadowCounter,number>>={};
 for(const [k,n] of Object.entries(raw)){if(natural(n)>1000)fail();if(n)out[k as ShadowCounter]=n as number}
 return out;
}

export class ShadowRepository {
 private readonly codec:RecordCodec;private readonly ledger:SourceLedger;private readonly suppression:Suppression;
 constructor(private readonly db:DatabaseSync,private readonly key:Uint8Array,private readonly fault?:TransactionFault,private readonly clock:()=>number=Date.now){this.codec=new RecordCodec(key);this.ledger=new SourceLedger(db,key);this.suppression=new Suppression(db,key)}

 private id(kind:Kind,scope:string,actorKey:string,part:unknown):string {return `shadow-${kind}-`+createHmac('sha256',this.key).update('FireflyShadowRecord-v1').update(canonicalJson({kind,scope,actorKey,part})).digest('hex')}
 private get<T>(scope:string,kind:Kind,id:string):T|null {
  const row=this.db.prepare('SELECT kind,payload FROM shadow_records WHERE scope_key=? AND id=?').get(scope,id);
  if(!row)return null;if(row.kind!==kind)fail('MEMORY_DATA_INVALID');return this.codec.open<T>('shadow-'+kind,scope,id,row.payload);
 }
 private put(scope:string,kind:Kind,id:string,value:unknown):void {
  this.db.prepare('INSERT INTO shadow_records(id,scope_key,kind,payload) VALUES(?,?,?,?) ON CONFLICT(id,scope_key) DO UPDATE SET payload=excluded.payload WHERE kind=excluded.kind').run(id,scope,kind,this.codec.seal('shadow-'+kind,scope,id,value));
  this.fault?.('after-record');
 }
 private all<T extends {actorKey:string}>(scope:string,kind:Kind,actorKey:string):Array<{id:string;value:T}> {
  return this.db.prepare('SELECT id,payload FROM shadow_records WHERE scope_key=? AND kind=?').all(scope,kind)
   .map(row=>({id:row.id as string,value:this.codec.open<T>('shadow-'+kind,scope,row.id as string,row.payload)})).filter(r=>r.value.actorKey===actorKey);
 }
 private control(scope:string,actorKey:string):Control {
  return this.get<Control>(scope,'control',this.id('control',scope,actorKey,null))??{actorKey,revision:0,enabled:false,dailyCap:SHADOW_STORE_LIMITS.defaultDailyCap,clearGeneration:0};
 }
 private statsId(scope:string,actorKey:string,day:string){return this.id('stats',scope,actorKey,day)}
 private stats(scope:string,actorKey:string,day:string):Stats {return this.get<Stats>(scope,'stats',this.statsId(scope,actorKey,day))??{actorKey,day,used:0,stopped:null,counters:{}}}
 private bump(s:Stats,add:Partial<Record<ShadowCounter,number>>):void {for(const [k,n] of Object.entries(add))s.counters[k as ShadowCounter]=(s.counters[k as ShadowCounter]??0)+(n as number)}
 private attemptId(scope:string,actorKey:string,ref:BoundSourceRef,promptVersion:string){return this.id('attempt',scope,actorKey,{sourceId:ref.sourceId,revision:ref.revision,promptVersion})}
 /** 来源仍是当前版本、来自用户本人、且没有被"忘记"拦截。任何异常都视为不可用。 */
 private sourceAvailable(scope:string,ref:BoundSourceRef):boolean {
  try{
   const head=this.ledger.assertCurrent(scope,ref);
   return !!head&&head.state==='ready'&&head.published?.state==='live'&&head.published.role==='user'&&head.published.trust==='direct-user-event'&&!this.suppression.sourceBlocked(scope,ref);
  }catch{return false}
 }
 private validRecords(scope:string,actorKey:string,generation:number):Array<{id:string;value:StoredRecord}> {
  return this.all<StoredRecord>(scope,'record',actorKey).filter(r=>r.value.clearGeneration===generation&&this.sourceAvailable(scope,r.value.sourceRef));
 }
 private transaction<T>(scope:string,commandId:string,request:unknown,apply:(now:number)=>T):T {
  return executeTransaction({db:this.db,key:this.key,scope,commandId,request,fault:this.fault,clock:this.clock,apply:()=>apply(transactionNow(this.db))});
 }

 status(scope:string,actorKey:string):ShadowStatus {
  const c=this.control(scope,actorKey),day=shadowDay(this.clock()),s=this.stats(scope,actorKey,day);
  return {enabled:c.enabled,dailyCap:c.dailyCap,revision:c.revision,clearGeneration:c.clearGeneration,day,used:s.used,stopped:s.stopped,records:this.validRecords(scope,actorKey,c.clearGeneration).length,counters:{...s.counters}};
 }
 exportRecords(scope:string,actorKey:string):ShadowExportRecord[] {
  const c=this.control(scope,actorKey);
  return this.validRecords(scope,actorKey,c.clearGeneration).map(r=>r.value).sort((a,b)=>a.recordedAt-b.recordedAt||(a.sourceRef.sourceId<b.sourceRef.sourceId?-1:1))
   .map(r=>({candidate:r.candidate,sourceRef:r.sourceRef,profile:r.profile,promptVersion:r.promptVersion,recordedAt:r.recordedAt}));
 }

 /** 改开关或上限。关闭会让清空版本加一：在途结果一律不能写回。 */
 configure(scope:string,commandId:string,actorKey:string,body:{enabled:boolean;dailyCap:number;expectedRevision:number}):ShadowStatus {
  this.transaction(scope,commandId,{kind:'configure',actorKey,body},()=>{
   const c=this.control(scope,actorKey);if(c.revision!==body.expectedRevision)fail('MEMORY_REVISION_CONFLICT');
   const next:Control={...c,revision:c.revision+1,enabled:body.enabled,dailyCap:body.dailyCap,clearGeneration:c.enabled&&!body.enabled?c.clearGeneration+1:c.clearGeneration};
   this.put(scope,'control',this.id('control',scope,actorKey,null),next);return null;
  });
  return this.status(scope,actorKey);
 }
 /** 发送前预占一次额度。占用后无论结果如何（含超时、结果不明）都算用掉。 */
 reserve(scope:string,commandId:string,actorKey:string,body:{clearGeneration:number;sourceRef:BoundSourceRef;promptVersion:string}):ShadowReserveResult {
  return this.transaction(scope,commandId,{kind:'reserve',actorKey,body},now=>{
   const c=this.control(scope,actorKey),day=shadowDay(now),s=this.stats(scope,actorKey,day),attemptId=this.attemptId(scope,actorKey,body.sourceRef,body.promptVersion);
   let reason:ShadowRefusal|null=null;
   if(!c.enabled)reason='disabled';
   else if(c.clearGeneration!==body.clearGeneration)reason='generation-changed';
   else if(s.stopped)reason='stopped';
   else if(s.used>=c.dailyCap)reason='cap-reached';
   else if(this.get<Attempt>(scope,'attempt',attemptId))reason='duplicate';
   else if(!this.sourceAvailable(scope,body.sourceRef))reason='source-unavailable';
   if(reason){this.bump(s,{[`refuse:${reason}`]:1});this.put(scope,'stats',this.statsId(scope,actorKey,day),s);return {status:'refused',reason}}
   s.used++;this.bump(s,{sent:1});this.put(scope,'stats',this.statsId(scope,actorKey,day),s);
   this.put(scope,'attempt',attemptId,{actorKey,clearGeneration:c.clearGeneration,state:'reserved'} satisfies Attempt);
   return {status:'reserved',day,used:s.used};
  });
 }
 /** 额度不足或限流：当天停止。 */
 stop(scope:string,commandId:string,actorKey:string,reason:ShadowStopReason):null {
  return this.transaction(scope,commandId,{kind:'stop',actorKey,reason},now=>{
   const day=shadowDay(now),s=this.stats(scope,actorKey,day);
   if(!s.stopped){s.stopped=reason;this.bump(s,{[`error:${reason}`]:1});this.put(scope,'stats',this.statsId(scope,actorKey,day),s)}
   return null;
  });
 }
 /** 只记数字：跳过、出错、取消等不经过写回的结果。 */
 tally(scope:string,commandId:string,actorKey:string,add:Partial<Record<ShadowCounter,number>>):null {
  return this.transaction(scope,commandId,{kind:'tally',actorKey,add},now=>{
   const day=shadowDay(now),s=this.stats(scope,actorKey,day);this.bump(s,add);this.put(scope,'stats',this.statsId(scope,actorKey,day),s);return null;
  });
 }
 /** 写回校验后的候选。事务里重新核对：开关、清空版本、来源、确有预占。 */
 record(scope:string,commandId:string,actorKey:string,body:{clearGeneration:number;sourceRef:BoundSourceRef;profile:{id:string;revision:number};promptVersion:string;candidates:ShadowCandidate[];tally:Partial<Record<ShadowCounter,number>>}):ShadowRecordResult {
  return this.transaction(scope,commandId,{kind:'record',actorKey,body},now=>{
   const c=this.control(scope,actorKey),day=shadowDay(now),s=this.stats(scope,actorKey,day);
   const attemptId=this.attemptId(scope,actorKey,body.sourceRef,body.promptVersion),attempt=this.get<Attempt>(scope,'attempt',attemptId);
   const existing=body.candidates.length?this.all<StoredRecord>(scope,'record',actorKey).length:0;
   let reason:ShadowRefusal|null=null;
   if(!c.enabled)reason='disabled';
   else if(c.clearGeneration!==body.clearGeneration)reason='generation-changed';
   // 预占必须属于当前清空版本且尚未写回：关闭后重新开启、或同一结果重复提交，都不能写回。
   else if(!attempt||attempt.state!=='reserved'||attempt.clearGeneration!==body.clearGeneration)reason='not-reserved';
   else if(!this.sourceAvailable(scope,body.sourceRef))reason='source-unavailable';
   else if(existing+body.candidates.length>SHADOW_STORE_LIMITS.maxRecordsPerActor)reason='storage-full';
   if(reason){this.bump(s,{[`discard:${reason}`]:1});this.put(scope,'stats',this.statsId(scope,actorKey,day),s);return {status:'refused',reason}}
   body.candidates.forEach((candidate,index)=>{
    const id=this.id('record',scope,actorKey,{sourceId:body.sourceRef.sourceId,revision:body.sourceRef.revision,promptVersion:body.promptVersion,index});
    this.put(scope,'record',id,{actorKey,clearGeneration:c.clearGeneration,candidate,sourceRef:body.sourceRef,profile:body.profile,promptVersion:body.promptVersion,recordedAt:now} satisfies StoredRecord);
   });
   this.put(scope,'attempt',attemptId,{...attempt!,state:'recorded'} satisfies Attempt);
   this.bump(s,{...body.tally,candidates:body.candidates.length});this.put(scope,'stats',this.statsId(scope,actorKey,day),s);
   return {status:'recorded',written:body.candidates.length};
  });
 }
 /** 物理删除全部影子记录和去重标记，清空版本加一。每日用量保留，避免靠清空绕过上限。 */
 clear(scope:string,commandId:string,actorKey:string):ShadowStatus {
  this.transaction(scope,commandId,{kind:'clear',actorKey},()=>{
   const c=this.control(scope,actorKey);
   for(const kind of ['record','attempt'] as const)for(const r of this.all(scope,kind,actorKey))this.db.prepare('DELETE FROM shadow_records WHERE scope_key=? AND id=?').run(scope,r.id);
   this.put(scope,'control',this.id('control',scope,actorKey,null),{...c,revision:c.revision+1,clearGeneration:c.clearGeneration+1} satisfies Control);return null;
  });
  return this.status(scope,actorKey);
 }
 /** 物理删除已失效的记录（来源删除/编辑/被忘记、旧清空版本）和超过保留期的统计。 */
 prune(scope:string,commandId:string,actorKey:string):{removedRecords:number;removedStats:number} {
  return this.transaction(scope,commandId,{kind:'prune',actorKey},now=>{
   const c=this.control(scope,actorKey),keep=new Set(this.validRecords(scope,actorKey,c.clearGeneration).map(r=>r.id));
   const cutoff=shadowDay(now-SHADOW_STORE_LIMITS.statsRetentionDays*86400000);let removedRecords=0,removedStats=0;
   const del=this.db.prepare('DELETE FROM shadow_records WHERE scope_key=? AND id=?');
   for(const r of this.all<StoredRecord>(scope,'record',actorKey))if(!keep.has(r.id)){del.run(scope,r.id);removedRecords++}
   for(const r of this.all<Stats>(scope,'stats',actorKey))if(r.value.day<cutoff){del.run(scope,r.id);removedStats++}
   return {removedRecords,removedStats};
  });
 }

 execute(value:unknown):unknown {
  const cmd=objectFields(value,['kind','scopeKey','body'],['commandId']),scope=parseInternalId(cmd.scopeKey);
  const write=()=>parseInternalId(cmd.commandId);
  switch(cmd.kind){
   case 'status':{const b=objectFields(cmd.body,['actorKey']);return this.status(scope,parseInternalId(b.actorKey))}
   case 'export':{const b=objectFields(cmd.body,['actorKey']);return this.exportRecords(scope,parseInternalId(b.actorKey))}
   case 'configure':{const b=objectFields(cmd.body,['actorKey','enabled','dailyCap','expectedRevision']);
    if(typeof b.enabled!=='boolean'||!Number.isSafeInteger(b.dailyCap)||(b.dailyCap as number)<1||(b.dailyCap as number)>SHADOW_STORE_LIMITS.maxDailyCap)fail();
    return this.configure(scope,write(),parseInternalId(b.actorKey),{enabled:b.enabled,dailyCap:b.dailyCap as number,expectedRevision:natural(b.expectedRevision)})}
   case 'reserve':{const b=objectFields(cmd.body,['actorKey','clearGeneration','sourceRef','promptVersion']);
    return this.reserve(scope,write(),parseInternalId(b.actorKey),{clearGeneration:natural(b.clearGeneration),sourceRef:boundRef(b.sourceRef),promptVersion:parseInternalId(b.promptVersion)})}
   case 'stop':{const b=objectFields(cmd.body,['actorKey','reason']);if(!SHADOW_STOP_REASONS.includes(b.reason as ShadowStopReason))fail();
    return this.stop(scope,write(),parseInternalId(b.actorKey),b.reason as ShadowStopReason)}
   case 'tally':{const b=objectFields(cmd.body,['actorKey','counters']);return this.tally(scope,write(),parseInternalId(b.actorKey),counters(b.counters))}
   case 'record':{const b=objectFields(cmd.body,['actorKey','clearGeneration','sourceRef','profile','promptVersion','candidates','tally']),ref=boundRef(b.sourceRef),p=objectFields(b.profile,['id','revision']);
    if(!Array.isArray(b.candidates)||b.candidates.length>SHADOW_LIMITS.maxCandidates)fail();
    return this.record(scope,write(),parseInternalId(b.actorKey),{clearGeneration:natural(b.clearGeneration),sourceRef:ref,profile:{id:parseInternalId(p.id),revision:positiveRevision(p.revision)},
     promptVersion:parseInternalId(b.promptVersion),candidates:b.candidates.map(v=>candidate(v,ref)),tally:counters(b.tally)})}
   case 'clear':{const b=objectFields(cmd.body,['actorKey']);return this.clear(scope,write(),parseInternalId(b.actorKey))}
   case 'prune':{const b=objectFields(cmd.body,['actorKey']);return this.prune(scope,write(),parseInternalId(b.actorKey))}
   default:return fail();
  }
 }
}
