import { describe, it, expect } from "vitest";
import { parseMemoryJudgeResult, validateMemoryJudgeBusiness, isValidSlug, isValidSourceQuote } from "./memory-schemas";
const candidate = { layer: "L2", content: "User practices watercolor painting", confidence: 0.87, triggerText: "I paint on Saturdays" };
const parse = (patch: Record<string, unknown>) => parseMemoryJudgeResult({ candidates: [{ ...candidate, ...patch }] }).candidates[0];
describe("judge response envelopes", () => {
    it("preserves the candidate contract and supplies an empty entity list", () => {
        const item = { ...candidate, layer: "L1", content: "User is studying watercolor techniques" };
        expect(parseMemoryJudgeResult({ candidates: [item] })).toEqual({ candidates: [item], entities: [] });
        const empty = parseMemoryJudgeResult({ candidates: [] });
        expect(validateMemoryJudgeBusiness(empty)).toEqual({ status: "accepted", value: { candidates: [], entities: [] } });
    });
    it("retains named entities and aliases in order while rejecting unknown types", () => {
        const entities = [{ name: "Lina", type: "person", aliases: ["Lin"] }, { name: "Kyoto", type: "place" }];
        expect(parseMemoryJudgeResult({ candidates: [], entities }).entities).toEqual(entities);
        expect(() => parseMemoryJudgeResult({ candidates: [], entities: [{ name: "Example", type: "not-a-type" }] })).toThrow();
    });
});
describe("L2 optional text fields", () => {
    it("trims accepted titles and verbatim quotes", () => {
        expect(parse({ slug: "  水彩练习  " }).slug).toEqual("水彩练习");
        expect(parse({ sourceQuote: "\tI used Krita 5.2, with a tablet.\n" }).sourceQuote).toEqual("I used Krita 5.2, with a tablet.");
        const quoted = "绘画、练习 与 调色！🎨";
        expect(parse({ sourceQuote: quoted }).sourceQuote).toEqual(quoted);
    });
    it.each(["水彩，练习", "水彩🎨", "长".repeat(21)])("drops an invalid title %j without dropping the candidate", slug => {
        const item = parse({ slug });
        expect(item.slug).toBeUndefined();
        expect(item.content).toEqual(candidate.content);
    });
    it.each(["L0", "L1"])("discards L2-only fields on %s candidates", layer => {
        const item = parse({ layer, field: "recentPreferences", slug: "水彩练习", sourceQuote: "I paint on Saturdays" });
        expect(item.slug).toBeUndefined();
        expect(item.sourceQuote).toBeUndefined();
    });
    it("accepts a 500-character quote and drops a 501-character or blank quote", () => {
        const limit = "q".repeat(500);
        expect(parse({ sourceQuote: limit }).sourceQuote).toEqual(limit);
        for (const sourceQuote of ["q".repeat(501), "\t \n"]) {
            const item = parse({ sourceQuote });
            expect(item.sourceQuote).toBeUndefined();
            expect(item.content).toEqual(candidate.content);
        }
    });
});
describe("text validators", () => {
    it.each(["水彩练习", "和同学画画", "Canvas绘画", "canvas_art-work", "日记_2042", "a".repeat(20)])("accepts a filename-safe title %j", value => expect(isValidSlug(value)).toEqual(true));
    it.each([undefined, null, 456, "", "\t ", "长".repeat(21), "水彩，练习", "水彩 练习", "水彩「练习」", "水彩🎨", "水彩/练习"])("rejects an unsafe title %j", value => expect(isValidSlug(value)).toEqual(false));
    it.each(["喜欢水彩", "I used Krita 5.2, with a tablet.", "绘画 很开心！🎨", "q".repeat(500)])("accepts verbatim evidence %j", value => expect(isValidSourceQuote(value)).toEqual(true));
    it.each([undefined, null, 456, "", "\t \n", "q".repeat(501)])("rejects unusable evidence %j", value => expect(isValidSourceQuote(value)).toEqual(false));
});
