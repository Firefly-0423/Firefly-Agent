import { promptTokensOf } from "./context-usage";
import type { ToolSpec, ChatResponse, ChatMessage } from "../../model/providers/types";
import { causeCodes } from "../../model/providers/error-chain";
import type { RunAdjustmentMessage, RunAdjustmentPoll, RunInsertionReceipt, AgentLoopResult, AgentLoopInput, AgentLoopConfig, AgentLoopCacheState, AgentState } from "./types";
import type { ToolOutputRef } from "./tool-output/tool-output-store";
import { INITIAL_AGENT_LOOP_CACHE_STATE, DEFAULT_AGENT_LOOP_CONFIG } from "./types";
import { getAgentLoopBuiltinToolSpecs } from "./builtin-tools";
import type { ToolDispatchContext } from "./tool-dispatcher";
import { computeTokenBudget, compressForAgentLoop, type TokenBudget } from "./compaction";
import { emitContextUsage, emitCacheDiagnostic } from "./agent-loop-observability";
import { StreamController } from "./stream-controller";
import { TimeoutClock } from "./timeout-clock";
import { buildCurrentTodoNotebookContext } from "./todo-working-notebook";
import { appendInternalTranscriptMessage, createInternalTranscriptMessage } from "../../model/prompt/internal-transcript";
import { callLLM, summarizeHistory } from "./agent-loop-llm";
import { ChatTimeStreamPrefixFilter } from "../../model/text/chat-time-stream-filter";
import { runToolRound, type ToolRoundOutcome } from "./tool-round";
import { publicRunFailure, type RunFailure, type RunFailureSource } from "../../../shared/run-failure";
import { ContextError } from "../../model/context/context-contracts";
import { buildStableSystemPrefix, type PromptLayers } from "../../model/prompt/prompt-layers";
import { logger, LogTag } from "../../base/logging/logger";
import { frameRunInsertion } from "./run-insertion-framing";

const logTag = "[AgentLoop]";
export type AgentLoopRun = {
  deadlineExceeded?: boolean;
  executionSettlement?: Promise<void>;
  currentAssistantEntryId?: string;
  toolCallStartedAt: Map<string, number>;
  toolDispatchContext: ToolDispatchContext;
  askDispatchContext: ToolDispatchContext;
  toolExecutionFailure?: { error: unknown };
  checkpoint(): void;
  failure?: RunFailure;
  checkpointFailure?: string;
  rounds: number;
  /** The provider's usage for the last model request, for the context card; cleared when compaction rewrites history. */
  measuredUsage?: { inputTokens: number; outputTokens: number; messageCount: number };
  cache: AgentLoopCacheState;
  toolOutputs: ToolOutputRef[];
  /** Receipts of inserted queue messages already in `messages`; saved with every checkpoint. */
  insertions: RunInsertionReceipt[];
  messages: ChatMessage[];
  allToolSpecs: ToolSpec[];
  streamController: StreamController;
  clock: TimeoutClock;
  state: AgentState;
  config: AgentLoopConfig;
  input: AgentLoopInput;
};

export async function runAgentLoop(input: AgentLoopInput): Promise<AgentLoopResult> {
  if (input.memoryRun && input.transcriptSink) input = { ...input, transcriptSink: input.memoryRun.bindSink(input.transcriptSink) };
  const current = createRun(input);
  current.clock.setDeadlineHandler(() => {
    if (input.signal?.aborted) return;
    current.deadlineExceeded = true;
    input.quiesceExecution?.();
  });
  current.clock.startActive();
  materializeInitialContext(current);
  let returned = false;
  try {
    const terminal = await runAgentLoopRounds(current);
    returned = true;
    return terminal;
  } finally {
    current.clock.setDeadlineHandler(null);
    try { if (!returned) input.quiesceExecution?.(); }
    finally { await drainRunExecution(current); }
  }
}
function failedStage(run: AgentLoopRun, cause: unknown, source: RunFailureSource, prefix = ""): Promise<AgentLoopResult> {
  const publicFailure = recordFailure(run, cause, source, prefix);
  return finishRun(run, prefix + publicFailure.code, true, "error");
}
/** Waits before retrying a blocked insertion, so a transient storage fault can clear. */
export const ADJUSTMENT_RETRY_DELAYS_MS = [200, 600] as const;

function waitForRetry(run: AgentLoopRun, ms: number): Promise<void> {
  const signal = run.input.signal;
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Pulls inserted queue messages before the next model request. Committed items enter the
 * context with a delivery receipt and are checkpointed first; a blocked item is retried a
 * bounded number of times before the request, and if it still cannot be committed the run
 * stops instead of answering without the user's supplement. Returns how many entered the
 * context, or the run's result when it must end here.
 */
async function acceptAdjustments(run: AgentLoopRun, firstPoll: Promise<RunAdjustmentPoll> | undefined, beforeFirstInsertion?: () => void): Promise<number | AgentLoopResult> {
  const host = run.input;
  let accepted = 0;
  for (let attempt = 0; ; attempt++) {
    const poll = attempt === 0 ? firstPoll : host.pollRunAdjustments?.();
    if (!poll) return accepted;
    let pulled: RunAdjustmentPoll;
    try { pulled = await poll; }
    catch (cause) { return failedStage(run, cause, "runtime", "插话提交失败："); }
    const fresh = pulled.delivered.filter((entry) => !run.insertions.some((receipt) => receipt.messageId === entry.id && receipt.revision === entry.revision));
    if (fresh.length > 0) {
      if (accepted === 0) beforeFirstInsertion?.();
      for (const entry of fresh) {
        run.messages.push({ role: "user", content: frameRunInsertion(entry.rawContent) });
        run.insertions.push({ messageId: entry.id, revision: entry.revision, sourceRunId: host.runId ?? "", round: run.rounds, order: run.insertions.length + 1 });
      }
      accepted += fresh.length;
      checkpoint(run);
      if (run.checkpointFailure) return checkpointFailed(run);
    }
    if (!pulled.blocked) return accepted;
    const { messageId, reason, retryable } = pulled.blocked;
    if (!retryable || attempt >= ADJUSTMENT_RETRY_DELAYS_MS.length) {
      return failedStage(run, new Error(`PENDING_ADJUST_BLOCKED:${messageId}:${reason}`), "runtime", "插话提交失败：");
    }
    await waitForRetry(run, ADJUSTMENT_RETRY_DELAYS_MS[attempt]);
    if (host.signal?.aborted) return abortedResult(run);
  }
}

function checkpointFailed(run: AgentLoopRun): Promise<AgentLoopResult> {
  return finishRun(run, `执行状态保存失败：${run.checkpointFailure}`, true, "error");
}
async function runAgentLoopRounds(run: AgentLoopRun): Promise<AgentLoopResult> {
  const host = run.input;
  while (!run.clock.isExecutionTimeout()) {
    if (run.checkpointFailure) return checkpointFailed(run);
    if (host.signal?.aborted) return abortedResult(run);
    if (run.config.maxRounds > 0 && run.rounds >= run.config.maxRounds) {
      const reply = run.streamController.getBuffered() || buildMaxRoundsReply(run.state, run.config.maxRounds);
      host.onEvent?.({ type: "final_answer", content: reply });
      return finishRun(run, reply, true, "max_rounds");
    }
    // Nothing marked: pass straight through, so the first model request gains no extra await.
    const firstPoll = host.pollRunAdjustments?.();
    if (firstPoll) {
      const inserted = await acceptAdjustments(run, firstPoll);
      if (typeof inserted !== "number") return inserted;
    }
    const layers = host.collectTurnPluginContext
      ? await buildRoundPromptLayersWithPluginContext(host, run.rounds)
      : buildRoundPromptLayers(host);
    const round = `round-${run.rounds}`;
    host.onEvent?.({ type: "round_start", roundId: round });
    // 无需压缩时同步穿过这里，首次模型调用不增加等待点。
    const pendingCompaction = compactIfNeeded(run, layers);
    if (pendingCompaction) {
      await pendingCompaction;
      if (run.checkpointFailure) return checkpointFailed(run);
    }
    emitContextUsage(run, "preRequest");
    emitCacheDiagnostic(run, layers);
    let generated: ChatResponse;
    const requested = run.messages.length;
    try { generated = await callRoundLLM(run, layers, round); }
    catch (cause) {
      if (host.signal?.aborted) return abortedResult(run);
      return failedStage(run, cause, cause instanceof ContextError ? "context" : "model");
    }
    // A round without usage must not keep the previous round's count as the baseline: the card falls back to the estimate.
    run.measuredUsage = generated.usage ? { inputTokens: promptTokensOf(generated.usage), outputTokens: generated.usage.output, messageCount: requested } : undefined;
    const declaration = toAssistantMessage(generated);
    run.messages.push(declaration);
    try { run.currentAssistantEntryId = await host.transcriptSink?.appendAssistant({ message: declaration, roundId: round }); }
    catch (cause) { return failedStage(run, cause, "runtime", "会话轨迹保存失败："); }
    if (generated.text) run.streamController.bufferProgressContent(generated.text);
    if (generated.finishReason === "length") console.warn(`${logTag} round ${run.rounds} finishReason=length (输出命中上限被截断)`);
    const calls = generated.toolCalls ?? [];
    if (calls.length > 0) {
      checkpoint(run);
      if (run.checkpointFailure) return checkpointFailed(run);
      let disposition: ToolRoundOutcome;
      try { disposition = await runToolRound(run, calls); }
      catch (cause) {
        if (!run.toolExecutionFailure && host.signal?.aborted) return abortedResult(run);
        const initiating = run.toolExecutionFailure ? run.toolExecutionFailure.error : cause;
        return failedStage(run, initiating, "tool", "工具执行异常：");
      }
      if (disposition === "cancelled") return abortedResult(run);
      host.onEvent?.({ type: "round_end", roundId: round });
      run.rounds++;
      checkpoint(run);
      continue;
    }
    const suffix = generated.finishReason === "length" ? "\n\n⚠️ 模型输出达到长度上限，以上回复可能不完整。" : "";
    const lateInsertions = await acceptAdjustments(run, host.pollRunAdjustments?.(), () => {
      // The answer this round was about to give becomes progress before the late insertion.
      const intermediate = run.streamController.commitProgressBuffer() + suffix;
      host.onEvent?.({ type: "round_end", roundId: round });
      if (intermediate) host.onEvent?.({ type: "progress_text", content: intermediate });
      run.rounds++;
    });
    if (typeof lateInsertions !== "number") return lateInsertions;
    if (lateInsertions > 0) continue;
    const reply = run.streamController.commitProgressBuffer() + suffix;
    host.onEvent?.({ type: "round_end", roundId: round });
    host.onEvent?.({ type: "final_answer", content: reply });
    return finishRun(run, reply, false, undefined);
  }
  const reply = run.streamController.getBuffered() || buildTimeoutReply(run.state);
  host.onEvent?.({ type: "final_answer", content: reply });
  return finishRun(run, reply, true, "timeout");
}

function createRun(input: AgentLoopInput): AgentLoopRun {
  const limits: AgentLoopConfig = { ...DEFAULT_AGENT_LOOP_CONFIG, ...input.config };
  const restored: AgentState = input.initialState ? deepClone(input.initialState) : { todoItems: [], uncertainEffects: [] };
  const registered: ToolSpec[] = input.tools.map((definition) => ({ name: definition.id, description: definition.description,
    parameters: { type: "object" as const, properties: definition.inputSchema.properties, required: definition.inputSchema.required } }));
  const advertised: ToolSpec[] = [...registered, ...getAgentLoopBuiltinToolSpecs({
    includeInteractive: input.includeInteractiveTools, includeAgent: Boolean(input.agentExecutor), agentDefinitions: input.agentDefinitions, planState: input.planState,
  }).filter((spec) => !input.allowedBuiltinToolIds || input.allowedBuiltinToolIds.has(spec.name))];
  const interactive: ToolDispatchContext = { state: restored, tools: input.tools, onEvent: input.onEvent,
    requestUserClarification: input.requestUserClarification, includeInteractiveTools: input.includeInteractiveTools,
    allowedBuiltinToolIds: input.allowedBuiltinToolIds, toolOutputStore: input.toolOutputStore,
    toolContext: { userQuery: input.toolContext?.userQuery ?? "", ...input.toolContext, signal: input.signal } };
  return {
    input, config: limits, state: restored, clock: new TimeoutClock(limits.totalTimeoutMs, limits.userWaitTimeoutMs),
    streamController: new StreamController(), allToolSpecs: advertised, messages: [...input.messages], toolOutputs: [], insertions: [],
    cache: input.initialCache ? { ...input.initialCache } : { ...INITIAL_AGENT_LOOP_CACHE_STATE }, rounds: 0,
    checkpoint() { checkpoint(this); }, askDispatchContext: interactive,
    toolDispatchContext: { ...interactive, checkPermission: input.checkPermission, toolContext: input.toolContext,
      executionLedger: input.executionLedger, agentExecutor: input.agentExecutor, deferOutputPersistence: true }, toolCallStartedAt: new Map(),
  };
}
function materializeInitialContext(run: AgentLoopRun): void {
  const host = run.input;
  const facts = [host.initialInternalContext?.content, host.promptLayers?.runtimeContext,
    run.state.todoItems.length > 0 ? buildCurrentTodoNotebookContext(run.state.todoItems) : undefined]
    .filter((text): text is string => Boolean(text?.trim()));
  if (facts.length === 0) return;
  const revision = run.messages.reduce((maximum, message) => Math.max(maximum, message.internal?.revision ?? 0), 0);
  run.messages = appendInternalTranscriptMessage(run.messages, createInternalTranscriptMessage({
    kind: host.initialInternalContext?.kind ?? "run_start", revision: revision + 1, runId: host.runId ?? "harness-run", content: facts.join("\n\n---\n\n"),
  }));
}
function buildRoundPromptLayers(input: AgentLoopInput, turnPluginContext?: string): PromptLayers {
  return {
    stablePrefix: input.promptLayers?.stablePrefix ?? input.systemPrompt,
    ...(input.promptLayers?.sessionPrefix ? { sessionPrefix: input.promptLayers.sessionPrefix } : {}),
    ...(input.promptLayers?.mode ? { mode: input.promptLayers.mode } : {}),
    ...(turnPluginContext?.trim() ? { runtimeContext: turnPluginContext.trim() } : {}),
  };
}
async function buildRoundPromptLayersWithPluginContext(input: AgentLoopInput, round: number): Promise<PromptLayers> {
  let turnPluginContext: string | undefined;
  try {
    turnPluginContext = await input.collectTurnPluginContext!({ round, signal: input.signal });
  } catch (cause) {
    logger.warn(LogTag.Plugins, "per-turn plugin context collection failed, skipped:", cause);
  }
  return buildRoundPromptLayers(input, turnPluginContext);
}
function compactIfNeeded(run: AgentLoopRun, promptLayers: PromptLayers): Promise<void> | undefined {
  if (run.input.memoryRun) return undefined;
  const limits = run.config;
  const system = buildStableSystemPrefix(promptLayers);
  const budget = computeTokenBudget(system, run.allToolSpecs, run.messages, limits.contextWindowTokens,
    limits.reservedOutputTokens, limits.safetyMarginTokens, limits.compactionThreshold);
  return budget.needsCompaction ? runCompaction(run, system, budget) : undefined;
}
async function runCompaction(run: AgentLoopRun, roundSystemPrompt: string, budget: TokenBudget): Promise<void> {
  const host = run.input;
  const limits = run.config;
  logger.info(LogTag.Runtime, `mid-loop compaction triggered (estimated=${budget.estimatedInput} budget=${budget.usableInputBudget})`);
  const before = run.messages.length;
  host.onCompactionLifecycle?.({ status: "started", messageCountBefore: before });
  const replacement = await compressForAgentLoop({ messages: run.messages,
    retainTokens: Math.floor(limits.contextWindowTokens * limits.compactionRetainRatio),
    summarize: (history) => summarizeHistory(host.vendorConfig, roundSystemPrompt, history, run.allToolSpecs, host.signal) });
  if (replacement === run.messages) { run.messages = replacement; return; }
  run.cache = { cacheEpoch: run.cache.cacheEpoch + 1, epochReason: "compaction" };
  run.messages = replacement; run.measuredUsage = undefined;
  host.onCompactionLifecycle?.({ status: "committed", messageCountBefore: before, messageCountAfter: replacement.length, cache: { ...run.cache } });
  checkpoint(run);
}
async function callRoundLLM(run: AgentLoopRun, promptLayers: PromptLayers, roundId: string): Promise<ChatResponse> {
  const reasoningId = `reasoning-${run.rounds}`;
  let thinking = false;
  const prefix = new ChatTimeStreamPrefixFilter();
  try {
    return await callLLM(run.input.vendorConfig, promptLayers, run.messages, run.allToolSpecs, run.config, run.input.signal,
      (delta) => {
        if (!thinking) { thinking = true; run.input.onEvent?.({ type: "reasoning_start", messageId: reasoningId }); }
        run.input.onEvent?.({ type: "reasoning_delta", messageId: reasoningId, delta });
      },
      (delta) => {
        const shown = prefix.push(delta);
        if (shown) run.input.onEvent?.({ type: "candidate_text_delta", roundId, delta: shown });
      }, run.input.memoryRun);
  } finally {
    const remainder = prefix.finish();
    if (remainder) run.input.onEvent?.({ type: "candidate_text_delta", roundId, delta: remainder });
    if (thinking) run.input.onEvent?.({ type: "reasoning_end", messageId: reasoningId });
  }
}

function checkpoint(run: AgentLoopRun): void {
  try { run.input.onCheckpoint?.({ messages: run.messages, state: run.state, toolOutputs: run.toolOutputs,
    rounds: run.rounds, cache: { ...run.cache }, insertions: run.insertions.map((receipt) => ({ ...receipt })), at: Date.now() }); }
  catch (cause) {
    const safe = publicRunFailure(cause);
    run.failure ??= safe;
    run.checkpointFailure = safe.code;
    console.error(`${logTag} checkpoint failed:`, { runId: run.input.runId, round: run.rounds, ...safe });
  }
}
function drainRunExecution(run: AgentLoopRun): Promise<void> {
  if (run.executionSettlement) return run.executionSettlement;
  const owner = run.input.toolContext?.execution;
  run.executionSettlement = owner ? owner.scope.childRunId === owner.scope.parentRunId
    ? owner.coordinator.closeGroup(owner.scope.groupId) : owner.coordinator.whenChildSettled(owner.scope.childRunId) : Promise.resolve();
  return run.executionSettlement;
}
async function settleRun(run: AgentLoopRun): Promise<void> {
  await drainRunExecution(run);
  run.clock.stopActive();
  emitContextUsage(run, "terminal");
  checkpoint(run);
}
function abortedResult(run: AgentLoopRun): Promise<AgentLoopResult> {
  if (!run.deadlineExceeded) return cancelledResult(run);
  const reply = run.streamController.getBuffered() || buildTimeoutReply(run.state);
  run.input.onEvent?.({ type: "final_answer", content: reply });
  return finishRun(run, reply, true, "timeout");
}
async function cancelledResult(run: AgentLoopRun): Promise<AgentLoopResult> {
  run.input.quiesceExecution?.();
  await settleRun(run);
  if (run.checkpointFailure) return buildResult(`执行状态保存失败：${run.checkpointFailure}`, run.state, true, "error", run.rounds, run.failure);
  return { finalAnswer: "", finalState: run.state, terminated: true, terminateReason: "cancelled",
    terminal: { status: "cancelled", reason: "user_cancelled", externalEffectsMayContinue: true }, rounds: run.rounds };
}
async function finishRun(run: AgentLoopRun, finalAnswer: string, terminated: boolean,
  terminateReason: AgentLoopResult["terminateReason"]): Promise<AgentLoopResult> {
  if (terminated) run.input.quiesceExecution?.();
  await settleRun(run);
  if (run.checkpointFailure) {
    const detail = `执行状态保存失败：${run.checkpointFailure}`;
    const reply = run.toolExecutionFailure ? finalAnswer + (finalAnswer.includes(detail) ? "" : `\n${detail}`) : detail;
    return buildResult(reply, run.state, true, "error", run.rounds, run.failure);
  }
  return buildResult(finalAnswer, run.state, terminated, terminateReason, run.rounds, run.failure);
}
function interruptionReply(state: AgentState, heading: string[]): string {
  if (state.todoItems.length > 0) {
    heading.push("", "当前待办状态：");
    for (const entry of state.todoItems) heading.push(`  [${entry.status}] ${entry.content}`);
  }
  if (state.uncertainEffects.length > 0) {
    heading.push("", "⚠️ 以下副作用结果未知：");
    for (const entry of state.uncertainEffects) heading.push(`  - ${entry.toolName}: ${entry.message}`);
  }
  return heading.join("\n");
}
function buildTimeoutReply(state: AgentState): string {
  return interruptionReply(state, ["抱歉，任务执行时间较长，已达到时间上限。", "", "中断原因：执行超时"]);
}
function buildMaxRoundsReply(state: AgentState, maxRounds: number): string {
  return interruptionReply(state, [`任务已达到工具轮次上限（${maxRounds}），已停止继续执行。`, "", "中断原因：工具轮次上限"]);
}
function buildResult(finalAnswer: string, state: AgentState, terminated: boolean,
  terminateReason: AgentLoopResult["terminateReason"], rounds: number, failure?: RunFailure): AgentLoopResult {
  return { finalAnswer, finalState: state, terminated, terminateReason, rounds, ...(failure ? { failure } : {}) };
}
function recordFailure(run: AgentLoopRun, error: unknown, source: RunFailureSource, stage = ""): RunFailure {
  const safe = publicRunFailure(error, source);
  run.failure = safe;
  // The local log also names the internal code and the error chain (class names and codes, never a message)
  // that the public code folds away, and the stage that failed.
  // Many internal failures carry their code as the whole message (Error("MEMORY_...")); only such identifiers are logged.
  const { code: internal, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  const identifier = [internal, message].find((value): value is string => typeof value === "string" && /^[A-Z][A-Z0-9_]{2,80}$/.test(value));
  const cause = identifier && identifier !== safe.code ? { cause: identifier } : {};
  const chain = causeCodes(error);
  console.error(`${logTag} run failed:`, { runId: run.input.runId, round: run.rounds, ...safe, ...cause, ...(chain ? { chain } : {}), ...(stage ? { stage } : {}) });
  return safe;
}
function toAssistantMessage(response: ChatResponse): ChatMessage {
  return response.assistantMessage ?? { role: "assistant", content: response.text,
    ...(response.toolCalls?.length ? { toolCalls: response.toolCalls } : {}) };
}
function deepClone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
