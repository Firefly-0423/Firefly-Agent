import {HistoryOrigins,historyDocumentKey,parseHistoryOriginEvent,type HistoryOriginEvent} from './history-origins';
import {historyTranscriptDigest} from './history-transcript-digest';
import {historyMessageChars} from './history-message';
import {countHistoryBudgetDrop,emptyHistoryBudgetStats} from './history-budget-stats';
import {createHash,createHmac} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {objectFields,parseInternalId,parseSourceRef,positiveRevision} from '../memory-core/command-validation';
import {canonicalJson} from '../memory-core/repository-types';
import {RecordCodec} from '../memory-core/record-codec';
import {executeTransaction,type TransactionFault} from '../memory-core/command-transactions';
import {transactionNow,withTransactionClock} from '../memory-core/transaction-clock';
import {toWindows} from './history-windows';
import {HISTORY_EXCERPT_CONTEXT_WINDOWS,HISTORY_EXCERPT_VERSION,atomicGroups,excerptRef,excerptToolSafe,selectExcerpt,sliceExcerpt,verifyExcerpt,type ExcerptRange} from './history-excerpts';
import {SourceLedger} from '../memory-core/source-ledger';
import {Suppression} from '../memory-core/suppression';
import {validateUnit} from '../memory-context/token-budget';
import {extractMaintenance} from '../memory-policy/maintenance-extractor';
import {FactRepository} from '../memory-core/fact-repository';
import {FactSupports} from '../memory-policy/fact-supports';
import {PolicyRepository} from '../memory-policy/policy-repository';
import {RecallRepository,parseRecallDependencies} from '../memory-recall/recall-repository';
import type {RecallDependency} from '../memory-recall/recall-contracts';
import type {BoundSourceRef} from '../../shared/memory-contracts';
import type {SourceDependency} from '../memory-context/context-contracts';
import {TranscriptLedger} from '../memory-context/transcript-ledger';
import {createHistoryTokenizer,normalizeVector,rankHistory} from './history-ranking';
import {historyTimeSpan,parseHistoryTemporal,type HistoryTemporalQuery} from './history-temporal';
import type {HistoryDocument,HistoryMessage,HistorySession,HistoryPartition,HistoryDependency,HistoryExcerptRef,HistoryHitDocument,StoredHistory,HistoryResult,HistorySettings,HistoryVector,ReadonlyHistoryProvenance} from './history-contracts';
function fail(code='MEMORY_HISTORY_INPUT_INVALID'):never {throw new Error(code)}
const natural=(v:unknown):number=>{if(!Number.isSafeInteger(v)||(v as number)<0)fail();return v as number};
const list=(v:unknown,max=128):unknown[]=>{if(!Array.isArray(v)||v.length>max)fail();return v};
const digest=(v:unknown):string=>createHash('sha256').update(canonicalJson(v)).digest('hex');
const text=(v:unknown,max=65536):string=>{if(typeof v!=='string'||v.length>max)fail();return v};
function bound(v:unknown):BoundSourceRef {const r=parseSourceRef(v);if(!r.binding||r.span)fail();return r as BoundSourceRef}

function eventId(v:unknown):string {const s=text(v,1024);if(!s||/[\u0000-\u001f\u007f]/u.test(s))fail();return s}

export function parseReadonlyHistoryProvenance(v:unknown):ReadonlyHistoryProvenance[]{
 return list(v,128).map(raw=>{const p=objectFields(raw,['originalId','seq','turnId','revision','incarnation','digest','span','originalRole','occurredAt','timeZone','active','format','providerId','sessionId'],['field']),s=objectFields(p.span,['start','end']);
  if(typeof p.digest!=='string'||!/^[a-f0-9]{64}$/.test(p.digest)||typeof p.active!=='boolean'||!['transcript-v1','chat-session-v1'].includes(p.format as string)||!['user','assistant','system','tool'].includes(p.originalRole as string)||natural(s.end)<natural(s.start))fail();
  if(p.field!==undefined&&p.field!=='modelContext')fail();
  const zone=p.timeZone===null?null:text(p.timeZone,128);if(zone!==null){try{new Intl.DateTimeFormat('en',{timeZone:zone})}catch{fail()}}
  return {originalId:eventId(p.originalId),seq:p.seq===null?null:positiveRevision(p.seq),turnId:p.turnId===null?null:eventId(p.turnId),revision:p.revision===null?null:positiveRevision(p.revision),incarnation:parseInternalId(p.incarnation),digest:p.digest,span:{start:natural(s.start),end:natural(s.end)},originalRole:p.originalRole as ReadonlyHistoryProvenance['originalRole'],occurredAt:p.occurredAt===null?null:natural(p.occurredAt),timeZone:zone,active:p.active,format:p.format as ReadonlyHistoryProvenance['format'],providerId:parseInternalId(p.providerId),sessionId:parseInternalId(p.sessionId),...(p.field==='modelContext'?{field:'modelContext' as const}:{})};
 });
}

export function parseHistorySessions(v:unknown):HistorySession[]{const sessions=list(v,32).map(raw=>{const s=objectFields(raw,['providerId','sessionId']);return {providerId:parseInternalId(s.providerId),sessionId:parseInternalId(s.sessionId)}});if(!sessions.length||new Set(sessions.map(canonicalJson)).size!==sessions.length)fail();return sessions.sort((a,b)=>canonicalJson(a)<canonicalJson(b)?-1:1)}
function vector(v:unknown):HistoryVector|null {if(v===null)return null;const raw=objectFields(v,['identity','values']),values=raw.values as number[];return {identity:parseInternalId(raw.identity),values:normalizeVector(values,values?.length)}}
function dependencies(v:unknown):SourceDependency[]{return list(v,128).map(raw=>{const d=objectFields(raw,['sourceRef','subjectKeys','derivedRefs']);const subjectKeys=d.subjectKeys===null?null:list(d.subjectKeys,64).map(x=>{if(typeof x!=='string'||!/^actor-attribute-[a-f0-9]{64}$/.test(x))fail();return x});return {sourceRef:bound(d.sourceRef),subjectKeys,derivedRefs:d.derivedRefs===null?null:list(d.derivedRefs,64).map(bound)}})}
export function parseHistoryDocument(v:unknown,options?:{allowUnboundTranscript?:boolean}):HistoryDocument {
 const d=objectFields(v,['id','incarnation','revision','origin','sourceDeps','messages','vector'],['transcriptRef','classification','provenance']);if(d.origin!=='canonical'&&d.origin!=='synthetic-import')fail();
 const messages:HistoryMessage[]=list(d.messages,128).map(raw=>{const m=objectFields(raw,['id','role','text','occurredAt','timeZone'],['sourceRef','toolCallIds','toolCallId','toolCalls','name']);
  if(!['user','assistant','system','tool'].includes(m.role as string))fail();const time=m.occurredAt===null?null:natural(m.occurredAt),zone=m.timeZone===null?null:text(m.timeZone,128);if(zone!==null){try{new Intl.DateTimeFormat('en',{timeZone:zone})}catch{fail()}}
  return {id:parseInternalId(m.id),role:m.role as HistoryMessage['role'],text:text(m.text),occurredAt:time,timeZone:zone,...(m.sourceRef?{sourceRef:bound(m.sourceRef)}:{}),...(m.toolCallIds?{toolCallIds:list(m.toolCallIds,64).map(eventId)}:{}),...(m.toolCallId?{toolCallId:eventId(m.toolCallId)}:{}),...(m.toolCalls!==undefined?{toolCalls:list(m.toolCalls,64).map(raw=>{const c=objectFields(raw,['id','name','arguments']);return {id:eventId(c.id),name:eventId(c.name),arguments:text(c.arguments)}})}:{}),...(m.name!==undefined?{name:eventId(m.name)}:{})};
 });
 if(!messages.length||new Set(messages.map(m=>m.id)).size!==messages.length||messages.reduce((n,m)=>n+historyMessageChars(m),0)>65536)fail();
 validateUnit({id:parseInternalId(d.id),kind:'summary',messages});if(messages.some(m=>[m.text,m.name??'',...(m.toolCalls??[]).flatMap(c=>[c.name,c.arguments])].some(s=>extractMaintenance(s).kind==='rejected')))fail('MEMORY_HISTORY_SECRET');
 const sourceDeps=dependencies(d.sourceDeps);if(d.origin==='canonical'&&!sourceDeps.length&&d.transcriptRef===undefined&&options?.allowUnboundTranscript!==true)fail();
 const byRef=new Map(sourceDeps.map(dep=>[canonicalJson(dep.sourceRef),dep]));if(byRef.size!==sourceDeps.length||new Set(sourceDeps.map(dep=>dep.sourceRef.sourceId)).size!==sourceDeps.length)fail('MEMORY_HISTORY_SOURCE_MISMATCH');
 const complete=new Set<string>();
 function closed(dep:SourceDependency,path=new Set<string>()):void {const key=canonicalJson(dep.sourceRef);if(complete.has(key))return;if(path.has(key))fail('MEMORY_HISTORY_SOURCE_MISMATCH');for(const ref of dep.derivedRefs??[]){const root=byRef.get(canonicalJson(ref));if(!root)fail('MEMORY_HISTORY_SOURCE_MISMATCH');closed(root,new Set([...path,key]))}complete.add(key)}
 for(const dep of sourceDeps)closed(dep);
 let transcriptRef;if(d.transcriptRef!==undefined){const ref=objectFields(d.transcriptRef,['headId','revision','digest']);if(typeof ref.digest!=='string'||!/^[a-f0-9]{64}$/.test(ref.digest))fail();transcriptRef={headId:parseInternalId(ref.headId),revision:positiveRevision(ref.revision),digest:ref.digest}}
 if(d.origin==='synthetic-import'&&(sourceDeps.length||messages.some(m=>m.sourceRef)||transcriptRef))fail();
 let provenance:ReadonlyHistoryProvenance[]|undefined;
 if(d.classification!==undefined&&!['raw-history','legacy-derived-unverified','unverified'].includes(d.classification as string))fail();
 if(d.provenance!==undefined){provenance=parseReadonlyHistoryProvenance(d.provenance);if(provenance.length!==messages.length||provenance.some((p,i)=>p.originalRole!==messages[i].role||p.occurredAt!==messages[i].occurredAt||p.timeZone!==messages[i].timeZone||p.span.end-p.span.start!==messages[i].text.length))fail('MEMORY_HISTORY_SOURCE_MISMATCH')}
 return {id:parseInternalId(d.id),incarnation:parseInternalId(d.incarnation),revision:positiveRevision(d.revision),origin:d.origin,sourceDeps,messages,vector:vector(d.vector),...(transcriptRef?{transcriptRef}:{}),...(d.classification?{classification:d.classification as HistoryDocument['classification']}:{}),...(provenance?{provenance}:{})};
}
function settings(v:unknown):HistorySettings {const s=objectFields(v,['version','limit','candidateLimit','rrfK','mmrLambda','maxTotalChars','maxExcerptChars','maxIndexDocuments','maxIndexBytes'],['windowTurns','recencyAlpha','recencyHalfLifeDays']);
 if(s.windowTurns!==undefined&&(!Number.isSafeInteger(s.windowTurns)||(s.windowTurns as number)<0||(s.windowTurns as number)>8))fail();
 if(s.recencyAlpha!==undefined&&(!Number.isFinite(s.recencyAlpha as number)||(s.recencyAlpha as number)<0||(s.recencyAlpha as number)>1))fail();
 if(s.recencyHalfLifeDays!==undefined&&(!Number.isFinite(s.recencyHalfLifeDays as number)||(s.recencyHalfLifeDays as number)<1||(s.recencyHalfLifeDays as number)>3650))fail();
 for(const key of ['limit','candidateLimit','rrfK','maxTotalChars','maxExcerptChars','maxIndexDocuments','maxIndexBytes'])if(natural(s[key])<1)fail();
 if((s.limit as number)>8||(s.candidateLimit as number)>50||(s.maxIndexDocuments as number)>4096||(s.maxIndexBytes as number)>32*1024*1024||(s.maxTotalChars as number)>65536||(s.maxExcerptChars as number)>65536||!Number.isFinite(s.mmrLambda as number)||(s.mmrLambda as number)<0||(s.mmrLambda as number)>1)fail();return {windowTurns:0,recencyAlpha:0,recencyHalfLifeDays:30,...s,version:parseInternalId(s.version)} as unknown as HistorySettings;
}
function parseExcerptRef(v:unknown):HistoryExcerptRef{const e=objectFields(v,['version','start','end','total','digest']);if(e.version!==HISTORY_EXCERPT_VERSION||typeof e.digest!=='string'||!/^[a-f0-9]{64}$/.test(e.digest))fail();return {version:HISTORY_EXCERPT_VERSION,start:natural(e.start),end:natural(e.end),total:natural(e.total),digest:e.digest}}
export function parseHistoryDependencies(v:unknown):HistoryDependency[]{return list(v,8).map(raw=>{const d=objectFields(raw,['documentId','providerId','sessionId','incarnation','revision','digest','generation','partition','indexVersion','tokenizerVersion','rankingVersion','recallDeps'],['excerpt']),p=objectFields(d.partition,['actorKey','sessions']);if(typeof d.digest!=='string'||! /^[a-f0-9]{64}$/.test(d.digest))fail();return {documentId:parseInternalId(d.documentId),providerId:parseInternalId(d.providerId),sessionId:parseInternalId(d.sessionId),incarnation:parseInternalId(d.incarnation),revision:positiveRevision(d.revision),digest:d.digest,generation:natural(d.generation),partition:{actorKey:parseInternalId(p.actorKey),sessions:parseHistorySessions(p.sessions)},indexVersion:text(d.indexVersion,128),tokenizerVersion:text(d.tokenizerVersion,128),rankingVersion:text(d.rankingVersion,128),recallDeps:parseRecallDependencies(d.recallDeps),...(d.excerpt!==undefined?{excerpt:parseExcerptRef(d.excerpt)}:{})}})}
/** Frozen native transcript provenance only; generic canonical/imported H stays current. */
export function isResponseNativeHistoryDocument(d:HistoryDocument):boolean {
 return d.origin==='canonical'&&d.classification==='raw-history'&&/^native-[a-f0-9]{64}$/.test(d.id)&&/^native-[a-f0-9]{64}$/.test(d.incarnation)&&d.sourceDeps.length===0&&d.messages.length>0&&d.messages.every(m=>!m.sourceRef)&&d.provenance?.length===d.messages.length&&d.provenance.every(p=>p.format==='transcript-v1'&&p.active&&p.field===undefined&&p.incarnation===d.incarnation&&Number.isSafeInteger(p.seq)&&p.seq!>0);
}
/** Worker-only: decrypt authorized partitions, build an ephemeral bounded index, never log bodies. */
export class HistoryRepository {
 private readonly codec:RecordCodec;private readonly ledger:SourceLedger;private readonly suppression:Suppression;
 /** Set only while a query reads: origin answers are reused, since nothing writes until it returns. */
 private readSnapshot?:{origins:HistoryOrigins;states:WeakMap<object,Array<'unknown'|'valid'|'invalid'>>};
 constructor(private readonly db:DatabaseSync,private readonly key:Uint8Array,private readonly fault?:TransactionFault,private readonly clock:()=>number=Date.now){this.codec=new RecordCodec(key);this.ledger=new SourceLedger(db,key);this.suppression=new Suppression(db,key)}
 private generation(scope:string,actorKey:string):number {
  // Read only canonical M ownership metadata, never other actors' history corpus.
  // Old unowned barriers remain conservative; sanctioned M barriers are actor-local for H.
  const owners=new Map<string,Set<string>>();
  for(const row of this.db.prepare('SELECT id,payload FROM policy_records WHERE scope_key=?').all(scope)){
   const p=this.codec.open<{actorKey:string;factId:string|null}>('policy-record',scope,row.id as string,row.payload);
   if(p.factId){const actors=owners.get(p.factId)??new Set<string>();actors.add(p.actorKey);owners.set(p.factId,actors)}
  }
  let generation=0;for(const row of this.db.prepare('SELECT id,payload FROM deletion_markers WHERE scope_key=?').all(scope)){
   const marker=this.codec.open<{factId:string;generation?:number}>('deletion_markers',scope,row.id as string,row.payload),actors=owners.get(marker.factId);
   if(!actors)return this.suppression.generation(scope);if(actors.has(actorKey))generation=Math.max(generation,marker.generation??this.suppression.generation(scope));
  }return generation;
 }
 private partition(scope:string,actorKey:string,s:HistorySession){return createHmac('sha256',this.key).update('FireflyHistoryPartition-v1').update(canonicalJson({scope,actorKey,providerId:s.providerId,sessionId:s.sessionId})).digest()}
 private id(scope:string,actorKey:string,s:HistorySession,documentId:string){return historyDocumentKey(this.key,scope,{actorKey,...s},documentId)}
 private decode(scope:string,row:Record<string,unknown>):StoredHistory {const d=this.codec.open<StoredHistory>('history-document',scope,row.id as string,row.payload);parseHistoryDocument({id:d.id,incarnation:d.incarnation,revision:d.revision,origin:d.origin,sourceDeps:d.sourceDeps,messages:d.messages,vector:d.vector,...(d.transcriptRef?{transcriptRef:d.transcriptRef}:{}),...(d.classification?{classification:d.classification}:{}),...(d.provenance?{provenance:d.provenance}:{})});if(!['live','deleted'].includes(d.state)||d.digest!==this.contentDigest(d)||row.id!==this.id(scope,d.actorKey,d,d.id)||!(row.partition_index instanceof Uint8Array)||!this.partition(scope,d.actorKey,d).equals(Buffer.from(row.partition_index)))fail('MEMORY_DATA_INVALID');return d}
 private contentDigest(d:HistoryDocument){return digest({id:d.id,incarnation:d.incarnation,revision:d.revision,origin:d.origin,sourceDeps:d.sourceDeps,messages:d.messages,vector:d.vector,...(d.transcriptRef?{transcriptRef:d.transcriptRef}:{}),...(d.classification?{classification:d.classification}:{}),...(d.provenance?{provenance:d.provenance}:{})})}
 private read(scope:string,actorKey:string,s:HistorySession,id:string):StoredHistory|null {const row=this.db.prepare("SELECT * FROM history_records WHERE scope_key=? AND id=? AND kind='document'").get(scope,this.id(scope,actorKey,s,id));return row?this.decode(scope,row):null}
 private save(scope:string,d:StoredHistory){const id=this.id(scope,d.actorKey,d,d.id);this.db.prepare("INSERT INTO history_records(id,scope_key,partition_index,kind,payload) VALUES(?,?,?,'document',?) ON CONFLICT(id,scope_key) DO UPDATE SET payload=excluded.payload").run(id,scope,this.partition(scope,d.actorKey,d),this.codec.seal('history-document',scope,id,d));this.fault?.('after-record')}
 private checkSource(scope:string,d:StoredHistory,dep:SourceDependency,seen=new Set<string>()):boolean {
  const ref=dep.sourceRef;if(ref.binding.providerId!==d.providerId||ref.binding.sessionId!==d.sessionId)fail('MEMORY_HISTORY_ACCESS_DENIED');
  const head=this.ledger.assertCurrent(scope,ref);if(!head?.published||this.suppression.sourceBlocked(scope,ref)||seen.has(ref.sourceId))return false;
  // Parsing requires a closed DAG; checkedDocument validates every root's head
  // and available checks every root's suppression independently of this generation.
  const gen=this.generation(scope,d.actorKey);if(gen===0)return true;
  if(head.published.role==='user'&&head.published.trust==='direct-user-event')return (head.firstObservedSuppressionGeneration??0)>=gen||!!dep.subjectKeys?.length&&!dep.subjectKeys.some(s=>this.suppression.subjectBlocked(scope,s));
  return !!dep.derivedRefs?.length&&dep.derivedRefs.every(root=>{const other=d.sourceDeps.find(v=>canonicalJson(v.sourceRef)===canonicalJson(root));return !!other&&this.checkSource(scope,d,other,new Set([...seen,ref.sourceId]))});
 }
 private originStates(scope:string,d:Pick<StoredHistory,'actorKey'|'providerId'|'sessionId'|'provenance'>):Array<'unknown'|'valid'|'invalid'> {
  const known=this.readSnapshot?.states.get(d);if(known)return known;
  const origins=this.readSnapshot?.origins??new HistoryOrigins(this.db,this.key);
  const states:Array<'unknown'|'valid'|'invalid'>=(d.provenance??[]).map(p=>{if(p.format!=='transcript-v1'||!p.active||p.field||p.seq===null||p.providerId!==d.providerId||p.sessionId!==d.sessionId||!['user','assistant','tool'].includes(p.originalRole))return 'unknown';const event:HistoryOriginEvent={originalId:p.originalId,seq:p.seq,turnId:p.turnId,revision:p.revision,originalRole:p.originalRole as HistoryOriginEvent['originalRole'],digest:p.digest};return origins.valid(scope,d,event)?'valid':origins.known(scope,d,event)?'invalid':'unknown'});
  this.readSnapshot?.states.set(d,states);return states;
 }
 private provedOrigins(scope:string,d:StoredHistory):boolean {const states=this.originStates(scope,d);return states.length===d.messages.length&&states.length>0&&states.every(s=>s==='valid')}
 private available(scope:string,d:StoredHistory):boolean {if(d.state!=='live'||d.classification!==undefined&&d.classification!=='raw-history'||d.provenance?.some(p=>!p.active))return false;const generation=this.generation(scope,d.actorKey);if(d.origin==='synthetic-import')return d.generation===generation;if(d.generation<generation&&d.messages.some(m=>!m.sourceRef)&&!this.provedOrigins(scope,d))return false;return d.sourceDeps.every(dep=>this.checkSource(scope,d,dep))}
 /** Superseded assertions are exclusion metadata only, never historical truth. */
 private hasSupersededOrigin(scope:string,d:Pick<StoredHistory,"actorKey"|"sourceDeps"|"messages"|"provenance">):boolean {
  const owned=new Set<string>();
  for(const row of this.db.prepare('SELECT id,payload FROM policy_records WHERE scope_key=?').all(scope)){
   const p=this.codec.open<{actorKey:string;factId:string|null}>('policy-record',scope,row.id as string,row.payload);
   if(p.actorKey===d.actorKey&&p.factId)owned.add(p.factId);
  }
  const facts=new FactRepository(this.db,this.key),supports=new FactSupports(this.db,this.key);
  for(const current of facts.current(scope).filter(f=>owned.has(f.factId))){
   // Unbound transcripts and assistant/tool echoes cannot prove independence from
   // retired facts. Preserve the same fail-closed boundary used after forgetting.
   const untraceable=d.sourceDeps.length===0||d.messages.some(m=>m.role!=='user'&&(!m.sourceRef||!d.sourceDeps.find(dep=>dep.sourceRef.sourceId===m.sourceRef!.sourceId)?.derivedRefs?.length));
   let invalidSource=false;
   try{const head=this.ledger.assertCurrent(scope,current.sourceRef);invalidSource=!head?.published||this.suppression.sourceBlocked(scope,current.sourceRef)}catch(error){
    if(error instanceof Error&&['MEMORY_SOURCE_PENDING','MEMORY_SOURCE_STALE','MEMORY_SOURCE_DELETED'].includes(error.message))invalidSource=true;else throw error;
   }
   if(untraceable&&(current.revision>1||invalidSource))return true;
   if(current.revision<=1)continue;
   const refs=[...facts.history(scope,current.factId).filter(v=>v.revision<current.revision).flatMap(v=>[v.sourceRef,v.provenance.activationSourceRef]),...supports.obsoleteOrigins(scope,d.actorKey,current.factId,current.revision)];
   if(refs.some(ref=>d.sourceDeps.some(dep=>dep.sourceRef.sourceId===ref.sourceId&&dep.sourceRef.revision<=ref.revision)||ref.binding&&d.provenance?.some(p=>p.providerId===ref.binding!.providerId&&p.sessionId===ref.binding!.sessionId&&p.originalId===ref.binding!.messageId)))return true;
  }
  return false;
 }
 private checkedDocument(scope:string,d:StoredHistory,expected?:RecallDependency[],response?:{owner:{actorKey:string;providerId:string;sessionId:string};operationId:string}):RecallDependency[] {
  if(d.origin==='canonical'){
   if(isResponseNativeHistoryDocument(d)&&!d.sourceDeps.length&&!this.provedOrigins(scope,d))fail('MEMORY_HISTORY_STALE');
   if(!d.sourceDeps.length&&this.generation(scope,d.actorKey)>0&&!this.provedOrigins(scope,d))fail('MEMORY_HISTORY_STALE');
   if(d.transcriptRef){const ledger=new TranscriptLedger(this.db,this.key),owner={actorKey:d.actorKey,providerId:d.providerId,sessionId:d.sessionId,bootId:'history'};
    const pending=response&&isResponseNativeHistoryDocument(d)&&response.owner.actorKey===d.actorKey&&response.owner.providerId===d.providerId&&response.owner.sessionId===d.sessionId;
    const head=pending?ledger.head(scope,owner,d.transcriptRef.headId):ledger.current(scope,owner,d.transcriptRef);
    if(!head||pending&&(head.state!=='pending'||head.operationId!==response!.operationId||canonicalJson(head.ref)!==canonicalJson(d.transcriptRef)))fail('MEMORY_CONTEXT_RESPONSE_PROGRESS_STALE');
    if(!d.sourceDeps.length&&head.ref?.digest!==historyTranscriptDigest(d))fail('MEMORY_HISTORY_SOURCE_MISMATCH');
   }else if(d.messages.some(m=>!m.sourceRef))fail('MEMORY_HISTORY_SOURCE_MISMATCH')
  }
  for(const dep of d.sourceDeps){if(dep.sourceRef.binding.providerId!==d.providerId||dep.sourceRef.binding.sessionId!==d.sessionId)fail('MEMORY_HISTORY_ACCESS_DENIED');this.ledger.assertCurrent(scope,dep.sourceRef)}
  for(const m of d.messages)if(m.sourceRef){if(!d.sourceDeps.some(dep=>canonicalJson(dep.sourceRef)===canonicalJson(m.sourceRef)))fail('MEMORY_HISTORY_SOURCE_MISMATCH');const h=this.ledger.assertCurrent(scope,m.sourceRef)!;
   if(h.published!.role!==m.role||(h.published!.occurredAt??null)!==m.occurredAt||h.published!.fingerprint!==digest({text:m.text,state:h.published!.state,role:h.published!.role,trust:h.published!.trust}))fail('MEMORY_HISTORY_SOURCE_MISMATCH');
  }
  if(this.originStates(scope,d).includes('invalid')||!this.available(scope,d)||!this.provedOrigins(scope,d)&&this.hasSupersededOrigin(scope,d))fail('MEMORY_HISTORY_STALE');
  const roots=d.sourceDeps.map(dep=>dep.sourceRef.sourceId),subjects=d.sourceDeps.flatMap(dep=>dep.subjectKeys??[]),facts=new PolicyRepository(this.db,this.key).eligibleFactsWithinTransaction(scope,d.actorKey,transactionNow(this.db)).filter(f=>roots.includes(f.sourceRef.sourceId)||roots.includes(f.provenance.activationSourceRef.sourceId)||subjects.includes(f.subjectKey));
  return new RecallRepository(this.db,this.key,()=>transactionNow(this.db)).readVisibleFactsWithinTransaction(scope,d.actorKey,facts.map(f=>({factId:f.factId,revision:f.revision})),expected).recallDeps;
 }
 /** Best window of an oversized document plus neighbours, within what the budgets allow. Only the repository's own stored messages are measured and sliced; ranking contributes just the window index. Null means no safe range: the caller drops the document, nothing is truncated. */
 private excerptRange(d:StoredHistory,sizes:number[],unit:number|undefined,config:HistorySettings,remaining:number,temporal?:HistoryTemporalQuery):ExcerptRange|null {
  if(unit===undefined)return null;const maxChars=Math.min(config.maxExcerptChars,remaining);
  // A time range filters whole documents, so a document can overlap the range while parts of it lie outside. Messages outside the range
  // are priced out of the excerpt (so neither the best window nor its neighbours can include them) and the result is re-checked below.
  const inRange=(m:{occurredAt:number|null})=>temporal?.kind!=='range'||m.occurredAt!==null&&m.occurredAt>=temporal.from&&m.occurredAt<=temporal.to;
  const priced=temporal?.kind==='range'?sizes.map((n,i)=>inRange(d.messages[i])?n:Number.MAX_SAFE_INTEGER):sizes;
  const range=selectExcerpt({sizes:priced,windowTurns:config.windowTurns,bestUnit:unit,maxChars,contextWindows:HISTORY_EXCERPT_CONTEXT_WINDOWS,groups:atomicGroups(d.messages)});
  if(!range||range.start===0&&range.end===d.messages.length||sizes.slice(range.start,range.end).reduce((n,x)=>n+x,0)>maxChars||!excerptToolSafe(d.messages,range)||!d.messages.slice(range.start,range.end).every(inRange))return null;return range;
 }
 private validateDocuments(scope:string,actorKey:string,value:unknown,response?:{owner:{actorKey:string;providerId:string;sessionId:string};operationId:string}):StoredHistory[]{
  // Validation only reads, so like a query it shares one origin snapshot; without it every context step took seconds.
  return this.withReadSnapshot(()=>this.validateDependencies(scope,actorKey,value,response));
 }
 /** Origin checks inside run share one snapshot; run must not write origins before its last check. */
 private withReadSnapshot<T>(run:()=>T):T{
  const own=!this.readSnapshot;if(own)this.readSnapshot={origins:new HistoryOrigins(this.db,this.key,{snapshot:true}),states:new WeakMap()};
  try{return run()}finally{if(own)this.readSnapshot=undefined}
 }
 private validateDependencies(scope:string,actorKey:string,value:unknown,response?:{owner:{actorKey:string;providerId:string;sessionId:string};operationId:string}):StoredHistory[]{
  return parseHistoryDependencies(value).map(dep=>{
   if(dep.partition.actorKey!==actorKey||!dep.partition.sessions.some(s=>s.providerId===dep.providerId&&s.sessionId===dep.sessionId))fail('MEMORY_HISTORY_ACCESS_DENIED');
   if(dep.generation!==this.generation(scope,actorKey)||dep.indexVersion!=='history-index-v1'||dep.rankingVersion!=='history-ranking-v4'||!/^history-jieba-v2-[a-f0-9]{64}$/.test(dep.tokenizerVersion))fail('MEMORY_HISTORY_STALE');
   const d=this.read(scope,actorKey,dep,dep.documentId);if(!d||d.incarnation!==dep.incarnation||d.revision!==dep.revision||d.digest!==dep.digest)fail('MEMORY_HISTORY_STALE');if(dep.excerpt&&!verifyExcerpt(d,d.digest,dep.excerpt))fail('MEMORY_HISTORY_STALE');this.checkedDocument(scope,d,dep.recallDeps,response);return d;
  });
 }
 /** Only ContextRepository's claimed response path supplies this reservation-bound exception. */
 validateResponseWithinTransaction(scope:string,actorKey:string,value:unknown,owner:{actorKey:string;providerId:string;sessionId:string},operationId:string):StoredHistory[]{
  return this.validateDocuments(scope,actorKey,value,{owner,operationId});
 }
 validateWithinTransaction(scope:string,actorKey:string,value:unknown):StoredHistory[]{return this.validateDocuments(scope,actorKey,value)}
 execute(value:unknown):unknown {
  const c=objectFields(value,['kind','scopeKey','body'],['commandId']),scope=parseInternalId(c.scopeKey),b=objectFields(c.body,['actorKey','providerId','sessionId'],['sessions','query','settings','vector','customWords','document','generation','documentId','revision','dependencies','documents','digest','transcriptHeads','temporal','event','mutation','entry']);
  const owner={actorKey:parseInternalId(b.actorKey),providerId:parseInternalId(b.providerId),sessionId:parseInternalId(b.sessionId)},identity=['actorKey','providerId','sessionId'];
  const apply=()=>{
   if(c.kind==='retireOrigins'){objectFields(b,[...identity,'mutation'],['entry']);if(!['append','delete','repair'].includes(b.mutation as string))fail();new HistoryOrigins(this.db,this.key).retire(scope,owner,b.mutation as 'append'|'delete'|'repair',b.entry as {kind:string});return {retired:true}}
   if(c.kind==='originStatus'){objectFields(b,[...identity,'event']);return {valid:new HistoryOrigins(this.db,this.key).valid(scope,owner,parseHistoryOriginEvent(b.event))}}
   if(c.kind==='projectNative'){
    objectFields(b,[...identity,'document']);const doc=parseHistoryDocument(b.document,{allowUnboundTranscript:true}),d={...doc,...owner,generation:this.generation(scope,owner.actorKey),digest:'',state:'live' as const};
    // Every message of the growing transcript is checked on each projection; they share one origin snapshot.
    if(!isResponseNativeHistoryDocument(doc))fail('MEMORY_HISTORY_SOURCE_MISMATCH');const states=this.withReadSnapshot(()=>this.originStates(scope,d));
    if(states.every(s=>s==='valid'))return {documents:[doc],partial:false};
    const groups=atomicGroups(doc.messages),documents:HistoryDocument[]=[];let start=0,runStart:number|undefined;
    const flush=(end:number)=>{if(runStart===undefined)return;const part={...doc,id:'native-'+digest({origin:doc.id,start:runStart,end,version:'origin-v1'}),messages:doc.messages.slice(runStart,end),provenance:doc.provenance!.slice(runStart,end)};validateUnit({id:part.id,kind:'summary',messages:part.messages});documents.push(part);runStart=undefined};
    while(start<doc.messages.length){const end=groups.find(g=>g.start===start)?.end??start+1;if(states.slice(start,end).every(s=>s==='valid'))runStart??=start;else flush(start);start=end}flush(start);
    return {documents,partial:true};
   }
   if(c.kind==='baseline'){objectFields(b,identity);return {generation:this.generation(scope,owner.actorKey),...(this.hasSupersededOrigin(scope,{actorKey:owner.actorKey,sourceDeps:[],messages:[]})?{unboundDisabled:true}:{})}}
   if(c.kind==='validate'){objectFields(b,[...identity,'dependencies']);return {documents:this.validateWithinTransaction(scope,owner.actorKey,b.dependencies)}}
   if(c.kind==='migrationPreview'||c.kind==='migrationApply'){
    objectFields(b,[...identity,'documents','digest','generation']);if(natural(b.generation)!==this.generation(scope,owner.actorKey))fail('MEMORY_HISTORY_STALE');const documents=list(b.documents,c.kind==='migrationApply'?16:128).map(value=>parseHistoryDocument(value));if(digest(documents)!==b.digest||documents.some(d=>d.origin!=='synthetic-import')||new Set(documents.map(d=>d.id)).size!==documents.length)fail('MEMORY_HISTORY_IMPORT_INVALID');
    const result={new:0,duplicates:0,conflicts:0,inserted:0,quarantined:0};
    for(const doc of documents){const old=this.read(scope,owner.actorKey,owner,doc.id),incoming=this.contentDigest(doc),duplicate=old&&old.state==='live'&&old.revision===doc.revision&&old.digest===incoming;
     if(duplicate){result.duplicates++;continue}
     if(old||this.generation(scope,owner.actorKey)>0){result.conflicts++;if(c.kind==='migrationApply'){const id='quarantine-'+createHmac('sha256',this.key).update(canonicalJson({scope,...owner,id:doc.id,digest:incoming})).digest('hex');this.db.prepare("INSERT OR IGNORE INTO history_records VALUES(?,?,?,'quarantine',?)").run(id,scope,this.partition(scope,owner.actorKey,owner),this.codec.seal('history-quarantine',scope,id,{documentId:doc.id,revision:doc.revision,existingDigest:old?.digest??null,incomingDigest:incoming,reason:old?'identity-conflict':'untraceable-after-forget'}));this.fault?.('after-record');result.quarantined++}continue}
     result.new++;if(c.kind==='migrationApply'){this.save(scope,{...doc,...owner,generation:b.generation as number,digest:incoming,state:'live'});result.inserted++}
    }
    return c.kind==='migrationPreview'?{new:result.new,duplicates:result.duplicates,conflicts:result.conflicts}:{inserted:result.inserted,duplicates:result.duplicates,quarantined:result.quarantined};
   }
   if(c.kind==='put'){objectFields(b,[...identity,'document','generation']);const generation=natural(b.generation);if(generation!==this.generation(scope,owner.actorKey))fail('MEMORY_HISTORY_STALE');const doc=parseHistoryDocument(b.document),old=this.read(scope,owner.actorKey,owner,doc.id),contentDigest=this.contentDigest(doc);
    if(old?.state==='deleted')fail('MEMORY_HISTORY_CONFLICT');
    if(old&&old.revision===doc.revision){if(old.state==='live'&&old.digest===contentDigest){this.withReadSnapshot(()=>this.checkedDocument(scope,old));return {status:'duplicate',documentId:doc.id}};fail('MEMORY_HISTORY_CONFLICT')}
    if(old&&doc.revision<=old.revision)fail('MEMORY_HISTORY_CONFLICT');const stored:StoredHistory={...doc,...owner,generation,digest:contentDigest,state:'live'};this.withReadSnapshot(()=>this.checkedDocument(scope,stored));this.save(scope,stored);return {status:'stored',documentId:doc.id};
   }
    if(c.kind==='delete'){objectFields(b,[...identity,'documentId','revision']);const d=this.read(scope,owner.actorKey,owner,parseInternalId(b.documentId));if(!d||d.revision!==positiveRevision(b.revision))fail('MEMORY_HISTORY_STALE');d.state='deleted';this.save(scope,d);if(isResponseNativeHistoryDocument(d))new HistoryOrigins(this.db,this.key).revokeEvents(scope,owner,d.provenance!.map(p=>({originalId:p.originalId,seq:p.seq!,turnId:p.turnId,revision:p.revision,originalRole:p.originalRole as HistoryOriginEvent['originalRole'],digest:p.digest})));return {deleted:true}}
   if(c.kind==='query'){
    this.readSnapshot={origins:new HistoryOrigins(this.db,this.key,{snapshot:true}),states:new WeakMap()};
    try{
    objectFields(b,[...identity,'sessions','query','settings'],['vector','customWords','transcriptHeads','temporal']);const temporal=parseHistoryTemporal(b.temporal),activeHeads=new Set(list(b.transcriptHeads??[],4096).map(parseInternalId));const sessions=parseHistorySessions(b.sessions),config=settings(b.settings),query=text(b.query,4096),v=b.vector===undefined?null:vector(b.vector),partition:HistoryPartition={actorKey:owner.actorKey,sessions};
    const rows=this.db.prepare("SELECT * FROM history_records WHERE scope_key=? AND kind='document' AND partition_index IN ("+sessions.map(()=>'?').join(',')+") ORDER BY id LIMIT ?").all(scope,...sessions.map(s=>this.partition(scope,owner.actorKey,s)),config.maxIndexDocuments+1);
    const result:HistoryResult={status:'ok',hits:[],diversity:v?'vector-mmr':'lexical-dedup',settingsVersion:config.version};if(rows.length>config.maxIndexDocuments)return {...result,status:'index-budget-exhausted'};
    let bytes=0;const documents:StoredHistory[]=[];
    for(const row of rows){const d=this.decode(scope,row);if(d.transcriptRef&&!activeHeads.has(d.transcriptRef.headId))continue;try{this.checkedDocument(scope,d)}catch(e){if(e instanceof Error&&['MEMORY_CONTEXT_TRANSCRIPT_STALE','MEMORY_CONTEXT_TRANSCRIPT_PENDING','MEMORY_CONTEXT_TRANSCRIPT_DELETED','MEMORY_SOURCE_PENDING','MEMORY_SOURCE_STALE','MEMORY_SOURCE_DELETED','MEMORY_HISTORY_STALE','MEMORY_RECALL_FACT_ARCHIVED','MEMORY_RECALL_FACT_UNAVAILABLE'].includes(e.message))continue;throw e}bytes+=Buffer.byteLength(canonicalJson(d));if(bytes>config.maxIndexBytes)return {...result,status:'index-budget-exhausted'};documents.push(d)}
    const tokenizer=createHistoryTokenizer();if(b.customWords!==undefined)tokenizer.register(list(b.customWords,128).map(x=>text(x,128)));
    if(v&&documents.some(d=>!d.vector||d.vector.identity!==v.identity))fail('MEMORY_HISTORY_VECTOR_INVALID');
    const candidateDocuments=new Map(documents.map(d=>[this.id(scope,d.actorKey,d,d.id),d]));
    const ranked=rankHistory([...candidateDocuments].map(([id,d])=>({id,text:d.messages.map(m=>m.text).join('\n'),...(()=>{const units=toWindows(d.messages,config.windowTurns);return units?{units}:{}})(),timeSpan:historyTimeSpan(d.messages),exactIdentity:createHmac('sha256',this.key).update(canonicalJson({origin:d.origin,providerId:d.providerId,sessionId:d.sessionId,messages:d.messages,sourceDeps:d.sourceDeps,transcriptRef:d.transcriptRef??null,...(!d.sourceDeps.length?{documentId:d.id,incarnation:d.incarnation}:{})})).digest('hex'),...(v?{vector:d.vector!.values}:{})})),query,{limit:config.limit,candidateLimit:config.candidateLimit,rrfK:config.rrfK,mmrLambda:config.mmrLambda,...(temporal?{temporal}:{}),...(v?{queryVector:v.values}:{}),...(config.recencyAlpha>0?{recency:{alpha:config.recencyAlpha,halfLifeDays:config.recencyHalfLifeDays,now:transactionNow(this.db)}}:{}),tokenizer});
    if(ranked.temporal)result.temporal=ranked.temporal;
    const budget=result.budget=emptyHistoryBudgetStats();budget.ranked=ranked.items.length;
    let used=0;for(const candidate of ranked.items){const d=candidateDocuments.get(candidate.id)!,sizes=d.messages.map(historyMessageChars),length=sizes.reduce((n,x)=>n+x,0);let shown:HistoryHitDocument=d,excerpt:HistoryExcerptRef|undefined,chars=length;
     if(length>config.maxExcerptChars||used+length>config.maxTotalChars){
      // Only a document too large for the per-document limit is excerpted; one that merely no longer fits the remaining total is dropped as before.
      const range=length>config.maxExcerptChars?this.excerptRange(d,sizes,candidate.unit,config,config.maxTotalChars-used,temporal):null;
      if(!range){result.status='excerpt-budget-exhausted';countHistoryBudgetDrop(budget,{length,messageSizes:sizes,windowTurns:config.windowTurns,...(candidate.unit!==undefined?{bestUnit:candidate.unit}:{})},config.maxExcerptChars);continue}
      excerpt=excerptRef(d.digest,d,range);shown={...d,...sliceExcerpt(d,range),excerpt};chars=sizes.slice(range.start,range.end).reduce((n,x)=>n+x,0);budget.excerpted++;
     }used+=chars;budget.returned++;
     result.hits.push({document:shown,score:candidate.score,dependency:{documentId:d.id,providerId:d.providerId,sessionId:d.sessionId,incarnation:d.incarnation,revision:d.revision,digest:d.digest,generation:this.generation(scope,owner.actorKey),partition,indexVersion:'history-index-v1',tokenizerVersion:ranked.tokenizerVersion,rankingVersion:ranked.version,recallDeps:this.checkedDocument(scope,d),...(excerpt?{excerpt}:{})}});
    }return result;
    }finally{this.readSnapshot=undefined}
   }fail();
  };
  if(['query','baseline','validate','migrationPreview','originStatus','projectNative'].includes(c.kind as string)){if(c.commandId!==undefined)fail();this.db.exec('BEGIN IMMEDIATE');try{return withTransactionClock(this.db,this.clock,()=>{const r=apply();this.db.exec('COMMIT');return r})}catch(e){this.db.exec('ROLLBACK');throw e}}
  return executeTransaction({db:this.db,key:this.key,scope,commandId:parseInternalId(c.commandId),request:value,fault:this.fault,clock:this.clock,apply});
 }
}
