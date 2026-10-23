// 工作步骤胶囊的数据口径（纯函数，不依赖 React）。
//
// 步骤来自 Harness 的 update_todo：主进程发出 firefly.todo，渲染端写入 todoStateBySession。
// 文件统计来自本轮助手消息的工具执行 changes（写文件 / 补丁等工具的结构化变更证据）。
// 两者都是现有真实事件，这里只做映射与汇总，不推测任何数据。
import type { ToolExecutionRecord } from "../../../../../shared/chat-types";
import type { TodoItem } from "../../../../../shared/todo-types";

export type StepProgressStatus = "done" | "running" | "pending";

export interface StepProgressStep {
  title: string;
  status: StepProgressStatus;
}

export interface StepProgressSummary {
  steps: StepProgressStep[];
  /** 会话是否仍有进行中的运行；不在运行时胶囊收起。 */
  running: boolean;
  /** 本轮去重后的文件数；本轮没有文件变更时省略。 */
  filesChanged?: number;
  /** 本轮新增行数（各次工具变更之和）。 */
  added?: number;
  /** 本轮删除行数（各次工具变更之和）。 */
  removed?: number;
}

export interface StepCursor {
  total: number;
  /** 1 起始：运行中步骤的序号；没有运行中步骤时为已完成数 + 1，不超过总数。 */
  current: number;
  allDone: boolean;
}

const TODO_TO_STEP_STATUS: Record<TodoItem["status"], StepProgressStatus> = {
  completed: "done",
  in_progress: "running",
  pending: "pending",
};

export function toStepProgressSteps(todos: readonly TodoItem[] | undefined): StepProgressStep[] {
  return (todos ?? []).map((todo) => ({
    title: todo.content,
    status: TODO_TO_STEP_STATUS[todo.status] ?? "pending",
  }));
}

export function describeStepCursor(steps: readonly StepProgressStep[]): StepCursor {
  const total = steps.length;
  const doneCount = steps.filter((step) => step.status === "done").length;
  const runningIndex = steps.findIndex((step) => step.status === "running");
  const current = runningIndex >= 0 ? runningIndex + 1 : Math.min(doneCount + 1, total);
  return { total, current, allDone: total > 0 && doneCount === total };
}

function countOrZero(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** 汇总一轮运行中所有工具的文件变更：文件按路径去重（统一分隔符），行数逐次累加。无变更返回 undefined。 */
export function summarizeRunFileChanges(
  toolExecutions: readonly Pick<ToolExecutionRecord, "changes">[] | undefined,
): { filesChanged: number; added: number; removed: number } | undefined {
  const files = new Set<string>();
  let added = 0;
  let removed = 0;
  for (const execution of toolExecutions ?? []) {
    for (const change of execution.changes ?? []) {
      if (typeof change.file !== "string" || !change.file) continue;
      files.add(change.file.replace(/\\/g, "/"));
      added += countOrZero(change.insertions);
      removed += countOrZero(change.deletions);
    }
  }
  if (files.size === 0) return undefined;
  return { filesChanged: files.size, added, removed };
}

export function buildStepProgressSummary(input: {
  todos?: readonly TodoItem[];
  toolExecutions?: readonly Pick<ToolExecutionRecord, "changes">[];
  running: boolean;
}): StepProgressSummary {
  const summary: StepProgressSummary = {
    steps: toStepProgressSteps(input.todos),
    running: input.running,
  };
  const changes = summarizeRunFileChanges(input.toolExecutions);
  if (changes) {
    summary.filesChanged = changes.filesChanged;
    summary.added = changes.added;
    summary.removed = changes.removed;
  }
  return summary;
}
