import {it,expect} from 'vitest';
import {parseHistoryDocument} from './history-repository';
import {createMainHistoryProvider,readHistoryEvidence} from './main-history';
import {createSmhFixture} from '../memory-context/smh-fixture.test-support';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
const tools=[{id:'call:original',name:'read_file',arguments:'{"path":"咖啡.txt","exact":"  keep  "}'}];
it('preserves complete tool call names, raw argument strings and result in encrypted H quotation',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'h-quote-')),f=createSmhFixture(root);
 try{
  const source=await f.source('周末咖啡',{trust:'history',occurredAt:1000});
  const doc={id:'native-tool',incarnation:'v1',revision:1,origin:'canonical' as const,sourceDeps:[{sourceRef:source.ref,subjectKeys:null,derivedRefs:null}],vector:null,messages:[
   {id:'u',role:'user' as const,text:'周末咖啡',occurredAt:1000,timeZone:null,sourceRef:source.ref},
   {id:'a',role:'assistant' as const,text:'查咖啡',occurredAt:1001,timeZone:null,toolCalls:tools,toolCallIds:['call:original']},
   {id:'t',role:'tool' as const,text:'咖啡原始结果',occurredAt:1002,timeZone:null,toolCallId:'call:original',name:'read_file'}]};
  expect(parseHistoryDocument(doc).messages).toEqual(doc.messages);
  const provider=createMainHistoryProvider(f.actorAuthority,f.actor,{withLease:async(_id,run)=>run(async()=>structuredClone(doc))});
  await f.history.captureTranscript(f.actor,provider,'native-tool');
  const q=await f.history.query(f.actor,{query:'咖啡'}),e=readHistoryEvidence(f.actorAuthority,f.actor,q.evidence);
  const quoted=JSON.parse(e.unit.messages[0].text.split('\n').slice(1).join('\n'))[0];
  expect(quoted.messages[1].toolCalls).toEqual(tools);
  expect(quoted.messages[2]).toMatchObject({name:'read_file',toolCallId:'call:original',text:'咖啡原始结果'});
  expect(f.repo.current('scope-a')).toEqual([]);
 }finally{f.close();fs.rmSync(root,{recursive:true,force:true})}
});
it('history direct read transactions sample and validate their injected clock once',()=>{
 const phases:Record<string,{wallMs:number;cpuMs:number}>={};let calls=0;
 function phase<T>(name:string,run:()=>T):T{
  const start=performance.now(),cpu=process.cpuUsage();
  try{return run()}finally{const used=process.cpuUsage(cpu);phases[name]={wallMs:performance.now()-start,cpuMs:(used.user+used.system)/1000}}
 }
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'h-clock-'));let f:ReturnType<typeof createSmhFixture>|undefined;
 try{
  const fixture=f=phase('fixture',()=>createSmhFixture(root,{clock:()=>{calls++;return -1}}));
  phase('command',()=>{
   expect(()=>fixture.repo.historyCommand({kind:'baseline',scopeKey:'scope-a',body:{actorKey:'actor-a',providerId:'synthetic',sessionId:'session-a'}})).toThrow('MEMORY_TRANSACTION_CLOCK_INVALID');
   expect(calls).toBe(1);
  });
 }finally{
  try{if(f)phase('close',()=>f!.close())}finally{
   phase('cleanup',()=>fs.rmSync(root,{recursive:true,force:true}));
   const output=process.env.FIREFLY_VITEST_DIAGNOSTICS;
   // CI-only metadata; no source content, paths, SQL or key material.
   if(output)fs.appendFileSync(path.join(output,`process-${process.pid}.jsonl`),JSON.stringify({time:new Date().toISOString(),event:'h-clock-phases',pid:process.pid,ppid:process.ppid,clockCalls:calls,phases})+'\n');
  }
 }
});

it('rejects oversized full tool envelopes rather than budgeting only visible text',()=>{
 const calls=Array.from({length:64},(_,i)=>({id:'t'+i+'x'.repeat(1020),name:'read_file',arguments:'{}'}));
 const document={id:'tool-budget',incarnation:'v1',revision:1,origin:'synthetic-import',sourceDeps:[],vector:null,messages:[
 {id:'u',role:'user',text:'咖啡',occurredAt:null,timeZone:null},
 {id:'a',role:'assistant',text:'',occurredAt:null,timeZone:null,toolCalls:calls,toolCallIds:calls.map(c=>c.id)},
 ...calls.map((c,i)=>({id:'result-'+i,role:'tool',text:'',occurredAt:null,timeZone:null,toolCallId:c.id,name:'read_file'}))]};
 expect(()=>parseHistoryDocument(document)).toThrow('MEMORY_HISTORY_INPUT_INVALID');
});
