import { promptTokensOf } from "../context-usage";
import type { ToolSpec, ChatResponse, ChatMessage } from "../vendors/types";
import { causeCodes } from "../vendors/error-chain";
import type { RunAdjustmentMessage, HarnessResult, HarnessInput, HarnessConfig, HarnessCacheState, AgentState } from "./types";
import type { ToolOutputRef } from "./tool-output/tool-output-store";
import { INITIAL_HARNESS_CACHE_STATE, DEFAULT_HARNESS_CONFIG } from "./types";
import { getHarnessBuiltinToolSpecs } from "./builtin-tools";
import type { ToolDispatchContext } from "./tool-dispatcher";
import { computeTokenBudget, compressForAgentLoop, type TokenBudget } from "./compaction";
import { emitContextUsage, emitCacheDiagnostic } from "./harness-observability";
import { StreamController } from "./stream-controller";
import { TimeoutClock } from "./timeout-clock";
import { buildCurrentTodoNotebookContext } from "./todo-working-notebook";
import { appendInternalTranscriptMessage, createInternalTranscriptMessage } from "./internal-transcript";
import { callLLM, summarizeHistory } from "./harness-llm";
import { ChatTimeStreamPrefixFilter } from "../../chat/chat-time-stream-filter";
import { runToolRound, type ToolRoundOutcome } from "./tool-round";
import { publicRunFailure, type RunFailure, type RunFailureSource } from "../../../shared/run-failure";
import { ContextError } from "../../memory-context/context-contracts";
import { buildStableSystemPrefix, type PromptLayers } from "../prompt-layers";

const logTag = "[FireflyHarness]";
export type HarnessRun = {
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
  cache: HarnessCacheState;
  toolOutputs: ToolOutputRef[];
  messages: ChatMessage[];
  allToolSpecs: ToolSpec[];
  streamController: StreamController;
  clock: TimeoutClock;
  state: AgentState;
  config: HarnessConfig;
  input: HarnessInput;
};

export async function runFireflyHarness(input: HarnessInput): Promise<HarnessResult> {
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
    const terminal = await runHarnessLoop(current);
    returned = true;
    return terminal;
  } finally {
    current.clock.setDeadlineHandler(null);
    try { if (!returned) input.quiesceExecution?.(); }
    finally { await drainRunExecution(current); }
  }
}
function failedStage(run: HarnessRun, cause: unknown, source: RunFailureSource, prefix = ""): Promise<HarnessResult> {
  const publicFailure = recordFailure(run, cause, source, prefix);
  return finishRun(run, prefix + publicFailure.code, true, "error");
}
function checkpointFailed(run: HarnessRun): Promise<HarnessResult> {
  return finishRun(run, `执行状态保存失败：${run.checkpointFailure}`, true, "error");
}
async function runHarnessLoop(run: HarnessRun): Promise<HarnessResult> {
  const host = run.input;
  while (!run.clock.isExecutionTimeout()) {
    if (run.checkpointFailure) return checkpointFailed(run);
    if (host.signal?.aborted) return abortedResult(run);
    if (run.config.maxRounds > 0 && run.rounds >= run.config.maxRounds) {
      const reply = run.streamController.getBuffered() || buildMaxRoundsReply(run.state, run.config.maxRounds);
      host.onEvent?.({ type: "final_answer", content: reply });
      return finishRun(run, reply, true, "max_rounds");
    }
    const poll = host.pollRunAdjustments?.();
    if (poll) {
      let queued: RunAdjustmentMessage[];
      try { queued = await poll; }
      catch (cause) { return failedStage(run, cause, "runtime", "插话提交失败："); }
      if (queued.length > 0) {
        for (const entry of queued) run.messages.push({ role: "user", content: entry.rawContent });
        checkpoint(run);
        if (run.checkpointFailure) return checkpointFailed(run);
      }
    }
    const layers = buildRoundPromptLayers(host);
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
    let finalPoll: RunAdjustmentMessage[];
    try { finalPoll = await host.pollRunAdjustments?.() ?? []; }
    catch (cause) { return failedStage(run, cause, "runtime", "插话提交失败："); }
    if (finalPoll.length > 0) {
      const intermediate = run.streamController.commitProgressBuffer() + suffix;
      host.onEvent?.({ type: "round_end", roundId: round });
      if (intermediate) host.onEvent?.({ type: "progress_text", content: intermediate });
      for (const entry of finalPoll) run.messages.push({ role: "user", content: entry.rawContent });
      run.rounds++;
      checkpoint(run);
      if (run.checkpointFailure) return checkpointFailed(run);
      continue;
    }
    const reply = run.streamController.commitProgressBuffer() + suffix;
    host.onEvent?.({ type: "round_end", roundId: round });
    host.onEvent?.({ type: "final_answer", content: reply });
    return finishRun(run, reply, false, undefined);
  }
  const reply = run.streamController.getBuffered() || buildTimeoutReply(run.state);
  host.onEvent?.({ type: "final_answer", content: reply });
  return finishRun(run, reply, true, "timeout");
}

function createRun(input: HarnessInput): HarnessRun {
  const limits: HarnessConfig = { ...DEFAULT_HARNESS_CONFIG, ...input.config };
  const restored: AgentState = input.initialState ? deepClone(input.initialState) : { todoItems: [], uncertainEffects: [] };
  const registered: ToolSpec[] = input.tools.map((definition) => ({ name: definition.id, description: definition.description,
    parameters: { type: "object" as const, properties: definition.inputSchema.properties, required: definition.inputSchema.required } }));
  const advertised: ToolSpec[] = [...registered, ...getHarnessBuiltinToolSpecs({
    includeInteractive: input.includeInteractiveTools, includeAgent: Boolean(input.agentExecutor), agentDefinitions: input.agentDefinitions, planState: input.planState,
  }).filter((spec) => !input.allowedBuiltinToolIds || input.allowedBuiltinToolIds.has(spec.name))];
  const interactive: ToolDispatchContext = { state: restored, tools: input.tools, onEvent: input.onEvent,
    requestUserClarification: input.requestUserClarification, includeInteractiveTools: input.includeInteractiveTools,
    allowedBuiltinToolIds: input.allowedBuiltinToolIds, toolOutputStore: input.toolOutputStore,
    toolContext: { userQuery: input.toolContext?.userQuery ?? "", ...input.toolContext, signal: input.signal } };
  return {
    input, config: limits, state: restored, clock: new TimeoutClock(limits.totalTimeoutMs, limits.userWaitTimeoutMs),
    streamController: new StreamController(), allToolSpecs: advertised, messages: [...input.messages], toolOutputs: [],
    cache: input.initialCache ? { ...input.initialCache } : { ...INITIAL_HARNESS_CACHE_STATE }, rounds: 0,
    checkpoint() { checkpoint(this); }, askDispatchContext: interactive,
    toolDispatchContext: { ...interactive, checkPermission: input.checkPermission, toolContext: input.toolContext,
      executionLedger: input.executionLedger, agentExecutor: input.agentExecutor, deferOutputPersistence: true }, toolCallStartedAt: new Map(),
  };
}
function materializeInitialContext(run: HarnessRun): void {
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
function buildRoundPromptLayers(input: HarnessInput): PromptLayers {
  return { stablePrefix: input.promptLayers?.stablePrefix ?? input.systemPrompt,
    ...(input.promptLayers?.sessionPrefix ? { sessionPrefix: input.promptLayers.sessionPrefix } : {}),
    ...(input.promptLayers?.mode ? { mode: input.promptLayers.mode } : {}) };
}
function compactIfNeeded(run: HarnessRun, promptLayers: PromptLayers): Promise<void> | undefined {
  if (run.input.memoryRun) return undefined;
  const limits = run.config;
  const system = buildStableSystemPrefix(promptLayers);
  const budget = computeTokenBudget(system, run.allToolSpecs, run.messages, limits.contextWindowTokens,
    limits.reservedOutputTokens, limits.safetyMarginTokens, limits.compactionThreshold);
  return budget.needsCompaction ? runCompaction(run, system, budget) : undefined;
}
async function runCompaction(run: HarnessRun, roundSystemPrompt: string, budget: TokenBudget): Promise<void> {
  const host = run.input;
  const limits = run.config;
  console.log(`${logTag} mid-loop compaction triggered (estimated=${budget.estimatedInput} budget=${budget.usableInputBudget})`);
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
async function callRoundLLM(run: HarnessRun, promptLayers: PromptLayers, roundId: string): Promise<ChatResponse> {
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

function checkpoint(run: HarnessRun): void {
  try { run.input.onCheckpoint?.({ messages: run.messages, state: run.state, toolOutputs: run.toolOutputs,
    rounds: run.rounds, cache: { ...run.cache }, at: Date.now() }); }
  catch (cause) {
    const safe = publicRunFailure(cause);
    run.failure ??= safe;
    run.checkpointFailure = safe.code;
    console.error(`${logTag} checkpoint failed:`, { runId: run.input.runId, round: run.rounds, ...safe });
  }
}
function drainRunExecution(run: HarnessRun): Promise<void> {
  if (run.executionSettlement) return run.executionSettlement;
  const owner = run.input.toolContext?.execution;
  run.executionSettlement = owner ? owner.scope.childRunId === owner.scope.parentRunId
    ? owner.coordinator.closeGroup(owner.scope.groupId) : owner.coordinator.whenChildSettled(owner.scope.childRunId) : Promise.resolve();
  return run.executionSettlement;
}
async function settleRun(run: HarnessRun): Promise<void> {
  await drainRunExecution(run);
  run.clock.stopActive();
  emitContextUsage(run, "terminal");
  checkpoint(run);
}
function abortedResult(run: HarnessRun): Promise<HarnessResult> {
  if (!run.deadlineExceeded) return cancelledResult(run);
  const reply = run.streamController.getBuffered() || buildTimeoutReply(run.state);
  run.input.onEvent?.({ type: "final_answer", content: reply });
  return finishRun(run, reply, true, "timeout");
}
async function cancelledResult(run: HarnessRun): Promise<HarnessResult> {
  run.input.quiesceExecution?.();
  await settleRun(run);
  if (run.checkpointFailure) return buildResult(`执行状态保存失败：${run.checkpointFailure}`, run.state, true, "error", run.rounds, run.failure);
  return { finalAnswer: "", finalState: run.state, terminated: true, terminateReason: "cancelled",
    terminal: { status: "cancelled", reason: "user_cancelled", externalEffectsMayContinue: true }, rounds: run.rounds };
}
async function finishRun(run: HarnessRun, finalAnswer: string, terminated: boolean,
  terminateReason: HarnessResult["terminateReason"]): Promise<HarnessResult> {
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
  terminateReason: HarnessResult["terminateReason"], rounds: number, failure?: RunFailure): HarnessResult {
  return { finalAnswer, finalState: state, terminated, terminateReason, rounds, ...(failure ? { failure } : {}) };
}
function recordFailure(run: HarnessRun, error: unknown, source: RunFailureSource, stage = ""): RunFailure {
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
