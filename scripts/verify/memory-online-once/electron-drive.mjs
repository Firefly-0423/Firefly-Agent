import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {build} from "esbuild";
import {createPackageWithOptions} from "@electron/asar";
const cwd=process.cwd();assert.equal(path.parse(cwd).root.toUpperCase(),"E:\\");
assert.equal(cwd,process.env.FIREFLY_ONLINE_VERIFY_WORKSPACE);
const output=path.join(cwd,"output/memory-online-once/native-"+Date.now());const source=path.join(output,"app-source");fs.mkdirSync(source,{recursive:true});
await build({entryPoints:["scripts/verify/memory-online-once/electron-entry.ts"],outfile:path.join(source,"entry.cjs"),bundle:true,platform:"node",target:"node24",format:"cjs",external:["electron"]});
fs.writeFileSync(path.join(source,"package.json"),JSON.stringify({name:"firefly-online-synthetic",version:"0.0.0",main:"entry.cjs"}));
const packaged=path.join(output,"win-unpacked");fs.cpSync(path.join(cwd,"node_modules/electron/dist"),packaged,{recursive:true});fs.renameSync(path.join(packaged,"electron.exe"),path.join(packaged,"FireflyOnlineSynthetic.exe"));
await createPackageWithOptions(source,path.join(packaged,"resources/app.asar"),{});
const runs=[];
for(const isPackaged of [false,true]){
 const root=path.join(output,isPackaged?"asar-profile":"development-profile");
 for(const sub of ["temp","appdata","localappdata","cache","logs","user-data"])fs.mkdirSync(path.join(root,sub),{recursive:true});
 const env={...process.env,ELECTRON_RUN_AS_NODE:undefined,TEMP:path.join(root,"temp"),TMP:path.join(root,"temp"),TMPDIR:path.join(root,"temp"),APPDATA:path.join(root,"appdata"),LOCALAPPDATA:path.join(root,"localappdata"),XDG_CACHE_HOME:path.join(root,"cache"),ELECTRON_LOG_FILE:path.join(root,"logs/electron.log"),CHROME_LOG_FILE:path.join(root,"logs/chromium.log")};
 const executable=isPackaged?path.join(packaged,"FireflyOnlineSynthetic.exe"):path.join(cwd,"node_modules/electron/dist/electron.exe");
 const args=[...(isPackaged?[]:[source]),"--probe-root="+root,"--user-data-dir="+path.join(root,"user-data"),"--disk-cache-dir="+path.join(root,"cache"),"--crash-dumps-dir="+path.join(root,"logs/crashes")];
 const child=spawn(executable,args,{cwd,env,windowsHide:true,stdio:["ignore","pipe","pipe"]});let stdout="",stderr="",timedOut=false;
 const timer=setTimeout(()=>{timedOut=true;child.kill();},30000);
 child.stdout.on("data",b=>{if(stdout.length<65536)stdout+=b.toString();});child.stderr.on("data",b=>{if(stderr.length<65536)stderr+=b.toString();});
 const code=await new Promise((resolve,reject)=>{child.on("error",reject);child.on("close",resolve);});clearTimeout(timer);
 fs.writeFileSync(path.join(root,"logs/stdout.log"),stdout);fs.writeFileSync(path.join(root,"logs/stderr.log"),stderr);
 assert.equal(timedOut,false);assert.equal(code,0);const result=JSON.parse(fs.readFileSync(path.join(root,"result.json"),"utf8"));assert.equal(result.realNetworkRequests,0);assert.equal(result.cases.length,3);runs.push({isPackaged,code,result});
}
const result={runs,totalScenarios:6,realNetworkRequests:0,realConfigurationRead:false,realCredentialsRead:false};fs.writeFileSync(path.join(output,"native-results.json"),JSON.stringify(result,null,2));fs.writeFileSync(path.join(cwd,"output/memory-online-once/native-results.json"),JSON.stringify(result,null,2));console.log(JSON.stringify({output,totalScenarios:6,realNetworkRequests:0}));
