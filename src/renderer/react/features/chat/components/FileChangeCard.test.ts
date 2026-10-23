import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";
import { extractFileChanges, FileChangeCard } from "./FileChangeCard";

const edits = [
  { file: "lib/config.ts", kind: "modified" as const, insertions: 3, deletions: 1,
    diff: [{ type: "context" as const, text: "const enabled = true;" },
      { type: "remove" as const, text: "const retries = 1;" },
      { type: "add" as const, text: "const retries = 5;" }] },
  { file: "notes/release.md", kind: "added" as const, insertions: 10, deletions: 0 },
];
afterEach(() => vi.unstubAllGlobals());

test("preserves all file metadata and diff ordering from tool output", () => {
  const parsed = extractFileChanges(JSON.stringify({ tool: "write_file", success: true, changes: edits }));
  expect(parsed).not.toBeNull();
  expect(parsed).toHaveLength(2);
  expect(parsed).toStrictEqual(edits);
});

test.each([
  "not structured output", JSON.stringify({ success: true }),
  JSON.stringify({ changes: [] }), JSON.stringify({ changes: [{ file: "invalid.ts" }] }),
  JSON.stringify({ changes: [{ file: "invalid.ts", kind: "unknown", insertions: 2, deletions: 1 }] }),
  JSON.stringify({ changes: [{ ...edits[0], file: "" }] }), "null",
])("rejects incomplete file change results: %s", (payload) => {
  expect(extractFileChanges(payload)).toBeNull();
});

test("shows aggregate and per-file counts with diff contents initially hidden", () => {
  vi.stubGlobal("React", React);
  const markup = renderToStaticMarkup(React.createElement(FileChangeCard, { changes: edits }));
  for (const required of ["2 个文件变更", "+13", "−1", "+3", "config.ts", "release.md",
    "ff-file-change-card__kind is-modified", "ff-file-change-card__kind is-added",
    "ff-file-change-card__dir", "ff-file-change-card__row is-expandable"]) expect(markup).toContain(required);
  expect(markup).not.toContain("ff-file-change-card__diff");
  expect(markup).not.toContain("const retries = 5;");
  expect(markup.match(/aria-expanded="false"/g)).toHaveLength(1);
});
