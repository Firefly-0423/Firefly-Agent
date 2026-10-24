import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {rankHistory} from '../../../src/main/memory-history/history-ranking';
import {scoreHits} from './quality-metrics';
const root=process.cwd(),out=path.join(root,'output/memory-h-quality');
assert.ok(root.toLowerCase().startsWith('e:\\codex\\2026-10-01\\task\\'),'owned E: workspace required');
const manifest=JSON.parse(fs.readFileSync(path.join(out,'manifest.json'),'utf8'));
for(const [name,hash] of Object.entries(manifest.files))assert.equal(createHash('sha256').update(fs.readFileSync(path.join(out,name))).digest('hex'),hash,'frozen corpus hash');
const load=(name:string)=>JSON.parse(fs.readFileSync(path.join(out,name+'.json'),'utf8')).cases as Array<{id:string;family:string;query:string;documents:Array<{id:string;text:string;grade:number;group:string}>;conflictGroups:string[]}>;
const dev=load('development'),holdout=load('holdout');
const devText=new Set(dev.flatMap(c=>[c.query,...c.documents.map(d=>d.text)]));
assert.ok(holdout.every(c=>!devText.has(c.query)&&c.documents.every(d=>!devText.has(d.text))),'split text leakage');
// Hand-computed metric oracles, before corpus results are observed.
const judged=[{id:'a',grade:3,group:'one'},{id:'b',grade:3,group:'one'},{id:'c',grade:1,group:'two'},{id:'d',grade:0,group:'wrong'}];
assert.deepEqual(scoreHits(judged,['a','c'],3),{recall:1,ndcg:1,duplicateRate:0,top1Grade:3});
const repeated=scoreHits(judged,['a','b','c'],3);assert.equal(repeated.recall,1);assert.equal(repeated.duplicateRate,1/3);assert.ok(Math.abs(repeated.ndcg-(7+.5)/(7+1/Math.log2(3)))<1e-12);
assert.equal(scoreHits(judged,['d'],1).ndcg,0);assert.equal(scoreHits(judged,[],8).recall,0);assert.throws(()=>scoreHits(judged,['missing'],1));assert.throws(()=>scoreHits(judged,['a','a'],1));
function run(cases:typeof dev){return cases.map(c=>{
 const input=c.documents.map(d=>({id:d.id,text:d.text}));
 assert.ok(input.every(d=>Object.keys(d).join(',')==='id,text'),'qrels passed to retriever');
 const r=rankHistory(input,c.query),ids=r.items.map(d=>d.id);
 assert.deepEqual(ids,rankHistory([...input].reverse(),c.query).items.map(d=>d.id),'order instability');
 return {id:c.id,family:c.family,query:c.query,hits:ids,route:r.diversity,tokenizer:r.tokenizerVersion,metrics:Object.fromEntries([1,3,8].map(k=>[k,scoreHits(c.documents,ids,k)])),conflictAt3:ids.slice(0,3).some(id=>c.conflictGroups.includes(c.documents.find(d=>d.id===id)!.group))};
})}
const development=run(dev),evaluation=run(holdout);
function aggregate(rows:typeof evaluation){return {cases:rows.length,metrics:Object.fromEntries([1,3,8].map(k=>[k,Object.fromEntries(['recall','ndcg','duplicateRate'].map(metric=>[metric,rows.reduce((sum,r)=>sum+(r.metrics[k] as any)[metric],0)/rows.length]))])),answerTop1:rows.filter(r=>r.metrics[1].top1Grade===3).length,conflictAt3:rows.filter(r=>r.conflictAt3).length}}
const result={version:'history-quality-result-v1',manifest,metricOracles:'6 passed',development:aggregate(development),holdout:aggregate(evaluation),families:Object.fromEntries([...new Set(evaluation.map(r=>r.family))].map(f=>[f,aggregate(evaluation.filter(r=>r.family===f))])),cases:{development,holdout:evaluation},limitations:['synthetic single-author labels, 32 case-local small corpora','no tuning; same-author disjoint holdout, not independent human annotation','BM25 default only; no semantic embedding or answer-generation quality claim','eventTime metadata not supplied to rankHistory; temporal cases test text retrieval only','safety is evaluated separately through real Main/worker probes']};
fs.writeFileSync(path.join(out,'offline-results.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({development:result.development,holdout:result.holdout,families:result.families},null,2));
