// 历史检索的预算丢弃计数：只记数字，不记正文、标识、会话或查询内容。
// 用来回答"单份文档超过 maxExcerptChars 在真实使用中有多常见"，再决定是否值得做摘录（PR B）。
import {AtomicJsonStore} from '../atomic-json-store';
import {selectExcerpt} from './history-excerpts';
import {HISTORY_BUDGET_SIZE_BUCKETS,type HistoryBudgetSizeBucket,type HistoryBudgetStats} from './history-contracts';

const BUCKET_LIMITS:ReadonlyArray<[number,HistoryBudgetSizeBucket]>=[[6000,'le-6k'],[12000,'6k-12k'],[24000,'12k-24k'],[48000,'24k-48k']];

export function historyBudgetBucket(chars:number):HistoryBudgetSizeBucket {
 for(const [limit,bucket] of BUCKET_LIMITS)if(chars<=limit)return bucket;
 return 'gt-48k';
}

export function emptyHistoryBudgetStats():HistoryBudgetStats {
 return {ranked:0,returned:0,excerpted:0,droppedOversized:0,droppedOverTotal:0,oversizedExcerptable:0,droppedSizes:Object.fromEntries(HISTORY_BUDGET_SIZE_BUCKETS.map(b=>[b,0])) as Record<HistoryBudgetSizeBucket,number>};
}

/** 被丢弃的文档在排序阶段的形状：每条消息的字符数，以及词法命中的最佳窗口（只有按窗口排序时才有）。 */
export interface HistoryBudgetDrop {length:number;messageSizes:ReadonlyArray<number>;windowTurns:number;bestUnit?:number}

/**
 * 记一份被预算丢弃的文档：单份超限优先于总预算用完。
 * 单份超限时，再看排序选中的最佳窗口本身能否放进 maxExcerptChars——能放下才算摘录救得回来。
 * 这是上限估计：不考虑工具调用与结果必须成组的约束；只靠向量命中、没有最佳窗口的文档算作救不回来。
 * 检索端现在会先摘录再丢弃，所以到这里的超限文档就是摘录没能救回来的：`oversizedExcerptable` 只剩下被工具成组、或被剩余总预算挡住的那部分。
 */
export function countHistoryBudgetDrop(stats:HistoryBudgetStats,drop:HistoryBudgetDrop,maxExcerptChars:number):void {
 if(drop.length>maxExcerptChars){
  stats.droppedOversized++;
  if(drop.bestUnit!==undefined&&selectExcerpt({sizes:drop.messageSizes,windowTurns:drop.windowTurns,bestUnit:drop.bestUnit,maxChars:maxExcerptChars,contextWindows:0}))stats.oversizedExcerptable++;
 }else stats.droppedOverTotal++;
 stats.droppedSizes[historyBudgetBucket(drop.length)]++;
}

const STAT_KEYS=['ranked','returned','excerpted','droppedOversized','droppedOverTotal','oversizedExcerptable'] as const;
/** 文件里的某天可以没有 excerpted（摘录功能之前写入的）；其余计数一律必须有。 */
const OPTIONAL_COUNTERS=['excerpted'] as const;
const COUNTERS=['queries','queriesWithDrops',...STAT_KEYS] as const;
export interface HistoryBudgetDay extends Record<typeof COUNTERS[number],number> {droppedSizes:Record<HistoryBudgetSizeBucket,number>}
export interface HistoryBudgetStatsFile {schemaVersion:1;days:Record<string,HistoryBudgetDay>}
/** 文件只保留最近这么多天，避免无限增长。 */
export const HISTORY_BUDGET_RETAINED_DAYS=90;

const count=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
const isRecord=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
function validDay(v:unknown):boolean {
 if(!isRecord(v))return false;
 const keys=Object.keys(v),allowed:readonly string[]=[...COUNTERS,'droppedSizes'],optional:readonly string[]=OPTIONAL_COUNTERS;
 if(keys.some(k=>!allowed.includes(k))||allowed.some(k=>!keys.includes(k)&&!optional.includes(k))||!COUNTERS.every(k=>v[k]===undefined?optional.includes(k):count(v[k])))return false;
 const sizes=v.droppedSizes;return isRecord(sizes)&&Object.keys(sizes).length===HISTORY_BUDGET_SIZE_BUCKETS.length&&HISTORY_BUDGET_SIZE_BUCKETS.every(b=>count(sizes[b]));
}
export function validHistoryBudgetStatsFile(v:unknown):v is HistoryBudgetStatsFile {
 return isRecord(v)&&v.schemaVersion===1&&isRecord(v.days)&&Object.entries(v.days).every(([day,value])=>/^\d{4}-\d{2}-\d{2}$/.test(day)&&validDay(value));
}
function validStats(v:HistoryBudgetStats):boolean {
 return isRecord(v)&&STAT_KEYS.every(k=>count(v[k]))&&isRecord(v.droppedSizes)&&HISTORY_BUDGET_SIZE_BUCKETS.every(b=>count(v.droppedSizes[b]));
}
const localDay=(now:Date)=>`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
const emptyDay=():HistoryBudgetDay=>({...Object.fromEntries(COUNTERS.map(k=>[k,0])),droppedSizes:emptyHistoryBudgetStats().droppedSizes} as HistoryBudgetDay);
function addDay(into:HistoryBudgetDay,from:HistoryBudgetDay){
 for(const k of COUNTERS)into[k]+=from[k];
 for(const b of HISTORY_BUDGET_SIZE_BUCKETS)into.droppedSizes[b]+=from.droppedSizes[b];
}

export interface HistoryBudgetRecorderOptions {clock?:()=>number;debounceMs?:number;maxWaitMs?:number}

/**
 * 计数先在内存里按本地日期累加，防抖后再原子写回，避免每次检索都在 Main 进程里做同步落盘。
 * 文件路径在第一次落盘时才解析，未安装存储上下文的测试环境里不会触碰磁盘。写入失败只告警，不影响检索。
 * 进程退出时会同步补写一次；异常崩溃最多丢失最后一个防抖窗口内的计数。
 */
export function createHistoryBudgetStatsRecorder(resolveFile:()=>string,options:HistoryBudgetRecorderOptions={}){
 const clock=options.clock??Date.now,debounceMs=options.debounceMs??1000,maxWaitMs=options.maxWaitMs??5000;
 let store:AtomicJsonStore<HistoryBudgetStatsFile>|undefined,pending=new Map<string,HistoryBudgetDay>();
 let saveTimer:ReturnType<typeof setTimeout>|undefined,maxWaitTimer:ReturnType<typeof setTimeout>|undefined,exitHooked=false;
 const clearTimers=()=>{if(saveTimer)clearTimeout(saveTimer);if(maxWaitTimer)clearTimeout(maxWaitTimer);saveTimer=maxWaitTimer=undefined};
 const storeFor=()=>store??=new AtomicJsonStore<HistoryBudgetStatsFile>(resolveFile(),validHistoryBudgetStatsFile);
 function flush():void {
  clearTimers();if(!pending.size)return;
  const batch=pending;pending=new Map();
  try{
   const s=storeFor(),current=s.read({schemaVersion:1,days:{}}),days={...current.days};
   for(const [key,delta] of batch){const day=days[key]?{...emptyDay(),...structuredClone(days[key])}:emptyDay();addDay(day,delta);days[key]=day}
   s.write({schemaVersion:1,days:Object.fromEntries(Object.entries(days).sort(([a],[b])=>a.localeCompare(b)).slice(-HISTORY_BUDGET_RETAINED_DAYS))});
  }catch(error){console.warn('[memory-history] budget stats write failed:',(error as Error).message)}
 }
 const timer=(ms:number)=>{const t=setTimeout(flush,ms);t.unref?.();return t};
 return Object.freeze({
  record(stats:HistoryBudgetStats):void {
   if(!validStats(stats))return;
   const key=localDay(new Date(clock())),day=pending.get(key)??emptyDay();
   day.queries++;if(stats.droppedOversized+stats.droppedOverTotal>0)day.queriesWithDrops++;
   for(const k of STAT_KEYS)day[k]+=stats[k];
   for(const b of HISTORY_BUDGET_SIZE_BUCKETS)day.droppedSizes[b]+=stats.droppedSizes[b];
   pending.set(key,day);
   if(!exitHooked){exitHooked=true;process.once('exit',flush)}
   if(saveTimer)clearTimeout(saveTimer);saveTimer=timer(debounceMs);
   maxWaitTimer??=timer(maxWaitMs);
  },
  flush,
  /** 摘录计数出现之前写入的天补 0，使调用方总能看到完整的计数。 */
  read():HistoryBudgetStatsFile {const file=storeFor().read({schemaVersion:1,days:{}});return {...file,days:Object.fromEntries(Object.entries(file.days).map(([key,day])=>[key,{...emptyDay(),...day}]))}},
 });
}
