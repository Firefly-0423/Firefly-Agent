import type { ToolCall, ChatMessage } from "../vendors/types";
import type { ToolCallResult } from "../types";
import { TranscriptWriteError } from "../transcript-sink";
import type { ToolObservation, ToolCallOutcome, SideEffectKind, HarnessToolLifecycleEvent, HarnessToolFinishedEvent } from "./types";
import type { ToolRiskLevel } from "../../permission/permission-policy";
import { parseToolCallArgs, tryParseToolCallArgs, toolCallFingerprint } from "./types";
import { dispatchToolCall, persistToolDispatchResult, type ToolDispatchResult } from "./tool-dispatcher";
import { classifyToolExecutionMode, scheduleToolCalls, type ToolScheduleCommitDecision,
  type ToolCallScheduleResult, type ToolCallExecution } from "./tool-call-scheduler";
import { resolveSideEffect } from "./side-effect-resolver";
import { extractFileChangesFromOutput } from "../tools/registry/tool-evidence";
import { classifyToolResultError } from "./error-classifier";
import { decideRetry, getRetryParams, sleepWithJitter } from "./retry-policy";
import { isToolBreakerTripped, nextToolFailureStreak, toolBreakerMessage } from "./tool-breaker";
import { isCancellationError, raceWithSignal } from "../../utils/abort-utils";
import type { HarnessRun } from "./firefly-harness";
import { extractTaskResult } from "./task-result-evidence";

export type ToolRoundOutcome = "cancelled" | "completed";
type FileReadEvidence = { path: string; canonicalPath: string; sha256: string; startLine: number; endLine: number; totalLines: number };
function toolRiskOf(run: HarnessRun, toolId: string): ToolRiskLevel {
  return run.input.tools.find((entry) => entry.id === toolId)?.risk ?? "safe";
}
function notifyToolFinished(run: HarnessRun, call: Pick<ToolCall, "id" | "name">,
  status: HarnessToolFinishedEvent["status"], startedAt?: number): void {
  run.input.onToolFinished?.({ toolId: call.name, toolCallId: call.id,
    runId: run.input.runId ?? run.input.toolContext?.runId ?? "", status, risk: toolRiskOf(run, call.name),
    ...(startedAt !== undefined ? { durationMs: Math.max(0, Date.now() - startedAt) } : {}) });
}
function resolveCallSideEffect(run: HarnessRun, call: ToolCall): SideEffectKind {
  const parsed = tryParseToolCallArgs(call);
  if (parsed === undefined) return "non_idempotent_side_effect";
  return resolveSideEffect(run.input.tools.find((entry) => entry.id === call.name), parsed);
}
export async function runToolRound(run: HarnessRun, toolCalls: ToolCall[]): Promise<ToolRoundOutcome> {
  const host = run.input;
  const declarations: (HarnessToolLifecycleEvent & { status: "planned" })[] = toolCalls.map((call) => {
    let effect: SideEffectKind = "non_idempotent_side_effect";
    try { effect = resolveSideEffect(host.tools.find((entry) => entry.id === call.name), parseToolCallArgs(call)); }
    catch { /* 参数或分类器不可用时采用保守类别。 */ }
    return { toolCallId: call.id, toolName: call.name, toolSideEffect: effect, status: "planned" };
  });
  if (host.onToolsPlanned) host.onToolsPlanned(declarations);
  else for (const declaration of declarations) host.onToolLifecycle?.(declaration);
  const interactive = host.includeInteractiveTools === false ? new Set<string>() : new Set(["ask_user", "confirm_uncertain_effect"]);
  const asks = toolCalls.filter((call) => interactive.has(call.name));
  const ordinary = toolCalls.filter((call) => !interactive.has(call.name));
  if (asks.length > 0) {
    host.onEvent?.({ type: "candidate_text_discard", roundId: `round-${run.rounds}` });
    try { await runAskUserRound(run, asks, ordinary); }
    catch (cause) { if (isCancellationError(cause, host.signal)) return "cancelled"; throw cause; }
    run.streamController.discardProgressBuffer();
    return "completed";
  }
  const buffered = run.streamController.flushProgressBufferAsProgress();
  if (buffered) host.onEvent?.({ type: "progress_text", content: buffered });
  let scheduled: ToolCallScheduleResult;
  try {
    scheduled = await scheduleToolCalls({
      calls: ordinary, maxParallel: run.config.maxParallelToolCalls, signal: host.signal,
      onFailure: (cause) => { run.toolExecutionFailure ??= { error: cause }; host.quiesceExecution?.(); },
      classify: (call) => {
        const mode = classifyToolExecutionMode(call, host.tools);
        return mode === "delegation" && !host.toolContext?.execution ? "exclusive" : mode;
      },
      execute: (invocation) => executeToolCallWithRetry(run, invocation),
      closeGroup: (group) => host.toolContext?.execution?.coordinator.closeGroup(group) ?? Promise.resolve(),
      commit: ({ call }, result) => commitToolResult(run, call, result),
      notExecuted: async ({ call }, reason): Promise<ToolDispatchResult> => reason === "execution_error"
        ? { outcome: "failure", category: "fatal", tool: call.name, message: "工具执行异常，结果不可用（execution error）" }
        : { outcome: "not_executed", category: "runtime_safety", tool: call.name, message: reason },
    });
  } catch (cause) {
    if (!run.toolExecutionFailure && isCancellationError(cause, host.signal)) return "cancelled";
    throw cause;
  }
  return scheduled.cancelled || host.signal?.aborted ? "cancelled" : "completed";
}
function requireAssistantEntryId(run: HarnessRun): string {
  if (!run.currentAssistantEntryId) throw new Error("TRANSCRIPT_ASSISTANT_ENTRY_MISSING");
  return run.currentAssistantEntryId;
}
function preserveUncertainEffectIfNeeded(run: HarnessRun, call: ToolCall, toolSideEffect?: SideEffectKind): void {
  if (toolSideEffect !== "non_idempotent_side_effect") return;
  const id = `${run.input.runId ?? run.input.toolContext?.runId ?? "unknown-run"}:${call.id}`;
  if (run.state.uncertainEffects.some((entry) => entry.id === id)) return;
  const parsed = tryParseToolCallArgs(call);
  run.state.uncertainEffects.push({ id, toolCallId: call.id, fingerprint: toolCallFingerprint(call.name, parsed ?? {}),
    ...(parsed === undefined ? { argumentsUnavailable: true as const } : {}), toolName: call.name, message: "工具已执行，但结果持久化失败，效果状态未知" });
}
async function commitToolResultMessage(run: HarnessRun, input: {
  call: ToolCall; message: ChatMessage; outcome: ToolCallOutcome; fullRef?: string; fileRead?: FileReadEvidence;
  roundId: string; toolSideEffect?: SideEffectKind;
}): Promise<void> {
  run.messages.push(input.message);
  try {
    await run.input.transcriptSink?.appendToolResult({ assistantEntryId: requireAssistantEntryId(run), message: input.message,
      outcome: input.outcome, ...(input.fullRef ? { fullRef: input.fullRef } : {}), ...(input.fileRead ? { fileRead: input.fileRead } : {}), roundId: input.roundId });
    run.checkpoint();
    if (run.checkpointFailure) throw new Error(`执行状态保存失败：${run.checkpointFailure}`);
  } catch (cause) {
    preserveUncertainEffectIfNeeded(run, input.call, input.toolSideEffect);
    throw new TranscriptWriteError("tool_result", cause);
  }
}
async function runAskUserRound(run: HarnessRun, askCalls: ToolCall[], otherCalls: ToolCall[]): Promise<void> {
  const host = run.input;
  const selected = askCalls[0];
  for (const call of askCalls.slice(1)) {
    const paired = toolResultMessage(call, { outcome: "not_executed", reason: "not_executed_due_to_another_ask" });
    await commitToolResultMessage(run, { call, message: paired, outcome: "not_executed", roundId: `round-${run.rounds}` });
    host.onToolLifecycle?.({ toolCallId: call.id, toolName: call.name, toolSideEffect: "read_only", status: "not_executed" });
    notifyToolFinished(run, call, "not_executed");
  }
  for (const call of otherCalls) {
    const paired = toolResultMessage(call, { outcome: "not_executed", reason: "not_executed_due_to_clarification" });
    await commitToolResultMessage(run, { call, message: paired, outcome: "not_executed", roundId: `round-${run.rounds}` });
    host.onToolLifecycle?.({ toolCallId: call.id, toolName: call.name, toolSideEffect: resolveCallSideEffect(run, call), status: "not_executed" });
    notifyToolFinished(run, call, "not_executed");
  }
  const parsed = tryParseToolCallArgs(selected);
  let began: number | undefined;
  let observed: ToolDispatchResult;
  if (parsed === undefined) observed = await dispatchToolCall(selected, run.askDispatchContext);
  else {
    host.onEvent?.({ type: "tool_start", toolCallId: selected.id, toolName: selected.name, args: parsed });
    run.clock.startUserWait();
    host.onToolLifecycle?.({ toolCallId: selected.id, toolName: selected.name, toolSideEffect: "read_only", status: "started" });
    began = Date.now();
    try { observed = await raceWithSignal(dispatchToolCall(selected, run.askDispatchContext), host.signal); }
    finally { run.clock.stopUserWait(); }
  }
  host.onEvent?.({ type: "tool_end", toolCallId: selected.id, outcome: observed.outcome === "success" ? "success" : "failure", preview: observed.message.slice(0, 200) });
  const paired = toolResultMessage(selected, observed);
  await commitToolResultMessage(run, { call: selected, message: paired, outcome: observed.outcome, roundId: `round-${run.rounds}` });
  host.onToolLifecycle?.({ toolCallId: selected.id, toolName: selected.name, toolSideEffect: "read_only",
    status: observed.outcome === "unknown" ? "unknown" : observed.outcome === "not_executed" ? "not_executed" : "committed" });
  notifyToolFinished(run, selected, observed.outcome, began);
}
async function executeToolCallWithRetry(run: HarnessRun, execution: ToolCallExecution): Promise<ToolDispatchResult> {
  const invocation = execution.call;
  if (tryParseToolCallArgs(invocation) === undefined) return dispatchToolCall(invocation, run.toolDispatchContext);
  const failures = run.state.toolFailureStreaks?.[invocation.name];
  if (isToolBreakerTripped(failures)) return { outcome: "not_executed", category: "runtime_safety", tool: invocation.name, message: toolBreakerMessage(invocation.name, failures ?? 0) };
  const host = run.input;
  const effect = resolveCallSideEffect(run, invocation);
  const context = { ...run.toolDispatchContext, delegationScope: execution.delegationScope,
    checkPermission: run.toolDispatchContext.checkPermission ? (toolId: string, args: Record<string, unknown>) => raceWithSignal(
      run.toolDispatchContext.checkPermission!(toolId, args, host.signal, { toolCallId: invocation.id }), host.signal) : undefined,
    onExecutionStarted: () => {
      if (run.toolCallStartedAt.has(invocation.id)) return;
      host.onToolLifecycle?.({ toolCallId: invocation.id, toolName: invocation.name, toolSideEffect: effect, status: "started" });
      run.toolCallStartedAt.set(invocation.id, Date.now());
    },
  };
  const invoke = async (): Promise<ToolDispatchResult> => {
    try { return await dispatchToolCall(invocation, context); }
    catch (cause) {
      if (isCancellationError(cause, host.signal) && !run.toolCallStartedAt.has(invocation.id)) return {
        outcome: "not_executed", category: "runtime_safety", tool: invocation.name, message: "aborted_before_dispatch",
      };
      throw cause;
    }
  };
  let observed = await invoke();
  let remainingLimit = Number.POSITIVE_INFINITY;
  for (let attempt = 0; !host.signal?.aborted && observed.outcome === "failure"; attempt++) {
    if (observed.retryDecision === "no_retry") break;
    const category = observed.category ?? classifyToolResultError(observed.rawResult
      ?? { toolId: invocation.name, args: {}, output: "", status: "failed" } as ToolCallResult);
    if (decideRetry(category, effect) !== "retry") break;
    const policy = getRetryParams(category);
    remainingLimit = Math.min(remainingLimit, policy.maxRetries);
    if (attempt >= remainingLimit) break;
    await sleepWithJitter(policy.backoffMs[attempt] ?? 1000, host.signal);
    if (host.signal?.aborted) break;
    observed = await invoke();
  }
  return persistToolDispatchResult(invocation, observed, run.toolDispatchContext);
}
function readFileEvidence(call: ToolCall, result: ToolDispatchResult): FileReadEvidence | undefined {
  if (call.name !== "read_file" || result.outcome !== "success" || typeof result.output !== "string") return undefined;
  try {
    const data = JSON.parse(result.output) as Record<string, unknown>;
    if (data.success !== false && data.truncated === false && typeof data.path === "string"
      && typeof data.canonicalPath === "string" && typeof data.sha256 === "string"
      && Number.isInteger(data.startLine) && Number.isInteger(data.endLine) && Number.isInteger(data.totalLines)) return {
      path: data.path, canonicalPath: data.canonicalPath, sha256: data.sha256,
      startLine: data.startLine as number, endLine: data.endLine as number, totalLines: data.totalLines as number,
    };
  } catch { return undefined; }
  return undefined;
}
async function commitToolResult(run: HarnessRun, call: ToolCall, result: ToolDispatchResult): Promise<ToolScheduleCommitDecision> {
  const host = run.input;
  const effect = result.toolSideEffect ?? resolveCallSideEffect(run, call);
  const counters = (run.state.toolFailureStreaks ??= {});
  const failures = nextToolFailureStreak(counters[call.name], result.outcome);
  if (failures > 0) counters[call.name] = failures;
  else delete counters[call.name];
  if (result.toolOutputRef && !run.toolOutputs.some((entry) => entry.recordId === result.toolOutputRef?.recordId)) run.toolOutputs.push(result.toolOutputRef);
  host.onEvent?.({ type: "tool_end", toolCallId: call.id, outcome: result.outcome, preview: (result.preview ?? result.message).slice(0, 200),
    changes: extractFileChangesFromOutput(result.output), taskResult: extractTaskResult(call.name, result.output, host.toolContext?.execution?.scope.parentRunId ?? host.runId) });
  const paired = toolResultMessage(call, result);
  const fileRead = readFileEvidence(call, result);
  await commitToolResultMessage(run, { call, message: paired, outcome: result.outcome,
    ...(result.fullOutputRef ? { fullRef: result.fullOutputRef } : {}), ...(fileRead ? { fileRead } : {}), roundId: `round-${run.rounds}`, toolSideEffect: effect });
  host.onToolLifecycle?.({ toolCallId: call.id, toolName: call.name, toolSideEffect: effect,
    status: result.outcome === "unknown" ? "unknown" : result.outcome === "not_executed" ? "not_executed" : "committed" });
  const began = run.toolCallStartedAt.get(call.id);
  run.toolCallStartedAt.delete(call.id);
  notifyToolFinished(run, call, result.outcome, began);
  if (result.outcome === "unknown" && effect === "non_idempotent_side_effect") {
    const parsed = tryParseToolCallArgs(call);
    const identity = toolCallFingerprint(call.name, parsed ?? {});
    const id = `${host.toolContext?.runId ?? "unknown-run"}:${call.id}`;
    if (!run.state.uncertainEffects.some((entry) => entry.id === id)) run.state.uncertainEffects.push({
      id, toolCallId: call.id, fingerprint: identity, ...(parsed === undefined ? { argumentsUnavailable: true as const } : {}),
      toolName: call.name, message: "副作用已发起，但 Runtime 无法确认是否生效",
    });
    return "halt";
  }
  return result.category === "fatal" ? "halt" : "continue";
}
/** 交互工具的结果是用户本人经由宿主回答的内容，不属于外部不可信数据。 */
const USER_RESPONSE_TOOLS: ReadonlySet<string> = new Set(["ask_user", "confirm_uncertain_effect"]);

/** 只有交互工具成功拿到的回答才算用户本人的话；失败、超时、未执行等宿主状态文本不是。 */
export function contentTrustFor(toolName: string, outcome?: unknown): "user_response" | "untrusted_tool_result" {
  return USER_RESPONSE_TOOLS.has(toolName) && outcome === "success" ? "user_response" : "untrusted_tool_result";
}

function toolResultMessage(call: ToolCall, observation: ToolObservation | { outcome: string; reason: string }): ChatMessage {
  const visible = { ...observation } as Record<string, unknown>;
  if (visible.truncated === true) visible.output = visible.preview ?? visible.message;
  delete visible.rawResult;
  delete visible.toolOutputRef;
  // Set the host-owned label after copying so external content cannot forge it.
  visible.contentTrust = contentTrustFor(call.name, visible.outcome);
  return { role: "tool", toolCallId: call.id, name: call.name, content: JSON.stringify(visible) };
}
