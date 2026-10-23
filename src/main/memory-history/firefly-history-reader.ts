import {historyMessageChars} from './history-message';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {canonicalJson} from '../memory-core/repository-types';
import {parseInternalId} from '../memory-core/command-validation';
import {classifySAssistantSettlement} from '../orchestrator/conversation-transcript-settlement';
import type {TranscriptEntry} from '../orchestrator/conversation-transcript-types';
import {extractMaintenance} from '../memory-policy/maintenance-extractor';
import {validateUnit} from '../memory-context/token-budget';
import type {ContextMessage} from '../memory-context/context-contracts';
import type {ReadonlyHistoryScope,ReadonlyHistoryReadResult,ReadonlyHistoryRecord,ReadonlyHistoryProvenance,HistoryMessage,ReadonlyHistoryBytes,ReadonlyHistorySelectionHead} from './history-contracts';

const hash=(v:unknown)=>createHash('sha256').update(canonicalJson(v)).digest('hex');
function fail(code='MEMORY_HISTORY_CORRUPT'):never {throw new Error(code)}
function row(v:unknown):Record<string,unknown>{if(!v||typeof v!=='object'||Array.isArray(v))fail();return v as Record<string,unknown>}
function string(v:unknown):string{if(typeof v!=='string'||v.length>65536)fail();return v}
function id(v:unknown):string{const s=string(v);if(!s||s.length>1024||/[\u0000-\u001f\u007f]/u.test(s))fail();return s}
function integer(v:unknown,min=0):number{if(!Number.isSafeInteger(v)||(v as number)<min)fail();return v as number}
function time(v:unknown):number|null{return v===undefined||v===null?null:integer(v)}
function abort(signal?:AbortSignal){if(signal?.aborted)fail('MEMORY_HISTORY_CANCELLED')}
export function validateReadonlyHistoryScope(value:ReadonlyHistoryScope):ReadonlyHistoryScope {
 const s=structuredClone(value);
 if(!s||!path.isAbsolute(s.root)||!Array.isArray(s.sessions)||!s.sessions.length||s.sessions.length>32)fail('MEMORY_HISTORY_ACCESS_DENIED');
 try{parseInternalId(s.actorKey);parseInternalId(s.scopeKey);for(const session of s.sessions){parseInternalId(session.providerId);parseInternalId(session.sessionId)}}catch{fail('MEMORY_HISTORY_ACCESS_DENIED')}
 if(new Set(s.sessions.map(canonicalJson)).size!==s.sessions.length)fail('MEMORY_HISTORY_ACCESS_DENIED');
 return s;
}
interface DecodedHistoryInput {text:string;incarnation:string}
/** Decodes supplied bytes only; neither filesystem provenance nor source authority is minted here. */
function decodeBytes(bytes:Uint8Array|null,incarnation:string):DecodedHistoryInput|null {
 if(bytes===null)return null;
 if(!(bytes instanceof Uint8Array)||bytes.byteLength>8*1024*1024)fail('MEMORY_HISTORY_INPUT_INVALID');
 let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes)}catch{fail()}
 return {text,incarnation};
}
interface NativeEntry {id:string;seq:number;at:number|null;kind:string;turnId?:string;revision?:number;payload:Record<string,unknown>;raw:Record<string,unknown>}
function entry(v:unknown):NativeEntry{
 const r=row(v);return {id:id(r.id),seq:integer(r.seq,1),at:time(r.at),kind:id(r.kind),...(r.turnId===undefined?{}:{turnId:id(r.turnId)}),...(r.revision===undefined?{}:{revision:integer(r.revision,1)}),payload:row(r.payload),raw:r};
}
function transcript(jsonl:DecodedHistoryInput|null,snapshot:DecodedHistoryInput|null,diagnostics:string[]):{entries:NativeEntry[];checkpointThroughSeq:number;completeTail:boolean}{
 let base:NativeEntry[]=[],through=0;const diagnosticStart=diagnostics.length;
 if(snapshot){
  let s:Record<string,unknown>;try{s=row(JSON.parse(snapshot.text))}catch{fail()}
  if(s.schemaVersion!==1||!Array.isArray(s.entries)||!Array.isArray(s.seenEntryIds)||!Array.isArray(s.seenUserRevisions))fail();
  base=s.entries.map(entry);through=integer(s.throughSeq);
  const savedIds=s.seenEntryIds,savedRevisions=s.seenUserRevisions;
  if((base.at(-1)?.seq??0)!==through||savedIds.length!==base.length||new Set(savedIds).size!==base.length||base.some(e=>!savedIds.includes(e.id)))fail();
  const revisions=base.filter(e=>e.kind==='user').map(e=>String(e.turnId)+'\u0000'+String(e.revision));if(savedRevisions.length!==revisions.length||new Set(savedRevisions).size!==revisions.length||revisions.some(key=>!savedRevisions.includes(key)))fail();
 }
 let text=jsonl?.text??'',lines=text.split('\n');lines.pop();
 if(text&&!text.endsWith('\n'))diagnostics.push('MEMORY_HISTORY_TRUNCATED_TAIL');
 const incoming:NativeEntry[]=[];
 for(let i=0;i<lines.length;i++){
  if(!lines[i].trim())fail();
  let parsed:unknown;try{parsed=JSON.parse(lines[i])}catch{if(i===lines.length-1){diagnostics.push('MEMORY_HISTORY_TRUNCATED_TAIL');break}fail()}
  incoming.push(entry(parsed));
 }
 const seen=new Map(base.map(e=>[e.seq,e])),byId=new Map<string,NativeEntry>();
 let prior=0;for(const e of base){if(e.seq!==prior+1||byId.has(e.id))fail();prior=e.seq;byId.set(e.id,e)}
 let priorLine=0;
 for(const e of incoming){
  if(e.seq<=priorLine)fail();priorLine=e.seq;
  if(e.seq<=through){if(!seen.has(e.seq)||canonicalJson(seen.get(e.seq)!.raw)!==canonicalJson(e.raw))fail();continue}
  if(e.seq!==prior+1||byId.has(e.id))fail();base.push(e);byId.set(e.id,e);prior=e.seq;
 }
 if(base.length>10000)fail('MEMORY_HISTORY_INPUT_INVALID');return {entries:base,checkpointThroughSeq:through,completeTail:!diagnostics.slice(diagnosticStart).includes('MEMORY_HISTORY_TRUNCATED_TAIL')};
}
interface Node {message:HistoryMessage;provenance:ReadonlyHistoryProvenance;raw:Record<string,unknown>;assistantEntryId?:string}
const derived=(text:string)=>/^\s*(?:\[此前对话已压缩为记忆摘要\]|<firefly_compaction_checkpoint>)/u.test(text);
function message(payload:Record<string,unknown>,role:ContextMessage['role']):ContextMessage {
 if(payload.role!==role||payload.rawAssistant!==undefined||payload.thinking||payload.internal||(payload.content!==undefined&&typeof payload.content!=='string'))fail('MEMORY_HISTORY_FORMAT_UNSUPPORTED');
 const m:ContextMessage={role,text:payload.content===undefined?'':string(payload.content)};
 if(payload.toolCalls!==undefined){
  if(role!=='assistant'||!Array.isArray(payload.toolCalls)||payload.toolCalls.length>64)fail();
  m.toolCalls=payload.toolCalls.map(v=>{const c=row(v);if(Object.keys(c).some(k=>!['id','name','arguments'].includes(k)))fail();return {id:id(c.id),name:id(c.name),arguments:string(c.arguments)}});
  m.toolCallIds=m.toolCalls.map(c=>c.id);
 }
 if(payload.toolCallId!==undefined)m.toolCallId=id(payload.toolCallId);
 if(payload.name!==undefined)m.name=id(payload.name);return m;
}
function makeNode(scope:ReadonlyHistoryScope,session:ReadonlyHistoryScope['sessions'][number],format:ReadonlyHistoryProvenance['format'],incarnation:string,r:Record<string,unknown>,m:ContextMessage,seq:number|null,turnId:string|null,revision:number|null,at:number|null):Node {
 const originalId=id(r.id),provenance:ReadonlyHistoryProvenance={originalId,seq,turnId,revision,incarnation,digest:hash(r),span:{start:0,end:m.text.length},originalRole:m.role,occurredAt:at,timeZone:null,active:true,format,providerId:session.providerId,sessionId:session.sessionId};
 return {message:{...m,id:'message-'+hash({scope:scope.scopeKey,actor:scope.actorKey,...session,format,originalId,seq}),occurredAt:at,timeZone:null},provenance,raw:r};
}
function records(scope:ReadonlyHistoryScope,session:ReadonlyHistoryScope['sessions'][number],groups:Node[][],diagnostics:string[]):ReadonlyHistoryRecord[]{
 return groups.filter(g=>g.length).map(g=>{
  let classification:ReadonlyHistoryRecord['classification']=g.some(n=>derived(n.message.text)||n.raw.readonlyDerived===true||n.raw.isSummary===true||['L0','L1','L2'].includes(String(n.raw.layer)))?'legacy-derived-unverified':g[0].message.role!=='user'?'unverified':'raw-history';
  if(g.some(n=>n.raw.readonlyDiagnostic===true))classification='unverified';
  if(g.length>128||g.reduce((count,n)=>count+historyMessageChars(n.message),0)>65536){classification='unverified';diagnostics.push('MEMORY_HISTORY_INPUT_LIMIT')}
  if(g.some(n=>[n.message.text,n.message.name??'',...(n.message.toolCalls??[]).flatMap(c=>[c.name,c.arguments])].some(text=>extractMaintenance(text).kind==='rejected'))){classification='unverified';diagnostics.push('MEMORY_HISTORY_SECRET')}
  try{validateUnit({id:'native',kind:'recent',messages:g.map(n=>n.message)})}catch{classification='unverified';diagnostics.push('MEMORY_HISTORY_TOOL_INCOMPLETE')}
  const provenance=g.map(n=>structuredClone(n.provenance)),messages=g.map(n=>structuredClone(n.message));
  const document={id:'native-'+hash({actor:scope.actorKey,scope:scope.scopeKey,...session,format:provenance[0].format,first:provenance[0].originalId,seq:provenance[0].seq,active:provenance[0].active,variant:g[0].raw.readonlyDerived===true?'modelContext':'native'}),incarnation:provenance[0].incarnation,revision:Math.max(1,...provenance.map(p=>p.seq??p.revision??1)),origin:'canonical' as const,sourceDeps:[],messages,vector:null,classification,provenance};
  return {document,classification,provenance};
 });
}
function transcriptRecords(scope:ReadonlyHistoryScope,session:ReadonlyHistoryScope['sessions'][number],entries:NativeEntry[],incarnation:string,diagnostics:string[]):ReadonlyHistoryRecord[]{
 const active:Node[][]=[],retired:Node[][]=[],separate:Node[][]=[];
 // Base envelopes are validated by this parser; S validates its own additional protocol fields fail-closed.
 const canonicalEntries=entries.map(e=>e.raw) as unknown as TranscriptEntry[];
 for(const e of entries){
  if(e.kind==='turn_rewind'){
   const anchor=id(e.payload.anchorUserTurnId);let index=-1;
   for(let i=active.length-1;i>=0;i--)if(active[i][0]?.provenance.turnId===anchor&&active[i][0]?.message.role==='user'){index=i;break}
   if(index<0)fail();if(!['keep_user','replace_user'].includes(string(e.payload.disposition)))fail();
   const removed=active.splice(index);
   for(const group of removed){const copy=structuredClone(group);for(const n of copy)n.provenance.active=false;retired.push(copy)}
   if(e.payload.disposition==='keep_user'){active.push([removed[0][0]]);continue}
   if(!e.turnId||e.turnId!==anchor||!e.revision||e.revision<=(removed[0][0].provenance.revision??0))fail();const p=row(e.payload.replacementUser);if(p.attachments!==undefined&&(!Array.isArray(p.attachments)||p.attachments.length))fail('MEMORY_HISTORY_FORMAT_UNSUPPORTED');
   active.push([makeNode(scope,session,'transcript-v1',incarnation,e.raw,{role:'user',text:string(p.text)},e.seq,e.turnId,e.revision,e.at)]);continue;
  }
  if(['backfill_boundary','interruption','compaction_checkpoint','assistant_settlement'].includes(e.kind))continue;
  let m:ContextMessage;
  if(e.kind==='user'){if(!e.turnId||!e.revision)fail();if(e.payload.attachments!==undefined&&(!Array.isArray(e.payload.attachments)||e.payload.attachments.length))fail('MEMORY_HISTORY_FORMAT_UNSUPPORTED');m={role:'user',text:string(e.payload.text)}}
  else if(e.kind==='assistant')m=message(e.payload,'assistant');
  else if(e.kind==='tool_result'){if(!['success','failure','unknown','not_executed'].includes(e.payload.outcome as string))fail();m=message(row(e.payload.message),'tool');if(m.toolCallId!==e.payload.toolCallId)fail();id(e.payload.assistantEntryId)}
  else fail('MEMORY_HISTORY_FORMAT_UNSUPPORTED');
  const n=makeNode(scope,session,'transcript-v1',incarnation,e.raw,m,e.seq,e.turnId??null,e.revision??null,e.at);
  if(derived(m.text)){separate.push([n]);if(m.role==='user')active.push([]);continue}
  // Use the sole S protocol authority; unknown old S and conflicting/missing markers stay diagnostic.
  const settlement=e.kind==='assistant'?classifySAssistantSettlement(canonicalEntries,e.id):'legacy';
  if(e.kind==='assistant'&&settlement!=='legacy'&&settlement!=='success'){n.raw={...n.raw,readonlyDiagnostic:true};separate.push([n]);diagnostics.push('MEMORY_HISTORY_S_UNSETTLED');continue}
  if(e.kind==='tool_result'){
   if(e.payload.outcome==='unknown'||e.payload.outcome==='not_executed'){n.raw={...n.raw,readonlyDiagnostic:true};diagnostics.push('MEMORY_HISTORY_TOOL_UNCERTAIN')}
   const owner=active.flat().find(v=>v.provenance.originalId===e.payload.assistantEntryId&&v.message.role==='assistant');
   if(!owner||!owner.message.toolCallIds?.includes(m.toolCallId!)){n.raw={...n.raw,readonlyDiagnostic:true};separate.push([n]);diagnostics.push('MEMORY_HISTORY_TOOL_INCOMPLETE');continue}
  }
  if(m.role==='user')active.push([n]);else if(active.at(-1)?.length)active.at(-1)!.push(n);else separate.push([n]);
 }
 return records(scope,session,[...retired,...active,...separate],diagnostics);
}
function chatRecords(scope:ReadonlyHistoryScope,session:ReadonlyHistoryScope['sessions'][number],file:DecodedHistoryInput,diagnostics:string[]):ReadonlyHistoryRecord[]{
 let chat:Record<string,unknown>;try{chat=row(JSON.parse(file.text))}catch{fail()}
 if(chat.schemaVersion!==1||chat.id!==session.sessionId||!['chat','work','code'].includes(string(chat.mode))||!Array.isArray(chat.messages)||chat.messages.length>10000)fail();
 const groups:Node[][]=[],separate:Node[][]=[];
 for(const raw of chat.messages){
  const r=row(raw);if(r.role!=='user'&&r.role!=='model')fail();
  if(r.attachments!==undefined&&(!Array.isArray(r.attachments)||r.attachments.length))fail('MEMORY_HISTORY_FORMAT_UNSUPPORTED');
  const role=r.role==='user'?'user':'assistant',n=makeNode(scope,session,'chat-session-v1',file.incarnation,r,{role,text:string(r.content)},null,role==='user'?id(r.id):null,null,time(r.at));
  if(derived(n.message.text)){separate.push([n]);if(role==='user')groups.push([])}
  else if(role==='user')groups.push([n]);else if(groups.at(-1)?.length)groups.at(-1)!.push(n);else separate.push([n]);
  if(r.modelContext!==undefined){const variant=makeNode(scope,session,'chat-session-v1',file.incarnation,{...r,readonlyDerived:true},{role,text:string(r.modelContext)},null,n.provenance.turnId,null,time(r.at));variant.provenance.field='modelContext';separate.push([variant])}
  if(r.toolExecutions!==undefined)diagnostics.push('MEMORY_HISTORY_DISPLAY_TOOLS_UNVERIFIED');
 }
 return records(scope,session,[...groups,...separate],diagnostics);
}
/** Native file acquisition is deferred. No option, platform or caller can enable a path-based read. */
export async function readFireflyHistory(_scope:ReadonlyHistoryScope,_signal?:AbortSignal):Promise<never>{
 throw new Error('MEMORY_HISTORY_NATIVE_UNAVAILABLE');
}
/** Pure unbound projection of explicit bytes. This is not an I/O bypass or a source capability. */
export function parseFireflyHistoryBytes(scope:ReadonlyHistoryScope,inputs:readonly ReadonlyHistoryBytes[],signal?:AbortSignal):ReadonlyHistoryReadResult {
 const authorized=validateReadonlyHistoryScope(scope);abort(signal);
 if(!Array.isArray(inputs)||inputs.length>32)fail('MEMORY_HISTORY_INPUT_INVALID');
 const documents:ReadonlyHistoryRecord[]=[],diagnostics:string[]=[],selectionHeads:ReadonlyHistorySelectionHead[]=[];
 for(const session of authorized.sessions){
  abort(signal);
  // Partition selection precedes decoding/budgets: foreign bytes are never inspected.
  const selected=inputs.filter(input=>input.providerId===session.providerId&&input.sessionId===session.sessionId);
  if(selected.length>1)fail();
  const input=selected[0];if(!input){diagnostics.push('MEMORY_HISTORY_SOURCE_UNAVAILABLE');continue}
  const incarnation=parseInternalId(input.incarnation),jsonl=decodeBytes(input.transcript,incarnation),snapshot=decodeBytes(input.snapshot,incarnation);
  if(jsonl||snapshot){
   const parsed=transcript(jsonl,snapshot,diagnostics);
   selectionHeads.push({...session,incarnation,maxSeq:parsed.entries.at(-1)?.seq??0,checkpointThroughSeq:parsed.checkpointThroughSeq,completeTail:parsed.completeTail});
   documents.push(...transcriptRecords(authorized,session,parsed.entries,incarnation,diagnostics));continue
  }
  const chat=decodeBytes(input.chat,incarnation);
  if(chat)documents.push(...chatRecords(authorized,session,chat,diagnostics));else diagnostics.push('MEMORY_HISTORY_SOURCE_UNAVAILABLE');
 }
 if(documents.length>4096)fail('MEMORY_HISTORY_INPUT_INVALID');
 abort(signal);return {selectionHeads,documents,coverage:diagnostics.length?'partial':'complete',diagnostics:[...new Set(diagnostics)]};
}
