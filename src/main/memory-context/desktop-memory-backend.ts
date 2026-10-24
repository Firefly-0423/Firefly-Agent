import {createOpenRouterExpense,OPENROUTER_BASE,OPENROUTER_MODEL} from "./openrouter-bounded";
import type {RuntimeProfile,RuntimeProfileKind} from "../runtime-profile";
import OpenAI from "openai";
import path from "node:path";
import fs from "node:fs";
import {spawn} from "node:child_process";
import {createHash,randomBytes} from "node:crypto";
import {MemoryClient} from "../memory-core/worker-client";
import {getStorageContext,type StorageContext} from "../storage-context";
import type {KeyProtection} from "../memory-core/key-provider";
import {loadModelSettings,resolveModelSettingsProfile,type ModelSettings} from "../settings/model-settings";
import {createLocalEmbeddingProvider} from "../rag/embedding";
import {createStandardReranker} from "../rag/reranker";
import {createNativeHistoryEndpointFactory} from "../memory-sources/native-history-transport";
import {createMainResponsesBinding,createMainResponsesLimits,createMainOpenRouterBoundedLimits,openRouterResponsesContract,type ResponsesSdkClient,type ResponsesLimitsInput} from "./main-responses-binding";
import type {DesktopMemoryBackend} from "./main-desktop-memory";
function unsupported():never{throw Error("MEMORY_CONTEXT_COUNTER_UNSUPPORTED")}
/** Verified official model documentation; unsupported models require a separately verified contract.
 * https://developers.openai.com/api/docs/models/gpt-5.2 (checked 2026-10-05).
 */
export function desktopResponsesContract(settings:ModelSettings):ResponsesLimitsInput {
 if(settings.provider!=="ChatGPT（OpenAI）"||settings.baseUrl!=="https://api.openai.com/v1"||!['gpt-5.2','gpt-5.2-2025-12-11'].includes(settings.model)
  ||settings.explicitTransport!==undefined&&settings.explicitTransport!=="responses"||!Number.isSafeInteger(settings.contextWindowTokens)||settings.contextWindowTokens<64)unsupported();
 const maxContextTokens=Math.min(400000,settings.contextWindowTokens),reservedOutputTokens=Math.min(4096,Math.floor(maxContextTokens/4)),safetyMarginTokens=Math.min(1024,Math.floor(maxContextTokens/16));
 return {model:settings.model,modelMaxOutputTokens:128000,limitsSource:'https://developers.openai.com/api/docs/models/gpt-5.2',budget:{maxContextTokens,reservedOutputTokens,safetyMarginTokens,maxSTokens:Math.min(16000,maxContextTokens-reservedOutputTokens-safetyMarginTokens),minRecentCompleteTurns:1}};
}
export function desktopMemoryAdmissionMode(hasSwitch:(name:string)=>boolean,kind:RuntimeProfileKind):"openrouter-bounded"|undefined {
 if(!hasSwitch("firefly-memory-openrouter-bounded"))return undefined;
 if(!hasSwitch("firefly-memory-controlled")||!["test","smoke"].includes(kind))throw Error("MEMORY_CONTEXT_PROFILE_DENIED");return "openrouter-bounded";
}
export function desktopOpenRouterContract(settings:ModelSettings,profile:Pick<RuntimeProfile,"kind"|"isolationRoot">):ResponsesLimitsInput {
 if(!["test","smoke"].includes(profile.kind)||!profile.isolationRoot||!path.isAbsolute(profile.isolationRoot))throw Error("MEMORY_CONTEXT_PROFILE_DENIED");
 if(settings.baseUrl!==OPENROUTER_BASE||settings.model!==OPENROUTER_MODEL||settings.explicitTransport!=="responses"||typeof settings.provider!=="string"||!settings.provider.trim())unsupported();return openRouterResponsesContract(settings.contextWindowTokens);
}
interface Options {admissionMode?:"openrouter-bounded";
 profileId:()=>string|undefined;
 /** Test-only Main injection; these objects never enter Renderer DTOs. */
 storage?:StorageContext;settings?:()=>ModelSettings;keyProtection?:KeyProtection;helper?:string;
 sdkFactory?:(settings:ModelSettings)=>ResponsesSdkClient;
}
/** Native executables live outside app.asar in packaged Electron resources. */
export function desktopHistoryHelperPath(app:{isPackaged:boolean;getAppPath():string},resourcesPath:string):string {
 return app.isPackaged?path.join(resourcesPath,'bin','firefly-history-read.exe'):path.join(app.getAppPath(),'native','target','release','firefly-history-read.exe');
}
/** Opens the existing one-writer Worker and pinned local models under Main's profile. */
export async function openDesktopMemoryBackend(options:Options):Promise<DesktopMemoryBackend>{
 const storage=options.storage??getStorageContext();
 if(options.admissionMode!==undefined&&options.admissionMode!=="openrouter-bounded")unsupported();
 const bounded=options.admissionMode==="openrouter-bounded";
 if(bounded&&(!["test","smoke"].includes(storage.profile.kind)||!storage.profile.isolationRoot))throw Error("MEMORY_CONTEXT_PROFILE_DENIED");
 const {app,safeStorage}=await import('electron');
 const settings=()=>resolveModelSettingsProfile((options.settings??loadModelSettings)(),options.profileId()),initial=settings(),limits=bounded?desktopOpenRouterContract(initial,storage.profile):desktopResponsesContract(initial);
 const helper=options.helper??desktopHistoryHelperPath(app,process.resourcesPath);
 if(!fs.existsSync(helper))throw Error('MEMORY_HISTORY_NATIVE_UNAVAILABLE');
 const salt=randomBytes(32),fingerprint=(s:ModelSettings)=>createHash('sha256').update(salt).update(JSON.stringify({profile:options.profileId(),provider:s.provider,baseUrl:s.baseUrl,model:s.model,apiKey:s.apiKey,explicitTransport:s.explicitTransport,reasoning:s.reasoning,contextWindowTokens:s.contextWindowTokens})).digest('hex');
 let previous=fingerprint(initial),revision=1;
 const config=(s:ModelSettings)=>({provider:s.provider,baseUrl:s.baseUrl,model:s.model,explicitTransport:'responses' as const,...(s.reasoning?{reasoning:s.reasoning}:{})});
 const client=(options.sdkFactory??(s=>new OpenAI({apiKey:s.apiKey,baseURL:s.baseUrl,maxRetries:0,logLevel:'off'})))(initial);
 const protection=options.keyProtection??{
  async protect(bytes:Uint8Array){if(!safeStorage.isEncryptionAvailable())throw Error('MEMORY_KEY_PROTECTION_UNAVAILABLE');return safeStorage.encryptString(Buffer.from(bytes).toString('base64'))},
  async unprotect(bytes:Uint8Array){if(!safeStorage.isEncryptionAvailable())throw Error('MEMORY_KEY_PROTECTION_UNAVAILABLE');return Buffer.from(safeStorage.decryptString(Buffer.from(bytes)),'base64')},
 };
 const worker=await MemoryClient.open({storage,keyProtection:protection});
 try{
 const binding=createMainResponsesBinding({enabled:true,client,limits:bounded?createMainOpenRouterBoundedLimits(initial.contextWindowTokens):createMainResponsesLimits(limits),...(bounded?{expense:createOpenRouterExpense({contextCommand:c=>worker.contextCommand(c)},"budget-"+randomBytes(16).toString("hex"))}:{}),configuration:()=>{const current=settings(),next=fingerprint(current);if(next!==previous){revision++;previous=next}return {revision,config:config(current)}}})!;
  const embedding=createLocalEmbeddingProvider('bgem3');if(!embedding)throw Error('MEMORY_HISTORY_VECTOR_UNAVAILABLE');
  const [,reranker]=await Promise.all([embedding.embed('local memory model initialization'),createStandardReranker()]);
  const endpointFactory=createNativeHistoryEndpointFactory({spawn:input=>spawn(helper,['--root',input.root,'--parent-pid',String(process.pid),'--deadline-ms',String(input.deadlineMs)],{windowsHide:true,stdio:['pipe','pipe','pipe']})});
  return {transport:{sourceCommand:c=>worker.sourceCommand(c),policyCommand:c=>worker.policyCommand(c),recallCommand:c=>worker.recallCommand(c),historyCommand:c=>worker.historyCommand(c),contextCommand:c=>worker.contextCommand(c)},binding,localRetrieval:{embedding,reranker},endpointFactory,
   request:input=>{binding.assertCurrent();if(input.settings.model!==limits.model||input.executionMode!=='chat')unsupported();return {model:limits.model,maxTokens:limits.budget.reservedOutputTokens,stream:true,messages:[{role:'system',content:[input.soulSystemBaseContent,input.skillLayerContent].filter(Boolean).join('\n\n')}]}},
   close:async()=>{await worker.close();salt.fill(0)},
  };
 }catch(error){await worker.close();salt.fill(0);throw error}
}
