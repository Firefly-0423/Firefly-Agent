import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {HISTORY_BUDGET_RETAINED_DAYS,countHistoryBudgetDrop,createHistoryBudgetStatsRecorder,emptyHistoryBudgetStats,historyBudgetBucket} from './history-budget-stats';

const dirs:string[]=[];
const tempFile=()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'history-budget-'));dirs.push(dir);return path.join(dir,'memory-history-budget.json')};
afterEach(()=>{for(const dir of dirs.splice(0))fs.rmSync(dir,{recursive:true,force:true});vi.restoreAllMocks();vi.useRealTimers()});
const day=(iso:string)=>new Date(iso+'T12:00:00').getTime();
const stats=(patch:Partial<ReturnType<typeof emptyHistoryBudgetStats>>={})=>({...emptyHistoryBudgetStats(),...patch});

describe('historyBudgetBucket',()=>{
 it.each([[0,'le-6k'],[6000,'le-6k'],[6001,'6k-12k'],[12000,'6k-12k'],[12001,'12k-24k'],[24001,'24k-48k'],[48000,'24k-48k'],[48001,'gt-48k'],[65536,'gt-48k']] as const)('%i chars falls in %s',(chars,bucket)=>{
  expect(historyBudgetBucket(chars)).toBe(bucket);
 });
});

describe('countHistoryBudgetDrop',()=>{
 it('judges excerpt viability from the ranked best window, not from any message in the document',()=>{
  const s=emptyHistoryBudgetStats();
  // A long message outside the matched window does not stop an excerpt.
  countHistoryBudgetDrop(s,{length:7210,messageSizes:[100,100,7000,10],windowTurns:2,bestUnit:0},6000);
  // The matched window itself is too long.
  countHistoryBudgetDrop(s,{length:7210,messageSizes:[100,100,7000,10],windowTurns:2,bestUnit:1},6000);
  // Vector-only match: no best window, so no excerpt.
  countHistoryBudgetDrop(s,{length:8000,messageSizes:[4000,4000],windowTurns:2},6000);
  // Fits the per-document limit; dropped only because the total budget ran out.
  countHistoryBudgetDrop(s,{length:3000,messageSizes:[3000],windowTurns:2,bestUnit:0},6000);
  expect(s).toMatchObject({droppedOversized:3,oversizedExcerptable:1,droppedOverTotal:1,droppedSizes:{'le-6k':1,'6k-12k':3}});
 });
});

describe('createHistoryBudgetStatsRecorder',()=>{
 it('accumulates in memory and writes once after the debounce, not once per query',()=>{
  vi.useFakeTimers();const file=tempFile(),write=vi.spyOn(fs,'writeFileSync');let now=day('2026-10-14');
  const recorder=createHistoryBudgetStatsRecorder(()=>file,{clock:()=>now,debounceMs:1000,maxWaitMs:5000});
  recorder.record(stats({ranked:3,returned:3}));
  const dropped=stats({ranked:4,returned:1,droppedOversized:2,droppedOverTotal:1,oversizedExcerptable:1});dropped.droppedSizes['6k-12k']=2;dropped.droppedSizes['le-6k']=1;recorder.record(dropped);
  now=day('2026-10-15');recorder.record(stats({ranked:1,returned:1}));
  expect(fs.existsSync(file)).toBe(false);expect(write).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1000);
  const saved=JSON.parse(fs.readFileSync(file,'utf8'));
  expect(saved.days['2026-10-14']).toEqual({queries:2,queriesWithDrops:1,ranked:7,returned:4,excerpted:0,droppedOversized:2,droppedOverTotal:1,oversizedExcerptable:1,droppedSizes:{'le-6k':1,'6k-12k':2,'12k-24k':0,'24k-48k':0,'gt-48k':0}});
  expect(saved.days['2026-10-15']).toMatchObject({queries:1,queriesWithDrops:0});
  expect(recorder.read()).toEqual(saved);
 });

 it('counts excerpted documents per day, and a file written before that counter existed still loads and keeps counting',()=>{
  const file=tempFile(),clock=()=>day('2026-10-14');
  const legacy={queries:4,queriesWithDrops:1,ranked:9,returned:8,droppedOversized:1,droppedOverTotal:0,oversizedExcerptable:1,droppedSizes:{'le-6k':0,'6k-12k':1,'12k-24k':0,'24k-48k':0,'gt-48k':0}};
  fs.writeFileSync(file,JSON.stringify({schemaVersion:1,days:{'2026-10-14':legacy,'2026-10-13':{...legacy,excerpted:2}}}));
  const recorder=createHistoryBudgetStatsRecorder(()=>file,{clock});recorder.record(stats({ranked:2,returned:2,excerpted:1}));recorder.flush();
  const days=recorder.read().days;expect(days['2026-10-14']).toEqual({...legacy,queries:5,ranked:11,returned:10,excerpted:1});expect(days['2026-10-13']).toMatchObject({excerpted:2});
 });
 it('rejects a day record whose excerpted counter is not a count',()=>{
  const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
  const file=tempFile(),bad={queries:0,queriesWithDrops:0,ranked:0,returned:0,excerpted:-1,droppedOversized:0,droppedOverTotal:0,oversizedExcerptable:0,droppedSizes:{'le-6k':0,'6k-12k':0,'12k-24k':0,'24k-48k':0,'gt-48k':0}};
  fs.writeFileSync(file,JSON.stringify({schemaVersion:1,days:{'2026-10-14':bad}}));const before=fs.readFileSync(file,'utf8');
  const recorder=createHistoryBudgetStatsRecorder(()=>file,{clock:()=>day('2026-10-14')});recorder.record(stats());recorder.flush();expect(fs.readFileSync(file,'utf8')).toBe(before);expect(warn).toHaveBeenCalled();
 });

 it('a steady stream of queries still flushes by the maximum wait',()=>{
  vi.useFakeTimers();const file=tempFile(),recorder=createHistoryBudgetStatsRecorder(()=>file,{clock:()=>day('2026-10-14'),debounceMs:1000,maxWaitMs:5000});
  for(let i=0;i<10;i++){recorder.record(stats());vi.advanceTimersByTime(600)}
  expect(JSON.parse(fs.readFileSync(file,'utf8')).days['2026-10-14'].queries).toBeGreaterThanOrEqual(8);
 });

 it('flush merges with counts already on disk',()=>{
  const file=tempFile(),clock=()=>day('2026-10-14');
  const first=createHistoryBudgetStatsRecorder(()=>file,{clock});first.record(stats({ranked:2}));first.flush();
  const second=createHistoryBudgetStatsRecorder(()=>file,{clock});second.record(stats({ranked:5}));second.flush();
  expect(second.read().days['2026-10-14']).toMatchObject({queries:2,ranked:7});
 });

 it('the file holds only counters: no text, ids or other strings besides dates and fixed key names',()=>{
  const file=tempFile(),recorder=createHistoryBudgetStatsRecorder(()=>file,{clock:()=>day('2026-10-14')});recorder.record(stats({ranked:2,returned:2}));recorder.flush();
  const strings=[...fs.readFileSync(file,'utf8').matchAll(/"([^"]*)"/g)].map(m=>m[1]);
  expect(new Set(strings)).toEqual(new Set(['schemaVersion','days','2026-10-14','queries','queriesWithDrops','ranked','returned','excerpted','droppedOversized','droppedOverTotal','oversizedExcerptable','droppedSizes','le-6k','6k-12k','12k-24k','24k-48k','gt-48k']));
 });

 it(`keeps only the most recent ${HISTORY_BUDGET_RETAINED_DAYS} days`,()=>{
  const file=tempFile();let now=0;const recorder=createHistoryBudgetStatsRecorder(()=>file,{clock:()=>now});
  const start=day('2026-01-01');for(let i=0;i<HISTORY_BUDGET_RETAINED_DAYS+5;i++){now=start+i*86400000;recorder.record(stats())}recorder.flush();
  const days=Object.keys(recorder.read().days);expect(days).toHaveLength(HISTORY_BUDGET_RETAINED_DAYS);expect(days[0]).toBe('2026-01-06');
 });

 it('ignores malformed statistics and never overwrites an existing file it cannot validate',()=>{
  const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
  const file=tempFile(),recorder=createHistoryBudgetStatsRecorder(()=>file,{clock:()=>day('2026-10-14')});
  recorder.record({...stats(),ranked:-1});recorder.record({...stats(),returned:1.5});recorder.record({...stats(),excerpted:-1});recorder.flush();expect(fs.existsSync(file)).toBe(false);
  fs.writeFileSync(file,'{"not":"ours"}');recorder.record(stats());expect(()=>recorder.flush()).not.toThrow();
  expect(fs.readFileSync(file,'utf8')).toBe('{"not":"ours"}');expect(warn).toHaveBeenCalled();
 });

 it('resolves the file only when it first writes',()=>{
  const file=tempFile(),resolve=vi.fn(()=>file),recorder=createHistoryBudgetStatsRecorder(resolve);
  recorder.record(stats());expect(resolve).not.toHaveBeenCalled();
  recorder.flush();recorder.record(stats());recorder.flush();expect(resolve).toHaveBeenCalledTimes(1);
 });
});
