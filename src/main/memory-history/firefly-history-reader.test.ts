import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {afterEach,it,expect,vi} from 'vitest';
import {readFireflyHistory,parseFireflyHistoryBytes,validateReadonlyHistoryScope} from './firefly-history-reader';
import type {ReadonlyHistoryScope} from './history-contracts';
import {createHistoryIndexBuilder} from './history-index-builder';
const roots:string[]=[];
afterEach(()=>{for(const r of roots.splice(0))fs.rmSync(r,{recursive:true,force:true})});
function fixture(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'h-native-'));roots.push(root);return {root,scope:{root,actorKey:'actor-a',scopeKey:'scope-a',sessions:[{providerId:'synthetic',sessionId:'session-a'}]}}}
const user=(seq=1,text='周末只喝咖啡')=>({id:'backfill:v1:u:'+seq,seq,at:1000+seq,kind:'user',turnId:'u:'+seq,revision:1,payload:{text}});
const assistant=(seq=2,text='咖啡回复')=>({id:'a:'+seq,seq,at:1000+seq,kind:'assistant',payload:{role:'assistant',content:text}});
function write(root:string,rows:unknown[],session='session-a'){const dir=path.join(root,'transcripts',session);fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,'transcript.jsonl');fs.writeFileSync(file,rows.map(r=>JSON.stringify(r)+'\n').join(''));return {dir,file}}
const digest=(file:string)=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
// Test-owned fixtures supply bytes directly. There is no production reader override or native bypass.
async function parseSyntheticFixture(scope:ReadonlyHistoryScope,signal?:AbortSignal){
 const partition=validateReadonlyHistoryScope(scope);
 if(signal?.aborted)return parseFireflyHistoryBytes(partition,[],signal);
 if(!roots.includes(partition.root))throw new Error('SYNTHETIC_FIXTURE_ROOT_REQUIRED');
 const bytes=(parts:string[])=>{const file=path.join(partition.root,...parts);return fs.existsSync(file)?fs.readFileSync(file):null};
 return parseFireflyHistoryBytes(partition,partition.sessions.map(session=>({...session,incarnation:'synthetic-'+createHash('sha256').update(partition.root).digest('hex'),
 transcript:bytes(['transcripts',session.sessionId,'transcript.jsonl']),snapshot:bytes(['transcripts',session.sessionId,'snapshot.json']),chat:bytes(['firefly-chats','sessions',session.sessionId+'.json'])})),signal);
}

it('parses supplied native transcript bytes with colon IDs, original quotes, null timezone and stable provenance without writes',async()=>{
 const f=fixture(),file=write(f.root,[user(),assistant()]).file,before=digest(file),a=await parseSyntheticFixture(f.scope),b=await parseSyntheticFixture(f.scope);
 expect(a.coverage).toBe('complete');expect(a.documents).toHaveLength(1);
 expect(a.documents[0].classification).toBe('raw-history');expect(a.documents[0].provenance[0]).toMatchObject({originalId:'backfill:v1:u:1',seq:1,turnId:'u:1',occurredAt:1001,timeZone:null,active:true,format:'transcript-v1'});
 expect(a.documents[0].document.messages[0].text).toBe('周末只喝咖啡');expect(b).toEqual(a);expect(digest(file)).toBe(before);
});
it('snapshot plus delta applies rewind but preserves inactive originals as diagnostic records',async()=>{
 const f=fixture(),{dir,file}=write(f.root,[user(),assistant(),{id:'edit:3',seq:3,at:1003,kind:'turn_rewind',turnId:'u:1',revision:2,payload:{anchorUserTurnId:'u:1',disposition:'replace_user',reason:'edit',replacementUser:{text:'现在喝茶'}}}]);
 fs.writeFileSync(path.join(dir,'snapshot.json'),JSON.stringify({schemaVersion:1,throughSeq:2,entries:[user(),assistant()],seenEntryIds:['backfill:v1:u:1','a:2'],seenUserRevisions:['u:1\u00001']}));
 const before=digest(file),r=await parseSyntheticFixture(f.scope);
 expect(r.documents.some(d=>d.provenance.some(p=>!p.active)&&d.document.messages.some(m=>m.text==='周末只喝咖啡'))).toBe(true);
 expect(r.documents.filter(d=>d.provenance.every(p=>p.active)).flatMap(d=>d.document.messages).map(m=>m.text)).toContain('现在喝茶');
 expect(createHistoryIndexBuilder(f.scope,r).query('咖啡').hits).toEqual([]);expect(digest(file)).toBe(before);
});
it('reports a damaged tail and keeps complete prefix readable without trimming source bytes',async()=>{
 const f=fixture(),{file}=write(f.root,[user(),assistant()]);fs.appendFileSync(file,'{"id":"broken"');const before=digest(file),r=await parseSyntheticFixture(f.scope);
 expect(r.coverage).toBe('partial');expect(r.diagnostics).toContain('MEMORY_HISTORY_TRUNCATED_TAIL');expect(r.documents).toHaveLength(1);expect(digest(file)).toBe(before);
});
it.each(['middle','snapshot'])('fails closed on corrupt %s without modifying source',async kind=>{
 const f=fixture(),{dir,file}=write(f.root,[user(),assistant()]);const target=kind==='middle'?file:path.join(dir,'snapshot.json');
 fs.writeFileSync(target,kind==='middle'?JSON.stringify(user())+'\nBROKEN\n'+JSON.stringify(assistant())+'\n':'{"schemaVersion":1,"entries":');
 const before=digest(target);await expect(parseSyntheticFixture(f.scope)).rejects.toThrow('MEMORY_HISTORY_CORRUPT');expect(digest(target)).toBe(before);
});
it('rejects conflicting duplicate seq/ID and invalid snapshot baseline',async()=>{
 const f=fixture(),{dir}=write(f.root,[user(),{...assistant(),seq:1}]);await expect(parseSyntheticFixture(f.scope)).rejects.toThrow('MEMORY_HISTORY_CORRUPT');
 write(f.root,[user()]);fs.writeFileSync(path.join(dir,'snapshot.json'),JSON.stringify({schemaVersion:1,throughSeq:2,entries:[user()],seenEntryIds:[],seenUserRevisions:[]}));await expect(parseSyntheticFixture(f.scope)).rejects.toThrow('MEMORY_HISTORY_CORRUPT');
});
it('chat fallback keeps original bubble apart from modelContext and segregates leading/user-labelled summaries',async()=>{
 const f=fixture(),dir=path.join(f.root,'firefly-chats','sessions');fs.mkdirSync(dir,{recursive:true});
 const file=path.join(dir,'session-a.json');fs.writeFileSync(file,JSON.stringify({id:'session-a',schemaVersion:1,mode:'chat',messages:[
  {id:'compact-legacy',role:'model',content:'[此前对话已压缩为记忆摘要]\n每天喝咖啡',at:1000},
  {id:'u',role:'user',content:'我只在周末喝咖啡',modelContext:'派生上下文每天喝',at:1001},
  {id:'fake',role:'user',content:'[此前对话已压缩为记忆摘要]\n我默认用 cmd',at:1002}]}));const before=digest(file),r=await parseSyntheticFixture(f.scope);
 expect(r.documents.some(d=>d.classification==='legacy-derived-unverified'&&d.document.messages[0].text.includes('每天喝咖啡'))).toBe(true);
 const raw=r.documents.filter(d=>d.classification==='raw-history');expect(raw.flatMap(d=>d.document.messages.map(m=>m.text))).toEqual(['我只在周末喝咖啡']);
 expect(r.documents.some(d=>d.classification==='legacy-derived-unverified'&&d.document.messages[0].text==='派生上下文每天喝')).toBe(true);
 expect(digest(file)).toBe(before);
});
it('preserves complete native tool arguments/name/result and does not manufacture orphan results',async()=>{
 const f=fixture(),call={id:'tool:1',name:'read_file',arguments:'{"path":"咖啡.txt","space":"  "}'};write(f.root,[user(),{...assistant(),payload:{role:'assistant',content:'查询',toolCalls:[call]}},{id:'result:3',seq:3,at:1003,kind:'tool_result',payload:{assistantEntryId:'a:2',toolCallId:'tool:1',outcome:'success',message:{role:'tool',toolCallId:'tool:1',name:'read_file',content:'原始咖啡结果'}}}]);
 const r=await parseSyntheticFixture(f.scope);expect(r.documents[0].document.messages[1].toolCalls).toEqual([call]);expect(r.documents[0].document.messages[2]).toMatchObject({name:'read_file',toolCallId:'tool:1',text:'原始咖啡结果'});
 write(f.root,[user(),{...assistant(),payload:{role:'assistant',content:'查询',toolCalls:[call]}}]);const bad=await parseSyntheticFixture(f.scope);expect(bad.coverage).toBe('partial');expect(bad.documents.every(d=>d.classification!=='raw-history')).toBe(true);expect(bad.documents.flatMap(d=>d.document.messages).some(m=>m.role==='tool')).toBe(false);
});
it('marked S without confirmed success remains diagnostics and cannot nominate default history',async()=>{
 const f=fixture();write(f.root,[user(),{...assistant(),runId:'run',turnId:'answer',sSettlement:{version:1,userTurnId:'u:1',userRevision:1}}]);const r=await parseSyntheticFixture(f.scope);
 expect(r.documents.some(d=>d.classification==='unverified'&&d.document.messages.some(m=>m.role==='assistant'))).toBe(true);
 expect(createHistoryIndexBuilder(f.scope,r).query('回复').hits).toEqual([]);
});
it('unknown event time stays null and range reports incomplete coverage',async()=>{
 const f=fixture(),dir=path.join(f.root,'firefly-chats','sessions');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'session-a.json'),JSON.stringify({id:'session-a',schemaVersion:1,mode:'chat',messages:[{id:'u',role:'user',content:'咖啡'}]}));
 const r=await parseSyntheticFixture(f.scope);expect(r.documents[0].provenance[0].occurredAt).toBeNull();const q=createHistoryIndexBuilder(f.scope,r).query('咖啡',{temporal:{kind:'range',from:0,to:2000}});expect(q.hits).toEqual([]);expect(q.temporal?.status).toBe('unavailable');
});
it('scope isolation, cancellation, unsafe path and symlink refusal perform no repairs',async()=>{
 const f=fixture();write(f.root,[user(),assistant()]);write(f.root,[user(1,'UNAUTHORIZED_SECRET_COFFEE')],'foreign');
 const before=digest(path.join(f.root,'transcripts','session-a','transcript.jsonl'));
 const controller=new AbortController();controller.abort();await expect(parseSyntheticFixture(f.scope,controller.signal)).rejects.toThrow('MEMORY_HISTORY_CANCELLED');
 await expect(parseSyntheticFixture({...f.scope,sessions:[{providerId:'synthetic',sessionId:'../foreign'}]})).rejects.toThrow('MEMORY_HISTORY_ACCESS_DENIED');
 const r=await parseSyntheticFixture(f.scope);expect(JSON.stringify(r)).not.toContain('UNAUTHORIZED_SECRET');expect(digest(path.join(f.root,'transcripts','session-a','transcript.jsonl'))).toBe(before);
});
it('Chinese lexical results are partitioned and duplicate locators across sessions do not collide',async()=>{
 const f=fixture();write(f.root,[user(1,'星河项目 PowerShell 默认终端'),assistant()]);write(f.root,[user(1,'星河项目 cmd 默认终端'),assistant()],'session-b');
 const r=await parseSyntheticFixture({...f.scope,sessions:[...f.scope.sessions,{providerId:'synthetic',sessionId:'session-b'}]});
 expect(new Set(r.documents.map(d=>d.document.id)).size).toBe(2);
 const q=createHistoryIndexBuilder(f.scope,r).query('星河项目 PowerShell');expect(q.hits).toHaveLength(1);expect(JSON.stringify(q)).not.toContain('cmd 默认终端');
 const small=createHistoryIndexBuilder({...f.scope,sessions:[...f.scope.sessions,{providerId:'synthetic',sessionId:'session-b'}]},r,{maxIndexDocuments:1});expect(small.query('星河').status).toBe('index-budget-exhausted');
});

it('uses the shared S success classifier while keeping interrupted/legacy-unknown answers diagnostic',async()=>{
 const f=fixture(),marked={...assistant(),runId:'run',turnId:'answer',roundId:'s-response',sSettlement:{version:1,userTurnId:'u:1',userRevision:1}};
 const binding={runId:'run',assistantTurnId:'answer',userTurnId:'u:1',userRevision:1,assistantEntryId:'a:2'};
 const marker={id:'settle:3',seq:3,at:1003,kind:'assistant_settlement',runId:'run',turnId:'answer',payload:{binding,result:'success',safeReason:'Completed'}};
 write(f.root,[user(),marked,marker]);const success=await parseSyntheticFixture(f.scope);
 expect(createHistoryIndexBuilder(f.scope,success).query('回复').hits).toHaveLength(1);
 write(f.root,[user(),marked,{...marker,payload:{...marker.payload,result:'interrupted'}}]);
 const interrupted=await parseSyntheticFixture(f.scope);expect(createHistoryIndexBuilder(f.scope,interrupted).query('回复').hits).toEqual([]);
 write(f.root,[user(),{...assistant(),roundId:'s-response'}]);const unknown=await parseSyntheticFixture(f.scope);expect(createHistoryIndexBuilder(f.scope,unknown).query('回复').hits).toEqual([]);
});
it('native modelContext retains original persisted ID and tagged legacy summaries cannot upgrade when prefix removed',async()=>{
 const f=fixture(),dir=path.join(f.root,'firefly-chats','sessions');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'session-a.json'),JSON.stringify({id:'session-a',schemaVersion:1,mode:'chat',messages:[
 {id:'original:u',role:'user',content:'咖啡原话',modelContext:'咖啡上下文',at:1000},{id:'legacy:u',role:'user',content:'没有摘要前缀的咖啡结论',isSummary:true,at:1001}]}));
 const r=await parseSyntheticFixture(f.scope),variant=r.documents.find(d=>d.document.messages[0].text==='咖啡上下文')!;
 expect(variant.provenance[0]).toMatchObject({originalId:'original:u',field:'modelContext'});
 expect(r.documents.find(d=>d.document.messages[0].text==='没有摘要前缀的咖啡结论')?.classification).toBe('legacy-derived-unverified');
});
it('labelled secrets and oversized turns remain diagnostics instead of lexical raw evidence',async()=>{
 const f=fixture();write(f.root,[user(1,'api_key: SYNTHETIC_SECRET_CANARY')]);const r=await parseSyntheticFixture(f.scope);
 expect(r.diagnostics).toContain('MEMORY_HISTORY_SECRET');expect(createHistoryIndexBuilder(f.scope,r).query('SYNTHETIC_SECRET_CANARY').hits).toEqual([]);
 write(f.root,[user(),...Array.from({length:128},(_,i)=>assistant(i+2,'咖啡'))]);const huge=await parseSyntheticFixture(f.scope);
 expect(huge.diagnostics).toContain('MEMORY_HISTORY_INPUT_LIMIT');expect(createHistoryIndexBuilder(f.scope,huge).query('咖啡').hits).toEqual([]);
});
it('native unavailable boundary refuses an existing escaping directory junction with both source trees unchanged',async()=>{
 const f=fixture(),outside=fixture();const target=write(outside.root,[user(1,'FOREIGN_JUNCTION_TEXT')]).file;
 fs.mkdirSync(path.join(f.root,'transcripts'),{recursive:true});fs.symlinkSync(path.join(outside.root,'transcripts','session-a'),path.join(f.root,'transcripts','session-a'),process.platform==='win32'?'junction':'dir');
 const before=digest(target);await expect(readFireflyHistory(f.scope)).rejects.toThrow('MEMORY_HISTORY_NATIVE_UNAVAILABLE');expect(digest(target)).toBe(before);
});
it.each([NaN,1.2,Infinity,-1])('index hard budgets reject non-integer configuration %s',async value=>{
 const f=fixture();write(f.root,[user()]);const r=await parseSyntheticFixture(f.scope);
 expect(()=>createHistoryIndexBuilder(f.scope,r,{maxIndexBytes:value})).toThrow('MEMORY_HISTORY_INPUT_INVALID');
});

it.each([undefined,null,'bogus',true])('does not promote missing or invalid tool outcome %s into raw execution evidence',async outcome=>{
 const f=fixture(),call={id:'call:1',name:'read_file',arguments:'{}'};
 const {file}=write(f.root,[user(),{...assistant(),payload:{role:'assistant',content:'lookup',toolCalls:[call]}},{id:'result:3',seq:3,at:1003,kind:'tool_result',payload:{assistantEntryId:'a:2',toolCallId:call.id,outcome,message:{role:'tool',toolCallId:call.id,content:'UNVERIFIED_RESULT_CANARY'}}}]);
 const before=digest(file);await expect(parseSyntheticFixture(f.scope)).rejects.toThrow('MEMORY_HISTORY_CORRUPT');expect(digest(file)).toBe(before);
});
it('native entry is unavailable before an ancestor junction swap can open or read foreign bytes',async()=>{
 const f=fixture(),outside=fixture(),{dir,file}=write(f.root,[user()]),foreign=write(outside.root,[user(1,'FOREIGN_RACE_CANARY')]).file;
 const localBefore=digest(file),foreignBefore=digest(foreign),originalOpen=fs.promises.open.bind(fs.promises);let changed=false,foreignReads=0;
 const moved=dir+'-checked-original';
 const spy=vi.spyOn(fs.promises,'open').mockImplementation(async(...args:Parameters<typeof fs.promises.open>)=>{
  if(String(args[0])===file&&!changed){changed=true;fs.renameSync(dir,moved);fs.symlinkSync(path.dirname(foreign),dir,process.platform==='win32'?'junction':'dir');
   const handle=await originalOpen(...args),originalRead=handle.readFile.bind(handle);vi.spyOn(handle,'readFile').mockImplementation(async()=>{foreignReads++;return originalRead()});return handle;
  }return originalOpen(...args);
 });
 try{await expect(readFireflyHistory(f.scope)).rejects.toThrow('MEMORY_HISTORY_NATIVE_UNAVAILABLE');expect(digest(foreign)).toBe(foreignBefore);expect(digest(file)).toBe(localBefore);expect(changed).toBe(false);expect(foreignReads).toBe(0);expect(spy).not.toHaveBeenCalled()}
 finally{spy.mockRestore();if(changed){fs.unlinkSync(dir);fs.renameSync(moved,dir)}}
});
it('native entry fails unavailable before even inspecting original paths',async()=>{
 const f=fixture(),{file}=write(f.root,[user()]),before=digest(file);
 const opened=vi.spyOn(fs.promises,'open'),resolved=vi.spyOn(fs.promises,'realpath'),read=vi.spyOn(fs.promises,'readFile');
 try{await expect(readFireflyHistory(f.scope)).rejects.toThrow('MEMORY_HISTORY_NATIVE_UNAVAILABLE');expect(opened).not.toHaveBeenCalled();expect(resolved).not.toHaveBeenCalled();expect(read).not.toHaveBeenCalled();expect(digest(file)).toBe(before)}
 finally{opened.mockRestore();resolved.mockRestore();read.mockRestore()}
});
it('pure bytes parsing ignores foreign invalid payloads and cannot mint canonical source authority',()=>{
 const f=fixture(),input={providerId:'synthetic',sessionId:'session-a',incarnation:'synthetic-bytes-v1',transcript:Buffer.from(JSON.stringify(user())+'\n'),snapshot:null,chat:null};
 const opened=vi.spyOn(fs.promises,'open'),read=vi.spyOn(fs,'readFileSync');
 try{
  const r=parseFireflyHistoryBytes(f.scope,[input,{...input,sessionId:'foreign',transcript:Buffer.from([255]),chat:new Uint8Array(8*1024*1024+1)}]);
  expect(r.documents).toHaveLength(1);expect(r.documents[0].document.sourceDeps).toEqual([]);expect(r.documents[0].document.messages[0].sourceRef).toBeUndefined();expect(opened).not.toHaveBeenCalled();expect(read).not.toHaveBeenCalled();
 }finally{opened.mockRestore();read.mockRestore()}
});
it.each(['invalid-utf8','byte-budget'])('pure parser rejects supplied %s bytes without I/O',kind=>{
 const f=fixture(),input={providerId:'synthetic',sessionId:'session-a',incarnation:'synthetic-bytes-v1',transcript:kind==='invalid-utf8'?Buffer.from([255]):new Uint8Array(8*1024*1024+1),snapshot:null,chat:null};
 expect(()=>parseFireflyHistoryBytes(f.scope,[input])).toThrow(kind==='invalid-utf8'?'MEMORY_HISTORY_CORRUPT':'MEMORY_HISTORY_INPUT_INVALID');
});

it('selection head counts physical rewind and settlement entries rather than projected messages',async()=>{
 const f=fixture(),rows=[user(),assistant(),{id:'settled:3',seq:3,at:1003,kind:'backfill_boundary',payload:{}},{id:'edit:4',seq:4,at:1004,kind:'turn_rewind',turnId:'u:1',revision:2,payload:{anchorUserTurnId:'u:1',disposition:'replace_user',reason:'edit',replacementUser:{text:'茶'}}}];
 const {dir,file}=write(f.root,rows);
 fs.writeFileSync(path.join(dir,'snapshot.json'),JSON.stringify({schemaVersion:1,throughSeq:2,entries:rows.slice(0,2),seenEntryIds:['backfill:v1:u:1','a:2'],seenUserRevisions:['u:1\u00001']}));
 const r=await parseSyntheticFixture(f.scope);
 expect(r.selectionHeads).toEqual([{providerId:'synthetic',sessionId:'session-a',incarnation:r.documents[0].document.incarnation,maxSeq:4,checkpointThroughSeq:2,completeTail:true}]);
 fs.appendFileSync(file,'BROKEN');expect((await parseSyntheticFixture(f.scope)).selectionHeads[0]).toMatchObject({maxSeq:4,completeTail:false});
});
