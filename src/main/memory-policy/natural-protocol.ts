import {createHash} from "node:crypto";
import type {TypedUserFact,FactTime} from "../../shared/memory-contracts";
import {parseFactTemporal,type TemporalSource} from "./fact-temporal";
import {canonicalJson} from "../memory-core/repository-types";
import {assertContextSecretFree} from "../memory-context/source-secret-screen";
import {validateShadowResponse} from "../memory-shadow/shadow-validate";
import {SHADOW_LIMITS,type ShadowAttribute} from "../memory-shadow/shadow-contracts";
import {extractPreference,type Attribute} from "./extractor";
import {policySubjectKey} from "./fact-identity";

export const NATURAL_VERSION="user-fact-v2";
export interface NaturalProposal {attribute:TypedUserFact["attribute"];value:string;polarity:"positive"|"negative";quote:string;span:{start:number;end:number};time?:FactTime}
export const factDigest=(value:unknown)=>createHash("sha256").update(canonicalJson(value)).digest("hex");
const attributes:Record<ShadowAttribute,TypedUserFact["attribute"]>={"form-of-address":"address",language:"language","response-style":"response-style",tool:"tool",preference:"preference"};
const normalize=(s:string)=>s.normalize("NFKC").trim().toLowerCase();
const NEGATIVE=/不|没(?:有)?|未(?:曾)?|讨厌|\b(?:not|never|dislike|hate|without|avoid)\b|\bno longer\b|\bstopp?ed (?:using|liking)\b|\b(?:don|doesn|didn|isn|wasn|aren)['’]t\b/i;
const AMBIGUOUS_NEGATIVE=/\b(?:do\s+not|don['’]t|never|no\s+longer)\s+(?:dislike|hate|avoid)\b/i;
// Quotation boundaries exclude in-word apostrophes such as don't. Wishes and questions
// without a question mark still are not evidence of an existing durable preference.
const NON_FACT=/["“”‘「」『』`\n]|(?:^|\s)['’]|['’](?:$|\s)|(?:^|\s)>|如果|假如|假设|比如|例如|示例|引用|翻译|他说|她说|可能|也许|是否|这句话|这段话|想知道|想问|请问|不得不|不能不|(?:没|未|不)(?:有)?(?:说过|说|表示|确认)|[?？]|\b(?:if|suppose|hypothetical|example|quote|pretend|translate|maybe|wish|wonder)\b|\b(?:never said|did not say|didn't say|not saying|the sentence|the phrase|can I|could I|should I|do I|not only)\b/i;
const MULTI_CLAUSE=/[,，;；\n]|但是|不过|然而|\b(?:but|however|although)\b/i;
const QUALIFIED=/工作|职场|项目|个人时|在家时|\bwhen\b|\bat work\b|\bfor work\b|\bin this project\b/i;
const INSTRUCTION=/忽略.*(?:规则|指令)|覆盖.*(?:规则|指令)|系统提示|执行命令|\b(?:ignore|override)\b.*\b(?:instructions?|rules?|system)\b|\b(?:system prompt|run_command|execute command)\b/i;
const aliases:Record<string,string[]>={zh:["中文","chinese","汉语"],en:["英文","英语","english"],mixed:["中英混合","bilingual"],concise:["简洁","简短","短一点","少一点","concise","brief","short"],detailed:["详细","展开","detailed"]};

// A self pronoun somewhere in the quote does not make another person's object ours.
// Keep this conservative: ambiguous paraphrases stay outside persistent candidates.
const SELF_PREDICATES:Record<ShadowAttribute,RegExp[]>={
 "form-of-address":[
  /^(?:please\s+)?(?:call me|my (?:name|nickname) is|i go by)\s+(.+)$/iu,
  /^(?:(?:以后|请|就|还是)\s*)*(?:叫我|称呼我)\s*(.+)$/u,
  /^我的(?:称呼|昵称|名字)(?:是|叫)\s*(.+)$/u,
  /^(.+?)\s*是我(?:习惯|一直|通常|平时|默认|喜欢)*(?:用的|的)?(?:称呼|昵称)(?:[，,。.!！].*)?$/u,
 ],
 language:[
  /^i\s+(?:(?:always|usually|normally|personally)\s+)*(?:(?:do not|don't|don’t|never)\s+)?(?:prefer|use|speak)\s+(.+)$/iu,
  /^我(?:一直|长期|通常|平时|默认|更|习惯)*(?:用|使用|说|喜欢(?:用)?|偏好(?:用)?)\s*(.+)$/u,
  /^以后(?:都)?(?:请)?(?:用|使用)\s*(.+)$/u,
 ],
 "response-style":[
  /^i\s+(?:(?:always|usually|normally|personally)\s+)*(?:(?:do not|don't|don’t|never)\s+)?(?:prefer|like|want)\s+(.+)$/iu,
  /^(?:我(?:一直|通常|更|现在)*(?:喜欢|希望|偏好)|以后(?:都)?(?:请)?)(?:回答|回复)?\s*(.+)$/u,
 ],
 tool:[
  /^i\s+(?:(?:always|usually|often|normally|regularly|personally)\s+)*(?:(?:do not|don't|don’t|never|no longer)\s+)?use\s+(.+)$/iu,
  /^my\s+(?:editor|ide|shell|terminal|browser|tool)\s+is\s+(.+)$/iu,
  /^我(?:一直|平时|通常|经常|习惯|始终|默认|现在|更常|常|不再|从不|没有|没|不)*(?:使用|用|改用)\s*(.+)$/u,
  /^我的(?:编辑器|工具|终端|浏览器)(?:是|用)\s*(.+)$/u,
 ],
 preference:[
  /^i\s+(?:(?:always|usually|normally|personally)\s+)*(?:(?:do not|don't|don’t|never)\s+)?(?:like|love|prefer|dislike|hate)\s+(.+)$/iu,
  /^my\s+favou?rite(?:\s+(?:food|drink|theme|color|colour))?\s+is\s+(.+)$/iu,
  /^我(?:一直|平时|通常|始终|更|不再|从不|没有|没|不)*(?:喜欢|爱|偏好|讨厌)\s*(.+)$/u,
 ],
};

function hasSelfPredicate(attribute:ShadowAttribute,clauseText:string,value:string):boolean {
 clauseText=clauseText.replace(/^(?:(?:但是|不过|然而)\s*|(?:but|however)\s+)/iu,"");
 const values=[value,...(aliases[value]??[])];
 return SELF_PREDICATES[attribute].some(pattern=>{
  let object=pattern.exec(clauseText)?.[1]?.trim();if(!object)return false;
  if(attribute==="preference")object=object.replace(/^(?:(?:drinking|eating|using|wearing)\s+|喝|吃|使用|用)/u,"");
  object=object.replace(/^(?:the|an?)\s+/u,"");
  return values.some(candidate=>object.startsWith(candidate)&&!(/[a-z0-9_]$/iu.test(candidate)&&/[a-z0-9_]/iu.test(object[candidate.length]??"")));
 });
}

function sentence(text:string,start:number,end:number):string {
 const boundary=/[。！？!?;；\n]/;let from=start,to=end;
 while(from>0&&!boundary.test(text[from-1]))from--;
 while(to<text.length&&!boundary.test(text[to]))to++;
 return text.slice(from,to);
}
function clause(text:string,start:number,end:number):string {
 const boundary=/[。！？!?;；,，\n]/;let from=start,to=end;
 while(from>0&&!boundary.test(text[from-1]))from--;
 while(to<text.length&&!boundary.test(text[to]))to++;
 return text.slice(from,to);
}
/** Reuses every shadow schema/sensitivity check, then enforces durable self-evidence. */
export function validateNaturalResponse(raw:unknown,text:string,messageId:string,source:TemporalSource={}):NaturalProposal[] {
 if(text.length>SHADOW_LIMITS.maxUserChars)return [];
 if(extractPreference(text).kind==="rejected")return [];
 try{assertContextSecretFree(text)}catch{return []}
 const temporal=parseFactTemporal(text,source);
 if(temporal.kind==="unresolved")return [];
 if(temporal.kind==="resolved"){
  // Only a host-recognized leading date clause is removed. Preserve every model
  // field so the original strict shadow schema still rejects extra authority.
  if(typeof raw!=="string"||raw.length>20000)return [];
  let parsed:unknown;try{parsed=JSON.parse(raw.replace(/^\s*```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/i,"$1"))}catch{return []}
  if(!parsed||typeof parsed!=="object"||Array.isArray(parsed)||Object.keys(parsed).length!==1||!Array.isArray((parsed as {facts?:unknown}).facts))return [];
  const clauseText=text.slice(temporal.clause.start,temporal.clause.end),result:NaturalProposal[]=[];
  for(const item of (parsed as {facts:unknown[]}).facts){
   if(!item||typeof item!=="object"||Array.isArray(item))continue;
   const quote=(item as {quote?:unknown}).quote;if(typeof quote!=="string"||quote.trim().length<SHADOW_LIMITS.minQuoteChars||quote.length>SHADOW_LIMITS.maxQuoteChars)continue;
   const start=text.indexOf(quote),end=start+quote.length;
   if(start<0||start!==text.lastIndexOf(quote)||end<=temporal.clause.start)continue;
   if(start<temporal.clause.start&&start!==0)continue;
   const clauseQuote=text.slice(Math.max(start,temporal.clause.start),end);
   const checked=validateNaturalResponse(JSON.stringify({facts:[{...item,quote:clauseQuote}]}),clauseText,messageId);
   if(checked.length===1)result.push({...checked[0],quote,span:{start,end},time:temporal.time});
  }
  // Retain the same per-response duplicate/limit rules as the shadow protocol.
  const seen=new Set<string>();return result.filter(p=>{const key=canonicalJson([p.attribute,p.value.toLowerCase(),p.polarity]);if(seen.has(key))return false;seen.add(key);return true}).slice(0,SHADOW_LIMITS.maxCandidates);
 }
 return validateShadowResponse(raw,{user:{id:messageId,text}}).candidates.flatMap(c=>{
  // Match source spans in the original text; normalization can change their length.
  const start=text.indexOf(c.evidence.quote),end=start+c.evidence.quote.length,s=normalize(sentence(text,start,end)),quote=normalize(c.evidence.quote);
  if(start!==text.lastIndexOf(c.evidence.quote)||c.status!=="asserted"||NON_FACT.test(s)||AMBIGUOUS_NEGATIVE.test(s)||QUALIFIED.test(s)||INSTRUCTION.test(s)||INSTRUCTION.test(normalize(c.value)))return [];
  // A requested one-off operation, a quote, or the assistant's guess cannot become self-evidence.
  if(!/我|以后|一直|通常|始终|\b(?:I|my|always)\b|\bcall me\b/i.test(quote)||(MULTI_CLAUSE.test(quote)&&NEGATIVE.test(quote)))return [];
  // A negation in a different clause cannot authorize this assertion. Conversely a
  // model may not trim an enclosing negation out of its evidence span.
  if(NEGATIVE.test(quote)!==(c.polarity==="negative")||NEGATIVE.test(normalize(clause(text,start,end)))!==NEGATIVE.test(quote))return [];
  const value=normalize(c.value),support=quote;
  if(!support.includes(value)&&!(aliases[value]?.some(alias=>support.includes(alias))))return [];
  if(!hasSelfPredicate(c.attribute,normalize(clause(text,start,end)),value))return [];
  try{for(const part of [c.value,c.reason,c.evidence.quote])assertContextSecretFree(part)}catch{return []}
  return [{attribute:attributes[c.attribute],value:c.value.trim(),polarity:c.polarity,quote:c.evidence.quote,span:{start,end}}];
 });
}
export function typedUserFact(actor:string,proposal:Pick<NaturalProposal,"attribute"|"value"|"polarity">):TypedUserFact {
 const attribute=proposal.attribute;let value=proposal.value.trim(),legacyAttribute:Attribute=attribute,cardinality:"one"|"many"=["tool","preference"].includes(attribute)?"many":"one";
 if(attribute==="language"||attribute==="response-style"){
  const groups=attribute==="language"?["zh","en","mixed"]:["concise","detailed"];
  value=groups.find(key=>key===normalize(value)||aliases[key].some(alias=>normalize(value)===alias))??value;
 }
 if(attribute==="tool"&&["powershell","cmd","bash"].includes(normalize(value))){legacyAttribute="shell";cardinality="one";value=normalize(value)}
 // New many-valued categories use one canonical identity for equality, correction
 // and suppression. Keep display spelling and every legacy single-valued slot.
 const canonicalValue=cardinality==="many"?normalize(value).replace(/\s+/g," "):value;
 const entityKey="entity-v2-"+factDigest({actor}),slotKey=policySubjectKey(actor,legacyAttribute,"default",cardinality,canonicalValue);
 return {version:2,attribute,value,canonicalValue,polarity:proposal.polarity,cardinality,entityKey,slotKey,assertionKey:"assertion-v2-"+factDigest({slotKey,value:canonicalValue,polarity:proposal.polarity}),legacyAttribute};
}
export function assertTypedUserFact(actor:string,value:TypedUserFact):void {
 if(!value||value.version!==2||!["address","language","response-style","tool","preference"].includes(value.attribute)||typeof value.value!=="string"||!value.value.trim()||value.value.length>80||!["positive","negative"].includes(value.polarity)||canonicalJson(value)!==canonicalJson(typedUserFact(actor,value)))throw Error("MEMORY_DATA_INVALID");
}
const assertionLabels={address:"用户称呼",language:"用户回复语言","response-style":"用户回复风格",tool:"用户使用工具",preference:"用户喜好"} as const;
export function naturalAssertion(fact:TypedUserFact):string {
 return `${assertionLabels[fact.attribute]}${fact.polarity==="negative"?"（否定）":""}：${fact.value}`;
}
/** A selected manual edit is an explicit user operation, not background extraction.
 * It accepts a short replacement value or a simple self-statement for that SAME category.
 * No model/queue participates in correction or revision. */
export function parseNaturalEdit(text:string,attribute:TypedUserFact["attribute"]):NaturalProposal {
 if(typeof text!=="string"||text.length>200||extractPreference(text).kind==="rejected")throw Error("MEMORY_POLICY_UNRESOLVED");
 const semantic=normalize(text);
 if(NON_FACT.test(semantic)||AMBIGUOUS_NEGATIVE.test(semantic)||INSTRUCTION.test(semantic))throw Error("MEMORY_POLICY_UNRESOLVED");
 let value=text.normalize("NFKC").trim().replace(/[。.!！]$/u,"");
 // Settings prefill the generated assertion. Its label and polarity are metadata,
 // not part of the edited object, and must belong to the selected category.
 const labeled=/^(用户称呼|用户回复语言|用户回复风格|用户使用工具|用户喜好)(\(否定\))?:\s*(.*)$/u.exec(value);
 if(labeled&&labeled[1]!==assertionLabels[attribute])throw Error("MEMORY_POLICY_UNRESOLVED");
 const polarity=labeled?(labeled[2]?"negative":"positive"):(NEGATIVE.test(semantic)?"negative":"positive");
 const prefixes:Record<TypedUserFact["attribute"],RegExp>={
  address:/^(?:(?:以后|请|就|还是)\s*)*(?:叫我|称呼我|call me\s+)/iu,
  language:/^(?:我(?:现在|以后|更)?(?:喜欢|偏好|默认用)|以后(?:都)?(?:请)?用|I (?:(?:do not|don['’]t|never)\s+)?(?:prefer|use)\s+)/iu,
  "response-style":/^(?:我(?:现在|更)?(?:喜欢|希望|偏好)|以后(?:都)?(?:请)?|I (?:(?:do not|don['’]t|never)\s+)?(?:prefer|like|want)\s+)/iu,
  tool:/^(?:我(?:现在|平时|通常|以后)?(?:更常|不再|从不)?(?:不使用|不用|使用|改用|用)|I (?:(?:do not|don['’]t|never)\s+)?(?:use|prefer)\s+)/iu,
  preference:/^(?:我(?:现在|平时|通常)?(?:更|不再)?(?:不喜欢|不爱|喜欢|偏好|爱)|I (?:(?:do not|don['’]t|never)\s+)?(?:dislike|like|prefer)\s+)/iu,
 };
 value=labeled?labeled[3].trim():value.replace(prefixes[attribute],"").trim();
 if(attribute==="language")value=value.replace(/(?:和我交流|回答|回复)$/u,"").trim();
 if(!value||value.length>80)throw Error("MEMORY_POLICY_UNRESOLVED");
 const shadowAttribute=Object.entries(attributes).find(([,a])=>a===attribute)![0];
 const raw=JSON.stringify({facts:[{subject:"user",attribute:shadowAttribute,value,polarity,status:"asserted",quote:text,reason:"explicit selected user edit"}]});
 if(validateShadowResponse(raw,{user:{id:"edit",text}}).candidates.length!==1)throw Error("MEMORY_POLICY_UNRESOLVED");
 try{assertContextSecretFree(value)}catch{throw Error("MEMORY_POLICY_SECRET")}
 return {attribute,value,polarity,quote:text,span:{start:0,end:text.length}};
}
