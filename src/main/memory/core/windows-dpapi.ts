import {spawn} from "node:child_process";
import type {KeyProtection} from "./key-provider";
import {windowsHelperConfig} from "./windows-open-lock";
const LIMIT=65536;
const script=(operation:"Protect"|"Unprotect")=>`
$ErrorActionPreference='Stop'
$bytes=$null;$result=$null;$memory=$null
try{
 Add-Type -AssemblyName System.Security
 $memory=New-Object System.IO.MemoryStream
 [Console]::OpenStandardInput().CopyTo($memory)
 $bytes=$memory.ToArray()
 if($bytes.Length -eq 0 -or $bytes.Length -gt 65536){throw 'length'}
 $entropy=[Text.Encoding]::UTF8.GetBytes('Firefly-Memory-v1')
 $result=[Security.Cryptography.ProtectedData]::${operation}($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
 if($result.Length -eq 0 -or $result.Length -gt 65536){throw 'length'}
 $out=[Console]::OpenStandardOutput()
 $magic=[Text.Encoding]::ASCII.GetBytes('FMD1');$out.Write($magic,0,4)
 $length=[BitConverter]::GetBytes([int]$result.Length);$out.Write($length,0,4)
 $out.Write($result,0,$result.Length);$out.Flush()
}catch{[Console]::Error.Write('MEMORY_DPAPI_FAILED');exit 1}
finally{
 if($bytes){[Array]::Clear($bytes,0,$bytes.Length)}
 if($result){[Array]::Clear($result,0,$result.Length)}
 if($memory){$buf=$memory.GetBuffer();[Array]::Clear($buf,0,$buf.Length);$memory.Dispose()}
}
`;
/** Platform adapter only; no safeStorage, shell, per-record subprocess or fallback. */
export function createWindowsKeyProtection(tempRoot:string):KeyProtection{
 const config=windowsHelperConfig(tempRoot);
 async function transform(operation:"Protect"|"Unprotect",value:Uint8Array):Promise<Uint8Array>{
  if(!(value instanceof Uint8Array)||value.length===0||value.length>LIMIT)throw new Error("MEMORY_DPAPI_FAILED");
  const input=Buffer.from(value),chunks:Buffer[]=[];let total=0,failed=false;
  const child=spawn(config.binary,["-NoLogo","-NoProfile","-NonInteractive","-Command",script(operation)],{cwd:config.cwd,env:config.env,windowsHide:true,stdio:["pipe","pipe","pipe"]});
  const timer=setTimeout(()=>{failed=true;child.kill("SIGKILL")},10000);
  child.once("error",()=>{failed=true});
  child.stdin.once("error",()=>{failed=true;child.kill("SIGKILL")});
  child.stderr.on("data",(bytes:Buffer)=>{bytes.fill(0);failed=true;child.kill("SIGKILL")});
  child.stdout.on("data",(bytes:Buffer)=>{
   total+=bytes.length;
   if(total>LIMIT+8){bytes.fill(0);failed=true;child.kill("SIGKILL")}else chunks.push(bytes);
  });
  const closed=new Promise<{code:number|null;signal:NodeJS.Signals|null}>(resolve=>child.once("close",(code,signal)=>resolve({code,signal})));
  child.stdin.end(input);
  let frame:Buffer|undefined;
  try{
   const result=await closed;
   if(failed||result.code!==0||result.signal||total<9)throw new Error("MEMORY_DPAPI_FAILED");
   frame=Buffer.concat(chunks);
   if(frame.subarray(0,4).toString("ascii")!=="FMD1"||frame.readUInt32LE(4)!==frame.length-8)throw new Error("MEMORY_DPAPI_FAILED");
   return Buffer.from(frame.subarray(8));
  }finally{clearTimeout(timer);input.fill(0);frame?.fill(0);for(const chunk of chunks)chunk.fill(0)}
 }
 return {async protect(value){if(value.length!==32)throw new Error("MEMORY_KEY_INVALID");return transform("Protect",value)},async unprotect(blob){return transform("Unprotect",blob)}};
}
