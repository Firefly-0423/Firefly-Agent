/** Synthetic native Main acceptance. Never launches normal app or imports settings owner. */
import { app, Menu } from "electron";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createProbeRunner } from "../../../src/main/memory-online-once/runner";
import { createNativeProbeEntry } from "../../../src/main/memory-online-once/native-entry";
import { buildTrayMenuTemplate } from "../../../src/main/windows/tray";
import { EXPERIMENT_ID, BUDGET_MICRO_CNY } from "../../../src/main/memory-online-once/boundary";
import { PROVIDER_CAPABILITIES } from "../../../src/main/orchestrator/vendors/capabilities";
const root=process.argv.find(a=>a.startsWith("--probe-root="))?.slice(13);
if(!root || path.parse(root).root.toUpperCase()!=="E:\\")throw new Error("E_ROOT_REQUIRED");
app.setPath("userData",path.join(root,"user-data"));
app.setPath("logs",path.join(root,"logs"));
// Any accidentally introduced global HTTP call is forbidden, including setup.
globalThis.fetch=async()=>{throw new Error("REAL_NETWORK_FORBIDDEN");};
const profile={id:"fake-native-id",provider:PROVIDER_CAPABILITIES.find(c=>c.id==="deepseek")!.displayName,model:"deepseek-flash",baseUrl:"https://api.deepseek.com",apiKey:"SYNTHETIC-NATIVE-SECRET",explicitTransport:"openai" as const};
function arm(dir:string){fs.mkdirSync(dir,{recursive:true});const now=Date.now();fs.writeFileSync(path.join(dir,"arm.json"),JSON.stringify({armed:true,experimentId:EXPERIMENT_ID,priorAttempts:0,budgetMicroCny:BUDGET_MICRO_CNY,priceVerifiedAt:now-1000,inputMicroCnyPerToken:2,outputMicroCnyPerToken:8,expiresAt:now+3600000}));}
void app.whenReady().then(async()=>{
 const cases=[];
 for(const mode of ["complete","uncertain","cancel"]){
  const dir=path.join(root,mode);arm(dir);let attempts=0;const dialogs:unknown[]=[];
  const runner=createProbeRunner({root:dir,resolveProfile:id=>id===profile.id?profile:undefined,now:Date.now,fetch:async()=>{
   attempts++;
   const ledger=JSON.parse(fs.readFileSync(path.join(dir,"ledger.json"),"utf8"));assert.equal(ledger.reservedMicroCny,4198400);assert.equal(ledger.attempts.at(-1).status,"pending");
   if(mode==="cancel")return await new Promise<Response>(()=>{});
   return new Response(JSON.stringify({id:"fake-native-id",object:"chat.completion",model:"deepseek-flash",usage:mode==="uncertain"?null:{prompt_tokens:100,completion_tokens:20,total_tokens:120,prompt_cache_hit_tokens:64,prompt_cache_miss_tokens:36},choices:[{index:0,message:{role:"assistant",content:profile.apiKey},finish_reason:"stop"}]}));
  }});
  const entry=createNativeProbeEntry({runner,listProfileIds:()=>[profile.id],show:async options=>{dialogs.push(options);return {response:0};}});
  const menu=Menu.buildFromTemplate(buildTrayMenuTemplate({requestActivation:()=>{},togglePetWindow:()=>{},quit:()=>{},memoryOnlineOnce:{run:()=>{void entry.run();},cancel:()=>entry.cancel()}}));
  const start=menu.items.find(i=>i.label==="记忆 H：一次性在线测试（≤¥5）")!;
  start.click();start.click();const run=entry.run();
  if(mode==="cancel") {await new Promise(resolve=>setImmediate(resolve));menu.items.find(i=>i.label==="取消记忆 H 在线测试")!.click();}
  await run;
  const receipt=await runner.start(profile.id);
  assert.equal(receipt.status,mode==="complete"?"completed":mode==="cancel"?"cancelled":"uncertain");assert.equal(attempts,mode==="complete"?2:1);
  assert.ok(!JSON.stringify({dialogs,receipt,ledger:fs.readFileSync(path.join(dir,"ledger.json"),"utf8")}).includes(profile.apiKey));
  const restarted=createProbeRunner({root:dir,resolveProfile:()=>profile,now:Date.now,fetch:async()=>{throw new Error("RESTART_SEND_FORBIDDEN");}});
  assert.equal((await restarted.start(profile.id)).status,"refused");
  cases.push({mode,status:receipt.status,attempts,duplicateClicks:true,reserveBeforeFetch:true,restartRefused:true,noSecretExport:true});
 }
 fs.writeFileSync(path.join(root,"result.json"),JSON.stringify({electron:process.versions.electron,node:process.versions.node,realNetworkRequests:0,realConfigurationRead:false,realCredentialsRead:false,cases},null,2));app.exit(0);
}).catch(()=>{fs.writeFileSync(path.join(root,"failed.json"),JSON.stringify({status:"SYNTHETIC_NATIVE_FAILED"}));app.exit(1);});
