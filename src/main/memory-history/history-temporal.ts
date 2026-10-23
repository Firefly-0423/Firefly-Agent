import {objectFields} from '../memory-core/command-validation';
export type HistoryTemporalQuery={kind:'latest'}|{kind:'range';from:number;to:number};
export interface HistoryTimeSpan {start:number;end:number}
export interface HistoryTemporalResult {kind:HistoryTemporalQuery['kind'];status:'applied'|'partial'|'unavailable';unknownDocuments:number}
const validTime=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
/** Explicit Main caller intent only. Query text or quoted history cannot mint it. */
export function parseHistoryTemporal(value:unknown):HistoryTemporalQuery|undefined {
 if(value===undefined)return undefined;
 try{
 const row=objectFields(value,['kind'],['from','to']);
 if(row.kind==='latest'){objectFields(row,['kind']);return {kind:'latest'}}
 if(row.kind==='range'){objectFields(row,['kind','from','to']);if(validTime(row.from)&&validTime(row.to)&&row.from<=row.to)return {kind:'range',from:row.from,to:row.to}}
 throw new Error('MEMORY_HISTORY_INPUT_INVALID');
 }catch{throw new Error('MEMORY_HISTORY_INPUT_INVALID')}
}
/** Missing time in any message makes the complete turn's temporal ordering unproved. */
export function historyTimeSpan(messages:ReadonlyArray<{occurredAt:number|null}>):HistoryTimeSpan|null {
 if(!messages.length||messages.some(m=>m.occurredAt===null))return null;
 const times=messages.map(m=>m.occurredAt!);if(times.some(t=>!validTime(t)))throw new Error('MEMORY_HISTORY_INPUT_INVALID');
 return {start:Math.min(...times),end:Math.max(...times)};
}
export function validateHistoryTimeSpan(span:HistoryTimeSpan|null|undefined):void {
 if(span===null||span===undefined)return;
 const row=objectFields(span,['start','end']);if(!validTime(row.start)||!validTime(row.end)||row.start>row.end)throw new Error('MEMORY_HISTORY_INPUT_INVALID');
}
