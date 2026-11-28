export type Attribute = "shell" | "language" | "response-style" | "address" | "programming-usage" | "programming-ability" | "unclassified" | "tool" | "preference";
export type Extraction = {kind:"rejected";reason:"secret"} | {kind:"direct"|"candidate";attribute:Attribute;value:string|null;reason:string;text:string};
/** Deliberately small grammar. It neither calls a model nor grants source trust. */
export function extractPreference(text:string):Extraction {
 if(typeof text!=="string"||text.length>100_000)throw new Error("MEMORY_INPUT_INVALID");
 // Do this before returning text, including an otherwise valid preference.
 if(/password|passwd|passphrase|credential|api[ _-]?key|(?:access|refresh|session|id|auth)[ _-]?token|bearer\s|\btoken\s*[:=]|(?:client[ _-]?)?secret\s*[:=]|private[ _-]?key|\b(?:ghp_|sk-)[A-Za-z0-9_-]{16,}|密码|口令|私钥|密钥|令牌/i.test(text.normalize("NFKC")))return {kind:"rejected",reason:"secret"};
 const candidate=(reason:string):Extraction=>({kind:"candidate",attribute:"unclassified",value:null,reason,text});
 const normalized=text.normalize("NFKC").trim();
 if(/糖尿病|疾病|病史|银行|账户|工资|身份证|cancer|medical|diagnos|bank|salary|social security/i.test(normalized))return candidate("sensitive");
 // Single, complete declarative preference only. No stripping quotes or clauses.
 if(/[\r\n?？;；:："“”「」]/.test(normalized))return candidate("ambiguous");
 if(/临时|暂时|今天|今晚|本次|这次|本会话|for now|today|tonight|tomorrow|this session/i.test(normalized))return candidate("temporary");
 const clean=normalized.replace(/[。.!！]$/u,"").trim();
 const address=/^(?:请叫我\s*|Call me\s+)([\p{L}\p{N}\p{Extended_Pictographic} _-]{1,32})$/iu.exec(clean);
 if(address)return {kind:"direct",attribute:"address",value:address[1].trim(),reason:"direct-preference",text};
 const match=/^(?:我(?:默认(?:用|使用)|偏好)\s*|I (?:prefer\s+|use\s+)|My preferred (?:shell|language) is\s+)(.+)$/iu.exec(clean);
 if(!match)return candidate("unknown");
 const value=match[1].replace(/ by default$/i,"").trim().toLowerCase();
 const values:Record<string,[Attribute,string]>={
  powershell:["shell","powershell"],cmd:["shell","cmd"],bash:["shell","bash"],
  中文:["language","zh"],chinese:["language","zh"],英文:["language","en"],english:["language","en"],
  中英混合:["language","mixed"],"bilingual responses":["language","mixed"],
  简洁回复:["response-style","concise"],"concise responses":["response-style","concise"],
  详细回复:["response-style","detailed"],"detailed responses":["response-style","detailed"],
 };
 const entry=values[value];
 const declared=/^My preferred (shell|language) is\s+/i.exec(clean)?.[1].toLowerCase();
 return entry&&(!declared||declared===entry[0])?{kind:"direct",attribute:entry[0],value:entry[1],reason:"direct-preference",text}:candidate("unknown");
}
