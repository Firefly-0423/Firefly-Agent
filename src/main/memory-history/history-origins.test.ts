import {afterEach,it,expect} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {recallFixture} from '../../../scripts/verify/memory-recall/recall-fixture';
import {canonicalJson} from '../memory-core/repository-types';
import {createMainContext} from '../memory-context/main-context';
import {HistoryOrigins} from './history-origins';
import {initializeSchema} from '../memory-core/schema';
const fixtures:ReturnType<typeof recallFixture>[]=[];
const hash=(v:unknown)=>createHash('sha256').update(canonicalJson(v)).digest('hex');
function fixture(){const f=recallFixture();fixtures.push(f);return f}
afterEach(()=>{for(const f of fixtures.splice(0))f.close()});
async function origin(f:ReturnType<typeof fixture>,sessionId:string,text:string){
 const identity={providerId:'synthetic',sessionId,messageId:randomUUID()};f.provider.write(identity,{text,role:'user',trust:'direct-user-event',occurredAt:100});
 const sourceRef=await f.registry.capture(f.access,f.provider.adapter,identity),entry={id:'entry-'+identity.messageId,seq:1,at:100,kind:'user',turnId:identity.messageId,revision:1,payload:{text}};
 f.repo.contextCommand({kind:'historyUserOrigin',scopeKey:'scope-a',commandId:randomUUID(),body:{...f.owner,sessionId,sourceRef,entry}});
 return {entry,sourceRef,owner:{actorKey:'actor-a',providerId:'synthetic',sessionId},event:{originalId:entry.id,seq:1,turnId:entry.turnId,revision:1,originalRole:'user',digest:hash(entry)}};
}
function valid(f:ReturnType<typeof fixture>,o:Awaited<ReturnType<typeof origin>>,extra={}){return f.repo.historyCommand({kind:'originStatus',scopeKey:'scope-a',body:{...o.owner,event:o.event,...extra}})}
it('creates the metadata-only origin table without exposing message bodies',async()=>{
 const f=fixture();await origin(f,'session-b','PRIVATE_ORIGIN_CANARY');const db=new DatabaseSync(f.databasePath,{readOnly:true});
 try{expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(12);const rows=db.prepare('SELECT payload FROM history_origins').all();expect(rows).toHaveLength(1);expect(Buffer.from(rows[0].payload as Uint8Array).toString()).not.toContain('PRIVATE_ORIGIN_CANARY')}finally{db.close()}
});
it('upgrades v11 atomically without rewriting old fact ciphertext and rolls back an interrupted migration',async()=>{
 const f=fixture();await f.active('I prefer English');f.repo.close();const db=new DatabaseSync(f.databasePath);
 try{const metadata=db.prepare('SELECT database_id FROM memory_metadata').get()!,before=db.prepare('SELECT payload FROM current_facts').all();db.exec('DROP TABLE history_origins; PRAGMA user_version=11');
  db.exec('CREATE VIEW history_origins AS SELECT id FROM current_facts');expect(()=>initializeSchema(db,metadata.database_id as string)).toThrow();expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(11);expect(db.prepare('SELECT payload FROM current_facts').all()).toEqual(before);
  db.exec('DROP VIEW history_origins');initializeSchema(db,metadata.database_id as string);expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(12);expect(db.prepare('SELECT payload FROM current_facts').all()).toEqual(before);
 }finally{db.close()}f.reopen();expect(await f.policy.recall(f.actor)).toHaveLength(1);
});
it('retains two independent pre-correction session origins across correction, forget and reopen',async()=>{
 const f=fixture(),a=await f.active("I prefer English"),b=await origin(f,'session-b','harbor cat'),c=await origin(f,'session-c','harbor dog');
 const correction=await f.source('I prefer Chinese');await f.policy.act(f.actor,await f.policy.event(f.actor,{kind:'correct',nonce:randomUUID(),factId:a.factId,revision:1,sourceRef:correction.ref}));
 expect(valid(f,b)).toEqual({valid:true});expect(valid(f,c)).toEqual({valid:true});
 await f.policy.act(f.actor,await f.policy.event(f.actor,{kind:'forget',nonce:randomUUID(),factId:a.factId,revision:2}));f.reopen();
 expect(valid(f,b)).toEqual({valid:true});expect(valid(f,c)).toEqual({valid:true});
});
it('does not accept changed bytes, foreign actors, unknown events, or a pending source',async()=>{
 const f=fixture(),o=await origin(f,'session-b','cat');expect(valid(f,o,{event:{...o.event,digest:hash('changed')}})).toEqual({valid:false});expect(valid(f,o,{actorKey:'other'})).toEqual({valid:false});
 await f.registry.prepareChange(f.access,f.provider.adapter,o.sourceRef);expect(valid(f,o)).toEqual({valid:false});
});
it('freezes a claimed source-only response closure and rejects its echo after forgetting',async()=>{
 const f=fixture(),a=await f.active('I prefer English');
 const identity={providerId:'synthetic',model:'fixture',transport:'synthetic',framingVersion:'v1'};
 const prepare=(units:any[])=>({...identity,inputTypes:['text'],body:{messages:units.flatMap(u=>u.messages)}});
 let bootId="";const transport={contextCommand:async(c:any)=>{if(c.kind==="snapshot")bootId=c.body.bootId;return f.transport.contextCommand(c)}};
 const context=createMainContext({actorAuthority:f.authority,registry:f.registry,transport,clock:f.now,counter:{capability:{...identity,mode:'exact',inputTypes:['text']},count:async()=>100},budget:{maxContextTokens:20000,reservedOutputTokens:64,safetyMarginTokens:0,maxSTokens:10000,minRecentCompleteTurns:1},prepare,prepareS:prepare});
 const snapshot=await context.assemble(f.actor,{sessionId:'session-a',sourceRefs:[a.ref]});
 const entry={id:'answer-1',seq:2,at:101,kind:'assistant',turnId:'answer-turn',payload:{role:'assistant',content:'echo English'}};
 const command=()=>f.repo.contextCommand({kind:'historyResponseOrigin',scopeKey:'scope-a',commandId:randomUUID(),body:{...f.owner,bootId,snapshotId:snapshot.snapshotId,entry}});
 expect(command).toThrow();const permit=await context.validateForDispatch(f.actor,snapshot);await context.dispatch(f.actor,permit,()=> 'ok');expect(command()).toEqual({recorded:true});
 const event={originalId:entry.id,seq:2,turnId:entry.turnId,revision:null,originalRole:'assistant',digest:hash(entry)};
 const status=()=>f.repo.historyCommand({kind:'originStatus',scopeKey:'scope-a',body:{actorKey:'actor-a',providerId:'synthetic',sessionId:'session-a',event}});
 expect(status()).toEqual({valid:true});f.reopen();expect(status()).toEqual({valid:true});
 await f.policy.act(f.actor,await f.policy.event(f.actor,{kind:'forget',nonce:randomUUID(),factId:a.factId,revision:1}));expect(status()).toEqual({valid:false});
});
it('revokes a deleted or rewound assistant origin and every cross-session descendant',async()=>{
 const f=fixture(),root=await origin(f,'session-b','safe root'),db=new DatabaseSync(f.databasePath),ledger=new HistoryOrigins(db,f.key);
 const b={...root.owner,event:{originalId:'b-output',seq:2,turnId:'b-turn',revision:null,originalRole:'assistant' as const,digest:hash('b')}},a={...root.owner,sessionId:'session-c',event:{...b.event,originalId:'a-output',digest:hash('a')}};
 try{db.exec('BEGIN IMMEDIATE');ledger.recordResponse('scope-a',b,b.event,'snapshot-b',{sources:[],events:[{...root.owner,event:root.event}],complete:true});ledger.recordResponse('scope-a',a,a.event,'snapshot-a',{sources:[],events:[b],complete:true});db.exec('COMMIT');
  const status=()=>f.repo.historyCommand({kind:'originStatus',scopeKey:'scope-a',body:{actorKey:a.actorKey,providerId:a.providerId,sessionId:a.sessionId,event:a.event}});expect(status()).toEqual({valid:true});
  f.repo.historyCommand({kind:'retireOrigins',scopeKey:'scope-a',commandId:randomUUID(),body:{...root.owner,mutation:'append',entry:{kind:'turn_rewind',payload:{anchorUserTurnId:root.entry.turnId,disposition:'keep_user'}}}});
  expect(valid(f,root)).toEqual({valid:true});expect(status()).toEqual({valid:false});f.reopen();expect(status()).toEqual({valid:false});
 }finally{db.close()}
});
