import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createMainProbeEntry } from "./main-entry";
import { EXPERIMENT_ID } from "./boundary";
import { PROVIDER_CAPABILITIES } from "../orchestrator/vendors/capabilities";
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});
const saved={id:"fake-cached-id",provider:PROVIDER_CAPABILITIES.find(c=>c.id==="deepseek")!.displayName,model:"deepseek-flash",baseUrl:"https://api.deepseek.com",apiKey:"FAKE-NATIVE-OWNER-KEY"};
function setup(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"main-entry-fake-"));roots.push(root);const now=Date.now();
 fs.writeFileSync(path.join(root,"arm.json"),JSON.stringify({armed:true,experimentId:EXPERIMENT_ID,priorAttempts:0,budgetMicroCny:5000000,priceVerifiedAt:now-1000,inputMicroCnyPerToken:2,outputMicroCnyPerToken:8,expiresAt:now+3600000}));
 const deps={root,now:()=>now,listProfileIds:vi.fn(()=>[saved.id]),resolveProfile:vi.fn((id:string)=>id===saved.id?{...saved}:undefined),show:vi.fn(async()=>({response:0})),fetch:vi.fn(async()=>new Response("fake-response"))};return {root,deps};
}
it("absent diagnostic launch switch has no admission, profile, UI or network effects",()=>{
 const {root,deps}=setup();expect(createMainProbeEntry(false,deps)).toBeUndefined();
 expect(fs.existsSync(path.join(root,"boot.json"))).toBe(false);
 for(const callback of [deps.listProfileIds,deps.resolveProfile,deps.show,deps.fetch])expect(callback).not.toHaveBeenCalled();
});
it("enabled startup only binds admission; cached profiles and network await the native action",async()=>{
 const {root,deps}=setup();const entry=createMainProbeEntry(true,deps)!;
 expect(fs.existsSync(path.join(root,"boot.json"))).toBe(true);
 expect(deps.resolveProfile).not.toHaveBeenCalled();expect(deps.fetch).not.toHaveBeenCalled();expect(deps.show).not.toHaveBeenCalled();
 await entry.run();expect(deps.resolveProfile).toHaveBeenCalledWith(saved.id);expect(deps.fetch).toHaveBeenCalledOnce();
 expect(JSON.stringify(deps.show.mock.calls)).not.toContain(saved.apiKey);
});
it("does not fall back after a selected cached profile disappears during the native picker",async()=>{
 const {deps}=setup();deps.show.mockImplementation(async()=>{deps.resolveProfile.mockReturnValue(undefined);return {response:0};});
 await createMainProbeEntry(true,deps)!.run();expect(deps.fetch).not.toHaveBeenCalled();
});
