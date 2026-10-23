import {createHash,createHmac} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {BoundSourceRef} from '../../shared/memory-contracts';
import {canonicalJson} from '../memory-core/repository-types';
import {RecordCodec} from '../memory-core/record-codec';
import {SourceLedger} from '../memory-core/source-ledger';
import {Suppression} from '../memory-core/suppression';
import {FactRepository} from '../memory-core/fact-repository';
import {FactSupports} from '../memory-policy/fact-supports';
import {objectFields,parseInternalId,parseSourceRef,positiveRevision} from '../memory-core/command-validation';
import type {TranscriptEntry} from '../orchestrator/conversation-transcript-types';

export interface HistoryOriginOwner {actorKey:string;providerId:string;sessionId:string}
export interface HistoryOriginEvent {originalId:string;seq:number;turnId:string|null;revision:number|null;originalRole:'user'|'assistant'|'tool';digest:string}
export interface HistoryOriginDependency extends HistoryOriginOwner {event:HistoryOriginEvent}
export interface HistoryOriginClosure {sources:BoundSourceRef[];events:HistoryOriginDependency[];documents?:Array<HistoryOriginOwner&{recordId:string;incarnation:string}>;complete:boolean}
export function historyDocumentKey(key:Uint8Array,scope:string,owner:HistoryOriginOwner,documentId:string){return 'history-'+createHmac('sha256',key).update('FireflyHistoryDocument-v1').update(canonicalJson({scope,actorKey:owner.actorKey,providerId:owner.providerId,sessionId:owner.sessionId,documentId})).digest('hex')}
interface Receipt extends HistoryOriginOwner {event:HistoryOriginEvent;closure:HistoryOriginClosure;snapshotId?:string;revoked?:boolean}
const hash=(v:unknown)=>createHash('sha256').update(canonicalJson(v)).digest('hex');
function fail():never{throw Error('MEMORY_HISTORY_ORIGIN_INVALID')}
function eventId(v:unknown):string{if(typeof v!=='string'||!v||v.length>1024||/[\u0000-\u001f\u007f]/.test(v))fail();return v}
export function parseHistoryOriginEvent(value:unknown):HistoryOriginEvent {
 const e=objectFields(value,['originalId','seq','turnId','revision','originalRole','digest']);
 if(!['user','assistant','tool'].includes(e.originalRole as string)||typeof e.digest!=='string'||!/^[a-f0-9]{64}$/.test(e.digest))fail();
 return {originalId:eventId(e.originalId),seq:positiveRevision(e.seq),turnId:e.turnId===null?null:eventId(e.turnId),revision:e.revision===null?null:positiveRevision(e.revision),originalRole:e.originalRole as HistoryOriginEvent['originalRole'],digest:e.digest};
}
/** Called only on the canonical entry supplied by the guarded Main store. */
export function historyOriginEvent(entry:TranscriptEntry):HistoryOriginEvent {
 const role=entry.kind==='user'||entry.kind==='turn_rewind'?'user':entry.kind==='assistant'?'assistant':entry.kind==='tool_result'?'tool':null;if(!role)fail();
 return parseHistoryOriginEvent({originalId:entry.id,seq:entry.seq,turnId:entry.turnId??null,revision:entry.revision??null,originalRole:role,digest:hash(entry)});
}
/** Worker-only exact provenance. Neither receipt lookup nor parsing confers acquisition authority. */
export class HistoryOrigins {
 private readonly codec:RecordCodec;
 constructor(private readonly db:DatabaseSync,private readonly key:Uint8Array){this.codec=new RecordCodec(key)}
 private id(scope:string,owner:HistoryOriginOwner,event:HistoryOriginEvent):string {
  return 'origin-'+createHmac('sha256',this.key).update('FireflyHistoryOrigin-v1').update(canonicalJson({scope,actorKey:owner.actorKey,providerId:owner.providerId,sessionId:owner.sessionId,event})).digest('hex');
 }
 private read(scope:string,owner:HistoryOriginOwner,event:HistoryOriginEvent):Receipt|null {
  const id=this.id(scope,owner,event),row=this.db.prepare('SELECT payload FROM history_origins WHERE scope_key=? AND id=?').get(scope,id);
  if(!row)return null;const receipt=this.codec.open<Receipt>('history-origin',scope,id,row.payload);
  if(this.id(scope,receipt,receipt.event)!==id)fail();return receipt;
 }
 private save(scope:string,receipt:Receipt):void {
  if(!this.db.isTransaction)throw Error('MEMORY_TRANSACTION_REQUIRED');
  const owner={actorKey:receipt.actorKey,providerId:receipt.providerId,sessionId:receipt.sessionId};
  const id=this.id(scope,owner,receipt.event),previous=this.read(scope,owner,receipt.event);
  // Immutable proof: later observations cannot upgrade an incomplete historical closure.
  if(previous){const {revoked:_revoked,...proof}=previous;if(canonicalJson(proof)!==canonicalJson(receipt))fail();return}
  this.db.prepare('INSERT INTO history_origins(id,scope_key,payload) VALUES(?,?,?)').run(id,scope,this.codec.seal('history-origin',scope,id,receipt));
 }
 recordUser(scope:string,owner:HistoryOriginOwner,refValue:unknown,entry:TranscriptEntry):void {
  const ref=parseSourceRef(refValue);if(!ref.binding||ref.span)fail();const event=historyOriginEvent(entry);
  const head=new SourceLedger(this.db,this.key).assertCurrent(scope,ref),observation=head?.published;
  if(event.originalRole!=='user'||!event.turnId||ref.binding.providerId!==owner.providerId||ref.binding.sessionId!==owner.sessionId||ref.binding.messageId!==event.turnId||ref.binding.contentRevision!==event.revision||!observation||observation.role!=='user'||observation.trust!=='direct-user-event')fail();
  const payload=entry.kind==='user'?entry.payload:entry.kind==='turn_rewind'?entry.payload.replacementUser:undefined;
  if(!payload||typeof payload.text!=='string'||payload.attachments?.length||observation.fingerprint!==hash({text:payload.text,state:observation.state,role:observation.role,trust:observation.trust}))fail();
  this.save(scope,{actorKey:owner.actorKey,providerId:owner.providerId,sessionId:owner.sessionId,event,closure:{sources:[ref as BoundSourceRef],events:[],complete:true}});
 }
 recordResponse(scope:string,owner:HistoryOriginOwner,event:HistoryOriginEvent,snapshotId:string,closure:HistoryOriginClosure):void {
  if(event.originalRole==='user')fail();parseInternalId(snapshotId);this.save(scope,{actorKey:owner.actorKey,providerId:owner.providerId,sessionId:owner.sessionId,event,snapshotId,closure});
 }
 /** Precise retraction roots: revision advancement means correction; independent temporal facts retain their own identity. */
 sourceAllowed(scope:string,actorKey:string,ref:BoundSourceRef):boolean {
  try{
   const head=new SourceLedger(this.db,this.key).assertCurrent(scope,ref);if(!head?.published||new Suppression(this.db,this.key).sourceBlocked(scope,ref))return false;
   const owned=new Set<string>();for(const row of this.db.prepare('SELECT id,payload FROM policy_records WHERE scope_key=?').all(scope)){
    const policy=this.codec.open<{actorKey:string;factId:string|null}>('policy-record',scope,row.id as string,row.payload);if(policy.actorKey===actorKey&&policy.factId)owned.add(policy.factId);
   }
   const facts=new FactRepository(this.db,this.key),supports=new FactSupports(this.db,this.key);
   for(const current of facts.current(scope).filter(f=>owned.has(f.factId)&&f.revision>1)){
    const obsolete=[...facts.history(scope,current.factId).filter(f=>f.revision<current.revision).flatMap(f=>[f.sourceRef,f.provenance.activationSourceRef]),...supports.obsoleteOrigins(scope,actorKey,current.factId,current.revision)];
    if(obsolete.some(old=>old.sourceId===ref.sourceId&&ref.revision<=old.revision))return false;
   }return true;
  }catch(error){if(error instanceof Error&&['MEMORY_SOURCE_PENDING','MEMORY_SOURCE_STALE','MEMORY_SOURCE_DELETED','MEMORY_SOURCE_INVALID'].includes(error.message))return false;throw error}
 }
 valid(scope:string,owner:HistoryOriginOwner,value:HistoryOriginEvent):boolean {
  const memo=new Map<string,boolean>(),visiting=new Set<string>();let remaining=1000;
  const visit=(identity:HistoryOriginOwner,event:HistoryOriginEvent,depth:number):boolean=>{
   const id=this.id(scope,identity,event);if(memo.has(id))return memo.get(id)!;if(depth>64||--remaining<0||visiting.has(id))return false;
   const receipt=this.read(scope,identity,event);if(!receipt?.closure.complete||receipt.revoked)return false;
   remaining-=receipt.closure.sources.length+(receipt.closure.documents?.length??0);if(remaining<0)return false;
   const documentsValid=(receipt.closure.documents??[]).every(dep=>{if(dep.actorKey!==owner.actorKey)return false;const row=this.db.prepare("SELECT payload FROM history_records WHERE scope_key=? AND id=? AND kind='document'").get(scope,dep.recordId);if(!row)return false;const doc=this.codec.open<HistoryOriginOwner&{state:string;incarnation:string}>('history-document',scope,dep.recordId,row.payload);return doc.state==='live'&&doc.actorKey===dep.actorKey&&doc.providerId===dep.providerId&&doc.sessionId===dep.sessionId&&doc.incarnation===dep.incarnation});
   visiting.add(id);const valid=documentsValid&&receipt.closure.sources.every(ref=>this.sourceAllowed(scope,owner.actorKey,ref))&&receipt.closure.events.every(dep=>dep.actorKey===owner.actorKey&&visit(dep,dep.event,depth+1));visiting.delete(id);memo.set(id,valid);return valid;
  };return visit(owner,parseHistoryOriginEvent(value),0);
 }
 known(scope:string,owner:HistoryOriginOwner,event:HistoryOriginEvent):boolean{return this.read(scope,owner,parseHistoryOriginEvent(event))!==null}
 revokeEvents(scope:string,owner:HistoryOriginOwner,events:HistoryOriginEvent[]):void {
  if(!this.db.isTransaction)throw Error('MEMORY_TRANSACTION_REQUIRED');
  for(const event of events){const receipt=this.read(scope,owner,event);if(!receipt)continue;const id=this.id(scope,owner,event);this.db.prepare('UPDATE history_origins SET payload=? WHERE scope_key=? AND id=?').run(this.codec.seal('history-origin',scope,id,{...receipt,revoked:true}),scope,id)}
 }
 /** Canonical mutation observers call before write. A failed mutation stays conservatively revoked. */
 retire(scope:string,owner:HistoryOriginOwner,mutation:'append'|'delete'|'repair',entry?:{kind:string;payload?:{anchorUserTurnId?:string;disposition?:string}}):void {
  if(!this.db.isTransaction)throw Error('MEMORY_TRANSACTION_REQUIRED');
  if(mutation==='append'&&entry?.kind!=='turn_rewind')return;
  const rows=this.db.prepare('SELECT id,payload FROM history_origins WHERE scope_key=?').all(scope).map(row=>({id:row.id as string,receipt:this.codec.open<Receipt>('history-origin',scope,row.id as string,row.payload)})).filter(({receipt:r})=>r.actorKey===owner.actorKey&&r.providerId===owner.providerId&&r.sessionId===owner.sessionId);
  const anchors=rows.filter(({receipt:r})=>r.event.originalRole==='user'&&r.event.turnId===entry?.payload?.anchorUserTurnId),cutoff=anchors.length?Math.max(...anchors.map(({receipt:r})=>r.event.seq)):0;
  for(const {id,receipt} of rows){if(mutation==='append'&&cutoff>0&&(receipt.event.seq<cutoff||receipt.event.seq===cutoff&&entry?.payload?.disposition==='keep_user'))continue;
   this.db.prepare('UPDATE history_origins SET payload=? WHERE scope_key=? AND id=?').run(this.codec.seal('history-origin',scope,id,{...receipt,revoked:true}),scope,id);
  }
 }
}
