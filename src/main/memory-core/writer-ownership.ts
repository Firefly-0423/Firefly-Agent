import path from "node:path";
import {createServer} from "node:net";
import {createHash} from "node:crypto";
import {canonicalPath} from "../runtime-profile";
import type {OpenLease} from "./key-provider";
/**
 * Main directly owns this kernel resource for the entire worker lifetime.
 * No external lock helper can die independently and release writer ownership.
 * Node's Windows libuv binding uses FIRST_PIPE_INSTANCE, rejecting another server.
 * https://nodejs.org/download/release/v24.18.0/docs/api/net.html#ipc-support
 */
export async function acquireWriterOwnership(dataRoot:string):Promise<OpenLease>{
 if(process.platform!=="win32"||!path.isAbsolute(dataRoot))throw new Error("MEMORY_WINDOWS_REQUIRED");
 const identity=canonicalPath(dataRoot).toLowerCase(),name="\\\\.\\pipe\\FireflyMemoryWriter-"+createHash("sha256").update(identity).digest("hex");
 const server=createServer(socket=>{socket.on("error",()=>{});socket.destroy()});
 let releasing=false,closed=false,failed=false;
 const listeners=new Set<()=>void>();
 const lost=()=>{failed=true;for(const callback of listeners)queueMicrotask(callback)};
 server.on("error",()=>{if(server.listening&&!releasing)lost()});
 server.on("close",()=>{closed=true;if(!releasing)lost()});
 await new Promise<void>((resolve,reject)=>{
  server.once("error",(error:NodeJS.ErrnoException)=>reject(new Error(error.code==="EADDRINUSE"?"MEMORY_OPEN_BUSY":"MEMORY_WRITER_LOCK_FAILED")));
  server.listen({path:name,exclusive:true},resolve);
 });
 let releaseResult:Promise<void>|undefined;
 return {
  assertHeld(){if(closed||failed||releasing||!server.listening)throw new Error("MEMORY_WRITER_LOCK_LOST")},
  onLost(callback){listeners.add(callback);if(failed||closed)queueMicrotask(callback);return()=>{listeners.delete(callback)}},
  release(){
   if(releaseResult)return releaseResult;releasing=true;
   releaseResult=new Promise<void>((resolve,reject)=>{if(closed){resolve();return}server.close(error=>error?reject(new Error("MEMORY_WRITER_LOCK_LOST")):resolve())});
   return releaseResult;
  }
 };
}
