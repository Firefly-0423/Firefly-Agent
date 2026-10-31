import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import path from 'node:path';
import {objectFields} from '../memory-core/command-validation';
import {MAX_INPUT,MAX_OUTPUT,NATIVE_CODES,deferred,identity,type NativeHistoryEndpoint,type NativeHistoryEndpointFactory,type NativeHistoryIdentity} from './native-history-transport';

const PROTOCOL='MEMORY_HISTORY_NATIVE_PROTOCOL_INVALID',TIMEOUT='MEMORY_HISTORY_NATIVE_TIMEOUT',CANCELLED='MEMORY_HISTORY_CANCELLED',VERSION=2;
function fail(code:string):never{throw Error(code)}
type Event=Record<string,unknown>&{type:string};
interface Session {
 readonly root:string;readonly child:ChildProcessWithoutNullStreams;readonly closed:Promise<void>;
 rootIdentity?:NativeHistoryIdentity;busy:boolean;dead:boolean;
 expect?:{types:readonly string[];resolve:(event:Event)=>void;reject:(error:Error)=>void};
 kill(code:string):void;send(value:object):void;
}
export interface NativeHistorySessionPool extends NativeHistoryEndpointFactory {close():Promise<void>}

/**
 * Resident firefly-history-read sessions (`--idle-ms`); up to `size` stay between uses. A session serves
 * one endpoint at a time. When every resident one is leased, a caller gets an extra helper that ends on
 * release instead of waiting: a history read holds one lease while it asks for its second, so waiting
 * for capacity could deadlock overlapping reads. every read still reopens and re-proves the files on disk. Any protocol error,
 * timeout or abort kills that session, and its endpoint's dispose waits for the process to close, as
 * the one-shot endpoint does. Only a trusted Main composition supplies `spawn`.
 */
export function createNativeHistorySessionPool(options:{spawn:(input:{root:string;idleMs:number})=>ChildProcessWithoutNullStreams;size?:number;idleMs?:number;clock?:()=>number}):NativeHistorySessionPool {
 const clock=options.clock??(()=>performance.now()),size=options.size??4,idleMs=options.idleMs??20_000;
 // `sessions` can serve; `alive` also holds killed ones until their process has closed.
 const sessions:Session[]=[],alive=new Set<Session>();
 let closing=false;
 function start(root:string):Session {
  const child=options.spawn({root,idleMs}),closed=deferred<void>();
  let buffer=Buffer.alloc(0),killed=false;
  const session:Session={root,child,closed:closed.promise,busy:true,dead:false,
   kill(code){
    if(session.dead)return;session.dead=true;remove();
    if(!killed){killed=true;child.kill()}
    const waiter=session.expect;session.expect=undefined;waiter?.reject(Error(code));
   },
   send(value){
    const line=JSON.stringify(value)+'\n';if(session.dead||Buffer.byteLength(line)>MAX_INPUT)fail(PROTOCOL);
    child.stdin.write(line,error=>{if(error)session.kill(PROTOCOL)});
   },
  };
  const remove=()=>{const at=sessions.indexOf(session);if(at>=0)sessions.splice(at,1)};
  function event(value:unknown){
   const v=objectFields(value,['type','version'],['rootIdentity','identity','rawLength','bytesHex','code']) as Event;
   if(v.version!==VERSION)fail(PROTOCOL);
   if(v.type==='error'){objectFields(v,['type','version','code']);session.kill(typeof v.code==='string'&&NATIVE_CODES.has(v.code)?v.code:PROTOCOL);return}
   const waiter=session.expect;if(!waiter||!waiter.types.includes(v.type))fail(PROTOCOL);
   session.expect=undefined;waiter.resolve(v);
  }
  child.stdout.on('data',(chunk:Buffer|string)=>{
   if(session.dead)return;
   buffer=Buffer.concat([buffer,Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk)]);if(buffer.length>MAX_OUTPUT){session.kill(PROTOCOL);return}
   for(;;){const next=buffer.indexOf(10);if(next<0)break;const line=buffer.subarray(0,next);buffer=buffer.subarray(next+1);try{event(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(line)))}catch{session.kill(PROTOCOL);return}}
  });
  child.stderr.on('data',()=>{/* Drain without exposing paths or bodies. */});
  for(const stream of [child,child.stdin,child.stdout,child.stderr])stream.on('error',()=>session.kill(PROTOCOL));
  // An idle session exits by itself; that is the end of its life, not an error for anyone.
  child.once('close',()=>{killed=true;session.kill(PROTOCOL);alive.delete(session);closed.resolve()});
  sessions.push(session);alive.add(session);return session;
 }
 function expect(session:Session,types:readonly string[]):Promise<Event> {
  if(session.dead)return Promise.reject(Error(PROTOCOL));
  return new Promise((resolve,reject)=>{session.expect={types,resolve,reject}});
 }
 async function take(root:string,deadlineAt:number,signal:AbortSignal):Promise<Session> {
  for(;;){
   if(closing)fail(CANCELLED);if(signal.aborted)fail(CANCELLED);if(clock()>=deadlineAt)fail(TIMEOUT);
   const idle=sessions.find(s=>s.root===root&&!s.busy&&!s.dead&&s.rootIdentity);
   if(idle){idle.busy=true;return idle}
   if(sessions.length>=size){const other=sessions.find(s=>!s.busy&&s.root!==root);if(other){other.kill(CANCELLED);continue}}
   const session=start(root);
   try{const ready=await bounded(expect(session,['ready']),deadlineAt,signal);objectFields(ready,['type','version','rootIdentity']);session.rootIdentity=identity(ready.rootIdentity);return session}
   // Startup may already hold the root, and no endpoint exists yet to wait on it: wait for the close here.
   catch(error){session.kill(error instanceof Error&&[TIMEOUT,CANCELLED].includes(error.message)?error.message:PROTOCOL);await session.closed;throw error}
  }
 }
 // A released helper holds nothing under the root, so ending an extra one needs no wait.
 function give(session:Session){if(sessions.length>size)session.kill(CANCELLED);else session.busy=false}
 /** Rejects with TIMEOUT at the deadline or CANCELLED on abort, whichever comes before the operation. */
 function bounded<T>(operation:Promise<T>,deadlineAt:number,signal:AbortSignal):Promise<T> {
  let timer:ReturnType<typeof setTimeout>|undefined,onAbort:(()=>void)|undefined;
  const limit=new Promise<never>((_,reject)=>{
   timer=setTimeout(()=>reject(Error(TIMEOUT)),Math.max(1,Math.ceil(deadlineAt-clock())));
   onAbort=()=>reject(Error(CANCELLED));signal.addEventListener('abort',onAbort,{once:true});
  });
  return Promise.race([operation,limit]).finally(()=>{clearTimeout(timer);signal.removeEventListener('abort',onAbort!)});
 }
 const pool=(async input=>{
  const remaining=input.deadlineAt-clock();if(!path.isAbsolute(input.root)||!Number.isFinite(remaining)||remaining<=0||remaining>30000)fail(TIMEOUT);
  if(input.signal.aborted)fail(CANCELLED);
  let session:Session,state:'ready'|'reading'|'leased'|'disposing'|'done'='ready',error:Error|undefined,disposing:Promise<void>|undefined;
  session=await take(input.root,input.deadlineAt,input.signal);
  // broken: the helper's state is unknown, so it is killed. stale: only this endpoint is finished; a helper
  // between reads (or holding a finished lease, released below) is still clean and goes back to the pool.
  const broken=(code:string)=>{if(!error)error=Error(code);session.kill(code)};
  const stale=(code:string)=>{if(state==='reading')broken(code);else if(!error)error=Error(code)};
  const abort=()=>stale(CANCELLED);
  const timer=setTimeout(()=>stale(TIMEOUT),Math.max(1,Math.ceil(input.deadlineAt-clock())));
  input.signal.addEventListener('abort',abort,{once:true});
  const finish=()=>{clearTimeout(timer);input.signal.removeEventListener('abort',abort)};
  const assertLive=()=>{if(error)throw error;if(state==='disposing'||state==='done'||session.dead)fail(PROTOCOL);if(clock()>=input.deadlineAt){broken(TIMEOUT);throw error}};
  const endpoint:NativeHistoryEndpoint=Object.freeze({rootIdentity:session.rootIdentity!,assertLive,
   async read(components:readonly string[],maxBytes:number){
    assertLive();if(state!=='ready'||!Array.isArray(components)||!components.length||components.length>16||components.some(c=>typeof c!=='string'||!c||c==='.'||c==='..'||/[\\/:\u0000-\u001f]/u.test(c))||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>4*1024*1024)fail(PROTOCOL);
    state='reading';const snapshot=expect(session,['snapshot']);
    session.send({type:'read',version:VERSION,components:[...components],maxBytes,deadlineMs:Math.max(1,Math.min(30000,Math.floor(input.deadlineAt-clock())))});
    let v:Event;try{v=await snapshot}catch(cause){broken(cause instanceof Error?cause.message:PROTOCOL);throw error}
    try{
     objectFields(v,['type','version','identity','rawLength','bytesHex']);const leaf=identity(v.identity);
     if(!Number.isSafeInteger(v.rawLength)||(v.rawLength as number)<0||(v.rawLength as number)>maxBytes||typeof v.bytesHex!=='string'||v.bytesHex.length!==(v.rawLength as number)*2||!/^[a-f0-9]*$/.test(v.bytesHex))fail(PROTOCOL);
     state='leased';return {identity:leaf,bytes:Uint8Array.from(Buffer.from(v.bytesHex,'hex'))};
    }catch{broken(PROTOCOL);throw error}
   },
   dispose(reason:'release'|'cancel'){
    if(disposing)return disposing;
    disposing=(async()=>{
     const prior=error,was=state;state='disposing';finish();
     // A read still in flight is stopped by ending the session, like the one-shot helper's cancel.
     if(was==='reading')broken(CANCELLED);
     if(!session.dead&&was==='leased'){
      const ack=expect(session,[reason==='release'?'released':'cancelled']);
      let bound:ReturnType<typeof setTimeout>|undefined;
      try{session.send({type:reason,version:VERSION});await Promise.race([ack,new Promise<never>((_,r)=>{bound=setTimeout(()=>r(Error(TIMEOUT)),Math.max(1,Math.min(1000,input.deadlineAt-clock())))})])}
      catch(cause){broken(cause instanceof Error&&cause.message===TIMEOUT?TIMEOUT:PROTOCOL)}
      finally{if(bound)clearTimeout(bound)}
     }
     // A killed session has given up its handles only once its process has closed.
     if(session.dead){await session.closed;state='done';if(error&&error!==prior)throw error;return}
     state='done';give(session);
    })();return disposing;
   },
  });
  return endpoint;
 }) as NativeHistorySessionPool;
 // Idle helpers hold no handle under the root, so ending every helper is a safe close; each one is
 // awaited until its process has closed.
 pool.close=async()=>{
  closing=true;
  await Promise.all([...alive].map(async session=>{session.kill(CANCELLED);await session.closed}));
 };
 return pool;
}
