import {describe,expect,it} from "vitest";
import {
 objectFields,
 parseFact,
 parseInternalId,
 parseSourceRef,
 positiveRevision,
 textField,
} from "./command-validation";

const INVALID="MEMORY_INPUT_INVALID";

describe("objectFields",()=>{
 it("accepts own enumerable data properties within the allowlist",()=>{
  const value={a:1,b:"two"};
  expect(objectFields(value,["a"],["b"])).toBe(value);
  expect(objectFields(Object.assign(Object.create(null),{a:1}),["a"])).toEqual({a:1});
 });
 it("rejects non-objects, arrays and foreign prototypes",()=>{
  for(const value of [null,undefined,1,"x",[],[1],new Date()]){
   expect(()=>objectFields(value,[])).toThrow(INVALID);
  }
 });
 it("rejects missing required, unknown and symbol keys",()=>{
  expect(()=>objectFields({},["a"])).toThrow(INVALID);
  expect(()=>objectFields({a:1,c:2},["a"])).toThrow(INVALID);
  expect(()=>objectFields({a:1,[Symbol("s")]:1},["a"])).toThrow(INVALID);
 });
 it("rejects accessor and non-enumerable properties",()=>{
  expect(()=>objectFields({get a(){return 1}},["a"])).toThrow(INVALID);
  const hidden={};
  Object.defineProperty(hidden,"a",{value:1,enumerable:false});
  expect(()=>objectFields(hidden,["a"])).toThrow(INVALID);
 });
});

describe("parseInternalId",()=>{
 it("returns valid identifiers",()=>{
  expect(parseInternalId("a")).toBe("a");
  expect(parseInternalId("A-b_9")).toBe("A-b_9");
  expect(parseInternalId("x".repeat(96))).toBe("x".repeat(96));
 });
 it("rejects empty, overlong and disallowed identifiers",()=>{
  expect(()=>parseInternalId("")).toThrow(INVALID);
  expect(()=>parseInternalId("x".repeat(97))).toThrow(INVALID);
  expect(()=>parseInternalId("a.b")).toThrow(INVALID);
  expect(()=>parseInternalId("中文")).toThrow(INVALID);
  expect(()=>parseInternalId(7)).toThrow(INVALID);
 });
});

describe("positiveRevision",()=>{
 it("accepts safe positive integers",()=>{
  expect(positiveRevision(1)).toBe(1);
  expect(positiveRevision(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
 });
 it("rejects zero, negatives, fractions and non-numbers",()=>{
  for(const value of [0,-1,1.5,Number.NaN,Infinity,"1",null]){
   expect(()=>positiveRevision(value)).toThrow(INVALID);
  }
 });
});

describe("parseSourceRef",()=>{
 it("parses a minimal reference and trims nothing from identifiers",()=>{
  expect(parseSourceRef({sourceId:"source-a",revision:2})).toEqual({sourceId:"source-a",revision:2});
 });
 it("parses an optional binding and span",()=>{
  const value={sourceId:"s",revision:1,binding:{providerId:"p",sessionId:"sess",messageId:"m",contentRevision:3,generation:"g"},span:{start:0,end:4}};
  expect(parseSourceRef(value)).toEqual(value);
 });
 it("rejects invalid bindings and spans",()=>{
  expect(()=>parseSourceRef({sourceId:"s",revision:1,binding:{providerId:"p"}})).toThrow(INVALID);
  expect(()=>parseSourceRef({sourceId:"s",revision:1,binding:{providerId:"p",sessionId:"s",messageId:"m",contentRevision:0,generation:"g"}})).toThrow(INVALID);
  expect(()=>parseSourceRef({sourceId:"s",revision:1,span:{start:2,end:2}})).toThrow(INVALID);
  expect(()=>parseSourceRef({sourceId:"s",revision:1,span:{start:-1,end:2}})).toThrow(INVALID);
  expect(()=>parseSourceRef({sourceId:"s",revision:1,span:{start:0.5,end:2}})).toThrow(INVALID);
 });
});

describe("textField",()=>{
 it("accepts non-blank strings within the byte limit",()=>{
  expect(textField("hello")).toBe("hello");
  expect(textField("a".repeat(65_536))).toHaveLength(65_536);
 });
 it("rejects empty, whitespace-only and oversized strings",()=>{
  for(const value of ["","   ","a".repeat(65_537),null,1]){
   expect(()=>textField(value)).toThrow(INVALID);
  }
 });
});

describe("parseFact",()=>{
 const valid={subjectKey:"topic",assertion:"assertion",assertionKind:"user-statement",time:{validFrom:null,validTo:null,referenceTime:null}};
 it("parses a fact and copies the time object",()=>{
  const parsed=parseFact(valid);
  expect(parsed).toEqual(valid);
  expect(parsed.time).not.toBe(valid.time);
 });
 it("accepts both assertion kinds and integer times",()=>{
  expect(parseFact({...valid,assertionKind:"inference",time:{validFrom:1,validTo:2,referenceTime:3}}).assertionKind).toBe("inference");
 });
 it("rejects unknown assertion kinds",()=>{
  expect(()=>parseFact({...valid,assertionKind:"guess"})).toThrow(INVALID);
 });
 it("rejects malformed time values with MEMORY_TIME_INVALID",()=>{
  expect(()=>parseFact({...valid,time:null})).toThrow(INVALID);
  expect(()=>parseFact({...valid,time:{validFrom:1.5,validTo:null,referenceTime:null}})).toThrow("MEMORY_TIME_INVALID");
  expect(()=>parseFact({...valid,time:{validFrom:"1",validTo:null,referenceTime:null}})).toThrow("MEMORY_TIME_INVALID");
  expect(()=>parseFact({...valid,time:{validFrom:5,validTo:5,referenceTime:null}})).toThrow("MEMORY_TIME_INVALID");
  expect(()=>parseFact({...valid,time:{validFrom:6,validTo:5,referenceTime:null}})).toThrow("MEMORY_TIME_INVALID");
 });
 it("rejects blank fact text",()=>{
  expect(()=>parseFact({...valid,subjectKey:" "})).toThrow(INVALID);
  expect(()=>parseFact({...valid,assertion:""})).toThrow(INVALID);
 });
});
