import {describe,expect,it} from "vitest";
import {projectFailure} from "./diagnostics";
import {inspectUsage} from "./boundary";
const secret="SYNTHETIC-DO-NOT-EXPOSE";
const usage={is_byok:false,prompt_tokens:100,completion_tokens:20,total_tokens:120,cost:0.000027};
const raw={id:secret,object:"chat.completion",provider:"DeepSeek",model:"deepseek/deepseek-v4.1-flash",choices:[{index:0,message:{role:"assistant",content:secret},finish_reason:"stop"}],usage};
describe("safe diagnostics projection",()=>{
 it.each([null,{},[],{code:secret},{code:"toString"},{code:"constructor"}])("rejects unknown or inherited codes %j",value=>expect(projectFailure(value)).toBeUndefined());
 it.each([401,"401",NaN,-1,600,null])("only carries bounded integer HTTP status %j",value=>{
  const r=projectFailure({code:"HTTP_REJECTED",stage:secret,httpStatus:value,error:secret});expect(r).toEqual({code:"HTTP_REJECTED",stage:"http",...(value===401?{httpStatus:401}:{})});expect(JSON.stringify(r)).not.toContain(secret);
 });
 it.each([
  [null,"ENVELOPE_INVALID"],[{...raw,model:secret},"IDENTITY_MISMATCH"],[{...raw,provider:undefined},"IDENTITY_MISMATCH"],
  [{...raw,choices:[]},"ENVELOPE_INVALID"],[{...raw,usage:{}},"USAGE_INVALID"],
  [{...raw,usage:{...usage,is_byok:undefined}},"BILLING_SOURCE_INVALID"],
  [{...raw,usage:{...usage,cost:secret}},"COST_INVALID"],
 ])("classifies response evidence without echo %j",(input,code)=>{const r=inspectUsage(input);expect(r).toMatchObject({failure:{code}});expect(JSON.stringify(r)).not.toContain(secret);});
 it("projects only numeric accepted usage",()=>{const r=inspectUsage(raw);expect(r).toMatchObject({usage:{costNanoUsd:27000}});expect(JSON.stringify(r)).not.toContain(secret);});
});
