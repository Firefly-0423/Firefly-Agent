import {DatabaseSync} from 'node:sqlite';
import {RecordCodec} from '../core/record-codec';
import {expect,it} from 'vitest';
import {contextFixture} from '../../../../scripts/verify/memory-context/context-fixture';
import {createMainHistory,createMainHistoryProvider} from '../history/main-history';
import {parseFireflyHistoryBytes} from '../history/firefly-history-reader';
import {createMainTranscriptProvider} from '../history/main-transcript-provider';
function records(f:{databasePath:string}){
 const db=new DatabaseSync(f.databasePath,{readOnly:true});
 try{return {context:db.prepare('SELECT id,payload FROM context_records ORDER BY id').all().map(r=>({...r})),history:db.prepare('SELECT id,payload FROM history_records ORDER BY id').all().map(r=>({...r}))}}finally{db.close()}
}
// A denied response check is read-only: every stored context and history record must be byte-identical afterwards.
async function denies(f:{databasePath:string},run:()=>Promise<unknown>,code:string){
 const before=records(f);
 expect(before.context.length).toBeGreaterThan(0);
 await expect(run()).rejects.toThrow(code);
 expect(records(f)).toEqual(before);
}
async function fixture(options:{reserve?:boolean;claim?:boolean;generic?:boolean}={}){
 const f=await contextFixture(),transport={...f.transport,historyCommand:async(c:any)=>f.repo.historyCommand(c)};
 const history=createMainHistory({actorAuthority:f.actorAuthority,registry:f.registry,transport});
 const row={id:'history-user',seq:1,at:1000,kind:'user',turnId:'history-turn',revision:1,payload:{text:'coffee harbor'}};
 if(!options.generic){const id={...f.identity,messageId:row.turnId};f.provider.write(id,{text:row.payload.text,role:'user',trust:'direct-user-event',occurredAt:row.at});const sourceRef=await f.registry.capture(f.access,f.provider.adapter,id);await f.context.recordHistoryUser(f.actor,sourceRef,row as any)}
 const parsed=parseFireflyHistoryBytes({root:f.root,actorKey:'actor-a',scopeKey:'scope-a',sessions:[{providerId:'synthetic',sessionId:'session-a'}]},[{providerId:'synthetic',sessionId:'session-a',incarnation:'native-'+ '1'.repeat(64),transcript:Buffer.from(JSON.stringify(row)+'\n'),snapshot:Buffer.from(JSON.stringify({schemaVersion:1,throughSeq:1,entries:[row],seenEntryIds:[row.id],seenUserRevisions:[row.turnId+"\u0000"+String(row.revision)]})),chat:null}]);
 const source=options.generic?await f.source('coffee harbor'):undefined;
 const document=source?{id:'history-document',incarnation:'history-v1',revision:1,origin:'canonical' as const,sourceDeps:[{sourceRef:source.ref,subjectKeys:null,derivedRefs:null}],messages:[{id:source.id.messageId,role:'user' as const,text:'coffee harbor',occurredAt:null,timeZone:null,sourceRef:source.ref}],vector:null}:parsed.documents[0].document;
 const h=createMainHistoryProvider(f.actorAuthority,f.actor,{withLease:async(_id,run)=>run(async()=>structuredClone(document))});
 const captured=await history.captureTranscript(f.actor,h,document.id);
 const queried=await history.query(f.actor,{query:'coffee'});
 const provider=createMainTranscriptProvider({scopeKey:'scope-a',providerId:'synthetic',sessionId:'session-a',withLease:async(id,run)=>run(async()=>({incarnation:'s-v1',revision:1,throughSeq:1,sourceRefs:[],unit:{id,kind:'recent',messages:[{role:'user',text:'synthetic question'}]}}))});
 const s=await f.context.captureTranscript(f.actor,provider,'s-turn'),snapshot=await f.context.assemble(f.actor,{sessionId:'session-a',sourceRefs:[],transcriptTokens:[s],historyTokens:[queried.evidence]});
 if(options.claim!==false)await f.context.dispatch(f.actor,await f.context.validateForDispatch(f.actor,snapshot),()=>'sent');
 const stored=(f.commands as any[]).findLast(c=>c.kind==='snapshot').body;
 const hRef=(await transport.historyCommand({kind:'validate',scopeKey:'scope-a',body:{actorKey:'actor-a',providerId:'synthetic',sessionId:'session-a',dependencies:queried.hits.map(h=>h.dependency)}}) as any).documents[0].transcriptRef;
 const refs=[...stored.transcriptRefs,...stored.guardRefs,...(options.generic?[]:[hRef])],operationId='response-operation';
 const call=(kind:string,body:any,commandId?:string)=>f.transport.contextCommand({kind,scopeKey:'scope-a',...(commandId?{commandId}:{}),body:{actorKey:'actor-a',providerId:'synthetic',sessionId:'session-a',bootId:stored.bootId,...body}});
 if(options.reserve!==false)await call('transcriptReserveBatch',{generation:snapshot.generation,operationId,expectedRefs:refs},'reserve-response');
 return {...f,history,queried,captured,stored,snapshot,refs,hRef,source,operationId,call,response:(expectedRefs=refs,op=operationId)=>call('validateResponse',{snapshotId:snapshot.snapshotId,responseProgress:{operationId:op,expectedRefs}})};
}
it('claimed response validates exact selected H and S pending union while ordinary H remains denied',async()=>{
 const f=await fixture();await expect(f.response()).resolves.toEqual({valid:true});
 await expect(Promise.resolve().then(()=>f.repo.historyCommand({kind:'validate',scopeKey:'scope-a',body:{actorKey:'actor-a',providerId:'synthetic',sessionId:'session-a',dependencies:f.queried.hits.map(h=>h.dependency)}}))).rejects.toThrow('MEMORY_CONTEXT_TRANSCRIPT_PENDING');
});
it.each([['missing-s','MEMORY_CONTEXT_RESPONSE_PROGRESS_DENIED'],['missing-h','MEMORY_CONTEXT_RESPONSE_PROGRESS_DENIED'],['extra','MEMORY_CONTEXT_RESPONSE_PROGRESS_DENIED'],['duplicate','MEMORY_CONTEXT_RESPONSE_PROGRESS_DENIED'],['wrong-ref','MEMORY_CONTEXT_RESPONSE_PROGRESS_DENIED'],['wrong-operation','MEMORY_CONTEXT_RESPONSE_PROGRESS_STALE'],['other-boot','MEMORY_CONTEXT_ACCESS_DENIED']])('response union denies %s with %s',async(kind,code)=>{
 const f=await fixture();let refs=f.refs.map(r=>({...r})),op=f.operationId;
 if(kind==='missing-s')refs=refs.slice(1);if(kind==='missing-h')refs.pop();if(kind==='extra')refs.push({...refs[0],headId:'unselected-head'});if(kind==='duplicate')refs=refs.map(()=>refs[0]);if(kind==='wrong-ref')refs[0].revision++;if(kind==='wrong-operation')op='other-operation';
 if(kind==='other-boot')await denies(f,()=>f.transport.contextCommand({kind:'validateResponse',scopeKey:'scope-a',body:{actorKey:'actor-a',providerId:'synthetic',sessionId:'session-a',bootId:'other-boot',snapshotId:f.snapshot.snapshotId,responseProgress:{operationId:op,expectedRefs:refs}}}),code);
 else await denies(f,()=>f.response(refs,op),code);
});

function mutate(f:Awaited<ReturnType<typeof fixture>>,table:'context_records'|'history_records',type:string,id:string|undefined,change:(record:any)=>void){
 const db=new DatabaseSync(f.databasePath),codec=new RecordCodec(f.key);
 try{const row=(id?db.prepare('SELECT id,payload FROM '+table+' WHERE id=?').get(id):db.prepare('SELECT id,payload FROM '+table+' LIMIT 1').get())!;
 const record=codec.open<any>(type,'scope-a',row.id as string,row.payload);change(record);db.prepare('UPDATE '+table+' SET payload=? WHERE id=?').run(codec.seal(type,'scope-a',row.id as string,record),row.id);
 }finally{db.close()}
}
it('unclaimed snapshot never obtains response pending exception',async()=>{const f=await fixture({claim:false});await expect(f.response()).rejects.toThrow('MEMORY_CONTEXT_RESPONSE_UNSENT')});
it.each([['ready','MEMORY_CONTEXT_RESPONSE_PROGRESS_STALE'],['deleted','MEMORY_CONTEXT_RESPONSE_PROGRESS_STALE'],['missing','MEMORY_CONTEXT_RESPONSE_PROGRESS_STALE'],['wrong-old-ref','MEMORY_CONTEXT_RESPONSE_PROGRESS_STALE']])('selected pending H head rejects %s with %s',async(kind,code)=>{
 const f=await fixture(),ref=f.refs.at(-1)!;
 if(kind==='missing'){const db=new DatabaseSync(f.databasePath);try{db.prepare('DELETE FROM context_records WHERE id=?').run(ref.headId)}finally{db.close()}}
 else mutate(f,'context_records','context-transcript',ref.headId,head=>{if(kind==='wrong-old-ref')head.ref.revision++;else head.state=kind});
 await denies(f,()=>f.response(),code);
});
it.each([['incarnation','MEMORY_DATA_INVALID'],['revision','MEMORY_DATA_INVALID'],['digest','MEMORY_DATA_INVALID'],['body','MEMORY_HISTORY_SOURCE_MISMATCH'],['deleted','MEMORY_HISTORY_STALE']])('correct receipt still rejects selected document %s changes with %s',async(kind,code)=>{
 const f=await fixture();mutate(f,'history_records','history-document',undefined,doc=>{if(kind==='incarnation')doc.incarnation='different';if(kind==='revision')doc.revision++;if(kind==='digest')doc.digest='0'.repeat(64);if(kind==='body')doc.messages[0].text='changed';if(kind==='deleted')doc.state='deleted'});
 await denies(f,()=>f.response(),code);
});
it('forget after reservation still rejects original generation under correct receipt',async()=>{const f=await fixture(),fact=await f.active();await f.forget(fact.factId!);await expect(f.response()).rejects.toThrow('MEMORY_CONTEXT_STALE')});
it.each([['last-stale','MEMORY_CONTEXT_TRANSCRIPT_STALE'],['duplicate','MEMORY_CONTEXT_INPUT_INVALID'],['after-first-reserve','SUMMARY_INJECTED_FAULT']])('combined reserve %s fails with %s and rolls back every head',async(kind,code)=>{
 const f=await fixture({reserve:false});let refs=f.refs.map(r=>({...r}));
 if(kind==='last-stale')refs.at(-1)!.revision++;if(kind==='duplicate')refs.push(refs[0]);if(kind==='after-first-reserve')f.setFault(true,'transcriptReserveBatch',1);
 await expect(f.call('transcriptReserveBatch',{generation:f.snapshot.generation,operationId:f.operationId,expectedRefs:refs},'failing-reserve')).rejects.toThrow(code);f.setFault(false);
 await expect(f.call('baseline',{sourceRefs:[],factRefs:[],transcriptRefs:f.refs})).resolves.toMatchObject({generation:f.snapshot.generation});
});

it('same-session ordinary source-backed H remains current and never joins response pending union',async()=>{
 const f=await fixture({generic:true});await expect(f.response()).resolves.toEqual({valid:true});
 await f.call('transcriptReserveBatch',{generation:f.snapshot.generation,operationId:f.operationId,expectedRefs:[f.hRef]},'generic-h-pending');
 await expect(f.response([...f.refs,f.hRef])).rejects.toThrow('MEMORY_CONTEXT_TRANSCRIPT_PENDING');
});
it('ordinary source-backed H source mutation still rejects response despite valid S receipt',async()=>{
 const f=await fixture({generic:true});await f.registry.prepareChange(f.access,f.provider.adapter,f.source!.ref);await expect(f.response()).rejects.toThrow('MEMORY_SOURCE_PENDING');
});
it.each([['actor','MEMORY_CONTEXT_ACCESS_DENIED'],['provider','MEMORY_HISTORY_ACCESS_DENIED'],['session','MEMORY_HISTORY_ACCESS_DENIED'],['partition','MEMORY_HISTORY_ACCESS_DENIED'],['extra-flag','MEMORY_INPUT_INVALID']])('claimed response rejects %s forgery with %s',async(kind,code)=>{
 const f=await fixture();
 if(kind==='extra-flag')await denies(f,()=>f.call('validateResponse',{snapshotId:f.snapshot.snapshotId,responseProgress:{operationId:f.operationId,expectedRefs:f.refs,allowStale:true}}),code);
 else {
  mutate(f,'context_records','context-snapshot',f.snapshot.snapshotId,snapshot=>{if(kind==='actor')snapshot.actorKey='other-actor';if(kind==='provider')snapshot.historyDeps[0].providerId='other-provider';if(kind==='session')snapshot.historyDeps[0].sessionId='other-session';if(kind==='partition')snapshot.historyDeps[0].partition.actorKey='other-actor'});
  await denies(f,()=>f.response(),code);
 }
});
