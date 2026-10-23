import { publicRunFailure } from "../../../../../../shared/run-failure";
import type {
  AgentRoundRecord, ChatMessage, ChatSession, ConversationMode, ProcessMessageRecord, ReasoningBlock,
  RunActivityRecord, TaskDelegationDisplayRecord, ToolExecutionRecord, WorkReadReport,
} from "../../../../../../shared/chat-types";
import { isContextUsageSnapshot, type ContextUsageSnapshot } from "../../../../../../shared/context-usage";
import { normalizeToolTaskResult } from "../../../../../../shared/task-result-evidence";
import type { TodoItem } from "../../../../../../shared/todo-types";
import type { ChatMessageItem } from "../../components/ChatMessageList";
import type { ComposerAttachment } from "../../components/ChatComposer";
import {
  isFormalAnswerCommitted, normalizeChoiceInteraction, normalizeTaskPlanPresentation, resolveRunFinishedStage,
  resolveTerminalContent, shouldClearComposerInteractionForTerminal, type ComposerInteraction,
} from "../../components/run-presentation";
import { applyAgentRoundBoundary, createRoundProcessMessage } from "../../components/agent-rounds";
import { applyTaskDelegationEvent, normalizeTaskDelegationEvent } from "../../components/task-delegations";
import { t } from "../../../../i18n";
import type { AguiApi, AguiEvent, CandidateTextEventValue, ChatStoreApi } from "../chat-page-bridge";
import { normalizeWeatherData, parseSessionRunActiveError, stageForStep, toUiMessages } from "../chat-page-normalizers";
import { RunEventGate } from "../run-event-gate";
import { FrameCoalescer, PacedTextReveal, SMOOTH_REVEAL_TICK_MS, SmoothTextRevealQueue } from "../message-reveal";
import { buildTodoRecoveryContext, mergeHarnessTodosForSession, startSessionTodos, type TodoStateBySession } from "../session-runtime-state";

const prefersReducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
type CheckpointPhase = "running" | "waiting_user" | "terminal";
type PublicText = [key: string, content: string, publish: (chunk: string) => void];

export type AgentRunInput = {
  transcriptRewind?: { disposition: "keep_user" | "replace_user"; anchorUserTurnId: string };
  claimedPendingMessageId?: string; takeoverFromRunId?: string; resumeFromRunId?: string;
  attachments: ComposerAttachment[]; session: ChatSession; assistantId: string;
  userMessageId: string; sessionId: string; targetMode: ConversationMode;
};
export type AgentRunHost = {
  onRunFinished(input: { mode: ConversationMode; sessionId: string; queuePaused: boolean }): void;
  clearTakeover(sessionId: string): void;
  requestTakeover(sessionId: string, activeRunId: string, retry: () => Promise<void>): void;
  setModeBusy(mode: ConversationMode, busy: boolean): void;
  setCompressingContext(sessionId: string, value: boolean): void;
  updateContextUsage(sessionId: string, snapshot: ContextUsageSnapshot): void;
  updateTodos(sessionId: string, updater: (current: TodoStateBySession) => TodoStateBySession): void;
  dismissAskIfMatched(sessionId: string, value: unknown): void;
  clearInteraction(sessionId: string): void;
  setInteraction(sessionId: string, interaction: ComposerInteraction): void;
  patchMessage(sessionId: string, messageId: string, patch: Partial<ChatMessageItem>): void;
  failPlan?(sessionId: string, runId: string | undefined, phase: "failed" | "cancelled"): void;
  bindPlanRun?(sessionId: string, runId: string): void;
  bindPlanAttempt?(sessionId: string, assistantId: string): void;
  completePlan?(sessionId: string, planPath: string, runId: string): void;
};
export type AgentRunRegistries = {
  eventUnsubscribers: { current: Set<() => void> };
  cancelRequestedSessions: { current: Set<string> };
  checkpointTriggers: { current: Record<string, (status: "running" | "waiting_user") => void> };
  activeRuns: { current: Record<string, { mode: ConversationMode; runId?: string; assistantId: string }> };
};
export type AgentRunDeps = {
  startRun: (input: AgentRunInput) => Promise<void>;
  registries: AgentRunRegistries; host: AgentRunHost; store: ChatStoreApi | undefined; api: AguiApi | undefined;
};

export class AgentRunController {
  private readonly request: AgentRunInput;
  private readonly ports: AgentRunDeps;
  private answerText = "";
  private finishStatus: string | undefined;
  private ended = false;
  private readEvidence: WorkReadReport | undefined;
  private thoughts = "";
  private thoughtBlocks: ReasoningBlock[] = [];
  private progressEntries: ProcessMessageRecord[] = [];
  private rounds: AgentRoundRecord[] = [];
  private delegations: TaskDelegationDisplayRecord[] = [];
  private roundKey: string | undefined;
  private nextProcessNumber = 0;
  private timelineNumber = 0;
  private answerClosed = false;
  private revealStopped = false;
  private revealSteps: Promise<void> = Promise.resolve();
  private readonly textReveal = new PacedTextReveal(() => this.request.targetMode !== "chat" && !prefersReducedMotion());
  private waitingPublic: PublicText[] | undefined;
  private tailIsText = false;
  private unfinishedSteps = 0;
  private readonly thoughtFrame = new FrameCoalescer();
  private previewRound: string | undefined;
  private previewText = "";
  private shownPreview = "";
  private readonly previewQueue = new SmoothTextRevealQueue();
  private previewSequence: number | undefined;
  private frameHandle: number | undefined;
  private frameIsRaf = false;
  private previousFrameTime: number | undefined;
  private releasePreview: (() => void) | undefined;
  private classification: { processId: string; content: string } | undefined;
  private stickerId: string | null = null;
  private tools: ToolExecutionRecord[] = [];
  private started = false;
  private accepted = false;
  private activity: RunActivityRecord | undefined;
  private todos: TodoItem[] = [];
  private savedAnswer = "";
  private usage: ContextUsageSnapshot | undefined;
  private messageTime = 0;
  private saveTimer: number | undefined;
  private saves: Promise<ChatSession | null> = Promise.resolve<ChatSession | null>(null);
  private readonly thoughtStarts = new Map<string, number>();
  private thoughtKey: string | undefined;
  private sResponseControlled = false;
  private settle!: (error?: Error) => void;
  private readonly settlement: Promise<Error | undefined>;

  constructor(input: AgentRunInput, deps: AgentRunDeps) {
    this.request = input;
    this.ports = deps;
    this.settlement = new Promise<Error | undefined>((complete) => { this.settle = complete; });
  }

  private patch(update: Partial<ChatMessageItem>): void {
    this.ports.host.patchMessage(this.request.sessionId, this.request.assistantId, update);
  }

  async start(): Promise<void> {
    this.ports.host.bindPlanAttempt?.(this.request.sessionId, this.request.assistantId);
    const { api: transport, store: storage } = this.ports;
    if (!transport || !storage) {
      this.failPlan("failed");
      const notice = t("chatPage.errorModelServiceNotReady");
      this.patch({ content: notice, loading: false, waitingForFirstEvent: false, streaming: false, responseStarted: true });
      await storage?.append(this.request.sessionId, {
        id: this.request.assistantId, role: "model", content: notice, at: Date.now(), answersUserMessageId: this.request.userMessageId,
      });
      this.ports.host.onRunFinished({ mode: this.request.targetMode, sessionId: this.request.sessionId, queuePaused: true });
      return;
    }
    const incumbent = this.ports.registries.activeRuns.current[this.request.sessionId];
    if (!incumbent) {
      this.ports.host.setModeBusy(this.request.targetMode, true);
      this.ports.registries.activeRuns.current = {
        ...this.ports.registries.activeRuns.current,
        [this.request.sessionId]: { assistantId: this.request.assistantId, mode: this.request.targetMode },
      };
    }
    this.messageTime = Date.now();
    const trigger = (phase: CheckpointPhase) => { void this.checkpointRun(phase, true); };
    if (!incumbent) {
      this.ports.registries.checkpointTriggers.current = { ...this.ports.registries.checkpointTriggers.current, [this.request.sessionId]: trigger };
    }
    await this.checkpointRun("running", true);
    const gate = new RunEventGate<AguiEvent>();
    const unsubscribe = transport.onEvent((packet) => {
      for (const admitted of gate.accept(packet)) this.handleEvent(admitted);
    });
    this.ports.registries.eventUnsubscribers.current.add(unsubscribe);

    try {
      const acknowledgement = await transport.run({
        messages: this.request.session.messages.map((entry) => ({ role: entry.role, content: entry.modelContext?.trim() || entry.content, at: entry.at })),
        userTurnId: this.request.userMessageId, assistantTurnId: this.request.assistantId, sessionId: this.request.sessionId,
        recoveryContext: buildTodoRecoveryContext(this.request.session.messages, this.request.assistantId),
        ...(this.request.resumeFromRunId ? { resumeFromRunId: this.request.resumeFromRunId } : {}),
        ...(this.request.takeoverFromRunId ? { takeoverFromRunId: this.request.takeoverFromRunId } : {}),
        ...(this.request.transcriptRewind ? { transcriptRewind: this.request.transcriptRewind } : {}),
        imageAttachments: this.request.attachments.filter((file) => file.kind === "image" && file.filePath)
          .map((file) => ({ name: file.name, filePath: file.filePath!, mime: file.mime })),
      });
      if (!acknowledgement.success) throw new Error(acknowledgement.error ?? t("chatPage.errorModelRequestStartFailed"));
      if (incumbent) this.ports.host.setModeBusy(this.request.targetMode, true);
      this.ports.registries.activeRuns.current = {
        ...this.ports.registries.activeRuns.current,
        [this.request.sessionId]: {
          assistantId: this.request.assistantId, mode: this.request.targetMode,
          ...(acknowledgement.runId ? { runId: acknowledgement.runId } : {}),
        },
      };
      this.ports.registries.checkpointTriggers.current = { ...this.ports.registries.checkpointTriggers.current, [this.request.sessionId]: trigger };
      if (acknowledgement.runId) {
        this.ports.host.bindPlanRun?.(this.request.sessionId, acknowledgement.runId);
        for (const admitted of gate.bind(acknowledgement.runId)) this.handleEvent(admitted);
      }
      this.accepted = true;
      if (this.request.claimedPendingMessageId) {
        try {
          const cleared = await storage.pendingCompleteDispatch(this.request.sessionId, this.request.claimedPendingMessageId);
          if (!cleared.ok) {
            console.warn(
              "[AgentRunController] 待发派发确认失败（保留恢复入口）: sessionId=" + this.request.sessionId,
              "messageId=" + this.request.claimedPendingMessageId,
            );
          }
        } catch (failure) {
          console.warn(
            "[AgentRunController] 待发派发确认异常（保留恢复入口）: sessionId=" + this.request.sessionId,
            "messageId=" + this.request.claimedPendingMessageId, failure,
          );
        }
      }
      this.ports.host.clearTakeover(this.request.sessionId);
      if (acknowledgement.runId) {
        await this.checkpointRun("running", true);
        if (this.ports.registries.cancelRequestedSessions.current.delete(this.request.sessionId)) await transport.cancel(acknowledgement.runId);
      }
      const terminalFailure = await this.settlement;
      if (terminalFailure) throw terminalFailure;
      await this.revealSteps;
      const committed = isFormalAnswerCommitted(this.answerText, this.finishStatus, this.answerClosed);
      if (!committed) this.moveCandidateToInterruptedProcess();
      else this.resetCandidateState();
      this.completeRunActivity(!committed);
      const finalText = committed ? resolveTerminalContent(this.answerText, this.finishStatus) : "";
      this.savedAnswer = finalText;
      this.patch({
        content: finalText, runStage: resolveRunFinishedStage({ status: this.finishStatus }), transientText: undefined,
        loading: false, waitingForFirstEvent: false, streaming: false,
        reasoning: this.thoughts || undefined, reasoningBlocks: this.thoughtBlocks, processMessages: this.progressEntries,
        agentRounds: this.rounds, reasoningStreaming: false, runActivity: this.activity,
        responseStarted: committed, sticker: this.stickerId, toolExecutions: this.tools,
      });
      await this.checkpointRun("terminal", true);
      await this.refreshCanonicalSettlement();
      this.reportRunPersisted();
    } catch (failure) {
      this.finishStatus = this.finishStatus ?? "runtime_error";
      if (!this.ended) this.failPlan("failed");
      this.completeRunActivity(true);
      const explanation = failure instanceof Error ? failure.message : String(failure);
      const conflict = parseSessionRunActiveError(explanation);
      if (conflict) {
        this.moveCandidateToInterruptedProcess();
        this.progressEntries = [...this.progressEntries, createRoundProcessMessage(
          "process-" + this.nextProcessNumber++, t("chatPage.sessionRunActiveNotice"), this.tools.length, this.roundKey, this.nextSeq(),
        )];
        this.patchFailedProcess();
        this.savedAnswer = "";
        this.ports.host.requestTakeover(this.request.sessionId, conflict, async () => {
          this.patch({ loading: true, waitingForFirstEvent: true, streaming: false, responseStarted: false });
          await this.ports.startRun({ ...this.request, takeoverFromRunId: conflict });
        });
        await this.checkpointRun("terminal", true);
        return;
      }
      const publicFailure = publicRunFailure(failure);
      const labels = {
        context: "chatPage.errorContextFailedWith", model: "chatPage.errorModelRequestFailedWith",
        tool: "chatPage.errorToolFailedWith", runtime: "chatPage.errorRuntimeFailedWith",
      } as const;
      const notice = t(labels[publicFailure.source], { message: publicFailure.code });
      this.moveCandidateToInterruptedProcess();
      this.progressEntries = [...this.progressEntries, createRoundProcessMessage(
        "process-" + this.nextProcessNumber++, notice, this.tools.length, this.roundKey, this.nextSeq(),
      )];
      this.patchFailedProcess();
      this.savedAnswer = "";
      await this.checkpointRun("terminal", true);
      await this.refreshCanonicalSettlement();
      this.reportRunPersisted();
    } finally {
      this.cancelCandidateFrame();
      if (this.saveTimer !== undefined) window.clearTimeout(this.saveTimer);
      if (this.ports.registries.checkpointTriggers.current[this.request.sessionId] === trigger) {
        const remaining = { ...this.ports.registries.checkpointTriggers.current };
        delete remaining[this.request.sessionId];
        this.ports.registries.checkpointTriggers.current = remaining;
      }
      unsubscribe();
      this.ports.registries.eventUnsubscribers.current.delete(unsubscribe);
      const registered = this.ports.registries.activeRuns.current[this.request.sessionId];
      if (registered?.assistantId === this.request.assistantId) {
        this.ports.registries.cancelRequestedSessions.current.delete(this.request.sessionId);
        const remaining = { ...this.ports.registries.activeRuns.current };
        delete remaining[this.request.sessionId];
        this.ports.registries.activeRuns.current = remaining;
        this.ports.host.setModeBusy(this.request.targetMode, Object.values(remaining).some((entry) => entry.mode === this.request.targetMode));
        this.ports.host.onRunFinished({ mode: this.request.targetMode, sessionId: this.request.sessionId, queuePaused: !this.accepted });
      }
    }
  }

  private patchFailedProcess(): void {
    this.patch({
      content: "", runStage: { kind: "failed" }, transientText: undefined, processMessages: this.progressEntries,
      loading: false, waitingForFirstEvent: false, streaming: false, reasoningStreaming: false,
      runActivity: this.activity, responseStarted: false,
    });
  }

  private reportRunPersisted(): void {
    const owner = this.ports.registries.activeRuns.current[this.request.sessionId]?.runId;
    if (owner) this.ports.api?.reportRunPersisted?.({ runId: owner, finalMessageId: this.request.assistantId });
  }

  private async refreshCanonicalSettlement(): Promise<ChatMessage["sSettlement"]> {
    const storage = this.ports.store;
    if (typeof storage?.get !== "function") return;
    try {
      const conversation = await storage.get(this.request.sessionId);
      const reply = conversation?.messages.find((entry) => entry.id === this.request.assistantId);
      const authority = reply?.sSettlement;
      const registered = this.ports.registries.activeRuns.current[this.request.sessionId];
      if (!conversation || !authority || registered?.assistantId !== this.request.assistantId || authority.runId !== registered.runId) return;
      this.patch(toUiMessages({ ...conversation, messages: [reply!] })[0]);
      return authority;
    } catch { return; }
  }

  private buildCheckpoint(status: CheckpointPhase): ChatMessage {
    return {
      id: this.request.assistantId, role: "model", content: status === "terminal" ? this.savedAnswer : "",
      reasoning: this.thoughts || undefined, reasoningBlocks: this.thoughtBlocks, processMessages: this.progressEntries,
      agentRounds: this.rounds, taskDelegations: this.delegations, runActivity: this.activity, at: this.messageTime,
      answersUserMessageId: this.request.userMessageId, sticker: this.stickerId, toolExecutions: this.tools,
      contextUsage: this.usage, workReadReport: this.readEvidence,
      runSnapshot: {
        runId: this.ports.registries.activeRuns.current[this.request.sessionId]?.runId, status,
        terminalStatus: status === "terminal" ? this.finishStatus as "success" | "cancelled" | "timeout" | "runtime_error" | undefined : undefined,
        todos: this.todos, updatedAt: Date.now(),
      },
    };
  }

  private writeCheckpoint(status: CheckpointPhase): Promise<ChatSession | null> {
    const checkpoint = this.buildCheckpoint(status);
    this.saves = this.saves.catch(() => null).then(() => this.ports.store!.upsert(this.request.sessionId, checkpoint));
    return this.saves;
  }

  private checkpointRun(status: CheckpointPhase, immediate = false): Promise<ChatSession | null> {
    if (this.saveTimer !== undefined) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    if (immediate) return this.writeCheckpoint(status);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = undefined;
      void this.writeCheckpoint(status);
    }, 350);
    return this.saves;
  }

  private updateRunTool(toolId: string, patch: Partial<ToolExecutionRecord>) {
    const found = this.tools.findIndex((entry) => entry.id === toolId);
    if (found === -1) {
      this.tools = [...this.tools, {
        id: toolId, name: patch.name ?? t("chatPage.toolCallFallbackName"), displayName: patch.displayName,
        status: patch.status ?? "running", result: patch.result, argsText: patch.argsText,
        changes: patch.changes, roundId: patch.roundId ?? this.roundKey, seq: this.nextSeq(),
      }];
    } else this.tools = this.tools.map((entry, offset) => offset === found ? { ...entry, ...patch } : entry);
    this.patch({ toolExecutions: this.tools });
  }

  private enqueuePublicTextReveal(key: string, content: string, publish: (chunk: string) => void) {
    if (this.revealStopped) return;
    if (this.waitingPublic) { this.waitingPublic.push([key, content, publish]); return; }
    if (this.textReveal.active && this.tailIsText) { void this.textReveal.push(key, content, publish); return; }
    if (this.unfinishedSteps === 0) {
      const draining = this.textReveal.push(key, content, publish);
      this.appendChainStep(() => draining);
      this.tailIsText = true;
      return;
    }
    const queued: PublicText[] = [[key, content, publish]];
    this.waitingPublic = queued;
    this.appendChainStep(() => {
      if (this.waitingPublic === queued) this.waitingPublic = undefined;
      if (this.revealStopped) return;
      let draining: Promise<void> = Promise.resolve();
      for (const [itemKey, text, deliver] of queued) draining = this.textReveal.push(itemKey, text, deliver);
      return draining;
    });
    this.tailIsText = true;
  }

  private chainReveal(step: () => void | Promise<void>): void {
    this.appendChainStep(step);
    this.tailIsText = false;
  }

  private appendChainStep(step: () => void | Promise<void>): void {
    this.unfinishedSteps += 1;
    const finished = () => { this.unfinishedSteps -= 1; };
    this.revealSteps = this.revealSteps.then(() => {
      let pending: void | Promise<void>;
      try { pending = step(); }
      catch (failure) { finished(); throw failure; }
      if (!pending) { finished(); return; }
      return pending.then(finished, (failure: unknown) => { finished(); throw failure; });
    });
  }

  private cancelPublicReveal(): void {
    this.revealStopped = true;
    this.waitingPublic = undefined;
    this.textReveal.cancel();
    this.thoughtFrame.flush();
  }

  private publishCandidateChunk(chunk: string): void {
    if (!chunk) return;
    this.shownPreview += chunk;
    this.patch({
      transientText: this.shownPreview, loading: false, waitingForFirstEvent: false,
      streaming: true, responseStarted: true, runStage: { kind: "responding" },
    });
  }

  private ensureCandidateDrainTracked(): void {
    if (this.releasePreview || !this.previewQueue.hasPending) return;
    const draining = new Promise<void>((complete) => { this.releasePreview = complete; });
    this.chainReveal(() => draining);
  }

  private completeCandidateDrain(): void {
    const complete = this.releasePreview;
    this.releasePreview = undefined;
    this.previousFrameTime = undefined;
    complete?.();
  }

  private appendCandidateDelta(delta: string): void {
    const firstChunk = this.previewQueue.push(delta);
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    if (reduced) {
      this.publishCandidateChunk(firstChunk + this.previewQueue.drain());
      this.completeCandidateDrain();
      return;
    }
    this.publishCandidateChunk(firstChunk);
    if (!this.previewQueue.hasPending) { this.completeCandidateDrain(); return; }
    this.ensureCandidateDrainTracked();
    this.scheduleCandidateFrame();
  }

  private scheduleCandidateFrame(): void {
    if (this.frameHandle !== undefined || !this.previewQueue.hasPending) return;
    if (this.previousFrameTime === undefined) this.previousFrameTime = performance.now();
    this.frameIsRaf = Boolean(window.requestAnimationFrame);
    const schedule = window.requestAnimationFrame?.bind(window)
      ?? ((callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), SMOOTH_REVEAL_TICK_MS));
    this.frameHandle = schedule((now) => {
      this.frameHandle = undefined;
      if (!this.previewQueue.hasPending) { this.completeCandidateDrain(); return; }
      const elapsed = Math.max(0, now - (this.previousFrameTime ?? now));
      if (elapsed >= SMOOTH_REVEAL_TICK_MS) {
        this.previousFrameTime = now;
        this.publishCandidateChunk(this.previewQueue.takeNext(Math.min(elapsed, 160)));
      }
      if (this.previewQueue.hasPending) this.scheduleCandidateFrame();
      else this.completeCandidateDrain();
    });
  }

  private cancelCandidateFrame(): void {
    if (this.frameHandle === undefined) return;
    if (this.frameIsRaf && window.cancelAnimationFrame) window.cancelAnimationFrame(this.frameHandle);
    else window.clearTimeout(this.frameHandle);
    this.frameHandle = undefined;
  }

  private abortCandidateReveal(): void {
    this.cancelCandidateFrame();
    this.previewQueue.clear();
    this.completeCandidateDrain();
  }

  private resetCandidateState(): void {
    this.abortCandidateReveal();
    this.previewRound = undefined;
    this.previewText = "";
    this.shownPreview = "";
    this.previewSequence = undefined;
  }

  private commitPendingCandidateClassification(): void {
    const pending = this.classification;
    if (!pending) return;
    this.classification = undefined;
    this.progressEntries = this.progressEntries.map((entry) => entry.id === pending.processId ? { ...entry, content: pending.content } : entry);
    this.resetCandidateState();
    this.patch({ transientText: undefined, streaming: false, responseStarted: false, processMessages: this.progressEntries });
    void this.checkpointRun("running");
  }

  private scheduleCandidateClassification(content: string, roundId = this.previewRound ?? this.roundKey, seq = this.previewSequence): void {
    if (this.classification) { this.classification.content = content; return; }
    const processKey = "process-" + this.nextProcessNumber++;
    this.progressEntries = [...this.progressEntries, createRoundProcessMessage(processKey, "", this.tools.length, roundId, seq)];
    this.classification = { processId: processKey, content };
    this.chainReveal(() => { this.commitPendingCandidateClassification(); });
  }

  private nextSeq(): number { return this.timelineNumber++; }

  private closeRoundCandidateText(): void {
    if (this.classification) return;
    if (!this.previewText.trim()) { this.resetCandidateState(); return; }
    this.scheduleCandidateClassification(this.previewText);
  }

  private moveCandidateToInterruptedProcess(): void {
    if (!this.previewText.trim()) { this.resetCandidateState(); return; }
    this.progressEntries = [...this.progressEntries, {
      id: "process-" + this.nextProcessNumber++, content: this.previewText, interrupted: true,
      afterToolCount: this.tools.length, roundId: this.previewRound, seq: this.previewSequence,
    }];
    this.resetCandidateState();
  }

  private publishRunActivity() {
    if (this.activity) this.patch({ runActivity: { ...this.activity } });
  }

  private updateActiveReasoningStart() {
    const beginnings = [...this.thoughtStarts.values()];
    if (!this.activity) return;
    this.activity = { ...this.activity, activeReasoningStartedAt: beginnings.length ? Math.min(...beginnings) : undefined };
  }

  private completeRunActivity(keepExpanded = false) {
    if (this.activity && this.activity.completedAt !== undefined) return;
    const finishedAt = Date.now();
    for (const beginning of this.thoughtStarts.values()) {
      this.activity = {
        ...(this.activity ?? { startedAt: finishedAt, reasoningMs: 0 }),
        reasoningMs: (this.activity?.reasoningMs ?? 0) + Math.max(0, finishedAt - beginning),
      };
    }
    this.thoughtStarts.clear();
    this.activity = {
      ...(this.activity ?? { startedAt: finishedAt, reasoningMs: 0 }),
      completedAt: finishedAt, activeReasoningStartedAt: undefined, keepExpanded,
    };
    this.publishRunActivity();
  }

  private markFirstResponse() { this.patch({ waitingForFirstEvent: false }); }

  private updateReasoningBlock(id: string, patch: Partial<ReasoningBlock>, deferMessageUpdate = false) {
    const found = this.thoughtBlocks.findIndex((entry) => entry.id === id);
    if (found < 0) this.thoughtBlocks = [...this.thoughtBlocks, {
      id, content: "", afterToolCount: this.tools.length, roundId: this.roundKey, seq: this.nextSeq(), ...patch,
    }];
    else this.thoughtBlocks = this.thoughtBlocks.map((entry, position) => position === found ? { ...entry, ...patch } : entry);
    this.thoughts = this.thoughtBlocks.map((entry) => entry.content).filter(Boolean).join("\n\n");
    if (deferMessageUpdate) { void this.checkpointRun("running"); return; }
    this.thoughtFrame.cancel();
    this.patch({ reasoning: this.thoughts || undefined, reasoningBlocks: this.thoughtBlocks });
    void this.checkpointRun("running");
  }

  private ensureWorkReadReport(): void {
    if (this.readEvidence || this.request.targetMode !== "work") return;
    const question = this.request.session.messages.find((entry) => entry.id === this.request.userMessageId);
    const documents = (question?.attachments ?? []).flatMap((file) => file.kind === "document" && file.readScope ? [file.readScope] : []);
    if (documents.length === 0) return;
    this.readEvidence = {
      status: "unverified",
      files: documents.map((scope) => ({
        name: scope.name, status: "unverified", coveredLines: 0, requiredLines: scope.endLine, totalLines: scope.totalLines,
      })),
    };
    this.patch({ workReadReport: this.readEvidence });
  }

  private failPlan(phase: "failed" | "cancelled") {
    const registered = this.ports.registries.activeRuns.current[this.request.sessionId];
    if (this.accepted && registered && registered.assistantId !== this.request.assistantId) return;
    const owner = registered?.assistantId === this.request.assistantId ? registered.runId : undefined;
    this.ports.host.failPlan?.(this.request.sessionId, owner, phase);
  }

  private handleEvent(event: AguiEvent) {
    if (this.ended) return;
    if (event.type === "CUSTOM" && event.name === "firefly.plan.completed") {
      const fields = event.value as { runStatus?: unknown; planPath?: unknown } | null | undefined;
      const registered = this.ports.registries.activeRuns.current[this.request.sessionId];
      if ((this.request.targetMode === "code" || this.request.targetMode === "chat")
        && event.threadId === this.request.sessionId && event.runId === registered?.runId
        && registered?.assistantId === this.request.assistantId && fields?.runStatus === "completed"
        && typeof fields.planPath === "string" && fields.planPath) {
        this.ports.host.completePlan?.(this.request.sessionId, fields.planPath, event.runId!);
      }
      return;
    }
    if (event.type === "CUSTOM" && event.name === "firefly.sResponse") { this.sResponseControlled = true; return; }
    if (event.type === "CUSTOM" && event.name === "firefly.round") {
      const fields = event.value as { action?: unknown; roundId?: unknown } | null | undefined;
      if ((fields?.action === "start" || fields?.action === "end") && typeof fields.roundId === "string") {
        if (fields.action === "start" && fields.roundId !== this.previewRound) this.closeRoundCandidateText();
        const boundary = applyAgentRoundBoundary({ rounds: this.rounds, activeRoundId: this.roundKey }, fields.action, fields.roundId);
        this.rounds = boundary.rounds;
        this.roundKey = boundary.activeRoundId;
        this.patch({ agentRounds: this.rounds });
        void this.checkpointRun("running", true);
      }
    } else if (event.type === "CUSTOM" && event.name === "firefly.candidate_text") {
      const fields = event.value as Partial<CandidateTextEventValue> | null | undefined;
      if (typeof fields?.roundId !== "string" || fields.roundId !== this.roundKey) return;
      if (fields.action === "delta" && typeof fields.delta === "string" && fields.delta) {
        if (this.previewRound !== fields.roundId) {
          if (this.classification) {
            this.publishCandidateChunk(this.previewQueue.drain());
            this.completeCandidateDrain();
            this.commitPendingCandidateClassification();
          }
          this.resetCandidateState();
          this.previewRound = fields.roundId;
          this.previewSequence = this.nextSeq();
        }
        this.previewText += fields.delta;
        this.appendCandidateDelta(fields.delta);
      } else if (fields.action === "discard") this.closeRoundCandidateText();
    } else if (event.type === "RUN_STARTED") {
      this.beginEventRun(event);
      return;
    }
    if (!this.started) return;
    const visibleEvents = [
      "REASONING_MESSAGE_START", "REASONING_MESSAGE_CONTENT", "REASONING_MESSAGE_END",
      "TOOL_CALL_START", "TOOL_CALL_RESULT", "TOOL_CALL_END",
      "TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END", "CUSTOM",
    ];
    if (visibleEvents.includes(event.type!)) this.markFirstResponse();

    switch (event.type) {
      case "REASONING_MESSAGE_START": {
        const key = event.messageId ?? crypto.randomUUID();
        this.thoughtKey = key;
        this.thoughtStarts.set(key, Date.now());
        this.updateActiveReasoningStart();
        this.publishRunActivity();
        this.updateReasoningBlock(key, { streaming: true });
        this.patch({ loading: false, reasoningStreaming: true, runStage: { kind: "responding" } });
        break;
      }
      case "REASONING_MESSAGE_CONTENT": {
        if (!event.delta) break;
        const key = event.messageId ?? this.thoughtKey ?? crypto.randomUUID();
        this.thoughtKey = key;
        const prior = this.thoughtBlocks.find((entry) => entry.id === key)?.content ?? "";
        this.updateReasoningBlock(key, { content: prior + event.delta, streaming: true }, true);
        this.thoughtFrame.schedule(() => this.patch({
          reasoning: this.thoughts || undefined, reasoningBlocks: this.thoughtBlocks, loading: false, reasoningStreaming: true,
        }));
        break;
      }
      case "REASONING_MESSAGE_END": {
        const key = event.messageId ?? this.thoughtKey;
        if (key) {
          const beginning = this.thoughtStarts.get(key);
          if (beginning && this.activity) {
            this.activity = { ...this.activity, reasoningMs: this.activity.reasoningMs + Math.max(0, Date.now() - beginning) };
          }
          this.thoughtStarts.delete(key);
          this.updateActiveReasoningStart();
          this.publishRunActivity();
          this.updateReasoningBlock(key, { streaming: false });
        }
        this.thoughtKey = undefined;
        this.patch({ reasoningStreaming: false, loading: false });
        break;
      }
      case "STEP_STARTED": {
        const phase = stageForStep(event.stepName);
        if (phase) this.patch({ runStage: phase });
        break;
      }
      case "TOOL_CALL_START": {
        if (!event.toolCallId) break;
        const caption = event.toolCallDisplayName ?? event.toolCallName ?? t("chatPage.toolCallFallbackName");
        this.updateRunTool(event.toolCallId, {
          name: event.toolCallName ?? t("chatPage.toolCallFallbackName"),
          displayName: event.toolCallDisplayName, status: "running", roundId: this.roundKey,
        });
        this.patch({ runStage: { kind: "executing", detail: caption } });
        break;
      }
      case "TOOL_CALL_ARGS": {
        if (!event.toolCallId || !event.delta) break;
        const prior = this.tools.find((entry) => entry.id === event.toolCallId)?.argsText ?? "";
        this.updateRunTool(event.toolCallId, { argsText: prior + event.delta, roundId: this.roundKey });
        break;
      }
      case "TOOL_CALL_RESULT": {
        if (!event.toolCallId) break;
        this.updateRunTool(event.toolCallId, {
          status: event.status === "failed" ? "error" : "success", result: (event.content ?? "").slice(0, 4000),
          changes: event.changes, taskResult: this.tools.find((entry) => entry.id === event.toolCallId)?.name === "delegate_agent"
            ? normalizeToolTaskResult(event.taskResult, event.runId) : undefined,
        });
        void this.checkpointRun("running", true);
        break;
      }
      case "TOOL_CALL_END":
        if (event.toolCallId) this.updateRunTool(event.toolCallId, {});
        break;
      case "TEXT_MESSAGE_START":
        this.patch({ loading: false, reasoningStreaming: false, responseStarted: true, streaming: true, runStage: { kind: "responding" } });
        break;
      case "TEXT_MESSAGE_CONTENT":
        if (!event.delta) break;
        if (this.previewText) this.answerText += event.delta;
        else this.enqueuePublicTextReveal("answer", event.delta, (chunk) => {
          this.answerText += chunk;
          this.patch({ content: this.answerText, loading: false, streaming: true, responseStarted: true });
          void this.checkpointRun("running");
        });
        break;
      case "TEXT_MESSAGE_END":
        if (this.previewText) this.answerClosed = true;
        else this.chainReveal(() => {
          this.answerClosed = true;
          this.patch({ streaming: false });
        });
        break;
      case "CUSTOM":
        this.handleCustomEvent(event);
        break;
      case "RUN_FINISHED": {
        this.ensureWorkReadReport();
        this.ended = true;
        const terminal = (event as { result?: { status?: string } }).result;
        this.finishStatus = terminal?.status;
        if (this.finishStatus !== "success") this.failPlan(this.finishStatus === "cancelled" ? "cancelled" : "failed");
        if (this.finishStatus !== "success") { this.cancelPublicReveal(); this.abortCandidateReveal(); }
        const phase = resolveRunFinishedStage(terminal);
        this.patch({ runStage: phase });
        const owner = this.ports.registries.activeRuns.current[this.request.sessionId]?.runId;
        if (shouldClearComposerInteractionForTerminal(owner, event.runId)) this.ports.host.clearInteraction(this.request.sessionId);
        this.settle();
        break;
      }
      case "RUN_ERROR": {
        this.failPlan("failed");
        this.ensureWorkReadReport();
        this.ended = true;
        this.cancelPublicReveal();
        this.abortCandidateReveal();
        this.completeRunActivity(true);
        this.patch({ runStage: { kind: "failed" } });
        const owner = this.ports.registries.activeRuns.current[this.request.sessionId]?.runId;
        if (shouldClearComposerInteractionForTerminal(owner, event.runId)) this.ports.host.clearInteraction(this.request.sessionId);
        const failure = publicRunFailure({ code: event.code, message: event.message });
        this.settle(Object.assign(new Error(failure.code), failure));
        break;
      }
    }
  }

  private beginEventRun(event: AguiEvent): void {
    this.started = true;
    this.activity = { startedAt: Date.now(), reasoningMs: 0 };
    this.ports.host.setCompressingContext(this.request.sessionId, false);
    if (event.runId) {
      const registered = this.ports.registries.activeRuns.current[this.request.sessionId];
      if (registered?.runId && registered.runId !== event.runId) {
        console.warn(
          "[AgentRunController] RUN_STARTED.runId (" + event.runId + ") 与 ack.runId (" + registered.runId + ") 不一致，"
          + "请检查 bridge 是否正确注入 options.runId。保留 ack.runId 作为权威值。",
        );
      } else {
        this.ports.registries.activeRuns.current = {
          ...this.ports.registries.activeRuns.current,
          [this.request.sessionId]: {
            ...(registered ?? { assistantId: this.request.assistantId, mode: this.request.targetMode }), runId: event.runId,
          },
        };
      }
    }
    this.todos = [];
    const owner = event.runId ?? this.ports.registries.activeRuns.current[this.request.sessionId]?.runId;
    this.ports.host.updateTodos(this.request.sessionId, (previous) => startSessionTodos(previous, this.request.sessionId, owner));
    this.patch({ waitingForFirstEvent: false, runActivity: { ...this.activity }, runStage: { kind: "understanding" }, runId: owner });
    void this.checkpointRun("running", true);
  }

  private handleCustomEvent(event: AguiEvent): void {
    switch (event.name) {
      case "firefly.process_text": {
        const text = (event.value as { content?: unknown } | null | undefined)?.content;
        if (typeof text !== "string" || !text.trim()) break;
        const fromPreview = Boolean(this.previewText);
        const sequence = fromPreview ? this.previewSequence : this.nextSeq();
        if (fromPreview) this.scheduleCandidateClassification(text, this.previewRound ?? this.roundKey, sequence);
        else {
          const key = "process-" + this.nextProcessNumber++;
          this.progressEntries = [...this.progressEntries, createRoundProcessMessage(key, "", this.tools.length, this.roundKey, sequence)];
          this.patch({ processMessages: this.progressEntries });
          this.enqueuePublicTextReveal(key, text, (chunk) => {
            this.progressEntries = this.progressEntries.map((entry) => entry.id === key ? { ...entry, content: entry.content + chunk } : entry);
            this.patch({ processMessages: this.progressEntries });
            void this.checkpointRun("running");
          });
        }
        break;
      }
      case "firefly.task": {
        const child = normalizeTaskDelegationEvent(event.value);
        if (!child) break;
        this.delegations = applyTaskDelegationEvent(this.delegations, child, this.roundKey);
        this.patch({ taskDelegations: this.delegations, runStage: { kind: "executing", detail: child.nickname } });
        void this.checkpointRun("running", true);
        break;
      }
      case "firefly.choice": {
        const card = normalizeChoiceInteraction(event.value);
        if (!card) break;
        this.ports.host.setInteraction(this.request.sessionId, card);
        this.patch({ runStage: { kind: "waiting_user" } });
        void this.checkpointRun("waiting_user", true);
        break;
      }
      case "firefly.choice.dismiss":
        this.ports.host.dismissAskIfMatched(this.request.sessionId, event.value);
        void this.checkpointRun("running", true);
        break;
      case "firefly.taskPlan": {
        const plan = normalizeTaskPlanPresentation(event.value);
        if (plan) this.patch({ taskPlan: plan, runStage: { kind: "executing" } });
        break;
      }
      case "firefly.todo": {
        const entries = (event.value as { items?: Array<{ id: string; content: string; status: string }> } | null | undefined)?.items;
        if (!Array.isArray(entries)) break;
        const owner = event.runId ?? this.ports.registries.activeRuns.current[this.request.sessionId]?.runId;
        const normalized = mergeHarnessTodosForSession({
          [this.request.sessionId]: { runId: owner, todos: this.todos, updatedAt: Date.now() },
        }, this.request.sessionId, owner, entries);
        this.todos = normalized[this.request.sessionId]?.todos ?? this.todos;
        this.ports.host.updateTodos(this.request.sessionId, (previous) => mergeHarnessTodosForSession(previous, this.request.sessionId, owner, entries));
        void this.checkpointRun("running", true);
        break;
      }
      case "firefly.compressingContext":
        this.ports.host.setCompressingContext(this.request.sessionId, true);
        break;
      case "firefly.context.usage": {
        const snapshot = isContextUsageSnapshot(event.value) ? event.value : undefined;
        if (!snapshot) break;
        this.usage = snapshot;
        this.patch({ contextUsage: snapshot });
        this.ports.host.updateContextUsage(this.request.sessionId, snapshot);
        if (snapshot.phase === "terminal") void this.checkpointRun("running");
        break;
      }
      case "firefly.sticker":
        this.stickerId = typeof event.value === "string" ? event.value : null;
        this.patch({ sticker: this.stickerId });
        break;
      case "firefly.weather": {
        const card = normalizeWeatherData(event.value);
        if (card) this.patch({ weather: card });
        break;
      }
      case "firefly.workRead": {
        const evidence = event.value as WorkReadReport | undefined;
        if (evidence && Array.isArray(evidence.files) && ["complete", "partial", "missing", "changed", "unverified"].includes(evidence.status)) {
          this.readEvidence = evidence;
          this.patch({ workReadReport: evidence });
        }
        break;
      }
    }
  }
}
