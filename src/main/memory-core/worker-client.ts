import path from "node:path";
import {Worker} from "node:worker_threads";
import {createStorageContext,type StorageContext} from "../storage-context";
import {canonicalPath,assertRuntimePathsOwned} from "../runtime-profile";
import {loadOrCreateMemoryKey} from "./protected-key";
import {copyMemoryKeyBytes,assertMemoryKeyOpenLease,type KeyProtection,type MemoryKeyHandle,type OpenLease} from "./key-provider";
import {acquireWriterOwnership} from "./writer-ownership";
import type {MemoryBackupResult} from "./backups";
import type {BatchCommand,BatchResult,EntityTable,MemoryRow} from "./repository-types";
export interface MemoryWorkerPort {
 postMessage(message:unknown):void;
 on(event:"message"|"error"|"exit",listener:(...args:any[])=>void):unknown;
 terminate():Promise<number>;
}
interface OpenOptions {
 storage:StorageContext;keyProtection:KeyProtection;
 workerFactory?:(data:{databasePath:string;key:Uint8Array})=>MemoryWorkerPort;
 writerLeaseFactory?:(dataRoot:string,tempRoot:string)=>Promise<OpenLease>;
}
interface Pending {resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}
const DEADLINE=5000;
export class MemoryClient {
 private state:"opening"|"open"|"closing"|"closed"="opening";
 private readonly pending=new Map<number,Pending>();private sequence=0;
 private readyResolve!:()=>void;private readyReject!:(error:Error)=>void;
 private readonly ready:Promise<void>;private readyTimer:ReturnType<typeof setTimeout>;
 private finished!:()=>void;private finishedReject!:(error:Error)=>void;readonly closed:Promise<void>;
 private failureCode:string|undefined;private cleanupResult:Promise<void>|undefined;private closeResult:Promise<void>|undefined;
 private unsubscribe=()=>{};private exitObserved=false;private acknowledgedClose=false;
 private terminationFailed=false;private resourceReleaseResult:Promise<void>|undefined;
 private constructor(private readonly worker:MemoryWorkerPort,private readonly writer:OpenLease,private readonly key:MemoryKeyHandle){
  this.closed=new Promise((resolve,reject)=>{this.finished=resolve;this.finishedReject=reject});
  void this.closed.catch(()=>{}); // Idle cleanup failures remain observable without an unhandled rejection.
  this.ready=new Promise((resolve,reject)=>{this.readyResolve=resolve;this.readyReject=reject});
  this.readyTimer=setTimeout(()=>this.fail("MEMORY_WORKER_TIMEOUT"),DEADLINE);
  worker.on("message",message=>this.receive(message));worker.on("error",()=>this.fail("MEMORY_WORKER_FAILED"));
  worker.on("exit",(code:number)=>{
   this.exitObserved=true;
   if(this.terminationFailed){void this.releaseResources();return}
   if(this.state==="closing"&&this.acknowledgedClose&&code===0){this.state="closed";void this.cleanup()}
   else this.fail("MEMORY_WORKER_FAILED");
  });
 }
 static async open(input:OpenOptions):Promise<MemoryClient>{
  const expected=createStorageContext(input.storage.profile);
  for(const name of ["dataRoot","indexRoot","tempRoot"] as const){
   if(canonicalPath(input.storage.memory[name]).toLowerCase()!==canonicalPath(expected.memory[name]).toLowerCase())throw new Error("MEMORY_STORAGE_INVALID");
  }
  assertRuntimePathsOwned(input.storage.profile,Object.values(input.storage.memory));
  const writer=await(input.writerLeaseFactory??((data)=>acquireWriterOwnership(data)))(canonicalPath(input.storage.memory.dataRoot),input.storage.memory.tempRoot);
  let handle:MemoryKeyHandle|undefined,client:MemoryClient|undefined,lost=false;
  const unsubscribe=writer.onLost(()=>{lost=true;client?.fail("MEMORY_WRITER_LOCK_LOST")});
  const held=()=>{if(lost)throw new Error("MEMORY_WRITER_LOCK_LOST");writer.assertHeld()};
  try{
   held();handle=await loadOrCreateMemoryKey({roots:input.storage.memory,protection:input.keyProtection,checkpoint:held});held();
   const bytes=copyMemoryKeyBytes(handle);let worker:MemoryWorkerPort;
   try{
    worker=(input.workerFactory??(data=>new Worker(path.join(__dirname,"worker.js"),{workerData:data,execArgv:[]})))({databasePath:path.join(input.storage.memory.dataRoot,"memory.sqlite"),key:bytes});
   }finally{bytes.fill(0)}
   client=new MemoryClient(worker,writer,handle);client.unsubscribe=unsubscribe;
   await client.ready;held();assertMemoryKeyOpenLease(handle);
   await handle.destroy();held();client.state="open";return client;
  }catch(error){
   if(client){client.fail(error instanceof Error&&/^MEMORY_[A-Z_]+$/.test(error.message)?error.message:"MEMORY_WORKER_FAILED");await client.closed}
   else{unsubscribe();await handle?.destroy().catch(()=>{});await writer.release().catch(()=>{})}
   throw error;
  }
 }
 private receive(message:unknown):void{
  if(!message||typeof message!=="object"){this.fail("MEMORY_PROTOCOL_INVALID");return}
  const input=message as {type?:string;id?:number;ok?:boolean;error?:string;result?:unknown};
  if(input.type==="ready"&&this.state==="opening"){clearTimeout(this.readyTimer);this.readyResolve();return}
  if(!Number.isSafeInteger(input.id)||typeof input.ok!=="boolean"){this.fail("MEMORY_PROTOCOL_INVALID");return}
  const pending=this.pending.get(input.id!);
  if(!pending){this.fail("MEMORY_PROTOCOL_INVALID");return}
  this.pending.delete(input.id!);clearTimeout(pending.timer);
  if(input.ok){if(this.state==="closing"&&input.id===this.sequence)this.acknowledgedClose=true;pending.resolve(input.result)}
  else pending.reject(new Error(typeof input.error==="string"&&/^MEMORY_[A-Z_]+$/.test(input.error)?input.error:"MEMORY_WORKER_FAILED"));
 }
 private fail(code:string):void{
  if(this.state==="closed")return;
  this.failureCode=code;this.state="closed";clearTimeout(this.readyTimer);this.readyReject(new Error(code));
  for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(new Error(code))}
  this.pending.clear();void this.cleanup();
 }
 private cleanup():Promise<void>{
  if(this.cleanupResult)return this.cleanupResult;
  this.cleanupResult=Promise.resolve().then(async()=>{
   this.unsubscribe();clearTimeout(this.readyTimer);
   if(!this.exitObserved){
    try{await this.worker.terminate()}
    catch{
     if(!this.exitObserved){
      this.terminationFailed=true;
      this.finishedReject(new Error("MEMORY_WORKER_CLEANUP_FAILED"));
      return; // A live worker still owns the profile; only a later observed exit can release it.
     }
    }
   }
   await this.releaseResources();
  });
  return this.cleanupResult;
 }
 private releaseResources():Promise<void>{
  if(this.resourceReleaseResult)return this.resourceReleaseResult;
  this.resourceReleaseResult=Promise.resolve().then(async()=>{
   const results=await Promise.allSettled([this.key.destroy(),this.writer.release()]);
   if(results.some(result=>result.status==="rejected")){
    this.finishedReject(new Error("MEMORY_OWNERSHIP_CLEANUP_FAILED"));
   }else this.finished();
  });
  return this.resourceReleaseResult;
 }
 private request<T>(type:string,body:unknown,shutdown=false):Promise<T>{
  if(!shutdown&&this.state!=="open")return Promise.reject(new Error("MEMORY_CLIENT_CLOSED"));
  try{this.writer.assertHeld()}catch{this.fail("MEMORY_WRITER_LOCK_LOST");return Promise.reject(new Error("MEMORY_WRITER_LOCK_LOST"))}
  if(this.pending.size>=256&&!shutdown)return Promise.reject(new Error("MEMORY_QUEUE_FULL"));
  const id=++this.sequence;
  return new Promise<T>((resolve,reject)=>{
   const timer=setTimeout(()=>this.fail("MEMORY_WORKER_TIMEOUT"),DEADLINE);
   this.pending.set(id,{resolve:value=>resolve(value as T),reject,timer});
   try{this.worker.postMessage({id,type,body})}catch{this.fail("MEMORY_PROTOCOL_INVALID")}
  });
 }
 jobCommand(command:unknown):Promise<unknown>{return this.request("job",command)}
 policyCommand(command:unknown):Promise<unknown>{return this.request("policy",command)}
 contextCommand(command:unknown):Promise<unknown>{return this.request("context",command)}
 recallCommand(command:unknown):Promise<unknown>{return this.request("recall",command)}
 historyCommand(command:unknown):Promise<unknown>{return this.request("historical",command)}
 shadowCommand(command:unknown):Promise<unknown>{return this.request("shadow",command)}
 execute(command:unknown):Promise<import("../../shared/memory-contracts").MutationResult>{return this.request("execute",command)}
 sourceCommand(command:unknown):Promise<unknown>{return this.request("source",command)}
 current(scope:string):Promise<import("../../shared/memory-contracts").FactView[]>{return this.request("current",{scopeKey:scope})}
 history(scope:string,id:string):Promise<import("../../shared/memory-contracts").FactView[]>{return this.request("history",{scopeKey:scope,factId:id})}
 writeBatch(input:BatchCommand):Promise<BatchResult>{return this.request("batch",input)}
 readRows(table:EntityTable,scopeKey:string):Promise<MemoryRow[]>{return this.request("rows",{table,scopeKey})}
 backup(backupId?:string):Promise<MemoryBackupResult>{return this.request("backup",backupId===undefined?{}:{backupId})}
 close():Promise<void>{
  if(this.closeResult)return this.closeResult;
  if(this.state==="closed")return this.closed;
  this.state="closing";
  this.closeResult=(async()=>{
   const timer=setTimeout(()=>this.fail("MEMORY_WORKER_TIMEOUT"),DEADLINE);
   try{await this.request("close",null,true);await this.closed;if(this.failureCode)throw new Error(this.failureCode)}finally{clearTimeout(timer)}
  })();
  return this.closeResult;
 }
}
