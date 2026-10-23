import {validateKeyResult} from "./probe-result.mjs";
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {build} from 'esbuild';
import {createPackage} from '@electron/asar';
const cwd=process.cwd();
assert.equal(cwd,'E:\\Codex\\Firefly_Agent-skills-layout\\output\\task-b-memory-core');
const output=path.join(cwd,'output','memory-core','key-integration');
assert.ok(!fs.existsSync(output),'preserve prior integration evidence; choose a new run directory explicitly');
fs.mkdirSync(output,{recursive:true});
const packageDir=path.join(output,'package');fs.mkdirSync(packageDir);
await build({entryPoints:['scripts/verify/memory-core/key-entry.ts'],outfile:path.join(packageDir,'entry.cjs'),bundle:true,platform:'node',target:'node24',format:'cjs'});
fs.writeFileSync(path.join(packageDir,'package.json'),JSON.stringify({name:'firefly-memory-key-probe',version:'0.0.0',main:'entry.cjs'}));
const asar=path.join(output,'app.asar');await createPackage(packageDir,asar);
const electron=path.join(cwd,'node_modules','electron','dist','electron.exe');
const records=[];
const envFor=root=>({...process.env,ELECTRON_RUN_AS_NODE:'1',TEMP:path.join(root,'temp'),TMP:path.join(root,'temp'),TMPDIR:path.join(root,'temp'),APPDATA:path.join(root,'appdata'),LOCALAPPDATA:path.join(root,'localappdata'),XDG_CACHE_HOME:path.join(root,'cache'),ELECTRON_LOG_FILE:path.join(root,'electron.log'),CHROME_LOG_FILE:path.join(root,'chromium.log'),PSModuleAnalysisCachePath:path.join(root,'ps-modules'),DOTNET_CLI_HOME:path.join(root,'dotnet'),DOTNET_SKIP_FIRST_TIME_EXPERIENCE:'1',POWERSHELL_TELEMETRY_OPTOUT:'1'});
const snapshot=root=>fs.existsSync(path.join(root,'data'))?Object.fromEntries(fs.readdirSync(path.join(root,'data')).sort().map(name=>{const p=path.join(root,'data',name),b=fs.readFileSync(p);return [name,{size:b.length,hash:crypto.createHash('sha256').update(b).digest('hex')}]})):{};
async function run(entry,root,pause){
 fs.mkdirSync(path.join(root,'temp'),{recursive:true});
 const child=spawn(electron,[entry,'--root='+root,...(pause?['--pause='+pause]:[])],{cwd,env:envFor(root),windowsHide:true,stdio:['ignore','pipe','pipe']});
 let stderr='',stdout='',marker=false,killResult,killError,timedOut=false;
 const killOwned=()=>{
  if(killResult)return;
  const killer=spawn('C:\\Windows\\System32\\taskkill.exe',['/PID',String(child.pid),'/T','/F'],{cwd,env:envFor(root),windowsHide:true,stdio:['ignore','pipe','pipe']});
  killer.stdout.resume();killer.stderr.resume();
  killResult=new Promise((resolve,reject)=>{killer.once('error',reject);killer.once('close',code=>code===0?resolve():reject(new Error('OWNED_PROCESS_KILL_FAILED')))}).catch(error=>{killError=error;child.kill()});
 };
 const ended=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}))});
 const timer=setTimeout(()=>{timedOut=true;killOwned();},40000);
 child.stderr.on('data',b=>{stderr+=b.toString()});
 child.stdout.on('data',b=>{
  stdout+=b.toString();
  if(pause&&!marker&&stdout.includes(JSON.stringify({stage:pause}))){
   marker=true;
   killOwned();
  }
 });
 let exit;try{exit=await ended}finally{clearTimeout(timer);await killResult}
 if(killError)throw killError;
 const lines=stdout.trim().split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));
 fs.writeFileSync(path.join(output,'run-'+records.length+'.json'),JSON.stringify({root,pause,exit,lines,stderrBytes:Buffer.byteLength(stderr)},null,2));
 const result={root,pause,exit,lines,stderrBytes:Buffer.byteLength(stderr)};records.push(result);
 validateKeyResult({lines,exit,pause,marker,timedOut});
 return result;
}
for(const [mode,entry] of [['development',path.join(packageDir,'entry.cjs')],['packaged',path.join(asar,'entry.cjs')]]){
 for(const stage of ['protected','pending-opened','pending-written','pending-fsynced','pending-validated','published','key-ready']){
  const root=path.join(output,mode+'-'+stage);await run(entry,root,stage);const before=snapshot(root);
  const reopened=await run(entry,root);const final=reopened.lines.at(-1);
  if(stage==='pending-opened'){assert.equal(final.error,'MEMORY_KEY_FORMAT_UNSUPPORTED');assert.deepEqual(snapshot(root),before)}
  else{
   assert.equal(final.ok,true);assert.equal(final.canaryMatch,true);assert.equal(final.versions.electron,'43.1.0');assert.equal(final.versions.node,'24.18.0');
   const previous=before['memory-key.protected']??before['memory-key.protected.pending'];
   if(previous)assert.deepEqual(snapshot(root)['memory-key.protected'],previous);
   const one=snapshot(root);const stable=await run(entry,root);assert.equal(stable.lines.at(-1).ok,true);assert.deepEqual(snapshot(root),one);
  }
 }
}
const report={gate:'PASS',baseline:'be6beede628e6e00dc6304355af4ab3dd65f919c',development:true,packagedAsar:true,killBoundariesPerMode:7,partialPublicationFailClosedPerMode:1,processRuns:records.length,powerLoss:'NOT_RUN',systemRebootNewModule:'NOT_RUN',productionAccess:'NONE',records};
fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({gate:report.gate,processRuns:records.length,report:path.join(output,'report.json')}));
