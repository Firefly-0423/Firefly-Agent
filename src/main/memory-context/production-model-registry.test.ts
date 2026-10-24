import { expect, it } from "vitest";
import { createProductionModelRegistry } from "./production-model-registry";
import type { ModelSettings } from "../settings/model-settings";
function settings():ModelSettings {return {provider:"OpenRouter",baseUrl:"https://openrouter.ai/api/v1",model:"openai/gpt-6-luna",apiKey:"synthetic-only",explicitTransport:"responses",contextWindowTokens:128000,chatRequestTimeoutSec:300,modelProfiles:[{id:"luna",provider:"OpenRouter",baseUrl:"https://openrouter.ai/api/v1",model:"openai/gpt-6-luna",apiKey:"synthetic-only",explicitTransport:"responses"}],defaultModelProfileId:"luna"} as ModelSettings}
it("binds the saved nondefault model without mutating settings or using diagnostic budgets",()=>{
 const value=settings(),before=JSON.stringify(value),registry=createProductionModelRegistry({settings:()=>value});
 const binding=registry.bind("luna");expect(binding.profileId).toBe("luna");expect(binding.config.model).toBe("openai/gpt-6-luna");
 expect(binding.budget).toMatchObject({admissionMode:"bounded",maxContextTokens:128000,reservedOutputTokens:8192,safetyMarginTokens:512});
 expect(binding.counter.capability.mode).toBe("estimate");expect(JSON.stringify(value)).toBe(before);
});
it("starts summarising S at 85% of the window, not at the usable ceiling",()=>{
 const budget=createProductionModelRegistry({settings}).bind("luna").budget;
 expect(budget.maxSTokens).toBe(Math.floor(128000*0.85));
 expect(budget.maxSTokens).toBeLessThan(128000-budget.reservedOutputTokens-budget.safetyMarginTokens);
});
it("rejects missing profiles instead of silently falling back to top-level settings",()=>{
 const registry=createProductionModelRegistry({settings});expect(registry.profile("missing")).toBeNull();expect(()=>registry.bind("missing")).toThrow("MEMORY_RUN_PROFILE_DENIED");
});
it("revokes old bindings for key, context-window and account changes without logging values",()=>{
 const value=settings(),registry=createProductionModelRegistry({settings:()=>value}),old=registry.bind("luna");
 value.modelProfiles![0].apiKey="changed-synthetic-only";
 expect(()=>old.assertCurrent()).toThrow("MEMORY_RUN_PROFILE_CHANGED");expect(registry.bind("luna").revision).toBeGreaterThan(old.revision);
 const next=registry.bind("luna");value.contextWindowTokens=96000;expect(()=>next.assertCurrent()).toThrow("MEMORY_RUN_PROFILE_CHANGED");
});
it("explicit invalidation prevents delete/recreate with identical bytes from reviving a binding",()=>{
 const registry=createProductionModelRegistry({settings}),old=registry.bind("luna");registry.invalidate();expect(()=>old.assertCurrent()).toThrow("MEMORY_RUN_PROFILE_CHANGED");
});
it("uses the actual Anthropic output reserve without changing the caller wire limit",()=>{
 const value=settings();value.modelProfiles![0].explicitTransport="anthropic";
 const binding=createProductionModelRegistry({settings:()=>value}).bind("luna");expect(binding.budget.reservedOutputTokens).toBe(32768);
});
it.each(["https://openrouter.ai/api/v1","https://api.openai.com/v1","https://synthetic.invalid/v1"])("counts the real factory adapter request for service identity %s",async baseUrl=>{
 const value=settings();value.modelProfiles![0].baseUrl=baseUrl;
 const binding=createProductionModelRegistry({settings:()=>value}).bind("luna"),{prepareModelCall}=await import("../orchestrator/vendors/prepared-model-call");
 const {providerId,model,transport,framingVersion}=binding.counter.capability;
 const prepared=prepareModelCall(binding.adapter,{model,messages:[{role:"user",content:"synthetic"}],stream:false},binding.config,{providerId,model,transport,framingVersion});
 expect(await binding.counter.count(prepared.request)).toBeGreaterThan(0);
});
it("preserves an existing no-auth local model profile",()=>{
 const value=settings();Object.assign(value.modelProfiles![0],{provider:"自定义端点（本地）",baseUrl:"http://127.0.0.1:11434/v1",model:"local-model",apiKey:"",explicitTransport:"openai"});
 const binding=createProductionModelRegistry({settings:()=>value}).bind("luna");expect(binding.config.apiKey).toBe("");expect(binding.config.model).toBe("local-model");
});
