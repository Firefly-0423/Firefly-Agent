import {describe,expect,it,vi} from "vitest";
import type {SavedModelProfile} from "./model-catalog";
import {createModelConnectionState,normalizeConnectionConfig} from "./model-connection-state";

function profile(overrides:Partial<SavedModelProfile>={}):SavedModelProfile{
 return{id:"profile-a",provider:"DeepSeek（深度求索）",baseUrl:"https://api.deepseek.com",model:"deepseek-flash",apiKey:"key",...overrides};
}
function config(overrides:Record<string,unknown>={}){
 return{provider:"DeepSeek（深度求索）",baseUrl:"https://api.deepseek.com",model:"deepseek-flash",apiKey:"key",explicitTransport:"openai",...overrides};
}

describe("normalizeConnectionConfig",()=>{
 it("trims strings and fills the provider transport",()=>{
  expect(normalizeConnectionConfig({provider:"DeepSeek（深度求索）",baseUrl:" https://api.deepseek.com ",model:" deepseek-flash ",apiKey:" key "})).toEqual({
   provider:"DeepSeek（深度求索）",baseUrl:"https://api.deepseek.com",model:"deepseek-flash",apiKey:"key",explicitTransport:"openai",
  });
 });
 it("falls back to OpenAI transport for unknown providers",()=>{
  expect(normalizeConnectionConfig(config({provider:"Custom"}))).toMatchObject({provider:"Custom",explicitTransport:"openai"});
 });
 it("keeps an explicit transport and normalized reasoning preference",()=>{
  expect(normalizeConnectionConfig(config({explicitTransport:"anthropic",reasoning:{mode:"on",effort:"high"}}))).toEqual({
   provider:"DeepSeek（深度求索）",baseUrl:"https://api.deepseek.com",model:"deepseek-flash",apiKey:"key",explicitTransport:"anthropic",reasoning:{mode:"on",effort:"high"},
  });
 });
 it("rejects invalid shapes and blank fields",()=>{
  for(const value of [null,undefined,[],"string",42,{},{...config(),provider:""},{...config(),apiKey:"  "},{...config(),model:1}]){
   expect(()=>normalizeConnectionConfig(value)).toThrow("MODEL_CONNECTION_INVALID_CONFIG");
  }
 });
 it("rejects an unknown explicit transport",()=>{
  expect(()=>normalizeConnectionConfig(config({explicitTransport:"grpc"}))).toThrow("MODEL_CONNECTION_INVALID_CONFIG");
 });
 it("rejects malformed reasoning preferences",()=>{
  for(const reasoning of [{mode:"sometimes"},{"mode":"on",extra:true},{mode:"on",effort:"pro"}]){
   expect(()=>normalizeConnectionConfig(config({reasoning}))).toThrow("MODEL_CONNECTION_INVALID_CONFIG");
  }
 });
});

describe("createModelConnectionState",()=>{
 it("publishes a configured snapshot for uniquely identified profiles",()=>{
  const state=createModelConnectionState();
  state.refresh([profile()],"profile-a");
  expect(state.snapshot()).toEqual({
   defaultProfileId:"profile-a",
   profiles:[{profileId:"profile-a",revision:1,state:"unverified",configured:true}],
  });
 });
 it("marks invalid and duplicate-id profiles as unconfigured",()=>{
  const state=createModelConnectionState();
  state.refresh([profile({id:"invalid",apiKey:""}),profile({id:"dup"}),profile({id:"dup"})]);
  const byId=Object.fromEntries(state.snapshot().profiles.map(entry=>[entry.profileId,entry.configured]));
  expect(byId.invalid).toBe(false);
  expect(byId.dup).toBe(false);
 });
 it("notifies subscribers only when the snapshot changes and supports unsubscribe",()=>{
  const state=createModelConnectionState();
  const listener=vi.fn();
  const unsubscribe=state.subscribe(listener);
  state.refresh([profile()],"profile-a");
  expect(listener).toHaveBeenCalledTimes(1);
  state.refresh([profile()],"profile-a");
  expect(listener).toHaveBeenCalledTimes(1);
  state.refresh([profile()],"profile-b");
  expect(listener).toHaveBeenCalledTimes(2);
  unsubscribe();
  state.refresh([],undefined);
  expect(listener).toHaveBeenCalledTimes(2);
 });
 it("survives a throwing listener and still notifies the others",()=>{
  const state=createModelConnectionState();
  const good=vi.fn();
  const warn=vi.spyOn(console,"warn").mockImplementation(()=>{});
  try{
   state.subscribe(()=>{throw new Error("listener failed")});
   state.subscribe(good);
   state.refresh([profile()]);
   expect(good).toHaveBeenCalledTimes(1);
   expect(warn).toHaveBeenCalledWith("[Firefly] model connection listener failed");
  }finally{warn.mockRestore()}
 });
 it("removes profiles that are no longer configured",()=>{
  const state=createModelConnectionState();
  state.refresh([profile(),profile({id:"profile-b"})]);
  state.refresh([profile({id:"profile-b"})]);
  expect(state.snapshot().profiles.map(entry=>entry.profileId)).toEqual(["profile-b"]);
 });
 it("reports connection only for an unchanged verified profile",async()=>{
  const state=createModelConnectionState();
  state.refresh([profile()]);
  expect(state.isConnected(profile())).toBe(false);
  await state.test(normalizeConnectionConfig(profile()),async()=>({ok:true,latency:12}));
  expect(state.isConnected(profile())).toBe(true);
  expect(state.isConnected(profile({apiKey:"other"}))).toBe(false);
  state.refresh([profile({apiKey:"rotated"})]);
  expect(state.isConnected(profile({apiKey:"rotated"}))).toBe(false);
 });
 it("publishes checking then connected with the tested dimension",async()=>{
  const state=createModelConnectionState();
  state.refresh([profile()],"profile-a");
  const snapshots:number[][]=[];
  state.subscribe(snapshot=>snapshots.push(snapshot.profiles.map(entry=>entry.revision)));
  const result=await state.test(normalizeConnectionConfig(profile()),async()=>({ok:true,latency:15}));
  expect(result).toEqual({ok:true,latency:15});
  const snapshot=state.snapshot();
  expect(snapshot.profiles[0]).toMatchObject({profileId:"profile-a",revision:1,state:"connected",checkedAt:expect.any(Number),configured:true});
  expect(snapshot.profiles[0].reason).toBeUndefined();
  expect(snapshots).toEqual([[1],[1]]);
 });
 it("reports a failed test and a thrown test distinctly",async()=>{
  const state=createModelConnectionState();
  state.refresh([profile()]);
  const failed=await state.test(normalizeConnectionConfig(profile()),async()=>({ok:false,latency:5}));
  expect(failed).toEqual({ok:false,latency:5,error:"MODEL_CONNECTION_TEST_FAILED"});
  expect(state.snapshot().profiles[0]).toMatchObject({state:"failed",reason:"test_failed"});
  const error=await state.test(normalizeConnectionConfig(profile()),async()=>{throw new Error("boom")});
  expect(error.ok).toBe(false);
  expect(error.error).toBe("MODEL_CONNECTION_TEST_ERROR");
  expect(Number.isFinite(error.latency)).toBe(true);
  expect(state.snapshot().profiles[0]).toMatchObject({state:"failed",reason:"test_error"});
 });
 it("falls back to measured latency when the driver reports an invalid one",async()=>{
  const state=createModelConnectionState();
  state.refresh([profile()]);
  const result=await state.test(normalizeConnectionConfig(profile()),async()=>({ok:true,latency:Number.NaN}));
  expect(Number.isFinite(result.latency)).toBe(true);
  expect(result.latency).toBeGreaterThanOrEqual(0);
 });
 it("does not publish a test result for a profile replaced while testing",async()=>{
  const state=createModelConnectionState();
  state.refresh([profile()]);
  let resolveDriver!: (value:{ok:boolean;latency:number})=>void;
  const pending=state.test(normalizeConnectionConfig(profile()),()=>new Promise(resolve=>{resolveDriver=resolve}));
  state.refresh([profile({model:"different-model"})]);
  resolveDriver({ok:true,latency:1});
  await pending;
  expect(state.snapshot().profiles[0]).toMatchObject({state:"unverified",configured:true});
 });
});
