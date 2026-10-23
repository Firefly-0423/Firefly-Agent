import { randomUUID } from "node:crypto";
import type { TaskTraceRecord } from "../../shared/task-session";
import type { HarnessEvent } from "./harness/types";

function clipTrace(text: string): string {
  return text.length > 2_000 ? `${text.slice(0, 2_000)}…` : text;
}

export function projectTaskTraceEvent(
  observation: HarnessEvent,
  timestamp = Date.now(),
  newTraceId: () => string = randomUUID,
): TaskTraceRecord | undefined {
  const category = observation.type;
  switch (category) {
    case "round_start": case "round_end":
      return { id: newTraceId(), at: timestamp, kind: "round", phase: category === "round_start" ? "start" : "end", label: observation.roundId };
    case "progress_text":
      return { id: newTraceId(), at: timestamp, kind: "progress", content: clipTrace(observation.content) };
    case "reasoning_start": case "reasoning_end":
      return { id: newTraceId(), at: timestamp, kind: "reasoning", phase: category === "reasoning_start" ? "start" : "end", label: observation.messageId };
    case "reasoning_delta":
      return { id: newTraceId(), at: timestamp, kind: "reasoning", phase: "delta", label: observation.messageId, content: clipTrace(observation.delta) };
    case "tool_start":
      return { id: newTraceId(), at: timestamp, kind: "tool", phase: "start", label: observation.toolName };
    case "tool_end":
      return { id: newTraceId(), at: timestamp, kind: "tool", phase: "end", label: observation.toolCallId, status: observation.outcome };
    case "todo_update":
      return { id: newTraceId(), at: timestamp, kind: "todo", status: String(observation.items.length) };
    case "error":
      return { id: newTraceId(), at: timestamp, kind: "terminal", status: "error", content: clipTrace(observation.message) };
    default: return undefined;
  }
}
