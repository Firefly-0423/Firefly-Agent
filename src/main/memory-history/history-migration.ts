import {createHash,randomUUID} from 'node:crypto';
import type {MainActorAuthority,MainActorContext} from '../memory-core/main-actor-authority';
import {objectFields,parseInternalId,positiveRevision} from '../memory-core/command-validation';
import {canonicalJson} from '../memory-core/repository-types';
import {parseHistoryDocument} from './history-repository';
import type {HistoryDocument,HistoryTransport,HistorySession} from './history-contracts';
const digest=(v:unknown)=>createHash('sha256').update(canonicalJson(v)).digest('hex');
interface ImportReport {new:number;duplicates:number;conflicts:number}
interface PreviewState {actorToken:object;actor:MainActorContext;documents:HistoryDocument[];digest:string;generation:number;report:ImportReport}
interface ApplyResult {status:'complete'|'cancelled';inserted:number;duplicates:number;quarantined:number}
export function parseSyntheticExport(value:unknown,expected:HistorySession):HistoryDocument[]{
 const e=objectFields(structuredClone(value),['format','records']);if(e.format!=='firefly-history-synthetic-v1'||!Array.isArray(e.records)||e.records.length>128||Buffer.byteLength(canonicalJson(e))>4*1024*1024)throw new Error('MEMORY_HISTORY_IMPORT_INVALID');
 const documents=e.records.map(raw=>{const r=objectFields(raw,['sourceId','revision','incarnation','messages','sourceProvider','sourceSession']);if(r.sourceProvider!==expected.providerId||r.sourceSession!==expected.sessionId)throw new Error('MEMORY_HISTORY_ACCESS_DENIED');const sourceId=parseInternalId(r.sourceId);return parseHistoryDocument({id:'synthetic-import-'+digest(sourceId),incarnation:parseInternalId(r.incarnation),revision:positiveRevision(r.revision),origin:'synthetic-import',sourceDeps:[],messages:r.messages,vector:null})});
 if(new Set(documents.map(d=>d.id)).size!==documents.length)throw new Error('MEMORY_HISTORY_IMPORT_INVALID');return documents;
}
/** Separate report and Main apply capabilities. No import payload can mint M support or ownership. */
export function createHistoryMigration(options:{actorAuthority:MainActorAuthority;transport:HistoryTransport}){
 const previews=new WeakMap<object,PreviewState>(),applies=new WeakMap<object,{preview:PreviewState;promise?:Promise<ApplyResult>}>();
 function actor(token:object){const a=options.actorAuthority.requireActor(token);if(a.sessionMode!=='persistent')throw new Error('MEMORY_HISTORY_TEMPORARY_DENIED');return a}
 function command<T>(a:MainActorContext,kind:string,body:object,commandId?:string):Promise<T>{return options.transport.historyCommand({kind,scopeKey:a.scopeKey,...(commandId?{commandId}:{}),body:{actorKey:a.actorKey,providerId:a.providerId,sessionId:a.sessionId,...body}}) as Promise<T>}
 async function preview(token:object,value:unknown):Promise<{ticket:object;report:ImportReport;digest:string}>{
  const a=actor(token),documents=parseSyntheticExport(value,a),hash=digest(documents),baseline=await command<{generation:number}>(a,'baseline',{}),report=await options.actorAuthority.coordinate(()=>command<ImportReport>(a,'migrationPreview',{documents,digest:hash,generation:baseline.generation}));
  const ticket=Object.freeze({});previews.set(ticket,{actorToken:token,actor:a,documents:structuredClone(documents),digest:hash,generation:baseline.generation,report});return Object.freeze({ticket,report:Object.freeze({...report}),digest:hash});
 }
 function authorizeApply(token:object,ticket:object):object {actor(token);const state=previews.get(ticket);if(!state||state.actorToken!==token)throw new Error('MEMORY_HISTORY_PREVIEW_DENIED');const cap=Object.freeze({});applies.set(cap,{preview:state});return cap}
 async function apply(token:object,cap:object,input:{signal?:AbortSignal}={}):Promise<ApplyResult>{
  actor(token);const state=applies.get(cap);if(!state||state.preview.actorToken!==token)throw new Error('MEMORY_HISTORY_APPLY_DENIED');if(state.promise)return state.promise;
  const p=state.preview;if(digest(p.documents)!==p.digest)throw new Error('MEMORY_HISTORY_STALE');
  state.promise=(async()=>{const result:ApplyResult={status:'complete',inserted:0,duplicates:0,quarantined:0};
   for(let offset=0;offset<p.documents.length;offset+=16){if(input.signal?.aborted)return {...result,status:'cancelled'};
    const documents=p.documents.slice(offset,offset+16),batch=await options.actorAuthority.coordinate(()=>{if(input.signal?.aborted)return null;return command<Omit<ApplyResult,'status'>>(p.actor,'migrationApply',{documents,digest:digest(documents),generation:p.generation},'history-import-'+randomUUID())});
    if(batch===null)return {...result,status:'cancelled'};result.inserted+=batch.inserted;result.duplicates+=batch.duplicates;result.quarantined+=batch.quarantined;
   }return Object.freeze(result);
  })();return state.promise;
 }
 return {preview,authorizeApply,apply};
}
