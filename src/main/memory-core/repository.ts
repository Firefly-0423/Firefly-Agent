import fs from "node:fs";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {JobRepository} from "./jobs";
import {SourceLedger} from "./source-ledger";
import {FactRepository} from "./fact-repository";
import {PolicyRepository} from "../memory-policy/policy-repository";
import {ContextRepository} from "../memory-context/context-repository";
import {RecallRepository} from "../memory-recall/recall-repository";
import {HistoryRepository} from "../memory-history/history-repository";
import {ShadowRepository} from "../memory-shadow/shadow-repository";
import {executeTransaction} from "./command-transactions";
import {DatabaseSync} from "node:sqlite";
import {ensureDatabaseAuth} from "./database-auth";
import {createMemoryBackup,type MemoryBackupResult} from "./backups";
import {initializeSchema} from "./schema";
import {sealPayload,openPayload} from "./payload-codec";
import {canonicalJson,internalId,entityTable,type BatchCommand,type BatchResult,type EntityTable,type MemoryRow} from "./repository-types";
const STATES=new Set(["recorded","proposed","active","superseded","forgotten","pending","running","complete","invalidated"]);
export class MemoryRepository {
 private closed=false;
 constructor(private readonly db:DatabaseSync,private readonly key:Buffer,private readonly databasePath:string,private readonly databaseId:string,private readonly fault?:(stage:"after-record"|"before-receipt")=>void,private readonly clock:()=>number=Date.now){}
 private assertOpen(){if(this.closed)throw new Error("MEMORY_REPOSITORY_CLOSED")}
 private binding(table:string,scope:string,id:string){return{recordType:table,id:JSON.stringify([scope,id]),schemaVersion:1,keyVersion:1}}
 private seal(table:string,scope:string,id:string,payload:unknown):Buffer{
  const bytes=Buffer.from(canonicalJson(payload));
  try{return sealPayload(this.key,this.binding(table,scope,id),bytes)}finally{bytes.fill(0)}
 }
 private open(table:string,scope:string,id:string,bytes:Uint8Array):unknown{
  const plain=openPayload(this.key,this.binding(table,scope,id),bytes);
  try{return JSON.parse(plain.toString("utf8"))}finally{plain.fill(0)}
 }
 jobCommand(command:unknown):unknown{this.assertOpen();return new JobRepository(this.db,this.key,this.clock,this.fault).execute(command)}
 historyCommand(command:unknown):any{this.assertOpen();return new HistoryRepository(this.db,this.key,this.fault,this.clock).execute(command)}
 shadowCommand(command:unknown):unknown{this.assertOpen();return new ShadowRepository(this.db,this.key,this.fault,this.clock).execute(command)}
 policyCommand(command:unknown):unknown{this.assertOpen();return new PolicyRepository(this.db,this.key,this.fault,this.clock).execute(command)}
 contextCommand(command:unknown):unknown{this.assertOpen();return new ContextRepository(this.db,this.key,this.fault,this.clock).execute(command)}
 recallCommand(command:unknown):unknown{this.assertOpen();return new RecallRepository(this.db,this.key,this.clock,this.fault).execute(command)}
 sourceCommand(command:unknown):unknown{this.assertOpen();return new SourceLedger(this.db,this.key,this.fault).execute(command)}
 execute(command:unknown):import("../../shared/memory-contracts").MutationResult{this.assertOpen();return new FactRepository(this.db,this.key,this.fault).execute(command)}
 current(scope:string):import("../../shared/memory-contracts").FactView[]{this.assertOpen();return new FactRepository(this.db,this.key,this.fault).current(scope)}
 history(scope:string,factId:string):import("../../shared/memory-contracts").FactView[]{this.assertOpen();return new FactRepository(this.db,this.key,this.fault).history(scope,factId)}
 writeBatch(command:BatchCommand):BatchResult{
  this.assertOpen();internalId(command?.commandId);internalId(command.scopeKey);
  if(!Array.isArray(command.records)||command.records.length===0||command.records.length>1000)throw new Error("MEMORY_INPUT_INVALID");
  return executeTransaction({db:this.db,key:this.key,scope:command.scopeKey,commandId:command.commandId,request:command,fault:this.fault,apply:()=>{
   for(const row of command.records){
    entityTable(row.table);internalId(row.id);
    if(!Number.isSafeInteger(row.revision)||row.revision<1)throw new Error("MEMORY_INPUT_INVALID");
    if(row.sourceId!==undefined)internalId(row.sourceId);
    if(row.parentId!==undefined)internalId(row.parentId);
    // Raw batches retain legacy storage fixtures. Managed sources must use the
    // semantic commands, which validate the durable head and bound revision.
    const payloadRef=row.payload&&typeof row.payload==="object"?(row.payload as {sourceRef?:{sourceId?:unknown}}).sourceRef:undefined;
    const sourceIds=[row.sourceId,row.table==="sources"?row.id:undefined,payloadRef&&typeof payloadRef.sourceId==="string"?payloadRef.sourceId:undefined];
    const ledger=new SourceLedger(this.db,this.key);
    if(sourceIds.some(id=>id!==undefined&&ledger.isManaged(command.scopeKey,id)))throw new Error("MEMORY_SOURCE_MANAGED");
    const state=row.state??"recorded";if(!STATES.has(state))throw new Error("MEMORY_INPUT_INVALID");
    this.db.prepare("INSERT INTO "+row.table+" (id,scope_key,revision,source_id,parent_id,state,payload) VALUES (?,?,?,?,?,?,?)")
     .run(row.id,command.scopeKey,row.revision,row.sourceId??null,row.parentId??null,state,this.seal(row.table,command.scopeKey,row.id,row.payload));
    this.fault?.("after-record");
   }
   return{inserted:command.records.length};
  }});
 }

 readRows(table:EntityTable,scopeKey:string):MemoryRow[]{
  this.assertOpen();entityTable(table);internalId(scopeKey);
  return this.db.prepare(`SELECT id,revision,source_id,parent_id,state,payload FROM ${table} WHERE scope_key=? ORDER BY id`).all(scopeKey).map(row=>({
   id:row.id as string,revision:row.revision as number,sourceId:row.source_id as string|null,parentId:row.parent_id as string|null,state:row.state as string,
   payload:this.open(table,scopeKey,row.id as string,row.payload as Uint8Array)
  }));
 }
 async backup(backupId:string=randomUUID()):Promise<MemoryBackupResult>{
  this.assertOpen();return createMemoryBackup({db:this.db,databasePath:this.databasePath,key:this.key,databaseId:this.databaseId,backupId});
 }
 close():void{if(this.closed)return;this.closed=true;try{this.db.close()}finally{this.key.fill(0)}}
}
/** Worker-only entry. Main uses MemoryClient; Renderer never supplies databasePath. */
export function openMemoryRepository(input:{databasePath:string;key:Uint8Array;fault?:(stage:"after-record"|"before-receipt")=>void;clock?:()=>number}):MemoryRepository{
 if(!path.isAbsolute(input.databasePath)||!(input.key instanceof Uint8Array)||input.key.length!==32)throw new Error("MEMORY_INPUT_INVALID");
 const databaseId=ensureDatabaseAuth(input.databasePath,input.key);
 const key=Buffer.from(input.key);let db:DatabaseSync|undefined;
 try{
  db=new DatabaseSync(input.databasePath,{enableForeignKeyConstraints:true,allowExtension:false});
  initializeSchema(db,databaseId);db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
  return new MemoryRepository(db,key,input.databasePath,databaseId,input.fault,input.clock);
 }catch(error){db?.close();key.fill(0);throw error}
}
