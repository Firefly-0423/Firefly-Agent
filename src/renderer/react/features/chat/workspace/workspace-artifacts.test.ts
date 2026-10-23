import { describe, expect, it } from "vitest";
import type { ChatMessageItem } from "../components/ChatMessageList";
import { collectWorkspaceOutputs, workspaceFileRevision, workspaceRelativePath } from "./workspace-artifacts";
const message = (extra: Partial<ChatMessageItem> = {}): ChatMessageItem => ({ id: "m1", role: "assistant", content: "finished report.md", runId: "r1", ...extra });
const change = { file: "report.md", kind: "added" as const, insertions: 1, deletions: 0, diff: [{ type: "add" as const, text: "real bytes" }] };
describe("workspace outputs from real run evidence", () => {
  it("does not create artifacts from assistant prose, URLs or unowned runs", () => {
    expect(collectWorkspaceOutputs("s1", [message(), message({ runId: undefined, toolExecutions: [{ id: "t1", name: "write_file", status: "success", changes: [change] }] })])).toEqual([]);
  });
  it("preserves session/run/tool IDs, structured changes and actual error results", () => {
    const rows = collectWorkspaceOutputs("s1", [message({ toolExecutions: [
      { id: "t1", name: "write_file", status: "success", result: "written", changes: [change] },
      { id: "t2", name: "run_shell", status: "error", result: "exit 1" },
    ] })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sessionId: "s1", runId: "r1", messageId: "m1", files: [{ toolId: "t1", change }] });
    expect(rows[0].tools[1]).toMatchObject({ status: "error", result: "exit 1" });
    expect(collectWorkspaceOutputs("s2", [message({ toolExecutions: rows[0].tools })])[0].id).not.toBe(rows[0].id);
  });
  it("updates the byte refresh key only from structured file evidence, including a new run with equal counts", () => {
    const a = [message({ toolExecutions: [{ id: "t1", name: "write_file", status: "success", changes: [change] }] })];
    const revision = workspaceFileRevision("s1", a);
    expect(workspaceFileRevision("s1", [{ ...a[0], content: "streaming words changed" }])).toBe(revision);
    expect(workspaceFileRevision("s1", [{ ...a[0], runId: "r2" }])).not.toBe(revision);
    expect(workspaceFileRevision("s1", [message({ toolExecutions: [{ ...a[0].toolExecutions![0], changes: [{ ...change, diff: [{ type: "add", text: "next bytes" }] }] }] })])).not.toBe(revision);
  });
  it("keeps real task lifecycle entries before a tool has finished", () => {
    const task = { invocationId: "child-run", taskId: "child-session", description: "Check", nickname: "Reviewer", assetFileName: "review.png", status: "running" as const };
    expect(collectWorkspaceOutputs("s", [message({ taskDelegations: [task] })])[0].tasks).toEqual([task]);
  });
});
describe("workspace result paths", () => {
  it("uses workspace-relative file paths and supports Windows tool paths", () => {
    expect(workspaceRelativePath("src/a.ts", "/project")).toBe("src/a.ts");
    expect(workspaceRelativePath("/project/src/a.ts", "/project")).toBe("src/a.ts");
    expect(workspaceRelativePath("C:\\Work\\project\\a.ts", "c:\\work\\project")).toBe("a.ts");
  });
  it("does not turn outside paths or URLs into openable workspace files", () => {
    for (const path of ["../secret", "/project-elsewhere/a.ts", "https://example.com/a.ts", "C:\\Other\\a.ts", "src/../../secret"]) expect(workspaceRelativePath(path, "/project")).toBeNull();
  });
});

it("reveals fresh run artifacts once without letting later tool updates reopen a closed result", async () => {
  const { createWorkspaceResultRevealer } = await import("./workspace-artifacts");
  const reveal = createWorkspaceResultRevealer();
  const tools = [{ id: "write", name: "write_file", status: "success" as const, changes: [change] }];
  expect(reveal("s", "r1", tools, "s")).toBe("results:s:r1");
  expect(reveal("s", "r1", [...tools, { ...tools[0], id: "write2" }], "s")).toBeNull();
  expect(reveal("s", "r2", tools, "other")).toBeNull();
  expect(reveal("s", "r2", tools, "s")).toBeNull();
  expect(reveal("s", "r3", tools, "s")).toBe("results:s:r3");
  expect(reveal("s", undefined, tools, "s")).toBeNull();
});

it("all_effect_states_survive_restore without inventing successful diffs", () => {
  const writes = (["applied", "partially_applied", "unknown", "not_applied"] as const).map(state => ({ path: `${state}.md`, canonicalPath: `/synthetic/${state}.md`, agentId: "reviewer", childRunId: "child-run", toolCallId: "write-child", state, eventIds: ["write-event"] }));
  const tools = [{ id: "child", name: "delegate_agent", status: "error" as const, taskResult: { agentId: "reviewer", sessionId: "child-session", status: "failed" as const, text: "failed after prior writes", writes } }];
  const restored = JSON.parse(JSON.stringify([message({ toolExecutions: tools })]));
  const actual = collectWorkspaceOutputs("s", restored)[0];
  expect(actual.tools[0].taskResult?.writes).toEqual(writes);
  expect(actual.files).toEqual([]);
  expect(workspaceFileRevision("s", restored)).not.toBe(workspaceFileRevision("s", [message({ toolExecutions: [{ ...tools[0], taskResult: { ...tools[0].taskResult, writes: [] } }] })]));
});
it("foreign_run_and_malformed_evidence_rejected on restored results", () => {
  const taskResult = { agentId: "reviewer", sessionId: "child", status: "failed" as const, text: "stale", executionEvents: [{ id: "event", seq: 1, monotonicMs: 0, clockDomainId: "synthetic", parentRunId: "other-run", agentId: "reviewer", childRunId: "child-run", executionId: "execution", phase: "start" as const }] };
  const tools = [{ id: "child", name: "delegate_agent", status: "error" as const, taskResult }];
  expect(collectWorkspaceOutputs("s", [message({ toolExecutions: tools })])[0].tools[0].taskResult).toBeUndefined();
});
