import fs from "node:fs";import os from "node:os";import path from "node:path";import {randomBytes} from "node:crypto";
import {DatabaseSync} from "node:sqlite";import {it,expect,afterEach,beforeEach,vi} from "vitest";import {openMemoryRepository} from "./repository";
// Real SQLite / filesystem integration cases: the 5 s default is too tight on CI runners, so this file allows 30 s. Other files keep the default.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const roots:string[]=[],repos:ReturnType<typeof openMemoryRepository>[]=[];
afterEach(()=>{vi.restoreAllMocks();for(const repo of repos.splice(0))repo.close();for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true})});
const canary="\u4e2d\u6587\u4f18\u5148 English \u6df7\u5408\ud83c\udf40";
let preparedFixture:ReturnType<typeof createFixture>;
beforeEach(()=>{preparedFixture=createFixture()});
function fixture(){return preparedFixture}
function createFixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"memory-safety-"));roots.push(root);
 const databasePath=path.join(root,"memory.sqlite"),key=randomBytes(32),repo=openMemoryRepository({databasePath,key});repos.push(repo);
 repo.writeBatch({commandId:"seed",scopeKey:"scope-a",records:[{table:"sources",id:"source-a",revision:1,payload:{text:canary}},{table:"sources",id:"source-b",revision:1,payload:{text:canary+" B"}}]});
 return{root,databasePath,key,repo};
}
function snapshot(root:string){return["memory.sqlite","memory.sqlite.auth","memory.sqlite-wal","memory.sqlite-shm"].map(name=>{
 const file=path.join(root,name);return fs.existsSync(file)?{name,bytes:fs.readFileSync(file),mtime:fs.statSync(file).mtimeMs}:{name,absent:true};
})}
it("round trips actual Chinese, English and mixed Unicode without replacement characters",()=>{
 const f=fixture();expect([...canary].some(c=>c.codePointAt(0)!>0x4e00)).toBe(true);
 expect(canary.includes("\ufffd")).toBe(false);f.repo.close();
 const repo=openMemoryRepository({databasePath:f.databasePath,key:f.key});repos.push(repo);
 expect((repo.readRows("sources","scope-a")[0].payload as any).text).toBe(canary);
});
it.each(["schema","key-version"])("rejects altered auth %s before touching live DB/WAL/SHM",kind=>{
 const f=fixture(),auth=f.databasePath+".auth",bytes=fs.readFileSync(auth);bytes.writeUInt32LE(99,kind==="schema"?4:8);fs.writeFileSync(auth,bytes);
 const before=snapshot(f.root);expect(()=>openMemoryRepository({databasePath:f.databasePath,key:f.key})).toThrow("MEMORY_SCHEMA_UNSUPPORTED");expect(snapshot(f.root)).toEqual(before);
});
it("rejects cross-record ciphertext substitution rather than returning the other plaintext",()=>{
 const f=fixture(),db=new DatabaseSync(f.databasePath);
 try{const payload=db.prepare("SELECT payload FROM sources WHERE id='source-a'").get()!.payload;db.prepare("UPDATE sources SET payload=? WHERE id='source-b'").run(payload)}finally{db.close()}
 expect(()=>f.repo.readRows("sources","scope-a")).toThrow();
});
// Publication uses the production Windows-only directory rename contract.
it.runIf(process.platform==="win32").each(["auth-write","auth-fsync","directory-publish"])("does not publish a partial backup after %s failure",async kind=>{
 const f=fixture(),before=snapshot(f.root),backupId="failed-"+kind;
 const spy=kind==="auth-write"?vi.spyOn(fs,"writeFileSync").mockImplementationOnce(()=>{throw Error("INJECTED_WRITE")}):
  kind==="auth-fsync"?vi.spyOn(fs,"fsyncSync").mockImplementationOnce(()=>{throw Error("INJECTED_SYNC")}):
  vi.spyOn(fs,"renameSync").mockImplementationOnce(()=>{throw Error("INJECTED_RENAME")});
 try{await expect(f.repo.backup(backupId)).rejects.toThrow("INJECTED")}finally{spy.mockRestore()}
 expect(fs.existsSync(path.join(f.root,"backups",backupId))).toBe(false);
 expect(fs.readdirSync(path.join(f.root,"backups"))).toEqual([]);expectReadMarkOnly(before,snapshot(f.root));
});
it("rejects a future schema with a live WAL while permitting only its SQLite read-mark",()=>{
 const f=fixture(),db=new DatabaseSync(f.databasePath);db.exec("PRAGMA user_version=99");db.close();
 const before=snapshot(f.root);expect(()=>openMemoryRepository({databasePath:f.databasePath,key:f.key})).toThrow("MEMORY_SCHEMA_UNSUPPORTED");expectReadMarkOnly(before,snapshot(f.root));
});

/** Windows SQLite wal-index read-mark[1], bytes 104..107; every other byte stays fixed.
 * Approved 2026-10-01: only backup/schema reads may advance this slot to mxFrame.
 */
function expectReadMarkOnly(before:ReturnType<typeof snapshot>,after:ReturnType<typeof snapshot>){
 expect(after.map(file=>file.name)).toEqual(before.map(file=>file.name));
 for(let i=0;i<before.length;i++){
  const old=before[i],current=after[i];
  if(old.name!=="memory.sqlite-shm"){expect(current).toEqual(old);continue}
  expect(current.mtime).toBe(old.mtime);
  if(!old.bytes||!current.bytes)throw Error("EXPECTED_LIVE_SHM");
  expect(current.bytes.length).toBe(old.bytes.length);expect(old.bytes.length).toBeGreaterThanOrEqual(136);
  const normalized=Buffer.from(current.bytes);
  if(!current.bytes.subarray(104,108).equals(old.bytes.subarray(104,108))){
   const frame=old.bytes.readUInt32LE(16),previous=old.bytes.readUInt32LE(104);
   expect(frame).toBeGreaterThan(0);expect(previous===0xffffffff||previous<=frame).toBe(true);
   expect(current.bytes.readUInt32LE(104)).toBe(frame);
   old.bytes.copy(normalized,104,104,108);
  }
  expect(normalized).toEqual(old.bytes);
 }
}
for(const action of ["backup","read-only-schema"])it.runIf(action!=="backup"||process.platform==="win32")(`causal ${action} control changes only the read-mark to the existing mxFrame`,async()=>{
 const f=fixture();
 if(action==="read-only-schema"){const db=new DatabaseSync(f.databasePath);db.exec("PRAGMA user_version=99");db.close()}
 const before=snapshot(f.root);
 if(action==="backup")await f.repo.backup("causal-control");
 else{const db=new DatabaseSync(f.databasePath,{readOnly:true});try{expect(db.prepare("PRAGMA user_version").get()!.user_version).toBe(99)}finally{db.close()}}
 const after=snapshot(f.root);expectReadMarkOnly(before,after);
 expect(after[3].bytes!.equals(before[3].bytes!)).toBe(false);
 expect(after[3].bytes!.readUInt32LE(104)).toBe(before[3].bytes!.readUInt32LE(16));
});
it.each([16,100,108,120])("does not permit an unrelated SHM byte change at offset %s",offset=>{
 const f=fixture(),before=snapshot(f.root),after=snapshot(f.root);
 after[3].bytes![offset]^=1;expect(()=>expectReadMarkOnly(before,after)).toThrow();
});
it("does not permit a read-mark value other than the existing mxFrame",()=>{
 const f=fixture(),before=snapshot(f.root),after=snapshot(f.root);
 after[3].bytes!.writeUInt32LE(before[3].bytes!.readUInt32LE(16)+1,104);
 expect(()=>expectReadMarkOnly(before,after)).toThrow();
});
it.each([0,1,2])("keeps durable file %s byte-for-byte unchanged",index=>{
 const f=fixture(),before=snapshot(f.root),after=snapshot(f.root);
 after[index].bytes![0]^=1;expect(()=>expectReadMarkOnly(before,after)).toThrow();
});
