import {describe,expect,it} from 'vitest';
import {atomicGroups,excerptDigest,excerptRef,excerptToolSafe,selectExcerpt,sliceExcerpt,verifyExcerpt,verifyExcerptSlice,HISTORY_EXCERPT_VERSION} from './history-excerpts';

const sizes=(n:number,each=10)=>Array.from({length:n},()=>each);
const base={windowTurns:2,contextWindows:1};
const total=(s:number[],r:{start:number;end:number})=>s.slice(r.start,r.end).reduce((a,b)=>a+b,0);

describe('selectExcerpt',()=>{
 it('returns only the best window when no context is allowed',()=>{
  expect(selectExcerpt({...base,sizes:sizes(20),bestUnit:3,maxChars:1000,contextWindows:0})).toEqual({start:6,end:8});
 });
 it('adds one neighbouring window on each side',()=>{
  expect(selectExcerpt({...base,sizes:sizes(20),bestUnit:3,maxChars:1000})).toEqual({start:4,end:10});
 });
 it('adds up to contextWindows windows on each side',()=>{
  expect(selectExcerpt({...base,sizes:sizes(40),bestUnit:5,maxChars:10000,contextWindows:2})).toEqual({start:6,end:16});
 });
 it('only grows the open side at the start and the end of the document',()=>{
  expect(selectExcerpt({...base,sizes:sizes(20),bestUnit:0,maxChars:1000,contextWindows:2})).toEqual({start:0,end:6});
  expect(selectExcerpt({...base,sizes:sizes(20),bestUnit:9,maxChars:1000,contextWindows:2})).toEqual({start:14,end:20});
 });
 it('clips the last window of an odd-length document',()=>{
  expect(selectExcerpt({...base,sizes:sizes(7),bestUnit:3,maxChars:1000,contextWindows:0})).toEqual({start:6,end:7});
 });
 it('stops growing as soon as the budget would be exceeded',()=>{
  // 三个窗口共 60：预算 60 刚好放下；59 时先放下前一个窗口，后一个放不下。
  expect(selectExcerpt({...base,sizes:sizes(20),bestUnit:3,maxChars:60})).toEqual({start:4,end:10});
  expect(selectExcerpt({...base,sizes:sizes(20),bestUnit:3,maxChars:59})).toEqual({start:4,end:8});
 });
 it('keeps growing the other side when one neighbour does not fit',()=>{
  const s=sizes(20);s[5]=500; // 最佳窗口 [6,8) 的前一个窗口 [4,6) 里有一条很大的消息
  expect(selectExcerpt({...base,sizes:s,bestUnit:3,maxChars:100})).toEqual({start:6,end:10});
 });
 it('returns null when the best window alone is over budget',()=>{
  const s=sizes(20);s[6]=7000;
  expect(selectExcerpt({...base,sizes:s,bestUnit:3,maxChars:6000})).toBeNull();
 });
 it.each([
  ['unit below zero',{bestUnit:-1}],
  ['unit past the end',{bestUnit:10}],
  ['fractional unit',{bestUnit:1.5}],
  ['zero windowTurns',{windowTurns:0}],
  ['fractional windowTurns',{windowTurns:1.5}],
  ['negative contextWindows',{contextWindows:-1}],
  ['non-positive budget',{maxChars:0}],
  ['NaN budget',{maxChars:NaN}],
 ])('fails closed on %s',(_,patch)=>{
  expect(selectExcerpt({...base,sizes:sizes(20),bestUnit:3,maxChars:1000,...patch})).toBeNull();
 });
 it('fails closed on an empty or malformed size list',()=>{
  expect(selectExcerpt({...base,sizes:[],bestUnit:0,maxChars:1000})).toBeNull();
  expect(selectExcerpt({...base,sizes:[10,-1,10],bestUnit:0,maxChars:1000})).toBeNull();
  expect(selectExcerpt({...base,sizes:[10,NaN,10],bestUnit:0,maxChars:1000})).toBeNull();
 });
 it('always returns one contiguous range that contains the best window and fits the budget',()=>{
  let seed=7;const rnd=()=>(seed=(seed*1103515245+12345)&0x7fffffff)/0x7fffffff;
  for(let i=0;i<300;i++){
   const n=1+Math.floor(rnd()*60),turns=1+Math.floor(rnd()*4),s=Array.from({length:n},()=>1+Math.floor(rnd()*200));
   const units=Math.ceil(n/turns),bestUnit=Math.floor(rnd()*units),maxChars=50+Math.floor(rnd()*1500),contextWindows=Math.floor(rnd()*4);
   const r=selectExcerpt({sizes:s,windowTurns:turns,bestUnit,maxChars,contextWindows});
   const bestStart=bestUnit*turns,bestEnd=Math.min(n,bestStart+turns);
   if(total(s,{start:bestStart,end:bestEnd})>maxChars){expect(r).toBeNull();continue}
   expect(r).not.toBeNull();
   expect(r!.start).toBeLessThanOrEqual(bestStart);expect(r!.end).toBeGreaterThanOrEqual(bestEnd);
   expect(r!.start).toBeGreaterThanOrEqual(0);expect(r!.end).toBeLessThanOrEqual(n);
   expect(total(s,r!)).toBeLessThanOrEqual(maxChars);
   expect(r!.start%turns).toBe(0);
  }
 });
 it('is deterministic',()=>{
  const input={...base,sizes:sizes(30,13),bestUnit:7,maxChars:200};
  expect(selectExcerpt(input)).toEqual(selectExcerpt(input));
 });
});

const msg=(i:number,extra:Record<string,unknown>={})=>({id:'m'+i,role:'user',text:'t'+i,occurredAt:null,timeZone:null,...extra});
describe('atomicGroups',()=>{
 it('groups an assistant tool call with its results and ignores plain messages',()=>{
  const m=[msg(0),msg(1,{role:'assistant',toolCallIds:['a','b']}),msg(2,{role:'tool',toolCallId:'a'}),msg(3,{role:'tool',toolCallId:'b'}),msg(4,{role:'assistant'}),msg(5)];
  expect(atomicGroups(m)).toEqual([{start:1,end:4}]);
 });
 it('understands calls given as toolCalls and keeps separate groups apart',()=>{
  const m=[msg(0,{role:'assistant',toolCalls:[{id:'x'}]}),msg(1,{role:'tool',toolCallId:'x'}),msg(2),msg(3,{role:'assistant',toolCallIds:['y']}),msg(4,{role:'tool',toolCallId:'y'})];
  expect(atomicGroups(m)).toEqual([{start:0,end:2},{start:3,end:5}]);
 });
 it('merges overlapping groups and tolerates a call whose result is missing',()=>{
  const m=[msg(0,{role:'assistant',toolCallIds:['a']}),msg(1,{role:'assistant',toolCallIds:['b']}),msg(2,{role:'tool',toolCallId:'a'}),msg(3,{role:'tool',toolCallId:'b'}),msg(4,{role:'assistant',toolCallIds:['gone']})];
  expect(atomicGroups(m)).toEqual([{start:0,end:4}]);
 });
});

describe('selectExcerpt with tool groups',()=>{
 // 十条消息，工具组占下标 3..5（调用在 3，结果在 4、5）
 const groups=[{start:3,end:6}];
 const fits=(overrides:object={})=>selectExcerpt({sizes:sizes(10),windowTurns:2,bestUnit:2,maxChars:1000,contextWindows:0,groups,...overrides});
 it('pulls the whole tool group into the excerpt when the best window cuts it',()=>{
  // 最佳窗口 [4,6) 只含两个工具结果；调用在 3，必须一起带上
  expect(fits()).toEqual({start:3,end:6});
 });
 it('never starts or ends an excerpt inside a group, including when growing into neighbours',()=>{
  const r=selectExcerpt({sizes:sizes(10),windowTurns:2,bestUnit:3,maxChars:1000,contextWindows:1,groups})!;
  for(const g of groups)for(const edge of [r.start,r.end])expect(edge<=g.start||edge>=g.end).toBe(true);
 });
 it('refuses when the group the best window needs does not fit, rather than cutting it',()=>{
  expect(fits({maxChars:25})).toBeNull();
  expect(fits({maxChars:30})).toEqual({start:3,end:6});
 });
 it('skips a neighbour whose group does not fit and still grows the other side',()=>{
  const s=sizes(10);s[4]=500; // 工具组 3..5 里有一条大消息
  const r=selectExcerpt({sizes:s,windowTurns:2,bestUnit:0,maxChars:100,contextWindows:2,groups:[{start:1,end:4}]});
  // 最佳窗口 [0,2) 必须带上组 [1,4) => [0,4)，共 40，放得下
  expect(r).toEqual({start:0,end:4});
 });
 it('without groups it behaves exactly as before',()=>{
  expect(selectExcerpt({sizes:sizes(10),windowTurns:2,bestUnit:2,maxChars:1000,contextWindows:0})).toEqual({start:4,end:6});
 });
 it('keeps the contiguity, bounds and budget properties with random groups',()=>{
  let seed=11;const rnd=()=>(seed=(seed*1103515245+12345)&0x7fffffff)/0x7fffffff;
  for(let i=0;i<300;i++){
   const n=2+Math.floor(rnd()*50),turns=1+Math.floor(rnd()*3),s=Array.from({length:n},()=>1+Math.floor(rnd()*120));
   const gs:{start:number;end:number}[]=[];let at=0;while(at<n-1){if(rnd()<.3){const len=2+Math.floor(rnd()*3),end=Math.min(n,at+len);gs.push({start:at,end});at=end}else at++}
   const bestUnit=Math.floor(rnd()*Math.ceil(n/turns)),maxChars=60+Math.floor(rnd()*900),contextWindows=Math.floor(rnd()*3);
   const r=selectExcerpt({sizes:s,windowTurns:turns,bestUnit,maxChars,contextWindows,groups:gs});
   if(!r)continue;
   expect(r.start).toBeGreaterThanOrEqual(0);expect(r.end).toBeLessThanOrEqual(n);expect(r.start).toBeLessThan(r.end);
   expect(total(s,r)).toBeLessThanOrEqual(maxChars);
   for(const g of gs)for(const edge of [r.start,r.end])expect(edge<=g.start||edge>=g.end).toBe(true);
   const bs=bestUnit*turns;expect(r.start).toBeLessThanOrEqual(bs);expect(r.end).toBeGreaterThan(bs);
  }
 });
});

describe('excerpt digest and verification',()=>{
 const documentDigest='a'.repeat(64);
 const messages=Array.from({length:8},(_,i)=>msg(i));
 const provenance=messages.map((_,i)=>({originalId:'o'+i}));
 const doc={messages,provenance};
 const ref=(range:{start:number;end:number},overrides:object={})=>({version:HISTORY_EXCERPT_VERSION,...range,total:8,digest:excerptDigest(documentDigest,doc,range),...overrides});
 it('slices messages and provenance by the same indices',()=>{
  const s=sliceExcerpt(doc,{start:2,end:4});
  expect(s.messages.map(m=>m.id)).toEqual(['m2','m3']);expect(s.provenance).toEqual([{originalId:'o2'},{originalId:'o3'}]);
  expect(sliceExcerpt({messages},{start:0,end:1}).provenance).toBeUndefined();
 });
 it('is deterministic and changes with the document digest, the range and any quoted message',()=>{
  const d=excerptDigest(documentDigest,doc,{start:2,end:4});
  expect(d).toMatch(/^[a-f0-9]{64}$/);expect(excerptDigest(documentDigest,doc,{start:2,end:4})).toBe(d);
  expect(excerptDigest('b'.repeat(64),doc,{start:2,end:4})).not.toBe(d);
  expect(excerptDigest(documentDigest,doc,{start:2,end:5})).not.toBe(d);
  expect(excerptDigest(documentDigest,{messages:messages.map((m,i)=>i===3?{...m,text:'changed'}:m),provenance},{start:2,end:4})).not.toBe(d);
  // 区间之外的消息不影响摘录校验值：整文校验值另行绑定
  expect(excerptDigest(documentDigest,{messages:messages.map((m,i)=>i===7?{...m,text:'changed'}:m),provenance},{start:2,end:4})).toBe(d);
  expect(d).not.toBe(documentDigest);
 });
 it('accepts a reference that matches the authoritative document',()=>{
  expect(verifyExcerpt(doc,documentDigest,ref({start:2,end:4}))).toBe(true);
 });
 it.each([
  ['a forged digest',{digest:'c'.repeat(64)}],
  ['an unknown version',{version:'history-excerpt-v2'}],
  ['a wrong total',{total:9}],
  ['a range past the end',{start:2,end:9}],
  ['an empty range',{start:3,end:3}],
  ['a negative start',{start:-1}],
  ['a fractional end',{end:3.5}],
  ['a range covering the whole document',{start:0,end:8}],
 ])('rejects %s',(_label,patch)=>{
  expect(verifyExcerpt(doc,documentDigest,{...ref({start:2,end:4}),...patch} as never)).toBe(false);
 });
 it('rejects when the document changed after the reference was made',()=>{
  const changed={messages:messages.map((m,i)=>i===2?{...m,text:'edited'}:m),provenance};
  expect(verifyExcerpt(changed,documentDigest,ref({start:2,end:4}))).toBe(false);
  expect(verifyExcerpt(doc,'d'.repeat(64),ref({start:2,end:4}))).toBe(false);
 });
});

describe('excerpt reference and slice verification (what Main can check without the full document)',()=>{
 const documentDigest='a'.repeat(64),messages=Array.from({length:8},(_,i)=>msg(i)),provenance=messages.map((_,i)=>({originalId:'o'+i})),doc={messages,provenance};
 it('builds a reference that verifies against both the full document and only the quoted slice',()=>{
  const r=excerptRef(documentDigest,doc,{start:2,end:5});
  expect(r).toEqual({version:HISTORY_EXCERPT_VERSION,start:2,end:5,total:8,digest:excerptDigest(documentDigest,doc,{start:2,end:5})});
  expect(verifyExcerpt(doc,documentDigest,r)).toBe(true);
  expect(verifyExcerptSlice(sliceExcerpt(doc,{start:2,end:5}),documentDigest,r)).toBe(true);
 });
 it('the slice check rejects swapped, shifted or edited quotes and a forged document digest',()=>{
  const r=excerptRef(documentDigest,doc,{start:2,end:5}),slice=sliceExcerpt(doc,{start:2,end:5});
  expect(verifyExcerptSlice(sliceExcerpt(doc,{start:3,end:6}),documentDigest,r)).toBe(false);
  expect(verifyExcerptSlice({...slice,messages:slice.messages.map((m,i)=>i===1?{...m,text:'edited'}:m)},documentDigest,r)).toBe(false);
  expect(verifyExcerptSlice({...slice,messages:slice.messages.slice(0,2)},documentDigest,r)).toBe(false);
  expect(verifyExcerptSlice(slice,'b'.repeat(64),r)).toBe(false);
  expect(verifyExcerptSlice({...slice,provenance:slice.provenance!.slice(1)},documentDigest,r)).toBe(false);
  expect(verifyExcerptSlice(slice,documentDigest,{...r,start:1,end:4})).toBe(false);
  expect(verifyExcerptSlice(slice,documentDigest,{...r,total:9})).toBe(false);
  expect(verifyExcerptSlice(slice,documentDigest,{...r,version:'history-excerpt-v2'} as never)).toBe(false);
 });
 it('a slice that carries provenance cannot be verified against a reference made without it (and vice versa)',()=>{
  const r=excerptRef(documentDigest,{messages},{start:2,end:5});
  expect(verifyExcerptSlice(sliceExcerpt(doc,{start:2,end:5}),documentDigest,r)).toBe(false);
 });
});

describe('excerptToolSafe: the last guard on a sliced range',()=>{
 const call=(i:number,ids:string[])=>msg(i,{role:'assistant',toolCallIds:ids,toolCalls:ids.map(id=>({id,name:'n',arguments:'{}'}))});
 const result=(i:number,id:string)=>msg(i,{role:'tool',toolCallId:id,name:'n'});
 const m=[msg(0),call(1,['a','b']),result(2,'a'),result(3,'b'),msg(4,{role:'assistant'}),msg(5)];
 it('accepts ranges that hold whole groups or none',()=>{
  expect(excerptToolSafe(m,{start:0,end:4})).toBe(true);expect(excerptToolSafe(m,{start:1,end:4})).toBe(true);expect(excerptToolSafe(m,{start:4,end:6})).toBe(true);
 });
 it('refuses a result without its call, a call without all its results, and a range that is not inside the document',()=>{
  expect(excerptToolSafe(m,{start:2,end:5})).toBe(false);expect(excerptToolSafe(m,{start:3,end:5})).toBe(false);
  expect(excerptToolSafe(m,{start:0,end:3})).toBe(false);expect(excerptToolSafe(m,{start:1,end:3})).toBe(false);
  expect(excerptToolSafe(m,{start:4,end:99})).toBe(false);expect(excerptToolSafe(m,{start:3,end:3})).toBe(false);expect(excerptToolSafe(m,{start:-1,end:2})).toBe(false);
 });
});
