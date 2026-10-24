import {DatabaseSync} from 'node:sqlite';
import {RecordCodec} from '../memory-core/record-codec';
import {expect,it} from 'vitest';
import {contextFixture} from '../../../scripts/verify/memory-context/context-fixture';
import {createMainHistory,createMainHistoryProvider} from '../memory-history/main-history';
import {parseFireflyHistoryBytes} from '../memory-history/firefly-history-reader';
import {createMainTranscriptProvider} from './main-transcript-provider';
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
it.each(['missing-s','missing-h','extra','duplicate','wrong-ref','wrong-operation','other-boot'])('response union denies %s',async(kind)=>{
 const f=await fixture();let refs=f.refs.map(r=>({...r})),op=f.operationId;
 if(kind==='missing-s')refs=refs.slice(1);if(kind==='missing-h')refs.pop();if(kind==='extra')refs.push({...refs[0],headId:'unselected-head'});if(kind==='duplicate')refs=refs.map(()=>refs[0]);if(kind==='wrong-ref')refs[0].revision++;if(kind==='wrong-operation')op='other-operation';
 if(kind==='other-boot')await expect(f.transport.contextCommand({kind:'validateResponse',scopeKey:'scope-a',body:{actorKey:'actor-a',providerId:'synthetic',sessionId:'session-a',bootId:'other-boot',snapshotId:f.snapshot.snapshotId,responseProgress:{operationId:op,expectedRefs:refs}}})).rejects.toThrow();
 else await expect(f.response(refs,op)).rejects.toThrow();
});

function mutate(f:Awaited<ReturnType<typeof fixture>>,table:'context_records'|'history_records',type:string,id:string|undefined,change:(record:any)=>void){
 const db=new DatabaseSync(f.databasePath),codec=new RecordCodec(f.key);
 try{const row=(id?db.prepare('SELECT id,payload FROM '+table+' WHERE id=?').get(id):db.prepare('SELECT id,payload FROM '+table+' LIMIT 1').get())!;
 const record=codec.open<any>(type,'scope-a',row.id as string,row.payload);change(record);db.prepare('UPDATE '+table+' SET payload=? WHERE id=?').run(codec.seal(type,'scope-a',row.id as string,record),row.id);
 }finally{db.close()}
}
it('unclaimed snapshot never obtains response pending exception',async()=>{const f=await fixture({claim:false});await expect(f.response()).rejects.toThrow('MEMORY_CONTEXT_RESPONSE_UNSENT')});
it.each(['ready','deleted','missing','wrong-old-ref'])('selected pending H head rejects %s',async(kind)=>{
 const f=await fixture(),ref=f.refs.at(-1)!;
 if(kind==='missing'){const db=new DatabaseSync(f.databasePath);try{db.prepare('DELETE FROM context_records WHERE id=?').run(ref.headId)}finally{db.close()}}
 else mutate(f,'context_records','context-transcript',ref.headId,head=>{if(kind==='wrong-old-ref')head.ref.revision++;else head.state=kind});
 await expect(f.response()).rejects.toThrow();
});
it.each(['incarnation','revision','digest','body','deleted'])('correct receipt still rejects selected document %s changes',async(kind)=>{
 const f=await fixture();mutate(f,'history_records','history-document',undefined,doc=>{if(kind==='incarnation')doc.incarnation='different';if(kind==='revision')doc.revision++;if(kind==='digest')doc.digest='0'.repeat(64);if(kind==='body')doc.messages[0].text='changed';if(kind==='deleted')doc.state='deleted'});
 await expect(f.response()).rejects.toThrow();
});
it('forget after reservation still rejects original generation under correct receipt',async()=>{const f=await fixture(),fact=await f.active();await f.forget(fact.factId!);await expect(f.response()).rejects.toThrow('MEMORY_CONTEXT_STALE')});
it.each(['last-stale','duplicate','after-first-reserve'])('combined reserve %s rolls back every head',async(kind)=>{
 const f=await fixture({reserve:false});let refs=f.refs.map(r=>({...r}));
 if(kind==='last-stale')refs.at(-1)!.revision++;if(kind==='duplicate')refs.push(refs[0]);if(kind==='after-first-reserve')f.setFault(true,'transcriptReserveBatch',1);
 await expect(f.call('transcriptReserveBatch',{generation:f.snapshot.generation,operationId:f.operationId,expectedRefs:refs},'failing-reserve')).rejects.toThrow();f.setFault(false);
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
it.each(['actor','provider','session','partition','extra-flag'])('claimed response rejects %s forgery',async kind=>{
 const f=await fixture();
 if(kind==='extra-flag')await expect(f.call('validateResponse',{snapshotId:f.snapshot.snapshotId,responseProgress:{operationId:f.operationId,expectedRefs:f.refs,allowStale:true}})).rejects.toThrow();
 else {
  mutate(f,'context_records','context-snapshot',f.snapshot.snapshotId,snapshot=>{if(kind==='actor')snapshot.actorKey='other-actor';if(kind==='provider')snapshot.historyDeps[0].providerId='other-provider';if(kind==='session')snapshot.historyDeps[0].sessionId='other-session';if(kind==='partition')snapshot.historyDeps[0].partition.actorKey='other-actor'});
  await expect(f.response()).rejects.toThrow();
 }
});
