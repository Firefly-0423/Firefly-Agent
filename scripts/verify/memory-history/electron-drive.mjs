import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {spawn} from "node:child_process";
import {build} from "esbuild";
import {createPackageWithOptions} from "@electron/asar";
const cwd=process.cwd();assert.equal(cwd,process.env.FIREFLY_HISTORY_VERIFY_WORKSPACE);assert.equal(path.parse(cwd).root.toUpperCase(),"E:\\");
const output=path.join(cwd,"output","memory-h","electron-"+Date.now()),source=path.join(output,"app-source");fs.mkdirSync(source,{recursive:true});
await build({entryPoints:["scripts/verify/memory-history/electron-entry.ts"],outfile:path.join(source,"entry.cjs"),bundle:true,platform:"node",target:"node24",format:"cjs",external:["electron"]});
await build({entryPoints:["src/main/memory-core/worker.ts"],outfile:path.join(source,"worker.cjs"),bundle:true,platform:"node",target:"node24",format:"cjs"});
fs.writeFileSync(path.join(source,"package.json"),JSON.stringify({name:"firefly-history-probe",version:"0.0.0",main:"entry.cjs"}));
await build({entryPoints:["scripts/verify/memory-history/v8-worker.ts"],outfile:path.join(source,"v8-worker.cjs"),bundle:true,platform:"node",target:"node24",format:"cjs"});
const fixture=path.join(cwd,"src/main/memory-history/fixtures/v8-writer"),manifest=JSON.parse(fs.readFileSync(path.join(fixture,"manifest.json"),"utf8"));
const oldWriter=path.join(fixture,"v8-writer.cjs");assert.equal(createHash("sha256").update(fs.readFileSync(oldWriter)).digest("hex"),manifest.hashes["v8-writer.cjs"]);
fs.copyFileSync(oldWriter,path.join(source,"v8-writer.cjs"));fs.copyFileSync(path.join(fixture,"manifest.json"),path.join(source,"v8-manifest.json"));
for(const name of ["@node-rs/jieba","@node-rs/jieba-win32-x64-msvc"]){fs.cpSync(path.join(cwd,"node_modules",name),path.join(source,"node_modules",name),{recursive:true});}
const packaged=path.join(output,"win-unpacked");fs.cpSync(path.join(cwd,"node_modules","electron","dist"),packaged,{recursive:true});fs.renameSync(path.join(packaged,"electron.exe"),path.join(packaged,"FireflyHistoryProbe.exe"));await createPackageWithOptions(source,path.join(packaged,"resources","app.asar"),{unpack:"**/*.node"});
const runs=[];
async function run(packagedMode,root,mode){
 for(const folder of ["temp","appdata","localappdata","cache","logs"])fs.mkdirSync(path.join(root,folder),{recursive:true});
 const env={...process.env,ELECTRON_RUN_AS_NODE:undefined,TEMP:path.join(root,"temp"),TMP:path.join(root,"temp"),TMPDIR:path.join(root,"temp"),APPDATA:path.join(root,"appdata"),LOCALAPPDATA:path.join(root,"localappdata"),XDG_CACHE_HOME:path.join(root,"cache"),PSModuleAnalysisCachePath:path.join(root,"cache","ps-modules"),DOTNET_CLI_HOME:path.join(root,"cache","dotnet"),DOTNET_SKIP_FIRST_TIME_EXPERIENCE:"1",POWERSHELL_TELEMETRY_OPTOUT:"1",ELECTRON_LOG_FILE:path.join(root,"logs","electron.log"),CHROME_LOG_FILE:path.join(root,"logs","chromium.log")};
 const executable=packagedMode?path.join(packaged,"FireflyHistoryProbe.exe"):path.join(cwd,"node_modules","electron","dist","electron.exe"),args=[...(packagedMode?[]:[source]),"--history-probe-root="+root,"--history-probe-mode="+mode,"--user-data-dir="+path.join(root,"early-userdata"),"--disk-cache-dir="+path.join(root,"cache","chromium"),"--crash-dumps-dir="+path.join(root,"logs","crashes")];
 const child=spawn(executable,args,{cwd,env,windowsHide:true,stdio:["ignore","pipe","pipe"]});let stdout="",stderr="",timedOut=false,killing;
 const ended=new Promise((resolve,reject)=>{child.once("error",reject);child.once("close",(code,signal)=>resolve({code,signal}))});
 const timer=setTimeout(()=>{timedOut=true;const owned=spawn("C:\\Windows\\System32\\taskkill.exe",["/PID",String(child.pid),"/T","/F"],{cwd,env,windowsHide:true,stdio:"ignore"});killing=new Promise((resolve,reject)=>{owned.once("error",reject);owned.once("close",code=>code===0?resolve():reject(new Error("OWNED_KILL_FAILED")))})},40000);
 child.stdout.on("data",b=>{if(stdout.length<512*1024)stdout+=b.toString()});child.stderr.on("data",b=>{if(stderr.length<512*1024)stderr+=b.toString()});
 let exit;try{exit=await ended}finally{clearTimeout(timer);await killing}
 const record={packagedMode,root,mode,exit,timedOut};runs.push(record);for(const [name,value] of [["stdout",stdout],["stderr",stderr]])fs.writeFileSync(path.join(root,"logs",mode+"-"+name+".log"),value);fs.writeFileSync(path.join(output,"progress.json"),JSON.stringify({runs},null,2));
 assert.equal(timedOut,false);assert.equal(exit.code,0,stdout+stderr);const result=JSON.parse(fs.readFileSync(path.join(root,"result-"+mode+".json"),"utf8"));assert.equal(result.ok,true);assert.equal(result.packaged,packagedMode);record.result=result;
}
try{for(const packagedMode of [false,true]){const root=path.join(output,packagedMode?"packaged":"development");for(const mode of ["create","reopen","migrate","rollback"])await run(packagedMode,mode==="migrate"||mode==="rollback"?path.join(root,mode):root,mode)}fs.writeFileSync(path.join(output,"result.json"),JSON.stringify({ok:true,runs},null,2));console.log(JSON.stringify({ok:true,runs:runs.length,output}))}catch(error){fs.writeFileSync(path.join(output,"result.json"),JSON.stringify({ok:false,runs,error:error.message},null,2));throw error}
