import {historyMessageChars} from './history-message';
import {canonicalJson} from '../memory-core/repository-types';
import {rankHistory} from './history-ranking';
import {toWindows} from './history-windows';
import {historyTimeSpan,type HistoryTemporalQuery} from './history-temporal';
import {validateReadonlyHistoryScope} from './firefly-history-reader';
import {DEFAULT_HISTORY_SETTINGS,type ReadonlyHistoryScope,type ReadonlyHistoryReadResult,type HistorySettings} from './history-contracts';
/** Bounded read-only lexical nominations. Never a Worker truth/support/evidence capability. */
export function createHistoryIndexBuilder(scope:ReadonlyHistoryScope,read:ReadonlyHistoryReadResult,settings:Partial<HistorySettings>={}){
 const partition=validateReadonlyHistoryScope(scope),config={...DEFAULT_HISTORY_SETTINGS,...settings};
 for(const field of ['limit','candidateLimit','rrfK','maxIndexDocuments','maxIndexBytes','maxTotalChars','maxExcerptChars'] as const)if(!Number.isSafeInteger(config[field])||config[field]<1)throw new Error('MEMORY_HISTORY_INPUT_INVALID');
 if(config.limit>8||config.candidateLimit>50||config.maxIndexDocuments>4096||config.maxIndexBytes>32*1024*1024||config.maxExcerptChars>65536||config.maxTotalChars>65536||!Number.isFinite(config.mmrLambda)||config.mmrLambda<0||config.mmrLambda>1)throw new Error('MEMORY_HISTORY_INPUT_INVALID');
 const documents=structuredClone(read.documents.filter(d=>d.provenance.length===d.document.messages.length&&d.provenance.every(p=>partition.sessions.some(s=>s.providerId===p.providerId&&s.sessionId===p.sessionId)&&p.active)&&d.classification==='raw-history'));
 const exhausted=documents.length>config.maxIndexDocuments||Buffer.byteLength(canonicalJson(documents))>config.maxIndexBytes;
 return {query(query:string,input:{signal?:AbortSignal;temporal?:HistoryTemporalQuery}={}){
  if(input.signal?.aborted)throw new Error('MEMORY_HISTORY_CANCELLED');
  if(typeof query!=='string'||query.length>4096)throw new Error('MEMORY_HISTORY_INPUT_INVALID');
  if(exhausted)return {status:'index-budget-exhausted' as const,hits:[],coverage:read.coverage,diagnostics:[...read.diagnostics]};
  const ranked=rankHistory(documents.map(d=>({id:d.document.id,text:d.document.messages.map(m=>m.text).join('\n'),...(()=>{const units=toWindows(d.document.messages,config.windowTurns);return units?{units}:{}})(),timeSpan:historyTimeSpan(d.document.messages)})),query,{limit:config.limit,candidateLimit:config.candidateLimit,rrfK:config.rrfK,mmrLambda:config.mmrLambda,...input});
  let chars=0,status:'ok'|'excerpt-budget-exhausted'='ok';
  const hits=ranked.items.flatMap(hit=>{const record=documents.find(d=>d.document.id===hit.id)!,size=record.document.messages.reduce((n,m)=>n+historyMessageChars(m),0);
   if(size>config.maxExcerptChars||chars+size>config.maxTotalChars){status='excerpt-budget-exhausted';return []}chars+=size;return [{record:structuredClone(record),score:hit.score}]});
  return {status,hits,coverage:read.coverage,diagnostics:[...read.diagnostics],...(ranked.temporal?{temporal:ranked.temporal}:{}),tokenizerVersion:ranked.tokenizerVersion,rankingVersion:ranked.version};
 }};
}
