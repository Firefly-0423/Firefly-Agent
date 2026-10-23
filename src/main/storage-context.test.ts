import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import type {RuntimeProfile} from "./runtime-profile";

const roots:string[]=[];
function root():string{
 const value=fs.mkdtempSync(path.join(os.tmpdir(),"storage-context-"));
 roots.push(value);
 return value;
}
function profile(base:string,overrides:Partial<RuntimeProfile>={}):RuntimeProfile{
 const userData=path.join(base,"Firefly-test");
 return{kind:"test",applicationName:"Firefly-test",appData:base,userData,sessionData:path.join(userData,"session"),logs:path.join(userData,"logs"),isolationRoot:base,...overrides};
}
async function load(){return import("./storage-context")}

beforeEach(()=>{vi.resetModules()});
afterEach(()=>{for(const value of roots.splice(0))fs.rmSync(value,{recursive:true,force:true})});

describe("createStorageContext",()=>{
 it("derives every configured root from the runtime profile",async()=>{
  const base=root();const p=profile(base);const {createStorageContext}=await load();
  const context=createStorageContext(p);
  expect(context.profile).toBe(p);
  expect(context.configRoot).toBe(p.userData);
  expect(context.dataRoot).toBe(p.userData);
  expect(context.stateRoot).toBe(p.userData);
  expect(context.cacheRoot).toBe(path.join(p.userData,"cache"));
  expect(context.logsRoot).toBe(p.logs);
  expect(context.sessionRoot).toBe(p.sessionData);
  expect(context.memory.dataRoot).toBe(path.join(p.userData,"memory","data"));
  expect(context.memory.indexRoot).toBe(path.join(p.userData,"memory","index"));
  expect(context.memory.tempRoot).toBe(path.join(p.userData,"memory","temp"));
 });
 it("exposes owned file paths and freezes the context",async()=>{
  const p=profile(root());const {createStorageContext}=await load();
  const context=createStorageContext(p);
  expect(context.files.mcp).toBe(path.join(p.userData,"mcp-servers.json"));
  expect(context.files.tokenUsage).toBe(path.join(p.userData,"token-usage.json"));
  expect(context.files.contentManifest).toBe(path.join(p.userData,"content-manifest.json"));
  expect(context.files.historyBudgetStats).toBe(path.join(p.userData,"memory-history-budget.json"));
  expect(context.files.chatWindowState).toBe(path.join(p.userData,"chat-window-state.json"));
  expect(context.files.skillDescriptionsZh).toBe(path.join(p.userData,"skill-descriptions-zh.json"));
  expect(context.files.mainLog).toBe(path.join(p.logs,"firefly.log"));
  expect(Object.isFrozen(context)).toBe(true);
  expect(Object.isFrozen(context.memory)).toBe(true);
  expect(Object.isFrozen(context.files)).toBe(true);
 });
 it("rejects configured roots outside an isolated profile",async()=>{
  const base=root();const {createStorageContext}=await load();
  expect(()=>createStorageContext(profile(base,{userData:path.join(base,"..","escape")}))).toThrow("FIREFLY_RUNTIME_PATH_ESCAPE");
 });
});

describe("initializeStorageContext / getStorageContext",()=>{
 it("throws before initialization and initializes only once",async()=>{
  const base=root();const p=profile(base);const {getStorageContext,initializeStorageContext}=await load();
  expect(()=>getStorageContext()).toThrow("FIREFLY_STORAGE_NOT_INITIALIZED");
  const context=initializeStorageContext(p);
  expect(getStorageContext()).toBe(context);
  expect(()=>initializeStorageContext(p)).toThrow("FIREFLY_STORAGE_ALREADY_INITIALIZED");
 });
});
