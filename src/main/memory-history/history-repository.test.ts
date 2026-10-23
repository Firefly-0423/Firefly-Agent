import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {afterEach,it,expect} from 'vitest';
import {recallFixture} from '../../../scripts/verify/memory-recall/recall-fixture';
import {DEFAULT_HISTORY_SETTINGS} from './history-contracts';
import {createMainActorAuthority} from '../memory-core/main-actor-authority';
import {createMainPolicy} from '../memory-policy/main-policy';
import {createMainSourceRegistry} from '../memory-sources/source-registry';
const fixtures:ReturnType<typeof recallFixture>[]=[];
function fixture(){const f=recallFixture();fixtures.push(f);const command=(kind:string,body:any={},commandId?:string)=>f.repo.historyCommand({kind,scopeKey:'scope-a',...(commandId?{commandId}:{}),body:{actorKey:'actor-a',providerId:'synthetic',sessionId:'session-a',...body}});return {...f,command}}
afterEach(()=>{for(const f of fixtures.splice(0))f.close()});
async function document(f:ReturnType<typeof fixture>,text='H_ENCRYPTED_SECRET cat'){const s=await f.source(text);return {id:randomUUID(),incarnation:randomUUID(),revision:1,origin:'canonical',sourceDeps:[{sourceRef:s.ref,subjectKeys:null,derivedRefs:null}],messages:[{id:s.id.messageId,role:'user',text,occurredAt:null,timeZone:null,sourceRef:s.ref}],vector:null}}
const scope=[{providerId:'synthetic',sessionId:'session-a'}];
it('accepted maximum text across multiple messages reaches explicit excerpt budgets without poisoning queries',async()=>{
 const f=fixture(),small=await document(f);put(f,small);for(const count of [2,128]){const sizes=Array.from({length:count},(_,i)=>Math.floor(65536/count)+(i<65536%count?1:0));put(f,{id:'large-'+count,incarnation:'v1',revision:1,origin:'synthetic-import',sourceDeps:[],vector:null,messages:sizes.map((size,i)=>({id:'m'+i,role:i===0?'user':'assistant',text:('cat '+i+' ').repeat(size).slice(0,size),occurredAt:null,timeZone:null}))})}const result=query(f);expect(result.status).toBe('excerpt-budget-exhausted');expect(result.hits.some((h:any)=>h.document.id===small.id)).toBe(true);
});
function query(f:ReturnType<typeof fixture>,extra:any={}){return f.command('query',{sessions:scope,query:'cat',settings:DEFAULT_HISTORY_SETTINGS,...extra})}
function put(f:ReturnType<typeof fixture>,doc:any){return f.command('put',{document:doc,generation:0},randomUUID())}
it('encrypted canonical history reopens and querying changes no persisted bytes or M usage',async()=>{
 const f=fixture(),d=await document(f);put(f,d);const a=query(f);expect(a.hits).toHaveLength(1);expect(a.hits[0].document.messages[0].text).toBe(d.messages[0].text);
 expect(a.hits[0].dependency).toMatchObject({documentId:d.id,incarnation:d.incarnation,revision:1,generation:0,indexVersion:'history-index-v1'});
 const files=()=>fs.readdirSync(f.root).filter(n=>n.startsWith('memory.sqlite')).map(n=>fs.readFileSync(f.root+'/'+n));const before=files();query(f);expect(files()).toEqual(before);
 for(const bytes of before)expect(bytes.toString('utf8')).not.toContain('H_ENCRYPTED_SECRET');f.reopen();expect(query(f).hits[0].dependency.digest).toBe(a.hits[0].dependency.digest);
});
it('checking historical M roots is read-only even when M projection was never initialized',async()=>{
 const f=fixture(),a=await f.active(),d={...(await document(f)),sourceDeps:[{sourceRef:a.ref,subjectKeys:null,derivedRefs:null}],messages:[{id:a.id.messageId,role:'user',text:'I prefer bash',occurredAt:null,timeZone:null,sourceRef:a.ref}]};put(f,d);const db=new DatabaseSync(f.databasePath,{readOnly:true});try{expect(db.prepare('SELECT count(*) AS n FROM recall_records').get()?.n).toBe(0);f.advance(86400000);expect(query(f,{query:'bash'}).hits).toHaveLength(1);expect(db.prepare('SELECT count(*) AS n FROM recall_records').get()?.n).toBe(0)}finally{db.close()}
});
it('actor partition filters before BM25 statistics, vector ranking and byte budgets',async()=>{
 const f=fixture(),d=await document(f);put(f,d);const baseline=query(f);
 for(let i=0;i<6;i++)f.command('put',{actorKey:'other-actor',document:{...d,id:randomUUID(),messages:d.messages.map((m:any)=>({...m,text:m.text}))},generation:0},randomUUID());
 expect(query(f)).toEqual(baseline);expect(query(f,{settings:{...DEFAULT_HISTORY_SETTINGS,maxIndexDocuments:1}}).status).toBe('ok');
});
it('another actor forget cannot change authorized H counts or ranking statistics',async()=>{
 const f=fixture(),d=await document(f);put(f,d);const baseline=query(f),authority=createMainActorAuthority({resolveActor:()=> 'actor-b'}),registry=createMainSourceRegistry(f.transport,{coordinate:authority.coordinate}),access=registry.authority.access('scope-a'),policy=createMainPolicy({registry,transport:f.transport,resolveActor:()=> 'actor-b',actorAuthority:authority}),identity={providerId:'synthetic',sessionId:'session-b',messageId:'bash-b'},actor=policy.bindActor(access,f.provider.adapter,identity);f.provider.write(identity,{text:'I prefer bash',role:'user',trust:'direct-user-event'});const ref=await registry.capture(access,f.provider.adapter,identity),fact=await policy.ingest(actor,ref);await policy.act(actor,await policy.event(actor,{kind:'forget',nonce:randomUUID(),factId:fact.factId,revision:1}));expect(query(f)).toEqual(baseline);
});
it('session whitelist filters candidates before lexical corpus statistics',async()=>{
 const f=fixture(),d=await document(f);put(f,d);expect(query(f,{sessions:[{providerId:'synthetic',sessionId:'other'}]}).hits).toEqual([]);
});
it('same document locator in two authorized sessions cannot collide in candidate IDs',async()=>{
 const f=fixture(),d=await document(f);put(f,d);const imported={...d,origin:'synthetic-import',sourceDeps:[],messages:[{id:'import-u',role:'user',text:'cat separate session',occurredAt:null,timeZone:null}]};f.command('put',{sessionId:'session-b',document:imported,generation:0},randomUUID());
 expect(query(f,{sessions:[...scope,{providerId:'synthetic',sessionId:'session-b'}]}).hits).toHaveLength(2);
});
it('pending/edit/delete/recreate source binding prevents stale index revival',async()=>{
 const f=fixture(),d=await document(f);put(f,d);const hit=query(f).hits[0],ref=d.sourceDeps[0].sourceRef;
 await f.registry.prepareChange(f.access,f.provider.adapter,ref);expect(query(f).hits).toEqual([]);expect(()=>f.command('validate',{dependencies:[hit.dependency]})).toThrow();
 const id={providerId:ref.binding.providerId,sessionId:ref.binding.sessionId,messageId:ref.binding.messageId};f.provider.remove(id);await expect(f.registry.reconcile(f.access,f.provider.adapter,id)).rejects.toThrow('MEMORY_SOURCE_DELETED');f.provider.write(id,{text:d.messages[0].text,role:'user',trust:'direct-user-event'});await f.registry.capture(f.access,f.provider.adapter,id);expect(query(f).hits).toEqual([]);
});
it('forget invalidates immutable dependencies and old source/derived history',async()=>{
 const f=fixture(),a=await f.active(),ref=a.ref,d={...(await document(f)),sourceDeps:[{sourceRef:ref,subjectKeys:null,derivedRefs:null}],messages:[{id:a.id.messageId,role:'user',text:'I prefer bash',occurredAt:null,timeZone:null,sourceRef:ref}]};put(f,d);const deps=query(f,{query:'bash'}).hits.map((h:any)=>h.dependency);
 await f.policy.act(f.actor,await f.policy.event(f.actor,{kind:'forget',nonce:randomUUID(),factId:a.factId,revision:1}));expect(query(f).hits).toEqual([]);expect(()=>f.command('validate',{dependencies:deps})).toThrow('MEMORY_HISTORY_STALE');
});
it('index hard budget returns explicit state and preserves every historical document',async()=>{
 const f=fixture(),d=await document(f);put(f,d);put(f,{...d,id:randomUUID()});expect(query(f,{settings:{...DEFAULT_HISTORY_SETTINGS,maxIndexDocuments:1}})).toMatchObject({status:'index-budget-exhausted',hits:[]});expect(query(f).hits).toHaveLength(1);
});
it('tool pairs are inseparable and missing results are refused',async()=>{
 const f=fixture(),d=await document(f),assistant={id:'call-message',role:'assistant',text:'cat tool call',occurredAt:null,timeZone:null,toolCallIds:['tool1']},tool={id:'tool-result',role:'tool',text:'cat tool result',occurredAt:null,timeZone:null,toolCallId:'tool1'};
 expect(()=>put(f,{...d,messages:[...d.messages,assistant]})).toThrow('MEMORY_CONTEXT_TOOL_PAIR_INVALID');expect(()=>put(f,{...d,messages:[...d.messages,assistant,tool]})).toThrow('MEMORY_HISTORY_SOURCE_MISMATCH');const {sourceRef:_source,...importedUser}=d.messages[0];put(f,{...d,origin:'synthetic-import',sourceDeps:[],messages:[importedUser,assistant,tool]});expect(query(f).hits[0].document.messages).toHaveLength(3);
 expect(query(f,{settings:{...DEFAULT_HISTORY_SETTINGS,maxExcerptChars:10,maxTotalChars:10}})).toMatchObject({status:'excerpt-budget-exhausted',hits:[]});
});
it('text, role and original event time cannot diverge from canonical sources',async()=>{
 const f=fixture(),d=await document(f);for(const edit of [{text:'forged cat'},{role:'assistant'},{occurredAt:123}])expect(()=>put(f,{...d,messages:[{...d.messages[0],...edit}]})).toThrow('MEMORY_HISTORY_SOURCE_MISMATCH');
});
it('same revision digest is idempotent and different digest cannot overwrite',async()=>{
 const f=fixture(),d=await document(f);put(f,d);expect(put(f,d).status).toBe('duplicate');expect(()=>put(f,{...d,incarnation:randomUUID()})).toThrow('MEMORY_HISTORY_CONFLICT');expect(query(f).hits).toHaveLength(1);
});
it('delete blocks a higher revision and new incarnation and invalidates the old dependency',async()=>{
 const f=fixture(),d=await document(f);put(f,d);const dep=query(f).hits[0].dependency;f.command('delete',{documentId:d.id,revision:1},randomUUID());expect(query(f).hits).toEqual([]);expect(()=>put(f,{...d,revision:2,incarnation:randomUUID()})).toThrow('MEMORY_HISTORY_CONFLICT');expect(query(f).hits).toEqual([]);expect(()=>f.command('validate',{dependencies:[dep]})).toThrow('MEMORY_HISTORY_STALE');
});
it('model identity or vector dimension mismatch fails closed without provider fallback',async()=>{
 const f=fixture(),d=await document(f);put(f,{...d,vector:{identity:'synthetic-v1',values:[1,0]}});expect(()=>query(f,{vector:{identity:'synthetic-other',values:[1,0]}})).toThrow('MEMORY_HISTORY_VECTOR_INVALID');expect(()=>query(f,{vector:{identity:'synthetic-v1',values:[1]}})).toThrow('MEMORY_HISTORY_VECTOR_INVALID');
 expect(query(f,{vector:{identity:'synthetic-v1',values:[1,0]}}).diversity).toBe('vector-mmr');
});
it('malformed/foreign dependencies and changed index settings cannot be claimed',async()=>{
 const f=fixture(),d=await document(f);put(f,d);const dep=query(f).hits[0].dependency;
 expect(()=>f.command('validate',{dependencies:[{...dep,partition:{actorKey:'other',sessions:scope}}]})).toThrow('MEMORY_HISTORY_ACCESS_DENIED');
 expect(()=>f.command('validate',{dependencies:[{...dep,indexVersion:'old'}]})).toThrow('MEMORY_HISTORY_STALE');
});

it('a fresh query is required after a ranking/tokenizer protocol version change',async()=>{
 const f=fixture();put(f,await document(f));const dep=query(f).hits[0].dependency;
 expect(()=>f.command('validate',{dependencies:[dep]})).not.toThrow();
 expect(()=>f.command('validate',{dependencies:[{...dep,rankingVersion:'history-ranking-v2'}]})).toThrow('MEMORY_HISTORY_STALE');
 expect(()=>f.command('validate',{dependencies:[{...dep,rankingVersion:'history-ranking-v1'}]})).toThrow('MEMORY_HISTORY_STALE');
 expect(()=>f.command('validate',{dependencies:[{...dep,tokenizerVersion:dep.tokenizerVersion.replace('-v2-','-v1-')}]})).toThrow('MEMORY_HISTORY_STALE');
});

it('Main unbound structure mode cannot authorize Worker put; current head binds the exact body',async()=>{
 const f=fixture(),{parseHistoryDocument}=await import('./history-repository'),{historyTranscriptDigest}=await import('./history-transcript-digest');
 const d={id:'native',incarnation:'native-inc',revision:1,origin:'canonical',sourceDeps:[],messages:[{id:'u',role:'user',text:'cat native',occurredAt:null,timeZone:null}],vector:null};
 expect(()=>parseHistoryDocument(d)).toThrow();expect(parseHistoryDocument(d,{allowUnboundTranscript:true})).toEqual(d);
 expect(()=>put(f,d)).toThrow();
 const context=(kind:string,body:any)=>f.transport.contextCommand({kind,scopeKey:'scope-a',commandId:randomUUID(),body:{...f.owner,...body}});
 await context('transcriptReserve',{headId:'head-native',operationId:'op-native',generation:0,expectedRef:null});
 const ref=await context('transcriptPublish',{headId:'head-native',operationId:'op-native',generation:0,incarnation:d.incarnation,contentRevision:1,throughSeq:1,digest:historyTranscriptDigest(d as any),sourceRefs:[]});
 expect(()=>put(f,{...d,transcriptRef:ref,messages:[{...d.messages[0],text:'forged cat'}]})).toThrow('MEMORY_HISTORY_SOURCE_MISMATCH');
 put(f,{...d,transcriptRef:ref});expect(query(f,{transcriptHeads:['head-native']}).hits).toHaveLength(1);
 const fact=await f.active();await f.policy.act(f.actor,await f.policy.event(f.actor,{kind:'forget',nonce:randomUUID(),factId:fact.factId,revision:1}));
 const generation=f.command('baseline').generation;
 expect(()=>f.command('put',{document:{...d,id:'new-id',revision:99,transcriptRef:ref},generation},randomUUID())).toThrow('MEMORY_HISTORY_STALE');
 expect(query(f,{transcriptHeads:['head-native']}).hits).toEqual([]);f.reopen();expect(query(f,{transcriptHeads:['head-native']}).hits).toEqual([]);
});
it('settings from before windowing and recency still work and mean both are off; out-of-range values are rejected',async()=>{
 const f=fixture(),d=await document(f);put(f,d);
 const {windowTurns,recencyAlpha,recencyHalfLifeDays,...legacy}=DEFAULT_HISTORY_SETTINGS;void windowTurns;void recencyAlpha;void recencyHalfLifeDays;
 const old=query(f,{settings:{...legacy,version:'history-settings-v1'}});expect(old.hits).toHaveLength(1);expect(old.hits[0].document.id).toBe(d.id);
 expect(()=>query(f,{settings:{...DEFAULT_HISTORY_SETTINGS,windowTurns:99}})).toThrow();
 expect(()=>query(f,{settings:{...DEFAULT_HISTORY_SETTINGS,windowTurns:1.5}})).toThrow();
 expect(()=>query(f,{settings:{...DEFAULT_HISTORY_SETTINGS,recencyAlpha:2}})).toThrow();
 expect(()=>query(f,{settings:{...DEFAULT_HISTORY_SETTINGS,recencyHalfLifeDays:0}})).toThrow();
});
it('the default settings window a long conversation and still return the whole document',async()=>{
 const f=fixture(),turn=(i:number,text:string)=>({id:'m'+i,role:i%2?'assistant':'user',text,occurredAt:null,timeZone:null});
 const messages=Array.from({length:41},(_,i)=>turn(i,i===20?'zebra passport renewal':'filler turn '+i));
 put(f,{id:'win-doc',incarnation:'v1',revision:1,origin:'synthetic-import',sourceDeps:[],vector:null,messages});
 const r=query(f,{query:'zebra passport'});expect(r.hits).toHaveLength(1);expect(r.hits[0].document.messages).toHaveLength(41);
 // 关掉窗口化后同一个查询仍然命中，说明窗口化只改排序，不改返回的内容
 const off=query(f,{query:'zebra passport',settings:{...DEFAULT_HISTORY_SETTINGS,windowTurns:0}});expect(off.hits).toHaveLength(1);expect(off.hits[0].document.messages).toHaveLength(41);
});
it('query reports numbers-only budget drop counts, separating oversized documents from total-budget drops',async()=>{
 const f=fixture(),small=await document(f,'cat small');put(f,small);
 const imported=(id:string,sizes:number[],words=sizes.map(()=>'cat '))=>({id,incarnation:'v1',revision:1,origin:'synthetic-import',sourceDeps:[],vector:null,messages:sizes.map((size,i)=>({id:id+'-m'+i,role:i%2===0?'user':'assistant',text:words[i].repeat(size).slice(0,size),occurredAt:null,timeZone:null}))});
 // long-message: the only window is 7000 chars; split: the only window (2 turns) is 8000; tail: the matched first window is short and the long message sits in a later window.
 put(f,imported('long-message',[7000]));put(f,imported('split',[4000,4000]));put(f,imported('tail',[100,100,7000,10],['cat ','cat ','zz ','zz ']));
 const q=query(f);expect(q.status).toBe('excerpt-budget-exhausted');expect(q.hits.map((h:any)=>h.document.id).sort()).toEqual([small.id,'tail'].sort());expect(q.hits.find((h:any)=>h.document.id==='tail').document.excerpt).toMatchObject({start:0,end:2,total:4});
 expect(q.budget).toEqual({ranked:4,returned:2,excerpted:1,droppedOversized:2,droppedOverTotal:0,oversizedExcerptable:0,droppedSizes:{'le-6k':0,'6k-12k':2,'12k-24k':0,'24k-48k':0,'gt-48k':0}});
 expect(JSON.stringify(q.budget)).not.toMatch(/cat|zz|split|tail|long-message|session/);
 const total=query(f,{settings:{...DEFAULT_HISTORY_SETTINGS,maxExcerptChars:65536,maxTotalChars:9000}});
 expect(total.budget).toMatchObject({ranked:4,droppedOversized:0,oversizedExcerptable:0});expect(total.budget.returned+total.budget.droppedOverTotal).toBe(4);expect(total.budget.droppedOverTotal).toBeGreaterThanOrEqual(1);
 expect(query(f,{settings:{...DEFAULT_HISTORY_SETTINGS,maxIndexDocuments:1}}).budget).toBeUndefined();
});

// ---- excerpts: an oversized matched document returns its best window plus neighbours instead of being dropped ----
const NEEDLE_QUERY='zebra passport';
const imp=(id:string,messages:any[],extra:any={})=>({id,incarnation:'v1',revision:1,origin:'synthetic-import',sourceDeps:[],vector:null,messages,...extra});
const row=(i:number,text:string,extra:any={})=>({id:'m'+i,role:i%2===0?'user':'assistant',text,occurredAt:null,timeZone:null,...extra});
/** n messages of about `size` chars; message `needleAt` is the only one that matches NEEDLE_QUERY. */
function longMessages(n:number,needleAt:number,size=700){return Array.from({length:n},(_,i)=>row(i,(i===needleAt?'zebra passport ':'filler '+i+' ')+'y'.repeat(size)))}
const excerptOf=(r:any,i=0)=>r.hits[i].document.excerpt;
const textLength=(messages:any[])=>messages.reduce((n:number,m:any)=>n+m.text.length,0);
it('an oversized matched document returns the best window plus neighbouring windows, whole messages only, and says it is an excerpt',async()=>{
 const f=fixture(),messages=longMessages(20,9);put(f,imp('big',messages));
 expect(textLength(messages)).toBeGreaterThan(DEFAULT_HISTORY_SETTINGS.maxExcerptChars);
 const r=query(f,{query:NEEDLE_QUERY});expect(r.status).toBe('ok');expect(r.hits).toHaveLength(1);
 const hit=r.hits[0],e=hit.document.excerpt;expect(e).toMatchObject({version:'history-excerpt-v1',start:6,end:12,total:20});
 expect(hit.document.messages).toEqual(messages.slice(6,12));// whole stored messages, byte for byte
 expect(hit.document.messages.some((m:any)=>m.text.startsWith('zebra passport'))).toBe(true);
 expect(textLength(hit.document.messages)).toBeLessThanOrEqual(DEFAULT_HISTORY_SETTINGS.maxExcerptChars);
 expect(hit.dependency.excerpt).toEqual(e);expect(hit.dependency.digest).toBe(hit.document.digest);
 expect(e.digest).toMatch(/^[a-f0-9]{64}$/);expect(e.digest).not.toBe(hit.document.digest);
 expect(r.budget).toMatchObject({ranked:1,returned:1,excerpted:1,droppedOversized:0,droppedOverTotal:0});
});
it('the excerpt is cut from the stored document and is reproducible from it',async()=>{
 const f=fixture(),messages=longMessages(20,9);put(f,imp('big',messages));
 const a=query(f,{query:NEEDLE_QUERY}),b=query(f,{query:NEEDLE_QUERY});expect(excerptOf(b)).toEqual(excerptOf(a));
 const stored=f.command('validate',{dependencies:[a.hits[0].dependency]}).documents[0];
 expect(stored.messages).toHaveLength(20);expect(stored.messages.slice(6,12)).toEqual(a.hits[0].document.messages);
 f.reopen();expect(excerptOf(query(f,{query:NEEDLE_QUERY}))).toEqual(excerptOf(a));
});
it('excerpts stay at the document edges and grow only on the open side',async()=>{
 for(const [needleAt,start,end] of [[0,0,4],[19,16,20]] as const){
  const f=fixture();put(f,imp('big',longMessages(20,needleAt)));const e=excerptOf(query(f,{query:NEEDLE_QUERY}));expect([e.start,e.end]).toEqual([start,end]);
 }
});
it('a document that fits the per-document budget is still returned whole, with no excerpt marker',async()=>{
 const f=fixture();put(f,imp('small',longMessages(6,2,100)));const r=query(f,{query:NEEDLE_QUERY});
 expect(r.hits[0].document.messages).toHaveLength(6);expect(r.hits[0].document.excerpt).toBeUndefined();expect(r.hits[0].dependency.excerpt).toBeUndefined();expect(r.budget).toMatchObject({returned:1,excerpted:0});
});
it('an excerpt is limited to what is left of the total budget as well as the per-document limit',async()=>{
 const f=fixture();put(f,imp('first',longMessages(3,1,300)));put(f,imp('big',longMessages(20,9)));
 const r=query(f,{query:NEEDLE_QUERY,settings:{...DEFAULT_HISTORY_SETTINGS,maxTotalChars:2800}});
 expect(r.hits.reduce((n:number,h:any)=>n+textLength(h.document.messages),0)).toBeLessThanOrEqual(2800);
 expect(r.hits.find((h:any)=>h.document.id==='big').document.excerpt).toMatchObject({start:8,end:10});// the neighbouring windows would not fit the 2800 total
});
const dropCases:[string,()=>any,any][]=[
 ['a single message larger than the budget',()=>imp('d',[row(0,'zebra passport '+'y'.repeat(7000)),row(1,'short')]),{}],
 ['a best window that does not fit',()=>imp('d',[...longMessages(12,5,200).slice(0,4),row(4,'y'.repeat(2500)),row(5,'zebra passport '+'y'.repeat(4000)),...longMessages(12,5,200).slice(6)]),{}],
 ['a document no longer than one window',()=>imp('d',[row(0,'zebra passport '+'y'.repeat(3500)),row(1,'y'.repeat(3500))]),{}],
 ['windowing switched off',()=>imp('d',longMessages(20,9)),{windowTurns:0}],
];
it.each(dropCases)('falls back to dropping the document (status excerpt-budget-exhausted) rather than truncating when there is %s',async(_,build,patch)=>{
 const f=fixture();put(f,build());const r=query(f,{query:NEEDLE_QUERY,settings:{...DEFAULT_HISTORY_SETTINGS,...patch}});
 expect(r.status).toBe('excerpt-budget-exhausted');expect(r.hits).toEqual([]);expect(r.budget).toMatchObject({returned:0,excerpted:0,droppedOversized:1});
});
it('a document found only by vector similarity has no best window and is dropped, not guessed at',async()=>{
 const f=fixture();put(f,imp('big',longMessages(20,9),{vector:{identity:'synthetic-v1',values:[1,0]}}));
 const r=query(f,{query:'nothing matches lexically',vector:{identity:'synthetic-v1',values:[1,0]}});
 expect(r.hits).toEqual([]);expect(r.status).toBe('excerpt-budget-exhausted');
 const hit=query(f,{query:NEEDLE_QUERY,vector:{identity:'synthetic-v1',values:[1,0]}});expect(hit.diversity).toBe('vector-mmr');expect(excerptOf(hit)).toMatchObject({start:6,end:12});
});
it('a document that only exceeds the remaining total budget is dropped as before, not excerpted, even though a window of it would fit',async()=>{
 const f=fixture();put(f,imp('a',longMessages(8,3,700)));put(f,imp('b',longMessages(8,3,700)));
 const r=query(f,{query:NEEDLE_QUERY,settings:{...DEFAULT_HISTORY_SETTINGS,maxTotalChars:7200}});
 expect(r.hits).toHaveLength(1);expect(r.hits[0].document.excerpt).toBeUndefined();expect(r.status).toBe('excerpt-budget-exhausted');expect(r.budget).toMatchObject({returned:1,excerpted:0,droppedOverTotal:1,droppedOversized:0});
});
// message 3 is a tool call and 4,5 are its results; the needle is only in result 4
function toolDoc(resultSize:number,callAt=3,huge=-1){const m:any[]=longMessages(14,-1,700);
 m[callAt]={...row(callAt,'calling '+'c'.repeat(300)),role:'assistant',toolCallIds:['t1','t2'],toolCalls:[{id:'t1',name:'lookup',arguments:'{}'},{id:'t2',name:'lookup',arguments:'{}'}]};
 m[callAt+1]={...row(callAt+1,'zebra passport '+'r'.repeat(resultSize)),role:'tool',toolCallId:'t1',name:'lookup'};m[callAt+2]={...row(callAt+2,'r'.repeat(resultSize)),role:'tool',toolCallId:'t2',name:'lookup'};
 m[callAt+3]={...m[callAt+3],role:'assistant'};if(huge>=0)m[huge]={...m[huge],text:'h'.repeat(4500)};return imp('tools',m)}
it('a tool call and all of its results always travel together: a window that cuts the group pulls in the call',async()=>{
 // The best window [6,8) holds only the two results; the call is message 5. The big neighbour 4 keeps the context from reaching back, so only the group rule can bring the call in.
 const f=fixture();put(f,toolDoc(300,5,4));const r=query(f,{query:NEEDLE_QUERY}),e=excerptOf(r),shown=r.hits[0].document.messages;
 expect(e.start).toBe(5);expect(e.end).toBeGreaterThanOrEqual(8);expect(shown.map((m:any)=>m.id)).toEqual(expect.arrayContaining(['m5','m6','m7']));
 for(const m of shown.filter((x:any)=>x.role==='tool'))expect(shown.some((c:any)=>c.toolCallIds?.includes(m.toolCallId))).toBe(true);
 expect(()=>f.command('validate',{dependencies:[r.hits[0].dependency]})).not.toThrow();
});
it('when the tool group the best window needs does not fit, nothing is returned for the document instead of an orphaned result',async()=>{
 const f=fixture();put(f,toolDoc(2900));const r=query(f,{query:NEEDLE_QUERY});
 expect(r.hits).toEqual([]);expect(r.status).toBe('excerpt-budget-exhausted');expect(r.budget).toMatchObject({returned:0,droppedOversized:1});
 // The two results alone ([4,6), 5.8k) would fit the budget; with their call the group is over 6k, and the group rule must refuse the orphaned results.
 expect(r.budget.oversizedExcerptable).toBe(1);
});
it('a dependency with an excerpt validates against the authoritative document and rejects a stale, shifted or swapped range',async()=>{
 const f=fixture();put(f,imp('big',longMessages(20,9)));put(f,imp('twin',longMessages(20,9)));
 const r=query(f,{query:NEEDLE_QUERY}),deps=r.hits.map((h:any)=>h.dependency),dep=deps.find((d:any)=>d.documentId==='big');expect(dep).toBeDefined();
 expect(f.command('validate',{dependencies:[dep]}).documents[0].id).toBe('big');
 const bad=(patch:any)=>expect(()=>f.command('validate',{dependencies:[{...dep,excerpt:{...dep.excerpt,...patch}}]})).toThrow('MEMORY_HISTORY_STALE');
 bad({start:dep.excerpt.start+2});bad({end:dep.excerpt.end+2});bad({digest:'c'.repeat(64)});bad({total:21});bad({start:0,end:20});
 expect(()=>f.command('validate',{dependencies:[{...dep,digest:'d'.repeat(64)}]})).toThrow('MEMORY_HISTORY_STALE');
 // an excerpt made for one document cannot be replayed on another document of identical shape
 const twin=deps.find((d:any)=>d.documentId==='twin');expect(twin).toBeDefined();expect(()=>f.command('validate',{dependencies:[{...twin,excerpt:dep.excerpt}]})).toThrow('MEMORY_HISTORY_STALE');
});
it('malformed excerpt references are rejected on parse, never coerced',async()=>{
 const f=fixture();put(f,imp('big',longMessages(20,9)));const dep=query(f,{query:NEEDLE_QUERY}).hits[0].dependency;
 for(const excerpt of [null,'x',[],{...dep.excerpt,extra:1},{...dep.excerpt,start:'6'},{...dep.excerpt,end:1.5},{...dep.excerpt,version:'v0'},{start:6,end:12,total:20}])
  expect(()=>f.command('validate',{dependencies:[{...dep,excerpt}]})).toThrow();
});
it('a deleted document produces no excerpt and its old excerpt dependency stops validating',async()=>{
 const f=fixture();put(f,imp('big',longMessages(20,9)));const dep=query(f,{query:NEEDLE_QUERY}).hits[0].dependency;
 f.command('delete',{documentId:'big',revision:1},randomUUID());expect(query(f,{query:NEEDLE_QUERY}).hits).toEqual([]);expect(()=>f.command('validate',{dependencies:[dep]})).toThrow('MEMORY_HISTORY_STALE');
});
it('after a forget the anti-resurrection rule applies before any excerpting',async()=>{
 const f=fixture(),a=await f.active();put(f,imp('big',longMessages(20,9)));
 const r=query(f,{query:NEEDLE_QUERY}),dep=r.hits[0].dependency;expect(r.hits[0].document.excerpt).toBeDefined();
 await f.policy.act(f.actor,await f.policy.event(f.actor,{kind:'forget',nonce:randomUUID(),factId:a.factId,revision:1}));
 const after=query(f,{query:NEEDLE_QUERY});expect(after.hits).toEqual([]);expect(after.budget).toMatchObject({ranked:0,returned:0,excerpted:0});
 expect(()=>f.command('validate',{dependencies:[dep]})).toThrow('MEMORY_HISTORY_STALE');
});
it('time-limited retrieval can return an excerpt too',async()=>{
 const f=fixture(),m=longMessages(20,9).map((x:any,i:number)=>({...x,occurredAt:1000+i,timeZone:'Etc/UTC'}));put(f,imp('big',m));
 const r=query(f,{query:NEEDLE_QUERY,temporal:{kind:'range',from:900,to:2000}});expect(r.temporal).toMatchObject({status:'applied'});expect(r.hits[0].document.excerpt).toMatchObject({start:6,end:12});
 expect(r.hits[0].document.messages.map((x:any)=>x.occurredAt)).toEqual([1006,1007,1008,1009,1010,1011]);
});
// A time range is applied to whole documents, so a long document can overlap the range while its best window lies outside it.
// The returned fragment must never reach outside the asked range while the result is labelled as time-limited.
const timed=(n:number,needleAt:number)=>longMessages(n,needleAt).map((x:any,i:number)=>({...x,occurredAt:1000+i,timeZone:'Etc/UTC'}));
it('a time-limited excerpt contains only messages inside the asked range, even when the document overlaps it',async()=>{
 const f=fixture();put(f,imp('big',timed(20,10)));
 const r=query(f,{query:NEEDLE_QUERY,temporal:{kind:'range',from:1010,to:1019}});
 expect(r.temporal).toMatchObject({status:'applied'});expect(r.hits).toHaveLength(1);
 const times=r.hits[0].document.messages.map((x:any)=>x.occurredAt);
 expect(times.length).toBeGreaterThan(0);expect(Math.min(...times)).toBeGreaterThanOrEqual(1010);expect(Math.max(...times)).toBeLessThanOrEqual(1019);
 expect(r.hits[0].document.excerpt.start).toBeGreaterThanOrEqual(10);expect(r.hits[0].document.messages.some((x:any)=>x.text.startsWith('zebra passport'))).toBe(true);
});
it('is dropped rather than returned when the best window of an overlapping document lies outside the asked range',async()=>{
 const f=fixture();put(f,imp('big',timed(20,5)));
 const r=query(f,{query:NEEDLE_QUERY,temporal:{kind:'range',from:1010,to:1019}});
 expect(r.hits).toEqual([]);expect(r.status).toBe('excerpt-budget-exhausted');expect(r.budget).toMatchObject({returned:0,excerpted:0,droppedOversized:1});
});
it('a latest-first query is not range-limited, so its excerpt is unchanged',async()=>{
 const f=fixture();put(f,imp('big',timed(20,9)));
 const r=query(f,{query:NEEDLE_QUERY,temporal:{kind:'latest'}});expect(r.hits[0].document.excerpt).toMatchObject({start:6,end:12});
});
it('128 half-kilobyte messages (the largest allowed document shape) are searchable through an excerpt',async()=>{
 const f=fixture();put(f,imp('max',longMessages(128,70,500)));const r=query(f,{query:NEEDLE_QUERY});
 expect(r.status).toBe('ok');expect(excerptOf(r)).toMatchObject({total:128});expect(r.hits[0].document.messages.some((m:any)=>m.id==='m70')).toBe(true);
});
