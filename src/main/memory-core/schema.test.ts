import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {randomBytes} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import {it,expect} from "vitest";
import {ensureDatabaseAuth} from "./database-auth";
import {openMemoryRepository} from "./repository";
import {MEMORY_SCHEMA_VERSION} from "./schema";
import {ENTITY_TABLES} from "./repository-types";
it("upgrades a schema-equivalent v6 fixture to the current schema",()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"memory-context-v6-")),databasePath=path.join(root,"memory.sqlite"),key=randomBytes(32);
 try{let repo=openMemoryRepository({databasePath,key});repo.writeBatch({commandId:"v6",scopeKey:"scope-a",records:[{table:"sources",id:"v6-source",revision:1,payload:{text:"V6_RECORD_CANARY"}}]});repo.close();let db=new DatabaseSync(databasePath);const payload=db.prepare("SELECT payload FROM sources WHERE id='v6-source'").get()?.payload;db.exec("DROP TABLE IF EXISTS history_origins; DROP TABLE IF EXISTS shadow_records; DROP TABLE IF EXISTS history_records; DROP TABLE IF EXISTS recall_records; DROP TABLE IF EXISTS context_records; PRAGMA user_version=6");db.close();repo=openMemoryRepository({databasePath,key});repo.close();db=new DatabaseSync(databasePath);try{expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(MEMORY_SCHEMA_VERSION);expect(db.prepare("SELECT name FROM sqlite_master WHERE name='context_records'").get()?.name).toBe("context_records");expect(db.prepare("SELECT payload FROM sources WHERE id='v6-source'").get()?.payload).toEqual(payload)}finally{db.close()}}
 finally{key.fill(0);fs.rmSync(root,{recursive:true,force:true})}
});
it("failed v7 context migration rolls back new table and leaves v6 unchanged",()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"memory-context-rollback-")),databasePath=path.join(root,"memory.sqlite"),key=randomBytes(32);
 try{const repo=openMemoryRepository({databasePath,key});repo.close();let db=new DatabaseSync(databasePath);db.exec("DROP TABLE IF EXISTS history_origins; DROP TABLE IF EXISTS shadow_records; DROP TABLE IF EXISTS history_records; DROP TABLE IF EXISTS recall_records; DROP TABLE IF EXISTS context_records;CREATE INDEX context_records_by_kind ON sources(scope_key); PRAGMA user_version=6");db.close();expect(()=>{const opened=openMemoryRepository({databasePath,key});opened.close()}).toThrow();db=new DatabaseSync(databasePath);try{expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(6);expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='context_records'").get()).toBeUndefined()}finally{db.close()}}
 finally{key.fill(0);fs.rmSync(root,{recursive:true,force:true})}
});
it.each([3,4,5])("migrates a schema-equivalent prior schema %s fixture without rewriting encrypted records",version=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"memory-support-schema-")),databasePath=path.join(root,"memory.sqlite"),key=randomBytes(32);
 try{
  let repo=openMemoryRepository({databasePath,key});repo.writeBatch({commandId:"old-schema-record",scopeKey:"scope-a",records:[{table:"sources",id:"legacy-fixture",revision:1,payload:{text:"encrypted legacy canary"}}]});repo.close();
  let db=new DatabaseSync(databasePath);const original=db.prepare("SELECT payload FROM sources WHERE id='legacy-fixture'").get()?.payload;
  db.exec("DROP TABLE history_origins; DROP TABLE shadow_records; DROP TABLE history_records; DROP TABLE recall_records; DROP TABLE context_records; DROP TABLE fact_supports; DROP TABLE fact_reviews"+(version<=4?"; DROP TABLE policy_records":"")+(version===3?"; DROP TABLE source_generations; DROP TABLE source_heads":"")+"; PRAGMA user_version="+version);db.close();
  repo=openMemoryRepository({databasePath,key});expect(repo.readRows("sources","scope-a")[0].payload).toEqual({text:"encrypted legacy canary"});repo.close();
  db=new DatabaseSync(databasePath);try{expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(MEMORY_SCHEMA_VERSION);expect(db.prepare("SELECT payload FROM sources WHERE id='legacy-fixture'").get()?.payload).toEqual(original)}finally{db.close()}
 }finally{key.fill(0);fs.rmSync(root,{recursive:true,force:true})}
});
it("failed v5 support migration rolls back its tables and schema version",()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"memory-support-rollback-")),databasePath=path.join(root,"memory.sqlite"),key=randomBytes(32);
 try{const repo=openMemoryRepository({databasePath,key});repo.close();let db=new DatabaseSync(databasePath);db.exec("DROP TABLE history_origins; DROP TABLE shadow_records; DROP TABLE history_records; DROP TABLE recall_records; DROP TABLE context_records; DROP TABLE fact_supports; PRAGMA user_version=5");db.close();expect(()=>openMemoryRepository({databasePath,key})).toThrow();db=new DatabaseSync(databasePath);try{expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(5);expect(db.prepare("SELECT name FROM sqlite_master WHERE name='fact_supports'").get()).toBeUndefined()}finally{db.close()}}
 finally{key.fill(0);fs.rmSync(root,{recursive:true,force:true})}
});
it("rejects mismatched v1 database identity before any schema migration or file change",()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"memory-schema-auth-")),databasePath=path.join(root,"memory.sqlite"),key=randomBytes(32);
 try{
  ensureDatabaseAuth(databasePath,key);
  const db=new DatabaseSync(databasePath);
  db.exec("CREATE TABLE memory_metadata(singleton INTEGER PRIMARY KEY,database_id TEXT,key_version INTEGER); INSERT INTO memory_metadata VALUES(1,'different-database-identity',1)");
  for(const table of ENTITY_TABLES)db.exec("CREATE TABLE "+table+" (id TEXT,scope_key TEXT,revision INTEGER,source_id TEXT,parent_id TEXT,state TEXT,payload BLOB)");
  db.exec("CREATE TABLE command_receipts(command_id TEXT,scope_key TEXT,request_digest BLOB,result BLOB); PRAGMA user_version=1");db.close();
  const snapshot=()=>fs.readdirSync(root).sort().map(name=>({name,bytes:fs.readFileSync(path.join(root,name)),mtime:fs.statSync(path.join(root,name)).mtimeMs}));
  const before=snapshot();expect(()=>openMemoryRepository({databasePath,key})).toThrow("MEMORY_DATABASE_AUTH_MISMATCH");expect(snapshot()).toEqual(before);
  const check=new DatabaseSync(databasePath,{readOnly:true});
  try{expect(check.prepare("PRAGMA user_version").get()?.user_version).toBe(1);expect(check.prepare("SELECT name FROM pragma_table_info('current_facts') WHERE name='subject_index'").get()).toBeUndefined()}finally{check.close()}
 }finally{key.fill(0);fs.rmSync(root,{recursive:true,force:true})}
});

it.each(["mismatched-key-version","migrate-empty-v1","refuse-nonempty-facts"])("handles legacy schema boundary %s explicitly",kind=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"memory-schema-v1-")),databasePath=path.join(root,"memory.sqlite"),key=randomBytes(32);
 try{
  const identity=ensureDatabaseAuth(databasePath,key),db=new DatabaseSync(databasePath);
  db.exec("CREATE TABLE memory_metadata(singleton INTEGER PRIMARY KEY,database_id TEXT,key_version INTEGER)");
  db.prepare("INSERT INTO memory_metadata VALUES(1,?,?)").run(identity,kind==="mismatched-key-version"?2:1);
  for(const table of ENTITY_TABLES){
   const parent=table==="candidates"?"evidence":table==="current_facts"?"fact_revisions":null;
   db.exec("CREATE TABLE "+table+" (id TEXT NOT NULL,scope_key TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),source_id TEXT,parent_id TEXT,state TEXT NOT NULL,payload BLOB NOT NULL,PRIMARY KEY(id,scope_key),FOREIGN KEY(source_id,scope_key) REFERENCES sources(id,scope_key)"+(parent?",FOREIGN KEY(parent_id,scope_key) REFERENCES "+parent+"(id,scope_key)":"")+") STRICT");
  }
  db.exec("CREATE TABLE command_receipts(command_id TEXT PRIMARY KEY,scope_key TEXT NOT NULL,request_digest BLOB NOT NULL,result BLOB NOT NULL) STRICT;PRAGMA user_version=1");
  if(kind==="refuse-nonempty-facts")db.prepare("INSERT INTO fact_revisions VALUES('legacy','scope-a',1,NULL,NULL,'recorded',?)").run(Buffer.from("synthetic unsupported legacy payload"));
  db.close();
  const snapshot=()=>fs.readdirSync(root).sort().map(name=>({name,bytes:fs.readFileSync(path.join(root,name)),mtime:fs.statSync(path.join(root,name)).mtimeMs}));
  const before=snapshot();
  if(kind==="migrate-empty-v1"){const repository=openMemoryRepository({databasePath,key});repository.close();const check=new DatabaseSync(databasePath,{readOnly:true});try{expect(check.prepare("PRAGMA user_version").get()?.user_version).toBe(MEMORY_SCHEMA_VERSION)}finally{check.close()}}
  else{expect(()=>openMemoryRepository({databasePath,key})).toThrow(kind==="mismatched-key-version"?"MEMORY_DATABASE_AUTH_MISMATCH":"MEMORY_SCHEMA_UNSUPPORTED");expect(snapshot()).toEqual(before)}
 }finally{key.fill(0);fs.rmSync(root,{recursive:true,force:true})}
});
