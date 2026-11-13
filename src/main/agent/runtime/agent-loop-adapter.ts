import type { BaseEvent } from "@ag-ui/core";
import { runAgentLoop } from "../loop";
import type { AgentLoopEvent, AgentLoopInput } from "../loop";
import type { RunResult, FireflyRunOptions, RunModelSettings } from "./firefly-agent";
import type { ToolCallResult } from "../../tooling/registry/tool-call-types";
import { mapTerminateReason, mapTerminateReasonToTerminal } from "./adapter/terminal-mapper";
import { app } from "electron";
import { getRunReviewTracker } from "../review/run-review-tracker";
import type { ReviewRunStatus } from "../../../shared/review-types";
import { sendAgentLoopEventAsAgui } from "./adapter/event-mapper";
import { completePlanRun } from "./adapter/plan-lifecycle";
import { prepareAgentLoopRun } from "./adapter/run-preparation";
import { prepareToolRuntime } from "./adapter/tool-runtime";
export { mapTerminateReasonToTerminal } from "./adapter/terminal-mapper";
export { buildAgentLoopPromptLayers, buildAgentLoopSystemPrompt, materializeAgentLoopStartTranscript } from "./adapter/prompt-builder";
export { sendAgentLoopEventAsAgui, sendTaskLifecycleAsAgui } from "./adapter/event-mapper";
export { filterToolsForConversationMode } from "./adapter/run-preparation";

export async function runAgentLoopWithAdapter(options: FireflyRunOptions, signal: AbortSignal, sendBaseEvent: (event: BaseEvent) => void): Promise<RunResult> {
  if (options.memoryRun && options.transcriptSink) options = { ...options, transcriptSink: options.memoryRun.bindSink(options.transcriptSink) };
  const preparation = await prepareAgentLoopRun(options, signal);
  const { messageId: message, runId: run, threadId: thread, planState: plan, vendorConfig: vendor, tools: enabled, runStore: journal,
    recovered: resume, promptLayers: layers, agentLoopPromptLayers: requestLayers, systemPrompt: prefix, runMessages: history } = preparation;
  const runtime = prepareToolRuntime({ options, signal, prepared: preparation, sendBaseEvent });
  const { toolContext: context, checkPermission: permission, toolOutputStore: outputStore, agentExecutor: executeAgent, agentDefinitions: agents } = runtime;
  const invocation: AgentLoopInput = {
    systemPrompt: prefix,
    promptLayers: requestLayers,
    usageParts: layers.usageParts,
    messages: history,
    runId: run,
    ...(resume ? { initialState: resume.state } : {}),
    ...(resume ? { initialCache: resume.cache } : {}),
    tools: enabled,
    vendorConfig: vendor,
    config: {
      ...(options.maxParallelToolCalls !== undefined ? { maxParallelToolCalls: options.maxParallelToolCalls } : {}),
      ...(options.maxToolRounds !== undefined ? { maxRounds: options.maxToolRounds } : {}),
      ...(options.runTimeoutMs !== undefined ? { totalTimeoutMs: options.runTimeoutMs } : {}),
      contextWindowTokens: options.settings.contextWindowTokens,
    },
    signal: runtime.signal,
    quiesceExecution: runtime.quiesceExecution,
    onEvent: (event: AgentLoopEvent) => { if (!signal.aborted) sendAgentLoopEventAsAgui(event, message, thread, run, sendBaseEvent); },
    onCheckpoint: (checkpoint) => { journal.checkpoint(run, {
      messages: checkpoint.messages, state: checkpoint.state, toolOutputs: checkpoint.toolOutputs, rounds: checkpoint.rounds, cache: checkpoint.cache,
    }); },
    onToolsPlanned: (events) => { journal.recordTools(run, events.map((event) => ({ toolCallId: event.toolCallId, toolName: event.toolName, sideEffect: event.toolSideEffect, status: event.status }))); },
    onToolLifecycle: (event) => { journal.recordTool(run, { toolCallId: event.toolCallId, toolName: event.toolName, sideEffect: event.toolSideEffect, status: event.status }); },
    onCompactionLifecycle: (event) => journal.recordCompaction(run, event),
    ...(options.onToolFinished ? { onToolFinished: options.onToolFinished } : {}),
    ...(options.pollRunAdjustments ? { pollRunAdjustments: options.pollRunAdjustments } : {}),
    requestUserClarification: options.requestUserClarification ? (card) => options.requestUserClarification!(card as never, runtime.signal) : undefined,
    includeInteractiveTools: options.interactiveTools,
    planState: plan,
    toolContext: context,
    toolOutputStore: outputStore,
    executionLedger: options.executionLedger,
    checkPermission: permission,
    agentExecutor: executeAgent,
    agentDefinitions: agents,
    ...(options.transcriptSink ? { transcriptSink: options.transcriptSink } : {}),
    ...(options.memoryRun ? { memoryRun: options.memoryRun } : {}),
  };
  const completed = await runAgentLoop(invocation);
  const completionReason = mapTerminateReason(completed.terminateReason);
  const unresolved = completed.finalState.uncertainEffects.length > 0;
  let terminal = completed.terminal ?? mapTerminateReasonToTerminal(completed.terminateReason, unresolved, completed.failure);
  let status: "completed" | "cancelled" | "failed" = terminal.status === "success" ? "completed" : terminal.status === "cancelled" ? "cancelled" : "failed";
  if (terminal.status === "cancelled" || completed.terminateReason === "cancelled") {
    try { await options.transcriptSink?.closeInterruption({ reason: "user_cancel", runSession: journal.get(run) }); }
    catch (failure) {
      console.error("[AgentLoopAdapter] transcript interruption closure failed:", failure);
      terminal = { status: "runtime_error", reason: "transcript_interruption_closure_failed", externalEffectsMayContinue: true };
      status = "failed";
    }
  }
  const session = journal.markTerminal(run, status);
  try {
    const review = getRunReviewTracker(app.getPath("userData"));
    const reviewStatus: ReviewRunStatus = status;
    review.finalizeReview(run, session.createdAt, reviewStatus);
  } catch (failure) { console.error("[AgentLoopAdapter] finalizeReview failed:", failure); }
  completePlanRun({ mode: options.conversationMode, threadId: thread, runId: run, runStatus: status, planState: plan, signal, send: sendBaseEvent });
  const toolResults: ToolCallResult[] = [];
  console.log(`[AgentLoopAdapter] harness run complete, rounds=${completed.rounds} terminated=${completed.terminated} terminal=${terminal.status}`);
  try { await options.transcriptSink?.checkpoint(); }
  catch (failure) { console.error("[ConversationTranscriptStore] snapshot checkpoint failed:", failure); }
  return { reply: completed.finalAnswer, toolResults, completionReason, terminal, totalUsage: undefined };
}
