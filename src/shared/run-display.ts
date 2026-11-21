import type { AgentRoundRecord, ToolExecutionRecord, ToolFileChange } from "./chat-types";
import { publicRunFailure } from "./run-failure";
import { normalizeToolTaskResult } from "./task-result-evidence";

export type AguiEvent = {
  taskResult?: import("./chat-types").ToolTaskResult;
  changes?: ToolFileChange[];
  status?: string;
  stepName?: string;
  toolCallDisplayName?: string;
  toolCallName?: string;
  toolCallId?: string;
  value?: unknown;
  name?: string;
  content?: string;
  error?: string;
  message?: string;
  delta?: string;
  messageId?: string;
  runId?: string;
  threadId?: string;
  type?: string;
  errorSource?: import("./run-failure").RunFailureSource;
  code?: string;
  /** RUN_FINISHED carries the shared terminal result (status, reason, externalEffectsMayContinue). */
  result?: import("./run-terminal").FireflyRunTerminalResult;
};
export type AgentRunStageKind =
  | "understanding" | "planning" | "executing" | "waiting_permission" | "waiting_user"
  | "responding" | "completed" | "cancelled" | "timeout" | "failed";
export type AgentRunStage = { detail?: string; kind: AgentRunStageKind };

export function startAgentRound(rounds: readonly AgentRoundRecord[], roundId: string, startedAt = Date.now()): AgentRoundRecord[] {
  const alreadyStarted = rounds.some(({ id }) => id === roundId);
  const next = [...rounds];
  if (!alreadyStarted) {
    next.push({ id: roundId, status: "running", startedAt });
  }
  return next;
}

export function finishAgentRound(rounds: readonly AgentRoundRecord[], roundId: string, completedAt = Date.now()): AgentRoundRecord[] {
  return rounds.map((record) => {
    if (record.id !== roundId) { return record; }
    return { ...record, status: "completed", completedAt };
  });
}

export interface AgentRoundBoundaryState {
  rounds: AgentRoundRecord[]; activeRoundId?: string;
}

export function applyAgentRoundBoundary(state: AgentRoundBoundaryState, action: "start" | "end", roundId: string, now = Date.now()): AgentRoundBoundaryState {
  switch (action) {
    case "start": return { rounds: startAgentRound(state.rounds, roundId, now), activeRoundId: roundId };
    default: return {
      rounds: finishAgentRound(state.rounds, roundId, now),
      activeRoundId: state.activeRoundId === roundId ? undefined : state.activeRoundId,
    };
  }
}

export function resolveRunFinishedStage(result: { status?: string } | undefined | null): AgentRunStage {
  const outcome = result?.status;
  if (outcome === "cancelled") return { kind: "cancelled" };
  if (outcome === "timeout") return { kind: "timeout" };
  if (outcome === "runtime_error") return { kind: "failed" };
  return { kind: "completed" };
}

export function resolveTerminalContent(streamContent: string, status: string | undefined): string {
  const stripped = streamContent.trim();
  return status === "success" || status === "cancelled" || status === "timeout" ? stripped : streamContent;
}

export function isFormalAnswerCommitted(content: string, status: string | undefined, finalMessageCompleted: boolean): boolean {
  return status === "success" && finalMessageCompleted && content.trim().length > 0;
}


/** Output of a display event. Scheduling text reveal, saving and notifying the window belong to the caller. */
export function reduceToolDisplay(tools: readonly ToolExecutionRecord[], event: AguiEvent, roundId: string | undefined, seq: number, fallbackName: string) {
  if (!event.toolCallId) return;
  const id = event.toolCallId;
  const index = tools.findIndex(tool => tool.id === id);
  const previous = tools[index];
  let patch: Partial<ToolExecutionRecord>;
  switch (event.type) {
    case "TOOL_CALL_START":
      patch = { name: event.toolCallName ?? fallbackName, displayName: event.toolCallDisplayName, status: "running", roundId };
      break;
    case "TOOL_CALL_ARGS":
      if (!event.delta) return;
      patch = { argsText: (previous?.argsText ?? "") + event.delta, roundId };
      break;
    case "TOOL_CALL_RESULT":
      patch = { status: event.status === "failed" ? "error" : "success", result: (event.content ?? "").slice(0, 4000), changes: event.changes,
        taskResult: previous?.name === "delegate_agent" ? normalizeToolTaskResult(event.taskResult, event.runId) : undefined };
      break;
    case "TOOL_CALL_END":
      patch = {};
      break;
    default: return;
  }
  const records: ToolExecutionRecord[] = previous
    ? tools.map((entry, offset) => offset === index ? { ...entry, ...patch } : entry)
    : [...tools, { id, name: patch.name ?? fallbackName, displayName: patch.displayName, status: patch.status ?? "running",
        result: patch.result, argsText: patch.argsText, changes: patch.changes, roundId: patch.roundId ?? roundId, seq }];
  return { records, nextSeq: previous ? seq : seq + 1 };
}

export interface DisplayAnswer { text: string; closed: boolean }

export function reduceDisplayAnswer(answer: DisplayAnswer, event: Pick<AguiEvent, "type" | "delta">): DisplayAnswer {
  if (event.type === "TEXT_MESSAGE_CONTENT" && event.delta) return { ...answer, text: answer.text + event.delta };
  if (event.type === "TEXT_MESSAGE_END") return { ...answer, closed: true };
  return answer;
}

export function displayTerminal(event: AguiEvent & { type: "RUN_FINISHED" }): { stage: AgentRunStage; status?: string };
export function displayTerminal(event: AguiEvent & { type: "RUN_ERROR" }): { stage: AgentRunStage; failure: ReturnType<typeof publicRunFailure> };
export function displayTerminal(event: AguiEvent): { stage: AgentRunStage; status?: string; failure?: ReturnType<typeof publicRunFailure> } | undefined {
  if (event.type === "RUN_ERROR") return { stage: { kind: "failed" as const }, failure: publicRunFailure({ code: event.code, message: event.message }) };
  if (event.type === "RUN_FINISHED") return { stage: resolveRunFinishedStage(event.result), status: event.result?.status };
}

export function finishDisplayAnswer(content: string, status: string | undefined, closed: boolean) {
  const committed = isFormalAnswerCommitted(content, status, closed);
  return { committed, content: committed ? resolveTerminalContent(content, status) : "" };
}
