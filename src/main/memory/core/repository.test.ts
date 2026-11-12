import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {randomBytes,createHash} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import {afterEach,it,expect,vi} from "vitest";
import {openMemoryRepository} from "./repository";
import {canonicalJson} from "./repository-types";
const dirs:string[]=[];const repos:any[]=[];
afterEach(()=>{for(const repo of repos.splice(0))repo.close();for(const dir of dirs.splice(0))fs.rmSync(dir,{recursive:true,force:true})});
function fixture(){const root=fs.mkdtempSync(path.join(os.tmpdir(),"memory-repo-"));dirs.push(root);return{databasePath:path.join(root,"memory.sqlite"),key:randomBytes(32)}}
const source={table:"sources" as const,id:"source-1",revision:1,payload:{title:"合成来源 source",text:"中文 English 🌱"}};
const batch={commandId:"command-1",scopeKey:"scope-a",records:[source]};
function snapshot(root:string){return fs.readdirSync(root).sort().map(name=>{const p=path.join(root,name),s=fs.statSync(p);return{name,bytes:fs.readFileSync(p),mtime:s.mtimeMs}})}
it("persists encrypted Chinese/English content and reopens stable records",()=>{
 const f=fixture(),repo=openMemoryRepository(f);repos.push(repo);expect(repo.writeBatch(batch)).toEqual({inserted:1});
 const files=fs.readdirSync(path.dirname(f.databasePath)).map(n=>fs.readFileSync(path.join(path.dirname(f.databasePath),n)));
 for(const bytes of files){expect(bytes.includes(Buffer.from(source.payload.text))).toBe(false);expect(bytes.includes(Buffer.from(source.payload.title))).toBe(false)}
 repo.close();const reopened=openMemoryRepository(f);repos.push(reopened);
 expect(reopened.readRows("sources","scope-a")[0].payload).toEqual(source.payload);expect(reopened.readRows("sources","scope-b")).toEqual([]);
});
it("rolls back both records and receipts on an injected transaction failure",()=>{
 const f=fixture(),repo=openMemoryRepository({...f,fault:(stage:string)=>{if(stage==="before-receipt")throw new Error("INJECTED")}});repos.push(repo);
 expect(()=>repo.writeBatch(batch)).toThrow("INJECTED");expect(repo.readRows("sources","scope-a")).toEqual([]);repo.close();
 const reopened=openMemoryRepository(f);repos.push(reopened);expect(reopened.writeBatch(batch)).toEqual({inserted:1});
});
it("replays identical commands and refuses changed payload or scope",()=>{
 const f=fixture(),repo=openMemoryRepository(f);repos.push(repo);expect(repo.writeBatch(batch)).toEqual(repo.writeBatch(batch));
 expect(()=>repo.writeBatch({...batch,records:[{...source,payload:{text:"changed"}}]})).toThrow("MEMORY_COMMAND_CONFLICT");
 expect(()=>repo.writeBatch({...batch,scopeKey:"scope-b"})).toThrow("MEMORY_COMMAND_CONFLICT");expect(repo.readRows("sources","scope-a")).toHaveLength(1);
});
it("enforces source foreign keys and record uniqueness within a scope",()=>{
 const f=fixture(),repo=openMemoryRepository(f);repos.push(repo);
 expect(()=>repo.writeBatch({commandId:"missing-source",scopeKey:"scope-a",records:[{table:"evidence",id:"evidence-1",sourceId:"missing",revision:1,payload:{text:"evidence"}}]})).toThrow();
 expect(repo.readRows("evidence","scope-a")).toEqual([]);
 repo.writeBatch(batch);expect(()=>repo.writeBatch({...batch,commandId:"duplicate-source"})).toThrow();
});
it("rejects a future SQLite schema before changing the stored schema",()=>{
 const f=fixture(),repo=openMemoryRepository(f);repo.close();
 const db=new DatabaseSync(f.databasePath);db.exec("PRAGMA user_version=99");db.close();
 expect(()=>openMemoryRepository(f)).toThrow("MEMORY_SCHEMA_UNSUPPORTED");
 const check=new DatabaseSync(f.databasePath,{readOnly:true});try{expect(check.prepare("PRAGMA user_version").get()?.user_version).toBe(99)}finally{check.close()}
});
it("authenticates wrong keys before opening a database with live WAL",()=>{
 const f=fixture(),repo=openMemoryRepository(f);repos.push(repo);repo.writeBatch(batch);
 expect(fs.statSync(f.databasePath+"-wal").size).toBeGreaterThan(0);
 const before=snapshot(path.dirname(f.databasePath));
 expect(()=>openMemoryRepository({...f,key:randomBytes(32)})).toThrow("MEMORY_AUTH_FAILED");
 expect(snapshot(path.dirname(f.databasePath))).toEqual(before);
});
it("rejects missing or damaged auth without changing DB/WAL/SHM",()=>{
 const f=fixture(),repo=openMemoryRepository(f);repos.push(repo);repo.writeBatch(batch);
 const auth=f.databasePath+".auth",valid=fs.readFileSync(auth);fs.unlinkSync(auth);let before=snapshot(path.dirname(auth));
 expect(()=>openMemoryRepository(f)).toThrow("MEMORY_AUTH_UNAVAILABLE");expect(snapshot(path.dirname(auth))).toEqual(before);
 fs.writeFileSync(auth,Buffer.from("damaged"));before=snapshot(path.dirname(auth));
 expect(()=>openMemoryRepository(f)).toThrow("MEMORY_AUTH_INVALID");expect(snapshot(path.dirname(auth))).toEqual(before);fs.writeFileSync(auth,valid);
});
it.runIf(process.platform==="win32")("produces a consistent SQLite backup that can be reopened with the same auth",async()=>{
 const f=fixture(),repo=openMemoryRepository(f);repos.push(repo);repo.writeBatch(batch);
 const result=await repo.backup("restorable-backup");const dest=path.join(path.dirname(f.databasePath),"backups",result.backupId,"memory.sqlite");
 const restored=openMemoryRepository({...f,databasePath:dest});repos.push(restored);expect(restored.readRows("sources","scope-a")[0].payload).toEqual(source.payload);
});

it("rejects sparse payloads before writing records or receipts",()=>{
 const f=fixture(),repo=openMemoryRepository(f);repos.push(repo);
 expect(()=>repo.writeBatch({...batch,records:[{...source,payload:Array(2)}]})).toThrow("MEMORY_INPUT_INVALID");
 expect(repo.readRows("sources","scope-a")).toEqual([]);
 const db=new DatabaseSync(f.databasePath,{readOnly:true});try{expect(db.prepare("SELECT count(*) AS n FROM command_receipts").get()?.n).toBe(0)}finally{db.close()}
});
it("does not equate a one-hole payload with an empty array on command replay",()=>{
 const f=fixture(),repo=openMemoryRepository(f);repos.push(repo);repo.writeBatch({...batch,records:[{...source,payload:[]}]});
 expect(()=>repo.writeBatch({...batch,records:[{...source,payload:Array(1)}]})).toThrow("MEMORY_INPUT_INVALID");
});
it("stores a keyed receipt digest instead of a publicly enumerable plaintext hash",()=>{
 const f=fixture(),repo=openMemoryRepository(f);repos.push(repo);repo.writeBatch(batch);
 const db=new DatabaseSync(f.databasePath,{readOnly:true});
 try{const digest=db.prepare("SELECT request_digest FROM command_receipts").get()?.request_digest;
  expect(Buffer.from(digest as Uint8Array)).not.toEqual(createHash("sha256").update(canonicalJson(batch)).digest());
 }finally{db.close()}
});
// Backup publication relies on Windows no-replace directory rename semantics.
// Identifier validation and the non-Windows denial remain cross-platform checks.
it("rejects arbitrary backup paths before platform-specific publication",async()=>{
 const f=fixture(),repo=openMemoryRepository(f);repos.push(repo);repo.writeBatch(batch);
 const external=path.join(path.dirname(f.databasePath),"uncontrolled.sqlite");
 await expect(repo.backup(external)).rejects.toThrow("MEMORY_BACKUP_INVALID");expect(fs.existsSync(external)).toBe(false);
});
it.runIf(process.platform==="win32")("preserves existing backup directories",async()=>{
 const f=fixture(),repo=openMemoryRepository(f);repos.push(repo);repo.writeBatch(batch);
 const existing=path.join(path.dirname(f.databasePath),"backups","owned-id");fs.mkdirSync(existing,{recursive:true});fs.writeFileSync(path.join(existing,"sentinel"),"keep");
 await expect(repo.backup("owned-id")).rejects.toThrow("MEMORY_BACKUP_EXISTS");expect(fs.readFileSync(path.join(existing,"sentinel"),"utf8")).toBe("keep");
});
it.runIf(process.platform==="win32")("rejects a backup root junction without writing through it",async()=>{
 const f=fixture(),repo=openMemoryRepository(f);repos.push(repo);repo.writeBatch(batch);
 const elsewhere=fs.mkdtempSync(path.join(os.tmpdir(),"memory-backup-elsewhere-"));dirs.push(elsewhere);
 fs.symlinkSync(elsewhere,path.join(path.dirname(f.databasePath),"backups"),"junction");
 await expect(repo.backup("junction-attempt")).rejects.toThrow("MEMORY_BACKUP_INVALID");expect(fs.readdirSync(elsewhere)).toEqual([]);
});
it.runIf(process.platform==="win32")("preserves a raced backup destination and leaves no published partial backup",async()=>{
 const f=fixture(),repo=openMemoryRepository(f);repos.push(repo);repo.writeBatch(batch);
 const rename=fs.renameSync.bind(fs);
 const spy=vi.spyOn(fs,"renameSync").mockImplementationOnce((from,to)=>{
  fs.mkdirSync(to as string);fs.writeFileSync(path.join(to as string,"sentinel"),"race");
  return rename(from,to);
 });
 try{await expect(repo.backup("race-id")).rejects.toThrow();
  expect(fs.readFileSync(path.join(path.dirname(f.databasePath),"backups","race-id","sentinel"),"utf8")).toBe("race");
 }finally{spy.mockRestore()}
});

it.runIf(process.platform!=="win32")("rejects backup publication on non-Windows without creating files or changing live storage",async()=>{
 const f=fixture(),repo=openMemoryRepository(f);repos.push(repo);repo.writeBatch(batch);
 const before=snapshot(path.dirname(f.databasePath));
 await expect(repo.backup("native-backup")).rejects.toThrow("MEMORY_WINDOWS_REQUIRED");
 expect(snapshot(path.dirname(f.databasePath))).toEqual(before);
});
