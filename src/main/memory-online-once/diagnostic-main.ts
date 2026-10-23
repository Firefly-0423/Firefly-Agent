/** Restricted native startup: never imports ordinary application bootstrap. */
import fs from "node:fs";
import path from "node:path";
import { app, dialog, Menu, Tray } from "electron";
import { applyElectronPaths, canonicalPath, resolveRuntimeProfile, within } from "../runtime-profile";
import { getFireflyApplicationDataPath } from "../app-identity";
import { initializeStorageContext } from "../storage-context";
import { loadTrayIcon } from "../windows/tray-icon";
import { getCachedSavedModelProfile, listCachedSavedModelProfileIds, loadModelSettings, prepareReadOnlyDiagnosticModelCache } from "../settings/model-settings";
import { resolveVendorRuntimeSettings, setVendorRuntimeSettingsGetter } from "../orchestrator/vendors/runtime-settings";
import { inspectPreparedProfiles } from "./preparation-diagnostics";
import { createDiagnosticController } from "./diagnostic-controller";
import { createMainProbeEntry } from "./main-entry";
import { ADMISSION_ROOT } from "./runner";
const BASE="E:\\Codex\\2026-10-01\\task\\firefly-memory-next-stage\\output\\memory-online-startup";
export async function startDiagnosticMain():Promise<void> {
 let tray:Tray|undefined,controller:ReturnType<typeof createDiagnosticController>|undefined;
 let root:string|undefined,lastState:Record<string,unknown>={},duplicates=0,menuReady=false;
 const quit=()=>{app.quit();};
 const persist=()=>{if(root)fs.writeFileSync(path.join(root,"readiness.json"),JSON.stringify({pid:process.pid,isReady:app.isReady(),menuReady,duplicateCount:duplicates,...lastState,admission:{armed:fs.existsSync(path.join(ADMISSION_ROOT,"arm.json")),bootBound:fs.existsSync(path.join(ADMISSION_ROOT,"boot.json")),spent:fs.existsSync(path.join(ADMISSION_ROOT,"spent.json")),ledger:fs.existsSync(path.join(ADMISSION_ROOT,"ledger.json"))}}));};
 const fail=()=>{try{lastState={phase:"startup-refused"};persist();}catch{}try{controller?.cancel();tray?.destroy();}catch{}app.exit(1);};
 process.stdout.on("error",()=>{});process.stderr.on("error",()=>{});
 process.once("uncaughtException",fail);process.once("unhandledRejection",fail);
 try {
  const productionAppData=getFireflyApplicationDataPath(app);
  const source=resolveRuntimeProfile({argv:["--firefly-profile=production"],env:{},isPackaged:app.isPackaged,productionAppData});
  const requested=process.env.FIREFLY_MEMORY_ONLINE_DIAGNOSTIC_ROOT??path.join(BASE,"live-runtime");
  const base=canonicalPath(BASE),resolved=canonicalPath(requested);
  if(!path.isAbsolute(requested)||!within(base,resolved)||resolved===base)throw new Error("DIAGNOSTIC_ROOT_REFUSED");
  fs.mkdirSync(resolved,{recursive:true});root=resolved;
  const profile=resolveRuntimeProfile({argv:["--firefly-profile=smoke",`--firefly-isolation-root=${root}`],env:{},isPackaged:app.isPackaged,productionAppData});
  applyElectronPaths(app,profile);initializeStorageContext(profile);
  if(!app.requestSingleInstanceLock()) {fs.writeFileSync(path.join(root,`secondary-${process.pid}.json`),JSON.stringify({pid:process.pid,secondary:true,configurationPrepared:false,permitCreated:false}));app.exit(0);return;}
  app.on("second-instance",()=>{duplicates++;persist();});
  app.on("before-quit",()=>{controller?.cancel();if(tray&&!tray.isDestroyed())tray.destroy();});
  await app.whenReady();
  tray=new Tray(loadTrayIcon());tray.setToolTip("Firefly H：受限测试");
  controller=createDiagnosticController({
   loadExistingConfiguration:()=>{
    const ready=prepareReadOnlyDiagnosticModelCache(source);
    if(ready)setVendorRuntimeSettingsGetter(()=>resolveVendorRuntimeSettings(loadModelSettings()));return ready;
   },
   inspectPreparedProfiles:()=>inspectPreparedProfiles(listCachedSavedModelProfileIds(),getCachedSavedModelProfile),
   createEntry:onReceipt=>createMainProbeEntry(true,{root:ADMISSION_ROOT,resolveProfile:getCachedSavedModelProfile,listProfileIds:listCachedSavedModelProfileIds,fetch:globalThis.fetch,now:Date.now,show:options=>dialog.showMessageBox(options),onReceipt}),
   show:options=>dialog.showMessageBox(options),
   setMenu:items=>{if(tray&&!tray.isDestroyed()){tray.setContextMenu(Menu.buildFromTemplate(items));menuReady=true;}},
   writeState:state=>{lastState=state;persist();},quit,
  });
  controller.install();persist();
  const choice=await dialog.showMessageBox({type:"info",title:"记忆 H 受限测试入口",message:"测试版本已就绪",detail:"启动不读取现有配置、不发送请求。准备配置后，请从系统托盘手动选择一次性在线测试；总预算不超过 ¥5。",buttons:["准备现有配置（不发送）","关闭"],defaultId:1,cancelId:1,noLink:true});
  if(choice.response===0)await controller.prepare();
 } catch {fail();}
}
