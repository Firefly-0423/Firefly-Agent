/** Same frozen qrels through the actual SQLite H parser/index/ranker/excerpt path. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {openMemoryRepository} from '../../../src/main/memory-core/repository';
import {DEFAULT_HISTORY_SETTINGS} from '../../../src/main/memory-history/history-contracts';
import {scoreHits} from './quality-metrics';
const workspace=process.cwd(),temp=process.env.TEMP??'',out=path.join(workspace,'output/memory-h-quality');
assert.ok(workspace.toLowerCase().startsWith('e:\\codex\\2026-10-01\\task\\'));
assert.ok(temp.toLowerCase().startsWith('e:\\codex\\2026-10-01\\task'));
const manifest=JSON.parse(fs.readFileSync(path.join(out,'manifest.json'),'utf8'));
for(const [name,hash] of Object.entries(manifest.files))assert.equal(createHash('sha256').update(fs.readFileSync(path.join(out,name))).digest('hex'),hash);
const rows=JSON.parse(fs.readFileSync(path.join(out,'holdout.json'),'utf8')).cases as Array<{id:string;family:string;query:string;documents:Array<{id:string;text:string;grade:number;group:string}>;conflictGroups:string[]}>;
const key=Buffer.alloc(32,17); // Public synthetic test key only; deterministic index-ID ties.
interface CaseResult {id:string;family:string;hits:string[];status:string;rejected:Array<{documentId:string;code:string}>;metrics:Record<number,ReturnType<typeof scoreHits>>;conflictAt3:boolean}
const results:CaseResult[]=[];
for(const c of rows){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'h-quality-repo-'));assert.ok(root.toLowerCase().startsWith(temp.toLowerCase()+path.sep));const repo=openMemoryRepository({databasePath:path.join(root,'memory.sqlite'),key});
 const command=(kind:string,body:object,mutation=false)=>repo.historyCommand({kind,scopeKey:'synthetic-quality',...(mutation?{commandId:randomUUID()}:{}),body:{actorKey:'actor-quality',providerId:'synthetic',sessionId:'quality-session',...body}}) as any;
 const rejected:Array<{documentId:string;code:string}>=[];
 try{
  for(const d of c.documents){
   const lines=d.text.split('\n'),structured=lines.length===3&&lines[0].startsWith('user: ')&&lines[1].startsWith('assistant: ')&&lines[2].startsWith('tool: ');
   const messages=structured?lines.map((line,i)=>({id:'m'+i,role:['user','assistant','tool'][i],text:line.slice(line.indexOf(': ')+2),occurredAt:null,timeZone:null,...(i===1?{toolCallIds:['synthetic-call']}:{}),...(i===2?{toolCallId:'synthetic-call'}:{})})):[{id:'m0',role:'user',text:d.text,occurredAt:null,timeZone:null}];
   try{command('put',{generation:0,document:{id:d.id,incarnation:'v1',revision:1,origin:'synthetic-import',sourceDeps:[],messages,vector:null}},true)}catch(error){if(error instanceof Error&&error.message==='MEMORY_HISTORY_SECRET')rejected.push({documentId:d.id,code:error.message});else throw error}
  }
  const query=()=>command('query',{sessions:[{providerId:'synthetic',sessionId:'quality-session'}],query:c.query,settings:DEFAULT_HISTORY_SETTINGS});
  const r=query();assert.equal(r.status,'ok');const ids=r.hits.map((h:any)=>h.document.id);assert.deepEqual(ids,query().hits.map((h:any)=>h.document.id));
  for(const hit of r.hits)if(hit.document.messages.some((m:any)=>m.role==='tool'))assert.equal(hit.document.messages.length,3);
  results.push({id:c.id,family:c.family,hits:ids,status:r.status,rejected,metrics:Object.fromEntries([1,3,8].map(k=>[k,scoreHits(c.documents,ids,k)])),conflictAt3:ids.slice(0,3).some((id:string)=>c.conflictGroups.includes(c.documents.find(d=>d.id===id)!.group))});
 }finally{repo.close();fs.rmSync(root,{recursive:true,force:true})}
}
key.fill(0);
function aggregate(list:typeof results){return {cases:list.length,metrics:Object.fromEntries([1,3,8].map(k=>[k,Object.fromEntries(['recall','ndcg','duplicateRate'].map(metric=>[metric,list.reduce((sum,r)=>sum+(r.metrics[k] as any)[metric],0)/list.length]))])),answerTop1:list.filter(r=>r.metrics[1].top1Grade===3).length,conflictAt3:list.filter(r=>r.conflictAt3).length}}
const result={version:'history-quality-repository-v1',manifest,holdout:aggregate(results),families:Object.fromEntries([...new Set(results.map(r=>r.family))].map(f=>[f,aggregate(results.filter(r=>r.family===f))])),cases:results,admissionRejected:results.flatMap(r=>r.rejected.map(d=>({caseId:r.id,...d}))),limitations:['same frozen labels after raw-text result inspection; fidelity correction, not fresh untouched evaluation','synthetic-import repository-command path; Main capabilities separately evaluated by safety probe','real parser/index/ranking/excerpt, in-process SQLite; not worker process/Electron','structured tool messages strip textual role prefixes; product HMAC index IDs change tie order','existing secret-word rejection recorded, labels and denominator unchanged, no filter weakened','fixed public synthetic key makes partition-ID tie breaks reproducible','no semantic vectors, event-time resolver, answer model or production dataset']};
fs.writeFileSync(path.join(out,'repository-results.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({holdout:result.holdout,families:result.families},null,2));
