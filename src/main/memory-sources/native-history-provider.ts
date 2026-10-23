import path from 'node:path';
import {createHash} from 'node:crypto';
import {getStorageContext} from '../storage-context';
import type {MainActorAuthority} from '../memory-core/main-actor-authority';
import {canonicalJson} from '../memory-core/repository-types';
import type {ConversationTranscriptStore,TranscriptMutation} from '../orchestrator/conversation-transcript-store';
import type {TranscriptEntry} from '../orchestrator/conversation-transcript-types';
import {createMainHistoryProvider,type createMainHistory,type HistoryResponseBinding,type HistoryResponseSelection,type HistoryResponseWitness,type NativeHistoryResponseFactory} from '../memory-history/main-history';
import {historyTranscriptDigest} from '../memory-history/history-transcript-digest';
import {parseFireflyHistoryBytes} from '../memory-history/firefly-history-reader';
import type {HistoryDocument,ReadonlyHistoryRecord,ReadonlyHistorySelectionHead} from '../memory-history/history-contracts';
import type {TranscriptDependency} from '../memory-context/context-contracts';
import type {NativeHistoryEndpoint,NativeHistoryEndpointFactory,NativeHistoryIdentity} from './native-history-transport';

type CoverageReason='snapshot-missing'|'transcript-missing'|'not-acquired'|'partial-source'|'selection-budget-exhausted'|'disabled-by-forget'|'disabled-by-retraction';
export interface NativeHistoryCoverageInsufficient {status:'coverage-insufficient';source:'native-h';coverage:'partial';reason:CoverageReason;diagnostics:string[];selection:{selected:1;covered:0;excluded:1}}
export type NativeHistoryCaptureOutcome=NativeHistoryCoverageInsufficient|{status:'captured';source:'native-h';coverage:'complete'|'partial';captured:number;diagnostics:string[];selection:{selected:1;covered:1;excluded:0}};
export type NativeHistoryQueryOutcome=NativeHistoryCoverageInsufficient|{status:'queried';source:'native-h';coverage:'complete'|'partial';result:Awaited<ReturnType<ReturnType<typeof createMainHistory>['query']>>};
interface Options {actorAuthority:MainActorAuthority;actorToken:object;store:Pick<ConversationTranscriptStore,'withReadonlyBarrier'>&Partial<Pick<ConversationTranscriptStore,'withHeldReadonlyBarrier'>>;history:ReturnType<typeof createMainHistory>;endpointFactory:NativeHistoryEndpointFactory;deadlineMs:number}
interface Operation {partial?:boolean;done:Promise<void>;finish:()=>void;cleanupFailure?:unknown;epoch:number;active:boolean;controller:AbortController;deadlineAt:number;endpoints:NativeHistoryEndpoint[];documents:Map<string,ReadonlyHistoryRecord>;proofs:WeakMap<ReadonlyHistoryRecord,string>;head?:ReadonlyHistorySelectionHead;pairDigest?:string;identities?:NativeHistoryIdentity[];prefixLength?:number;prefixDigest?:string;snapshotDigest?:string}
function fail(code:string):never{throw Error(code)}
const hash=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
const bytesHash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const equal=(a:NativeHistoryIdentity,b:NativeHistoryIdentity)=>a.volumeSerial===b.volumeSerial&&a.fileIndex===b.fileIndex;
function validateIdentity(value:NativeHistoryIdentity):NativeHistoryIdentity {if(!value||!Number.isInteger(value.volumeSerial)||value.volumeSerial<0||value.volumeSerial>0xffffffff||typeof value.fileIndex!=='string'||!/^[a-f0-9]{16}$/.test(value.fileIndex))fail('MEMORY_HISTORY_NATIVE_PROTOCOL_INVALID');return Object.freeze({...value})}

/** Main-only trusted composition. Neither parser records nor DTO roots can grant acquisition. */
export function createNativeHistoryProvider(options:Options){
 const actor=options.actorAuthority.requireActor(options.actorToken);if(actor.sessionMode!=='persistent')fail('MEMORY_HISTORY_TEMPORARY_DENIED');
 if(!Number.isInteger(options.deadlineMs)||options.deadlineMs<1||options.deadlineMs>30000)fail('MEMORY_HISTORY_NATIVE_TIMEOUT');
 const storage=getStorageContext(),root=path.join(storage.dataRoot,'transcripts'),grant=Object.freeze({}),operations=new Set<Operation>();
 let closing:Promise<void>|undefined;
 let epoch=0,closed=false,committed=false,publishing=false,rootPin:NativeHistoryIdentity|undefined;
 let partialCoverage=false;
 let coverage:NativeHistoryCoverageInsufficient=insufficient('not-acquired');
 const responseClaims=new WeakMap<HistoryResponseBinding,{witness:HistoryResponseWitness;add:(selection:HistoryResponseSelection[])=>void}>();
 const witnesses=new Set<HistoryResponseWitness>(),handledTickets=new WeakMap<object,string>();
 const captures=new Map<string,{transcriptToken:object;ref:TranscriptDependency}>();
 // The only cursor owner is this private closure. It never grants authority or skips native acquisition.
 let cursor:{grant:object;bootId:string;actorToken:object;epoch:number;rootIdentity:NativeHistoryIdentity;identities:NativeHistoryIdentity[];pairDigest:string;incarnation:string;maxSeq:number;checkpointThroughSeq:number;refs:TranscriptDependency[]}|undefined;
 function insufficient(reason:CoverageReason,diagnostics:string[]=[]):NativeHistoryCoverageInsufficient{return {status:'coverage-insufficient',source:'native-h',coverage:'partial',reason,diagnostics:[...new Set(['MEMORY_HISTORY_COVERAGE_INSUFFICIENT',...(reason==='snapshot-missing'?['MEMORY_HISTORY_SNAPSHOT_MISSING']:[]),...diagnostics])],selection:{selected:1,covered:0,excluded:1}}}
 function authorize(){if(closed)fail('MEMORY_HISTORY_PROVIDER_DENIED');if(options.actorAuthority.requireActor(options.actorToken)!==actor)fail('MEMORY_HISTORY_PROVIDER_DENIED');if(getStorageContext()!==storage||getStorageContext().dataRoot!==storage.dataRoot)fail('MEMORY_HISTORY_PROVIDER_DENIED')}
 function gate(operation:Operation){authorize();if(operation.controller.signal.aborted)fail(performance.now()>=operation.deadlineAt?'MEMORY_HISTORY_NATIVE_TIMEOUT':'MEMORY_HISTORY_CANCELLED');if(!operation.active||operation.epoch!==epoch)fail('MEMORY_HISTORY_STALE');if(performance.now()>=operation.deadlineAt)fail('MEMORY_HISTORY_NATIVE_TIMEOUT');for(const endpoint of operation.endpoints)endpoint.assertLive()}
 function revoke(preserve?:HistoryResponseWitness){for(const witness of [...witnesses])if(witness!==preserve)witness.retire();epoch++;committed=false;cursor=undefined;coverage=insufficient('not-acquired');for(const operation of operations)operation.controller.abort()}
 async function cleanupHeads(){const results=await Promise.allSettled([...captures].map(async([locator,capture])=>{await options.history.prepareTranscriptChange(options.actorToken,capture.transcriptToken);if(captures.get(locator)===capture)captures.delete(locator)}));const failed=results.find(result=>result.status==='rejected');if(failed?.status==='rejected')throw failed.reason}
 async function disposeEndpoints(endpoints:NativeHistoryEndpoint[],reason:'cancel'|'release'){const results=await Promise.allSettled(endpoints.map(endpoint=>endpoint.dispose(reason)));const failed=results.find(result=>result.status==='rejected');if(failed?.status==='rejected')throw failed.reason}
 async function invalidate(_reason:'forget'|'history-remove'|'grant-change'|'profile-change'|'root-change'|'actor-teardown'|TranscriptMutation){const pending=[...operations];revoke();const results=await Promise.allSettled([cleanupHeads(),disposeEndpoints(pending.flatMap(operation=>operation.endpoints),'cancel'),...pending.map(async operation=>{await operation.done;if(Object.hasOwn(operation,'cleanupFailure'))throw operation.cleanupFailure})]);const failed=results.find(result=>result.status==='rejected');if(failed?.status==='rejected')throw failed.reason}
 function evidenceGate(captureEpoch:number){authorize();if(!committed||publishing||captureEpoch!==epoch)fail('MEMORY_HISTORY_STALE')}
 async function acquire<T>(run:(operation:Operation)=>Promise<T>,signal?:AbortSignal,ticket?:object,prefix?:{length:number;digest:string;snapshotDigest:string;identities:NativeHistoryIdentity[];tailLength:number;tailDigest:string}):Promise<T>{
  authorize();let finish!:()=>void;const done=new Promise<void>(resolve=>{finish=resolve});const controller=new AbortController(),operation:Operation={done,finish,epoch,active:true,controller,deadlineAt:performance.now()+options.deadlineMs,endpoints:[],documents:new Map(),proofs:new WeakMap()};
  let enteredBarrier=false,rejectWaiting!:(error:Error)=>void;
  const waiting=new Promise<never>((_resolve,reject)=>{rejectWaiting=reject});void waiting.catch(()=>undefined);
  const abortWaiting=()=>{if(!enteredBarrier)rejectWaiting(Error(performance.now()>=operation.deadlineAt?'MEMORY_HISTORY_NATIVE_TIMEOUT':'MEMORY_HISTORY_CANCELLED'))};
  controller.signal.addEventListener('abort',abortWaiting,{once:true});
  const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const timer=setTimeout(abort,options.deadlineMs);operations.add(operation);
  try{const readPair=async()=>{
   enteredBarrier=true;try{gate(operation);
   const read=async(leaf:string,budget:number)=>{
    gate(operation);const endpoint=await options.endpointFactory({root,deadlineAt:operation.deadlineAt,signal:controller.signal});operation.endpoints.push(endpoint);gate(operation);
    const ready=validateIdentity(endpoint.rootIdentity);if(rootPin&&!equal(ready,rootPin))fail('MEMORY_HISTORY_NATIVE_ROOT_CHANGED');if(!rootPin)rootPin=ready;
    let snapshot;try{snapshot=await endpoint.read([actor.sessionId,leaf],budget)}catch(error){if(error instanceof Error&&error.message==='history-leaf-missing'){
     const next=insufficient(leaf==='snapshot.json'?'snapshot-missing':'transcript-missing');revoke();coverage=next;fail('MEMORY_HISTORY_COVERAGE_INSUFFICIENT');
    }throw error}
    gate(operation);const identity=validateIdentity(snapshot.identity);if(identity.volumeSerial!==rootPin.volumeSerial||!(snapshot.bytes instanceof Uint8Array)||snapshot.bytes.length>budget)fail('MEMORY_HISTORY_NATIVE_PROTOCOL_INVALID');return {identity,bytes:Uint8Array.from(snapshot.bytes)};
   };
   const transcript=await read('transcript.jsonl',4*1024*1024),remaining=4*1024*1024-transcript.bytes.length;
   if(remaining<1){const next=insufficient('selection-budget-exhausted');revoke();coverage=next;fail('MEMORY_HISTORY_COVERAGE_INSUFFICIENT')}
   const snapshot=await read('snapshot.json',remaining);gate(operation);
   let transcriptBytes=transcript.bytes;
   if(prefix){
    if(transcript.bytes.length!==prefix.length+prefix.tailLength||bytesHash(transcript.bytes.subarray(0,prefix.length))!==prefix.digest||bytesHash(transcript.bytes.subarray(prefix.length))!==prefix.tailDigest||bytesHash(snapshot.bytes)!==prefix.snapshotDigest||!equal(transcript.identity,prefix.identities[0])||!equal(snapshot.identity,prefix.identities[1]))fail('MEMORY_HISTORY_STALE');
    transcriptBytes=transcript.bytes.subarray(0,prefix.length);
   }
   operation.prefixLength=transcriptBytes.length;operation.prefixDigest=bytesHash(transcriptBytes);operation.snapshotDigest=bytesHash(snapshot.bytes);
   const incarnation='native-'+hash({root:rootPin,transcript:transcript.identity});
   const parsed=parseFireflyHistoryBytes({root,actorKey:actor.actorKey,scopeKey:actor.scopeKey,sessions:[{providerId:actor.providerId,sessionId:actor.sessionId}]},[{providerId:actor.providerId,sessionId:actor.sessionId,incarnation,transcript:transcriptBytes,snapshot:snapshot.bytes,chat:null}],controller.signal);
   const records=parsed.documents.filter(record=>record.classification==='raw-history'&&record.provenance.every(p=>p.active));
   if(parsed.coverage!=='complete'||!parsed.selectionHeads[0]?.completeTail||records.length>32){const next=insufficient(records.length>32?'selection-budget-exhausted':'partial-source',parsed.diagnostics);revoke();coverage=next;fail('MEMORY_HISTORY_COVERAGE_INSUFFICIENT')}
   operation.head=parsed.selectionHeads[0];operation.identities=[transcript.identity,snapshot.identity];operation.pairDigest=hash([bytesHash(transcript.bytes),bytesHash(snapshot.bytes)]);
   if(cursor&&(cursor.pairDigest!==operation.pairDigest||operation.identities.some((identity,i)=>!equal(identity,cursor!.identities[i]))))fail('MEMORY_HISTORY_STALE');
   // Physical progress includes rewinds/settlements; the digest separately binds the current message projection.
   for(const record of records){record.document.revision=Math.max(1,operation.head.maxSeq);const projection=await options.history.projectNative(options.actorToken,record.document);gate(operation);operation.partial ||= projection.partial;for(const document of projection.documents){const projected={document,classification:record.classification,provenance:document.provenance!};operation.documents.set(document.id,projected);operation.proofs.set(projected,historyTranscriptDigest(document))}}
   if(operation.documents.size>128){const next=insufficient('selection-budget-exhausted');revoke();coverage=next;fail('MEMORY_HISTORY_COVERAGE_INSUFFICIENT')}
   gate(operation);return await run(operation);
   }finally{operation.active=false;try{await disposeEndpoints(operation.endpoints,controller.signal.aborted?'cancel':'release')}catch(error){operation.cleanupFailure=error;throw error}}
  };
   if(ticket&&!options.store.withHeldReadonlyBarrier)fail('TRANSCRIPT_HELD_TICKET_DENIED');
   const barrier=ticket?options.store.withHeldReadonlyBarrier!(ticket,actor.sessionId,root,readPair):options.store.withReadonlyBarrier(actor.sessionId,readPair);
   return await Promise.race([barrier,waiting])}catch(error){
   if(operation.epoch===epoch)revoke();await cleanupHeads();throw error;
  }finally{
   operation.active=false;clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.signal.removeEventListener('abort',abortWaiting);
   operation.documents.clear();operations.delete(operation);operation.finish();
  }
 }
 function bindDocument(operation:Operation,record:ReadonlyHistoryRecord):HistoryDocument {gate(operation);const digest=operation.proofs.get(record);if(!digest||operation.documents.get(record.document.id)!==record||digest!==historyTranscriptDigest(record.document))fail('MEMORY_HISTORY_PROVIDER_DENIED');return structuredClone(record.document)}
 // A response witness is private to one claimed snapshot and immutable completed output.
 // It keeps hashes and physical metadata, never source plaintext or a renewable cursor.
 const responseFactory:NativeHistoryResponseFactory={claim(selected:HistoryResponseSelection[],input:HistoryResponseBinding):HistoryResponseWitness{
  authorize();const requester=options.actorAuthority.requireActor(input.actorToken);
  if(input.bootId!==options.actorAuthority.bootId||requester.actorKey!==actor.actorKey||requester.scopeKey!==actor.scopeKey||requester.sessionId!==input.sessionId||requester.providerId!==input.providerId||!selected.length)fail('MEMORY_HISTORY_PROVIDER_DENIED');
  const existing=responseClaims.get(input);if(existing){existing.witness.check();existing.add(selected);return existing.witness}
  const binding=Object.freeze({...input}),selection=structuredClone(selected),own=binding.sessionId===actor.sessionId&&binding.providerId===actor.providerId;
  for(const item of selection){const capture=captures.get(item.locator);if(!capture||canonicalJson(capture.ref)!==canonicalJson(item.ref))fail('MEMORY_HISTORY_STALE')}
  let active=true,witnessEpoch=epoch,phase=0,validatedTicket:object|undefined,validated=false;
  let metadata:{length:number;digest:string;snapshotDigest:string;identities:NativeHistoryIdentity[]}|undefined,tailLength=0,tailDigest=bytesHash(new Uint8Array());
  function check(){authorize();options.actorAuthority.requireActor(binding.actorToken);if(!active||witnessEpoch!==epoch)fail('MEMORY_HISTORY_STALE')}
  const witness:HistoryResponseWitness=Object.freeze({providerId:actor.providerId,sessionId:actor.sessionId,get refs(){return own?selection.map(item=>structuredClone(item.ref)):[]},check,
   async validate(ticket?:object,signal?:AbortSignal){
    check();if(!own&&ticket){if(!validated)fail('MEMORY_HISTORY_STALE');return}
    validated=false;validatedTicket=undefined;if(own&&!ticket)fail('TRANSCRIPT_HELD_TICKET_DENIED');
    await acquire(async operation=>{
     check();for(const item of selection){const current=operation.documents.get(item.locator);if(!current||historyTranscriptDigest(current.document)!==item.digest)fail('MEMORY_HISTORY_STALE')}
     if(own&&phase===0&&operation.head!.maxSeq!==binding.throughSeq)fail('MEMORY_HISTORY_STALE');
     metadata={length:operation.prefixLength!,digest:operation.prefixDigest!,snapshotDigest:operation.snapshotDigest!,identities:operation.identities!};
    },signal,ticket,own&&phase===1?{...metadata!,tailLength,tailDigest}:undefined);
    check();validated=true;validatedTicket=ticket;
   },
   async observe(entry:TranscriptEntry,ticket:object){
    check();if(!validated||own&&validatedTicket!==ticket||phase>1||entry.runId!==binding.runId||entry.turnId!==binding.assistantTurnId||entry.seq!==binding.throughSeq+phase+1)fail('MEMORY_HISTORY_RESPONSE_DENIED');
    if(phase===0){if(entry.kind!=='assistant'||entry.id!==binding.assistantEntryId||entry.sSettlement?.userTurnId!==binding.userTurnId||entry.sSettlement?.userRevision!==binding.userRevision||hash(entry.payload.content)!==binding.contentDigest)fail('MEMORY_HISTORY_RESPONSE_DENIED')}
    else if(entry.kind!=='assistant_settlement'||entry.payload.result!=='success'||entry.payload.binding.assistantEntryId!==binding.assistantEntryId||entry.payload.binding.userTurnId!==binding.userTurnId||entry.payload.binding.userRevision!==binding.userRevision)fail('MEMORY_HISTORY_RESPONSE_DENIED');
    if(own){
     if(phase===0)for(const item of selection){const capture=captures.get(item.locator);if(!capture||canonicalJson(capture.ref)!==canonicalJson(item.ref))fail('MEMORY_HISTORY_STALE');options.history.retireResponseTranscript(options.actorToken,capture.transcriptToken,item.ref);captures.delete(item.locator)}
     revoke(witness);witnessEpoch=epoch;await cleanupHeads();
     if(phase===0){const tail=Buffer.from(JSON.stringify(entry)+'\n');tailLength=tail.length;tailDigest=bytesHash(tail)}
     handledTickets.set(ticket,bytesHash(Buffer.from(JSON.stringify(entry))));
    }
    phase++;validated=false;validatedTicket=undefined;check();
   },
   retire(){active=false;validated=false;validatedTicket=undefined;witnesses.delete(witness)}
  });witnesses.add(witness);responseClaims.set(input,{witness,add(items){
   check();if(phase!==0||validated||metadata)fail('MEMORY_HISTORY_RESPONSE_DENIED');
   for(const item of items){const capture=captures.get(item.locator);if(!capture||canonicalJson(capture.ref)!==canonicalJson(item.ref))fail('MEMORY_HISTORY_STALE');const old=selection.find(s=>s.locator===item.locator);if(old){if(canonicalJson(old)!==canonicalJson(item))fail('MEMORY_HISTORY_STALE')}else selection.push(structuredClone(item))}
  }});return witness;
 }};
 async function capture(signal?:AbortSignal):Promise<NativeHistoryCaptureOutcome>{
  authorize();if(publishing)fail('MEMORY_HISTORY_STALE');publishing=true;
  try{revoke();await cleanupHeads();
   return await acquire(async operation=>{
    const captureEpoch=epoch;
    for(const [locator,record] of operation.documents){
     const original=bindDocument(operation,record),digest=historyTranscriptDigest(original);let leaseOperation:Operation|undefined=operation;
     const provider=createMainHistoryProvider(options.actorAuthority,options.actorToken,{
      transcriptProgress:()=>{if(!leaseOperation?.head)fail('MEMORY_HISTORY_STALE');gate(leaseOperation);return {contentRevision:Math.max(1,leaseOperation.head.maxSeq),throughSeq:leaseOperation.head.maxSeq}},
      check:()=>{if(!leaseOperation)fail('MEMORY_HISTORY_STALE');gate(leaseOperation)},checkEvidence:()=>evidenceGate(captureEpoch),onInvalidated:revoke,
      onCaptured:captured=>{gate(operation);captures.set(locator,captured)},responseFactory,
      withLease:async(id,run,signal)=>{
       if(id!==locator)fail('MEMORY_HISTORY_PROVIDER_DENIED');
       if(operation.active&&operation.epoch===epoch){leaseOperation=operation;return run(async()=>bindDocument(operation,record))}
       evidenceGate(captureEpoch);
       return acquire(async fresh=>{const current=fresh.documents.get(locator);if(!current||historyTranscriptDigest(current.document)!==digest)fail('MEMORY_HISTORY_STALE');leaseOperation=fresh;try{return await run(async()=>bindDocument(fresh,current))}finally{leaseOperation=undefined}},signal);
      },
     });
     await options.history.captureTranscript(options.actorToken,provider,locator);gate(operation);
    }
    gate(operation);if(operation.documents.size>0){committed=true;cursor={grant,bootId:options.actorAuthority.bootId,actorToken:options.actorToken,epoch,rootIdentity:rootPin!,identities:operation.identities!,pairDigest:operation.pairDigest!,incarnation:operation.head!.incarnation,maxSeq:operation.head!.maxSeq,checkpointThroughSeq:operation.head!.checkpointThroughSeq,refs:[...captures.values()].map(c=>structuredClone(c.ref))}}
    partialCoverage=operation.partial===true;
    if(!operation.documents.size&&partialCoverage){coverage=insufficient('partial-source',['MEMORY_HISTORY_ORIGIN_UNPROVEN']);return structuredClone(coverage)}
    coverage=insufficient('not-acquired');return {status:'captured',source:'native-h',coverage:partialCoverage?'partial':'complete',captured:operation.documents.size,diagnostics:partialCoverage?['MEMORY_HISTORY_COVERAGE_INSUFFICIENT','MEMORY_HISTORY_ORIGIN_UNPROVEN']:[],selection:{selected:1,covered:1,excluded:0}};
   },signal);
  }catch(error){
   const insufficientCoverage=error instanceof Error&&error.message==='MEMORY_HISTORY_COVERAGE_INSUFFICIENT'?structuredClone(coverage):undefined;
   revoke();await cleanupHeads();if(insufficientCoverage){coverage=insufficientCoverage;return structuredClone(coverage)}throw error;
  }finally{publishing=false}
 }
 async function query(input:Omit<Parameters<ReturnType<typeof createMainHistory>['query']>[1],'scope'>):Promise<NativeHistoryQueryOutcome>{
  authorize();if(publishing)fail('MEMORY_HISTORY_STALE');if(!committed)return structuredClone(coverage);
  const queryEpoch=epoch;
  try{const result=await options.history.query(options.actorToken,input);if(coverage.reason!=='not-acquired')return structuredClone(coverage);evidenceGate(queryEpoch);return {status:'queried',source:'native-h',coverage:partialCoverage?'partial':'complete',result}}
  catch(error){if(error instanceof Error&&error.message==='MEMORY_HISTORY_COVERAGE_INSUFFICIENT'){await cleanupHeads();return structuredClone(coverage)}throw error}
 }
 return Object.freeze({capture,query,beforeMutation:async(kind:TranscriptMutation,entry?:TranscriptEntry,ticket?:object)=>{if(ticket&&entry&&handledTickets.get(ticket)===bytesHash(Buffer.from(JSON.stringify(entry)))){handledTickets.delete(ticket);return Promise.resolve()}if(kind==='delete'||kind==='repair'||entry?.kind==='turn_rewind')await options.history.retireOrigins(options.actorToken,kind,entry);return invalidate(kind)},invalidate,close(){if(!closing){closed=true;closing=invalidate('actor-teardown')}return closing}});
}
