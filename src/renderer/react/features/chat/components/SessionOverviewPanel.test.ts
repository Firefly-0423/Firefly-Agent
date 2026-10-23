import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import type { ContextUsageSnapshot } from "../../../../../shared/context-usage";
import type { TaskDelegationDisplayRecord } from "../../../../../shared/chat-types";
import type { WorkspaceRunOutput } from "../workspace/workspace-artifacts";
import { SessionOverviewPanel } from "./SessionOverviewPanel";

const usage: ContextUsageSnapshot = {
  phase: "preRequest",
  contextWindowTokens: 1_000_000,
  totalTokens: 210_200,
  categories: [
    { key: "conversation", tokens: 160_500 },
    { key: "tools", tokens: 20_500 },
    { key: "systemPrompt", tokens: 4_300 },
  ],
  messageCount: 12,
  updatedAt: 1,
};

const task = (invocationId: string, status: TaskDelegationDisplayRecord["status"]): TaskDelegationDisplayRecord => ({
  invocationId, taskId: `task-${invocationId}`, description: `job ${invocationId}`, nickname: "小萤", assetFileName: "a.png", status,
});

const output: WorkspaceRunOutput = {
  id: "results:s:r1", sessionId: "s", runId: "r1", messageId: "m1", tools: [],
  tasks: [task("a", "running"), task("b", "completed"), task("c", "failed")],
  files: [{ toolId: "write_file", change: { file: "src/app/main.ts", kind: "modified", insertions: 12, deletions: 3 } }],
};

function render(props: Partial<Parameters<typeof SessionOverviewPanel>[0]> = {}): string {
  return renderToStaticMarkup(createElement(SessionOverviewPanel, { outputs: [], ...props }));
}

describe("SessionOverviewPanel", () => {
  beforeAll(() => {
    // The component reads localStorage for card state; a missing store must not break rendering.
    (globalThis as { React?: unknown }).React = React;
  });

  it("shows real context numbers: percent, used / window and per-category rows", () => {
    const html = render({ usage });

    expect(html).toContain("已用 21%");
    expect(html).toContain("210k / 1M");
    expect(html).toContain("161k");
    expect(html).toContain("76%");
    expect(html).toContain("剩余空间");
    expect(html).toContain("不是供应商返回的用量");
  });

  it("says there is no data instead of inventing any", () => {
    const html = render();

    expect(html).toContain("发送消息后显示上下文占用");
    expect(html).toContain("暂无后台任务");
    expect(html).toContain("本会话还没有文件变更");
    expect(html).not.toContain("ff-overview-context__bar");
  });

  it("lists running tasks and counts the finished and failed ones", () => {
    const html = render({ outputs: [output] });

    expect(html).toContain("1 个运行中");
    expect(html).toContain("job a");
    expect(html).not.toContain("job b");
    expect(html).toContain("2 个已结束");
    expect(html).toContain("1 个失败");
  });

  it("lists changed files with their line counts and a total", () => {
    const html = render({ outputs: [output] });

    expect(html).toContain("main.ts");
    expect(html).toContain("+12");
    expect(html).toContain("−3");
  });

  it("makes every card a labelled disclosure", () => {
    const html = render({ usage, outputs: [output] });

    // Tasks, context, changes, outputs and usage fold; environment and connectors are one-row entries.
    expect((html.match(/aria-expanded="true"/g) ?? []).length).toBe(5);
    expect((html.match(/aria-controls=/g) ?? []).length).toBe(5);
  });
});
