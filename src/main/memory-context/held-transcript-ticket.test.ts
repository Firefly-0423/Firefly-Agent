import {ConversationTranscriptStore} from '../orchestrator/conversation-transcript-store';
import {afterEach,expect,it} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true})});
it('held readonly acquisition is bound to exact live guarded store session root and callback phase',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'smh-ticket-'));roots.push(root);
 const store=new ConversationTranscriptStore(root),foreign=new ConversationTranscriptStore(root);
 let ticket:object|undefined;let acquired=0;
 const guard={throughSeq:0,validate:async(value:object)=>{
  ticket=value;
  await store.withHeldReadonlyBarrier(value,'session',path.join(root,'transcripts'),async()=>{acquired++});
  for(const [candidate,session,targetRoot,owner] of [[structuredClone(value),'session',path.join(root,'transcripts'),store],[value,'other',path.join(root,'transcripts'),store],[value,'session',root,store],[value,'session',path.join(root,'transcripts'),foreign]] as const){
   await expect(owner.withHeldReadonlyBarrier(candidate,session,targetRoot,async()=>{acquired++})).rejects.toThrow('TRANSCRIPT_HELD_TICKET_DENIED');
  }
 },commit:async(write:()=>Promise<any>,value:object)=>{
  expect(value).toBe(ticket);
  await expect(store.withHeldReadonlyBarrier(value,'session',path.join(root,'transcripts'),async()=>{acquired++})).rejects.toThrow('TRANSCRIPT_HELD_TICKET_DENIED');
  return write();
 }};
 await store.append('session',{kind:'user',id:'user',turnId:'turn',revision:1,payload:{text:'synthetic'}},guard);
 await expect(store.withHeldReadonlyBarrier(ticket!,'session',path.join(root,'transcripts'),async()=>{acquired++})).rejects.toThrow('TRANSCRIPT_HELD_TICKET_DENIED');
 expect(acquired).toBe(1);
});
it('unawaited held acquisition must finish exact cleanup before append and cleanup failure denies write',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'smh-ticket-drain-'));roots.push(root);const store=new ConversationTranscriptStore(root);
 let entered!:()=>void,release!:()=>void,wrote=false;const started=new Promise<void>(r=>entered=r),hold=new Promise<void>(r=>release=r);
 const append=store.append('session',{kind:'user',id:'user',turnId:'turn',revision:1,payload:{text:'synthetic'}},{throughSeq:0,validate:async ticket=>{void store.withHeldReadonlyBarrier(ticket,'session',path.join(root,'transcripts'),async()=>{entered();await hold;throw Error('exact cleanup failure')}).catch(()=>{})},commit:async write=>{wrote=true;return write()}});
 const failed=expect(append).rejects.toThrow('exact cleanup failure');await started;
 try{await new Promise<void>(setImmediate);expect(wrote).toBe(false)}finally{release();await failed}
 expect(wrote).toBe(false);expect((await store.read('session')).entries).toEqual([]);
});
it('a swallowed undefined held failure still denies append',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'smh-ticket-undefined-'));roots.push(root);const store=new ConversationTranscriptStore(root);let wrote=false;
 const append=store.append('session',{kind:'user',id:'user',turnId:'turn',revision:1,payload:{text:'synthetic'}},{throughSeq:0,validate:async ticket=>{await store.withHeldReadonlyBarrier(ticket,'session',path.join(root,'transcripts'),async()=>{throw undefined}).catch(()=>{})},commit:async write=>{wrote=true;return write()}});
 await expect(append).rejects.toBeUndefined();expect(wrote).toBe(false);expect((await store.read('session')).entries).toEqual([]);
});
it('throwing guard still waits its unawaited held cleanup before failure acknowledgement and next queued work',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'smh-ticket-throw-'));roots.push(root);const store=new ConversationTranscriptStore(root);
 let entered!:()=>void,release!:()=>void,acknowledged=false,next=false;const started=new Promise<void>(r=>entered=r),hold=new Promise<void>(r=>release=r);
 const append=store.append('session',{kind:'user',id:'user',turnId:'turn',revision:1,payload:{text:'synthetic'}},{throughSeq:0,validate:async ticket=>{void store.withHeldReadonlyBarrier(ticket,'session',path.join(root,'transcripts'),async()=>{entered();await hold}).catch(()=>{});throw Error('guard failure')},commit:write=>write()}).finally(()=>{acknowledged=true});
 const failed=expect(append).rejects.toThrow('guard failure');await started;const queued=store.withReadonlyBarrier('session',async()=>{next=true});
 try{await new Promise<void>(setImmediate);expect(acknowledged).toBe(false);expect(next).toBe(false)}finally{release();await failed;await queued}
 expect((await store.read('session')).entries).toEqual([]);
});
