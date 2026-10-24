import {assertProbeRoot} from "./probe-root";
import fs from "node:fs";
import path from "node:path";
import {loadOrCreateMemoryKey,type KeyStage} from "../../../src/main/memory-core/protected-key";
import {copyMemoryKeyBytes} from "../../../src/main/memory-core/key-provider";
import {createWindowsKeyProtection} from "../../../src/main/memory-core/windows-dpapi";
import {sealPayload,openPayload} from "../../../src/main/memory-core/payload-codec";
const cwd=process.cwd(),root=process.argv.find(a=>a.startsWith("--root="))?.slice(7),pause=process.argv.find(a=>a.startsWith("--pause="))?.slice(8);
assertProbeRoot(cwd,root);
const roots={dataRoot:path.join(root,"data"),indexRoot:path.join(root,"index"),tempRoot:path.join(root,"temp")};
(async()=>{
 let handle;
 try{
  handle=await loadOrCreateMemoryKey({roots,protection:createWindowsKeyProtection(roots.tempRoot),checkpoint:async(stage:KeyStage)=>{
   if(stage===pause){console.log(JSON.stringify({stage}));await new Promise<void>(()=>{})}
  }});
  const key=copyMemoryKeyBytes(handle),binding={recordType:"integration",id:"synthetic-fixture",schemaVersion:1,keyVersion:1};
  const fixture=path.join(roots.dataRoot,"synthetic-fixture.aead"),canary=Buffer.from("合成记忆 中文 English 混合🌱");
  try{
   if(!fs.existsSync(fixture)){const fd=fs.openSync(fixture,"wx");try{fs.writeFileSync(fd,sealPayload(key,binding,canary));fs.fsyncSync(fd)}finally{fs.closeSync(fd)}}
   const recovered=openPayload(key,binding,fs.readFileSync(fixture));const match=recovered.equals(canary);recovered.fill(0);
   if(!match)throw new Error("CANARY_MISMATCH");
   console.log(JSON.stringify({ok:true,canaryMatch:match,versions:{electron:process.versions.electron,node:process.versions.node,sqlite:process.versions.sqlite}}));
  }finally{key.fill(0);canary.fill(0)}
 }catch(error){console.log(JSON.stringify({ok:false,error:error instanceof Error?error.message:"TEST_FAILED"}));process.exitCode=1}
 finally{await handle?.destroy()}
})();
