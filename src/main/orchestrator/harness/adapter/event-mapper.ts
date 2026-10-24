import { type BaseEvent, EventType } from "@ag-ui/core";
import { normalizeToolTaskResult } from "../../../../shared/task-result-evidence";
import type { TaskDelegationPresentation } from "../../../../shared/task-session";
import type { HarnessEvent } from "../types";

export function sendHarnessEventAsAgui(
  incoming: HarnessEvent,
  assistantId: string,
  conversationId: string,
  executionId: string,
  publish: (event: BaseEvent) => void,
): void {
  const variant = incoming.type;
  const emit = (body: { type: EventType } & Record<string, unknown>): void => {
    publish({ ...body, threadId: conversationId, runId: executionId } as BaseEvent);
  };
  const custom = (name: string, value: unknown): void => {
    emit({ type: EventType.CUSTOM, name, value });
  };

  if (variant === "round_start" || variant === "round_end") {
    custom("firefly.round", {
      action: incoming.type === "round_start" ? "start" : "end",
      roundId: incoming.roundId,
    });
    return;
  }
  if (variant === "candidate_text_delta" || variant === "candidate_text_discard") {
    custom("firefly.candidate_text", incoming.type === "candidate_text_delta"
      ? { action: "delta", roundId: incoming.roundId, delta: incoming.delta }
      : { action: "discard", roundId: incoming.roundId });
    return;
  }
  if (variant === "progress_text") {
    custom("firefly.process_text", { content: incoming.content });
    return;
  }
  if (variant === "final_answer") {
    emit({ type: EventType.TEXT_MESSAGE_START, messageId: assistantId, role: "assistant" });
    emit({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: assistantId, delta: incoming.content });
    emit({ type: EventType.TEXT_MESSAGE_END, messageId: assistantId });
    return;
  }
  if (variant === "reasoning_start") {
    emit({ type: EventType.REASONING_MESSAGE_START, messageId: incoming.messageId, role: "assistant" });
    return;
  }
  if (variant === "reasoning_delta") {
    emit({ type: EventType.REASONING_MESSAGE_CONTENT, messageId: incoming.messageId, delta: incoming.delta });
    return;
  }
  if (variant === "reasoning_end") {
    emit({ type: EventType.REASONING_MESSAGE_END, messageId: incoming.messageId });
    return;
  }
  if (variant === "tool_start") {
    emit({
      type: EventType.TOOL_CALL_START,
      toolCallId: incoming.toolCallId,
      toolCallName: incoming.toolName,
      toolCallDisplayName: incoming.displayName,
    });
    emit({ type: EventType.TOOL_CALL_ARGS, toolCallId: incoming.toolCallId, delta: JSON.stringify(incoming.args) });
    return;
  }
  if (variant === "tool_end") {
    emit({
      type: EventType.TOOL_CALL_RESULT,
      messageId: `${assistantId}-tool-${incoming.toolCallId}`,
      toolCallId: incoming.toolCallId,
      content: incoming.preview,
      changes: incoming.changes,
      taskResult: normalizeToolTaskResult(incoming.taskResult, executionId),
      role: "tool",
      status: incoming.outcome === "success" ? "success" : "failed",
    });
    emit({ type: EventType.TOOL_CALL_END, toolCallId: incoming.toolCallId });
    return;
  }
  if (variant === "todo_update") {
    custom("firefly.todo", { items: incoming.items });
    return;
  }
  if (variant === "context_usage") {
    custom("firefly.context.usage", incoming.snapshot);
    return;
  }
  if (variant === "plan_mode_changed") {
    custom("firefly.plan", { action: "state_changed", state: incoming.state });
    return;
  }
  if (variant === "plan_written") {
    custom("firefly.plan", { action: "written", planPath: incoming.planPath });
    return;
  }
  if (variant === "error") console.error(`[HarnessAdapter] harness error: ${incoming.message}`);
}

export function sendTaskLifecycleAsAgui(
  presentation: TaskDelegationPresentation,
  conversationId: string,
  executionId: string,
  publish: (event: BaseEvent) => void,
): void {
  publish({
    type: EventType.CUSTOM, name: "firefly.task", value: presentation,
    threadId: conversationId, runId: executionId,
  } as BaseEvent);
}
