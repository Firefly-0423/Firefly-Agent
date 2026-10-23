import type {FactTime} from "../../shared/memory-contracts";
import {parseHistoryTimeIntent} from "../memory-history/history-time-intent";
export interface TemporalSource {occurredAt?:number;timeZone?:string}
export type FactTemporal = {kind:"none"}|{kind:"unresolved"}|{kind:"resolved";time:FactTime;clause:{start:number;end:number}};
const MARKER=/\d{4}[-年]\d{1,2}|昨天|昨日|今天|今日|前天|明天|上个?月|上周|上个?星期|本月|这周|以前|曾经|最近|过去|当时|暂时|\b(?:yesterday|today|tomorrow|last|previous|recently|formerly|temporarily|used to|since|until|during|in \d{4})\b/iu;
const UNSAFE=/(?<![\p{L}\p{N}])['‘’]|['‘’](?![\p{L}\p{N}])|["“”「」『』`\n]|(?:^|\s)>|如果|假设|翻译|引用|例如|\b(?:if|suppose|translate|quote|example|pretend)\b/iu;
const RELATIVE=/昨天|昨日|今天|今日|上个?月|上周|上个?星期|\b(?:yesterday|today|(?:last|previous) (?:week|month))\b/giu;
const ABSOLUTE=/\d{4}-\d{2}-\d{2}(?:\s*(?:至|到|to)\s*\d{4}-\d{2}-\d{2})?/giu;

function anchored(source:TemporalSource):source is {occurredAt:number;timeZone:string} {
 if(!Number.isSafeInteger(source.occurredAt)||source.occurredAt!<0||typeof source.timeZone!=="string"||!source.timeZone)return false;
 try{new Intl.DateTimeFormat("en-US",{timeZone:source.timeZone}).format(source.occurredAt);return true}catch{return false}
}
interface Civil {year:number;month:number;day:number}
function civil(text:string):Civil|undefined {
 const [year,month,day]=text.split("-").map(Number),date=new Date(Date.UTC(year,month-1,day));
 if(year<1970||year>9998||date.getUTCFullYear()!==year||date.getUTCMonth()!==month-1||date.getUTCDate()!==day)return;
 return {year,month,day};
}
function midnight(c:Civil,zone:string):number|undefined {
 const target=Date.UTC(c.year,c.month-1,c.day),formatter=new Intl.DateTimeFormat("en-CA",{timeZone:zone,hourCycle:"h23",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit"});
 let guess=target;
 for(let i=0;i<5;i++){
  const parts=formatter.formatToParts(guess),v=(type:string)=>Number(parts.find(p=>p.type===type)!.value);
  const projected=Date.UTC(v("year"),v("month")-1,v("day"),v("hour"),v("minute"),v("second"));
  if(projected===target)return guess;
  guess+=target-projected;
 }
 // A skipped local midnight is ambiguous; never silently shift it to another date.
 return;
}
function resolve(phrase:string,source:TemporalSource):FactTime|undefined {
 if(!anchored(source))return;
 const dates=phrase.split(/\s*(?:至|到|to)\s*/iu);
 let from:number|undefined,to:number|undefined;
 if(/^\d{4}-/.test(phrase)){
  const first=civil(dates[0]),last=civil(dates[1]??dates[0]);if(!first||!last)return;
  const next=new Date(Date.UTC(last.year,last.month-1,last.day+1));
  from=midnight(first,source.timeZone);to=midnight({year:next.getUTCFullYear(),month:next.getUTCMonth()+1,day:next.getUTCDate()},source.timeZone);
 }else{
  const result=parseHistoryTimeIntent(phrase,source.occurredAt,source.timeZone);
  if(result?.query.kind!=="range")return;
  from=result.query.from;to=result.query.to+1;
 }
 if(from===undefined||to===undefined||!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||from<0||from>=to)return;
 return {validFrom:from,validTo:to,referenceTime:source.occurredAt};
}
function phraseIn(text:string):{phrase:string;start:number;end:number}|undefined {
 const matches=[...text.matchAll(new RegExp(ABSOLUTE)),...text.matchAll(new RegExp(RELATIVE))];
 if(matches.length!==1)return;
 const match=matches[0],start=match.index!,end=start+match[0].length;
 // Reject an additional unsupported temporal qualifier rather than dropping it.
 if(MARKER.test(text.slice(0,start)+text.slice(end)))return;
 return {phrase:match[0],start,end};
}
/** Only an explicit leading calendar clause is eligible for factual validation.
 * This does not validate a fact: the remaining clause must pass the natural protocol. */
export function parseFactTemporal(text:string,source:TemporalSource):FactTemporal {
 if(!MARKER.test(text))return {kind:"none"};
 const unresolved:FactTemporal={kind:"unresolved"};
 if(UNSAFE.test(text))return unresolved;
 const phrase=phraseIn(text);if(!phrase||!/^\s*(?:from\s+|在)?$/iu.test(text.slice(0,phrase.start)))return unresolved;
 const separator=/^\s*[,，:：]\s*/u.exec(text.slice(phrase.end));if(!separator)return unresolved;
 const start=phrase.end+separator[0].length,time=resolve(phrase.phrase,source);
 if(!time||start===text.length)return unresolved;
 return {kind:"resolved",time,clause:{start,end:text.length}};
}
/** The caller must bind this result to the authenticated current question source. */
export function hasFactTimeQuery(text:string):boolean {return !UNSAFE.test(text)&&MARKER.test(text)&&/[?？]|什么|哪|如何|\b(?:what|which|how|when)\b/iu.test(text)}
export function parseFactTimeQuery(text:string,source:TemporalSource):FactTime|undefined {
 if(!hasFactTimeQuery(text))return;
 const phrase=phraseIn(text);return phrase?resolve(phrase.phrase,source):undefined;
}
