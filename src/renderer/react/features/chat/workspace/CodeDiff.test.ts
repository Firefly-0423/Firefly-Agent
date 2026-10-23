// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReviewSnapshot } from "../../../../../shared/review-types";
import { CodeDiff } from "./CodeDiff";
import { WorkspaceChangeDiff } from "./WorkspaceRunResults";

vi.mock("../../../i18n", () => ({ useTranslation: () => ({ t: (key: string, options?: { count?: number }) => options?.count !== undefined ? `${key}:${options.count}` : key }) }));

let host: HTMLDivElement; let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); delete (window as { review?: unknown }).review; vi.unstubAllGlobals(); });

const hunks = [
  { oldStart: 3, oldLines: 2, newStart: 3, newLines: 2, lines: [
    { type: "context" as const, oldLine: 3, newLine: 3, text: "keep" },
    { type: "remove" as const, oldLine: 4, newLine: null, text: "old" },
    { type: "add" as const, oldLine: null, newLine: 4, text: "new" },
  ] },
  { oldStart: 14, oldLines: 1, newStart: 14, newLines: 1, lines: [{ type: "add" as const, oldLine: null, newLine: 14, text: "tail" }] },
];

it("numbers each line and folds untouched stretches into one bar", () => {
  act(() => root.render(createElement(CodeDiff, { hunks })));
  const rows = [...host.querySelectorAll<HTMLElement>(".ff-code-diff > *")];
  expect(rows.map(row => row.className.includes("gap") ? `gap ${row.textContent}` : `${row.querySelector(".ff-code-diff__number")?.textContent}|${row.querySelector(".ff-code-diff__text")?.textContent}`))
    .toEqual(["gap workspace.unmodifiedLines:2", "3|keep", "4|old", "4|new", "gap workspace.unmodifiedLines:9", "14|tail"]);
  expect(host.querySelector(".ff-code-diff__line.is-remove .ff-code-diff__sign")?.textContent).toBe("−");
});

it("shows the run's full diff instead of the capped tool evidence once the snapshot is in", async () => {
  const snapshot: ReviewSnapshot = { runId: "r1", startedAt: 0, endedAt: 1, status: "completed",
    files: [{ kind: "modified", oldPath: "src/a.ts", newPath: "src/a.ts", additions: 2, deletions: 1, hunks }] };
  (window as { review?: unknown }).review = { get: vi.fn(async () => snapshot), restore: vi.fn() };
  const change = { file: "E:\\proj\\src\\a.ts", kind: "modified" as const, insertions: 1, deletions: 0, diff: [{ type: "add" as const, text: "cut" }], truncated: true };
  await act(async () => root.render(createElement(WorkspaceChangeDiff, { change, runId: "r1", workspaceRoot: "E:\\proj" })));
  expect([...host.querySelectorAll(".ff-code-diff__text")].map(node => node.textContent)).toEqual(["keep", "old", "new", "tail"]);
  expect(host.textContent).not.toContain("fileChange.truncated");
  expect(host.querySelector("header small")?.textContent).toBe("+2 / −1");
});

it("falls back to the tool evidence, with its cut-off note, when the run has no snapshot", async () => {
  (window as { review?: unknown }).review = { get: vi.fn(async () => null), restore: vi.fn() };
  const change = { file: "b.ts", kind: "modified" as const, insertions: 1, deletions: 0, diff: [{ type: "add" as const, text: "cut" }], truncated: true };
  await act(async () => root.render(createElement(WorkspaceChangeDiff, { change, runId: "r2" })));
  expect([...host.querySelectorAll(".ff-code-diff__text")].map(node => node.textContent)).toEqual(["cut"]);
  expect(host.textContent).toContain("fileChange.truncated");
});

it("lists produced files with a file-type icon, and unfolds a row into its full diff", async () => {
  const { WorkspaceOutputFiles } = await import("./WorkspaceRunResults");
  const snapshot: ReviewSnapshot = { runId: "r3", startedAt: 0, endedAt: 1, status: "completed",
    files: [{ kind: "created", oldPath: "notes.md", newPath: "notes.md", additions: 2, deletions: 0, hunks }] };
  (window as { review?: unknown }).review = { get: vi.fn(async () => snapshot), restore: vi.fn() };
  const changed = { toolId: "t1", change: { file: "notes.md", kind: "added" as const, insertions: 1, deletions: 0 } };
  const output = { id: "o1", sessionId: "s", runId: "r3", messageId: "m", tools: [], files: [changed], tasks: [] };
  await act(async () => root.render(createElement(WorkspaceOutputFiles, { files: [{ file: "notes.md", type: "text", output, changed }], onOpenFile: vi.fn(), onOpenDiff: vi.fn() })));
  const row = host.querySelector<HTMLElement>(".ff-run-row--file")!;
  expect(row.dataset.fileType).toBe("text");
  expect(row.querySelector(".ff-run-file__stats")?.textContent).toBe("+2−0");
  expect(row.querySelectorAll(".ff-code-diff__line")).toHaveLength(4);
});
