/** Fixed, non-secret diagnostics. Profiles and their original values stay in Main. */
import type { SavedModelProfile } from "../settings/model-catalog";
import { getCapability } from "../orchestrator/vendors/capabilities";
import { eligibleProfile } from "./boundary";
export const PREPARATION_REASONS = {
 PROVIDER_MISMATCH:"服务商不匹配",
 MODEL_MISMATCH:"模型不匹配",
 BASE_URL_MISMATCH:"地址不匹配",
 TRANSPORT_MISMATCH:"协议不匹配",
 KEY_MISSING:"密钥未填写（未验证有效性）",
 PROFILE_UNAVAILABLE:"保存配置无法按原标识找到或不符合测试条件",
 NO_SAVED_PROFILES:"没有保存的模型配置",
 CONFIGURATION_UNAVAILABLE:"配置读取或诊断失败",
} as const;
export type PreparationReason=keyof typeof PREPARATION_REASONS;
export interface PreparationDiagnostics {profileCount:number;eligibleProfiles:number;reasons:{code:PreparationReason;count:number}[];}
export function inspectPreparedProfiles(ids:readonly string[],resolve:(id:string)=>SavedModelProfile|undefined):PreparationDiagnostics {
 const counts:Partial<Record<PreparationReason,number>>={};let eligible=0;
 const add=(code:PreparationReason)=>{counts[code]=(counts[code]??0)+1;};
 if(ids.length===0)add("NO_SAVED_PROFILES");
 for(const id of ids){
  const p=resolve(id);if(!p||p.id!==id){add("PROFILE_UNAVAILABLE");continue;}
  // Existing predicate alone controls admission; diagnostics cannot admit a profile.
  if(eligibleProfile(p)){eligible++;continue;}
  const codes:PreparationReason[]=[];
  if(getCapability(p.provider)?.id!=="deepseek")codes.push("PROVIDER_MISMATCH");
  if(p.model!=="deepseek-flash")codes.push("MODEL_MISMATCH");
  if(p.baseUrl!=="https://api.deepseek.com"&&p.baseUrl!=="https://api.deepseek.com/")codes.push("BASE_URL_MISMATCH");
  if(p.explicitTransport!==undefined&&p.explicitTransport!=="openai")codes.push("TRANSPORT_MISMATCH");
  if(typeof p.apiKey!=="string"||p.apiKey.trim().length===0)codes.push("KEY_MISSING");
  if(codes.length===0)codes.push("PROFILE_UNAVAILABLE");for(const code of codes)add(code);
 }
 return {profileCount:ids.length,eligibleProfiles:eligible,reasons:(Object.keys(PREPARATION_REASONS) as PreparationReason[]).filter(code=>counts[code]).map(code=>({code,count:counts[code]!}))};
}
/** Never spread dependency payloads into readiness or native dialogs. */
export function projectPreparation(value:PreparationDiagnostics):PreparationDiagnostics {
 const number=(n:unknown)=>typeof n==="number"&&Number.isSafeInteger(n)&&n>=0?Math.min(n,10000):0;
 const profileCount=number(value.profileCount);
 const reasons=(Object.keys(PREPARATION_REASONS) as PreparationReason[]).map(code=>({code,count:Math.min(Math.max(profileCount,1),Array.isArray(value.reasons)?value.reasons.filter(item=>item?.code===code).reduce((sum,item)=>sum+number(item.count),0):0)})).filter(item=>item.count>0);
 return {profileCount,eligibleProfiles:Math.min(profileCount,number(value.eligibleProfiles)),reasons};
}
export function preparationDetail(value:PreparationDiagnostics):string {
 return [`已读取保存配置：${value.profileCount}；符合测试条件：${value.eligibleProfiles}。`,
 ...value.reasons.map(reason=>`${reason.code}：${PREPARATION_REASONS[reason.code]}（${reason.count}项）`),
 value.eligibleProfiles>0?"下一步：关闭此提示，再从托盘手动选择一次性在线测试。":"下一步：把原因码告诉助手即可，不要发送密钥或配置文件。",
 "准备按钮禁用：本次进程已经准备过配置。在线测试仅在存在合格配置时启用。",
 "可从托盘反复打开“查看最近准备结果”；查看不会重新读取配置或发送请求。同一配置可能有多项不符。"].join("\n");
}
