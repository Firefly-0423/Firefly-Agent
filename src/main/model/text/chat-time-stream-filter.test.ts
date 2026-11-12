import { describe, expect, it } from "vitest";
import { ChatTimeStreamPrefixFilter } from "./chat-time-stream-filter";
describe("reply timestamp suppression", () => {
    it("waits for a split header and releases the body immediately", () => {
        const reader = new ChatTimeStreamPrefixFilter();
        expect(reader.push("[2027-01")).toEqual("");
        expect(reader.push("-09 08:15, Europe/Paris]\nWelcome")).toEqual("Welcome");
        expect(reader.finish()).toEqual("");
    });
    it.each([
        [["Ready ", "when you are."], "Ready when you are."],
        [["[notice]", " keep this"], "[notice] keep this"],
        [["[2027-01-09 08:15, ", "bad zone]keep"], "[2027-01-09 08:15, bad zone]keep"],
        [["[2027-01-"], "[2027-01-"],
        [["[2027-01-09 08:15, Europe/Paris]\n", "[2027-01-09 08:15, Europe/Paris]Body"], "Body"],
    ])("preserves only visible content for chunks %j", (parts, expected) => {
        const reader = new ChatTimeStreamPrefixFilter();
        const visible = parts.reduce((text, piece) => text + reader.push(piece), "");
        expect(visible + reader.finish()).toEqual(expected);
    });
});
