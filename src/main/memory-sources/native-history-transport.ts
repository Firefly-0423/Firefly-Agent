import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import path from 'node:path';
import {objectFields} from '../memory-core/command-validation';

export interface NativeHistoryIdentity {readonly volumeSerial:number;readonly fileIndex:string}
export interface NativeHistoryEndpoint {
 readonly rootIdentity:NativeHistoryIdentity;
 read(components:readonly string[],maxBytes:number):Promise<{identity:NativeHistoryIdentity;bytes:Uint8Array}>;
 assertLive():void;
 dispose(reason:'release'|'cancel'):Promise<void>;
}
export type NativeHistoryEndpointFactory=(input:{root:string;deadlineAt:number;signal:AbortSignal})=>Promise<NativeHistoryEndpoint>;
const PROTOCOL='MEMORY_HISTORY_NATIVE_PROTOCOL_INVALID',TIMEOUT='MEMORY_HISTORY_NATIVE_TIMEOUT';
const MAX_INPUT=16384,MAX_OUTPUT=8*1024*1024+1024;
const NATIVE_CODES=new Set(['history-invalid-root','history-invalid-path','history-invalid-budget','history-unsupported-filesystem','history-unsafe-attributes','history-multiple-links','history-source-changed','history-native-open-failed','history-native-io-failed','history-leaf-missing','history-invalid-cli','history-parent-unavailable','history-input-failed','history-input-oversize','history-invalid-state','history-output-failed','history-output-oversize','history-invalid-version','history-invalid-command']);
function fail(code:string):never{throw Error(code)}
function identity(value:unknown):NativeHistoryIdentity {
 const v=objectFields(value,['volumeSerial','fileIndex']);
 if(!Number.isInteger(v.volumeSerial)||(v.volumeSerial as number)<0||(v.volumeSerial as number)>0xffffffff||typeof v.fileIndex!=='string'||!/^[a-f0-9]{16}$/.test(v.fileIndex))fail(PROTOCOL);
 return Object.freeze({volumeSerial:v.volumeSerial as number,fileIndex:v.fileIndex});
}
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b});void promise.catch(()=>undefined);return {promise,resolve,reject}}
/** Only a trusted Main composition supplies a child; this module never resolves or spawns a binary. */
export function createNativeHistoryEndpointFactory(options:{spawn:(input:{root:string;deadlineMs:number})=>ChildProcessWithoutNullStreams;clock?:()=>number}):NativeHistoryEndpointFactory {
 const clock=options.clock??(()=>performance.now());
 return async input=>{
  const remaining=input.deadlineAt-clock();if(!path.isAbsolute(input.root)||!Number.isFinite(remaining)||remaining<=0||remaining>30000)fail(TIMEOUT);
  if(input.signal.aborted)fail('MEMORY_HISTORY_CANCELLED');
  const child=options.spawn({root:input.root,deadlineMs:Math.max(1,Math.floor(remaining))});
  const ready=deferred<NativeHistoryEndpoint>(),snapshot=deferred<{identity:NativeHistoryIdentity;bytes:Uint8Array}>(),closed=deferred<void>();
  let state:'starting'|'ready'|'reading'|'leased'|'disposing'|'closed'='starting',error:Error|undefined,buffer=Buffer.alloc(0),total=0,budget=0,closeSeen=false,killed=false,ack=false,expectedAck:'released'|'cancelled'|undefined,disposing:Promise<void>|undefined;
  const kill=()=>{if(!closeSeen&&!killed){killed=true;child.kill()}};
  const reject=(reason:string)=>{if(error)return;error=Error(reason);ready.reject(error);snapshot.reject(error);kill()};
  const abort=()=>reject('MEMORY_HISTORY_CANCELLED');
  const timer=setTimeout(()=>reject(TIMEOUT),Math.max(1,Math.ceil(remaining)));
  const assertLive=()=>{if(error)throw error;if(state==='disposing'||state==='closed'||closeSeen)fail(PROTOCOL);if(clock()>=input.deadlineAt){reject(TIMEOUT);throw error}};
  const send=(value:object)=>{assertLive();const line=JSON.stringify(value)+'\n';if(Buffer.byteLength(line)>MAX_INPUT)fail(PROTOCOL);child.stdin.write(line,error=>{if(error)reject(PROTOCOL)})};
  const finish=()=>{clearTimeout(timer);input.signal.removeEventListener('abort',abort);child.stdout.removeListener('data',data);child.stdout.removeListener('end',end);child.stderr.removeListener('data',stderr);child.removeListener('error',onError);child.stdin.removeListener('error',onError);child.stdout.removeListener('error',onError);child.stderr.removeListener('error',onError)};
  const endpoint=(rootIdentity:NativeHistoryIdentity):NativeHistoryEndpoint=>Object.freeze({rootIdentity,assertLive,
   async read(components:readonly string[],maxBytes:number){
    assertLive();if(state!=='ready'||!Array.isArray(components)||!components.length||components.length>16||components.some(c=>typeof c!=='string'||!c||c==='.'||c==='..'||/[\\/:\u0000-\u001f]/u.test(c))||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>4*1024*1024)fail(PROTOCOL);
    budget=maxBytes;state='reading';send({type:'read',version:1,components:[...components],maxBytes});return snapshot.promise;
   },
   dispose(reason:'release'|'cancel'){
    if(disposing)return disposing;
    disposing=(async()=>{
     const priorError=error;expectedAck=reason==='release'?'released':'cancelled';
     if(!closeSeen&&!error){try{send({type:reason,version:1});state='disposing'}catch{reject(PROTOCOL)}}
     if(error)kill();
     // A successful release includes both acknowledgement and process closure.
     let bound:ReturnType<typeof setTimeout>|undefined;
     try{await Promise.race([closed.promise,new Promise<never>((_,r)=>{bound=setTimeout(()=>{reject(TIMEOUT);kill();r(Error(TIMEOUT))},Math.max(1,Math.min(1000,input.deadlineAt-clock())))})])}
     // A timeout is a failed acquisition, not proof that OS leases are closed.
     // The injected trusted native helper has its own watchdog; retain the S
     // barrier until this exact child's close is observed even after kill.
     catch(cleanupError){await closed.promise;throw cleanupError}
     finally{if(bound)clearTimeout(bound);finish()}
     if(error&&error!==priorError)throw error;
    })();return disposing;
   },
  });
  function event(value:unknown){
   const v=objectFields(value,['type','version'],['rootIdentity','identity','rawLength','bytesHex','code']);if(v.version!==1)fail(PROTOCOL);
   if(v.type==='error'){
    objectFields(v,['type','version','code']);if(typeof v.code!=='string'||!NATIVE_CODES.has(v.code))fail(PROTOCOL);reject(v.code);return;
   }
   if(state==='starting'&&v.type==='ready'){objectFields(v,['type','version','rootIdentity']);const root=identity(v.rootIdentity);state='ready';ready.resolve(endpoint(root));return}
   if(state==='reading'&&v.type==='snapshot'){
    objectFields(v,['type','version','identity','rawLength','bytesHex']);const leaf=identity(v.identity);
    if(!Number.isSafeInteger(v.rawLength)||(v.rawLength as number)<0||(v.rawLength as number)>budget||typeof v.bytesHex!=='string'||v.bytesHex.length!==(v.rawLength as number)*2||!/^[a-f0-9]*$/.test(v.bytesHex))fail(PROTOCOL);
    const bytes=Uint8Array.from(Buffer.from(v.bytesHex,'hex'));state='leased';snapshot.resolve({identity:leaf,bytes});return;
   }
   if(state==='disposing'&&!ack&&v.type===expectedAck){objectFields(v,['type','version']);ack=true;return}
   fail(PROTOCOL);
  }
  function data(chunk:Buffer|string){
   if(error||closeSeen)return;
   const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);total+=bytes.length;if(total>MAX_OUTPUT){reject(PROTOCOL);return}
   buffer=Buffer.concat([buffer,bytes]);
   for(;;){const next=buffer.indexOf(10);if(next<0)break;const line=buffer.subarray(0,next);buffer=buffer.subarray(next+1);try{event(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(line)))}catch{reject(PROTOCOL);return}}
  }
  function end(){if(!ack&&!error)reject(PROTOCOL)}
  function stderr(_chunk:unknown){/* Drain without exposing paths or bodies. */}
  function onError(){reject(PROTOCOL)}
  child.stdout.on('data',data);child.stdout.on('end',end);child.stderr.on('data',stderr);child.on('error',onError);child.stdin.on('error',onError);child.stdout.on('error',onError);child.stderr.on('error',onError);
  child.once('close',(code:number|null)=>{closeSeen=true;state='closed';if(!error&&(!ack||code!==0||buffer.length))reject(PROTOCOL);finish();closed.resolve()});
  input.signal.addEventListener('abort',abort,{once:true});if(input.signal.aborted)abort();
  try{const result=await ready.promise;result.assertLive();return result}catch(error){let bound:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([closed.promise,new Promise<void>(r=>{bound=setTimeout(r,1000)})]);if(!closeSeen){kill();await closed.promise}}finally{if(bound)clearTimeout(bound);finish()}throw error}
 };
}
