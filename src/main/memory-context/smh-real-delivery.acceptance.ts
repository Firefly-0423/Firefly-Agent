import {it,expect} from 'vitest';
import {execFile} from 'node:child_process';
import fs from 'node:fs';import path from 'node:path';
// Explicit local NTFS synthetic resources only. This never discovers application userData.
const resources=['FF_HISTORY_TEST_ROOT','FF_SMH_MODELS_ROOT','FF_HISTORY_HELPER','FF_SMH_DELIVERY_EVIDENCE'] as const;
for(const key of resources){const value=process.env[key];if(!value||!path.isAbsolute(value)||!/^E:[\\/]/i.test(value))throw Error('SMH_EXPLICIT_E_SYNTHETIC_RESOURCES_REQUIRED')}
const driver=String.raw`const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),{spawn}=require('node:child_process');
const base=path.join(process.cwd(),'dist/main/main'),load=p=>require(path.join(base,p+'.js'));
const root=process.env.FF_HISTORY_TEST_ROOT,modelRoot=process.env.FF_SMH_MODELS_ROOT,helper=process.env.FF_HISTORY_HELPER,evidence=process.env.FF_SMH_DELIVERY_EVIDENCE;
if(![root,modelRoot,helper,evidence].every(p=>p&&path.isAbsolute(p)&&/^E:[\\/]/i.test(p))||path.resolve(os.tmpdir())!==path.resolve(root))throw Error('EXPLICIT_E_SYNTHETIC_RESOURCES_REQUIRED');
globalThis.fetch=()=>{throw Error('EXTERNAL_NETWORK_FORBIDDEN')};
const isolation=fs.mkdtempSync(path.join(root,'smh-real-delivery-'));
let f,adapter,nativeA,nativeB;
(async()=>{
 const {createLocalEmbeddingProvider}=load('rag/embedding'),{createStandardReranker}=load('rag/reranker');
 const embedding=createLocalEmbeddingProvider('bgem3');assert.ok(embedding);
 // Exercise the two complete initializations concurrently under their shared global-env lock.
 const [_,reranker]=await Promise.all([embedding.embed('本地模型合成测试'),createStandardReranker()]);
 const {initializeStorageContext}=load('storage-context'),{resolveRuntimeProfile}=load('runtime-profile');
 const storage=initializeStorageContext(resolveRuntimeProfile({argv:['--firefly-profile=test','--firefly-isolation-root='+isolation],env:{},isPackaged:false,productionAppData:path.join(root,'smh-unopened-production')}));
 f=load('memory-context/smh-fixture.test-support').createSmhFixture(path.join(isolation,'fixture'),{clock:()=>1700000000010});
 const {ConversationTranscriptStore}=load('orchestrator/conversation-transcript-store'),{createTranscriptSink}=load('orchestrator/transcript-sink');
 const store=new ConversationTranscriptStore(storage.dataRoot),sourceRoot=path.join(storage.dataRoot,'transcripts');
 await store.append('session-a',{id:'old-drink',kind:'user',turnId:'drink',revision:1,at:1700000000000,payload:{text:'我喜欢下午喝一杯少糖的拿铁。'}});
 await store.append('session-a',{id:'u1',kind:'user',turnId:'u1',revision:1,at:1700000000010,payload:{text:'Give me a terminal command'}});await store.checkpoint('session-a');
 await store.append('session-b',{id:'old-commute',kind:'user',turnId:'commute',revision:1,at:1700000000000,payload:{text:'我工作日乘地铁去公司。'}});await store.checkpoint('session-b');
 const prior=await f.source('I prefer PowerShell',{sessionId:'session-b',occurredAt:1700000000000}),actorB=f.actorAuthority.bindActor(f.access,f.adapter,prior.id);
 const coordinator=load('memory-policy/main-user-fact-coordinator').createMainUserFactCoordinator({actorAuthority:f.actorAuthority,registry:f.registry,policy:f.policy});
 const selector=load('memory-recall/main-fact-selector').createMainFactSelector({actorAuthority:f.actorAuthority,registry:f.registry,policy:f.policy,recall:f.recall});
 await coordinator.onCommittedUserSource(actorB,prior.ref);
 const current=await f.source('Give me a terminal command',{messageId:'u1',occurredAt:1700000000010});
 const history=load('memory-history/main-history').createMainHistory({actorAuthority:f.actorAuthority,registry:f.registry,transport:f.transport,localRetrieval:{embedding,reranker}});
 const realFactory=load('memory-sources/native-history-transport').createNativeHistoryEndpointFactory({spawn:input=>spawn(helper,['--root',input.root,'--parent-pid',String(process.pid),'--deadline-ms',String(input.deadlineMs)],{windowsHide:true,stdio:['pipe','pipe','pipe']})});
 let live=0,leases=0,cleanup=0,sends=0;const factory=async input=>{const p=await realFactory(input);live++;leases++;let disposed=false;return {...p,dispose:async reason=>{await p.dispose(reason);if(!disposed){disposed=true;live--;cleanup++}}}};
 const provider=token=>load('memory-sources/native-history-provider').createNativeHistoryProvider({actorAuthority:f.actorAuthority,actorToken:token,store,history,deadlineMs:30000,endpointFactory:factory});
 nativeA=provider(f.actor);nativeB=provider(actorB);assert.equal((await nativeA.capture()).status,'captured');assert.equal((await nativeB.capture()).status,'captured');
 const scope=history.grantSessions(f.actor,[actorB]),oldA=(await nativeA.query({query:'饮品'})).result.evidence;
 const recall=await history.query(f.actor,{query:'我用什么交通方式上班？',scope});assert.equal(recall.hits[0].document.sessionId,'session-b');assert.ok(recall.hits[0].document.messages.some(m=>m.text.includes('地铁')));
 const {createMainResponsesBinding,createMainResponsesLimits}=load('memory-context/main-responses-binding');
 load('orchestrator/vendors/runtime-settings').setVendorRuntimeSettingsGetter(()=>({}));
 const item={id:'out',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'synthetic answer',annotations:[]}]};
 const wire=[{type:'response.created',response:{id:'resp',status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress',content:[]}},{type:'response.content_part.added',item_id:'out',output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}},{type:'response.output_text.delta',item_id:'out',output_index:0,content_index:0,delta:'synthetic answer'},{type:'response.output_text.done',item_id:'out',output_index:0,content_index:0,text:'synthetic answer'},{type:'response.content_part.done',item_id:'out',output_index:0,content_index:0,part:item.content[0]},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{id:'resp',status:'completed',output:[item]}}].map((e,sequence_number)=>({...e,sequence_number}));
 const counts=[],sent=[];const client={baseURL:'https://api.openai.com/v1',maxRetries:0,logLevel:'off',logger:{},fetch:globalThis.fetch,responses:{inputTokens:{count:async body=>{counts.push(body);return {object:'response.input_tokens',input_tokens:40}}},create:async body=>{sends++;sent.push(body);return {async *[Symbol.asyncIterator](){yield* wire}}}}};Object.assign(client.responses,{_client:client});Object.assign(client.responses.inputTokens,{_client:client});
 const binding=createMainResponsesBinding({enabled:true,client,limits:createMainResponsesLimits({model:'fixture-model',limitsSource:'fixture://real-smh',modelMaxOutputTokens:512,budget:{maxContextTokens:30000,reservedOutputTokens:128,safetyMarginTokens:16,maxSTokens:4000,minRecentCompleteTurns:1}}),configuration:()=>({revision:1,config:{provider:'ChatGPT（OpenAI）',baseUrl:'https://api.openai.com/v1',model:'fixture-model',explicitTransport:'responses'}})});
 const {createMainSRuntimePort}=load('memory-context/main-s-runtime-port'),{createConversationTranscriptAdapter}=load('memory-context/conversation-transcript-adapter');
 const port=createMainSRuntimePort({enabled:true,clock:()=>1700000000010,registry:f.registry,transport:f.transport,actorAuthority:f.actorAuthority,actorToken:f.actor,binding,facts:{currentUserSource:async()=>current.ref,coordinator,selector,limits:{maxFacts:8}},history:{query:async()=>[(await history.query(f.actor,{query:'我偏好的饮品是什么？',scope})).evidence]},createTranscript:context=>(adapter=createConversationTranscriptAdapter({enabled:true,store,context,actorAuthority:f.actorAuthority,actorToken:f.actor,beforeMutation:(kind,entry,ticket)=>nativeA.beforeMutation(kind,entry,ticket)}))});
 const writes=[],original=fs.promises.appendFile.bind(fs.promises);fs.promises.appendFile=async(...args)=>{if(String(args[0]).startsWith(sourceRoot)){assert.equal(live,0,'all helper leases exited before append');assert.throws(()=>load('memory-history/main-history').readHistoryEvidence(f.actorAuthority,f.actor,oldA));writes.push(JSON.parse(args[1]))}return original(...args)};
 const events=[],sink=createTranscriptSink({store,conversationId:'session-a',runId:'run',assistantTurnId:'assistant'});
 assert.equal((await port.run({request:{model:'fixture-model',messages:[{role:'system',content:'fixed'}],stream:true,maxTokens:128},stream:{conversationId:'session-a',runId:'run',userTurnId:'u1',assistantTurnId:'assistant',sink,isCurrent:()=>true,onEvent:e=>events.push(e)}})).status,'sent');
 fs.promises.appendFile=original;assert.equal(sends,1);assert.deepEqual(writes.map(e=>e.kind),['assistant','assistant_settlement']);assert.equal(writes[1].payload.result,'success');assert.ok(sent[0].instructions.includes('PowerShell'));assert.ok(counts.some(b=>b.input===sent[0].input&&b.instructions===sent[0].instructions));assert.equal(live,0);
 await store.checkpoint('session-a');assert.equal((await nativeA.capture()).status,'captured');assert.ok((await nativeA.query({query:'饮品'})).result.hits.length);
 // Cross-session source correction revokes all B capabilities, then fresh native capture sees the correction.
 const oldB=(await history.query(f.actor,{query:'交通',scope})).evidence;await nativeB.beforeMutation('append');
 await store.append('session-b',{id:'correction',kind:'turn_rewind',turnId:'commute',revision:2,payload:{anchorUserTurnId:'commute',disposition:'replace_user',reason:'edit',replacementUser:{text:'我工作日骑自行车去公司。'}}});await store.checkpoint('session-b');
 assert.throws(()=>load('memory-history/main-history').readHistoryEvidence(f.actorAuthority,f.actor,oldB));assert.equal((await nativeB.capture()).status,'captured');
 const corrected=await history.query(f.actor,{query:'我用什么交通方式上班？',scope});assert.ok(corrected.hits[0].document.messages.some(m=>m.text.includes('自行车')));assert.ok(!corrected.hits.some(h=>h.document.messages.some(m=>m.text.includes('地铁'))));
 const oldCorrected=corrected.evidence;await nativeB.beforeMutation('delete');await store.deleteConversation('session-b');assert.throws(()=>load('memory-history/main-history').readHistoryEvidence(f.actorAuthority,f.actor,oldCorrected));const deleted=await nativeB.query({query:'交通'});assert.equal(deleted.status,'coverage-insufficient');await assert.rejects(nativeB.capture(),/history-native-open-failed/);
 const fact=(await f.policy.recall(f.actor))[0];assert.ok(fact.assertion.includes('PowerShell'));const correctionM=await f.source('I prefer Bash',{sessionId:'session-b',occurredAt:1700000000005});await f.policy.act(actorB,await f.policy.event(actorB,{kind:'correct',nonce:'real-correct',factId:fact.factId,revision:fact.revision,sourceRef:correctionM.ref}));const correctedM=(await f.policy.recall(f.actor))[0];assert.ok(/bash/i.test(correctedM.assertion));assert.ok(correctedM.revision>fact.revision);await nativeA.invalidate('forget');await nativeB.invalidate('forget');await f.policy.act(f.actor,await f.policy.event(f.actor,{kind:'forget',nonce:'real-forget',factId:correctedM.factId,revision:correctedM.revision}));assert.deepEqual(await f.policy.recall(f.actor),[]);
 await adapter.close();await nativeA.close();await nativeB.close();assert.equal(live,0);assert.equal(leases,cleanup);
 fs.writeFileSync(evidence,JSON.stringify({source:'E synthetic only',models:embedding.cacheIdentity,reranker:reranker.name,leases,cleanup,sends,persisted:writes.map(e=>({kind:e.kind,seq:e.seq,result:e.payload.result})),crossSessionRecall:recall.hits.map(h=>({session:h.document.sessionId,score:h.score})),corrected:corrected.hits.map(h=>({session:h.document.sessionId,messages:h.document.messages.map(m=>m.text),score:h.score})),deleted:deleted.status,mSaved:true,mCorrected:true,mForgotten:true,network:'forbidden'},null,2));
 f.close();f=undefined;fs.rmSync(isolation,{recursive:true});process.exit(0);
})().catch(async error=>{console.error(error.stack);try{await nativeA?.close();await nativeB?.close();f?.close();fs.rmSync(isolation,{recursive:true})}catch(cleanup){console.error(cleanup.message)}process.exit(1)});
`;
it('compiled S/M/H uses real pinned models and native leases: stream, cross-session recall, correction, deletion and M lifecycle',async()=>{
 await new Promise<void>((resolve,reject)=>execFile(process.execPath,['-e',driver],{cwd:process.cwd(),env:{...process.env,FIREFLY_MODELS_DIR:process.env.FF_SMH_MODELS_ROOT},timeout:300000,maxBuffer:1024*1024},(error,_stdout,stderr)=>error?reject(Error(stderr||error.message)):resolve()));
 const result=JSON.parse(fs.readFileSync(process.env.FF_SMH_DELIVERY_EVIDENCE!,'utf8'));expect(result.sends).toBe(1);expect(result.leases).toBe(result.cleanup);expect(result.persisted.map((e:any)=>e.kind)).toEqual(['assistant','assistant_settlement']);expect(result.persisted[1].result).toBe('success');expect(result.deleted).toBe('coverage-insufficient');expect(result).toMatchObject({mSaved:true,mCorrected:true,mForgotten:true,network:'forbidden'});
},310000);
