// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkspaceRunResults, WorkspaceResultsIndex, WorkspaceChangeDiff, WorkspaceChangedFiles, groupTools } from "./WorkspaceRunResults";
import type { WorkspaceRunOutput } from "./workspace-artifacts";
vi.mock("../../../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const change = { file: "report.md", kind: "added" as const, insertions: 1, deletions: 0, diff: [{ type: "add" as const, text: "changed bytes" }] };
const output: WorkspaceRunOutput = { id: "results:s:r", sessionId: "s", runId: "r", messageId: "m", files: [{ toolId: "write", change }], tasks: [], tools: [{ id: "delegate", name: "delegate_agent", status: "success", result: "short preview", taskResult: { agentId: "reviewer", sessionId: "child", status: "completed", text: "complete task output", truncated: true } }] };
let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
beforeEach(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
it("opens exact evidence files and diffs while displaying actual full child output", () => {
  const onOpenFile = vi.fn(), onOpenDiff = vi.fn();
  act(() => root.render(React.createElement(WorkspaceRunResults, { output, workspaceRoot: "/work", onOpenFile, onOpenDiff })));
  expect(host.textContent).toContain("complete task output");
  expect(host.textContent).toContain("workspace.resultTruncated");
  act(() => host.querySelector<HTMLButtonElement>('[data-output-file]')!.click());
  expect(onOpenFile).toHaveBeenCalledExactlyOnceWith("report.md");
  act(() => host.querySelector<HTMLButtonElement>('[data-output-diff]')!.click());
  expect(onOpenDiff).toHaveBeenCalledExactlyOnceWith(output, output.files[0]);
});
it("does not offer to read a deleted or outside workspace file", () => {
  act(() => root.render(React.createElement(WorkspaceRunResults, { output: { ...output, files: [{ toolId: "remove", change: { ...change, kind: "deleted" } }, { toolId: "outside", change: { ...change, file: "/elsewhere/a" } }] }, workspaceRoot: "/work", onOpenFile: vi.fn(), onOpenDiff: vi.fn() })));
  expect(host.querySelector('[data-output-file]')).toBeNull();
  expect(host.querySelectorAll('[data-output-diff]')).toHaveLength(2);
});
it("selects the source run rather than inferring a result from chat text", () => {
  const onOpenResult = vi.fn();
  act(() => root.render(React.createElement(WorkspaceResultsIndex, { outputs: [output], onOpenResult })));
  act(() => host.querySelector<HTMLButtonElement>('[data-output-result]')!.click());
  expect(onOpenResult).toHaveBeenCalledExactlyOnceWith(output.id);
});
it("shows real inline diff and a clear state when no diff bytes were supplied", () => {
  act(() => root.render(React.createElement(WorkspaceChangeDiff, { change })));
  expect(host.textContent).toContain("changed bytes");
  expect(host.querySelector('.is-add')).not.toBeNull();
  act(() => root.render(React.createElement(WorkspaceChangeDiff, { change: { ...change, diff: undefined } })));
  expect(host.textContent).toContain("workspace.diffUnavailable");
});

const writeEvidence = { path: "prior.md", canonicalPath: "/work/prior.md", agentId: "reviewer", childRunId: "child-run", toolCallId: "write-child", state: "applied" as const, before: { sha256: "a".repeat(64) }, after: { version: "absent" }, eventIds: ["actual-write-event"] };
it.each(["failed", "cancelled"] as const)("failed_child_shows_prior_writes_and_sibling_success: %s", status => {
  const taskResult = { agentId: "reviewer", sessionId: "child", status, text: "Stopped after writing", writes: [writeEvidence], error: { code: "AGENT_WRITE_CONFLICT", message: "Another child owns blocked.md" } };
  act(() => root.render(React.createElement(WorkspaceRunResults, { output: { ...output, files: [], tools: [
    { id: "failed-child", name: "delegate_agent", status: "error", taskResult },
    { id: "sibling", name: "delegate_agent", status: "success", taskResult: { agentId: "writer", sessionId: "sibling-child", status: "completed", text: "Sibling successful result" } },
  ] }, workspaceRoot: "/work", onOpenFile: vi.fn(), onOpenDiff: vi.fn() })));
  expect(host.textContent).toContain("prior.md");
  expect(host.textContent).toContain("workspace.writeState.applied");
  expect(host.textContent).toContain("a".repeat(64));
  expect(host.textContent).toContain("absent");
  expect(host.textContent).toContain("actual-write-event");
  expect(host.textContent).toContain("write-child");
  expect(host.textContent).toContain("AGENT_WRITE_CONFLICT");
  expect(host.textContent).toContain("Sibling successful result");
});
it("all_effect_states_survive_restore", () => {
  const writes = (["applied", "partially_applied", "unknown", "not_applied"] as const).map(state => ({ ...writeEvidence, path: `${state}.md`, state, before: undefined, after: undefined }));
  const live: WorkspaceRunOutput = { ...output, files: [], tools: [{ ...output.tools[0], taskResult: { ...output.tools[0].taskResult!, status: "failed", writes } }] };
  const restored: WorkspaceRunOutput = JSON.parse(JSON.stringify(live));
  act(() => root.render(React.createElement(WorkspaceRunResults, { output: live, workspaceRoot: "/work", onOpenFile: vi.fn(), onOpenDiff: vi.fn() })));
  const liveMarkup = host.innerHTML;
  act(() => root.render(React.createElement(WorkspaceRunResults, { output: restored, workspaceRoot: "/work", onOpenFile: vi.fn(), onOpenDiff: vi.fn() })));
  expect(host.innerHTML).toBe(liveMarkup);
  for (const state of ["applied", "partially_applied", "unknown", "not_applied"]) expect(host.textContent).toContain(`workspace.writeState.${state}`);
  expect(host.querySelectorAll('[data-write-state]')).toHaveLength(4);
  expect(host.querySelectorAll('[data-output-diff]')).toHaveLength(0);
  expect(host.textContent).toContain("workspace.versionUnavailable");
});
it("shows unavailable evidence for legacy child results rather than zero modifications", () => {
  act(() => root.render(React.createElement(WorkspaceRunResults, { output, workspaceRoot: "/work", onOpenFile: vi.fn(), onOpenDiff: vi.fn() })));
  expect(host.textContent).toContain("workspace.writeEvidenceUnavailable");
});

it("restores observed model event identity, monotonic clock and terminal metadata", () => {
  const executionEvents = [{ id: "model-end", seq: 2, monotonicMs: 20, clockDomainId: "synthetic-clock", agentId: "reviewer", parentRunId: "r", childRunId: "child-run", executionId: "execution-1", phase: "end" as const, terminal: "failed" as const }];
  const restored: WorkspaceRunOutput = JSON.parse(JSON.stringify({ ...output, files: [], tools: [{ ...output.tools[0], taskResult: { ...output.tools[0].taskResult, writes: [writeEvidence], executionEvents } }] }));
  act(() => root.render(React.createElement(WorkspaceRunResults, { output: restored, onOpenFile: vi.fn(), onOpenDiff: vi.fn() })));
  expect(host.textContent).toContain("model-end");
  expect(host.textContent).toContain("execution-1");
  expect(host.textContent).toContain("synthetic-clock");
  expect(host.textContent).toContain("workspace.childStatus.failed");
  expect(host.querySelector('[data-execution-phase="end"]')).not.toBeNull();
});

it("shows the delegated agent and its task above a rendered conclusion, and scrolls to the requested task", () => {
  const scroll = vi.fn();
  Element.prototype.scrollIntoView = scroll;
  const task = { invocationId: "run-1", taskId: "child", description: "检查取消链路", nickname: "艾利欧", assetFileName: "艾利欧.png", status: "completed" as const };
  const withTask: WorkspaceRunOutput = { ...output, files: [], tasks: [task], tools: [{ ...output.tools[0], taskResult: { agentId: "strategy-planning", sessionId: "child", status: "completed", text: "## 结论 已核对 **全部** 文件" } }] };
  const props = { output: withTask, workspaceRoot: "/work", onOpenFile: vi.fn(), onOpenDiff: vi.fn() };
  act(() => root.render(React.createElement(WorkspaceRunResults, props)));
  const article = host.querySelector<HTMLElement>('[data-task-id="child"]')!;
  expect(article.querySelector(".ff-run-row__head strong")?.textContent).toBe("艾利欧");
  expect(article.querySelector(".ff-workspace-run-results__task")?.textContent).toBe("检查取消链路");
  expect(article.querySelector(".ff-workspace-run-results__text")?.textContent).toContain("已核对");
  expect(article.querySelector(".ff-workspace-run-results__text")?.textContent).not.toContain("**");
  expect(scroll).not.toHaveBeenCalled();
  act(() => root.render(React.createElement(WorkspaceRunResults, { ...props, focusTask: { taskId: "child", seq: 1 } })));
  expect(scroll).toHaveBeenCalledOnce();
  act(() => root.render(React.createElement(WorkspaceRunResults, { ...props, focusTask: { taskId: "child", seq: 2 } })));
  expect(scroll).toHaveBeenCalledTimes(2);
});

const call = (id: string, name: string, status: "success" | "error", result = `${name} output ${id}`) => ({ id, name, displayName: name, status, result });
const manyTools = [
  call("c1", "run_command", "success"),
  call("g1", "git_status", "success"),
  call("c2", "run_command", "success"),
  call("c3", "run_command", "success"),
  call("c4", "run_command", "error", "x".repeat(300)),
];
const render = (tools: WorkspaceRunOutput["tools"]) => act(() => root.render(React.createElement(WorkspaceRunResults, { output: { ...output, files: [], tools }, workspaceRoot: "/work", onOpenFile: vi.fn(), onOpenDiff: vi.fn() })));

it("folds consecutive calls of the same tool into one group and keeps other calls separate, in order", () => {
  expect(groupTools(manyTools as never).map(group => group.kind === "plain" ? [group.name, group.items.length] : "delegate")).toEqual([["run_command", 1], ["git_status", 1], ["run_command", 3]]);
  expect(groupTools([call("a", "delegate_agent", "success"), call("b", "read_file", "success")] as never).map(group => group.kind)).toEqual(["delegate", "plain"]);
});

it("keeps two different tools apart even when they share a display name", () => {
  const a = { ...call("a1", "plugin_a_search", "success"), displayName: "Search" };
  const b = { ...call("b1", "plugin_b_search", "success"), displayName: "Search" };
  const groups = groupTools([a, b, { ...a, id: "a2" }] as never);
  expect(groups.map(group => group.kind === "plain" ? [group.toolName, group.name, group.items.length] : "delegate")).toEqual([
    ["plugin_a_search", "Search", 1], ["plugin_b_search", "Search", 1], ["plugin_a_search", "Search", 1],
  ]);
  expect(groupTools([a, { ...a, id: "a2" }] as never)).toHaveLength(1);
});

const isOpen = (row: Element) => row.hasAttribute("data-open");
const head = (row: Element) => row.querySelector<HTMLButtonElement>(":scope > .ff-run-row__head")!;

it("puts a run of calls on one bar, folded, with the count and failures on it", () => {
  render(manyTools as never);
  const groups = [...host.querySelectorAll(".ff-run-row--group")];
  expect(groups).toHaveLength(1);
  expect(isOpen(groups[0]!)).toBe(false);
  expect(head(groups[0]!).getAttribute("aria-expanded")).toBe("false");
  expect(head(groups[0]!).textContent).toContain("run_command");
  expect(head(groups[0]!).textContent).toContain("workspace.toolGroupCount");
  expect(groups[0]!.querySelector(".ff-run-row__failed")).not.toBeNull();
  // The folded body stays out of the tab order.
  expect(groups[0]!.querySelector(".ff-run-row__body")!.hasAttribute("inert")).toBe(true);
});

it("shows each call as one bar that opens onto the full return, all folded at first", () => {
  render(manyTools as never);
  const rows = [...host.querySelectorAll(".ff-run-row--tool, .ff-run-row--item")];
  expect(rows).toHaveLength(5);
  expect(rows.some(isOpen)).toBe(false);
  const failed = rows.find(row => row.querySelector('.ff-run-row__head [data-tool-status="error"]'))!;
  expect(failed.querySelector(".ff-run-row__preview")!.textContent!.length).toBeLessThanOrEqual(91);
  expect(failed.querySelector("pre")!.textContent).toBe("x".repeat(300));
  act(() => head(failed).click());
  expect(isOpen(failed)).toBe(true);
  expect(head(failed).getAttribute("aria-expanded")).toBe("true");
  act(() => head(failed).click());
  expect(isOpen(failed)).toBe(false);
});

it("keeps a lone call as a single bar of its own", () => {
  render([call("c1", "run_command", "success"), call("c2", "run_command", "success"), call("g1", "git_status", "success")] as never);
  expect(host.querySelectorAll(".ff-run-row--group")).toHaveLength(1);
  expect(host.querySelectorAll(".ff-run-row--tool")).toHaveLength(1);
});


it("folds a delegated task into a bar too, and opens it when the chat points at it", () => {
  Element.prototype.scrollIntoView = vi.fn();
  const props = { output, workspaceRoot: "/work", onOpenFile: vi.fn(), onOpenDiff: vi.fn() };
  act(() => root.render(React.createElement(WorkspaceRunResults, props)));
  const task = host.querySelector('[data-task-id="child"]')!;
  expect(task.classList.contains("ff-run-row--task")).toBe(true);
  expect(isOpen(task)).toBe(false);
  act(() => root.render(React.createElement(WorkspaceRunResults, { ...props, focusTask: { taskId: "child", seq: 1 } })));
  expect(isOpen(task)).toBe(true);
});

it("has no expand-all / collapse-all bar: each row folds on its own", () => {
  render(manyTools as never);
  expect(host.querySelector("[data-fold-all]")).toBeNull();
  expect(host.textContent).not.toContain("workspace.expandAll");
});

it("lists changed files as rows: name, folder, coloured counts, the diff in place and actions at the end", () => {
  const files = [
    { toolId: "w1", change: { ...change, file: "/work/src/app/report.md", kind: "modified" as const, insertions: 5, deletions: 2 } },
    { toolId: "w2", change: { ...change, file: "/elsewhere/notes.txt", kind: "added" as const } },
  ];
  act(() => root.render(React.createElement(WorkspaceRunResults, { output: { ...output, files, tools: [] }, workspaceRoot: "/work", onOpenFile: vi.fn(), onOpenDiff: vi.fn() })));
  const rows = [...host.querySelectorAll<HTMLElement>(".ff-run-row--file")];
  expect(rows).toHaveLength(2);
  const head = rows[0]!.querySelector(".ff-run-row__head")!;
  expect(head.querySelector("strong")?.textContent).toBe("report.md");
  expect(head.querySelector(".ff-run-row__preview")?.textContent).toBe("src/app");
  expect(head.querySelector(".is-add")?.textContent).toBe("+5");
  expect(head.querySelector(".is-remove")?.textContent).toBe("−2");
  expect(rows[0]!.dataset.changeKind).toBe("modified");
  // The actions sit beside the toggle, not inside it.
  expect(head.querySelector("[data-output-file], [data-output-diff]")).toBeNull();
  expect(rows[0]!.querySelector('[data-output-file="src/app/report.md"]')).not.toBeNull();
  // Outside the project the full folder shows and there is no open-file action.
  expect(rows[1]!.querySelector(".ff-run-row__preview")?.textContent).toBe("/elsewhere");
  expect(rows[1]!.querySelector("[data-output-file]")).toBeNull();
  expect(rows[0]!.hasAttribute("data-open")).toBe(false);
  act(() => (head as HTMLButtonElement).click());
  expect(rows[0]!.hasAttribute("data-open")).toBe(true);
  expect(rows[0]!.querySelector(".ff-workspace-change-diff--bare .is-add")?.textContent).toContain("changed bytes");
});

it("puts the changed files behind one entry row that opens their own panel", () => {
  const files = [
    { toolId: "w1", change: { ...change, file: "/work/a.md", insertions: 5, deletions: 1 } },
    { toolId: "w2", change: { ...change, file: "/work/b.md", insertions: 2, deletions: 0 } },
  ];
  const withFiles = { ...output, files, tools: [] };
  const onOpenChanges = vi.fn();
  act(() => root.render(React.createElement(WorkspaceRunResults, { output: withFiles, workspaceRoot: "/work", onOpenFile: vi.fn(), onOpenDiff: vi.fn(), onOpenChanges })));
  expect(host.querySelectorAll(".ff-run-row--file")).toHaveLength(0);
  const entry = host.querySelector<HTMLButtonElement>("[data-open-changes]")!;
  expect(entry.textContent).toContain("2");
  expect(entry.querySelector(".is-add")?.textContent).toBe("+7");
  expect(entry.querySelector(".is-remove")?.textContent).toBe("−1");
  act(() => entry.click());
  expect(onOpenChanges).toHaveBeenCalledExactlyOnceWith(withFiles);
  // The panel itself lists every file as a row.
  act(() => root.render(React.createElement(WorkspaceChangedFiles, { output: withFiles, workspaceRoot: "/work", onOpenFile: vi.fn(), onOpenDiff: vi.fn() })));
  expect(host.querySelectorAll(".ff-run-row--file")).toHaveLength(2);
  act(() => root.render(React.createElement(WorkspaceChangedFiles, { output: { ...withFiles, files: [] }, onOpenFile: vi.fn(), onOpenDiff: vi.fn() })));
  expect(host.textContent).toContain("workspace.noChangedFiles");
});

it("lists the run's steps before the changed-files entry that sums them up", () => {
  const withFiles = { ...output, files: [{ toolId: "w1", change: { ...change, file: "/work/a.md" } }] };
  act(() => root.render(React.createElement(WorkspaceRunResults, { output: withFiles, workspaceRoot: "/work", onOpenFile: vi.fn(), onOpenDiff: vi.fn(), onOpenChanges: vi.fn() })));
  const steps = host.querySelector(".ff-workspace-run-results > .ff-run-list")!;
  const entry = host.querySelector("[data-open-changes]")!;
  expect(steps.compareDocumentPosition(entry) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});
