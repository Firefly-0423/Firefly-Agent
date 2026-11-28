import fs from "node:fs";
import path from "node:path";
import {randomBytes,timingSafeEqual} from "node:crypto";
import {sealPayload,openPayload} from "./payload-codec";
const MAGIC=Buffer.from("FMA1"),HEADER=28,MARKER=Buffer.from("FireflyMemoryDatabaseAuth-v1");
function decode(bytes:Buffer,key:Uint8Array):string{
 if(bytes.length<HEADER+40||bytes.length>256||!bytes.subarray(0,4).equals(MAGIC))throw new Error("MEMORY_AUTH_INVALID");
 if(bytes.readUInt32LE(4)!==1||bytes.readUInt32LE(8)!==1)throw new Error("MEMORY_SCHEMA_UNSUPPORTED");
 const id=bytes.subarray(12,28).toString("hex");
 const value=openPayload(key,{recordType:"database-auth",id,schemaVersion:1,keyVersion:1},bytes.subarray(HEADER));
 try{if(!value.equals(MARKER))throw new Error("MEMORY_AUTH_FAILED")}finally{value.fill(0)}
 return id;
}
function read(file:string):Buffer{
 const stat=fs.lstatSync(file);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size>256)throw new Error("MEMORY_AUTH_INVALID");
 return fs.readFileSync(file);
}
function flush(file:string):void{const fd=fs.openSync(file,"r+");try{fs.fsyncSync(fd)}finally{fs.closeSync(fd)}}
/** Runs before DatabaseSync construction; invalid existing state never causes initialization. */
export function ensureDatabaseAuth(databasePath:string,key:Uint8Array):string{
 const file=databasePath+".auth",pending=file+".pending";
 if(fs.existsSync(file)){
  const bytes=read(file),id=decode(bytes,key);
  if(fs.existsSync(pending)){
   const other=read(pending);decode(other,key);
   if(bytes.length!==other.length||!timingSafeEqual(bytes,other))throw new Error("MEMORY_AUTH_PUBLICATION_CONFLICT");
   flush(file);fs.unlinkSync(pending);
  }
  return id;
 }
 if(["","-wal","-shm"].some(s=>fs.existsSync(databasePath+s)))throw new Error("MEMORY_AUTH_UNAVAILABLE");
 fs.mkdirSync(path.dirname(file),{recursive:true});
 if(!fs.existsSync(pending)){
  const header=Buffer.alloc(HEADER);MAGIC.copy(header);header.writeUInt32LE(1,4);header.writeUInt32LE(1,8);randomBytes(16).copy(header,12);
  const id=header.subarray(12,28).toString("hex"),bytes=Buffer.concat([header,sealPayload(key,{recordType:"database-auth",id,schemaVersion:1,keyVersion:1},MARKER)]);
  const fd=fs.openSync(pending,"wx");
  try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd)}finally{fs.closeSync(fd)}
 }
 const bytes=read(pending),id=decode(bytes,key);flush(pending);
 fs.linkSync(pending,file);flush(file);decode(read(file),key);fs.unlinkSync(pending);return id;
}
