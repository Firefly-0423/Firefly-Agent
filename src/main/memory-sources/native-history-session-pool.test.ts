import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import {it,expect} from 'vitest';
import {createNativeHistorySessionPool} from './native-history-session-pool';
// The injected helpers are synthetic, but the production absolute-root preflight is real.
const ROOT=path.join(os.tmpdir(),'firefly-history-pool-synthetic');
const identity={volumeSerial:42,fileIndex:'1234567890abcdef'};
type Fake=EventEmitter&{stdin:PassThrough;stdout:PassThrough;stderr:PassThrough;kills:number;reads:number;commands:string[];kill():boolean;emitEvent(v:unknown):void;answer:boolean};
/** A synthetic resident helper that answers like firefly-history-read --idle-ms, unless `answer` is off. */
function helper():Fake {
 const c=new EventEmitter() as Fake;Object.assign(c,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kills:0,reads:0,commands:[],answer:true});
 c.emitEvent=v=>c.stdout.write(JSON.stringify(v)+'\n');
 c.kill=()=>{c.kills++;queueMicrotask(()=>c.emit('close',null,'SIGTERM'));return true};
 let pending='';
 c.stdin.on('data',chunk=>{pending+=String(chunk);for(let at=pending.indexOf('\n');at>=0;at=pending.indexOf('\n')){const command=JSON.parse(pending.slice(0,at));pending=pending.slice(at+1);c.commands.push(command.type);if(!c.answer)continue;
  if(command.type==='read'){c.reads++;c.emitEvent({type:'snapshot',version:2,identity,rawLength:2,bytesHex:'6162'})}
  else if(command.type==='release')c.emitEvent({type:'released',version:2});
  else if(command.type==='cancel')c.emitEvent({type:'cancelled',version:2});
  else if(command.type==='close'){c.emitEvent({type:'closed',version:2});queueMicrotask(()=>c.emit('close',0,null))}}});
 queueMicrotask(()=>c.emitEvent({type:'ready',version:2,rootIdentity:identity}));
 return c;
}
function setup(size=2){const spawned:Fake[]=[];const pool=createNativeHistorySessionPool({spawn:()=>{const c=helper();spawned.push(c);return c as never},size});return {pool,spawned}}
const acquire=(pool:ReturnType<typeof setup>['pool'],signal=new AbortController().signal,ms=2000)=>pool({root:ROOT,deadlineAt:performance.now()+ms,signal});

it('reuses one resident helper for consecutive reads instead of a process per read',async()=>{
 const f=setup();
 for(let i=0;i<5;i++){const endpoint=await acquire(f.pool);expect(endpoint.rootIdentity).toEqual(identity);expect((await endpoint.read(['session','snapshot.json'],2)).bytes).toEqual(new Uint8Array([97,98]));await endpoint.dispose('release')}
 expect(f.spawned).toHaveLength(1);expect(f.spawned[0].reads).toBe(5);expect(f.spawned[0].kills).toBe(0);
 await f.pool.close();expect(f.spawned[0].kills).toBe(1);
});
it('holds two leases at once on two helpers and queues a third until one is released',async()=>{
 const f=setup(2),a=await acquire(f.pool),b=await acquire(f.pool);await a.read(['s','snapshot.json'],2);await b.read(['s','transcript.jsonl'],2);
 let third=false;const pending=acquire(f.pool).then(endpoint=>{third=true;return endpoint});
 await new Promise(r=>setTimeout(r,20));expect(third).toBe(false);expect(f.spawned).toHaveLength(2);
 await a.dispose('release');const c=await pending;expect(f.spawned).toHaveLength(2);await c.dispose('release');await b.dispose('cancel');
 expect(f.spawned.flatMap(s=>s.commands)).toContain('cancel');await f.pool.close();
});
it('kills a helper that breaks the protocol and gives the next caller a fresh one',async()=>{
 const f=setup(),endpoint=await acquire(f.pool);f.spawned[0].answer=false;const read=endpoint.read(['s','snapshot.json'],2);
 f.spawned[0].emitEvent({type:'snapshot',version:1,identity,rawLength:2,bytesHex:'6162'});
 await expect(read).rejects.toThrow('MEMORY_HISTORY_NATIVE_PROTOCOL_INVALID');expect(f.spawned[0].kills).toBe(1);
 await endpoint.dispose('release');
 const next=await acquire(f.pool);expect(f.spawned).toHaveLength(2);await next.dispose('release');await f.pool.close();
});
it('times out a lease that is never acknowledged and waits for that helper to close',async()=>{
 const f=setup(),endpoint=await acquire(f.pool,undefined,150);await endpoint.read(['s','snapshot.json'],2);f.spawned[0].answer=false;
 let closed=false;f.spawned[0].once('close',()=>{closed=true});
 await expect(endpoint.dispose('release')).rejects.toThrow('MEMORY_HISTORY_NATIVE_TIMEOUT');expect(closed).toBe(true);expect(f.spawned[0].kills).toBe(1);
 await f.pool.close();
});
it('an abort while reading ends that helper; a released helper stays for the next read',async()=>{
 const f=setup(),controller=new AbortController(),endpoint=await acquire(f.pool,controller.signal);f.spawned[0].answer=false;
 const read=endpoint.read(['s','snapshot.json'],2);controller.abort();await expect(read).rejects.toThrow('MEMORY_HISTORY_CANCELLED');
 await endpoint.dispose('cancel');expect(f.spawned[0].kills).toBe(1);
 const next=await acquire(f.pool);await next.read(['s','snapshot.json'],2);await next.dispose('release');
 const again=await acquire(f.pool);await again.dispose('release');expect(f.spawned).toHaveLength(2);await f.pool.close();
});
it('a helper that exits while idle is replaced without failing anyone',async()=>{
 const f=setup(),endpoint=await acquire(f.pool);await endpoint.dispose('release');f.spawned[0].emit('close',0,null);
 const next=await acquire(f.pool);await next.read(['s','snapshot.json'],2);await next.dispose('release');expect(f.spawned).toHaveLength(2);await f.pool.close();
});
it('refuses relative roots and new work after close',async()=>{
 const f=setup();await expect(f.pool({root:'relative',deadlineAt:performance.now()+1000,signal:new AbortController().signal})).rejects.toThrow('MEMORY_HISTORY_NATIVE_TIMEOUT');
 await f.pool.close();await expect(acquire(f.pool)).rejects.toThrow('MEMORY_HISTORY_CANCELLED');expect(f.spawned).toHaveLength(0);
});
it('an abort after the read finished only ends that endpoint; the helper is released and reused',async()=>{
 const f=setup(),controller=new AbortController(),endpoint=await acquire(f.pool,controller.signal);await endpoint.read(['s','snapshot.json'],2);
 controller.abort();expect(()=>endpoint.assertLive()).toThrow('MEMORY_HISTORY_CANCELLED');
 await endpoint.dispose('cancel');expect(f.spawned[0].kills).toBe(0);expect(f.spawned[0].commands).toContain('cancel');
 const next=await acquire(f.pool);await next.read(['s','snapshot.json'],2);await next.dispose('release');expect(f.spawned).toHaveLength(1);await f.pool.close();
});
