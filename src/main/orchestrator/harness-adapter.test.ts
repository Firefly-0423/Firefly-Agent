import { describe, expect, it } from "vitest";
import { buildHarnessPromptLayers, buildHarnessSystemPrompt, mapTerminateReasonToTerminal, materializeHarnessStartTranscript, sendHarnessEventAsAgui, sendTaskLifecycleAsAgui } from "./harness-adapter";
import type { HarnessEvent } from "./harness/types";
import type { BaseEvent } from "@ag-ui/core";

describe("Adapter facade prompt contracts", () => {
  const base = { soulSystemBaseContent: "审查助手角色核心", toolSystemContent: "审查工具目录" };
  it("deduplicates environment facts and keeps recovery separate from the stable prefix", () => {
    expect(buildHarnessSystemPrompt({ ...base, soulSystemBaseContent: "[WORKSPACE_FACTS]", runtimeEnvironmentContext: "[WORKSPACE_FACTS]" } as never).split("[WORKSPACE_FACTS]").length - 1).toBe(1);
    const layers = buildHarnessPromptLayers({ ...base, recoveryContext: "已检查持久化边界" } as never);
    expect(layers.stablePrefix).not.toContain("RECOVERY_CONTEXT");
    expect(layers.runtimeContext).toBe("[RECOVERY_CONTEXT]\n已检查持久化边界");
    const prompt = buildHarnessSystemPrompt({ ...base, recoveryContext: "已检查持久化边界" } as never);
    expect(prompt).toContain("[RECOVERY_CONTEXT]");
    expect(prompt).toContain("已检查持久化边界");
  });

  it("supplies the same persona and shared tool policy in Work and Code, with soft notebook guidance", () => {
    const work = buildHarnessSystemPrompt({ ...base, conversationMode: "work" } as never);
    const code = buildHarnessSystemPrompt({ ...base, conversationMode: "code" } as never);
    expect(code).toBe(work);
    for (const token of ["审查助手角色核心", "[TODO_WORKING_NOTEBOOK_POLICY]", "至少 2 个 execution step", "不得作为后续行动的强约束", "## 工具使用", "主动调用", "invoke_skill", "多个互不依赖的调查或执行方向"]) expect(work).toContain(token);
    expect(work).not.toContain("Work / Learn / Code");
    expect(code).not.toContain("Work / Learn / Code");
  });

  it("separates usage buckets while preserving the stable prefix's original order", () => {
    const layers = buildHarnessPromptLayers({ ...base, conversationMode: "work" } as never);
    const persona = layers.usageParts!.personaContent, tools = layers.usageParts!.toolLayerContent;
    expect(persona).toContain("审查助手角色核心");
    expect(persona).toContain("[TODO_WORKING_NOTEBOOK_POLICY]");
    expect(persona).toContain("# 流萤 · 执行人设");
    expect(persona).not.toContain("审查工具目录");
    expect(persona).not.toContain("## 工具使用");
    expect(tools).toContain("审查工具目录");
    expect(tools).toContain("## 工具使用");
    expect(layers.stablePrefix).toBe([persona, tools].filter(Boolean).join("\n\n---\n\n"));
  });

  it("keeps the full chat persona with neither compact execution persona nor file tool policy", () => {
    const layers = buildHarnessPromptLayers({ ...base, toolSystemContent: "", conversationMode: "chat" } as never);
    expect(layers.usageParts!.toolLayerContent).toBe("");
    expect(layers.stablePrefix).toBe(layers.usageParts!.personaContent);
    expect(layers.stablePrefix).toContain("审查助手角色核心");
    expect(layers.stablePrefix).not.toContain("# 流萤 · 执行人设");
    expect(buildHarnessSystemPrompt({ ...base, conversationMode: "chat" } as never)).not.toContain("## 工具使用");
  });

  it("materializes the runtime context and interrupted notebook in one internal recovery entry", () => {
    const transcript = materializeHarnessStartTranscript({
      messages: [{ role: "user", content: "Continue audit" }], runId: "facade-coral", kind: "recovery",
      runtimeContext: "[RECOVERY_CONTEXT]\n持久化验证尚未完成",
      initialState: { todoItems: [{ id: "verify", content: "核对持久化记录", status: "in_progress" }], uncertainEffects: [] },
    });
    expect(transcript).toHaveLength(2);
    expect(transcript[1]).toMatchObject({ role: "user", visibility: "internal", internal: { kind: "recovery", runId: "facade-coral" } });
    expect(transcript[1].content).toContain("持久化验证尚未完成");
    expect(transcript[1].content).toContain("核对持久化记录");
  });
});

describe("Adapter facade terminal truth", () => {
  it("exposes explicit success uncertainty and a boolean effect flag on every failure", () => {
    expect(mapTerminateReasonToTerminal(undefined)).toStrictEqual({ status: "success", externalEffectsMayContinue: false });
    expect(mapTerminateReasonToTerminal(undefined, false)).toStrictEqual({ status: "success", externalEffectsMayContinue: false });
    expect(mapTerminateReasonToTerminal(undefined, true)).toStrictEqual({ status: "success", externalEffectsMayContinue: true });
    for (const flag of [undefined, false, true]) {
      expect((["error", "cancelled", "max_rounds", "timeout"] as const).map(reason => mapTerminateReasonToTerminal(reason, flag))).toStrictEqual([
        { status: "runtime_error", reason: "E_HARNESS_FAILURE", externalEffectsMayContinue: true },
        { status: "cancelled", reason: "user_cancelled", externalEffectsMayContinue: true },
        { status: "timeout", reason: "max_rounds", externalEffectsMayContinue: true },
        { status: "timeout", reason: "timeout", externalEffectsMayContinue: true },
      ]);
    }
    for (const reason of [undefined, "error", "cancelled", "max_rounds", "timeout"] as const) expect(typeof mapTerminateReasonToTerminal(reason).externalEffectsMayContinue).toBe("boolean");
  });
});

describe("Adapter facade public event stream", () => {
  const stamp = { threadId: "dialog-coral", runId: "facade-coral" };
  function events(input: HarnessEvent) {
    const sent: BaseEvent[] = [];
    sendHarnessEventAsAgui(input, "answer-coral", stamp.threadId, stamp.runId, value => sent.push(value));
    return sent as unknown as Record<string, unknown>[];
  }
  it("projects process text, round boundaries and public reasoning with canonical run identity", () => {
    expect(events({ type: "progress_text", content: "核对中" })).toEqual([{ ...stamp, type: "CUSTOM", name: "firefly.process_text", value: { content: "核对中" } }]);
    for (const [type, action] of [["round_end", "end"], ["round_start", "start"]] as const) {
      expect(events({ type, roundId: "iteration-coral" })).toEqual([{ ...stamp, type: "CUSTOM", name: "firefly.round", value: { action, roundId: "iteration-coral" } }]);
    }
    const reasoning = ([
      { type: "reasoning_start", messageId: "thought-coral" },
      { type: "reasoning_delta", messageId: "thought-coral", delta: "验证顺序" },
      { type: "reasoning_end", messageId: "thought-coral" },
    ] as HarnessEvent[]).flatMap(events);
    expect(reasoning).toEqual([
      { ...stamp, type: "REASONING_MESSAGE_START", messageId: "thought-coral", role: "assistant" },
      { ...stamp, type: "REASONING_MESSAGE_CONTENT", messageId: "thought-coral", delta: "验证顺序" },
      { ...stamp, type: "REASONING_MESSAGE_END", messageId: "thought-coral" },
    ]);
  });

  it("serializes tool arguments and sends result evidence before closing the call", () => {
    expect(events({ type: "tool_start", toolCallId: "change-coral", toolName: "apply_patch", args: { path: "src/contracts.ts" } })).toStrictEqual([
      { ...stamp, type: "TOOL_CALL_START", toolCallId: "change-coral", toolCallName: "apply_patch", toolCallDisplayName: undefined },
      { ...stamp, type: "TOOL_CALL_ARGS", toolCallId: "change-coral", delta: '{"path":"src/contracts.ts"}' },
    ]);
    const changes = [{ file: "src/contracts.ts", kind: "modified" as const, insertions: 2, deletions: 0, diff: [{ type: "add" as const, text: "export const limit = 7;" }] }];
    const sent = events({ type: "tool_end", toolCallId: "change-coral", outcome: "success", preview: '{"truncated":', changes });
    expect(sent.map(event => event.type)).toEqual(["TOOL_CALL_RESULT", "TOOL_CALL_END"]);
    expect(sent[0]).toMatchObject({ ...stamp, toolCallId: "change-coral", content: '{"truncated":', status: "success", changes });
    for (const outcome of ["unknown", "not_executed", "failure"] as const) expect(events({ type: "tool_end", toolCallId: "failed-coral", outcome, preview: outcome })[0].status).toBe("failed");
  });

  it("forwards todo and context snapshots and wraps final text in exactly three stamped events", () => {
    const items = [{ id: "collect", content: "Collect evidence", status: "pending" as const }];
    expect(events({ type: "todo_update", items })).toEqual([{ ...stamp, type: "CUSTOM", name: "firefly.todo", value: { items } }]);
    const snapshot = { phase: "preRequest" as const, contextWindowTokens: 64000, totalTokens: 900, categories: [{ key: "systemPrompt" as const, tokens: 900 }], messageCount: 3, updatedAt: 81 };
    expect(events({ type: "context_usage", snapshot })).toEqual([{ ...stamp, type: "CUSTOM", name: "firefly.context.usage", value: snapshot }]);
    expect(events({ type: "final_answer", content: "报告已完成" })).toEqual([
      { ...stamp, type: "TEXT_MESSAGE_START", messageId: "answer-coral", role: "assistant" },
      { ...stamp, type: "TEXT_MESSAGE_CONTENT", messageId: "answer-coral", delta: "报告已完成" },
      { ...stamp, type: "TEXT_MESSAGE_END", messageId: "answer-coral" },
    ]);
  });

  it("forwards a task presentation without adding the hidden delegation prompt", () => {
    const sent: BaseEvent[] = [];
    const presentation = { invocationId: "child-coral", taskId: "audit-coral", description: "核对事件记录", nickname: "审查员", assetFileName: "auditor.png", status: "running" as const };
    sendTaskLifecycleAsAgui(presentation, stamp.threadId, stamp.runId, event => sent.push(event));
    expect(sent).toEqual([{ ...stamp, type: "CUSTOM", name: "firefly.task", value: presentation }]);
    expect(JSON.stringify(sent)).not.toContain("prompt");
  });
});
