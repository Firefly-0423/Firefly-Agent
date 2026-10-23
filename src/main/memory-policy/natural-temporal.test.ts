import {expect,it} from "vitest";
import {validateNaturalResponse} from "./natural-protocol";
const source={occurredAt:Date.parse("2026-03-09T12:00:00Z"),timeZone:"America/New_York"};
const raw=(quote:string,patch:Record<string,unknown>={})=>JSON.stringify({facts:[{subject:"user",attribute:"language",value:"English",polarity:"positive",status:"asserted",quote,reason:"direct user statement",...patch}]});
it("validates a dated factual clause and retains original evidence offsets and host-derived time",()=>{
 const text="Yesterday, I prefer English";
 expect(validateNaturalResponse(raw(text),text,"message",source)).toEqual([{attribute:"language",value:"English",polarity:"positive",quote:text,span:{start:0,end:text.length},time:{validFrom:Date.parse("2026-03-08T05:00:00Z"),validTo:Date.parse("2026-03-09T04:00:00Z"),referenceTime:source.occurredAt}}]);
 expect(validateNaturalResponse(raw("I prefer English"),text,"message",source)[0]).toMatchObject({span:{start:11,end:27},time:{referenceTime:source.occurredAt}});
});
it.each(['Yesterday, use English for this reply','Yesterday, my wife prefers English','Yesterday, if I prefer English','Yesterday, I do not prefer English','Yesterday, I prefer English because of my medical condition','Recently, I prefer English','"Yesterday, I prefer English"'])("does not strip unsafe context to manufacture a dated fact: %s",text=>{
 expect(validateNaturalResponse(raw(text),text,"message",source)).toEqual([]);
});
it("refuses temporal content without provenance or with model-supplied time fields",()=>{
 const text="2026-03-01, I prefer English";
 expect(validateNaturalResponse(raw(text),text,"message")).toEqual([]);
 expect(validateNaturalResponse(raw(text,{time:{validFrom:1,validTo:2}}),text,"message",source)).toEqual([]);
});
