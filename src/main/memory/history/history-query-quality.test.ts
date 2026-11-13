import {it,expect} from 'vitest';
import {createHistoryTokenizer,rankHistory} from './history-ranking';
import {historyTimeSpan} from './history-temporal';
const doc=(id:string,text:string,start:number|null=null,end=start)=>({id,text,timeSpan:start===null?null:{start,end}});
const ids=(result:ReturnType<typeof rankHistory>)=>result.items.map(item=>item.id);
it('normalizes fullwidth identifier spelling only in the search index',()=>{
 const t=createHistoryTokenizer();expect(t.tokens('ＡＢＣ')).toContain('abc');
});
it('retrieves separated identifier words from camel-case spelling without synonym data',()=>{
 expect(ids(rankHistory([doc('a','silver notes'),doc('b','SilverPine port')],'silver pine'))[0]).toBe('b');
});
it('keeps a genuine paraphrase outside BM25 capability rather than manufacturing semantic hits',()=>{
 expect(rankHistory([doc('a','offline cached files')],'without network').items).toEqual([]);
});
it('changes known-time order only when the caller explicitly requests latest',()=>{
 const docs=[doc('a','harbor port harbor port harbor port',1000),doc('b','harbor port new',2000),doc('c','port',3000)];
 expect(ids(rankHistory(docs,'harbor port'))[0]).toBe('a');
 const latest=rankHistory(docs,'harbor port',{temporal:{kind:'latest'}} as any);
 expect(ids(latest)[0]).toBe('b');expect(ids(latest).indexOf('c')).toBeGreaterThan(ids(latest).indexOf('a'));
 expect((latest as any).temporal).toMatchObject({kind:'latest',status:'applied'});
});
it('latest can select a newer matching candidate beyond the requested result limit',()=>{
 const docs=[doc('a','harbor port harbor port harbor port',1000),doc('b','harbor port new',2000)];
 expect(ids(rankHistory(docs,'harbor port',{limit:1,temporal:{kind:'latest'}} as any))).toEqual(['b']);
});
it('recency does not reorder records matching different query terms',()=>{
 const docs=[doc('a','harbor harbor harbor',1000),doc('b','port',2000),doc('n','port port port port',9000)];
 expect(ids(rankHistory(docs,'harbor port'))[0]).toBe('a');
 expect(ids(rankHistory(docs,'harbor port',{temporal:{kind:'latest'}} as any))[0]).toBe('a');
});
it('unknown original times remain unproved even if the text asserts a future date',()=>{
 const docs=[doc('a','harbor port OLD'),doc('b','harbor port UPDATED 2099-12-31')],normal=rankHistory(docs,'harbor port');
 const latest=rankHistory(docs,'harbor port',{temporal:{kind:'latest'}} as any);
 expect(ids(latest)).toEqual(ids(normal));expect((latest as any).temporal).toMatchObject({status:'unavailable',unknownDocuments:2});
});
it('an explicit historical window uses original span overlap and excludes unknown-time records',()=>{
 const docs=[doc('a','harbor port',1000,1200),doc('b','harbor port revised',2000,2200),doc('t','harbor port tool result',1400,1800),doc('u','harbor port 1500')];
 const r=rankHistory(docs,'harbor port',{temporal:{kind:'range',from:1500,to:1700}} as any);
 expect(ids(r)).toEqual(['t']);expect((r as any).temporal).toMatchObject({kind:'range',status:'partial',unknownDocuments:1});
});
it('word-order differences are not discarded as lexical duplicates',()=>{
 expect(ids(rankHistory([doc('a','door north opens door south'),doc('b','door south opens door north')],'door'))).toEqual(['a','b']);
});
it('exact lexical duplicates at a different known event time preserve distinct history',()=>{
 const docs=[{...doc('a','harbor port',1000),exactIdentity:'same-source'},{...doc('b','harbor port',1000),exactIdentity:'same-source'},doc('c','harbor port',2000)];
 expect(ids(rankHistory(docs,'harbor port'))).toEqual(['a','c']);
});
it.each([{kind:'range',from:2,to:1},{kind:'latest',actorKey:'other'},{kind:'range',from:NaN,to:3},{kind:'unknown'}])('rejects malformed temporal request %j',temporal=>{
 expect(()=>rankHistory([doc('a','harbor port')],'harbor port',{temporal} as any)).toThrow('MEMORY_HISTORY_INPUT_INVALID');
});
it('does not silently change a vector query into a lexical temporal query',()=>{
 expect(()=>rankHistory([{...doc('a','harbor port',1000),vector:[1,0]}],'harbor port',{queryVector:[1,0],temporal:{kind:'latest'}} as any)).toThrow('MEMORY_HISTORY_TEMPORAL_VECTOR_UNSUPPORTED');
});

it('a missing original time makes the complete turn unproved without text-date inference',()=>{
 expect(historyTimeSpan([{occurredAt:2000},{occurredAt:null}])).toBeNull();
 expect(historyTimeSpan([{occurredAt:3000},{occurredAt:1000}])).toEqual({start:1000,end:3000});
});
it('compatibility folding is nonexpanding at the accepted document length bound',()=>{
 const t=createHistoryTokenizer();expect(()=>t.tokens('Ａ'.repeat(65536))).not.toThrow();
 t.register(['ＦＯＯ']);expect(t.tokens('ＦＯＯ')).toEqual(['foo']);
 expect(()=>t.tokens('A'.repeat(65536+128))).toThrow('MEMORY_HISTORY_INPUT_INVALID');
});

it.each([
 ['ABC',['abc']],
 ['XMLHttpRequest',['xmlhttprequest','xml','http','request']],
 ['HTTPServerURL',['httpserverurl','http','server','url']],
 ['ABcDEf',['abcdef','a','bc','d','ef']],
 ['ABcDeFGhIj',['abcdefghij','a','bc','de','f','gh','ij']],
 ['v2HTTPServer99URL',['v2httpserver99url','v2','http','server99','url']],
 ['FooBarFooBar',['foobarfoobar','foo','bar','foo','bar']],
 ['XMLHttpRequest XMLHttpRequest',['xmlhttprequest','xml','http','request','xmlhttprequest','xml','http','request']],
] as const)('preserves acronym, numeric and consecutive camel boundaries for %s',(text,expected)=>{
 expect(createHistoryTokenizer().tokens(text)).toEqual(expected);
});
it('keeps a full-length all-uppercase identifier as one unexpanded token',()=>{
 expect(createHistoryTokenizer().tokens('A'.repeat(65536))).toEqual(['a'.repeat(65536)]);
});

it('sign punctuation cannot collapse contradictory numeric records as duplicates',()=>{
 expect(ids(rankHistory([doc('a','gain -1',1000),doc('b','gain +1',1000)],'gain'))).toEqual(['a','b']);
});

it('missing complete evidence identity cannot infer equivalence from repeated text',()=>{
 expect(ids(rankHistory([doc('a','harbor port',1000),doc('b','harbor port',1000)],'harbor port'))).toEqual(['a','b']);
});
it('a supplied full-evidence key cannot collide with fallback candidate identity',()=>{
 expect(ids(rankHistory([{...doc('a','harbor port'),exactIdentity:'b'},doc('b','harbor port')],'harbor port'))).toEqual(['a','b']);
});
