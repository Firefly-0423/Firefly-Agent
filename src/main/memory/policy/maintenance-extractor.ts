import {extractPreference,type Attribute,type Extraction} from "./extractor";

export type ContextKey="default"|"work"|"personal";
export interface MaintenanceClaim {
 attribute:Attribute;value:string;context:ContextKey;cardinality:"one"|"many";
 operation:"assert"|"change"|"deny";previousValue?:string;
}
export type MaintenanceExtraction=Extract<Extraction,{kind:"rejected"}>|{kind:"candidate";attribute:Attribute;value:string|null;reason:string;text:string}|{kind:"claims";text:string;claims:MaintenanceClaim[]};
export const MAINTENANCE_VERSION="main-maintenance-v1";
/** Full-source conservative grammar, not a model evaluation or a trust decision. */
export function extractMaintenance(text:string):MaintenanceExtraction {
 const base=extractPreference(text);
 if(base.kind==="rejected")return base;
 const candidate=(reason:string):MaintenanceExtraction=>({kind:"candidate",attribute:"unclassified",value:null,reason,text});
 const clean=text.normalize("NFKC").trim().replace(/[。.!！]$/u,"").trim();
 if(base.kind==="candidate"&&base.reason==="sensitive")return {...base,kind:"candidate"};
 if(/[\r\n?？;；:："“”‘’]/u.test(clean)||/^(?:If |Suppose |Maybe |Alice |They |He |She |如果|假如|可能|他|她)/iu.test(clean))return candidate("ambiguous");
 if(/^(?:From |Starting |从|明天|下周)|(?:tomorrow|next week|will use)/iu.test(clean))return candidate("future-effective");
 const claim=(attribute:Attribute,value:string,context:ContextKey="default",cardinality:"one"|"many"="one",operation:MaintenanceClaim["operation"]="assert",previousValue?:string):MaintenanceClaim=>({attribute,value,context,cardinality,operation,...(previousValue?{previousValue}: {})});
 const claims=(items:MaintenanceClaim[]):MaintenanceExtraction=>({kind:"claims",text,claims:items});
 const value=(raw:string)=>raw.trim().toLowerCase();
 const attr=(raw:string):Attribute=>/^(?:python|rust|typescript|javascript|go)$/iu.test(raw)?"programming-usage":"shell";
 const tools="(Python|Rust|TypeScript|JavaScript|Go|bash|cmd|PowerShell)";
 const paired=new RegExp("^我工作用\\s*"+tools+"[，,]\\s*个人用\\s*"+tools+"$","iu").exec(clean);
 if(paired)return claims([claim(attr(paired[1]),value(paired[1]),"work",attr(paired[1])==="shell"?"one":"many"),claim(attr(paired[2]),value(paired[2]),"personal",attr(paired[2])==="shell"?"one":"many")]);
 const abilities=/^(?:I know |我会\s*)(Python|Rust|TypeScript|JavaScript|Go)(?:(?: and | 和 |和)(Python|Rust|TypeScript|JavaScript|Go))?$/iu.exec(clean);
 if(abilities)return claims([...new Set(abilities.slice(1).filter(Boolean).map(value))].map(v=>claim("programming-ability",v,"default","many")));
 const contextual=new RegExp("^I (now )?use "+tools+" (for work|personally)$","iu").exec(clean);
 const zhContext=new RegExp("^我(工作|个人)(现在改用|用)\\s*"+tools+"$","iu").exec(clean);
 if(contextual){const attribute=attr(contextual[2]);return claims([claim(attribute,value(contextual[2]),contextual[3].toLowerCase()==="for work"?"work":"personal",attribute==="shell"?"one":"many",contextual[1]?"change":"assert")]);}
 if(zhContext){const attribute=attr(zhContext[3]);return claims([claim(attribute,value(zhContext[3]),zhContext[1]==="工作"?"work":"personal",attribute==="shell"?"one":"many",zhContext[2]==="现在改用"?"change":"assert")]);}
 const address=/^(?:Please now call me |现在请叫我\s*)(.+)$/iu.exec(clean);
 if(address){const parsed=extractPreference("Call me "+address[1]);if(parsed.kind==="direct")return claims([claim(parsed.attribute,parsed.value!,"default","one","change")]);return candidate("ambiguous");}
 const change=/^(?:I now (?:prefer|use) |我现在(?:默认)?(?:改用|偏好)\s*)(.+?)(?: instead of (.+))?$/iu.exec(clean);
 if(change){
  const parsed=extractPreference("I prefer "+change[1]),previous=change[2]?extractPreference("I prefer "+change[2]):null;
  if(parsed.kind==="direct"&&(!previous||(previous.kind==="direct"&&previous.attribute===parsed.attribute)))return claims([claim(parsed.attribute,parsed.value!,"default","one","change",previous?.kind==="direct"?previous.value!:undefined)]);
  return candidate("ambiguous");
 }
 const denied=/^(?:I no longer use |我不再用\s*)(bash|cmd|PowerShell)$/iu.exec(clean);
 if(denied)return claims([claim("shell",value(denied[1]),"default","one","deny")]);
 if(base.kind==="direct")return claims([claim(base.attribute,base.value!)]);
 return {...base,kind:"candidate"};
}
