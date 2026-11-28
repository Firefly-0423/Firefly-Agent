/** Isolated test shell: no ordinary startup, model settings or user-history imports. */
import fs from "node:fs";
import path from "node:path";
import { app, dialog, Menu, Tray } from "electron";
import { applyElectronPaths,canonicalPath,resolveRuntimeProfile,within } from "../../../base/identity/runtime-profile";
import { getFireflyApplicationDataPath } from "../../../base/identity/app-identity";
import { initializeStorageContext } from "../../../base/storage/storage-context";
import { loadTrayIcon } from "../../../platform/windows/tray-icon";
import { createController } from "./controller";
import { createConfigurationWindow } from "./configuration-window";
import { createProbeRunner,ADMISSION_ROOT } from "./runner";
import type { SessionProfile } from "./session-profile";
const DEFAULT_BASE="E:/Codex/2026-10-01/task/firefly-memory-next-stage/output/openrouter-usd1";
/** 诊断输出只能写在这个根目录下。验证脚本用 FIREFLY_OPENROUTER_DIAGNOSTIC_BASE 指向自己的输出目录；没设置时用原来的目录。 */
const diagnosticBase=():string=>process.env.FIREFLY_OPENROUTER_DIAGNOSTIC_BASE||DEFAULT_BASE;
export async function startOpenRouterDiagnosticMain():Promise<void>{
 let tray:Tray|undefined,controller:ReturnType<typeof createController>|undefined,root:string|undefined,lastState:Record<string,unknown>={},duplicates=0;
 let startupRunner:ReturnType<typeof createProbeRunner>|undefined,resolveSelectedProfile:((id:string)=>SessionProfile|undefined)|undefined;
 const persist=()=>{if(root)fs.writeFileSync(path.join(root,"readiness.json"),JSON.stringify({pid:process.pid,isReady:app.isReady(),menuReady:!!tray,duplicateCount:duplicates,...lastState,admission:{armed:fs.existsSync(path.join(ADMISSION_ROOT,"arm.json")),bootBound:fs.existsSync(path.join(ADMISSION_ROOT,"boot.json")),spent:fs.existsSync(path.join(ADMISSION_ROOT,"spent.json")),ledger:fs.existsSync(path.join(ADMISSION_ROOT,"ledger.json"))}}));};
 // 退出路径：清理失败不能挡住退出。
 const fail=()=>{try{controller?.cancel();startupRunner?.cancel();tray?.destroy();}catch{}app.exit(1);};
 process.stdout.on("error",()=>{});process.stderr.on("error",()=>{});process.once("uncaughtException",fail);process.once("unhandledRejection",fail);
 try{
  const productionAppData=getFireflyApplicationDataPath(app);
  const requested=process.env.FIREFLY_OPENROUTER_DIAGNOSTIC_ROOT??path.join(diagnosticBase(),"live-runtime");const base=canonicalPath(diagnosticBase()),resolved=canonicalPath(requested);
  if(!path.isAbsolute(diagnosticBase())||!path.isAbsolute(requested)||!within(base,resolved)||resolved===base)throw new Error("DIAGNOSTIC_ROOT_REFUSED");fs.mkdirSync(resolved,{recursive:true});root=resolved;
  const profile=resolveRuntimeProfile({argv:["--firefly-profile=smoke",`--firefly-isolation-root=${root}`],env:{},isPackaged:app.isPackaged,productionAppData});applyElectronPaths(app,profile);initializeStorageContext(profile);
  if(!app.requestSingleInstanceLock()){fs.writeFileSync(path.join(root,`secondary-${process.pid}.json`),JSON.stringify({secondary:true,pid:process.pid}));app.exit(0);return;}
  // Bind one non-secret permission before displaying the form. The resolver stays empty until native confirmation.
  startupRunner=createProbeRunner({root:ADMISSION_ROOT,resolveProfile:id=>resolveSelectedProfile?.(id),fetch:globalThis.fetch,now:Date.now});
  app.on("second-instance",()=>{duplicates++;persist();});app.on("before-quit",()=>{controller?.cancel();startupRunner?.cancel();resolveSelectedProfile=undefined;if(tray&&!tray.isDestroyed())tray.destroy();});
  // Closing the credential form must leave the native tray available for manual send.
  // https://www.electronjs.org/docs/latest/api/app#event-window-all-closed
  app.on("window-all-closed",()=>{});
  await app.whenReady();tray=new Tray(loadTrayIcon());tray.setToolTip("OpenRouter H：USD 1 受限测试");const form=createConfigurationWindow();
  controller=createController({openForm:form.open,closeForm:form.close,createRunner:resolveProfile=>{resolveSelectedProfile=resolveProfile;return startupRunner!;},show:options=>dialog.showMessageBox(options),setMenu:items=>{if(tray&&!tray.isDestroyed())tray.setContextMenu(Menu.buildFromTemplate(items));},writeState:s=>{lastState=s;persist();},quit:()=>app.quit()});
  controller.install();controller.configure();
 }catch(error){
  // 只输出错误码，不输出配置或路径；否则失败时进程什么都不留就退出。
  console.error("[memory-openrouter-once] startup refused:",error instanceof Error?error.message:String(error));fail();
 }
}
