import { describe, expect, it } from "vitest";
import { buildCurrentTodoNotebookContext, TODO_WORKING_NOTEBOOK_POLICY } from "./todo-working-notebook";

describe("Working notebook text supplied to the model", () => {
  it("serializes ordered statuses and an optional active description with the nonbinding envelope", () => {
    const rendered = buildCurrentTodoNotebookContext([
      { status: "completed", id: "catalog", content: "整理接口" },
      { status: "in_progress", id: "verify", content: "核对事件", activeForm: "正在核对事件" },
      { status: "pending", id: "deliver", content: "交付报告", activeForm: "" },
    ]);
    expect(rendered).toEqual([
      '[CURRENT_TODO_NOTEBOOK mutable="true" binding="false"]',
      "[completed] catalog: 整理接口",
      "[in_progress] verify: 核对事件（当前：正在核对事件）",
      "[pending] deliver: 交付报告",
      "[/CURRENT_TODO_NOTEBOOK]",
    ].join("\n"));
  });

  it("represents no tasks explicitly within the same envelope", () => {
    expect(buildCurrentTodoNotebookContext([]).split("\n")).toEqual([
      '[CURRENT_TODO_NOTEBOOK mutable="true" binding="false"]',
      "（当前工作笔记为空）", "[/CURRENT_TODO_NOTEBOOK]",
    ]);
  });

  it("publishes the full policy, including the two-step threshold, revisions and limits of evidence", () => {
    expect(TODO_WORKING_NOTEBOOK_POLICY).toEqual([
      "[TODO_WORKING_NOTEBOOK_POLICY]",
      "Todo 是你的 mutable working notebook（可变工作笔记），用于像人类手边的笔记本一样记录当前方向和阶段进度。",
      "- 如果预计任务需要至少 2 个 execution step（执行步骤）或 tool round（工具推进轮次），优先调用 update_todo 建立一份简短清单。",
      "- “两轮”按执行步骤/工具推进轮次理解，不按 LLM 调用次数计算。",
      "- 单次工具即可完成的简单任务（例如一次天气查询）不需要 Todo。",
      "- 当 Todo 为空但任务已经显现为多步、Todo 与事实不符、一个阶段完成、用户改变目标或发生方向改变时，及时调用 update_todo 修订或重写它。",
      "- Todo 不得作为后续行动的强约束；先依据用户当前目标和最新工具事实判断，再修订笔记并继续。",
      "- Todo 不是外部操作已经成功的证明。",
    ].join("\n"));
  });
});
