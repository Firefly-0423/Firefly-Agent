/** Dedicated SQLite owner. This module is loaded only inside a Main-created Worker. */
import {isMainThread,parentPort,workerData} from "node:worker_threads";
import {openMemoryRepository} from "./repository";
import {objectFields,parseInternalId} from "./command-validation";
import type {BatchCommand,EntityTable} from "./repository-types";
if(isMainThread||!parentPort)throw new Error("MEMORY_WORKER_REQUIRED");
const port=parentPort,key=workerData?.key;
let closing=false;
const repository=(()=>{try{return openMemoryRepository({databasePath:workerData.databasePath,key})}finally{if(key instanceof Uint8Array)key.fill(0)}})();
let queue=Promise.resolve();
port.on("message",(message:unknown)=>{
 queue=queue.then(async()=>{
  const input=message as {id:number;type:string;body:unknown};
  if(!input||!Number.isSafeInteger(input.id)||input.id<1)throw new Error("MEMORY_PROTOCOL_INVALID");
  if(closing){port.postMessage({id:input.id,ok:false,error:"MEMORY_CLIENT_CLOSED"});return}
  try{
   let result:unknown;
   switch(input.type){
    case "batch":result=repository.writeBatch(input.body as BatchCommand);break;
    case "job":result=repository.jobCommand(input.body);break;
    case "policy":result=repository.policyCommand(input.body);break;
    case "context":result=repository.contextCommand(input.body);break;
    case "recall":result=repository.recallCommand(input.body);break;
    case "historical":result=repository.historyCommand(input.body);break;
    case "shadow":result=repository.shadowCommand(input.body);break;
    case "source":result=repository.sourceCommand(input.body);break;
    case "execute":result=repository.execute(input.body);break;
    case "current":{const body=objectFields(input.body,["scopeKey"]);result=repository.current(parseInternalId(body.scopeKey));break}
    case "history":{const body=objectFields(input.body,["scopeKey","factId"]);result=repository.history(parseInternalId(body.scopeKey),parseInternalId(body.factId));break}
    case "rows":{const body=input.body as {table:EntityTable;scopeKey:string};result=repository.readRows(body.table,body.scopeKey);break}
    case "backup":result=await repository.backup((input.body as {backupId?:string}).backupId);break;
    case "close":closing=true;repository.close();result=null;break;
    default:throw new Error("MEMORY_PROTOCOL_INVALID");
   }
   port.postMessage({id:input.id,ok:true,result});
   if(closing)port.close();
  }catch(error){
   const code=error instanceof Error&&/^MEMORY_[A-Z_]+$/.test(error.message)?error.message:"MEMORY_TRANSACTION_FAILED";
   port.postMessage({id:input.id,ok:false,error:code});
  }
 }).catch(()=>{closing=true;repository.close();port.close();process.exitCode=1});
});
port.postMessage({type:"ready"});
