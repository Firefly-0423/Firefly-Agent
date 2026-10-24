import {getCustomEndpointMode,getCustomEndpointPresentation} from "../../shared/custom-endpoint-state";
import { createHash, randomBytes } from "node:crypto";
import type { ModelSettings } from "../settings/model-settings";
import { getAdapterForConfig } from "../orchestrator/vendors";
import { resolveTransport } from "../orchestrator/vendors/transport-detector";
import type { VendorConfig } from "../orchestrator/vendors/types";
import { DEFAULT_HARNESS_CONFIG } from "../orchestrator/harness/types";
import { autoCompactTriggerTokens } from "../../shared/context-window";
import type { MainMemoryModelBinding } from "./main-memory-runtime";
import { resolveMemoryCounter } from "./model-counting";
interface Options {
 settings():ModelSettings;
 reservedOutputTokens?:number;
 safetyMarginTokens?:number;
}
/** Main owns profile identity/revisions; no settings writes, network calls or diagnostic expense policy. */
export function createProductionModelRegistry(options:Options) {
 const salt=randomBytes(32),records=new Map<string,{fingerprint:string;revision:number}>();let epoch=0,closed=false;
 const denied=():never=>{throw new Error("MEMORY_RUN_PROFILE_DENIED")};
 function read(id:string) {
  if(closed)return denied();
  const settings=options.settings(),matches=settings.modelProfiles?.filter(profile=>profile.id===id)??[];
  if(matches.length!==1)return null;
  const profile=matches[0],config:VendorConfig={provider:profile.provider,baseUrl:profile.baseUrl,model:profile.model,apiKey:profile.apiKey,
   ...(profile.explicitTransport?{explicitTransport:profile.explicitTransport}:{}),...(profile.reasoning?{reasoning:structuredClone(profile.reasoning)}:{})};
  const window=profile.contextWindowTokens??settings.contextWindowTokens;
  const customMode=getCustomEndpointMode(config.provider),keyOptional=customMode!==null&&getCustomEndpointPresentation(customMode).apiKeyOptional;
  if(!config.provider?.trim()||!config.model?.trim()||!config.baseUrl?.trim()||(!keyOptional&&!config.apiKey?.trim())||!Number.isSafeInteger(window)||window<1)return denied();
  const fingerprint=createHash("sha256").update(salt).update(JSON.stringify({config,window,timeout:settings.chatRequestTimeoutSec,epoch})).digest("hex");
  const previous=records.get(id);let record=previous;
  if(!record||record.fingerprint!==fingerprint){record={fingerprint,revision:(previous?.revision??0)+1};records.set(id,record)}
  return {config,window,revision:record.revision,fingerprint};
 }
 function profile(id:string) {const value=read(id);return value?Object.freeze({id,revision:value.revision}):null}
 function bind(id:string):MainMemoryModelBinding {
  const value=read(id);if(!value)return denied();
  const config=Object.freeze(value.config),transport=resolveTransport(config);
  const reservedOutputTokens=Math.max(options.reservedOutputTokens??DEFAULT_HARNESS_CONFIG.reservedOutputTokens,transport==="anthropic"?32768:0);
  const safetyMarginTokens=options.safetyMarginTokens??DEFAULT_HARNESS_CONFIG.safetyMarginTokens;
  if(!Number.isSafeInteger(reservedOutputTokens)||reservedOutputTokens<1||!Number.isSafeInteger(safetyMarginTokens)||safetyMarginTokens<0||reservedOutputTokens+safetyMarginTokens>=value.window)return denied();
  const assertCurrent=()=>{const current=read(id);if(!current||current.fingerprint!==value.fingerprint||current.revision!==value.revision)throw new Error("MEMORY_RUN_PROFILE_CHANGED")};
  // S 超过窗口的 85%（且不超过扣除预留后的可用输入）就进入摘要，不等到顶才压缩。
  const budget=Object.freeze({admissionMode:"bounded" as const,maxContextTokens:value.window,reservedOutputTokens,safetyMarginTokens,maxSTokens:autoCompactTriggerTokens(value.window,{reservedOutputTokens,safetyMarginTokens}),minRecentCompleteTurns:1});
  // No verified output-limit contract is inferred from a model name. Exact adapters
  // remain available separately; production defaults to honestly labeled estimates.
  return Object.freeze({profileId:id,revision:value.revision,config,adapter:getAdapterForConfig(config),budget,
   counter:resolveMemoryCounter(config,value.revision,{mode:"estimate",validateCurrent:assertCurrent}),assertCurrent});
 }
 return Object.freeze({profile,bind,invalidate(){epoch++},close(){closed=true;salt.fill(0);records.clear()}});
}
