import {createTestResourceScope} from "../../../scripts/verify/memory-core/test-resources";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {randomBytes} from "node:crypto";
import {afterEach,describe,it,expect,vi} from "vitest";
import {loadOrCreateMemoryKey} from "./protected-key";
import {copyMemoryKeyBytes} from "./key-provider";
import {sealPayload,openPayload} from "./payload-codec";
const dirs:string[]=[],scopes:ReturnType<typeof keyScope>[]=[];
const owned=new WeakMap<object,ReturnType<typeof keyScope>>();
function keyScope(){return createTestResourceScope<Awaited<ReturnType<typeof loadOrCreateMemoryKey>>>(key=>key.destroy())}
function openKey(input:Parameters<typeof loadOrCreateMemoryKey>[0]){return owned.get(input.roots)!.open(()=>loadOrCreateMemoryKey(input))}
afterEach(async()=>{const ownScopes=scopes.splice(0),ownDirs=dirs.splice(0);vi.restoreAllMocks();await Promise.all(ownScopes.map(scope=>scope.close()));for(const dir of ownDirs)fs.rmSync(dir,{recursive:true,force:true})});
function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"memory-key-"));dirs.push(root);
 const roots={dataRoot:path.join(root,"data"),indexRoot:path.join(root,"index"),tempRoot:path.join(root,"temp")};
 const scope=keyScope();scopes.push(scope);owned.set(roots,scope);
 const wrapping=randomBytes(32),binding={recordType:"protected-key",id:"test-wrapper",schemaVersion:1,keyVersion:1};
 const protection={protect:async(value:Uint8Array)=>sealPayload(wrapping,binding,value),unprotect:async(value:Uint8Array)=>openPayload(wrapping,binding,value)};
 return{roots,protection,file:path.join(roots.dataRoot,"memory-key.protected"),pending:path.join(roots.dataRoot,"memory-key.protected.pending")};
}
describe.runIf(process.platform==="win32")("exclusive memory key publication",()=>{
 it("reopens the same published key without replacement",async()=>{
  const f=fixture(),one=await openKey(f),bytes=copyMemoryKeyBytes(one);await one.destroy();
  const disk=fs.readFileSync(f.file),two=await openKey(f);
  try{expect(copyMemoryKeyBytes(two)).toEqual(bytes);expect(fs.readFileSync(f.file)).toEqual(disk);expect(JSON.stringify(two)).not.toContain(bytes.toString("base64"))}finally{await two.destroy()}
 });
 it.each(["memory.sqlite","memory.sqlite.auth","memory.sqlite-wal","memory.sqlite-shm"])("never generates replacement when %s exists and canonical key is missing",async(name)=>{
  const f=fixture();fs.mkdirSync(f.roots.dataRoot);const file=path.join(f.roots.dataRoot,name);fs.writeFileSync(file,"existing");const original=fs.readFileSync(file);
  await expect(openKey(f)).rejects.toThrow("MEMORY_KEY_UNAVAILABLE");
  expect(fs.readFileSync(file)).toEqual(original);expect(fs.existsSync(f.file)).toBe(false);
 });
 it("recovers the same key from a complete pending record after injected fsync failure",async()=>{
  const f=fixture(),spy=vi.spyOn(fs,"fsyncSync").mockImplementationOnce(()=>{throw new Error("INJECTED_SYNC")});
  await expect(openKey(f)).rejects.toThrow("INJECTED_SYNC");spy.mockRestore();
  const pending=fs.readFileSync(f.pending),reopened=await openKey(f);
  try{expect(fs.readFileSync(f.file)).toEqual(pending);expect(fs.existsSync(f.pending)).toBe(false);expect(copyMemoryKeyBytes(reopened)).toHaveLength(32)}finally{await reopened.destroy()}
 });
 it("rejects old/partial records unchanged",async()=>{
  const f=fixture();fs.mkdirSync(f.roots.dataRoot);fs.writeFileSync(f.pending,"v10-old");const original=fs.readFileSync(f.pending);
  await expect(openKey(f)).rejects.toThrow("MEMORY_KEY_FORMAT_UNSUPPORTED");
  expect(fs.readFileSync(f.pending)).toEqual(original);expect(fs.existsSync(f.file)).toBe(false);
 });
 it("rejects a damaged protected key without touching live database sidecars",async()=>{
  const f=fixture(),handle=await openKey(f);await handle.destroy();
  const damaged=fs.readFileSync(f.file);damaged[damaged.length-1]^=1;fs.writeFileSync(f.file,damaged);
  for(const name of ["memory.sqlite","memory.sqlite.auth","memory.sqlite-wal","memory.sqlite-shm"])fs.writeFileSync(path.join(f.roots.dataRoot,name),name);
  const before=fs.readdirSync(f.roots.dataRoot).sort().map(n=>[n,fs.readFileSync(path.join(f.roots.dataRoot,n))]);
  await expect(openKey(f)).rejects.toThrow("MEMORY_PROTECTED_KEY_INVALID");
  expect(fs.readdirSync(f.roots.dataRoot).sort().map(n=>[n,fs.readFileSync(path.join(f.roots.dataRoot,n))])).toEqual(before);
 });
 it("rejects a second instance until the first open lease is released",async()=>{
  const f=fixture(),one=await openKey(f);
  try{await expect(openKey(f)).rejects.toThrow("MEMORY_OPEN_BUSY")}finally{await one.destroy()}
  const reopened=await openKey(f);await reopened.destroy();
 });
 it("rejects canonical/pending conflicts without changing either record",async()=>{
  const f=fixture(),one=await openKey(f);await one.destroy();const original=fs.readFileSync(f.file);
  const other=fixture(),two=await openKey({...other,protection:f.protection});await two.destroy();
  fs.copyFileSync(other.file,f.pending);const pending=fs.readFileSync(f.pending);
  await expect(openKey(f)).rejects.toThrow("MEMORY_KEY_PUBLICATION_CONFLICT");
  expect(fs.readFileSync(f.file)).toEqual(original);expect(fs.readFileSync(f.pending)).toEqual(pending);
 });
});

it.runIf(process.platform==="win32")("clears the provider-owned plaintext key buffers after accepting their copies",async()=>{
 const f=fixture(),plain:Uint8Array[]=[];
 const protection={...f.protection,async unprotect(blob:Uint8Array){const value=await f.protection.unprotect(blob);plain.push(value);return value}};
 const key=await openKey({...f,protection});
 try{expect(plain.length).toBeGreaterThan(0);for(const value of plain)expect(value.every(byte=>byte===0)).toBe(true)}
 finally{await key.destroy()}
});
