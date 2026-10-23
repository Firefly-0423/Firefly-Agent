import { expect, test } from "vitest";
import type { ToolExecutionRecord } from "../../../../../shared/chat-types";
import { applyAgentRoundBoundary, buildAskUserQa, buildFlatRunTimeline, countRoundChangedFiles,
  createRoundProcessMessage, describeToolExecution, finishAgentRound, resolveAgentRoundTitle, startAgentRound } from "./agent-rounds";

const record = (name: string, patch: Partial<ToolExecutionRecord> = {}): ToolExecutionRecord =>
  ({ id: "tool-" + name, name, status: "success", roundId: "round-review", ...patch });

test("starts, settles and associates terminal process text with the same round", () => {
  const opened = [{ id: "round-review", status: "running" as const, startedAt: 450 }];
  const closed = [{ id: "round-review", status: "completed", startedAt: 450, completedAt: 980 }];
  expect(startAgentRound([], "round-review", 450)).toStrictEqual(opened);
  expect(finishAgentRound(opened, "round-review", 980)).toStrictEqual(closed);
  const state = applyAgentRoundBoundary({ rounds: [] }, "start", "round-review", 450);
  expect(state).toStrictEqual({ rounds: opened, activeRoundId: "round-review" });
  expect(applyAgentRoundBoundary(state, "end", "round-review", 980)).toStrictEqual({ rounds: closed, activeRoundId: undefined });
  expect(createRoundProcessMessage("network-failure", "服务连接中断", 4, "round-review")).toStrictEqual({
    id: "network-failure", content: "服务连接中断", afterToolCount: 4, roundId: "round-review", seq: undefined,
  });
});

test("uses live tools for running titles and only successful facts for completed titles", () => {
  const active = startAgentRound([], "round-review", 450)[0];
  const done = finishAgentRound([active], active.id, 980)[0];
  expect(resolveAgentRoundTitle(active, [record("list_dir"), record("read_file", { status: "running" })]))
    .toBe("流萤正在读取文件");
  const tools = [...Array.from({ length: 5 }, (_, n) => record("list_dir", { id: "directory-" + n })),
    record("read_file", { id: "first-read" }), record("read_file", { id: "second-read" }),
    record("read_file", { status: "error" })];
  expect(resolveAgentRoundTitle(done, tools)).toBe("流萤已完成 · 浏览 5 个目录 · 读取 2 个文件 · 1 项失败");
  expect(resolveAgentRoundTitle(done, [record("vendor_lookup"), record("vendor_verify")])).toBe("流萤已完成 · 完成 2 项操作");
  expect(resolveAgentRoundTitle(active, [record("read_file", { status: "error" })], true)).toBe("流萤已中断 · 1 项失败");
});

test.each([
  { tool: record("run_shell", { status: "running", argsText: JSON.stringify({ command: "npm run check:renderer" }) }),
    expected: { label: "运行命令", statusText: "正在运行命令", detail: "npm run check:renderer" } },
  { tool: record("write_file", { status: "running", argsText: JSON.stringify({ path: "lib/preferences.ts", content: "private payload" }) }),
    expected: { label: "写入文件", statusText: "正在写入文件", detail: "lib/preferences.ts" } },
  { tool: record("run_shell", { status: "running", argsText: '{"command":' }),
    expected: { label: "运行命令", statusText: "正在运行命令", detail: undefined } },
  { tool: record("run_shell", { status: "error", argsText: JSON.stringify({ command: "npm run dev" }), result: JSON.stringify({ timedOut: true, exitCode: null }) }),
    expected: { label: "运行命令", statusText: "命令运行超时", detail: "npm run dev" } },
  { tool: record("vendor_music", { displayName: "播放歌曲", status: "running" }),
    expected: { label: "播放歌曲", statusText: "正在播放歌曲", detail: undefined } },
  { tool: record("read_file"), expected: { label: "读取文件", statusText: "读取文件完成", detail: undefined } },
  { tool: record("vendor_music"), expected: { label: "vendor_music", statusText: "执行操作完成", detail: undefined } },
])("presents tool details without exposing write contents: $tool.name / $tool.status", ({ tool, expected }) => {
  expect(describeToolExecution(tool)).toStrictEqual(expected);
});

test.each([
  ["running", "等待用户回答"], ["success", "用户已回答"], ["error", "询问用户失败"],
] as const)("presents ask_user status %s", (status, statusText) => {
  expect(describeToolExecution(record("ask_user", { status }))).toStrictEqual({ label: "询问用户", statusText, detail: undefined });
});

test("extracts readable question/answer rows only for ask_user results", () => {
  expect(buildAskUserQa(record("ask_user", { result: "  选择格式？ → JSON\n输出到哪里？ → 本地\n" })))
    .toStrictEqual(["选择格式？ → JSON", "输出到哪里？ → 本地"]);
  expect(buildAskUserQa(record("ask_user", { status: "running" }))).toStrictEqual([]);
  expect(buildAskUserQa(record("list_dir", { result: "lib" }))).toStrictEqual([]);
});

test("orders mixed timeline records by sequence and retains parallel tool ordering", () => {
  const entries = buildFlatRunTimeline({
    tools: [record("list_dir", { id: "inspect", seq: 2 })], taskDelegations: [],
    processMessages: [{ id: "announce", content: "Inspect files", seq: 1 }, { id: "summarize", content: "Report", seq: 4 }],
    reasoningBlocks: [{ id: "prepare", content: "Plan inspection", seq: 0 }, { id: "evaluate", content: "Evaluate result", seq: 3 }],
  });
  expect(entries.map(item => [item.kind, item.key])).toStrictEqual([
    ["reasoning", "prepare"], ["process", "announce"], ["tool", "inspect"], ["reasoning", "evaluate"], ["process", "summarize"],
  ]);
  const parallel = buildFlatRunTimeline({ tools: [record("read_file", { id: "left", seq: 1 }), record("read_file", { id: "right", seq: 2 })],
    taskDelegations: [], reasoningBlocks: [], processMessages: [{ id: "begin", content: "Starting", seq: 0 }] });
  expect(parallel.map(item => item.key)).toStrictEqual(["begin", "left", "right"]);
});

test("restores legacy timeline ordering using tool positions", () => {
  const timeline = buildFlatRunTimeline({
    processMessages: [{ id: "before", content: "Begin", afterToolCount: 0 }, { id: "between", content: "Continue", afterToolCount: 1 }],
    reasoningBlocks: [{ id: "thought", content: "Assess", afterToolCount: 0 }], taskDelegations: [],
    tools: [record("list_dir", { id: "scan" }), record("read_file", { id: "open" })],
  });
  expect(timeline.map(item => item.key)).toStrictEqual(["before", "thought", "scan", "between", "open"]);
});

test("deduplicates changed paths across tool results and accepts absent changes", () => {
  const change = { file: "lib/cache.ts", kind: "modified" as const, insertions: 4, deletions: 2 };
  expect(countRoundChangedFiles([record("str_replace", { changes: [change] }),
    record("write_file", { changes: [{ ...change, insertions: 7 }, { ...change, file: "lib/store.ts", kind: "added" }] }),
    record("read_file")])).toBe(2);
  expect(countRoundChangedFiles([record("list_dir")])).toBe(0);
  expect(countRoundChangedFiles([])).toBe(0);
});
