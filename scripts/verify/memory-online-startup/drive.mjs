import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createPackageWithOptions} from '@electron/asar';
const cwd=process.cwd();assert.equal(path.parse(cwd).root.toUpperCase(),'E:\\');
const base=path.join(cwd,'output/memory-online-startup'),output=path.join(base,'native-'+Date.now()),source=path.join(output,'app-source');
fs.mkdirSync(source,{recursive:true});fs.cpSync(path.join(cwd,'dist/main'),path.join(source,'compiled'),{recursive:true});
fs.copyFileSync('scripts/verify/memory-online-startup/entry.cjs',path.join(source,'entry.cjs'));
fs.mkdirSync(path.join(source,'assets/icon-presets'),{recursive:true});
for(const asset of ['tray-icon.ico','icon-presets/firefly.png'])fs.copyFileSync(path.join(cwd,'assets',asset),path.join(source,'assets',asset));
fs.writeFileSync(path.join(source,'package.json'),JSON.stringify({name:'firefly-startup-synthetic',version:'0.0.0',main:'entry.cjs'}));
const packaged=path.join(output,'win-unpacked');fs.cpSync(path.join(cwd,'node_modules/electron/dist'),packaged,{recursive:true});
fs.renameSync(path.join(packaged,'electron.exe'),path.join(packaged,'FireflyStartupSynthetic.exe'));
await createPackageWithOptions(source,path.join(packaged,'resources/app.asar'),{});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check){for(let i=0;i<300;i++){if(check())return;await pause(20);}throw Error('DRIVER_TIMEOUT');}
const actualAdmission='E:\\Codex\\2026-10-01\\task\\memory-online-once-admission-55df896';
const snapshot=()=>['arm.json','boot.json','spent.json','ledger.json'].map(f=>fs.existsSync(path.join(actualAdmission,f)));
const initial=snapshot(),runs=[];
for(const isPackaged of [false,true])for(const mode of ['startup','prepare','success','cancel','duplicate','provider','model','url','transport','key','empty','read-error']){
 const root=path.join(output,(isPackaged?'asar-':'dev-')+mode),sourceRoot=path.join(output,(isPackaged?'asar-':'dev-')+mode+'-source');
 for(const sub of ['temp','cache','logs','initial-userdata','fake-admission'])fs.mkdirSync(path.join(root,sub),{recursive:true});
 fs.mkdirSync(path.join(sourceRoot,'Firefly'),{recursive:true});
 const profile={id:'synthetic-profile',provider:'DeepSeek（深度求索）',model:'deepseek-flash',baseUrl:'https://api.deepseek.com',apiKey:'SYNTHETIC-H-KEY'};
 if(mode==='provider')profile.provider='SYNTHETIC-PROVIDER';if(mode==='model')profile.model='SYNTHETIC-MODEL';if(mode==='url')profile.baseUrl='https://synthetic.invalid';if(mode==='transport')profile.explicitTransport='anthropic';if(mode==='key')profile.apiKey='';
 fs.writeFileSync(path.join(sourceRoot,'Firefly/model-settings.json'),mode==='read-error'?'{':JSON.stringify({schemaVersion:2,modelProfiles:mode==='empty'?[]:[profile]}));
 const now=Date.now();fs.writeFileSync(path.join(root,'fake-admission/arm.json'),JSON.stringify({armed:true,experimentId:'memory-h-deepseek-flash-once-55df896',priorAttempts:0,budgetMicroCny:5000000,inputMicroCnyPerToken:2,outputMicroCnyPerToken:8,priceVerifiedAt:now-1000,expiresAt:now+3600000}));
 const env={...process.env,ELECTRON_RUN_AS_NODE:undefined,TEMP:path.join(root,'temp'),TMP:path.join(root,'temp'),TMPDIR:path.join(root,'temp'),APPDATA:sourceRoot,LOCALAPPDATA:sourceRoot,ELECTRON_LOG_FILE:path.join(root,'logs/electron.log'),CHROME_LOG_FILE:path.join(root,'logs/chromium.log'),FIREFLY_MEMORY_ONLINE_DIAGNOSTIC_ROOT:root,FIREFLY_STARTUP_CASE:mode};
 const exe=isPackaged?path.join(packaged,'FireflyStartupSynthetic.exe'):path.join(cwd,'node_modules/electron/dist/electron.exe');
 const args=[...(isPackaged?[]:[source]),'--firefly-memory-online-once','--user-data-dir='+path.join(root,'initial-userdata'),'--disk-cache-dir='+path.join(root,'cache'),'--crash-dumps-dir='+path.join(root,'logs/crashes')];
 function launch(){const child=spawn(exe,args,{cwd,env,windowsHide:true,stdio:['ignore','pipe','pipe']});let stderr='',stdout='';child.stdout.on('data',b=>{stdout+=b.toString();});child.stderr.on('data',b=>{stderr+=b.toString();});const timer=setTimeout(()=>child.kill(),20000);const done=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>{clearTimeout(timer);resolve(code);});});return {child,done,logs:()=>({stderr,stdout})};}
 const primary=launch();
 if(mode==='duplicate'){
  await until(()=>fs.existsSync(path.join(root,'readiness.json'))&&JSON.parse(fs.readFileSync(path.join(root,'readiness.json'),'utf8')).menuReady);
  const secondary=launch();assert.equal(await secondary.done,0);assert.ok(fs.existsSync(path.join(root,'secondary-'+secondary.child.pid+'.json')));
  fs.writeFileSync(path.join(root,'quit-verification'),'');
 }
 const code=await primary.done;fs.writeFileSync(path.join(root,'logs/process.json'),JSON.stringify(primary.logs()));
 assert.equal(code,0,'actual '+(isPackaged?'ASAR':'dev')+' '+mode+' startup failed: '+root);
 const result=JSON.parse(fs.readFileSync(path.join(root,'result.json'),'utf8'));assert.equal(result.isPackaged,isPackaged);assert.equal(result.normalLoads,0);assert.equal(result.writes,0);runs.push(result);
 assert.deepEqual(snapshot(),initial);
}
const result={output,runs,totalScenarios:runs.length,actualAdmissionUnchanged:true,realNetworkRequests:0,realConfigurationRead:false};
fs.writeFileSync(path.join(cwd,'output/memory-online-diagnostics/native-results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({output,totalScenarios:runs.length,actualAdmissionUnchanged:true}));
