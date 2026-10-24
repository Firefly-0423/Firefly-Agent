import { expect, it, vi } from "vitest";
import type { PreparationReason } from "./preparation-diagnostics";
import { createDiagnosticController } from "./diagnostic-controller";
function setup(){const entry={run:vi.fn(async()=>{}),cancel:vi.fn()};const deps={loadExistingConfiguration:vi.fn(()=>true),inspectPreparedProfiles:vi.fn(()=>({profileCount:1,eligibleProfiles:1,reasons:[] as {code:PreparationReason;count:number}[]})),createEntry:vi.fn(()=>entry),show:vi.fn(async()=>({response:0})),setMenu:vi.fn(),writeState:vi.fn(),quit:vi.fn()};return {entry,deps,controller:createDiagnosticController(deps)};}
it("startup/exit without preparation or test does not read source or create/consume a permit",()=>{
 const {deps,controller}=setup();controller.install();controller.exit();
 expect(deps.loadExistingConfiguration).not.toHaveBeenCalled();expect(deps.createEntry).not.toHaveBeenCalled();expect(deps.quit).toHaveBeenCalledOnce();
});
it("preparation coalesces, reads cache through Main only and does not create a runner",async()=>{
 const {deps,controller}=setup();controller.install();const p=controller.prepare();expect(controller.prepare()).toBe(p);await p;
 expect(deps.loadExistingConfiguration).toHaveBeenCalledOnce();expect(deps.createEntry).not.toHaveBeenCalled();
 expect(deps.writeState.mock.calls.at(-1)![0]).toMatchObject({phase:"ready-to-test",configurationPrepared:true,eligibleProfiles:1});
});
it("only explicit native test action creates one runner and duplicate triggers coalesce",async()=>{
 const {deps,entry,controller}=setup();controller.install();await controller.run();expect(deps.createEntry).not.toHaveBeenCalled();
 await controller.prepare();const first=controller.run();expect(controller.run()).toBe(first);await first;
 expect(deps.createEntry).toHaveBeenCalledOnce();expect(entry.run).toHaveBeenCalledOnce();
});
it("cancel before test and config refusal leave admission untouched",async()=>{
 for(const mode of ["cancel","refused"]) {const {deps,controller}=setup();controller.install();if(mode==="cancel")controller.cancel();else{deps.loadExistingConfiguration.mockReturnValue(false);await controller.prepare();}
 await controller.run();expect(deps.createEntry).not.toHaveBeenCalled();}
});
it("exit/cancel during a run stops the held entry without reporting raw errors",async()=>{
 const {deps,entry,controller}=setup();entry.run.mockImplementation(async()=>{controller.cancel();throw new Error("FAKE-SECRET");});
 controller.install();await controller.prepare();await expect(controller.run()).resolves.toBeUndefined();expect(entry.cancel).toHaveBeenCalled();
 expect(JSON.stringify(deps.writeState.mock.calls)).not.toContain("FAKE-SECRET");
});
it("numeric result projection never persists injected extra fields or source identities",async()=>{
 const {deps,controller}=setup();controller.install();await controller.prepare();
 deps.createEntry.mockImplementation(((onReceipt:any)=>{onReceipt({status:"completed",attempts:2,reservedMicroCny:4198400,upperMicroCny:20,usage:[{promptTokens:2,completionTokens:2,totalTokens:4,upperMicroCny:20,apiKey:"FAKE-SECRET"}],apiKey:"FAKE-SECRET",profileId:"PRIVATE-ID"});return {run:async()=>{},cancel:()=>{}};}) as any);
 await controller.run();const output=JSON.stringify(deps.writeState.mock.calls);expect(output).not.toContain("FAKE-SECRET");expect(output).not.toContain("PRIVATE-ID");expect(output).toContain("upperMicroCny");
});

it("failed preparation exposes repeatable last diagnostics without reload, send or permit creation",async()=>{
 const {deps,controller}=setup();deps.inspectPreparedProfiles.mockReturnValue({profileCount:1,eligibleProfiles:0,reasons:[{code:"MODEL_MISMATCH",count:1}]});
 controller.install();await controller.prepare();
 const menu=deps.setMenu.mock.calls.at(-1)![0];expect(menu[0].enabled).toBe(false);expect(menu[1].enabled).toBe(false);
 const view=menu.find((item:any)=>item.label==="查看最近准备结果");expect(view?.enabled).toBe(true);
 await controller.viewPreparation();await controller.viewPreparation();
 expect(deps.loadExistingConfiguration).toHaveBeenCalledOnce();expect(deps.inspectPreparedProfiles).toHaveBeenCalledOnce();expect(deps.createEntry).not.toHaveBeenCalled();
 expect(deps.show.mock.calls.at(-1)![0]).toMatchObject({detail:expect.stringContaining("MODEL_MISMATCH")});
 expect(deps.writeState.mock.calls.at(-1)![0]).toMatchObject({preparation:{eligibleProfiles:0,reasons:[{code:"MODEL_MISMATCH",count:1}]}});
});
it("projects only fixed codes and bounded counts; cached diagnostics survive injected extras",async()=>{
 const {deps,controller}=setup();deps.inspectPreparedProfiles.mockReturnValue({profileCount:1,eligibleProfiles:0,reasons:[{code:"MODEL_MISMATCH",count:1},{code:"FAKE-SECRET",count:1}],apiKey:"FAKE-SECRET"} as any);
 await controller.prepare();await controller.viewPreparation();
 expect(JSON.stringify([deps.show.mock.calls,deps.writeState.mock.calls])).not.toContain("FAKE-SECRET");
});
it("read failure has a distinct fixed explanation and view coalesces while open",async()=>{
 const {deps,controller}=setup();deps.loadExistingConfiguration.mockReturnValue(false);await controller.prepare();
 expect(deps.inspectPreparedProfiles).not.toHaveBeenCalled();expect(deps.show.mock.calls.at(-1)![0]).toMatchObject({detail:expect.stringContaining("CONFIGURATION_UNAVAILABLE")});
 let close!:()=>void;deps.show.mockImplementation(()=>new Promise(resolve=>{close=()=>resolve({response:0});}));
 const first=controller.viewPreparation();expect(controller.viewPreparation()).toBe(first);await Promise.resolve();close();await first;
});
