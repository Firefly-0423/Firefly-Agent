import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TASK_CHARACTERS } from "../../../../../shared/task-characters";
import { TaskDelegationRow } from "./TaskDelegationRow";

describe("TaskDelegationRow", () => {
  it("renders the supplied portrait during a running task", () => {
    const html = renderToStaticMarkup(createElement(TaskDelegationRow, { delegation: {
      invocationId: "child-run-1", taskId: "task-1", description: "检查取消链路",
      nickname: "艾利欧", assetFileName: "艾利欧.png", status: "running", roundId: "round-1",
    } }));

    expect(html).toContain("流萤委托了");
    expect(html).toContain("艾利欧");
    expect(html).toContain("正在运行");
    expect(html).toContain("ff-task-delegation__avatar");
    expect(html).toContain("is-running");
  });

  it("renders a completed marker and completed copy", () => {
    const html = renderToStaticMarkup(createElement(TaskDelegationRow, { delegation: {
      invocationId: "child-run-1", taskId: "task-1", description: "检查取消链路",
      nickname: "艾利欧", assetFileName: "艾利欧.png", status: "completed", roundId: "round-1",
    } }));
    expect(html).toContain("已完成");
    expect(html).toContain("ff-task-delegation__avatar");
    expect(html).toContain("✓");
  });
  it("does not restore a retired portrait from history", () => {
    const html = renderToStaticMarkup(createElement(TaskDelegationRow, { delegation: {
      invocationId: "child-run-1", taskId: "task-1", description: "历史子任务",
      nickname: "风堇", assetFileName: "风堇.png", status: "failed", roundId: "round-1",
    } }));
    expect(html).not.toContain("ff-task-delegation__avatar");
  });

  it.each(["running", "completed", "failed", "cancelled"] as const)("keeps portraits for %s and persisted history", (status) => {
    for (const character of TASK_CHARACTERS) {
      const html = renderToStaticMarkup(createElement(TaskDelegationRow, { delegation: {
        invocationId: "child-run-1", taskId: "task-1", description: "公开任务",
        nickname: character.nickname, assetFileName: character.assetFileName, status, roundId: "round-1",
      } }));
      expect(html, character.nickname).toContain("ff-task-delegation__avatar");
      expect(html, character.nickname).toContain(character.nickname);
    }
  });
});
