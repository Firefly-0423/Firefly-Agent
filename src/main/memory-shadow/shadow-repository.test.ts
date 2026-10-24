import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {afterEach,describe,expect,it} from 'vitest';
import {openMemoryRepository} from '../memory-core/repository';
import {MEMORY_SCHEMA_VERSION} from '../memory-core/schema';
import {RecordCodec} from '../memory-core/record-codec';
import {shadowDay} from './shadow-repository';
import {SHADOW_STORE_LIMITS} from './shadow-store-contracts';

const SCOPE='scope-a',ACTOR='actor-a',PROMPT='m-shadow-prompt-v1',CANARY='ShadowCanaryEditor';
const roots:string[]=[],repositories:ReturnType<typeof openMemoryRepository>[]=[];
afterEach(()=>{for(const r of repositories.splice(0))r.close();for(const p of roots.splice(0))fs.rmSync(p,{recursive:true,force:true})});

function fixture(start=Date.UTC(2026,9,14,4)){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'shadow-repo-'));roots.push(root);
 const databasePath=path.join(root,'memory.sqlite'),key=randomBytes(32),clock={now:start};
 const open=()=>{const repo=openMemoryRepository({databasePath,key,clock:()=>clock.now});repositories.push(repo);return repo};
 let repo=open(),n=0,message=0;
 const source=(kind:string,body:unknown)=>(repo as any).sourceCommand({kind,scopeKey:SCOPE,commandId:'source-'+ ++n,body});
 const shadow=(kind:string,body:Record<string,unknown>={})=>(repo as any).shadowCommand({kind,scopeKey:SCOPE,...(['status','export'].includes(kind)?{}:{commandId:'shadow-'+ ++n}),body:{actorKey:ACTOR,...body}});
 const observation=(identity:object,patch:object={})=>({...identity,contentRevision:1,generation:'generation-a',state:'live',role:'user',trust:'direct-user-event',fingerprint:'a'.repeat(64),...patch});
 function publish(patch:object={}){const identity={providerId:'desktop',sessionId:'session-a',messageId:'message-'+ ++message},r=source('reserve',{identity,expectedRef:null});return source('finish',{sourceId:r.sourceId,operationId:r.operationId,observation:observation(identity,patch)})}
 function republish(ref:any,patch:object){const identity={providerId:ref.binding.providerId,sessionId:ref.binding.sessionId,messageId:ref.binding.messageId},r=source('reserve',{identity,expectedRef:ref});return source('finish',{sourceId:r.sourceId,operationId:r.operationId,observation:observation(identity,patch)})}
 const enable=(dailyCap=50)=>{const s=shadow('status');return shadow('configure',{enabled:true,dailyCap,expectedRevision:s.revision})};
 return {root,databasePath,key,clock,get repo(){return repo},reopen(){repo.close();repo=open()},shadow,publish,republish,enable};
}
const candidate=(ref:any,value=CANARY)=>({attribute:'tool',value,polarity:'positive',status:'asserted',evidence:{messageId:ref.binding.messageId,quote:`我平时用 ${value}`},reason:'用户直接说明'});
function extract(f:ReturnType<typeof fixture>,ref:any,candidates=[candidate(ref)]){
 const {clearGeneration}=f.shadow('status');
 const reserved=f.shadow('reserve',{clearGeneration,sourceRef:ref,promptVersion:PROMPT});
 if(reserved.status!=='reserved')return reserved;
 return f.shadow('record',{clearGeneration,sourceRef:ref,profile:{id:'profile-a',revision:1},promptVersion:PROMPT,candidates,tally:{'drop:sensitive':1}});
}

describe('shadow store schema',()=>{
 it('migrates a version 9 database and keeps existing rows',()=>{
  const f=fixture();f.publish();f.repo.close();
  let db=new DatabaseSync(f.databasePath);db.exec('DROP TABLE history_origins; DROP TABLE shadow_records; PRAGMA user_version=9');db.close();
  f.reopen();db=new DatabaseSync(f.databasePath,{readOnly:true});
  try{expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(MEMORY_SCHEMA_VERSION);expect(MEMORY_SCHEMA_VERSION).toBe(12);
   expect(db.prepare("SELECT name FROM sqlite_master WHERE name='shadow_records'").get()?.name).toBe('shadow_records');
   expect(db.prepare('SELECT count(*) AS n FROM sources').get()?.n).toBe(1)}finally{db.close()}
 });
});

describe('shadow store',()=>{
 it('is off by default and refuses to reserve until enabled',()=>{
  const f=fixture(),ref=f.publish();
  expect(f.shadow('status')).toMatchObject({enabled:false,dailyCap:SHADOW_STORE_LIMITS.defaultDailyCap,used:0,records:0,clearGeneration:0});
  expect(extract(f,ref)).toEqual({status:'refused',reason:'disabled'});
  expect(f.shadow('status').used).toBe(0);
 });

 it('writes and reads back a record with its source, profile and prompt version',()=>{
  const f=fixture(),ref=f.publish();f.enable();
  expect(extract(f,ref)).toEqual({status:'recorded',written:1});
  expect(f.shadow('export')).toEqual([{candidate:candidate(ref),sourceRef:ref,profile:{id:'profile-a',revision:1},promptVersion:PROMPT,recordedAt:f.clock.now}]);
  expect(f.shadow('status')).toMatchObject({used:1,records:1,counters:{sent:1,candidates:1,'drop:sensitive':1}});
 });

 it('stores records encrypted: the database files contain no plaintext value or quote',()=>{
  const f=fixture(),ref=f.publish();f.enable();extract(f,ref);f.repo.close();
  for(const file of fs.readdirSync(f.root))expect(fs.readFileSync(path.join(f.root,file)).includes(Buffer.from(CANARY))).toBe(false);
 });

 it('hides records whose source message was edited or deleted',()=>{
  const f=fixture(),edited=f.publish(),deleted=f.publish(),kept=f.publish();f.enable();
  for(const ref of [edited,deleted,kept])extract(f,ref,[candidate(ref,'Tool'+ref.binding.messageId)]);
  f.republish(edited,{contentRevision:2,fingerprint:'b'.repeat(64)});
  f.republish(deleted,{contentRevision:2,state:'deleted'});
  expect(f.shadow('export').map((r:any)=>r.sourceRef.sourceId)).toEqual([kept.sourceId]);
  expect(f.shadow('status').records).toBe(1);
 });

 it('hides records whose source supports a forgotten fact',()=>{
  const f=fixture(),ref=f.publish(),other=f.publish();f.enable();extract(f,ref);extract(f,other,[candidate(other,'Other')]);
  // A forget marker whose origin is this source, sealed the way the worker seals it.
  const db=new DatabaseSync(f.databasePath),id=randomUUID();
  try{db.prepare("INSERT INTO deletion_markers (id,scope_key,revision,source_id,parent_id,state,payload) VALUES(?,?,1,NULL,NULL,'forgotten',?)")
   .run(id,SCOPE,new RecordCodec(f.key).seal('deletion_markers',SCOPE,id,{factId:'fact-a',sourceRef:ref,forgetEvent:ref,at:f.clock.now,generation:1,origins:[ref],subjects:[]}))}finally{db.close()}
  expect(f.shadow('export').map((r:any)=>r.candidate.value)).toEqual(['Other']);
 });

 it('refuses a source that is not a direct user message',()=>{
  const f=fixture(),ref=f.publish({role:'assistant',trust:'model'});f.enable();
  expect(extract(f,ref)).toEqual({status:'refused',reason:'source-unavailable'});
  expect(f.shadow('status')).toMatchObject({used:0,counters:{'refuse:source-unavailable':1}});
 });

 it('rejects a candidate whose evidence points at another message',()=>{
  const f=fixture(),ref=f.publish(),other=f.publish();f.enable();
  expect(()=>extract(f,ref,[candidate(other)])).toThrow('MEMORY_SHADOW_SOURCE_MISMATCH');
 });

 it('reserves each source revision and prompt version only once',()=>{
  const f=fixture(),ref=f.publish();f.enable();extract(f,ref);
  expect(extract(f,ref)).toEqual({status:'refused',reason:'duplicate'});
  expect(f.shadow('status').used).toBe(1);
 });

 it('accepts only one writeback per reservation, so a second result cannot overwrite or mix with the first',()=>{
  const f=fixture(),ref=f.publish();f.enable();
  expect(extract(f,ref,[candidate(ref,'First'),candidate(ref,'Second')])).toEqual({status:'recorded',written:2});
  expect(f.shadow('record',{clearGeneration:0,sourceRef:ref,profile:{id:'profile-a',revision:1},promptVersion:PROMPT,candidates:[candidate(ref,'Other')],tally:{}})).toEqual({status:'refused',reason:'not-reserved'});
  expect(f.shadow('export').map((r:any)=>r.candidate.value)).toEqual(['First','Second']);
  expect(f.shadow('status').counters).toMatchObject({candidates:2,'discard:not-reserved':1});
 });

 it('refuses to write without a reservation',()=>{
  const f=fixture(),ref=f.publish();f.enable();
  expect(f.shadow('record',{clearGeneration:0,sourceRef:ref,profile:{id:'profile-a',revision:1},promptVersion:PROMPT,candidates:[candidate(ref)],tally:{}})).toEqual({status:'refused',reason:'not-reserved'});
 });

 describe('late results after clear or disable',()=>{
  function inFlight(f:ReturnType<typeof fixture>){const ref=f.publish(),{clearGeneration}=f.shadow('status');expect(f.shadow('reserve',{clearGeneration,sourceRef:ref,promptVersion:PROMPT}).status).toBe('reserved');
   return ()=>f.shadow('record',{clearGeneration,sourceRef:ref,profile:{id:'profile-a',revision:1},promptVersion:PROMPT,candidates:[candidate(ref)],tally:{}})}

  it('a result arriving after clear is refused and does not reappear',()=>{
   const f=fixture();f.enable();const late=inFlight(f);
   expect(f.shadow('clear')).toMatchObject({clearGeneration:1,records:0});
   expect(late()).toEqual({status:'refused',reason:'generation-changed'});
   expect(f.shadow('export')).toEqual([]);
  });

  it('a result arriving after the switch was turned off is refused',()=>{
   const f=fixture();f.enable();const late=inFlight(f),s=f.shadow('status');
   expect(f.shadow('configure',{enabled:false,dailyCap:50,expectedRevision:s.revision})).toMatchObject({enabled:false,clearGeneration:1});
   expect(late()).toEqual({status:'refused',reason:'disabled'});
   f.enable();expect(late()).toEqual({status:'refused',reason:'generation-changed'});
  });

  it('a reservation from before the switch was turned off cannot be written back after turning it on again',()=>{
   const f=fixture();f.enable();const ref=f.publish(),old=f.shadow('status');
   expect(f.shadow('reserve',{clearGeneration:old.clearGeneration,sourceRef:ref,promptVersion:PROMPT}).status).toBe('reserved');
   f.shadow('configure',{enabled:false,dailyCap:50,expectedRevision:old.revision});f.enable();
   const {clearGeneration}=f.shadow('status');expect(clearGeneration).toBe(old.clearGeneration+1);
   expect(f.shadow('record',{clearGeneration,sourceRef:ref,profile:{id:'profile-a',revision:1},promptVersion:PROMPT,candidates:[candidate(ref)],tally:{}})).toEqual({status:'refused',reason:'not-reserved'});
   expect(f.shadow('export')).toEqual([]);
  });

  it('clear deletes the rows physically but keeps today\'s usage',()=>{
   const f=fixture(),ref=f.publish();f.enable();extract(f,ref);f.shadow('clear');
   const db=new DatabaseSync(f.databasePath,{readOnly:true});
   try{expect(db.prepare("SELECT count(*) AS n FROM shadow_records WHERE kind IN ('record','attempt')").get()?.n).toBe(0)}finally{db.close()}
   expect(f.shadow('status').used).toBe(1);
  });
 });

 describe('daily cap and stop',()=>{
  it('refuses once the daily cap is used up, including reservations that never wrote back',()=>{
   const f=fixture();f.enable(2);
   const [a,b,c]=[f.publish(),f.publish(),f.publish()],{clearGeneration}=f.shadow('status');
   // a times out after reserving: it still counts.
   expect(f.shadow('reserve',{clearGeneration,sourceRef:a,promptVersion:PROMPT}).status).toBe('reserved');
   expect(extract(f,b)).toMatchObject({status:'recorded'});
   expect(extract(f,c)).toEqual({status:'refused',reason:'cap-reached'});
   expect(f.shadow('status')).toMatchObject({used:2,counters:{'refuse:cap-reached':1}});
  });

  it('keeps the count across a restart',()=>{
   const f=fixture();f.enable(1);extract(f,f.publish());f.reopen();
   expect(f.shadow('status').used).toBe(1);
   expect(extract(f,f.publish())).toEqual({status:'refused',reason:'cap-reached'});
  });

  it('stops for the rest of the day on quota or rate limit and resumes the next day',()=>{
   const f=fixture();f.enable();f.shadow('stop',{reason:'rate-limit'});
   expect(f.shadow('status')).toMatchObject({stopped:'rate-limit',counters:{'error:rate-limit':1}});
   expect(extract(f,f.publish())).toEqual({status:'refused',reason:'stopped'});
   f.reopen();expect(f.shadow('status').stopped).toBe('rate-limit');
   f.clock.now+=86400000;
   expect(f.shadow('status')).toMatchObject({stopped:null,used:0,day:shadowDay(f.clock.now)});
   expect(extract(f,f.publish())).toMatchObject({status:'recorded'});
  });
 });

 it('rejects a stale configure revision',()=>{
  const f=fixture();f.enable();
  expect(()=>f.shadow('configure',{enabled:true,dailyCap:10,expectedRevision:0})).toThrow('MEMORY_REVISION_CONFLICT');
 });

 it.each([
  ['a cap of zero',{kind:'configure',body:{enabled:true,dailyCap:0,expectedRevision:0}}],
  ['an unknown counter',{kind:'tally',body:{counters:{'skip:whatever':1}}}],
  ['an unknown stop reason',{kind:'stop',body:{reason:'tired'}}],
  ['an unknown command',{kind:'drop-table',body:{}}],
 ])('rejects malformed input: %s',(_label,{kind,body})=>{
  const f=fixture();expect(()=>f.shadow(kind,body)).toThrow();
 });

 it('keeps actors apart',()=>{
  const f=fixture(),ref=f.publish();f.enable();extract(f,ref);
  expect((f.repo as any).shadowCommand({kind:'export',scopeKey:SCOPE,body:{actorKey:'actor-b'}})).toEqual([]);
  expect((f.repo as any).shadowCommand({kind:'status',scopeKey:SCOPE,body:{actorKey:'actor-b'}})).toMatchObject({enabled:false,used:0,records:0});
 });

 it('prune removes invalid records and statistics past the retention period',()=>{
  const f=fixture(),gone=f.publish(),kept=f.publish();f.enable();
  extract(f,gone,[candidate(gone,'Gone')]);extract(f,kept,[candidate(kept,'Kept')]);
  f.republish(gone,{contentRevision:2,state:'deleted'});
  f.clock.now+=(SHADOW_STORE_LIMITS.statsRetentionDays+1)*86400000;
  expect(f.shadow('prune')).toEqual({removedRecords:1,removedStats:1});
  expect(f.shadow('export').map((r:any)=>r.candidate.value)).toEqual(['Kept']);
 });
});
