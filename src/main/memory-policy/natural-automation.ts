import {objectFields} from "../memory-core/command-validation";
import {typedUserFact,validateNaturalResponse,type NaturalProposal} from "./natural-protocol";

export const NATURAL_JOB_LIMITS=Object.freeze({requestsPerDay:20,reservedUnitsPerDay:100_000,outputTokens:800,requestBytes:16_384,resultBytes:32_768,userChars:4000,proposals:5,nonterminalJobs:100,rowsPerActor:1000,retentionMs:7*24*60*60*1000,networkRetries:0});

/** Eligibility is independent of consent; only the writer may combine the two.
 * Deliberately recognize whole, durable self-statements rather than model confidence. */
export function automaticNaturalProposal(text:string,proposals:readonly NaturalProposal[]):NaturalProposal|null {
 try{
  if(typeof text!=="string"||text.length>NATURAL_JOB_LIMITS.userChars||!Array.isArray(proposals)||proposals.length!==1)return null;
  const p=objectFields(proposals[0],["attribute","value","polarity","quote","span"]),span=objectFields(p.span,["start","end"]);
  if(!["language","response-style"].includes(p.attribute as string)||p.polarity!=="positive"||typeof p.quote!=="string"||p.quote.trim()!==text.trim())return null;
  if(span.start!==text.indexOf(p.quote)||span.end!==(span.start as number)+p.quote.length)return null;
  const s=text.normalize("NFKC").trim().toLowerCase();
  let category:NaturalProposal["attribute"]|undefined,value:string|undefined,match:RegExpExecArray|null;
  if((match=/^我(?:一直|长期)(?:偏好)?(?:用)?(中文|英语|英文)交流[。.!]?$/u.exec(s))){category="language";value=match[1]==="中文"?"zh":"en"}
  else if((match=/^i always prefer (english|chinese) for our chats[.!]?$/u.exec(s))){category="language";value=match[1]==="chinese"?"zh":"en"}
  else if((match=/^我(?:一直|长期)偏好(简洁|详细)(?:的)?回复[。.!]?$/u.exec(s))){category="response-style";value=match[1]==="简洁"?"concise":"detailed"}
  else if((match=/^i always prefer (concise|detailed) replies[.!]?$/u.exec(s))){category="response-style";value=match[1]}
  if(!category||!value)return null;
  const proposal=proposals[0],typed=typedUserFact("program-eligibility",proposal);
  if(typed.attribute!==category||typed.value!==value)return null;
  const raw=JSON.stringify({facts:[{subject:"user",attribute:category,value:proposal.value,polarity:"positive",status:"asserted",quote:proposal.quote,reason:"Explicit durable self statement"}]});
  const validated=validateNaturalResponse(raw,text,"program-eligibility");
  if(validated.length!==1||validated[0].span.start!==span.start||validated[0].span.end!==span.end)return null;
  return {attribute:category,value,polarity:"positive",quote:proposal.quote,span:{start:span.start as number,end:span.end as number}};
 }catch{return null}
}
