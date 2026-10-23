// 校验模型返回的影子抽取结果。模型输出不可信：结构不对、证据不在用户原话里、敏感、说的是别人，一律丢弃。
import {SHADOW_ATTRIBUTES,SHADOW_DROP_REASONS,SHADOW_LIMITS,type ShadowAttribute,type ShadowCandidate,type ShadowDropReason,type ShadowTurn,type ShadowValidation} from './shadow-contracts';

const MAX_RESPONSE_CHARS=20000;
const FIELDS=['subject','attribute','value','polarity','status','quote','reason'];

/** 第一批不收的类别。宁可多丢：这里命中就不进影子记录。 */
const SENSITIVE=new RegExp([
 '健康','疾病','生病','病史','病情','过敏','药','症','怀孕','体重','身高','血压','血糖','医院','医生','诊断','治疗','抑郁','焦虑','心理','手术','残疾',
 '糖尿病','胰岛素','肿瘤','癌','哮喘','癫痫','艾滋',
 '银行','账户','账号','卡号','工资','收入','存款','贷款','负债','欠款','身份证','护照','驾照','社保','住址','家庭地址','门牌','小区','电话','手机号','邮箱',
 '宗教','信仰','政治','性取向','同性','种族','民族',
 'health','medical','medicine','medication','allerg','disease','illness','diagnos','symptom','pregnan','therapy','depress','anxiety','surgery','disab',
 'diabet','cancer','tumou?r','leuk[ae]m','epilep','asthma','chemotherap','antidepress','\\b(?:hiv|aids|insulin|metformin|sertraline|fluoxetine|steroids?)\\b',
 'bank','account number','card number','salary','income','debt','loan','passport','social security','\\bssn\\b','driver\'?s licen','home address','phone number','e-?mail',
 'religio','politic','sexual','ethnic','\\brace\\b',
].join('|'),'i');
/**
 * 敏感值的形状：只靠类别词拦不住"123 Main Street"、邮箱、电话、证件号这类原始值。
 * 邮箱；7 位以上的数字串（允许空格、横线分隔）；中英文门牌地址与住址表述。
 */
const SENSITIVE_SHAPE=new RegExp([
 String.raw`[\w.+-]+@[\w-]+\.[\w.-]+`,
 String.raw`(?:\d[\s-]?){7,}`,
 String.raw`\b\d+[a-z]?\s+(?:[a-z]+\s+){0,3}(?:street|st|road|rd|avenue|ave|lane|ln|boulevard|blvd|drive|dr|court|ct|way|place|pl)\b`,
 String.raw`\b(?:i live|i'm living|my address)\b`,
 String.raw`[\d一二三四五六七八九十百]+\s*(?:号楼|号院|号|弄|栋|幢|单元|室)`,
 String.raw`(?:路|街|巷|道|大道)\s*\d+`,
 '我住在|我家在|住址是',
].join('|'),'i');
/**
 * 说的是别人：不信模型的 subject 标注，独立检查引用所在的整句。宁可多丢。
 * 中文排除"其他""吉他"里的"他"。
 */
const OTHER_PERSON=/朋友|同事|同学|室友|老板|领导|上司|客户|妈|爸|父亲|母亲|爷爷|奶奶|外公|外婆|老婆|老公|妻子|丈夫|男朋友|女朋友|对象|伴侣|孩子|儿子|女儿|哥哥|姐姐|弟弟|妹妹|别人|他人|(?<![其吉])他|她|\bmy\s+(?:friends?|wife|husband|partner|boyfriend|girlfriend|mom|mother|dad|father|son|daughter|kids?|child|children|brother|sister|boss|colleague|co-?worker|roommate|manager|client)\b|\b(?:he|she|his|her|him|they|their|them)\b/i;
const TEMPORARY=/临时|暂时|今天|今晚|明天|这次|本次|这周|本周|这会儿|for now|today|tonight|tomorrow|this time|this week|right now/i;
/** 用户整句只是附和，不能据此确定任何事实。 */
const AFFIRMATION=/^(?:是的?|对的?|对呀|嗯+|恩+|好的?|好呀|行|可以|没错|当然|yes|yeah|yep|yup|ok(?:ay)?|sure|right|correct|exactly)[\s。.!！~～,，]*$/i;

const isRecord=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const short=(v:unknown,max:number,min=1):v is string=>typeof v==='string'&&v.trim().length>=min&&v.length<=max;
/** 引用所在的整句（按句末标点和换行切分）。时间限定和"说的是谁"要看整句，不能只看模型挑出的那一段。 */
function sentenceAround(text:string,quote:string):string {
 const at=text.indexOf(quote),boundary=/[。！？!?.;；\n]/;
 let from=at,to=at+quote.length;
 while(from>0&&!boundary.test(text[from-1]))from--;
 while(to<text.length&&!boundary.test(text[to]))to++;
 return text.slice(from,to);
}

function emptyDropped():Record<ShadowDropReason,number> {return Object.fromEntries(SHADOW_DROP_REASONS.map(r=>[r,0])) as Record<ShadowDropReason,number>}

/** 只接受一个 JSON 对象；允许外面包一层 ```json 代码块。 */
function parseJson(raw:string):unknown {
 const fenced=/^\s*```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/i.exec(raw);
 try{return JSON.parse(fenced?fenced[1]:raw)}catch{return undefined}
}

export function validateShadowResponse(raw:unknown,turn:ShadowTurn):ShadowValidation {
 const dropped=emptyDropped(),result:ShadowValidation={candidates:[],dropped,downgraded:0};
 const parsed=typeof raw==='string'&&raw.length<=MAX_RESPONSE_CHARS?parseJson(raw):undefined;
 if(!isRecord(parsed)||Object.keys(parsed).length!==1||!Array.isArray(parsed.facts)){dropped.schema++;return result}
 const userText=turn.user.text,affirmationOnly=AFFIRMATION.test(userText.normalize('NFKC').trim()),seen=new Set<string>();
 for(const item of parsed.facts){
  if(!isRecord(item)||Object.keys(item).length!==FIELDS.length||!FIELDS.every(k=>Object.hasOwn(item,k))
   ||!['user','other'].includes(item.subject as string)||!SHADOW_ATTRIBUTES.includes(item.attribute as ShadowAttribute)
   ||!['positive','negative'].includes(item.polarity as string)||!['asserted','needs-confirmation'].includes(item.status as string)
   ||!short(item.value,SHADOW_LIMITS.maxValueChars)||!short(item.quote,SHADOW_LIMITS.maxQuoteChars)||!short(item.reason,SHADOW_LIMITS.maxReasonChars)){dropped.schema++;continue}
  const value=(item.value as string).trim(),quote=item.quote as string,reason=(item.reason as string).trim();
  // 过短的引用（如单个"我"）不足以支撑事实；唯一例外是附和词（"嗯"），它只会成为待确认。
  if(quote.trim().length<SHADOW_LIMITS.minQuoteChars&&!AFFIRMATION.test(quote.normalize('NFKC').trim())){dropped.schema++;continue}
  if(item.subject!=='user'){dropped['about-other']++;continue}
  // 只能引用用户原话；只出现在助手回复里的句子不算证据。
  if(!userText.includes(quote)){dropped['quote-not-in-user']++;continue}
  const sentence=sentenceAround(userText,quote).normalize('NFKC');
  if(OTHER_PERSON.test(sentence)){dropped['about-other']++;continue}
  // reason 也会被保存和导出：模型可能把助手语境里的敏感内容写进理由，一并检查。
  if([value,quote,sentence,reason].some(t=>{const n=t.normalize('NFKC');return SENSITIVE.test(n)||SENSITIVE_SHAPE.test(n)})){dropped.sensitive++;continue}
  if(TEMPORARY.test(sentence)){dropped.temporary++;continue}
  const key=`${item.attribute}\u0000${item.polarity}\u0000${value.toLowerCase()}`;
  if(seen.has(key)){dropped.duplicate++;continue}
  if(result.candidates.length>=SHADOW_LIMITS.maxCandidates){dropped['over-limit']++;continue}
  seen.add(key);
  let status=item.status as ShadowCandidate['status'];
  if(status==='asserted'&&(affirmationOnly||AFFIRMATION.test(quote.normalize('NFKC').trim()))){status='needs-confirmation';result.downgraded++}
  result.candidates.push({attribute:item.attribute as ShadowAttribute,value,polarity:item.polarity as ShadowCandidate['polarity'],status,evidence:{messageId:turn.user.id,quote},reason});
 }
 return result;
}
