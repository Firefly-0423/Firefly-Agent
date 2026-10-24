// 工作步骤胶囊的纯函数：待办状态映射、步骤游标口径、本轮文件变更汇总。
import { describe, expect, it } from "vitest";
import type { ToolExecutionRecord, ToolFileChange } from "../../../../../shared/chat-types";
import type { TodoItem } from "../../../../../shared/todo-types";
import {
  buildStepProgressSummary,
  describeStepCursor,
  summarizeRunFileChanges,
  toStepProgressSteps,
  type StepProgressStep,
} from "./step-progress";

function step(title: string, status: StepProgressStep["status"]): StepProgressStep {
  return { title, status };
}

function change(file: string, insertions: number, deletions: number, kind: ToolFileChange["kind"] = "modified"): ToolFileChange {
  return { file, kind, insertions, deletions };
}

function execution(...changes: ToolFileChange[]): Pick<ToolExecutionRecord, "changes"> {
  return { changes };
}

describe("toStepProgressSteps", () => {
  it("maps todo statuses to pill statuses and keeps the list order", () => {
    const todos: TodoItem[] = [
      { id: "a", content: "读取配置", status: "completed" },
      { id: "b", content: "修改组件", status: "in_progress" },
      { id: "c", content: "补充测试", status: "pending" },
    ];
    expect(toStepProgressSteps(todos)).toEqual([
      step("读取配置", "done"),
      step("修改组件", "running"),
      step("补充测试", "pending"),
    ]);
  });

  it("returns an empty list when there is no todo state", () => {
    expect(toStepProgressSteps(undefined)).toEqual([]);
    expect(toStepProgressSteps([])).toEqual([]);
  });
});

describe("describeStepCursor", () => {
  it("points at the running step, 1-based, in the middle of a plan", () => {
    expect(describeStepCursor([step("a", "done"), step("b", "running"), step("c", "pending")]))
      .toEqual({ total: 3, current: 2, allDone: false });
  });

  it("points at the next step after the completed ones when nothing is running", () => {
    expect(describeStepCursor([step("a", "done"), step("b", "done"), step("c", "pending"), step("d", "pending")]))
      .toEqual({ total: 4, current: 3, allDone: false });
  });

  it("starts at step 1 for a fresh plan", () => {
    expect(describeStepCursor([step("a", "pending"), step("b", "pending")]))
      .toEqual({ total: 2, current: 1, allDone: false });
  });

  it("reports all done, capped at the total, when every step is completed", () => {
    expect(describeStepCursor([step("a", "done"), step("b", "done")]))
      .toEqual({ total: 2, current: 2, allDone: true });
  });

  it("reports an empty plan without claiming completion", () => {
    expect(describeStepCursor([])).toEqual({ total: 0, current: 0, allDone: false });
  });
});

describe("summarizeRunFileChanges", () => {
  it("returns undefined when no tool reported file changes", () => {
    expect(summarizeRunFileChanges(undefined)).toBeUndefined();
    expect(summarizeRunFileChanges([{ changes: undefined }, { changes: [] }])).toBeUndefined();
  });

  it("counts unique files and sums line churn across tool calls", () => {
    const result = summarizeRunFileChanges([
      execution(change("src/a.ts", 10, 0)),
      execution(change("src/a.ts", 2, 3)),
      execution(change("src/b.ts", 5, 1, "added"), change("src/c.ts", 0, 4, "deleted")),
    ]);
    expect(result).toEqual({ filesChanged: 3, added: 17, removed: 8 });
  });

  it("treats Windows and POSIX separators as the same file and ignores non-finite counts", () => {
    const result = summarizeRunFileChanges([
      execution(change("src/a.ts", 4, 0)),
      execution(change("src\\a.ts", 1, 2)),
      execution(change("src/b.ts", Number.NaN, 1)),
    ]);
    expect(result).toEqual({ filesChanged: 2, added: 5, removed: 3 });
  });
});

describe("buildStepProgressSummary", () => {
  it("leaves file counts out entirely when no change was recorded", () => {
    const summary = buildStepProgressSummary({
      todos: [{ id: "a", content: "读取配置", status: "in_progress" }],
      toolExecutions: [],
      running: true,
    });
    expect(summary).toStrictEqual({ steps: [step("读取配置", "running")], running: true });
  });

  it("combines the todo steps with this run's file changes", () => {
    const summary = buildStepProgressSummary({
      todos: [
        { id: "a", content: "读取配置", status: "completed" },
        { id: "b", content: "修改组件", status: "in_progress" },
      ],
      toolExecutions: [execution(change("src/a.ts", 403, 0, "added"))],
      running: true,
    });
    expect(summary).toStrictEqual({
      steps: [step("读取配置", "done"), step("修改组件", "running")],
      running: true,
      filesChanged: 1,
      added: 403,
      removed: 0,
    });
  });
});
