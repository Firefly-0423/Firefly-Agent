import type { MessageBoxOptions, MenuItemConstructorOptions } from "electron";
import type { ProbeReceipt } from "./runner";
import { preparationDetail, projectPreparation, type PreparationDiagnostics } from "./preparation-diagnostics";
interface Dependencies {
 loadExistingConfiguration():boolean;
 inspectPreparedProfiles():PreparationDiagnostics;
 createEntry(onReceipt:(receipt:ProbeReceipt)=>void):{run():Promise<void>;cancel():void}|undefined;
 show(options:MessageBoxOptions):Promise<{response:number}>;
 setMenu(items:MenuItemConstructorOptions[]):void;
 writeState(state:Record<string,unknown>):void;
 quit():void;
}
/** Only native user actions may prepare credentials or create the one-shot runner. */
export function createDiagnosticController(deps:Dependencies) {
 let phase="awaiting-user-preparation",prepared=false,count=0,stopped=false;
 let preparation:Promise<void>|undefined,action:Promise<void>|undefined,preparationView:Promise<void>|undefined;
 let lastPreparation:PreparationDiagnostics|undefined;
 let entry:ReturnType<Dependencies["createEntry"]>,receipt:Record<string,unknown>|undefined;
 const number=(value:unknown)=>typeof value==="number"&&Number.isSafeInteger(value)&&value>=0?value:0;
 function publish(){deps.writeState({phase,configurationPrepared:prepared,eligibleProfiles:count,...(receipt?{receipt}: {}),...(lastPreparation?{preparation:projectPreparation(lastPreparation)}:{})});
 deps.setMenu([
  {label:"准备现有配置（不发送）",enabled:!preparation&&!stopped,click:()=>{void prepare();}},
  {label:"记忆 H：一次性在线测试（≤¥5）",enabled:prepared&&count>0&&!action&&!stopped,click:()=>{void run();}},
  {label:"查看最近准备结果",enabled:lastPreparation!==undefined,click:()=>{void viewPreparation();}},
  {label:"取消记忆 H 在线测试",enabled:!stopped,click:cancel},
  {label:"退出测试版本",click:exit},
 ]);}
 function receive(value:ProbeReceipt){
  receipt={status:["completed","refused","uncertain","cancelled"].includes(value.status)?value.status:"refused",
   attempts:number(value.attempts),reservedMicroCny:number(value.reservedMicroCny),upperMicroCny:number(value.upperMicroCny),
   usage:Array.isArray(value.usage)?value.usage.slice(0,2).map(u=>({promptTokens:number(u.promptTokens),completionTokens:number(u.completionTokens),totalTokens:number(u.totalTokens),upperMicroCny:number(u.upperMicroCny),...(u.cacheHitTokens===undefined?{}:{cacheHitTokens:number(u.cacheHitTokens),cacheMissTokens:number(u.cacheMissTokens)})})):[]};publish();
 }
 function viewPreparation():Promise<void>{
  if(!lastPreparation)return Promise.resolve();
  if(!preparationView)preparationView=Promise.resolve().then(async()=>{
   await deps.show({type:"info",title:"记忆 H：最近准备结果",message:lastPreparation!.eligibleProfiles>0?"配置准备成功":"配置准备未通过",detail:preparationDetail(lastPreparation!),buttons:["关闭"]});
  }).catch(()=>{}).finally(()=>{preparationView=undefined;});
  return preparationView;
 }
 function prepare():Promise<void>{
  if(!preparation)preparation=Promise.resolve().then(async()=>{if(stopped)return;
   try{
    prepared=deps.loadExistingConfiguration();
    lastPreparation=prepared?projectPreparation(deps.inspectPreparedProfiles()):{profileCount:0,eligibleProfiles:0,reasons:[{code:"CONFIGURATION_UNAVAILABLE",count:1}]};
    count=lastPreparation.eligibleProfiles;phase=prepared&&count>0?"ready-to-test":"refused";
   }catch{phase="refused";prepared=false;count=0;lastPreparation={profileCount:0,eligibleProfiles:0,reasons:[{code:"CONFIGURATION_UNAVAILABLE",count:1}]};}
   publish();await viewPreparation();
  });return preparation;
 }
 function run():Promise<void>{
  if(!action&&prepared&&count>0&&!stopped)action=Promise.resolve().then(async()=>{
   if(stopped)return;phase="running";publish();
   try{entry=deps.createEntry(receive);if(entry)await entry.run();phase=stopped?"cancelled":"finished";}
   catch{entry?.cancel();phase=stopped?"cancelled":"refused";}publish();
  });return action??Promise.resolve();
 }
 function cancel(){stopped=true;entry?.cancel();phase="cancelled";publish();}
 function exit(){cancel();phase="closed";publish();deps.quit();}
 return {install:publish,prepare,viewPreparation,run,cancel,exit};
}
