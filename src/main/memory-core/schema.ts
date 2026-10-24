import type {DatabaseSync} from "node:sqlite";
import {ENTITY_TABLES} from "./repository-types";
export const MEMORY_SCHEMA_VERSION=12;
function baseSchema(db:DatabaseSync,databaseId:string){
 db.exec("CREATE TABLE memory_metadata (singleton INTEGER PRIMARY KEY CHECK(singleton=1), database_id TEXT NOT NULL, key_version INTEGER NOT NULL CHECK(key_version=1)) STRICT");
 db.prepare("INSERT INTO memory_metadata VALUES (1,?,1)").run(databaseId);
 for(const table of ENTITY_TABLES){
  const parent=table==="candidates"?"evidence":table==="current_facts"?"fact_revisions":null;
  db.exec("CREATE TABLE "+table+" (id TEXT NOT NULL,scope_key TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),source_id TEXT,parent_id TEXT,state TEXT NOT NULL,payload BLOB NOT NULL,PRIMARY KEY(id,scope_key),FOREIGN KEY(source_id,scope_key) REFERENCES sources(id,scope_key)"+(parent?",FOREIGN KEY(parent_id,scope_key) REFERENCES "+parent+"(id,scope_key)":"")+") STRICT");
 }
 db.exec("CREATE TABLE command_receipts (command_id TEXT PRIMARY KEY,scope_key TEXT NOT NULL,request_digest BLOB NOT NULL,result BLOB NOT NULL) STRICT");
}
function factSchema(db:DatabaseSync){
 db.exec("ALTER TABLE fact_revisions ADD COLUMN fact_id TEXT; ALTER TABLE fact_revisions ADD COLUMN event_kind TEXT CHECK(event_kind IS NULL OR event_kind IN ('assertion','supersession','forget')); ALTER TABLE current_facts ADD COLUMN subject_index BLOB CHECK(subject_index IS NULL OR length(subject_index)=32)");
 db.exec("CREATE UNIQUE INDEX fact_revision_identity ON fact_revisions(scope_key,fact_id,revision,event_kind) WHERE fact_id IS NOT NULL; CREATE UNIQUE INDEX current_subject_identity ON current_facts(scope_key,subject_index) WHERE state='active' AND subject_index IS NOT NULL");
 db.exec("CREATE TRIGGER revisions_no_update BEFORE UPDATE ON fact_revisions BEGIN SELECT RAISE(ABORT,'immutable revision'); END; CREATE TRIGGER revisions_no_delete BEFORE DELETE ON fact_revisions BEGIN SELECT RAISE(ABORT,'immutable revision'); END");
 db.exec("CREATE TRIGGER revision_identity BEFORE INSERT ON fact_revisions WHEN NEW.event_kind IS NOT NULL AND (NEW.fact_id IS NULL OR (NEW.event_kind<>'assertion' AND NOT EXISTS(SELECT 1 FROM fact_revisions WHERE id=NEW.parent_id AND scope_key=NEW.scope_key AND fact_id=NEW.fact_id AND revision=NEW.revision AND event_kind='assertion'))) BEGIN SELECT RAISE(ABORT,'revision identity'); END");
 for(const operation of ["INSERT","UPDATE"]){
  db.exec("CREATE TRIGGER current_identity_"+operation+" BEFORE "+operation+" ON current_facts WHEN NEW.subject_index IS NOT NULL AND NOT EXISTS(SELECT 1 FROM fact_revisions WHERE id=NEW.parent_id AND scope_key=NEW.scope_key AND fact_id=NEW.id AND revision=NEW.revision AND event_kind='assertion') BEGIN SELECT RAISE(ABORT,'current identity'); END");
 }
 for(const table of ENTITY_TABLES)for(const operation of ["INSERT","UPDATE"]){
  db.exec("CREATE TRIGGER state_"+table+"_"+operation+" BEFORE "+operation+" ON "+table+" WHEN NEW.state NOT IN ('recorded','proposed','active','superseded','forgotten','pending','running','complete','invalidated') BEGIN SELECT RAISE(ABORT,'unknown state'); END");
 }
}
export function initializeSchema(db:DatabaseSync,databaseId:string):void{
 const version=db.prepare("PRAGMA user_version").get()?.user_version;
 if(![0,1,2,3,4,5,6,7,8,9,10,11,12].includes(version as number))throw new Error("MEMORY_SCHEMA_UNSUPPORTED");
 if(version!==0){
  const metadata=db.prepare("SELECT database_id,key_version FROM memory_metadata WHERE singleton=1").get();
  if(metadata?.database_id!==databaseId||metadata.key_version!==1)throw new Error("MEMORY_DATABASE_AUTH_MISMATCH");
 }
 if(version===0||version===1){
  if(version===0&&db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get()?.n!==0)throw new Error("MEMORY_SCHEMA_UNSUPPORTED");
  if(version===1&&(db.prepare("SELECT count(*) AS n FROM fact_revisions").get()?.n!==0||db.prepare("SELECT count(*) AS n FROM current_facts").get()?.n!==0))throw new Error("MEMORY_SCHEMA_UNSUPPORTED");
  db.exec("BEGIN IMMEDIATE");
  try{if(version===0)baseSchema(db,databaseId);factSchema(db);db.exec("PRAGMA user_version=2; COMMIT")}
  catch(error){db.exec("ROLLBACK");throw error}
 }
 if(version===0||version===1||version===2){
  db.exec("BEGIN IMMEDIATE");
  try{db.exec("CREATE TABLE scope_suppression (scope_key TEXT PRIMARY KEY,generation INTEGER NOT NULL CHECK(generation>=0),payload BLOB NOT NULL) STRICT; PRAGMA user_version=3; COMMIT")}
  catch(error){db.exec("ROLLBACK");throw error}
 }
 if((version as number)<4){
  db.exec("BEGIN IMMEDIATE");
  try{db.exec("CREATE TABLE source_heads (scope_key TEXT NOT NULL,locator_index BLOB NOT NULL CHECK(length(locator_index)=32),source_id TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('ready','pending','deleted')),payload BLOB NOT NULL,PRIMARY KEY(scope_key,locator_index),UNIQUE(source_id,scope_key),FOREIGN KEY(source_id,scope_key) REFERENCES sources(id,scope_key)) STRICT; CREATE TABLE source_generations (scope_key TEXT NOT NULL,source_id TEXT NOT NULL,generation_index BLOB NOT NULL CHECK(length(generation_index)=32),PRIMARY KEY(scope_key,source_id,generation_index),FOREIGN KEY(source_id,scope_key) REFERENCES source_heads(source_id,scope_key)) STRICT; PRAGMA user_version=4; COMMIT")}
  catch(error){db.exec("ROLLBACK");throw error}
 }
 if((version as number)<5){
  db.exec("BEGIN IMMEDIATE");
  try{db.exec("CREATE TABLE policy_records (id TEXT NOT NULL,scope_key TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),payload BLOB NOT NULL,PRIMARY KEY(id,scope_key)) STRICT; PRAGMA user_version=5; COMMIT")}
  catch(error){db.exec("ROLLBACK");throw error}
 }
 if((version as number)<6){
  db.exec("BEGIN IMMEDIATE");
  try{db.exec("CREATE TABLE fact_supports(id TEXT NOT NULL,scope_key TEXT NOT NULL,fact_id TEXT NOT NULL,fact_revision INTEGER NOT NULL CHECK(fact_revision>0),payload BLOB NOT NULL,PRIMARY KEY(id,scope_key)) STRICT; CREATE INDEX supports_by_fact ON fact_supports(scope_key,fact_id); CREATE TABLE fact_reviews(id TEXT NOT NULL,scope_key TEXT NOT NULL,fact_id TEXT NOT NULL,payload BLOB NOT NULL,PRIMARY KEY(id,scope_key)) STRICT; CREATE INDEX reviews_by_fact ON fact_reviews(scope_key,fact_id); PRAGMA user_version=6; COMMIT")}
  catch(error){db.exec("ROLLBACK");throw error}
 }
 if((version as number)<7){
  db.exec("BEGIN IMMEDIATE");
  try{db.exec("CREATE TABLE context_records(id TEXT NOT NULL,scope_key TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('snapshot','permit','transcript','summary-lease','summary')),revision INTEGER NOT NULL CHECK(revision>0),payload BLOB NOT NULL,PRIMARY KEY(id,scope_key)) STRICT;CREATE INDEX context_records_by_kind ON context_records(scope_key,kind);PRAGMA user_version=7;COMMIT")}
  catch(error){db.exec("ROLLBACK");throw error}
 }
 if((version as number)<8){
  db.exec("BEGIN IMMEDIATE");
  try{db.exec("CREATE TABLE recall_records(id TEXT NOT NULL,scope_key TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('policy','state','use')),revision INTEGER NOT NULL CHECK(revision>0),payload BLOB NOT NULL,PRIMARY KEY(id,scope_key)) STRICT;CREATE INDEX recall_records_by_kind ON recall_records(scope_key,kind);PRAGMA user_version=8;COMMIT")}
  catch(error){db.exec("ROLLBACK");throw error}
 }
 if((version as number)<9){
  db.exec("BEGIN IMMEDIATE");
  try{db.exec("CREATE TABLE history_records(id TEXT NOT NULL,scope_key TEXT NOT NULL,partition_index BLOB NOT NULL CHECK(length(partition_index)=32),kind TEXT NOT NULL CHECK(kind IN ('document','quarantine')),payload BLOB NOT NULL,PRIMARY KEY(id,scope_key)) STRICT;CREATE INDEX history_records_by_partition ON history_records(scope_key,partition_index,kind);PRAGMA user_version=9;COMMIT")}
  catch(error){db.exec("ROLLBACK");throw error}
 }
 if((version as number)<10){
  db.exec("BEGIN IMMEDIATE");
  try{db.exec("CREATE TABLE shadow_records(id TEXT NOT NULL,scope_key TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('control','record','attempt','stats')),payload BLOB NOT NULL,PRIMARY KEY(id,scope_key)) STRICT;CREATE INDEX shadow_records_by_kind ON shadow_records(scope_key,kind);PRAGMA user_version=10;COMMIT")}
  catch(error){db.exec("ROLLBACK");throw error}
 }
 if((version as number)<11){
  db.exec("BEGIN IMMEDIATE");
  try{db.exec("DROP INDEX current_subject_identity; CREATE INDEX current_subject_identity ON current_facts(scope_key,subject_index) WHERE state='active' AND subject_index IS NOT NULL; PRAGMA user_version=11; COMMIT")}
  catch(error){db.exec("ROLLBACK");throw error}
 }
 if((version as number)<12){
  db.exec("BEGIN IMMEDIATE");
  try{db.exec("CREATE TABLE history_origins(id TEXT NOT NULL,scope_key TEXT NOT NULL,payload BLOB NOT NULL,PRIMARY KEY(id,scope_key)) STRICT; PRAGMA user_version=12; COMMIT")}
  catch(error){db.exec("ROLLBACK");throw error}
 }
 const metadata=db.prepare("SELECT database_id,key_version FROM memory_metadata WHERE singleton=1").get();
 if(metadata?.database_id!==databaseId||metadata.key_version!==1)throw new Error("MEMORY_DATABASE_AUTH_MISMATCH");
}
