import { describe, expect, it, vi } from "vitest";
import { createController } from "./controller";
const evidence=(costNanoUsd=27000)=>({promptTokens:100,completionTokens:20,totalTokens:120,costNanoUsd,upperNanoUsd:54000});
function setup(){let accept:(key:unknown,balance:boolean)=>boolean=()=>false;let state:any,menu:any[]=[];const runner={start:vi.fn(async()=>({status:"completed",attempts:2,reservedNanoUsd:1e9,upperNanoUsd:108000,costNanoUsd:54000,costStatus:"complete",usage:[evidence(),evidence()]})),cancel:vi.fn()};const show=vi.fn(async()=>({response:1}));let resolveProfile:(id:string)=>any=()=>undefined;
 const createRunner=vi.fn((resolve:any)=>{resolveProfile=resolve;return runner;});const close=vi.fn();const controller=createController({openForm:fn=>{accept=fn;},closeForm:close,createRunner,show,setMenu:m=>{menu=m;},writeState:s=>{state=s;},quit:vi.fn()});controller.install();return {controller,prepare:(k:unknown,b=true)=>accept(k,b),getState:()=>state,getMenu:()=>menu,runner,createRunner,show,close,profile:(id:string)=>resolveProfile(id)};}
describe("user-only OpenRouter preparation and native sending",()=>{
 it("starts empty; preparation only stores an isolated profile with zero runner creation",()=>{const t=setup();expect(t.getState().prepared).toBe(false);t.controller.configure();expect(t.prepare("SYNTHETIC-ONLY-KEY",false)).toBe(false);expect(t.prepare("bad")).toBe(false);expect(t.prepare("SYNTHETIC-ONLY-KEY")).toBe(true);expect(t.getState().prepared).toBe(true);expect(t.createRunner).not.toHaveBeenCalled();expect(t.runner.start).not.toHaveBeenCalled();expect(JSON.stringify(t.getState())).not.toContain("SYNTHETIC");expect(t.prepare("SYNTHETIC-SECOND-KEY")).toBe(false);});
 it("requires native confirmation; rejection clears key and cannot retry",async()=>{const t=setup();t.controller.configure();t.prepare("SYNTHETIC-ONLY-KEY");await t.controller.send();expect(t.show).toHaveBeenCalledOnce();expect(t.createRunner).not.toHaveBeenCalled();expect(t.getState().prepared).toBe(false);await t.controller.send();expect(t.show).toHaveBeenCalledOnce();});
 it("coalesces native clicks, emits only numeric receipt, clears key and stops",async()=>{const t=setup();t.show.mockResolvedValue({response:0});t.controller.configure();t.prepare("SYNTHETIC-ONLY-KEY");const a=t.controller.send(),b=t.controller.send();expect(a).toBe(b);await a;expect(t.runner.start).toHaveBeenCalledOnce();expect(t.createRunner).toHaveBeenCalledOnce();expect(t.getState()).toMatchObject({phase:"finished",prepared:false,receipt:{status:"completed",attempts:2}});expect(t.profile(t.runner.start.mock.calls[0][0])).toBeUndefined();expect(JSON.stringify(t.getState())).not.toContain("SYNTHETIC");});
 it("cancel during confirmation never constructs or sends a runner",async()=>{const t=setup();let release!:(v:any)=>void;t.show.mockImplementation(()=>new Promise(r=>{release=r;}));t.controller.configure();t.prepare("SYNTHETIC-ONLY-KEY");const sending=t.controller.send();await Promise.resolve();t.controller.cancel();release({response:0});await sending;expect(t.createRunner).not.toHaveBeenCalled();expect(t.getState().prepared).toBe(false);});
 it("cancel before preparation permanently blocks later submission",()=>{const t=setup();t.controller.configure();t.controller.cancel();expect(t.prepare("SYNTHETIC-ONLY-KEY")).toBe(false);expect(t.getState()).toMatchObject({phase:"cancelled",prepared:false});});
 it.each([
  [{status:"uncertain",costStatus:"unknown",costNanoUsd:null,usage:[]},"实际费用：未知",false],
  [{status:"uncertain",attempts:2,costStatus:"partial",costNanoUsd:27000,usage:[evidence()]},"总费用：未知；已确认部分：USD 0.000027",false],
  [{status:"completed",costStatus:"complete",costNanoUsd:0,usage:[evidence(0)]},"已报告扣费：USD 0",true],
  [{status:"uncertain",costNanoUsd:0,usage:[]},"实际费用：未知",false],
  [{status:"completed",costStatus:"complete",costNanoUsd:0,usage:new Array(1)},"实际费用：未知",false],
  [{status:"completed",costStatus:"complete",costNanoUsd:0,usage:[]},"实际费用：未知",false],
  [{status:"uncertain",costStatus:"partial",costNanoUsd:27000,usage:[]},"实际费用：未知",false],
  [{status:"completed",costStatus:"complete",costNanoUsd:0,usage:[evidence()]},"实际费用：未知",false],
  [{status:"completed",costStatus:"complete",costNanoUsd:0,usage:[{...evidence(0),promptTokens:-1}]},"实际费用：未知",false],
  [{status:"completed",costStatus:"complete",costNanoUsd:0,usage:null},"实际费用：未知",false],
  [{status:"SYNTHETIC-UNKNOWN-STATUS",costStatus:"complete",costNanoUsd:0,usage:[evidence(0)]},"实际费用：未知",false],
  [{status:"completed",attempts:0,costStatus:"complete",costNanoUsd:0,usage:[evidence(0)]},"实际费用：未知",false],
 ])("does not invent a zero charge from missing cost evidence %j",async(patch,text,known)=>{
  const t=setup();t.runner.start.mockResolvedValue({attempts:1,reservedNanoUsd:1e9,upperNanoUsd:1e9,...patch} as any);t.show.mockResolvedValue({response:0});t.controller.configure();t.prepare("SYNTHETIC-ONLY-KEY");await t.controller.send();
  const detail=t.show.mock.calls.at(-1)![0].detail;expect(detail).toContain(text);if(!known)expect(detail).not.toContain("已报告扣费：USD 0");if(text==="实际费用：未知")expect(t.getState().receipt).toMatchObject({costNanoUsd:null,costStatus:"unknown"});
 });
 it("projects safe reasons and discards forged stage, secrets and invalid status",async()=>{
  const t=setup();t.runner.start.mockResolvedValue({status:"uncertain",attempts:1,reservedNanoUsd:1e9,upperNanoUsd:1e9,costNanoUsd:null,costStatus:"unknown",usage:[],failure:{code:"HTTP_REJECTED",stage:"SYNTHETIC-LEAK",httpStatus:401,message:"SYNTHETIC-LEAK",headers:{key:"SYNTHETIC-LEAK"}}} as any);t.show.mockResolvedValue({response:0});t.controller.configure();t.prepare("SYNTHETIC-ONLY-KEY");await t.controller.send();
  expect(t.getState().receipt.failure).toEqual({code:"HTTP_REJECTED",stage:"http",httpStatus:401});expect(t.show.mock.calls.at(-1)![0].detail).toContain("HTTP_REJECTED");expect(JSON.stringify([t.getState(),t.show.mock.calls])).not.toContain("SYNTHETIC-LEAK");
 });

});
