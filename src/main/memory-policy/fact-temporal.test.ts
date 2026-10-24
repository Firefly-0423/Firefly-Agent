import {expect,it} from "vitest";
import {parseFactTemporal,parseFactTimeQuery} from "./fact-temporal";

const source={occurredAt:Date.parse("2026-03-09T12:00:00Z"),timeZone:"America/New_York"};
const interval=(from:string,to:string)=>({validFrom:Date.parse(from),validTo:Date.parse(to),referenceTime:source.occurredAt});
// Removing host-calendar resolution must fail these assertions, not just a mock call count.
it("anchors yesterday to the original event and observes the 23-hour DST day",()=>{
 const text="Yesterday, I prefer English";
 expect(parseFactTemporal(text,source)).toEqual({kind:"resolved",time:interval("2026-03-08T05:00:00Z","2026-03-09T04:00:00Z"),clause:{start:11,end:text.length}});
});
it("resolves last month across year boundaries in the host timezone",()=>{
 const anchor={occurredAt:Date.parse("2026-01-10T00:00:00Z"),timeZone:"Asia/Shanghai"};
 expect(parseFactTemporal("上个月，我喜欢咖啡",anchor)).toMatchObject({kind:"resolved",time:{validFrom:Date.parse("2025-11-30T16:00:00Z"),validTo:Date.parse("2025-12-31T16:00:00Z"),referenceTime:anchor.occurredAt}});
});
it("uses inclusive named dates and an exclusive end midnight",()=>{
 expect(parseFactTemporal("From 2026-01-01 to 2026-01-31, I use bash",source)).toMatchObject({kind:"resolved",time:interval("2026-01-01T05:00:00Z","2026-02-01T05:00:00Z")});
 expect(parseFactTemporal("2026-02-01至2026-02-28，我喜欢茶",source)).toMatchObject({kind:"resolved",time:interval("2026-02-01T05:00:00Z","2026-03-01T05:00:00Z")});
});
it.each(["2026-02-30，我喜欢茶","2026-03-02至2026-03-01，我喜欢茶","Recently, I like tea","Yesterday and today, I like tea","I liked tea last month"])("leaves ambiguous or invalid temporal assertion unresolved: %s",text=>{
 expect(parseFactTemporal(text,source).kind).toBe("unresolved");
});
it.each([{}, {occurredAt:source.occurredAt},{timeZone:"UTC"},{...source,timeZone:"invalid/zone"},{...source,occurredAt:NaN}])("does not fabricate an anchor or zone: %j",anchor=>{
 expect(parseFactTemporal("Yesterday, I like tea",anchor).kind).toBe("unresolved");
});
it("preserves undated assertions as undated",()=>expect(parseFactTemporal("I prefer English",source)).toEqual({kind:"none"}));
it("reads an explicit historical question but never a quotation or hypothetical",()=>{
 expect(parseFactTimeQuery("What language did I prefer yesterday?",source)).toEqual(interval("2026-03-08T05:00:00Z","2026-03-09T04:00:00Z"));
 for(const text of ['Translate "what did I prefer yesterday?"','If I liked tea yesterday, what then?','What do I prefer?','What did I prefer yesterday and today?'])expect(parseFactTimeQuery(text,source)).toBeUndefined();
});
