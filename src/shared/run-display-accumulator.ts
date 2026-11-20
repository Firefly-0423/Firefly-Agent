import type { ChatMessage } from "./chat-types";
import type { FireflyRunTerminalResult } from "./run-terminal";
import { applyAgentRoundBoundary, reduceDisplayAnswer, reduceToolDisplay, finishDisplayAnswer, type AguiEvent } from "./run-display";
import { normalizeTaskDelegationEvent, applyTaskDelegationEvent } from "./task-delegation-display";
import type { TodoItem } from "./todo-types";
import { publicRunFailure } from "./run-failure";
import { isContextUsageSnapshot } from "./context-usage";

/** Accumulates only the same public, filtered packets delivered to the window. No model transcript input. */
export class RunDisplayAccumulator {
  private message: ChatMessage;
  private answer = { text: "", closed: false };
  private roundId: string | undefined;
  private seq = 0;
  private candidate = "";
  private candidateSeq: number | undefined;
  private processId = 0;
  private todos: TodoItem[] | undefined;
  private frozen: ChatMessage | undefined;
  constructor(seed: ChatMessage, private readonly runId: string) {
    this.message = { id: seed.id, role: "model", content: "", at: seed.at, answersUserMessageId: seed.answersUserMessageId };
  }
  private process(content: string, interrupted = false, seq = this.seq++): void {
    this.message.processMessages = [...(this.message.processMessages ?? []), {
      id: `process-${this.processId++}`, content, ...(interrupted ? { interrupted: true } : {}),
      afterToolCount: this.message.toolExecutions?.length ?? 0, roundId: this.roundId, seq,
    }];
  }
  private closeCandidate(): void {
    if (this.candidate.trim()) this.process(this.candidate, true, this.candidateSeq);
    this.candidate = ""; this.candidateSeq = undefined;
  }
  accept(event: AguiEvent, now = Date.now()): void {
    if (this.frozen) return;
    this.answer = reduceDisplayAnswer(this.answer, event);
    const tool = reduceToolDisplay(this.message.toolExecutions ?? [], event, this.roundId, this.seq, "工具调用");
    if (tool) { this.message.toolExecutions = tool.records; this.seq = tool.nextSeq; }
    if (event.type === "RUN_STARTED") this.message.runActivity = { startedAt: now, reasoningMs: 0 };
    if (event.type?.startsWith("REASONING_MESSAGE_")) {
      if (this.message.runActivity) {
        const activity = this.message.runActivity;
        if (event.type === "REASONING_MESSAGE_START" && activity.activeReasoningStartedAt === undefined) activity.activeReasoningStartedAt = now;
        if (event.type === "REASONING_MESSAGE_END" && activity.activeReasoningStartedAt !== undefined) {
          activity.reasoningMs += Math.max(0, now - activity.activeReasoningStartedAt);
          activity.activeReasoningStartedAt = undefined;
        }
      }
      const id = event.messageId ?? "reasoning";
      const blocks = this.message.reasoningBlocks ?? [];
      const previous = blocks.find(block => block.id === id);
      const block = { ...(previous ?? { id, content: "", afterToolCount: this.message.toolExecutions?.length ?? 0, roundId: this.roundId, seq: this.seq++ }),
        content: (previous?.content ?? "") + (event.delta ?? ""), streaming: event.type !== "REASONING_MESSAGE_END" };
      this.message.reasoningBlocks = previous ? blocks.map(row => row.id === id ? block : row) : [...blocks, block];
      this.message.reasoning = this.message.reasoningBlocks.map(row => row.content).filter(Boolean).join("\n\n");
    }
    if (event.type === "RUN_ERROR") {
      this.closeCandidate();
      this.process(publicRunFailure({ code: event.code, message: event.message }).code);
    }
    if (event.type !== "CUSTOM") return;
    const value = event.value as Record<string, unknown> | undefined;
    switch (event.name) {
      case "firefly.round": {
        if ((value?.action !== "start" && value?.action !== "end") || typeof value.roundId !== "string") break;
        if (value.action === "start" && value.roundId !== this.roundId) this.closeCandidate();
        const state = applyAgentRoundBoundary({ rounds: this.message.agentRounds ?? [], activeRoundId: this.roundId }, value.action, value.roundId, now);
        this.message.agentRounds = state.rounds; this.roundId = state.activeRoundId; break;
      }
      case "firefly.candidate_text":
        if (!value || typeof value.roundId !== "string" || value.roundId !== this.roundId) break;
        if (value.action === "delta" && typeof value.delta === "string") {
          if (!this.candidate) this.candidateSeq = this.seq++;
          this.candidate += value.delta;
        } else if (value.action === "discard") this.closeCandidate();
        break;
      case "firefly.process_text":
        if (typeof value?.content === "string" && value.content.trim()) {
          this.process(value.content, false, this.candidateSeq); this.candidate = ""; this.candidateSeq = undefined;
        } break;
      case "firefly.task": {
        const task = normalizeTaskDelegationEvent(event.value);
        if (task) this.message.taskDelegations = applyTaskDelegationEvent(this.message.taskDelegations ?? [], task, this.roundId);
        break;
      }
      case "firefly.todo":
        if (Array.isArray(value?.items)) this.todos = value.items.flatMap((entry: Partial<TodoItem>) =>
          typeof entry.id === "string" && typeof entry.content === "string" && entry.id && entry.content
          && (entry.status === "pending" || entry.status === "in_progress" || entry.status === "completed")
            ? [{ id: entry.id, content: entry.content, status: entry.status }] : []);
        break;
      case "firefly.sticker": this.message.sticker = typeof event.value === "string" ? event.value : null; break;
      case "firefly.workRead":
        if (value && Array.isArray(value.files) && ["complete","partial","missing","changed","unverified"].includes(String(value.status))) this.message.workReadReport = structuredClone(event.value) as ChatMessage["workReadReport"];
        break;
      case "firefly.context.usage": if (isContextUsageSnapshot(event.value)) this.message.contextUsage = structuredClone(event.value); break;
    }
  }
  freeze(result: FireflyRunTerminalResult, now = Date.now()): ChatMessage {
    if (!this.frozen) {
      const answer = finishDisplayAnswer(this.answer.text, result.status, this.answer.closed);
      if (answer.committed) { this.candidate = ""; this.candidateSeq = undefined; }
      else {
        this.closeCandidate();
        if (this.answer.text.trim()) this.process(this.answer.text, true);
      }
      this.message.content = answer.content;
      this.message.agentRounds = this.message.agentRounds?.map(round => round.status === "running" ? { ...round, status: "completed", completedAt: now } : round);
      this.message.toolExecutions = this.message.toolExecutions?.map(tool => tool.status === "running" ? { ...tool, status: "error" } : tool);
      this.message.reasoningBlocks = this.message.reasoningBlocks?.map(block => ({ ...block, streaming: false }));
      if (this.message.runActivity) this.message.runActivity = { ...this.message.runActivity, reasoningMs: this.message.runActivity.reasoningMs + (this.message.runActivity.activeReasoningStartedAt === undefined ? 0 : Math.max(0, now - this.message.runActivity.activeReasoningStartedAt)), completedAt: now, activeReasoningStartedAt: undefined, keepExpanded: !answer.committed };
      this.message.runSnapshot = { runId: this.runId, status: "terminal", terminalStatus: result.status, ...(this.todos ? { todos: this.todos } : {}), updatedAt: now };
      this.frozen = structuredClone(this.message);
    }
    return structuredClone(this.frozen);
  }
}
