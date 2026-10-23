/** Frozen before/after evaluation; labels are scoring-only, never ranking inputs. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {openMemoryRepository} from '../../../src/main/memory-core/repository';
import {DEFAULT_HISTORY_SETTINGS} from '../../../src/main/memory-history/history-contracts';
import {scoreHits} from './quality-metrics';
const workspace=process.cwd(),temp=process.env.TEMP??'',out=path.join(workspace,'output/memory-h-quality-next');
assert.ok(workspace.toLowerCase().startsWith('e:\\codex\\2026-10-01\\task\\'));assert.ok(temp.toLowerCase().startsWith('e:\\codex\\2026-10-01\\task'));
const hash=(file:string)=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const freeze=JSON.parse(fs.readFileSync(path.join(out,'candidate-freeze.json'),'utf8'));
const manifest=JSON.parse(fs.readFileSync(path.join(out,'manifest.json'),'utf8'));
assert.equal(hash(path.join(out,'manifest.json')),freeze.challengeManifestSha256);
for(const [file,sha] of Object.entries(manifest.files))assert.equal(hash(path.join(out,file)),sha);
assert.equal(hash(path.join(out,'baseline-repository.cjs')),freeze.baselineBundleSha256);
const baseline=require(path.join(out,'baseline-repository.cjs')).openMemoryRepository as typeof openMemoryRepository;
const candidateHead=execFileSync('git',['rev-parse','HEAD'],{cwd:workspace,encoding:'utf8'}).trim();
const challenge=JSON.parse(fs.readFileSync(path.join(out,'challenge.json'),'utf8'));
const legacyRoot=path.join(workspace,'output/memory-h-quality'),legacyManifest=JSON.parse(fs.readFileSync(path.join(legacyRoot,'manifest.json'),'utf8'));
assert.equal(hash(path.join(legacyRoot,'holdout.json')),legacyManifest.files['holdout.json']);
const legacy=JSON.parse(fs.readFileSync(path.join(legacyRoot,'holdout.json'),'utf8')).cases;
function legacyMessages(text:string){const lines=text.split('\n');return lines.length===3&&lines[0].startsWith('user: ')&&lines[1].startsWith('assistant: ')&&lines[2].startsWith('tool: ')?lines.map((line,i)=>({id:'m'+i,role:['user','assistant','tool'][i],text:line.slice(line.indexOf(': ')+2),occurredAt:null,timeZone:null,...(i===1?{toolCallIds:['synthetic-call']}:{}),...(i===2?{toolCallId:'synthetic-call'}:{})})):[{id:'m0',role:'user',text,occurredAt:null,timeZone:null}]}
const inputs=[{name:'challenge',rows:challenge.cases.map((c:any)=>({...c,judgments:c.qrels.map((j:any)=>({id:j.documentId,grade:j.grade,group:j.equivalenceGroup}))}))},{name:'legacy-regression',rows:legacy.map((c:any)=>({...c,documents:c.documents.map((d:any)=>({...d,messages:legacyMessages(d.text)})),judgments:c.documents.map((d:any)=>({id:d.id,grade:d.grade,group:d.group}))}))}];
const corrective=process.argv.includes('--corrective');
const reportFile=path.join(out,corrective?'comparison-corrective.json':'comparison.json');
assert.ok(!fs.existsSync(reportFile),'Evaluation output exists; preserve it, choose a fresh output variant');
const key=Buffer.alloc(32,17); // Public synthetic deterministic fixture key.
const runs:any={};
function aggregate(rows:any[]){return {cases:rows.length,metrics:Object.fromEntries([1,3,8].map(k=>[k,Object.fromEntries(['recall','ndcg','duplicateRate'].map(m=>[m,rows.reduce((sum,r)=>sum+r.metrics[k][m],0)/rows.length]))])),answerTop1:rows.filter(r=>r.metrics[1].top1Grade===3).length,conflictAt3:rows.filter(r=>r.conflictAt3).length}}
for(const suite of inputs){const variants:any={};for(const [variant,open] of [['before',baseline],['after',openMemoryRepository]] as const){const results:any[]=[];
 for(const c of suite.rows){const root=fs.mkdtempSync(path.join(os.tmpdir(),'h-quality-next-'));assert.ok(root.toLowerCase().startsWith(temp.toLowerCase()+path.sep));const repo=open({databasePath:path.join(root,'memory.sqlite'),key});
 const command=(kind:string,body:object,mutation=false)=>repo.historyCommand({kind,scopeKey:'synthetic-quality',...(mutation?{commandId:randomUUID()}:{}),body:{actorKey:'actor-quality',providerId:'synthetic',sessionId:'quality-session',...body}}) as any;
 try{const rejected:any[]=[];for(const d of c.documents){try{command('put',{generation:0,document:{id:d.id,incarnation:'v1',revision:1,origin:'synthetic-import',sourceDeps:[],messages:d.messages,vector:null}},true)}catch(error){if(error instanceof Error&&error.message==='MEMORY_HISTORY_SECRET')rejected.push({documentId:d.id,code:error.message});else throw error}}
 const query=()=>command('query',{sessions:[{providerId:'synthetic',sessionId:'quality-session'}],query:c.query,settings:DEFAULT_HISTORY_SETTINGS,...(variant==='after'&&c.temporal?{temporal:c.temporal}:{})});
 const result=query(),ids=result.hits.map((h:any)=>h.document.id);assert.equal(result.status,'ok');assert.deepEqual(ids,query().hits.map((h:any)=>h.document.id));
 for(const h of result.hits)assert.equal(h.document.messages.length,c.documents.find((d:any)=>d.id===h.document.id).messages.length);
 results.push({id:c.id,family:c.family,hits:ids,status:result.status,temporalRequested:c.temporal??null,temporalImplemented:variant==='after',temporalResult:result.temporal??null,rejected,metrics:Object.fromEntries([1,3,8].map(k=>[k,scoreHits(c.judgments,ids,k)])),conflictAt3:ids.slice(0,3).some((id:string)=>c.conflictGroups.includes(c.judgments.find((d:any)=>d.id===id)!.group))});
 }finally{repo.close();fs.rmSync(root,{recursive:true,force:true})}}
 variants[variant]={aggregate:aggregate(results),families:Object.fromEntries([...new Set(results.map(r=>r.family))].map(f=>[f,aggregate(results.filter(r=>r.family===f))])),cases:results}}
 const improvements=[],regressions=[];for(let i=0;i<variants.after.cases.length;i++){const a=variants.after.cases[i],b=variants.before.cases[i],delta=a.metrics[3].ndcg-b.metrics[3].ndcg;if(delta>0)improvements.push({id:a.id,delta});if(delta<0)regressions.push({id:a.id,delta})}runs[suite.name]={...variants,improvements,regressions,answerFailures:variants.after.cases.filter((r:any)=>r.metrics[1].top1Grade!==3).map((r:any)=>({id:r.id,family:r.family,hits:r.hits,top1Grade:r.metrics[1].top1Grade,temporalResult:r.temporalResult}))};}
key.fill(0);
const report={version:'history-quality-next-v1',evaluationStage:corrective?'seen-set corrective recheck':'first frozen-candidate scoring',untouchedCandidate:!corrective&&candidateHead===freeze.candidateHead,freeze,candidateHead,challengeManifest:manifest,legacyManifest,runs,limitations:['36 independently authored synthetic retrieval cases, single author; not human multi-rater or production acceptance','6 Main safety scenarios executed separately, not added to retrieval metric denominator','first candidate frozen before implementer read cases; later independently reproduced attribution correction is a seen-set recheck; no label-driven tuning','baseline omits explicit temporal option because v1 rejects it; historical baseline relevance shown, no emulated temporal fix','earlier 32 are seen regression/diagnostic cases only','actual repository/parser/index/ranking/excerpts in-process, fixed public synthetic key; no real user data or semantic vectors','top1 is manually judged answer-bearing retrieval, not answer generation accuracy','unknown/mixed original turn times are unproved; query text does not generate time','dedup uses repository-derived complete original message/source/transcript identity; unsourced imports and missing identity retain distinct candidates; near-equivalent redundancy remains']};
fs.writeFileSync(reportFile,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(Object.fromEntries(Object.entries(runs).map(([n,r]:[string,any])=>[n,{before:r.before.aggregate,after:r.after.aggregate,improvements:r.improvements,regressions:r.regressions,failures:r.answerFailures}])),null,2));
