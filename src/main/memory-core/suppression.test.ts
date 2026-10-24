import {randomBytes} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import {afterEach,beforeEach,describe,expect,it} from "vitest";
import type {FactView,SourceRef} from "../../shared/memory-contracts";
import {RecordCodec} from "./record-codec";
import {Suppression} from "./suppression";

const SCOPE="scope-a";
let db:DatabaseSync;
let key:Uint8Array;
let codec:RecordCodec;
let suppression:Suppression;

function createTables(database:DatabaseSync):void{
 database.exec(`
  CREATE TABLE fact_revisions(id TEXT NOT NULL,scope_key TEXT NOT NULL,fact_id TEXT,event_kind TEXT,payload BLOB NOT NULL,PRIMARY KEY(id,scope_key));
  CREATE TABLE deletion_markers(id TEXT NOT NULL,scope_key TEXT NOT NULL,revision INTEGER NOT NULL,source_id TEXT,parent_id TEXT,state TEXT,payload BLOB NOT NULL,PRIMARY KEY(id,scope_key));
  CREATE TABLE scope_suppression(scope_key TEXT PRIMARY KEY,generation INTEGER NOT NULL,payload BLOB NOT NULL);
 `);
}
function addAssertion(scope:string,id:string,factId:string,subjectKey:string,sourceId:string,revision=1):void{
 const payload={factId,subjectKey,sourceRef:{sourceId,revision},provenance:{activationSourceRef:{sourceId:`activation-${sourceId}`,revision}}};
 db.prepare("INSERT INTO fact_revisions(id,scope_key,fact_id,event_kind,payload) VALUES(?,?,?,'assertion',?)").run(id,scope,factId,codec.seal("fact_revisions",scope,id,payload));
}
function addMarker(scope:string,id:string,value:Record<string,unknown>):void{
 db.prepare("INSERT INTO deletion_markers(id,scope_key,revision,payload) VALUES(?,?,1,?)").run(id,scope,codec.seal("deletion_markers",scope,id,value));
}
function tx<T>(operation:()=>T):T{
 db.exec("BEGIN");
 try{const value=operation();db.exec("COMMIT");return value}catch(error){db.exec("ROLLBACK");throw error}
}
function view(overrides:Partial<FactView>={}):FactView{
 return{
  factId:"fact-a",revision:1,subjectKey:"coffee",assertion:"likes coffee",assertionKind:"user-statement",
  time:{validFrom:null,validTo:null,referenceTime:null},sourceRef:{sourceId:"source-a",revision:1},
  recordedAt:1,acceptedAt:1,supersededAt:null,activationReason:"policyAccepted",policyVersion:null,
  provenance:{candidateId:null,evidenceId:null,activationSourceRef:{sourceId:"activation-source-a",revision:1}},
  ...overrides,
 };
}

beforeEach(()=>{
 db=new DatabaseSync(":memory:");
 createTables(db);
 key=randomBytes(32);
 codec=new RecordCodec(key);
 suppression=new Suppression(db,key);
});
afterEach(()=>{db.close()});

describe("Suppression.generation",()=>{
 it("falls back to the number of markers when no scope row exists",()=>{
  addMarker(SCOPE,"marker-1",{factId:"fact-a",sourceRef:{sourceId:"source-a",revision:1},origins:[{sourceId:"source-a",revision:1}],subjects:["coffee"]});
  addMarker(SCOPE,"marker-2",{factId:"fact-b",sourceRef:{sourceId:"source-b",revision:1},origins:[{sourceId:"source-b",revision:1}],subjects:["tea"]});
  expect(suppression.generation(SCOPE)).toBe(2);
 });
 it("returns the stored generation and validates its payload",()=>{
  tx(()=>expect(suppression.advance(SCOPE)).toBe(1));
  expect(suppression.generation(SCOPE)).toBe(1);
 });
 it("rejects a negative generation and a row/payload mismatch",()=>{
  db.prepare("INSERT INTO scope_suppression VALUES(?,?,?)").run(SCOPE,-1,codec.seal("scope_suppression",SCOPE,SCOPE,{generation:-1}));
  expect(()=>suppression.generation(SCOPE)).toThrow("MEMORY_DATA_INVALID");
  db.exec("DELETE FROM scope_suppression");
  db.prepare("INSERT INTO scope_suppression VALUES(?,?,?)").run(SCOPE,2,codec.seal("scope_suppression",SCOPE,SCOPE,{generation:1}));
  expect(()=>suppression.generation(SCOPE)).toThrow("MEMORY_DATA_INVALID");
 });
 it("rejects malformed markers",()=>{
  addMarker(SCOPE,"bad-marker",{sourceRef:{sourceId:"source-a",revision:1}});
  expect(()=>suppression.generation(SCOPE)).toThrow("MEMORY_DATA_INVALID");
 });
});

describe("Suppression.advance",()=>{
 it("requires an active transaction",()=>{
  expect(()=>suppression.advance(SCOPE)).toThrow("MEMORY_TRANSACTION_REQUIRED");
 });
 it("increments and persists the generation inside a transaction",()=>{
  tx(()=>expect(suppression.advance(SCOPE)).toBe(1));
  tx(()=>expect(suppression.advance(SCOPE)).toBe(2));
  expect(suppression.generation(SCOPE)).toBe(2);
 });
});

describe("Suppression.sourceBlocked / subjectBlocked",()=>{
 it("blocks source references at or below a forgotten origin revision",()=>{
  addMarker(SCOPE,"marker",{factId:"fact-a",sourceRef:{sourceId:"source-a",revision:2},origins:[{sourceId:"source-a",revision:2}],subjects:["coffee"]});
  expect(suppression.sourceBlocked(SCOPE,{sourceId:"source-a",revision:1})).toBe(true);
  expect(suppression.sourceBlocked(SCOPE,{sourceId:"source-a",revision:2})).toBe(true);
  expect(suppression.sourceBlocked(SCOPE,{sourceId:"source-a",revision:3})).toBe(false);
  expect(suppression.sourceBlocked(SCOPE,{sourceId:"source-b",revision:1})).toBe(false);
 });
 it("derives origins and subjects from assertion views when a marker lacks them",()=>{
  addAssertion(SCOPE,"assertion-1","fact-a","coffee","source-a",2);
  addMarker(SCOPE,"marker",{factId:"fact-a",sourceRef:{sourceId:"source-a",revision:2}});
  expect(suppression.sourceBlocked(SCOPE,{sourceId:"source-a",revision:1})).toBe(true);
  expect(suppression.sourceBlocked(SCOPE,{sourceId:"activation-source-a",revision:1})).toBe(true);
  expect(suppression.subjectBlocked(SCOPE,"coffee")).toBe(true);
  expect(suppression.subjectBlocked(SCOPE,"tea")).toBe(false);
 });
 it("checks explicit subject lists",()=>{
  addMarker(SCOPE,"marker",{factId:"fact-a",sourceRef:{sourceId:"source-a",revision:1},origins:[],subjects:["coffee","tea"]});
  expect(suppression.subjectBlocked(SCOPE,"coffee")).toBe(true);
  expect(suppression.subjectBlocked(SCOPE,"water")).toBe(false);
 });
});

describe("Suppression.includeOrigins",()=>{
 it("requires a transaction and appends only new, deduplicated origins",()=>{
  const original:SourceRef={sourceId:"source-a",revision:1};
  addMarker(SCOPE,"marker",{factId:"fact-a",sourceRef:original,origins:[original],subjects:["coffee"]});
  const extra:SourceRef={sourceId:"source-b",revision:3};
  expect(()=>suppression.includeOrigins(SCOPE,"fact-a",[extra])).toThrow("MEMORY_TRANSACTION_REQUIRED");
  tx(()=>suppression.includeOrigins(SCOPE,"fact-a",[extra,extra,original]));
  expect(suppression.sourceBlocked(SCOPE,extra)).toBe(true);
  tx(()=>suppression.includeOrigins(SCOPE,"fact-a",[extra]));
  expect(suppression.sourceBlocked(SCOPE,extra)).toBe(true);
 });
 it("leaves markers for other facts unchanged",()=>{
  addMarker(SCOPE,"marker-a",{factId:"fact-a",sourceRef:{sourceId:"source-a",revision:1},origins:[{sourceId:"source-a",revision:1}],subjects:["coffee"]});
  addMarker(SCOPE,"marker-b",{factId:"fact-b",sourceRef:{sourceId:"source-b",revision:1},origins:[{sourceId:"source-b",revision:1}],subjects:["tea"]});
  tx(()=>suppression.includeOrigins(SCOPE,"fact-a",[{sourceId:"source-c",revision:1}]));
  expect(suppression.sourceBlocked(SCOPE,{sourceId:"source-c",revision:1})).toBe(true);
 });
});

describe("Suppression.forget",()=>{
 it("requires a transaction",()=>{
  expect(()=>suppression.forget(SCOPE,view(),{sourceId:"forget",revision:1},1)).toThrow("MEMORY_TRANSACTION_REQUIRED");
 });
 it("creates a barrier from all assertion views and advances the generation",()=>{
  addAssertion(SCOPE,"assertion-1","fact-a","coffee","source-a",1);
  addAssertion(SCOPE,"assertion-2","fact-a","coffee","source-b",2);
  const generation=tx(()=>{
   suppression.forget(SCOPE,view({sourceRef:{sourceId:"source-a",revision:1}}),{sourceId:"forget-event",revision:1},123);
   return suppression.generation(SCOPE);
  });
  expect(generation).toBe(1);
  expect(suppression.sourceBlocked(SCOPE,{sourceId:"source-a",revision:1})).toBe(true);
  expect(suppression.sourceBlocked(SCOPE,{sourceId:"source-b",revision:2})).toBe(true);
  expect(suppression.sourceBlocked(SCOPE,{sourceId:"activation-source-b",revision:2})).toBe(true);
  expect(suppression.subjectBlocked(SCOPE,"coffee")).toBe(true);
 });
 it("keeps old markers after a later forget",()=>{
  addAssertion(SCOPE,"assertion-1","fact-a","coffee","source-a",1);
  tx(()=>suppression.forget(SCOPE,view(),{sourceId:"forget-1",revision:1},1));
  addAssertion(SCOPE,"assertion-2","fact-b","tea","source-b",1);
  tx(()=>suppression.forget(SCOPE,view({factId:"fact-b",subjectKey:"tea",sourceRef:{sourceId:"source-b",revision:1}}),{sourceId:"forget-2",revision:1},2));
  expect(suppression.generation(SCOPE)).toBe(2);
  expect(suppression.sourceBlocked(SCOPE,{sourceId:"source-a",revision:1})).toBe(true);
  expect(suppression.sourceBlocked(SCOPE,{sourceId:"source-b",revision:1})).toBe(true);
 });
});
