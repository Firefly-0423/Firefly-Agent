import { describe, expect, it } from "vitest";
import type { BaseEvent } from "@ag-ui/core";
import type { HarnessEvent } from "../types";
import { sendHarnessEventAsAgui, sendTaskLifecycleAsAgui } from "./event-mapper";

const identity = { threadId: "thread-slate", runId: "run-slate" };
function transmit(input: HarnessEvent): Record<string, unknown>[] {
  const result: BaseEvent[] = [];
  sendHarnessEventAsAgui(input, "answer-slate", identity.threadId, identity.runId, event => result.push(event));
  return result as unknown as Record<string, unknown>[];
}

describe("AG-UI events exposed by the harness adapter", () => {
  it("wraps the final answer in exactly one ordered assistant message", () => {
    expect(transmit({ type: "final_answer", content: "核对完毕" })).toStrictEqual([
      { ...identity, type: "TEXT_MESSAGE_START", messageId: "answer-slate", role: "assistant" },
      { ...identity, type: "TEXT_MESSAGE_CONTENT", messageId: "answer-slate", delta: "核对完毕" },
      { ...identity, type: "TEXT_MESSAGE_END", messageId: "answer-slate" },
    ]);
  });

  it("publishes provisional text and its retraction as round-scoped custom events", () => {
    expect(transmit({ type: "candidate_text_delta", roundId: "iteration-slate", delta: "分析中" })).toStrictEqual([
      { ...identity, type: "CUSTOM", name: "firefly.candidate_text", value: { action: "delta", roundId: "iteration-slate", delta: "分析中" } },
    ]);
    expect(transmit({ type: "candidate_text_discard", roundId: "iteration-slate" })).toStrictEqual([
      { ...identity, type: "CUSTOM", name: "firefly.candidate_text", value: { action: "discard", roundId: "iteration-slate" } },
    ]);
  });

  it("sends the tool result before its closing event, preserving the complete delegated response", () => {
    const taskResult = { agentId: "analyst", sessionId: "child-slate", status: "completed" as const, text: "Detailed findings ".repeat(80) };
    expect(transmit({ type: "tool_end", toolCallId: "delegation-slate", outcome: "success", preview: "Preview", taskResult })).toStrictEqual([
      { ...identity, type: "TOOL_CALL_RESULT", toolCallId: "delegation-slate", messageId: "answer-slate-tool-delegation-slate",
        role: "tool", content: "Preview", status: "success", changes: undefined, taskResult },
      { ...identity, type: "TOOL_CALL_END", toolCallId: "delegation-slate" },
    ]);
  });

  it("drops a child response whose execution evidence names a different parent", () => {
    const events = transmit({
      type: "tool_end", toolCallId: "delegation-foreign", outcome: "success", preview: "Preview",
      taskResult: { agentId: "analyst", sessionId: "child-foreign", status: "failed", text: "Untrusted result",
        executionEvents: [{ id: "trace-foreign", seq: 1, monotonicMs: 0, clockDomainId: "test-clock", agentId: "analyst",
          parentRunId: "unrelated-parent", childRunId: "child-run-foreign", executionId: "execution-foreign", phase: "start" }] },
    } as HarnessEvent);
    expect(events[0].taskResult).toBeUndefined();
    expect(events.map(event => event.type)).toEqual(["TOOL_CALL_RESULT", "TOOL_CALL_END"]);
  });

  it("stamps task lifecycle presentations without altering their payload", () => {
    const sent: BaseEvent[] = [];
    const presentation = { taskId: "task-slate", status: "running" } as never;
    sendTaskLifecycleAsAgui(presentation, identity.threadId, identity.runId, event => sent.push(event));
    expect(sent).toStrictEqual([{ ...identity, type: "CUSTOM", name: "firefly.task", value: presentation }]);
  });
});
