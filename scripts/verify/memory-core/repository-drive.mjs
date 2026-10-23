import {DatabaseSync} from "node:sqlite";
import {validateProbeResult} from "./probe-result.mjs";
import {checkpointPlugin} from "./checkpoint-build.mjs";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {build} from "esbuild";
import {createPackage} from "@electron/asar";
const cwd="E:\\Codex\\Firefly_Agent-skills-layout\\output\\task-b-memory-core";
assert.equal(process.cwd(),cwd);
const output=path.join(cwd,"output","memory-core","repository-integration-"+new Date().toISOString().replace(/[:.]/g,"-"));
fs.mkdirSync(output,{recursive:true});
const source=path.join(output,"app-source");fs.mkdirSync(source);
await build({entryPoints:["scripts/verify/memory-core/repository-entry.ts"],outfile:path.join(source,"entry.js"),plugins:[checkpointPlugin],bundle:true,platform:"node",target:"node24",format:"cjs",external:["electron"]});
await build({entryPoints:["scripts/verify/memory-core/worker-probe.ts"],outfile:path.join(source,"worker.js"),plugins:[checkpointPlugin],bundle:true,platform:"node",target:"node24",format:"cjs"});
fs.writeFileSync(path.join(source,"package.json"),JSON.stringify({name:"firefly-memory-core-probe",version:"0.0.0",main:"entry.js"}));
const packaged=path.join(output,"win-unpacked");
fs.cpSync(path.join(cwd,"node_modules","electron","dist"),packaged,{recursive:true});
const asar=path.join(packaged,"resources","app.asar");await createPackage(source,asar);
const runs=[],gates={};
const envFor=root=>({...process.env,ELECTRON_RUN_AS_NODE:undefined,TEMP:path.join(root,"temp"),TMP:path.join(root,"temp"),TMPDIR:path.join(root,"temp"),APPDATA:path.join(root,"appdata"),LOCALAPPDATA:path.join(root,"localappdata"),XDG_CACHE_HOME:path.join(root,"cache"),npm_config_cache:path.join(root,"cache","npm"),ELECTRON_CACHE:path.join(root,"cache","electron"),ELECTRON_BUILDER_CACHE:path.join(root,"cache","electron-builder"),ELECTRON_LOG_FILE:path.join(root,"logs","electron.log"),CHROME_LOG_FILE:path.join(root,"logs","chromium.log"),PSModuleAnalysisCachePath:path.join(root,"cache","ps-module-analysis"),DOTNET_CLI_HOME:path.join(root,"cache","dotnet"),DOTNET_SKIP_FIRST_TIME_EXPERIENCE:"1",POWERSHELL_TELEMETRY_OPTOUT:"1"});
const snapshot=data=>Object.fromEntries(["memory.sqlite","memory.sqlite-wal","memory.sqlite-shm","memory.sqlite.auth"].map(name=>{const file=path.join(data,name);if(!fs.existsSync(file))return [name,null];const bytes=fs.readFileSync(file),stat=fs.statSync(file);return [name,{size:bytes.length,mtime:stat.mtimeMs,sha256:crypto.createHash("sha256").update(bytes).digest("hex")}]}));
async function run(mode,root,action,kill=false,pause,expectedError){
 const runId=crypto.randomUUID();
 for(const folder of ["temp","appdata","localappdata","cache","logs"])fs.mkdirSync(path.join(root,folder),{recursive:true});
 const exe=mode==="development"?path.join(cwd,"node_modules","electron","dist","electron.exe"):path.join(packaged,"electron.exe");
 const args=["--probe-run-id="+runId,...(pause?["--probe-pause="+pause]:[]),...(mode==="development"?[source]:[]),"--probe-root="+root,"--probe-mode="+action,"--user-data-dir="+path.join(root,"early-userdata"),"--disk-cache-dir="+path.join(root,"cache","chromium"),"--crash-dumps-dir="+path.join(root,"logs","crashes")];
 const child=spawn(exe,args,{cwd,env:envFor(root),windowsHide:true,stdio:["ignore","pipe","pipe"]});
 let bytes=0,buffer="",killPromise,killError,marker=false,timedOut=false;
 const killOwned=()=>{
  if(killPromise)return;
  const killer=spawn("C:\\Windows\\System32\\taskkill.exe",["/PID",String(child.pid),"/T","/F"],{cwd,env:envFor(root),windowsHide:true,stdio:["ignore","pipe","pipe"]});
  killer.stdout.resume();killer.stderr.resume();
  killPromise=new Promise((resolve,reject)=>{killer.once("error",reject);killer.once("close",code=>code===0?resolve():reject(Error("PROBE_KILL_FAILED")))}).catch(error=>{killError=error;child.kill()});
 };
 const ended=new Promise((resolve,reject)=>{child.once("error",reject);child.once("close",(code,signal)=>resolve({code,signal}))});
 const timeout=setTimeout(()=>{timedOut=true;killOwned();},40000);
 child.stderr.on("data",chunk=>{bytes+=chunk.length});
 child.stdout.on("data",chunk=>{
  buffer+=chunk.toString();
  if(kill&&!marker&&buffer.includes('"stage":"'+(pause??"committed-live-wal")+'"')){
   marker=true;
   killOwned();
  }
 });
 let exit;
 try{exit=await ended}finally{clearTimeout(timeout);await killPromise}
 const record={mode,root,action,runId,kill,pause,expectedError,exit,timedOut,marker,stderrBytes:bytes};runs.push(record);
 fs.writeFileSync(path.join(output,"progress.json"),JSON.stringify({gates,runs},null,2));
 if(killError)throw killError;
 const resultFile=path.join(root,(pause?"checkpoint-":"result-")+runId+".json");
 assert.ok(fs.existsSync(resultFile),"probe result missing; do not retry blindly");
 const result=JSON.parse(fs.readFileSync(resultFile,"utf8"));
 record.result=result;
 fs.writeFileSync(path.join(output,"progress.json"),JSON.stringify({gates,runs},null,2));
 validateProbeResult(result,{runId,action,exit,pause,kill,marker,timedOut,expectedError});
 return result;
}
try{
 for(const mode of ["development","packaged"]){
  const jobs=await run(mode,path.join(output,mode+"-jobs"),"jobs");assert.equal(jobs.ok,true);assert.equal(jobs.oldJobStillBlocked,true);
  const facts=await run(mode,path.join(output,mode+"-facts"),"facts");assert.equal(facts.ok,true);assert.equal(facts.concurrentRevisionConflict,true);assert.equal(facts.transactionRollback,true);
  const swapped=path.join(output,mode+"-swapped-payload"),swappedData=path.join(swapped,"isolated","Firefly-test","memory","data");
  fs.mkdirSync(swappedData,{recursive:true});
  const factsData=path.join(output,mode+"-facts","isolated","Firefly-test","memory","data");
  for(const name of ["memory.sqlite","memory.sqlite.auth","memory-key.protected"])fs.copyFileSync(path.join(factsData,name),path.join(swappedData,name),fs.constants.COPYFILE_EXCL);
  const tamper=new DatabaseSync(path.join(swappedData,"memory.sqlite"));
  try{
   const records=tamper.prepare("SELECT id,payload FROM sources WHERE scope_key=? ORDER BY id LIMIT 2").all("scope-test");assert.equal(records.length,2);
   tamper.prepare("UPDATE sources SET payload=? WHERE id=?").run(records[0].payload,records[1].id);
  }finally{tamper.close()}
  const rejectedPayload=await run(mode,swapped,"reject-payload",false,undefined,"MEMORY_AUTH_FAILED");assert.match(rejectedPayload.error,/^MEMORY_/);
  const root=path.join(output,mode);
  const first=await run(mode,root,"basic");assert.equal(first.ok,true);assert.equal(first.versions.electron,"43.1.0");assert.equal(first.versions.node,"24.18.0");assert.equal(first.versions.sqlite,"3.53.1");assert.equal(first.workerInAsar,mode==="packaged");assert.equal(first.workerRuntime.electron,"43.1.0");assert.equal(first.workerRuntime.node,"24.18.0");assert.equal(first.workerRuntime.sqlite,"3.53.1");assert.ok(first.workerRuntime.threadId>0);
  assert.equal((await run(mode,root,"read")).canaryMatch,true);
  const data=first.roots.dataRoot;
  const backup=path.join(data,"backups","consistent-snapshot");
  assert.ok(fs.existsSync(path.join(backup,"memory.sqlite")));assert.ok(fs.existsSync(path.join(backup,"memory.sqlite.auth")));
  const restored=path.join(output,mode+"-backup-restore"),restoredData=path.join(restored,"isolated","Firefly-test","memory","data");
  fs.mkdirSync(restoredData,{recursive:true});
  for(const name of ["memory.sqlite","memory.sqlite.auth"])fs.copyFileSync(path.join(backup,name),path.join(restoredData,name),fs.constants.COPYFILE_EXCL);
  fs.copyFileSync(path.join(data,"memory-key.protected"),path.join(restoredData,"memory-key.protected"),fs.constants.COPYFILE_EXCL);
  assert.equal((await run(mode,restored,"read")).canaryMatch,true);
  const wrong=path.join(output,mode+"-different-key");assert.equal((await run(mode,wrong,"basic")).ok,true);
  const wrongProtected=fs.readFileSync(path.join(wrong,"isolated","Firefly-test","memory","data","memory-key.protected"));
  const live=path.join(output,mode+"-live-wal");
  const held=await run(mode,live,"hold",true);assert.equal(held.ok,true);
  const liveData=held.roots.dataRoot;assert.ok(fs.statSync(path.join(liveData,"memory.sqlite-wal")).size>0);
  const original=snapshot(liveData),keyFile=path.join(liveData,"memory-key.protected"),key=fs.readFileSync(keyFile);
  for(const kind of ["wrong","missing","corrupt"]){
   if(kind==="missing")fs.unlinkSync(keyFile);else fs.writeFileSync(keyFile,kind==="wrong"?wrongProtected:Buffer.from("invalid synthetic protected key"));
   try{const refused=await run(mode,live,"reject",false,undefined,{wrong:"MEMORY_AUTH_FAILED",missing:"MEMORY_KEY_UNAVAILABLE",corrupt:"MEMORY_KEY_FORMAT_UNSUPPORTED"}[kind]);assert.equal(refused.ok,false);assert.ok(/^MEMORY_/.test(refused.error));assert.deepEqual(snapshot(liveData),original)}finally{fs.writeFileSync(keyFile,key)}
  }
  const authFile=path.join(liveData,"memory.sqlite.auth"),auth=fs.readFileSync(authFile);
  for(const kind of ["schema","key-version","corrupt"]){
   const changed=Buffer.from(auth);
   if(kind==="schema")changed.writeUInt32LE(99,4);else if(kind==="key-version")changed.writeUInt32LE(99,8);else changed[changed.length-1]^=1;
   fs.writeFileSync(authFile,changed);const unchanged=snapshot(liveData);
   try{const result=await run(mode,live,"reject",false,undefined,kind==="corrupt"?"MEMORY_AUTH_FAILED":"MEMORY_SCHEMA_UNSUPPORTED");assert.equal(result.ok,false);assert.deepEqual(snapshot(liveData),unchanged)}
   finally{fs.writeFileSync(authFile,auth)}
  }
  assert.equal((await run(mode,live,"read")).canaryMatch,true);
  const boundaries=[];
  for(const stage of ["key-protected","key-pending-opened","key-pending-written","key-pending-fsynced","key-pending-validated","key-published","key-key-ready","auth-pending-opened","auth-pending-written","auth-pending-fsynced","auth-pending-validated","auth-published","auth-ready"]){
   const boundaryRoot=path.join(output,mode+"-"+stage);
   const stopped=await run(mode,boundaryRoot,"basic",true,stage);assert.equal(stopped.stage,stage);
   const dataRoot=path.join(boundaryRoot,"isolated","Firefly-test","memory","data");
   for(const name of ["memory.sqlite","memory.sqlite-wal","memory.sqlite-shm"])assert.equal(fs.existsSync(path.join(dataRoot,name)),false);
   const names=fs.existsSync(dataRoot)?fs.readdirSync(dataRoot).sort():[];
   const before=Object.fromEntries(names.map(name=>[name,fs.readFileSync(path.join(dataRoot,name))]));
   const mustRefuse=stage==="key-pending-opened"||stage==="auth-pending-opened";
   const reopened=await run(mode,boundaryRoot,mustRefuse?"reject":"basic",false,undefined,mustRefuse?(stage==="key-pending-opened"?"MEMORY_KEY_FORMAT_UNSUPPORTED":"MEMORY_AUTH_INVALID"):undefined);
   if(mustRefuse){
    assert.equal(reopened.ok,false);assert.match(reopened.error,/^MEMORY_/);
    assert.deepEqual(fs.readdirSync(dataRoot).sort(),names);
    for(const name of names)assert.deepEqual(fs.readFileSync(path.join(dataRoot,name)),before[name]);
   }else{
    assert.equal(reopened.ok,true);
    for(const name of ["memory-key.protected","memory.sqlite.auth"]){
     const previous=before[name]??before[name+".pending"];
     if(previous)assert.deepEqual(fs.readFileSync(path.join(dataRoot,name)),previous);
    }
   }
   boundaries.push({stage,noDatabaseBeforeKeyReady:true,result:mustRefuse?"REFUSED_UNCHANGED":"RECOVERED"});
  }
  gates[mode]={ciphertextSwapRejected:"PASS",authVersionAndCorruptionZeroChange:"PASS",initializationBoundaries:boundaries,jobs:"PASS",trustedFactsAndRevisions:"PASS",rollback:"PASS",scope:"PASS",forgetReadBarrier:"PASS",openReopen:"PASS",actualWorker:"PASS",appAsar:mode==="packaged"?"PASS":"NOT_APPLICABLE",dpapi:"PASS",idempotentConcurrent:"PASS",consistentBackup:"PASS",cleanShutdown:"PASS",killReopen:"PASS",liveWalWrongMissingAndCorruptKeyZeroChange:"PASS",backupRestore:"PASS"};
 }
 const report={gate:"PASS",baseline:"be6beede628e6e00dc6304355af4ab3dd65f919c",gates,runs,productionAccess:"NONE",wrongValidProtectedKey:"PASS",backupRestore:"PASS",initialAuthKillBoundaries:"PASS",powerLoss:"NOT_RUN",systemRebootNewModule:"NOT_RUN",canaryScan:scanCanaries(output)};
 fs.writeFileSync(path.join(output,"report.json"),JSON.stringify(report,null,2));
 console.log(JSON.stringify({gate:report.gate,report:path.join(output,"report.json")}));
}catch(error){
 fs.writeFileSync(path.join(output,"report.json"),JSON.stringify({gate:"FAIL",error:error.message,gates,runs},null,2));throw error;
}

function scanCanaries(root){
 const needle=Buffer.from("FIREFLY_SYNTHETIC_\u4e2d\u6587_English_\u6df7\u5408_\ud83c\udf40_CANARY");
 const needles=[needle,Buffer.from(needle.toString(),"utf16le")];let checked=0;
 function visit(dir){
  for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
   if(["app-source","win-unpacked"].includes(entry.name))continue;
   const file=path.join(dir,entry.name);
   if(entry.isDirectory())visit(file);
   else if(entry.isFile()){
    const bytes=fs.readFileSync(file);checked++;
    if(needles.some(n=>bytes.includes(n)))throw Error("PROBE_CANARY_LEAK:"+path.relative(root,file));
   }
  }
 }
 visit(root);return {gate:"PASS",files:checked,utf8:true,utf16le:true};
}
