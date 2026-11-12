/** Kernel-owned Windows lease; no expiration once the handshake succeeds. */
import fs from "node:fs";
import path from "node:path";
import {createHash} from "node:crypto";
import {spawn} from "node:child_process";
import type {OpenLease} from "./key-provider";
const SYSTEM_ROOT="C:\\Windows";
const SCRIPT=`
$ErrorActionPreference='Stop'
$mutex=$null;$owned=$false
try {
 $name=[Console]::In.ReadLine()
 if($name -notmatch '^Global\\\\FireflyMemory(Open|Writer)-[a-f0-9]{64}$'){throw 'invalid name'}
 $mutex=[Threading.Mutex]::new($false,$name)
 try{$owned=$mutex.WaitOne(0)}catch [Threading.AbandonedMutexException]{$owned=$true}
 if(-not $owned){exit 2}
 [Console]::Out.WriteLine('MEMORY_LOCK_READY');[Console]::Out.Flush()
 $null=[Console]::In.ReadLine()
} catch {exit 1}
finally{if($owned){$mutex.ReleaseMutex()};if($mutex){$mutex.Dispose()}}
`;
/** Fixed supported Windows installation. Host environment is checked, never used as an executable selector. */
export function windowsHelperConfig(tempRoot:string):{binary:string;cwd:string;env:NodeJS.ProcessEnv}{
 if(process.platform!=="win32"||!path.isAbsolute(tempRoot))throw new Error("MEMORY_WINDOWS_REQUIRED");
 const supplied=process.env.SystemRoot;
 if(!supplied||!path.isAbsolute(supplied)||path.resolve(supplied).toLowerCase()!==SYSTEM_ROOT.toLowerCase())throw new Error("MEMORY_HELPER_PATH_INVALID");
 const segments=["System32","WindowsPowerShell","v1.0","powershell.exe"];
 let binary=SYSTEM_ROOT;
 try{
  for(const segment of ["",...segments]){
   if(segment)binary=path.join(binary,segment);
   const stat=fs.lstatSync(binary);
   if(stat.isSymbolicLink()||fs.realpathSync.native(binary).toLowerCase()!==binary.toLowerCase())throw new Error("alias");
  }
  if(!fs.statSync(binary).isFile())throw new Error("not executable");
 }catch{throw new Error("MEMORY_HELPER_PATH_INVALID")}
 fs.mkdirSync(tempRoot,{recursive:true});
 const root=fs.realpathSync.native(tempRoot);
 return {binary,cwd:root,env:{...process.env,TEMP:root,TMP:root,TMPDIR:root,APPDATA:path.join(root,"appdata"),LOCALAPPDATA:path.join(root,"localappdata"),PSModuleAnalysisCachePath:path.join(root,"ps-modules"),DOTNET_CLI_HOME:root,DOTNET_SKIP_FIRST_TIME_EXPERIENCE:"1",POWERSHELL_TELEMETRY_OPTOUT:"1"}};
}
export async function acquireMemoryOpenLease(canonicalDataRoot:string,tempRoot:string,purpose:"Open"|"Writer"="Open"):Promise<OpenLease>{
 const config=windowsHelperConfig(tempRoot);
 const name="Global\\FireflyMemory"+purpose+"-"+createHash("sha256").update(canonicalDataRoot.toLowerCase()).digest("hex");
 const child=spawn(config.binary,["-NoLogo","-NoProfile","-NonInteractive","-Command",SCRIPT],{...config,windowsHide:true,stdio:["pipe","pipe","pipe"]});
 let closed=false,released=false,ready=false,failed=false,output=""; const lost=new Set<()=>void>();
 let finish!:(code:number|null)=>void;
 const ended=new Promise<number|null>(resolve=>{finish=resolve});
 const terminate=()=>{failed=true;if(!closed)child.kill()};
 const timer=setTimeout(terminate,10000);
 child.once("close",code=>{closed=true;clearTimeout(timer);finish(code);if(!released)for(const callback of lost)queueMicrotask(callback)});
 child.stdin.on("error",terminate);child.stderr.on("data",terminate);
 const handshake=new Promise<void>((resolve,reject)=>{
  child.once("error",()=>{failed=true;reject(new Error("MEMORY_OPEN_LOCK_FAILED"))});
  child.once("close",code=>{if(!ready)reject(new Error(code===2?"MEMORY_OPEN_BUSY":"MEMORY_OPEN_LOCK_FAILED"))});
  child.stdout.on("data",(chunk:Buffer)=>{
   output+=chunk.toString("ascii");
   if(output.length>32||(!"MEMORY_LOCK_READY\r\n".startsWith(output)&&!"MEMORY_LOCK_READY\n".startsWith(output))){terminate();return}
   if(output==="MEMORY_LOCK_READY\r\n"||output==="MEMORY_LOCK_READY\n"){ready=true;clearTimeout(timer);resolve()}
  });
 });
 child.stdin.write(name+"\n");
 try{await handshake}catch(error){child.stdin.end();if(!closed)child.kill();await ended;throw error}
 let releaseResult:Promise<void>|undefined;
 return {onLost(callback:()=>void){lost.add(callback);if(closed&&!released)queueMicrotask(callback);return()=>{lost.delete(callback)}},assertHeld(){if(!ready||closed||failed||released)throw new Error("MEMORY_OPEN_LOCK_LOST")},release(){
  if(releaseResult)return releaseResult;
  released=true;
  releaseResult=(async()=>{
   const releaseTimer=setTimeout(terminate,10000);child.stdin.end();
   try{const code=await ended;if(failed||code!==0)throw new Error("MEMORY_OPEN_LOCK_LOST")}
   finally{clearTimeout(releaseTimer)}
  })();
  return releaseResult;
 }};
}
