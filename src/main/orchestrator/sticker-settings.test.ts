import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";

const mocks=vi.hoisted(()=>({settingsDir:"",items:[] as Array<Record<string,unknown>>,getAll:vi.fn()}));
vi.mock("electron",()=>({app:{getPath:vi.fn(()=>mocks.settingsDir)}}));
vi.mock("../stickers/sticker-storage",()=>({getAllStickerConfig:vi.fn((settings:Record<string,boolean>)=>{mocks.getAll(settings);return mocks.items})}));

import {
 clearStickerSettingsCache,
 getStickerManagerConfig,
 loadStickerSettings,
 saveStickerSettings,
 setStickerEnabled,
} from "./sticker-settings";

const roots:string[]=[];
function settingsPath(){return path.join(mocks.settingsDir,"sticker-settings.json")}
function writeSettings(value:unknown){fs.mkdirSync(mocks.settingsDir,{recursive:true});fs.writeFileSync(settingsPath(),typeof value==="string"?value:JSON.stringify(value),"utf8")}
function readSettings(){return JSON.parse(fs.readFileSync(settingsPath(),"utf8")) as Record<string,boolean>}

beforeEach(()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"sticker-settings-"));
 roots.push(dir);mocks.settingsDir=dir;mocks.getAll.mockClear();clearStickerSettingsCache();
});
afterEach(()=>{for(const dir of roots.splice(0))fs.rmSync(dir,{recursive:true,force:true})});

describe("loadStickerSettings",()=>{
 it("returns an empty map when the settings file is absent",()=>{
  expect(loadStickerSettings()).toEqual({});
 });
 it("normalizes every stored id to a boolean, defaulting to true",()=>{
  writeSettings({off:false,on:true,truthy:"yes",zero:0,null:null});
  expect(loadStickerSettings()).toEqual({off:false,on:true,truthy:true,zero:true,null:true});
 });
 it("returns an empty map and logs when the file is not valid JSON",()=>{
  writeSettings("{not json");
  const error=vi.spyOn(console,"error").mockImplementation(()=>{});
  try{
   expect(loadStickerSettings()).toEqual({});
   expect(error).toHaveBeenCalledWith("[StickerSettings] failed to load sticker settings:",expect.any(Error));
  }finally{error.mockRestore()}
 });
 it("caches the loaded settings until the cache is cleared",()=>{
  writeSettings({first:false});
  const first=loadStickerSettings();
  writeSettings({second:false});
  expect(loadStickerSettings()).toBe(first);
  clearStickerSettingsCache();
  expect(loadStickerSettings()).toEqual({second:false});
 });
});

describe("saveStickerSettings",()=>{
 it("merges with the cached settings and writes pretty JSON",()=>{
  writeSettings({keep:false});
  loadStickerSettings();
  const saved=saveStickerSettings({added:true});
  expect(saved).toEqual({keep:false,added:true});
  expect(readSettings()).toEqual({keep:false,added:true});
  expect(fs.readFileSync(settingsPath(),"utf8")).toContain('\n  "keep": false');
 });
 it("creates the parent directory when missing",()=>{
  mocks.settingsDir=path.join(mocks.settingsDir,"nested","deeper");
  expect(saveStickerSettings({a:false})).toEqual({a:false});
  expect(fs.existsSync(settingsPath())).toBe(true);
 });
});

describe("setStickerEnabled",()=>{
 it("updates one id and returns the merged settings",()=>{
  writeSettings({a:true});
  expect(setStickerEnabled("a",false)).toEqual({a:false});
  expect(setStickerEnabled("b",true)).toEqual({a:false,b:true});
  expect(readSettings()).toEqual({a:false,b:true});
 });
});

describe("getStickerManagerConfig",()=>{
 it("passes the loaded settings to the sticker storage",()=>{
  writeSettings({a:false});
  expect(getStickerManagerConfig()).toBe(mocks.items);
  expect(mocks.getAll).toHaveBeenCalledWith({a:false});
 });
});
