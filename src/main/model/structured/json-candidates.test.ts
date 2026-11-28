import { describe, expect, it } from "vitest";
import { extractJsonCandidates } from "./json-candidates";

describe("Objects recovered from model text", () => {
  it("returns a trimmed direct object with its extraction provenance", () => {
    expect(extractJsonCandidates(' \n {"count":17} \t')).toStrictEqual([
      { raw: '{"count":17}', value: { count: 17 }, method: "direct" },
    ]);
  });

  it("prioritizes fenced objects before scanning surrounding prose and preserves discovery order", () => {
    const fenced = '{"route":"review"}';
    const trailing = '{"route":"clarify"}';
    expect(extractJsonCandidates(`Start\n\`\`\`json\n${fenced}\n\`\`\`\nNext ${trailing}`)).toStrictEqual([
      { raw: fenced, value: { route: "review" }, method: "fence" },
      { raw: trailing, value: { route: "clarify" }, method: "scan" },
    ]);
  });

  it("reads nested JSON while quoted braces, escaped quotes and Windows slashes remain data", () => {
    const payload = { label: '流萤 {literal} "caption" D:\\notes', options: { enabled: false, rows: [3, { k: 9 }] } };
    const raw = JSON.stringify(payload);
    expect(extractJsonCandidates(`Answer follows: ${raw} Done.`)).toStrictEqual([
      { raw, value: payload, method: "scan" },
    ]);
  });

  it("collapses key-order variants across fences and scans, retaining the first representation", () => {
    expect(extractJsonCandidates('```json\n{"y":7,"x":{"q":4,"p":3}}\n```\n{"x":{"p":3,"q":4},"y":7}')).toStrictEqual([
      { raw: '{"y":7,"x":{"q":4,"p":3}}', value: { y: 7, x: { q: 4, p: 3 } }, method: "fence" },
    ]);
  });

  it.each(["", " \t\n", "null", "false", "73", '"message"', "[5,8]", '{"broken":', "{unquoted: 2}"])(
    "does not invent an object for %j", (text) => expect(extractJsonCandidates(text)).toStrictEqual([]),
  );
});
