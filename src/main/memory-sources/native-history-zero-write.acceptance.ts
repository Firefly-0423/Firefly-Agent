import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {afterEach,afterAll,it,expect,vi} from 'vitest';
import {recallFixture} from '../../../scripts/verify/memory-recall/recall-fixture';
import {createMainHistory} from '../memory-history/main-history';
import {ConversationTranscriptStore} from '../orchestrator/conversation-transcript-store';
import {initializeStorageContext} from '../storage-context';
import {resolveRuntimeProfile} from '../runtime-profile';
import {createNativeHistoryProvider} from './native-history-provider';
import {createNativeHistoryEndpointFactory} from './native-history-transport';
// E: is the local acceptance workspace, not a universal drive-letter requirement.
// CI must explicitly supply a dedicated local NTFS synthetic root and matching TEMP/TMP.
const syntheticRoot=process.env.FF_HISTORY_TEST_ROOT;
if(process.platform!=='win32'||!syntheticRoot||!path.isAbsolute(syntheticRoot)||!fs.statSync(syntheticRoot).isDirectory()||path.resolve(os.tmpdir()).toLowerCase()!==path.resolve(syntheticRoot).toLowerCase())throw Error('EXPLICIT_WINDOWS_NTFS_SYNTHETIC_ROOT_REQUIRED');
const isolation=fs.mkdtempSync(path.join(syntheticRoot,'h-zero-write-'));
const storage=initializeStorageContext(resolveRuntimeProfile({argv:['--firefly-profile=test','--firefly-isolation-root='+isolation],env:{},isPackaged:false,productionAppData:path.join(os.tmpdir(),'synthetic-production-never-used')}));
const fixtures:ReturnType<typeof recallFixture>[]=[];
afterEach(()=>{vi.restoreAllMocks();for(const f of fixtures.splice(0))f.close();fs.rmSync(path.join(storage.dataRoot,'transcripts'),{recursive:true,force:true})});
afterAll(()=>fs.rmSync(isolation,{recursive:true,force:true}));
function sourceState(root:string):unknown[]{if(!fs.existsSync(root))return [];return fs.readdirSync(root,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(entry=>{const target=path.join(root,entry.name);if(entry.isDirectory())return [{path:target},...sourceState(target)];const stat=fs.statSync(target);return [{path:target,size:stat.size,modified:stat.mtimeMs,digest:createHash('sha256').update(fs.readFileSync(target)).digest('hex')}]})}
it.each(['valid','missing-snapshot','missing-session','broken-tail','broken-snapshot','cancel','timeout','refused'])('whole %s capture/query makes zero source write attempts through actual readonly barrier',async kind=>{
 const f=recallFixture();fixtures.push(f);const store=new ConversationTranscriptStore(storage.dataRoot),sourceRoot=path.join(storage.dataRoot,'transcripts'),session=path.join(sourceRoot,'session-a');
 await store.append('session-a',{id:'u',kind:'user',turnId:'turn',revision:1,payload:{text:'harbor coffee'},at:1000});await store.checkpoint('session-a');
 if(kind==='missing-snapshot')fs.unlinkSync(path.join(session,'snapshot.json'));
 if(kind==='missing-session')fs.rmSync(session,{recursive:true});
 if(kind==='broken-tail')fs.appendFileSync(path.join(session,'transcript.jsonl'),'BROKEN');
 if(kind==='broken-snapshot')fs.writeFileSync(path.join(session,'snapshot.json'),'BROKEN');
 const helper=process.env.FF_HISTORY_HELPER;if(!helper||!path.isAbsolute(helper)||!fs.existsSync(helper))throw Error('EXACT_SYNTHETIC_HELPER_REQUIRED');
 const factory=createNativeHistoryEndpointFactory({spawn:input=>spawn(helper,['--root',input.root,'--parent-pid',String(process.pid),'--deadline-ms',String(input.deadlineMs)],{windowsHide:true,stdio:['pipe','pipe','pipe']})});
 const history=createMainHistory({actorAuthority:f.authority,registry:f.registry,transport:{...f.transport,historyCommand:async(c:unknown)=>f.repo.historyCommand(c)}});
 const native=createNativeHistoryProvider({actorAuthority:f.authority,actorToken:f.actor,store,history,deadlineMs:10000,endpointFactory:kind==='timeout'||kind==='refused'?async()=>{throw Error(kind==='timeout'?'MEMORY_HISTORY_NATIVE_TIMEOUT':'history-native-open-failed')}:factory});
 const before=sourceState(sourceRoot),attempts:string[]=[];
 const spies=['mkdir','writeFile','appendFile','truncate','rename','rm','unlink','open'].map(name=>{
  const api=fs.promises as any,original=api[name].bind(api);return vi.spyOn(api,name).mockImplementation((...args:any[])=>{const target=typeof args[0]==='string'?path.resolve(args[0]):'';if(target===sourceRoot||target.startsWith(sourceRoot+path.sep)){
   if(name!=='open'||args[1]!=='r')attempts.push(name);
  }return original(...args)});
 });
 const guards=[vi.spyOn(store,'withReadLease'),vi.spyOn(store,'read'),vi.spyOn(store,'checkpoint')];
 try{
  const controller=new AbortController();if(kind==='cancel')controller.abort();
  if(['broken-snapshot','cancel','timeout','refused','missing-session'].includes(kind))await expect(native.capture(controller.signal)).rejects.toThrow();
  else {
   const capture=await native.capture(controller.signal);
   if(kind==='valid'){expect(capture).toMatchObject({status:'captured',captured:1});const query=await native.query({query:'harbor'});expect(query.status).toBe('queried')}
   else{expect(capture).toMatchObject({status:'coverage-insufficient'});expect(await native.query({query:'harbor'})).not.toHaveProperty('result')}
  }
  await native.close();expect(attempts).toEqual([]);for(const guard of guards)expect(guard).not.toHaveBeenCalled();
 }finally{for(const spy of [...spies,...guards])spy.mockRestore();await native.close()}
 expect(sourceState(sourceRoot)).toEqual(before);
 if(kind==='missing-snapshot')expect(fs.existsSync(path.join(session,'snapshot.json'))).toBe(false);
});

// Real IPC probe: the debug reader pauses after the first 64 KiB while unread
// chunks remain. The separate precommit window pauses after all bytes are read.
async function nativeCancellationProbe(mode:'read'|'precommit'|'release-control',controlBarrier='read'){
 const helper=process.env[mode==='release-control'?'FF_HISTORY_RELEASE_HELPER':'FF_HISTORY_HELPER'];if(!helper||!path.isAbsolute(helper)||!fs.existsSync(helper))throw Error('EXACT_SYNTHETIC_HELPER_REQUIRED');
 const root=path.join(storage.dataRoot,'transcripts'),session=path.join(root,'cancel-window');fs.mkdirSync(session,{recursive:true});fs.writeFileSync(path.join(session,'history'),Buffer.alloc(128*1024,65));const before=sourceState(root);
 const child=spawn(helper,['--root',root,'--parent-pid',String(process.pid),'--deadline-ms','10000'],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,FF_HISTORY_TEST_PRECOMMIT_CANCEL:mode==='release-control'?controlBarrier:mode==='precommit'?'1':'read'}});
 const events:any[]=[];let buffer='',markers='',readSent=false,cancelSent=false;const close=new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)});let timeout:ReturnType<typeof setTimeout>|undefined;
 child.stdout.on('data',chunk=>{buffer+=chunk.toString();for(;;){const newline=buffer.indexOf('\n');if(newline<0)break;const event=JSON.parse(buffer.slice(0,newline));buffer=buffer.slice(newline+1);events.push(event);if(event.type==='ready'&&!readSent){readSent=true;child.stdin.write(JSON.stringify({type:'read',version:1,components:['cancel-window','history'],maxBytes:256*1024})+'\n')}if(mode==='release-control'&&event.type==='snapshot')child.stdin.write(JSON.stringify({type:'release',version:1})+'\n')}});
 child.stderr.on('data',chunk=>{markers+=chunk.toString();if(mode!=='release-control'&&!cancelSent&&markers.includes(mode==='read'?'history-test-read-active':'history-test-precommit')){cancelSent=true;child.stdin.write(JSON.stringify({type:'cancel',version:1})+'\n')}});
 try{
  const code=await Promise.race([close,new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(Error('REAL_CANCEL_BARRIER_NOT_OBSERVED')),8000)})]);expect(code).toBe(0);expect(buffer).toBe('');expect(readSent).toBe(true);
  if(mode==='release-control'){expect(markers).not.toContain('history-test-');expect(events.map(e=>e.type)).toEqual(['ready','snapshot','released'])}
  else{expect(cancelSent).toBe(true);expect(events.map(e=>e.type)).toEqual(['ready','cancelled']);expect(events.some(e=>e.type==='snapshot')).toBe(false);expect(markers.trim()).toBe(mode==='read'?'history-test-read-active':'history-test-precommit')}
 }finally{if(timeout)clearTimeout(timeout);if(child.exitCode===null){child.kill();await close}expect(sourceState(root)).toEqual(before)}
}
it('A29 real native IPC cancel during a partial source read suppresses publication',()=>nativeCancellationProbe('read'),15000);
it('real native IPC cancel after reading and before CAS suppresses publication',()=>nativeCancellationProbe('precommit'),15000);
it.each(['read','1'])('release native binary ignores debug-only barrier environment %s',barrier=>nativeCancellationProbe('release-control',barrier),15000);
