import {describe,expect,it} from "vitest";
import {SHADOW_DROP_REASONS,type ShadowTurn} from "./shadow-contracts";
import {validateShadowResponse} from "./shadow-validate";

const turn:ShadowTurn={user:{id:"user-1",text:"我喜欢喝美式咖啡"}};
function item(overrides:Record<string,unknown>={}){
 return{subject:"user",attribute:"preference",value:"美式咖啡",polarity:"positive",status:"asserted",quote:"我喜欢喝美式咖啡",reason:"用户明确表达偏好",...overrides};
}
function response(facts:unknown[]){return JSON.stringify({facts});}
function zeroDropped(){
 return Object.fromEntries(SHADOW_DROP_REASONS.map(reason=>[reason,0]));
}

describe("validateShadowResponse",()=>{
 it("accepts a valid candidate and preserves the evidence",()=>{
  const result=validateShadowResponse(response([item()]),turn);
  expect(result).toEqual({
   candidates:[{attribute:"preference",value:"美式咖啡",polarity:"positive",status:"asserted",evidence:{messageId:"user-1",quote:"我喜欢喝美式咖啡"},reason:"用户明确表达偏好"}],
   dropped:zeroDropped(),
   downgraded:0,
  });
 });
 it("accepts a fenced JSON response",()=>{
  const raw="```json\n"+response([item()])+"\n```";
  expect(validateShadowResponse(raw,turn).candidates).toHaveLength(1);
 });
 it("rejects non-JSON, non-objects, extra root keys and non-array facts as schema errors",()=>{
  for(const raw of ["not json",JSON.stringify([]),JSON.stringify({facts:[],other:1}),JSON.stringify({facts:"x"}),"",42]){
   expect(validateShadowResponse(raw,turn).dropped.schema).toBe(1);
  }
 });
 it("rejects responses over 20k characters without parsing",()=>{
  expect(validateShadowResponse(" ".repeat(20_001),turn).dropped.schema).toBe(1);
 });
 it("rejects items missing required fields or with invalid enum values",()=>{
  const cases=[
   {...item(),extra:true},
   item({subject:"someone"}),
   item({attribute:"health"}),
   item({polarity:"neutral"}),
   item({status:"known"}),
   item({value:""}),
   item({value:"x".repeat(81)}),
   item({quote:"x".repeat(201)}),
   item({reason:"x".repeat(201)}),
   "not an object",
  ];
  expect(validateShadowResponse(response(cases),turn).dropped.schema).toBe(cases.length);
 });
 it("rejects too-short quotes unless the quote itself is an affirmation",()=>{
  expect(validateShadowResponse(response([item({quote:"我"})]),{user:{id:"u",text:"我"}}).dropped.schema).toBe(1);
  const affirmed=validateShadowResponse(response([item({quote:"嗯",value:"同意"})]),{user:{id:"u",text:"嗯"}});
  expect(affirmed.candidates).toHaveLength(1);
 });
 it("rejects quotes that are not verbatim in the user text",()=>{
  const result=validateShadowResponse(response([item({quote:"我喜欢喝茶"})]),turn);
  expect(result.candidates).toEqual([]);
  expect(result.dropped["quote-not-in-user"]).toBe(1);
 });
 it("rejects facts about other people",()=>{
  const otherTurn={user:{id:"u",text:"我妈妈喜欢喝美式咖啡"}};
  const bySubject=validateShadowResponse(response([item({subject:"other",quote:"美式咖啡"})]),otherTurn);
  expect(bySubject.dropped["about-other"]).toBe(1);
  const bySentence=validateShadowResponse(response([item({quote:"喜欢喝美式咖啡"})]),otherTurn);
  expect(bySentence.dropped["about-other"]).toBe(1);
 });
 it("rejects sensitive categories and sensitive value shapes",()=>{
  const sensitiveTurn={user:{id:"u",text:"我对花粉过敏"}};
  expect(validateShadowResponse(response([item({value:"花粉过敏",quote:"我对花粉过敏",reason:"健康信息"})]),sensitiveTurn).dropped.sensitive).toBe(1);
  const emailTurn={user:{id:"u",text:"我的邮箱是 a@b.com"}};
  expect(validateShadowResponse(response([item({value:"a@b.com",quote:"我的邮箱是 a@b.com"})]),emailTurn).dropped.sensitive).toBe(1);
  const phoneTurn={user:{id:"u",text:"电话 138 0013 8000"}};
  expect(validateShadowResponse(response([item({value:"13800138000",quote:"138 0013 8000"})]),phoneTurn).dropped.sensitive).toBe(1);
 });
 it("rejects temporary statements",()=>{
  const temporaryTurn={user:{id:"u",text:"今天想喝美式咖啡"}};
  expect(validateShadowResponse(response([item({quote:"今天想喝美式咖啡"})]),temporaryTurn).dropped.temporary).toBe(1);
 });
 it("rejects duplicate attribute/polarity/value combinations case-insensitively",()=>{
  const result=validateShadowResponse(response([item(),item({value:"美式咖啡"})]),turn);
  expect(result.candidates).toHaveLength(1);
  expect(result.dropped.duplicate).toBe(1);
 });
 it("caps candidates at five and counts the rest as over-limit",()=>{
  const facts=Array.from({length:6},(_,index)=>item({value:`value-${index}`,quote:`我喜欢喝美式咖啡`}));
  const result=validateShadowResponse(response(facts),turn);
  expect(result.candidates).toHaveLength(5);
  expect(result.dropped["over-limit"]).toBe(1);
 });
 it("downgrades asserted candidates when the user only affirmed",()=>{
  const result=validateShadowResponse(response([item({quote:"好的",value:"同意"})]),{user:{id:"u",text:"好的"}});
  expect(result.candidates[0].status).toBe("needs-confirmation");
  expect(result.downgraded).toBe(1);
 });
 it("downgrades an asserted candidate whose quote is an affirmation",()=>{
  const result=validateShadowResponse(response([item({quote:"嗯",value:"同意"})]),{user:{id:"u",text:"嗯"}});
  expect(result.candidates[0].status).toBe("needs-confirmation");
 });
 it("keeps needs-confirmation candidates unchanged",()=>{
  const result=validateShadowResponse(response([item({status:"needs-confirmation"})]),turn);
  expect(result.candidates[0].status).toBe("needs-confirmation");
  expect(result.downgraded).toBe(0);
 });
});
