import fs from "node:fs";
import path from "node:path";
import {backup as sqliteBackup,type DatabaseSync} from "node:sqlite";
import {ensureDatabaseAuth} from "./database-auth";
import {internalId} from "./repository-types";
export interface MemoryBackupResult {readonly backupId:string}
function flush(file:string){const fd=fs.openSync(file,"r+");try{fs.fsyncSync(fd)}finally{fs.closeSync(fd)}}
/** Entire directory is published only after a consistent DB and authenticated header are flushed. */
export async function createMemoryBackup(input:{db:DatabaseSync;databasePath:string;key:Uint8Array;databaseId:string;backupId:string}):Promise<MemoryBackupResult>{
 try{internalId(input.backupId)}catch{throw new Error("MEMORY_BACKUP_INVALID")}
 if(process.platform!=="win32")throw new Error("MEMORY_WINDOWS_REQUIRED");
 if(ensureDatabaseAuth(input.databasePath,input.key)!==input.databaseId)throw new Error("MEMORY_DATABASE_AUTH_MISMATCH");
 const dataRoot=fs.realpathSync.native(path.dirname(input.databasePath)),root=path.join(dataRoot,"backups");
 if(fs.existsSync(root)&&(fs.lstatSync(root).isSymbolicLink()||fs.realpathSync.native(root).toLowerCase()!==root.toLowerCase()))throw new Error("MEMORY_BACKUP_INVALID");
 fs.mkdirSync(root,{recursive:true});
 const destination=path.join(root,input.backupId);
 if(fs.existsSync(destination))throw new Error("MEMORY_BACKUP_EXISTS");
 const staging=fs.mkdtempSync(path.join(root,".pending-")),database=path.join(staging,"memory.sqlite");
 try{
  await sqliteBackup(input.db,database);
  const auth=fs.readFileSync(input.databasePath+".auth"),fd=fs.openSync(database+".auth","wx");
  try{fs.writeFileSync(fd,auth);fs.fsyncSync(fd)}finally{fs.closeSync(fd)}
  if(ensureDatabaseAuth(database,input.key)!==input.databaseId)throw new Error("MEMORY_DATABASE_AUTH_MISMATCH");
  flush(database);
  // Windows directory rename refuses an existing destination, including empty directories.
  fs.renameSync(staging,destination);
  return {backupId:input.backupId};
 }finally{
  if(fs.existsSync(staging)){
   const stat=fs.lstatSync(staging);
   if(stat.isSymbolicLink())fs.unlinkSync(staging);
   else if(fs.realpathSync.native(staging).toLowerCase()===staging.toLowerCase())fs.rmSync(staging,{recursive:true,force:true});
   // If an alias replaced our staging directory, leave it untouched and fail closed.
  }
 }
}
