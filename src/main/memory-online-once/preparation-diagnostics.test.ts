import { expect, it } from "vitest";
import { eligibleProfile } from "./boundary";
import { inspectPreparedProfiles } from "./preparation-diagnostics";
import { PROVIDER_CAPABILITIES } from "../orchestrator/vendors/capabilities";
const profile={id:"PRIVATE-ID",provider:PROVIDER_CAPABILITIES.find(c=>c.id==="deepseek")!.displayName,model:"deepseek-flash",baseUrl:"https://api.deepseek.com",apiKey:"FAKE-SECRET"};
it("reports exact rejection categories without broadening existing eligibility",()=>{
 const cases:[string,Partial<typeof profile>&{explicitTransport?:"anthropic"|"responses"|"openai"}][]=[
 ["PROVIDER_MISMATCH",{provider:"PRIVATE-PROVIDER"}],["MODEL_MISMATCH",{model:"PRIVATE-MODEL"}],["BASE_URL_MISMATCH",{baseUrl:"https://api.deepseek.com/v1"}],["TRANSPORT_MISMATCH",{explicitTransport:"anthropic"}],["KEY_MISSING",{apiKey:"  "}]];
 for(const [code,patch] of cases){const p={...profile,...patch};expect(eligibleProfile(p)).toBe(false);const report=inspectPreparedProfiles([p.id],()=>p);expect(report).toEqual({profileCount:1,eligibleProfiles:0,reasons:[{code,count:1}]});expect(JSON.stringify(report)).not.toContain("PRIVATE");expect(JSON.stringify(report)).not.toContain("FAKE-SECRET");}
 expect(inspectPreparedProfiles([profile.id],()=>profile)).toEqual({profileCount:1,eligibleProfiles:1,reasons:[]});
});
it("counts overlapping reasons and strict missing IDs, never falls back or exports raw values",()=>{
 const bad={...profile,model:"PRIVATE-MODEL",apiKey:""};
 expect(inspectPreparedProfiles(["missing",profile.id],id=>id===profile.id?bad:undefined)).toEqual({profileCount:2,eligibleProfiles:0,reasons:[{code:"MODEL_MISMATCH",count:1},{code:"KEY_MISSING",count:1},{code:"PROFILE_UNAVAILABLE",count:1}]});
 expect(inspectPreparedProfiles([],()=>profile)).toEqual({profileCount:0,eligibleProfiles:0,reasons:[{code:"NO_SAVED_PROFILES",count:1}]});
 expect(inspectPreparedProfiles(["different"],()=>profile).reasons).toEqual([{code:"PROFILE_UNAVAILABLE",count:1}]);
});
