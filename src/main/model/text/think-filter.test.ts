import { describe, expect, it } from "vitest";
import { createThinkFilter, stripThinkBlocks, type ThinkFilterMode } from "./think-filter";
function render(text: string, width: number, mode?: ThinkFilterMode) {
    const reader = createThinkFilter(mode);
    const parts = Array.from({ length: Math.ceil(text.length / width) }, (_, i) => text.slice(i * width, (i + 1) * width));
    return parts.map(part => reader.push(part)).join("") + reader.flush();
}
describe("visible text policy", () => {
    it.each([
        ["<think>consider choices</think>Accepted", "Accepted"],
        ["Ordinary reply", "Ordinary reply"],
        ["Literal `<think>sample</think>` syntax", "Literal `<think>sample</think>` syntax"],
        [" \n<think>draft</think>Final", " \nFinal"],
        ["<think>first</think>A<think>second</think>B", "AB"],
        ["<think>unfinished reasoning", ""],
        ["\t \n ", "\t \n "],
        ["<section>content</section>", "<section>content</section>"],
        ["<THINK>planning</THINK>Done", "Done"],
    ])("applies leading-only filtering to %j", (text, visible) => {
        for (const width of [1, 3, text.length])
            expect(render(text, width)).toEqual(visible);
    });
    it.each([
        ["Start<think>draft</think>Middle<think>revise</think>End", "StartMiddleEnd"],
        ["Body<think>private</think>", "Body"],
        ["Tag <think>example</think> in prose", "Tag  in prose"],
    ])("removes embedded tags in strict mode: %j", (text, visible) => {
        expect(render(text, 1, "strict")).toEqual(visible);
    });
    it("leaves tags untouched when disabled", () => {
        const source = "<think>working notes</think>Answer";
        expect(render(source, 1, "disabled")).toEqual(source);
    });
    it("isolates successive model responses including an unclosed first response", () => {
        expect(render("<think>request a tool", 1)).toEqual("");
        expect(render("Search returned three pages.", 1)).toEqual("Search returned three pages.");
        expect(render("<think>invoke search</think>", 1)).toEqual("");
        expect(render("Here is the final response.", 1)).toEqual("Here is the final response.");
    });
});
describe("stream completion and public thinking", () => {
    it("drains captured reasoning separately from the answer", () => {
        const reader = createThinkFilter();
        let body = reader.push("<thi");
        expect(reader.takeThinking()).toEqual("");
        body += reader.push("nk>Investigate ");
        const first = reader.takeThinking();
        body += reader.push("the result</think>Confirmed");
        const second = reader.takeThinking();
        expect(first + second).toEqual("Investigate the result");
        expect(body + reader.flush()).toEqual("Confirmed");
        expect(reader.takeThinking()).toEqual("");
    });
    it("accepts empty deltas, flushes incomplete probes and emits no duplicate text", () => {
        const reader = createThinkFilter();
        expect([reader.push(""), reader.push(""), reader.flush()]).toEqual(["", "", ""]);
        const unfinished = createThinkFilter();
        expect(unfinished.push("<thi")).toEqual("");
        expect(unfinished.flush()).toEqual("<thi");
        const ordinary = createThinkFilter();
        expect(ordinary.push("Visible")).toEqual("Visible");
        expect(ordinary.flush()).toEqual("");
    });
});
describe("complete-message cleanup", () => {
    it.each([
        ["<think>hidden</think>Public", "Public"], ["<think>still hidden", ""],
        ["one<think>two</think>three<think>four</think>five", "onethreefive"],
        ["No hidden blocks", "No hidden blocks"], ["<Think>private</Think>visible", "visible"],
    ])("cleans %j", (source, expected) => expect(stripThinkBlocks(source)).toEqual(expected));
});
