import {it,expect} from 'vitest';
import {createHistoryTokenizer,rankHistory,normalizeVector} from './history-ranking';
import {toWindows} from './history-windows';
const doc=(id:string,text:string,vector?:number[])=>({id,text,...(vector?{vector}:{})});
it('isolated Jieba tokenizes Chinese, English, mixed Unicode and punctuation deterministically',()=>{
 const t=createHistoryTokenizer();expect(t.tokens('Hello Firefly 2026')).toEqual(['hello','firefly','2026']);
 expect(t.tokens('萤火虫喜欢 TypeScript')).toContain('typescript');expect(t.tokens(' !!! ，。')).toEqual([]);
 expect(t.tokens('中文😀hello')).toEqual(t.tokens('中文😀hello'));expect(t.tokens('')).toEqual([]);
});
it('custom dictionary identity changes locally without altering another actor tokenizer',()=>{
 const a=createHistoryTokenizer(),b=createHistoryTokenizer(),old=a.version,before=b.tokens('甲乙丙丁测试名字');
 a.register(['甲乙丙丁测试名字']);expect(a.version).not.toBe(old);expect(a.tokens('甲乙丙丁测试名字')).toContain('甲乙丙丁测试名字');
 expect(b.tokens('甲乙丙丁测试名字')).toEqual(before);expect(b.version).toBe(old);
});
it('independent route ranks feed equal RRF instead of raw BM25/vector score interpolation',()=>{
 const r=rankHistory([doc('a','cat cat cat',[1,0]),doc('b','cat',[0,1]),doc('c','other',[1,0])],'cat',{queryVector:[1,0]});
 expect(r.routeRanks.lexical.map(x=>x.id)).toEqual(['a','b']);expect(r.routeRanks.vector.map(x=>x.id)).toEqual(['a','c','b']);
 expect(r.fused.find(x=>x.id==='a')?.score).toBeCloseTo(2/61);expect(r.fused.find(x=>x.id==='c')?.score).toBeCloseTo(1/62);
 expect(r.diversity).toBe('vector-mmr');
});
it('vector MMR diversifies redundant hits after RRF',()=>{
 const r=rankHistory([doc('a','cat',[1,0]),doc('b','cat',[1,0]),doc('c','cat',[0,1])],'cat',{queryVector:[1,0],mmrLambda:0.1});
 expect(r.items.map(x=>x.id).slice(0,2)).toEqual(['a','c']);
});
it('BM25-only explicitly uses lexical duplicate filtering, not vector MMR',()=>{
 const r=rankHistory([{...doc('a','cat dog'),exactIdentity:'same-source'},{...doc('b','cat dog'),exactIdentity:'same-source'},doc('c','cat fish')],'cat');
 expect(r.diversity).toBe('lexical-dedup');expect(r.routeRanks.vector).toEqual([]);expect(r.items.map(x=>x.id)).toEqual(['a','c']);
});
it('unmatched documents are never promoted by an empty lexical query',()=>{
 expect(rankHistory([doc('a','hello')],'!!!').items).toEqual([]);expect(rankHistory([doc('a','hello')],'absent').items).toEqual([]);
});
it('bounded routes and results have deterministic ties independent of ingestion order',()=>{
 const docs=Array.from({length:70},(_,i)=>doc(String(i).padStart(3,'0'),'cat '+i));
 const a=rankHistory(docs,'cat'),b=rankHistory(docs.reverse(),'cat');expect(a.items).toEqual(b.items);
 expect(a.items).toHaveLength(8);expect(a.routeRanks.lexical).toHaveLength(50);expect(a.version).toBe('history-ranking-v4');
});
it.each([[0,0],[NaN,1],[Infinity,1],[],[1]])('invalid vector %j fails closed',v=>{
 expect(()=>normalizeVector(v,2)).toThrow('MEMORY_HISTORY_VECTOR_INVALID');
});
it('dimension mismatch and partial vectors do not silently change retrieval mode',()=>{
 expect(()=>rankHistory([doc('a','cat',[1])],'cat',{queryVector:[1,0]})).toThrow('MEMORY_HISTORY_VECTOR_INVALID');
 expect(()=>rankHistory([doc('a','cat',[1,0]),doc('b','cat')],'cat',{queryVector:[1,0]})).toThrow('MEMORY_HISTORY_VECTOR_INVALID');
});
it('query cancellation and invalid ranking settings fail before ranking',()=>{
 const abort=new AbortController();abort.abort();expect(()=>rankHistory([doc('a','cat')],'cat',{signal:abort.signal})).toThrow('MEMORY_HISTORY_CANCELLED');
 expect(()=>rankHistory([], '',{limit:9})).toThrow('MEMORY_HISTORY_INPUT_INVALID');
});

const DAY=86_400_000,NOW=Date.UTC(2026,9,13,4);
const at=(daysAgo:number)=>({start:NOW-daysAgo*DAY,end:NOW-daysAgo*DAY});
it('windowed lexical units find a short passage buried in a long document, and results stay one per document',()=>{
 const turns=[...Array.from({length:80},(_,i)=>'闲聊填充内容第'+i+'段'),'我的护照快要过期',...Array.from({length:80},(_,i)=>'继续闲聊第'+i+'段')].map(text=>({text}));
 const long={id:'long',text:turns.map(t=>t.text).join('\n')},short={id:'short',text:'护照办理流程说明'};
 const query='护照过期';
 const whole=rankHistory([long,short],query).routeRanks.lexical.find(x=>x.id==='long')!.score;
 const windowed=rankHistory([{...long,units:toWindows(turns,2)!},short],query);
 // 窗口化去掉了篇幅稀释：同一个文档的词法得分更高，并且排到了只含一个查询词的短文档前面
 expect(windowed.routeRanks.lexical.find(x=>x.id==='long')!.score).toBeGreaterThan(whole*2);
 expect(windowed.items[0].id).toBe('long');
 expect(new Set(windowed.items.map(x=>x.id)).size).toBe(windowed.items.length);
 expect(windowed.units).toBeGreaterThan(2);
});
it('reports which window scored best, and only for documents that were ranked over windows',()=>{
 const turns=[...Array.from({length:6},(_,i)=>'闲聊填充内容第'+i+'段'),'我的护照快要过期',...Array.from({length:5},(_,i)=>'继续闲聊第'+i+'段')].map(text=>({text}));
 const windows=toWindows(turns,2)!,expected=Math.floor(6/2);
 const r=rankHistory([{id:'long',text:turns.map(t=>t.text).join('\n'),units:windows},doc('short','护照办理流程说明')],'护照过期');
 expect(r.items.find(x=>x.id==='long')!.unit).toBe(expected);
 expect(windows[expected].text).toContain('护照快要过期');
 expect(r.items.find(x=>x.id==='short')).not.toHaveProperty('unit');
 expect(r.routeRanks.lexical.find(x=>x.id==='long')!.unit).toBe(expected);
});
it('keeps the best window attached after recency and vector fusion',()=>{
 const v=[1,0],turns=Array.from({length:8},(_,i)=>({text:i===5?'唯一的护照信息':'闲聊第'+i+'段'}));
 const d={id:'a',text:turns.map(t=>t.text).join('\n'),units:toWindows(turns,2)!,vector:v,timeSpan:at(1)};
 const r=rankHistory([d,{...doc('b','无关内容',v),timeSpan:at(2)}],'护照',{queryVector:v,recency:{alpha:.1,halfLifeDays:30,now:NOW}});
 expect(r.items.find(x=>x.id==='a')!.unit).toBe(2);
});
it('without units a document is one ranking unit exactly as before',()=>{
 const r=rankHistory([doc('a','cat dog'),doc('b','cat')],'cat');expect(r.units).toBe(2);
});
it('recency lets the newer of two equally relevant documents win, only on the hybrid path',()=>{
 const v=[1,0],older={...doc('a-old','cat',v),timeSpan:at(40)},newer={...doc('b-new','cat',v),timeSpan:at(1)};
 const recency={alpha:.1,halfLifeDays:30,now:NOW};
 expect(rankHistory([older,newer],'cat',{queryVector:v}).items[0].id).toBe('a-old');
 expect(rankHistory([older,newer],'cat',{queryVector:v,recency}).items[0].id).toBe('b-new');
 // 纯词法：评测显示加新近度会让整体变差，所以没有向量路线时不生效
 expect(rankHistory([older,newer],'cat',{recency}).items.map(x=>x.id)).toEqual(['a-old','b-new']);
});
it('recency is off for alpha 0, never boosts a document without a time, and is bounded so a one-route match cannot overtake a two-route match',()=>{
 const v=[1,0],NOT_NOW={alpha:0,halfLifeDays:30,now:NOW};
 const older={...doc('a-old','cat',v),timeSpan:at(40)},newer={...doc('b-new','cat',v),timeSpan:at(1)};
 expect(rankHistory([older,newer],'cat',{queryVector:v,recency:NOT_NOW}).items[0].id).toBe('a-old');
 const undated=doc('a-undated','cat',v);
 expect(rankHistory([undated,newer],'cat',{queryVector:v,recency:{alpha:.1,halfLifeDays:30,now:NOW}}).items[0].id).toBe('b-new');
 // 只在向量路线命中的新文档，分数约为两条路线都命中的旧文档的一半，10% 的加权越不过去。
 const strong={...doc('z-strong','cat',[1,0]),timeSpan:at(400)},weak={...doc('a-weak','dog',[0,1]),timeSpan:at(0)};
 expect(rankHistory([strong,weak],'cat',{queryVector:[1,0],recency:{alpha:.1,halfLifeDays:30,now:NOW}}).items[0].id).toBe('z-strong');
});
it.each([[{alpha:-1,halfLifeDays:30,now:NOW}],[{alpha:2,halfLifeDays:30,now:NOW}],[{alpha:.1,halfLifeDays:0,now:NOW}],[{alpha:.1,halfLifeDays:30,now:NaN}]])('invalid recency %j fails closed',recency=>{
 expect(()=>rankHistory([doc('a','cat',[1,0])],'cat',{queryVector:[1,0],recency})).toThrow('MEMORY_HISTORY_INPUT_INVALID');
});
