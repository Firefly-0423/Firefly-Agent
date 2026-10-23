import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import {it,expect,vi} from 'vitest';
import {createNativeHistoryEndpointFactory} from './native-history-transport';
// The injected child is synthetic, but the production absolute-root preflight is real.
const ROOT=path.join(os.tmpdir(),'firefly-history-transport-synthetic');
const identity={volumeSerial:42,fileIndex:'1234567890abcdef'};
function child(){const c:any=new EventEmitter();c.stdin=new PassThrough();c.stdout=new PassThrough();c.stderr=new PassThrough();c.kills=0;c.kill=()=>{c.kills++;queueMicrotask(()=>c.emit('close',null,'SIGTERM'));return true};return c}
function setup(){const c=child(),controller=new AbortController(),factory=createNativeHistoryEndpointFactory({spawn:()=>c});const pending=factory({root:ROOT,deadlineAt:performance.now()+1000,signal:controller.signal});const emit=(v:unknown)=>c.stdout.write(JSON.stringify(v)+'\n');emit({type:'ready',version:1,rootIdentity:identity});return {c,controller,pending,emit}}
it('holds a validated snapshot until released acknowledgement and exact child close',async()=>{
 const f=setup(),endpoint=await f.pending;const read=endpoint.read(['session','snapshot.json'],2);
 f.emit({type:'snapshot',version:1,identity,rawLength:2,bytesHex:'6162'});expect((await read).bytes).toEqual(new Uint8Array([97,98]));endpoint.assertLive();
 const disposed=endpoint.dispose('release');f.emit({type:'released',version:1});f.c.emit('close',0,null);await disposed;await endpoint.dispose('release');expect(f.c.kills).toBe(0);expect(()=>endpoint.assertLive()).toThrow();
});
it.each([
 {type:'ready',version:1,rootIdentity:identity,extra:true},
 {type:'ready',version:2,rootIdentity:identity},
 {type:'snapshot',version:1,identity,rawLength:0,bytesHex:''},
 {type:'ready',version:1,rootIdentity:{...identity,fileIndex:'1'}},
 {type:'error',version:1,code:'unrecognized-child-text'},
])('rejects invalid protocol before authority with exact child termination',async event=>{
 const c=child(),factory=createNativeHistoryEndpointFactory({spawn:()=>c}),pending=factory({root:ROOT,deadlineAt:performance.now()+1000,signal:new AbortController().signal});c.stdout.write(JSON.stringify(event)+'\n');await expect(pending).rejects.toThrow('MEMORY_HISTORY_NATIVE_PROTOCOL_INVALID');expect(c.kills).toBe(1);
});
it.each([{rawLength:2,bytesHex:'61'},{rawLength:1,bytesHex:'GG'},{rawLength:3,bytesHex:'616263'}])('refuses mismatched hex and byte budgets',async body=>{
 const f=setup(),endpoint=await f.pending,read=endpoint.read(['session','snapshot.json'],2);f.emit({type:'snapshot',version:1,identity,...body});await expect(read).rejects.toThrow('MEMORY_HISTORY_NATIVE_PROTOCOL_INVALID');await endpoint.dispose('cancel');expect(f.c.kills).toBe(1);
});
it('abort, late bytes and premature exit cannot leave a usable lease',async()=>{
 const f=setup(),endpoint=await f.pending,read=endpoint.read(['session','snapshot.json'],2);f.controller.abort();f.emit({type:'snapshot',version:1,identity,rawLength:2,bytesHex:'6162'});await expect(read).rejects.toThrow('MEMORY_HISTORY_CANCELLED');expect(()=>endpoint.assertLive()).toThrow('MEMORY_HISTORY_CANCELLED');await endpoint.dispose('cancel');expect(f.c.kills).toBe(1);
 const g=setup(),other=await g.pending;g.c.emit('close',0,null);expect(()=>other.assertLive()).toThrow('MEMORY_HISTORY_NATIVE_PROTOCOL_INVALID');
});
it('deadline terminates the same child even with a blocked pipe',async()=>{
 const c=child(),factory=createNativeHistoryEndpointFactory({spawn:()=>c});await expect(factory({root:ROOT,deadlineAt:performance.now()+20,signal:new AbortController().signal})).rejects.toThrow('MEMORY_HISTORY_NATIVE_TIMEOUT');expect(c.kills).toBe(1);
});

it('invalid protocol during release is an error acknowledgement, not successful disposal',async()=>{
 const f=setup(),endpoint=await f.pending,read=endpoint.read(['session','snapshot.json'],2);f.emit({type:'snapshot',version:1,identity,rawLength:2,bytesHex:'6162'});await read;
 const disposed=endpoint.dispose('release');f.emit({type:'released',version:1});f.emit({type:'released',version:1});await expect(disposed).rejects.toThrow('MEMORY_HISTORY_NATIVE_PROTOCOL_INVALID');expect(f.c.kills).toBe(1);
});

it('consumes stdin pipe errors and fails the exact child acquisition without an uncaught event',async()=>{
 const f=setup(),endpoint=await f.pending,read=endpoint.read(['session','snapshot.json'],2);
 expect(()=>f.c.stdin.emit('error',Object.assign(Error('broken pipe'),{code:'EPIPE'}))).not.toThrow();await expect(read).rejects.toThrow('MEMORY_HISTORY_NATIVE_PROTOCOL_INVALID');await endpoint.dispose('cancel');expect(f.c.kills).toBe(1);
});

it('cleanup timeout keeps disposal pending until exact child closure is confirmed',async()=>{
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});const f=setup(),endpoint=await f.pending;f.c.kill=()=>{f.c.kills++;return true};f.controller.abort();let settled=false;
 const disposed=endpoint.dispose('cancel').catch(error=>{settled=true;throw error}),failed=expect(disposed).rejects.toThrow('MEMORY_HISTORY_NATIVE_TIMEOUT');
 try{await vi.advanceTimersByTimeAsync(1001);expect(settled).toBe(false)}finally{f.c.emit('close',null,'SIGTERM');await failed;vi.useRealTimers()}
});

it('failed readiness retains cleanup until the exact child closes',async()=>{
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});const c=child();c.kill=()=>{c.kills++;return true};const factory=createNativeHistoryEndpointFactory({spawn:()=>c});let settled=false;
 const pending=factory({root:ROOT,deadlineAt:performance.now()+1000,signal:new AbortController().signal}).catch(error=>{settled=true;throw error}),failed=expect(pending).rejects.toThrow('MEMORY_HISTORY_NATIVE_PROTOCOL_INVALID');c.stdout.write(JSON.stringify({type:'ready',version:2,rootIdentity:identity})+'\n');
 try{await vi.advanceTimersByTimeAsync(1001);expect(settled).toBe(false)}finally{c.emit('close',null,'SIGTERM');await failed;vi.useRealTimers()}
});

it('send-time expiry waits for close and keeps stdio error consumers installed',async()=>{
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});const f=setup(),endpoint=await f.pending;f.c.kill=()=>{f.c.kills++;return true};const expired=performance.now()+2000;vi.spyOn(performance,'now').mockReturnValue(expired);let settled=false;
 const disposed=endpoint.dispose('release').catch(error=>{settled=true;throw error}),failed=expect(disposed).rejects.toThrow('MEMORY_HISTORY_NATIVE_TIMEOUT');
 try{await vi.advanceTimersByTimeAsync(2);expect(settled).toBe(false);expect(()=>f.c.stdin.emit('error',Error('EPIPE'))).not.toThrow();expect(()=>f.c.stderr.emit('error',Error('late pipe'))).not.toThrow()}finally{f.c.emit('close',null,'SIGTERM');await failed;vi.restoreAllMocks();vi.useRealTimers()}
});

it('valid ready followed by a protocol fault in the same chunk cannot return a failed endpoint',async()=>{
 const c=child();c.kill=()=>{c.kills++;return true};const factory=createNativeHistoryEndpointFactory({spawn:()=>c});let settled=false;
 const pending=factory({root:ROOT,deadlineAt:performance.now()+1000,signal:new AbortController().signal}),outcome=pending.then(()=>{settled=true;return 'unexpected endpoint'},error=>{settled=true;return error.message});
 c.stdout.write(JSON.stringify({type:'ready',version:1,rootIdentity:identity})+'\n'+JSON.stringify({type:'ready',version:2,rootIdentity:identity})+'\n');
 try{await new Promise<void>(setImmediate);expect(settled).toBe(false)}finally{c.emit('close',null,'SIGTERM');expect(await outcome).toBe('MEMORY_HISTORY_NATIVE_PROTOCOL_INVALID')}
});
