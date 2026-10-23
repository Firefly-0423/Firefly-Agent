import {expect,it} from 'vitest';
import {execFile} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const modelRoot=process.env.FF_SMH_MODELS_ROOT,evidence=process.env.FF_SMH_MODEL_EVIDENCE;
if(!modelRoot||!evidence||![modelRoot,evidence].every(p=>path.isAbsolute(p)&&/^E:[\\/]/i.test(p)))throw Error('SMH_EXPLICIT_E_MODEL_ROOT_REQUIRED');
// Transformers.js uses the production Node dynamic-import host, which Vitest's VM does not provide.
const driver=String.raw`
const path=require('node:path'),fs=require('node:fs');
const base=path.join(process.cwd(),'dist','main','main','rag');
const {createLocalEmbeddingProvider}=require(path.join(base,'embedding.js'));
const {createStandardReranker}=require(path.join(base,'reranker.js'));
globalThis.fetch=()=>{throw Error('MODEL_REMOTE_FETCH_FORBIDDEN')};
(async()=>{
 const embedding=createLocalEmbeddingProvider('bgem3');if(!embedding)throw Error('PINNED_MODEL_MISSING');
 const reranker=await createStandardReranker();
 const docs=['我喜欢下午喝一杯少糖的拿铁。','我工作日乘地铁去公司。','我们的测试脚本使用 TypeScript 编写。'];
 const queries=['我偏好的饮品是什么？','我用什么交通方式上班？'],vectors=await embedding.embedBatch(docs),results=[];
 for(const [i,query] of queries.entries()){
  const vector=await embedding.embed(query),ranking=docs.map((text,n)=>({text,score:vector.reduce((s,x,k)=>s+x*vectors[n][k],0)})).sort((a,b)=>b.score-a.score);
  const reranked=await reranker.rerank(query,ranking.map(r=>r.text));
  if(ranking[0].text!==docs[i]||reranked[0].text!==docs[i]||!(reranked[0].score>reranked[1].score))throw Error('SYNTHETIC_CHINESE_QUALITY_FAILED');
  results.push({query,vectorRanking:ranking,reranked});
 }
 fs.writeFileSync(process.env.FF_SMH_MODEL_EVIDENCE,JSON.stringify({embedding:embedding.cacheIdentity,reranker:reranker.name,networkFetch:'forbidden',results},null,2));process.exit(0);
})().catch(error=>{console.error(error.message);process.exit(1)});
`;
it('compiled product adapters retrieve Chinese paraphrases and rerank actual candidates with pinned local weights',async()=>{
 await new Promise<void>((resolve,reject)=>execFile(process.execPath,['-e',driver],{cwd:process.cwd(),env:{...process.env,FIREFLY_MODELS_DIR:modelRoot},timeout:300000,maxBuffer:1024*1024},(error,_stdout,stderr)=>error?reject(Error(stderr||error.message)):resolve()));
 const result=JSON.parse(fs.readFileSync(evidence!,'utf8'));expect(result.results).toHaveLength(2);expect(result.embedding.model).toContain('cls');expect(result.reranker).toContain('text-pair-sigmoid');
},310000);
