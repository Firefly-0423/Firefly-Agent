import { expect, it, describe } from "vitest";
import { buildFullFileDiff, buildReplacedDiff, countLines, extractFileChangesFromOutput, finalizeFileChanges, parseUnifiedPatch } from "./tool-evidence";
import type { ToolFileChange } from "../../../../shared/chat-types";

const addition = (file: string, size: number): ToolFileChange => ({
  file, kind: "added", insertions: size, deletions: 0,
  diff: Array.from({ length: size }, (_, n) => ({ type: "add", text: `entry ${n + 10}` })),
});

describe("review evidence budgets", () => {
  it("preserves a small change without a truncation flag", () => {
    const change = addition("short.txt", 2);
    expect(finalizeFileChanges([change])).toEqual([change]);
    expect(finalizeFileChanges([change])[0].truncated).toBeUndefined();
  });
  it("limits a large file to sixty ordered rows while retaining its totals", () => {
    const change = addition("long.txt", 100);
    expect(finalizeFileChanges([change])).toEqual([{ ...change, diff: change.diff!.slice(0, 60), truncated: true }]);
    expect(finalizeFileChanges([addition("exact.txt", 60)])[0].truncated).toBeUndefined();
  });
  it("allocates two hundred rows in file order and omits later exhausted diffs", () => {
    const input = ["north", "east", "south", "west", "extra"].map(name => addition(`${name}.txt`, 60));
    const result = finalizeFileChanges(input);
    expect(result.map(row => row.diff?.length)).toEqual([60, 60, 60, 20, undefined]);
    expect(result.slice(0, 3)).toEqual(input.slice(0, 3));
    expect(result[3]).toEqual({ ...input[3], diff: input[3].diff!.slice(0, 20), truncated: true });
    expect(result[4]).toEqual({ ...input[4], diff: undefined, truncated: true });
  });
});

describe("diff text presented to reviewers", () => {
  it("places removed rows before inserted rows between the surrounding context", () => {
    expect(buildReplacedDiff(["retired", "obsolete"], ["replacement"], ["heading"], ["footer"]))
      .toEqual([
        { type: "context", text: "heading" }, { type: "remove", text: "retired" },
        { type: "remove", text: "obsolete" }, { type: "add", text: "replacement" },
        { type: "context", text: "footer" },
      ]);
  });
  it.each(["add", "remove"] as const)("labels all full-file rows as %s", (type) => {
    expect(buildFullFileDiff(["first record", "second record"], type))
      .toEqual([{ type, text: "first record" }, { type, text: "second record" }]);
  });
  it("clips only text beyond two hundred characters and appends an ellipsis", () => {
    const exact = "q".repeat(200);
    expect(buildFullFileDiff([exact, `${exact}r`, "q".repeat(300)], "add").map(row => row.text))
      .toEqual([exact, `${exact}…`, `${exact}…`]);
  });
  it("ignores patch metadata and preserves the hunk and row sequence", () => {
    const patch = ["diff --git a/report.txt b/report.txt", "index abc..def 100644", "--- a/report.txt", "+++ b/report.txt", "@@ -4,2 +4,2 @@", " same", "-previous", "+current"].join("\n");
    expect(parseUnifiedPatch(patch)).toEqual([
      { type: "hunk", text: "@@ -4,2 +4,2 @@" }, { type: "context", text: "same" },
      { type: "remove", text: "previous" }, { type: "add", text: "current" },
    ]);
  });
  it.each([["red\nblue\n", 2], ["red\nblue", 2], ["", 0]] as const)("counts lines in %j", (text, total) => {
    expect(countLines(text)).toBe(total);
  });
});

describe("changes extracted from tool output", () => {
  it("returns all valid change records", () => {
    const changes = [{ file: "notes/review.md", kind: "modified", insertions: 2, deletions: 1 }];
    expect(extractFileChangesFromOutput(JSON.stringify({ tool: "str_replace", success: true, changes }))).toEqual(changes);
  });
  it.each([
    undefined, "ordinary reply", JSON.stringify({ success: true }), JSON.stringify({ changes: [] }),
    JSON.stringify({ changes: [{ file: "incomplete.txt" }] }),
    JSON.stringify({ changes: [{ file: "unknown.txt", kind: "unsupported", insertions: 1, deletions: 0 }] }),
    JSON.stringify({ changes: [addition("partial.txt", 2)] }).slice(0, 30),
  ])("does not invent evidence for invalid output %j", (output) => {
    expect(extractFileChangesFromOutput(output)).toBeUndefined();
  });
});
