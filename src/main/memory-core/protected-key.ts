import fs from "node:fs";
import path from "node:path";
import {randomBytes,timingSafeEqual} from "node:crypto";
import type {StorageContext} from "../storage-context";
import {canonicalPath,within} from "../runtime-profile";
import {createMemoryKeyHandle,type KeyProtection,type MemoryKeyHandle} from "./key-provider";
import {acquireMemoryOpenLease} from "./windows-open-lock";
const MAGIC=Buffer.from("FMK1"),MAX=65536;
export type KeyStage="protected"|"pending-opened"|"pending-written"|"pending-fsynced"|"pending-validated"|"published"|"key-ready";
export async function loadOrCreateMemoryKey(input:{roots:StorageContext["memory"];protection:KeyProtection;checkpoint?:(stage:KeyStage)=>void|Promise<void>}):Promise<MemoryKeyHandle>{
 const {roots,protection}=input;
 const paths=Object.values(roots);
 if(paths.length!==3||paths.some(p=>typeof p!=="string"||!path.isAbsolute(p)))throw new Error("MEMORY_ROOTS_INVALID");
 const canonical=paths.map(p=>canonicalPath(p).toLowerCase());
 for(let i=0;i<3;i++)for(let j=i+1;j<3;j++)if(within(canonical[i],canonical[j])||within(canonical[j],canonical[i]))throw new Error("MEMORY_ROOTS_OVERLAP");
 const lease=await acquireMemoryOpenLease(canonicalPath(roots.dataRoot),roots.tempRoot);
 const file=path.join(roots.dataRoot,"memory-key.protected"),pending=file+".pending";
 const sync=(p:string)=>{lease.assertHeld();const fd=fs.openSync(p,"r+");try{fs.fsyncSync(fd)}finally{fs.closeSync(fd)}};
 const stage=async(s:KeyStage)=>{lease.assertHeld();await input.checkpoint?.(s);lease.assertHeld()};
 async function read(p:string):Promise<Buffer>{
  const stat=fs.lstatSync(p);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size<8||stat.size>MAX)throw new Error("MEMORY_KEY_FORMAT_UNSUPPORTED");
  const blob=fs.readFileSync(p);
  if(!blob.subarray(0,4).equals(MAGIC)||blob.readUInt32LE(4)!==1)throw new Error("MEMORY_KEY_FORMAT_UNSUPPORTED");
  let plaintext:Uint8Array|undefined;
  try{plaintext=await protection.unprotect(blob.subarray(8));const key=Buffer.from(plaintext);if(key.length!==32){key.fill(0);throw new Error("invalid key")}return key}
  catch{throw new Error("MEMORY_PROTECTED_KEY_INVALID")}
  finally{plaintext?.fill(0)}
 }
 let key:Buffer|undefined;
 try{
  if(fs.existsSync(file)){
   key=await read(file);
   if(fs.existsSync(pending)){const other=await read(pending);try{if(!timingSafeEqual(key,other))throw new Error("MEMORY_KEY_PUBLICATION_CONFLICT")}finally{other.fill(0)}sync(file);fs.unlinkSync(pending)}
  }else{
   if(["",".auth","-wal","-shm"].some(s=>fs.existsSync(path.join(roots.dataRoot,"memory.sqlite"+s))))throw new Error("MEMORY_KEY_UNAVAILABLE");
   if(!fs.existsSync(pending)){
    const generated=randomBytes(32);let blob:Buffer;
    try{const sealed=Buffer.from(await protection.protect(generated));if(sealed.length===0||sealed.length>MAX-8)throw new Error("MEMORY_PROTECTED_KEY_INVALID");
     const header=Buffer.alloc(8);MAGIC.copy(header);header.writeUInt32LE(1,4);blob=Buffer.concat([header,sealed])
    }finally{generated.fill(0)}
    await stage("protected");fs.mkdirSync(roots.dataRoot,{recursive:true});
    const fd=fs.openSync(pending,"wx");
    try{await stage("pending-opened");fs.writeFileSync(fd,blob);await stage("pending-written");fs.fsyncSync(fd);await stage("pending-fsynced")}finally{fs.closeSync(fd)}
   }else{const checked=await read(pending);checked.fill(0);sync(pending)}
   key=await read(pending);await stage("pending-validated");fs.linkSync(pending,file);await stage("published");sync(file);
   const final=await read(file);try{if(!timingSafeEqual(key,final))throw new Error("MEMORY_KEY_PUBLICATION_CONFLICT")}finally{final.fill(0)}
   fs.unlinkSync(pending);await stage("key-ready");
  }
  lease.assertHeld();return createMemoryKeyHandle(key,lease);
 }catch(error){await lease.release();throw error}
 finally{key?.fill(0)}
}
