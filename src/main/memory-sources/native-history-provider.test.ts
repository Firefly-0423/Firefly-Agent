import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach,it,expect,vi} from 'vitest';
// Real SQLite / filesystem integration cases: the 5 s default is too tight on CI runners, so this file allows 30 s. Other files keep the default.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
import {recallFixture} from '../../../scripts/verify/memory-recall/recall-fixture';
import {createMainActorAuthority} from '../memory-core/main-actor-authority';
import {createMainSourceRegistry} from './source-registry';
import {createMainHistory,readHistoryEvidence} from '../memory-history/main-history';
import {ConversationTranscriptStore} from '../orchestrator/conversation-transcript-store';
import {initializeStorageContext} from '../storage/storage-context';
import {resolveRuntimeProfile} from '../startup/runtime-profile';
import {createNativeHistoryProvider} from './native-history-provider';
import {DatabaseSync} from 'node:sqlite';
import {HistoryOrigins,historyOriginEvent} from '../memory-history/history-origins';
const isolation=fs.mkdtempSync(path.join(os.tmpdir(),'native-h-provider-'));
const storage=initializeStorageContext(resolveRuntimeProfile({argv:['--firefly-profile=test','--firefly-isolation-root='+isolation],env:{},isPackaged:false,productionAppData:path.join(os.tmpdir(),'synthetic-production-never-used')}));
const fixtures:ReturnType<typeof recallFixture>[]=[];
it('recovers a mapped independent native user after forget while quarantining an unproved assistant',async()=>{
 const f=await fixture();const entry=(await f.store.read('session-a')).entries[0];
 expect(entry.kind).toBe('user');
 await f.store.append('session-a',{id:'legacy-answer',kind:'assistant',turnId:'assistant',payload:{role:'assistant',content:'unproved legacy echo'},at:1001});await f.store.checkpoint('session-a');
 const fact=await f.active();await f.policy.act(f.actor,await f.policy.event(f.actor,{kind:'forget',nonce:crypto.randomUUID(),factId:fact.factId,revision:1}));
 expect(await f.native.capture()).toMatchObject({status:'captured',coverage:'partial',captured:1});
 const q=await f.native.query({query:'harbor'});expect(q.status).toBe('queried');if(q.status!=='queried')throw Error('missing recovered history');
 expect(q.result.hits.flatMap(h=>h.document.messages).map(m=>m.text)).toEqual(['harbor coffee']);
 await f.native.close();f.reopen();const reopened=createMainHistory({actorAuthority:f.authority,registry:f.registry,transport:f.historyTransport}),native=createNativeHistoryProvider({actorAuthority:f.authority,actorToken:f.actor,store:f.store,history:reopened,endpointFactory:f.endpointFactory,deadlineMs:1000});
 expect(await native.capture()).toMatchObject({status:'captured',coverage:'partial'});expect((await native.query({query:'harbor'})).status).toBe('queried');await native.close();
});
afterEach(async()=>{for(const f of fixtures.splice(0))f.close();fs.rmSync(path.join(storage.dataRoot,'transcripts'),{recursive:true,force:true});vi.restoreAllMocks()});
it('quarantines unknown legacy native and old cached documents even without an M fact or forget generation',async()=>{
 const f=await fixture();await f.native.capture();const old=await f.native.query({query:'harbor'});expect(old.status).toBe('queried');
 const db=new DatabaseSync(f.databasePath);try{db.exec('DELETE FROM history_origins')}finally{db.close()}
 const id={providerId:'synthetic',sessionId:'session-a',messageId:'turn'},ref=await f.registry.capture(f.access,f.provider.adapter,id);await f.registry.prepareChange(f.access,f.provider.adapter,ref);f.provider.remove(id);await expect(f.registry.reconcile(f.access,f.provider.adapter,id)).rejects.toThrow('MEMORY_SOURCE_DELETED');
 expect(await f.policy.recall(f.actor)).toEqual([]);expect(await f.native.capture()).toMatchObject({status:'coverage-insufficient',reason:'partial-source'});expect(await f.native.query({query:'harbor'})).toMatchObject({status:'coverage-insufficient'});
 if(old.status==='queried')expect(()=>readHistoryEvidence(f.authority,f.actor,old.result.evidence)).toThrow();
});
it('merges more than 129 consecutive proven messages into bounded safe runs around unknown history',async()=>{
 const f=await fixture(),owner={actorKey:'actor-a',providerId:'synthetic',sessionId:'session-a'},root=historyOriginEvent((await f.store.read('session-a')).entries[0]);
 for(let turn=0;turn<2;turn++){
  if(turn)await f.store.append('session-a',{id:'u2',kind:'user',turnId:'turn2',revision:1,payload:{text:'harbor tea'},at:2000});
  await f.store.append('session-a',{id:'unknown-'+turn,kind:'assistant',payload:{role:'assistant',content:'legacy unknown'}});
  for(let i=0;i<65;i++)await f.store.append('session-a',{id:`safe-${turn}-${i}`,kind:'assistant',payload:{role:'assistant',content:'harbor safe'}});
 }
 await f.bindUsers();const db=new DatabaseSync(f.databasePath),ledger=new HistoryOrigins(db,f.key);try{db.exec('BEGIN IMMEDIATE');for(const entry of (await f.store.read('session-a')).entries.filter(e=>e.id.startsWith('safe-')))ledger.recordResponse('scope-a',owner,historyOriginEvent(entry),'fixture-snapshot',{sources:[],events:[{...owner,event:root}],complete:true});db.exec('COMMIT')}finally{db.close()}
 await f.store.checkpoint('session-a');expect(await f.native.capture()).toMatchObject({status:'captured',coverage:'partial',captured:4});
});
it('native H remove permanently revokes its exact events and prevents alternate projection revival',async()=>{
 const f=await fixture();await f.native.capture();const q=await f.native.query({query:'harbor'});if(q.status!=='queried')throw Error('missing');const hit=q.result.hits[0];
 await f.history.remove(f.actor,{documentId:hit.document.id,revision:hit.document.revision});expect(await f.native.capture()).toMatchObject({status:'coverage-insufficient',reason:'partial-source'});await f.native.close();f.reopen();
 const fresh=createMainHistory({actorAuthority:f.authority,registry:f.registry,transport:f.historyTransport}),native=createNativeHistoryProvider({actorAuthority:f.authority,actorToken:f.actor,store:f.store,history:fresh,endpointFactory:f.endpointFactory,deadlineMs:1000});try{expect(await native.capture()).toMatchObject({status:'coverage-insufficient',reason:'partial-source'})}finally{await native.close()}
});
async function fixture(options:{missing?:string;rootMismatch?:boolean;failPut?:number}={}){
 const f=recallFixture();fixtures.push(f);const store=new ConversationTranscriptStore(storage.dataRoot);await store.append('session-a',{id:'u',kind:'user',turnId:'turn',revision:1,payload:{text:'harbor coffee'},at:1000});await store.checkpoint('session-a');
 const bindUsers=async()=>{for(const entry of (await store.read('session-a')).entries){if(entry.kind!=='user')continue;const id={providerId:'synthetic',sessionId:'session-a',messageId:entry.turnId!};f.provider.write(id,{text:entry.payload.text,role:'user',trust:'direct-user-event',occurredAt:entry.at});const sourceRef=await f.registry.capture(f.access,f.provider.adapter,id);f.repo.contextCommand({kind:'historyUserOrigin',scopeKey:'scope-a',commandId:crypto.randomUUID(),body:{...f.owner,sourceRef,entry}})}};
 await bindUsers();
 let held=0,reads=0,starts=0,puts=0;const commands:any[]=[];
 const transport={...f.transport,historyCommand:async(c:any)=>{commands.push(c);if(c.kind==='put'){expect(held).toBe(2);if(++puts===options.failPut)throw Error('injected put')}return f.repo.historyCommand(c)},contextCommand:async(c:any)=>{if(c.kind==='transcriptPublish')expect(held).toBe(2);return f.transport.contextCommand(c)}};
 const history=createMainHistory({actorAuthority:f.authority,registry:f.registry,transport});
 const endpointFactory=async()=>{const ordinal=++starts;let acquired=false,disposed=false;return {rootIdentity:{volumeSerial:42,fileIndex:options.rootMismatch&&ordinal===2?'2222222222222222':'1111111111111111'},async read(components:readonly string[],maxBytes:number){reads++;if(options.missing===components[1])throw Error('history-leaf-missing');const file=path.join(storage.dataRoot,'transcripts',...components);if(!fs.existsSync(file))throw Error('history-leaf-missing');const bytes=fs.readFileSync(file);if(bytes.length>maxBytes)throw Error('history-invalid-budget');acquired=true;held++;return {identity:{volumeSerial:42,fileIndex:components[1]==='snapshot.json'?'bbbbbbbbbbbbbbbb':'aaaaaaaaaaaaaaaa'},bytes}},assertLive(){if(disposed)throw Error('dead helper')},async dispose(){if(!disposed&&acquired)held--;disposed=true}}};
 const native=createNativeHistoryProvider({actorAuthority:f.authority,actorToken:f.actor,store,history,endpointFactory,deadlineMs:1000});return {...f,get repo(){return f.repo},store,history,native,endpointFactory,historyTransport:transport,commands,options,bindUsers,get held(){return held},get reads(){return reads}};
}
it('captures one stable native pair and retrieves opaque quotes without M support or leaked lease',async()=>{
 const f=await fixture();expect(await f.native.capture()).toMatchObject({status:'captured',captured:1,coverage:'complete'});expect(f.held).toBe(0);
 const q=await f.native.query({query:'harbor'});expect(q.status).toBe('queried');if(q.status!=='queried')throw Error('expected queried');expect(q.result.hits[0].document.sourceDeps).toEqual([]);expect(readHistoryEvidence(f.authority,f.actor,q.result.evidence).unit.messages[0].text).toContain('harbor coffee');expect(f.reads).toBeGreaterThan(2);
 expect(await f.policy.recall(f.actor)).toEqual([]);
});
it.each(['snapshot.json','transcript.jsonl'])('missing %s remains explicit coverage, creates no head/index and cannot fallback',async missing=>{
 const f=await fixture({missing});const capture=await f.native.capture();expect(capture).toMatchObject({status:'coverage-insufficient',reason:missing==='snapshot.json'?'snapshot-missing':'transcript-missing'});expect(f.commands.some(c=>c.kind==='put')).toBe(false);expect(f.held).toBe(0);const q=await f.native.query({query:'harbor'});expect(q).toMatchObject({status:'coverage-insufficient'});expect(q).not.toHaveProperty('result');
});
it('authorized root pin rejects a second helper before its leaf read',async()=>{const f=await fixture({rootMismatch:true});await expect(f.native.capture()).rejects.toThrow('MEMORY_HISTORY_NATIVE_ROOT_CHANGED');expect(f.reads).toBe(1);expect(f.held).toBe(0)});
it('successful capture followed by external snapshot deletion revokes old synchronous evidence and reports coverage',async()=>{
 const f=await fixture();await f.native.capture();const q=await f.native.query({query:'harbor'});if(q.status!=='queried')throw Error('expected queried');fs.unlinkSync(path.join(storage.dataRoot,'transcripts','session-a','snapshot.json'));
 await expect(f.history.query(f.actor,{query:'harbor'})).rejects.toThrow('MEMORY_HISTORY_COVERAGE_INSUFFICIENT');expect(await f.native.query({query:'harbor'})).toMatchObject({status:'coverage-insufficient',reason:'snapshot-missing'});expect(()=>readHistoryEvidence(f.authority,f.actor,q.result.evidence)).toThrow();
});
it('invalidates on mutation, close and forget without restoring authority from identical files',async()=>{
 const f=await fixture();await f.native.capture();const q=await f.native.query({query:'harbor'});if(q.status!=='queried')throw Error('expected queried');await f.native.beforeMutation('append');expect(()=>readHistoryEvidence(f.authority,f.actor,q.result.evidence)).toThrow();expect(await f.native.query({query:'harbor'})).toMatchObject({reason:'not-acquired'});
 await f.native.capture();const fact=await f.active();await f.native.invalidate('forget');await f.policy.act(f.actor,await f.policy.event(f.actor,{kind:'forget',nonce:crypto.randomUUID(),factId:fact.factId,revision:1}));const reads=f.reads,puts=f.commands.filter(c=>c.kind==='put').length;
 expect(await f.native.capture()).toMatchObject({status:'captured',coverage:'complete'});
 expect(await f.native.query({query:'harbor'})).toMatchObject({status:'queried'});
 expect(f.reads).toBeGreaterThan(reads);expect(f.commands.filter(c=>c.kind==='put').length).toBeGreaterThan(puts);
 await f.native.close();await f.native.close();await expect(f.native.capture()).rejects.toThrow('MEMORY_HISTORY_PROVIDER_DENIED');
});
it('partial tail and per-session record budget cannot yield partial publication',async()=>{
 const f=await fixture();fs.appendFileSync(path.join(storage.dataRoot,'transcripts','session-a','transcript.jsonl'),'BROKEN');expect(await f.native.capture()).toMatchObject({reason:'partial-source'});expect(f.commands.some(c=>c.kind==='put')).toBe(false);
});
it('a later record failure invalidates the first head before capture acknowledgement',async()=>{
 const f=await fixture({failPut:2});await f.store.append('session-a',{id:'u2',kind:'user',turnId:'turn2',revision:1,payload:{text:'harbor tea'},at:2000});await f.store.checkpoint('session-a');await f.bindUsers();await expect(f.native.capture()).rejects.toThrow('injected put');expect(await f.native.query({query:'harbor'})).toMatchObject({reason:'not-acquired'});expect(f.held).toBe(0);await expect(f.history.query(f.actor,{query:'harbor'})).rejects.toThrow();
});
it('forged actor and temporary actors reject before endpoint acquisition',async()=>{const f=await fixture();expect(()=>createNativeHistoryProvider({actorAuthority:f.authority,actorToken:{},store:f.store,history:f.history,endpointFactory:async()=>{throw Error('read forbidden')},deadlineMs:1000})).toThrow('MEMORY_ACTOR_DENIED');const temporary=f.authority.bindActor(f.access,f.provider.adapter,f.identity,{sessionMode:'temporary'});expect(()=>createNativeHistoryProvider({actorAuthority:f.authority,actorToken:temporary,store:f.store,history:f.history,endpointFactory:async()=>{throw Error('read forbidden')},deadlineMs:1000})).toThrow('MEMORY_HISTORY_TEMPORARY_DENIED')});

it('queued cancellation performs zero native reads and preserves mutation progress',async()=>{
 const f=await fixture();let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>entered=r),hold=new Promise<void>(r=>release=r);
 const barrier=f.store.withReadonlyBarrier('session-a',async()=>{entered();await hold});await started;
 const controller=new AbortController(),capture=f.native.capture(controller.signal);const rejected=expect(capture).rejects.toThrow('MEMORY_HISTORY_CANCELLED');controller.abort();release();await barrier;await rejected;expect(f.reads).toBe(0);
 await f.store.append('session-a',{id:'after-cancel',kind:'user',turnId:'after',revision:1,payload:{text:'still live'}});
});
it('session record count is bounded before the first head dispatch',async()=>{
 const f=await fixture();for(let i=0;i<33;i++)await f.store.append('session-a',{id:'budget-'+i,kind:'user',turnId:'budget-turn-'+i,revision:1,payload:{text:'harbor '+i}});await f.store.checkpoint('session-a');expect(await f.native.capture()).toMatchObject({reason:'selection-budget-exhausted'});expect(f.commands.some(c=>c.kind==='put')).toBe(false);
});
it('generic native faults on refresh propagate and synchronously revoke the old session',async()=>{
 const f=await fixture();await f.native.capture();const q=await f.native.query({query:'harbor'});if(q.status!=='queried')throw Error('expected queried');
 // Test-owned source bytes become corrupt without invoking the observer.
 fs.writeFileSync(path.join(storage.dataRoot,'transcripts','session-a','snapshot.json'),'BROKEN');
 await expect(f.native.query({query:'harbor'})).rejects.toThrow('MEMORY_HISTORY_CORRUPT');expect(()=>readHistoryEvidence(f.authority,f.actor,q.result.evidence)).toThrow();expect(await f.native.query({query:'harbor'})).toMatchObject({reason:'not-acquired'});
});

it('readonly barrier retains the queue until both endpoints finish disposal',async()=>{
 const f=await fixture();let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>entered=r),hold=new Promise<void>(r=>release=r);
 const native=createNativeHistoryProvider({actorAuthority:f.authority,actorToken:f.actor,store:f.store,history:f.history,deadlineMs:1000,endpointFactory:async()=>{const endpoint=await f.endpointFactory();return {...endpoint,async dispose(){entered();await hold;await endpoint.dispose()}}}});
 const capture=native.capture();await started;let appended=false,queuedBarrierEntered=false;
 const probe=f.store.withReadonlyBarrier('session-a',async()=>{queuedBarrierEntered=true});
 const append=f.store.append('session-a',{id:'queued-write',kind:'user',turnId:'queued',revision:1,payload:{text:'queued'}}).then(()=>{appended=true});
 try{await new Promise<void>(setImmediate);expect(queuedBarrierEntered).toBe(false);expect(appended).toBe(false)}finally{release();await capture;await probe;await append;await native.close()}
});
it('simultaneous captures cannot share an epoch or publication eligibility',async()=>{
 const f=await fixture();const first=f.native.capture(),second=f.native.capture();await expect(second).rejects.toThrow('MEMORY_HISTORY_STALE');await first;
});

it('delegated runs share one capture: concurrent callers join it and keep the evidence a direct capture produced',async()=>{
 const f=await fixture();await f.native.capture();const parent=await f.native.query({query:'harbor'});if(parent.status!=='queried')throw Error('expected queried');
 const before=f.reads,[a,b]=await Promise.all([f.native.captureShared(),f.native.captureShared()]);
 expect(a).toMatchObject({status:'captured',captured:1});expect(b).toEqual(a);expect(f.reads).toBe(before);
 // The parent's evidence survives its children's history step, and the children can query the same capture.
 expect(readHistoryEvidence(f.authority,f.actor,parent.result.evidence).unit.messages[0].text).toContain('harbor coffee');
 const child=await f.native.query({query:'harbor'});expect(child.status).toBe('queried');
});

it('a shared capture acquires once when nothing is current, and again only after the epoch moves',async()=>{
 const f=await fixture(),before=f.reads,[a,b]=await Promise.all([f.native.captureShared(),f.native.captureShared()]);
 expect(a).toMatchObject({status:'captured'});expect(b).toEqual(a);expect(f.reads-before).toBe(2);
 await f.native.captureShared();expect(f.reads-before).toBe(2);
 await f.native.invalidate('grant-change');await f.native.captureShared();expect(f.reads-before).toBe(4);
});

it('one caller detaching does not cancel the capture its siblings share, and a direct capture is still refused meanwhile',async()=>{
 const f=await fixture(),controller=new AbortController(),detached=f.native.captureShared(controller.signal),sibling=f.native.captureShared();
 await expect(f.native.capture()).rejects.toThrow('MEMORY_HISTORY_STALE');
 controller.abort();await expect(detached).rejects.toThrow('MEMORY_HISTORY_CANCELLED');
 expect(await sibling).toMatchObject({status:'captured',captured:1});
 await expect(f.native.captureShared(controller.signal)).rejects.toThrow('MEMORY_HISTORY_CANCELLED');
});

it('active query cancellation reaches the exact fresh acquisition signal',async()=>{
 const f=await fixture();let starts=0,entered!:()=>void,release!:()=>void,observed:AbortSignal|undefined;const started=new Promise<void>(r=>entered=r),hold=new Promise<void>(r=>release=r);
 const native=createNativeHistoryProvider({actorAuthority:f.authority,actorToken:f.actor,store:f.store,history:f.history,deadlineMs:1000,endpointFactory:async input=>{const endpoint=await f.endpointFactory();if(++starts<=2)return endpoint;observed=input.signal;return {...endpoint,async read(components,maxBytes){entered();await hold;return endpoint.read(components,maxBytes)}}}});
 await native.capture();const controller=new AbortController(),query=native.query({query:'harbor',signal:controller.signal}),failed=expect(query).rejects.toThrow('MEMORY_HISTORY_CANCELLED');await started;controller.abort();
 try{await Promise.resolve();expect(observed?.aborted).toBe(true)}finally{release();await failed;await native.close()}
});

it('close revokes synchronously and concurrent callers await the same head cleanup',async()=>{
 const f=await fixture();await f.native.capture();let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>entered=r),hold=new Promise<void>(r=>release=r);
 const original=f.history.prepareTranscriptChange;vi.spyOn(f.history,'prepareTranscriptChange').mockImplementation(async(...args)=>{entered();await hold;return original(...args)});
 const first=f.native.close();await started;let secondAcknowledged=false;const second=f.native.close().then(()=>{secondAcknowledged=true});
 try{await expect(f.native.capture()).rejects.toThrow('MEMORY_HISTORY_PROVIDER_DENIED');await new Promise<void>(setImmediate);expect(secondAcknowledged).toBe(false)}finally{release();await first;await second}
});

it('failed endpoint disposal waits for the other endpoint before releasing the session barrier',async()=>{
 const f=await fixture();let starts=0,entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>entered=r),hold=new Promise<void>(r=>release=r);
 const native=createNativeHistoryProvider({actorAuthority:f.authority,actorToken:f.actor,store:f.store,history:f.history,deadlineMs:1000,endpointFactory:async()=>{const endpoint=await f.endpointFactory(),ordinal=++starts;return {...endpoint,async dispose(){if(ordinal===1){await endpoint.dispose();throw Error('injected disposal')}entered();await hold;await endpoint.dispose()}}}});
 let acknowledged=false;const capture=native.capture().catch(error=>{acknowledged=true;throw error}),failed=expect(capture).rejects.toThrow('injected disposal');await started;let barrierEntered=false;const queued=f.store.withReadonlyBarrier('session-a',async()=>{barrierEntered=true});
 try{await new Promise<void>(setImmediate);expect(acknowledged).toBe(false);expect(barrierEntered).toBe(false)}finally{release();await failed;await queued;await native.close().catch(()=>undefined)}
});
it('fresh capture excludes removed user turns while keeping old evidence revoked',async()=>{
 const f=await fixture();await f.store.append('session-a',{id:'u2',kind:'user',turnId:'turn2',revision:1,payload:{text:'harbor tea'}});await f.store.checkpoint('session-a');await f.native.capture();const old=await f.native.query({query:'harbor'});if(old.status!=='queried')throw Error('expected queried');
 await f.native.beforeMutation('rewind');await f.store.append('session-a',{id:'rewind',kind:'turn_rewind',payload:{anchorUserTurnId:'turn',disposition:'keep_user',reason:'delete'}});await f.store.checkpoint('session-a');await f.native.capture();const current=await f.native.query({query:'harbor'});expect(current.status).toBe('queried');if(current.status==='queried')expect(current.result.hits).toHaveLength(1);expect(()=>readHistoryEvidence(f.authority,f.actor,old.result.evidence)).toThrow();
});
it('rewinding a completed turn keeps physical publication progress monotonic',async()=>{
 const f=await fixture();await f.store.append('session-a',{id:'assistant',kind:'assistant',payload:{role:'assistant',content:'harbor reply'}});await f.store.checkpoint('session-a');await f.native.capture();
 await f.native.beforeMutation('rewind');await f.store.append('session-a',{id:'rewind',kind:'turn_rewind',payload:{anchorUserTurnId:'turn',disposition:'keep_user',reason:'retry'}});await f.store.checkpoint('session-a');await expect(f.native.capture()).resolves.toMatchObject({status:'captured'});const q=await f.native.query({query:'harbor'});expect(q.status).toBe('queried');if(q.status==='queried'){expect(q.result.hits[0].document.revision).toBe(3);expect(q.result.hits[0].document.messages).toHaveLength(1)}
});
it('a new boot can reacquire unchanged files without inheriting the old evidence authority',async()=>{
 const f=await fixture();await f.native.capture();const old=await f.native.query({query:'harbor'});if(old.status!=='queried')throw Error('expected queried');await f.native.close();
 const authority=createMainActorAuthority({resolveActor:()=> 'actor-a'}),registry=createMainSourceRegistry(f.transport,{coordinate:authority.coordinate}),access=registry.authority.access('scope-a'),actor=authority.bindActor(access,f.provider.adapter,f.identity),history=createMainHistory({actorAuthority:authority,registry,transport:{...f.transport,historyCommand:async(c)=>f.repo.historyCommand(c)}});
 const native=createNativeHistoryProvider({actorAuthority:authority,actorToken:actor,store:f.store,history,endpointFactory:f.endpointFactory,deadlineMs:1000});await expect(native.capture()).resolves.toMatchObject({status:'captured'});expect((await native.query({query:'harbor'})).status).toBe('queried');expect(()=>readHistoryEvidence(authority,actor,old.result.evidence)).toThrow('MEMORY_HISTORY_EVIDENCE_DENIED');await native.close();
});
it('forget remains disabled after repository and Main restart without disabling another actor',async()=>{
 const f=await fixture();await f.native.capture();
 const fact=await f.active();await f.native.invalidate('forget');
 await f.policy.act(f.actor,await f.policy.event(f.actor,{kind:'forget',nonce:crypto.randomUUID(),factId:fact.factId,revision:1}));
 await f.native.close();f.reopen();
 await f.store.append('session-b',{id:'other-user',kind:'user',turnId:'other-turn',revision:1,payload:{text:'independent actor orchard'},at:2000});await f.store.checkpoint('session-b');
 const authority=createMainActorAuthority({resolveActor:(_scope,id)=>id.sessionId==='session-a'?'actor-a':'actor-b'});
 const registry=createMainSourceRegistry(f.historyTransport,{coordinate:authority.coordinate}),access=registry.authority.access('scope-a');
 const actor=authority.bindActor(access,f.provider.adapter,f.identity),other=authority.bindActor(access,f.provider.adapter,{...f.identity,sessionId:'session-b'});
 const history=createMainHistory({actorAuthority:authority,registry,transport:f.historyTransport});
 const native=(actorToken:object)=>createNativeHistoryProvider({actorAuthority:authority,actorToken,store:f.store,history,endpointFactory:f.endpointFactory,deadlineMs:1000});
 const forgotten=native(actor),independent=native(other),reads=f.reads;
 try{
  expect(await forgotten.capture()).toMatchObject({status:'captured'});expect(f.reads).toBeGreaterThan(reads);
  expect(await forgotten.query({query:'harbor'})).toMatchObject({status:'queried'});
  const entry=(await f.store.read('session-b')).entries[0],id={providerId:'synthetic',sessionId:'session-b',messageId:'other-turn'};f.provider.write(id,{text:'independent actor orchard',role:'user',trust:'direct-user-event',occurredAt:2000});const sourceRef=await registry.capture(access,f.provider.adapter,id);
  f.repo.contextCommand({kind:'historyUserOrigin',scopeKey:'scope-a',commandId:crypto.randomUUID(),body:{...f.owner,actorKey:'actor-b',sessionId:'session-b',sourceRef,entry}});
  expect(await independent.capture()).toMatchObject({status:'captured'});
  const result=await independent.query({query:'orchard'});expect(result.status).toBe('queried');if(result.status!=='queried')throw Error('expected queried');
  expect(result.result.hits.map(hit=>hit.document.sessionId)).toEqual(['session-b']);
  expect(result.result.hits[0].document.messages[0].text).toBe('independent actor orchard');
 }finally{await forgotten.close();await independent.close()}
});

it('a queued acquisition deadline rejects before the held S barrier is released',async()=>{
 const f=await fixture();let entered!:()=>void,release!:()=>void,queued!:()=>void;
 const started=new Promise<void>(r=>entered=r),hold=new Promise<void>(r=>release=r),admitted=new Promise<void>(r=>queued=r);
 const barrier=f.store.withReadonlyBarrier('session-a',async()=>{entered();await hold});await started;
 // capture performs async preflight before starting its acquisition deadline.
 // Observe real queue admission before advancing the same clock as that deadline.
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout','performance']});
 const native=createNativeHistoryProvider({actorAuthority:f.authority,actorToken:f.actor,history:f.history,endpointFactory:f.endpointFactory,deadlineMs:50,
  store:{withReadonlyBarrier:(id,run)=>{const pending=f.store.withReadonlyBarrier(id,run);queued();return pending}}});
 let settled=false;
 const outcome=native.capture().then(value=>{settled=true;return {value}},error=>{settled=true;return {error}});
 try{
  await Promise.race([admitted,outcome.then(()=>{throw Error('capture settled before queue admission')})]);
  await vi.advanceTimersByTimeAsync(49);expect(settled).toBe(false);expect(f.reads).toBe(0);
  await vi.advanceTimersByTimeAsync(1);expect(settled).toBe(true);
  expect(await outcome).toMatchObject({error:expect.objectContaining({message:'MEMORY_HISTORY_NATIVE_TIMEOUT'})});
  expect(f.reads).toBe(0);
  release();await barrier;await f.store.waitForIdle('session-a');
  expect(f.reads).toBe(0);expect(f.held).toBe(0);
 }finally{
  try{release();await barrier;await f.store.waitForIdle('session-a');await outcome;await native.close()}
  finally{vi.useRealTimers()}
 }
});

it('invalidation waits for an in-flight endpoint factory to finish exact cleanup',async()=>{
 const f=await fixture();let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>entered=r),hold=new Promise<void>(r=>release=r);let disposed=false;
 const native=createNativeHistoryProvider({actorAuthority:f.authority,actorToken:f.actor,store:f.store,history:f.history,deadlineMs:1000,endpointFactory:async()=>{const endpoint=await f.endpointFactory();entered();await hold;return {...endpoint,async dispose(){await endpoint.dispose();disposed=true}}}});
 const capture=native.capture(),failed=expect(capture).rejects.toThrow('MEMORY_HISTORY_CANCELLED');await started;let acknowledged=false;const invalidated=native.invalidate('root-change').then(()=>{acknowledged=true});
 try{await new Promise<void>(setImmediate);expect(acknowledged).toBe(false)}finally{release();await failed;await invalidated;expect(disposed).toBe(true);await native.close()}
});

it('invalidation propagates cleanup failures from an endpoint returned after revoke',async()=>{
 const f=await fixture();let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>entered=r),hold=new Promise<void>(r=>release=r);
 const native=createNativeHistoryProvider({actorAuthority:f.authority,actorToken:f.actor,store:f.store,history:f.history,deadlineMs:1000,endpointFactory:async()=>{const endpoint=await f.endpointFactory();entered();await hold;return {...endpoint,async dispose(){await endpoint.dispose();throw Error('late dispose fault')}}}});
 const capture=native.capture(),failed=expect(capture).rejects.toThrow('late dispose fault');await started;const invalidated=native.invalidate('root-change'),cleanupFailed=expect(invalidated).rejects.toThrow('late dispose fault');release();await failed;await cleanupFailed;await native.close();
});

it('one late cleanup failure cannot acknowledge invalidation while another operation is pending',async()=>{
 const f=await fixture();let starts=0,entered=0,ready!:()=>void;const both=new Promise<void>(r=>ready=r);const releases:Array<()=>void>=[];
 const native=createNativeHistoryProvider({actorAuthority:f.authority,actorToken:f.actor,store:{withReadonlyBarrier:(_id,run)=>run()},history:f.history,deadlineMs:1000,endpointFactory:async()=>{const endpoint=await f.endpointFactory();if(++starts<=2)return endpoint;const ordinal=++entered;await new Promise<void>(r=>{releases.push(r);if(entered===2)ready()});return {...endpoint,async dispose(){await endpoint.dispose();if(ordinal===1)throw Error('first cleanup fault')}}}});
 await native.capture();const first=native.query({query:'harbor'}),second=native.query({query:'harbor'}),firstFailed=expect(first).rejects.toThrow('first cleanup fault'),secondFailed=expect(second).rejects.toThrow();await both;let acknowledged=false;const invalidated=native.invalidate('root-change').finally(()=>{acknowledged=true}),cleanupFailed=expect(invalidated).rejects.toThrow('first cleanup fault');
 releases[0]();try{await firstFailed;await new Promise<void>(setImmediate);expect(acknowledged).toBe(false)}finally{releases[1]();await secondFailed;await cleanupFailed;await native.close()}
});

it('invalidation still waits exact live operation cleanup when captured-head cleanup rejects',async()=>{
 const f=await fixture();let failHeads=false,starts=0,entered!:()=>void,release!:()=>void;
 const started=new Promise<void>(r=>entered=r),hold=new Promise<void>(r=>release=r);
 const history={...f.history,prepareTranscriptChange:async(...args:Parameters<typeof f.history.prepareTranscriptChange>)=>{if(failHeads)throw Error('HEAD_CLEANUP_FAILED');return f.history.prepareTranscriptChange(...args)}};
 const native=createNativeHistoryProvider({actorAuthority:f.authority,actorToken:f.actor,store:f.store,history,deadlineMs:1000,endpointFactory:async()=>{const endpoint=await f.endpointFactory();if(++starts===3){entered();await hold}return endpoint}});
 await native.capture();const query=native.query({query:'harbor'}),queryFailed=expect(query).rejects.toThrow();await started;
 failHeads=true;let acknowledged=false;const invalidation=native.invalidate('root-change').catch(error=>{acknowledged=true;return error.message});
 try{await new Promise<void>(setImmediate);expect(acknowledged).toBe(false)}
 finally{release();await queryFailed;expect(await invalidation).toBe('HEAD_CLEANUP_FAILED');failHeads=false;await native.close()}
});

it('head cleanup failure cannot acknowledge invalidation before a late factory finishes disposal',async()=>{
 const f=await fixture();let starts=0,entered!:()=>void,release!:()=>void,disposed=false;
 const started=new Promise<void>(r=>entered=r),hold=new Promise<void>(r=>release=r);
 const native=createNativeHistoryProvider({actorAuthority:f.authority,actorToken:f.actor,store:f.store,history:f.history,deadlineMs:1000,endpointFactory:async()=>{const endpoint=await f.endpointFactory();if(++starts<=2)return endpoint;entered();await hold;return {...endpoint,async dispose(){await endpoint.dispose();disposed=true}}}});
 await native.capture();vi.spyOn(f.history,'prepareTranscriptChange').mockRejectedValue(Error('head cleanup fault'));
 const query=native.query({query:'harbor'}),queryFailed=expect(query).rejects.toThrow('head cleanup fault');await started;
 let acknowledged=false;const invalidated=native.invalidate('root-change').finally(()=>{acknowledged=true}),cleanupFailed=expect(invalidated).rejects.toThrow('head cleanup fault');
 try{await new Promise<void>(setImmediate);expect(acknowledged).toBe(false)}finally{release();await queryFailed;await cleanupFailed;expect(disposed).toBe(true);await native.close().catch(()=>undefined)}
});
it('a captured-head failure still settles later heads before invalidation acknowledges',async()=>{
 const f=await fixture();await f.store.append('session-a',{id:'u2',kind:'user',turnId:'turn2',revision:1,payload:{text:'harbor tea'},at:2000});await f.store.checkpoint('session-a');await f.bindUsers();
 let failHeads=false,calls=0,release!:()=>void;const hold=new Promise<void>(r=>release=r);
 const history={...f.history,prepareTranscriptChange:async(...args:Parameters<typeof f.history.prepareTranscriptChange>)=>{if(failHeads){if(++calls===1)throw Error('FIRST_HEAD_FAILED');await hold}return f.history.prepareTranscriptChange(...args)}};
 const native=createNativeHistoryProvider({actorAuthority:f.authority,actorToken:f.actor,store:f.store,history,endpointFactory:f.endpointFactory,deadlineMs:1000});
 expect(await native.capture()).toMatchObject({captured:2});const refs=f.commands.filter(c=>c.kind==='put').map(c=>c.body.document.transcriptRef);
 const baseline=(ref:typeof refs[number])=>f.transport.contextCommand({kind:'baseline',scopeKey:'scope-a',body:{actorKey:'actor-a',providerId:'synthetic',sessionId:'session-a',bootId:f.authority.bootId,sourceRefs:[],factRefs:[],transcriptRefs:[ref]}});
 await baseline(refs[1]);failHeads=true;let acknowledged=false;const invalidated=native.invalidate('root-change').catch(error=>{acknowledged=true;return error.message});
 try{await new Promise<void>(setImmediate);expect(calls).toBe(2);expect(acknowledged).toBe(false);release();expect(await invalidated).toBe('FIRST_HEAD_FAILED');await expect(baseline(refs[1])).rejects.toThrow('MEMORY_CONTEXT_TRANSCRIPT_PENDING')}
 finally{release();await invalidated;failHeads=false;await native.close()}
});
it('keeps unrelated proven native history available following correction',async()=>{
 const f=await fixture();await f.native.capture();const fact=await f.active(),edit=await f.source('I prefer powershell');
 await f.policy.act(f.actor,await f.policy.event(f.actor,{kind:'correct',nonce:crypto.randomUUID(),factId:fact.factId,revision:1,sourceRef:edit.ref}));
 const reads=f.reads,puts=f.commands.filter(c=>c.kind==='put').length;
 expect(await f.native.capture()).toMatchObject({status:'captured',coverage:'complete'});
 expect(f.reads).toBeGreaterThan(reads);expect(f.commands.filter(c=>c.kind==='put').length).toBeGreaterThan(puts);
});
