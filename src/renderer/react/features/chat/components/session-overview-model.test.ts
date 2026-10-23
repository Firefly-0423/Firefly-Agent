import { describe, expect, it } from "vitest";
import type { ContextUsageSnapshot } from "../../../../../shared/context-usage";
import type { TaskDelegationDisplayRecord, ToolFileChange } from "../../../../../shared/chat-types";
import type { WorkspaceRunOutput } from "../workspace/workspace-artifacts";
import { buildContextOverview, summarizeChanges, summarizeTasks } from "./session-overview-model";

function usage(overrides: Partial<ContextUsageSnapshot> = {}): ContextUsageSnapshot {
  return {
    phase: "preRequest",
    contextWindowTokens: 1000,
    totalTokens: 300,
    categories: [
      { key: "systemPrompt", tokens: 50 },
      { key: "conversation", tokens: 200 },
      { key: "tools", tokens: 50 },
      { key: "skills", tokens: 0 },
    ],
    messageCount: 4,
    updatedAt: 1,
    ...overrides,
  };
}

describe("buildContextOverview", () => {
  it("returns nothing without a snapshot instead of inventing numbers", () => {
    expect(buildContextOverview(undefined)).toBeUndefined();
  });

  it("sorts categories largest first, drops empty ones and reports window share", () => {
    const overview = buildContextOverview(usage())!;

    expect(overview.usedPercent).toBe(30);
    expect(overview.freeTokens).toBe(700);
    expect(overview.rows.map((row) => row.key)).toEqual(["conversation", "systemPrompt", "tools"]);
    expect(overview.rows[0]).toMatchObject({ tokens: 200, share: 67, windowRatio: 0.2 });
  });

  it("keeps an over-full window honest: percent above 100, no free space, bar clamped", () => {
    const overview = buildContextOverview(usage({
      contextWindowTokens: 100, totalTokens: 118,
      categories: [{ key: "conversation", tokens: 118 }],
    }))!;

    expect(overview.usedPercent).toBe(118);
    expect(overview.tone).toBe("alert");
    expect(overview.freeTokens).toBeUndefined();
    expect(overview.rows[0].windowRatio).toBe(1);
  });

  it("omits the percentage and free space when the window is unknown", () => {
    const overview = buildContextOverview(usage({ contextWindowTokens: 0 }))!;

    expect(overview.usedPercent).toBeUndefined();
    expect(overview.freeTokens).toBeUndefined();
    expect(overview.rows.every((row) => row.windowRatio === 0)).toBe(true);
  });
});

const change = (file: string, insertions: number, deletions: number, kind: ToolFileChange["kind"] = "modified"): ToolFileChange =>
  ({ file, kind, insertions, deletions });

function output(runId: string, files: ToolFileChange[], tasks: TaskDelegationDisplayRecord[] = []): WorkspaceRunOutput {
  return {
    id: `results:s:${runId}`, sessionId: "s", runId, messageId: `m-${runId}`, tools: [], tasks,
    files: files.map((item) => ({ toolId: "write_file", change: item })),
  };
}

describe("summarizeChanges", () => {
  it("totals insertions and deletions across runs", () => {
    const summary = summarizeChanges([
      output("r1", [change("a.ts", 10, 2)]),
      output("r2", [change("b.ts", 5, 0, "added")]),
    ]);

    expect(summary.files.map((file) => file.file)).toEqual(["a.ts", "b.ts"]);
    expect(summary.insertions).toBe(15);
    expect(summary.deletions).toBe(2);
  });

  it("merges repeated edits of one file and points at the latest change", () => {
    const first = output("r1", [change("a.ts", 10, 2)]);
    const second = output("r2", [change("a.ts", 3, 1)]);

    const summary = summarizeChanges([first, second]);

    expect(summary.files).toHaveLength(1);
    expect(summary.files[0]).toMatchObject({ file: "a.ts", insertions: 13, deletions: 3 });
    expect(summary.files[0].output).toBe(second);
    expect(summary.files[0].changed.change.insertions).toBe(3);
  });

  it("is empty when nothing changed", () => {
    expect(summarizeChanges([output("r1", [])])).toEqual({ files: [], insertions: 0, deletions: 0 });
  });
});

const task = (invocationId: string, status: TaskDelegationDisplayRecord["status"]): TaskDelegationDisplayRecord => ({
  invocationId, taskId: `task-${invocationId}`, description: `job ${invocationId}`, nickname: "n", assetFileName: "a.png", status,
});

describe("summarizeTasks", () => {
  it("separates running work from finished work and counts failures", () => {
    const summary = summarizeTasks([
      output("r1", [], [task("a", "completed"), task("b", "failed"), task("c", "running"), task("d", "cancelled")]),
    ]);

    expect(summary.running.map((item) => item.task.invocationId)).toEqual(["c"]);
    expect(summary.finished).toBe(3);
    expect(summary.failed).toBe(1);
  });

  it("keeps the originating run of a resumed agent that reuses its taskId", () => {
    const first = output("r1", [], [task("a", "completed")]);
    const second = output("r2", [], [{ ...task("b", "running"), taskId: "task-a" }]);

    const summary = summarizeTasks([first, second]);

    expect(summary.running).toHaveLength(1);
    expect(summary.running[0].task.taskId).toBe("task-a");
    expect(summary.running[0].output).toBe(second);
  });

  it("lets a later record of the same invocation replace the earlier status", () => {
    const summary = summarizeTasks([
      output("r1", [], [task("a", "running")]),
      output("r2", [], [task("a", "completed")]),
    ]);

    expect(summary.running).toEqual([]);
    expect(summary.finished).toBe(1);
  });
});
