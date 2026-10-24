import { getStorageContext } from "../storage-context";
import { createHash, randomUUID } from "node:crypto";
import { createBackgroundMemoryIngressIssuer, type BackgroundMemoryPreparedRun } from "../memory-context/background-memory-ingress";
import type { MainMemoryRun } from "../memory-context/main-memory-runtime";
import { getHarnessRunStore, type HarnessRunStore } from "./harness/run-store";
import type { TranscriptSink } from "./transcript-sink";
import { DEFAULT_HARNESS_CONFIG } from "./harness/types";
import type { TaskSession, TaskDelegationPresentation, TaskTranscriptMessage } from "../../shared/task-session";
import type { TaskSessionStore } from "../tasks/task-session-store";
import type { TaskCharacterLease } from "../tasks/task-character-pool";
import type { ChildSessionResult, ChildSessionParent, DelegationScope } from "./child-session-types";
import type { ToolDefinition } from "./tools/registry/tool-registry";
import type { ToolContext } from "./tools/registry/tool-context";
import type { HarnessConfig, HarnessResult } from "./harness/types";
import type { ChatMessage } from "./vendors/types";
import { runFireflyHarness } from "./harness/firefly-harness";
import { projectTaskTraceEvent } from "./task-events";
import { createTaskTraceBuffer } from "./task-trace-buffer";
import { settleChildExecution } from "./child-run-lifecycle";
import type { TaskWriteEvidence, ModelExecutionEvent } from "../../shared/agent-execution-evidence";
import type { PromptLayers } from "./prompt-layers";
import { runAsSubagent } from "../usage-attribution";

export function buildChildPromptLayers(parent: ChildSessionParent, profilePrompt: string): PromptLayers {
  const workspace = parent.resolvedWorkspaceRoot
    ? `可信工作目录：${parent.resolvedWorkspaceRoot}`
    : "当前没有绑定工作目录。";
  return {
    stablePrefix: profilePrompt,
    sessionPrefix: `${workspace}\n会话模式：${parent.mode}`,
    mode: parent.mode,
  };
}

/** Runs a child session; its model requests count under the sub-agent feature of the parent conversation. */
export function runChildSession(input: Parameters<typeof runChildSessionInner>[0]): Promise<ChildSessionResult> {
  return runAsSubagent(() => runChildSessionInner(input));
}

async function runChildSessionInner(input: {
  parent: ChildSessionParent;
  store: TaskSessionStore;
  session: TaskSession;
  prompt: string;
  description: string;
  systemPrompt: string;
  tools: ToolDefinition[];
  config: Partial<HarnessConfig>;
  lease: TaskCharacterLease | null;
  delegationScope?: DelegationScope;
  recoverRunId?: string;
  runHarness?: typeof runFireflyHarness;
  runStore?: HarnessRunStore;
  onLifecycle?: (event: TaskDelegationPresentation) => void;
}): Promise<ChildSessionResult> {
  const { parent, store, session, lease } = input;
  // TaskSession is the durable display/audit trail, including pre-SMH history.
  // Only the current instruction seeds Harness/S; preserve older audit bytes
  // independently instead of replacing them with this run's scoped checkpoint.
  const auditPrefix = parent.backgroundMemory ? structuredClone(session.messages) : undefined;
  const controller = new AbortController();
  const signal = parent.signal ? AbortSignal.any([parent.signal, controller.signal]) : controller.signal;
  const coordinator = parent.executionCoordinator;
  const toolContext: ToolContext = {
    userQuery: input.prompt, conversationId: parent.parentConversationId, runId: session.childRunId,
    ownerSessionId: session.id,
    signal, resolvedWorkspaceRoot: parent.resolvedWorkspaceRoot, mode: parent.mode,
    allowedSkillIds: parent.capabilities?.skillIds, permissionMode: parent.permissionMode,
    fileAccessLevel: parent.fileAccessLevel,
    workReadScopes: parent.workReadScopes,
    revalidateToolPermission: parent.revalidateToolPermission,
    ...(coordinator ? { execution: { coordinator, scope: { workspaceId: coordinator.workspaceId, parentRunId: parent.parentRunId,
      groupId: input.delegationScope?.groupId ?? parent.groupId ?? parent.parentRunId, agentId: session.agent.id, childRunId: session.childRunId,
      toolCallId: input.delegationScope?.toolCallId ?? session.childRunId } } } : {}),
  };
  const presentation = lease ? {
    invocationId: session.childRunId, taskId: session.id, description: input.description,
    nickname: lease.nickname, assetFileName: lease.assetFileName,
  } : null;
  let prepared: BackgroundMemoryPreparedRun | undefined, memoryRun: MainMemoryRun | undefined, sink: TranscriptSink | undefined;
  let runStore: HarnessRunStore | undefined, active = true, executionQuiesced = false;
  const appendWrites = (writes: TaskWriteEvidence[]): void => {
    const current = store.get(session.id);
    if (!current || current.childRunId !== session.childRunId) return;
    store.checkpoint(session.id, { writes: [...(current.writes ?? []).filter(write => write.childRunId !== session.childRunId), ...writes] });
  };
  const appendExecutionEvent = (event: ModelExecutionEvent): void => {
    if (event.childRunId !== session.childRunId || event.parentRunId !== parent.parentRunId || event.agentId !== session.agent.id) return;
    const current = store.get(session.id);
    if (current?.childRunId === session.childRunId) store.checkpoint(session.id, { executionEvents: [...current.executionEvents ?? [], event] });
  };
  const traceBuffer = createTaskTraceBuffer(store, session.id);
  // Trace is observation data: a failure while saving it at the end must not replace the run result.
  const flushTrace = (): void => { try { traceBuffer.flush(); } catch { /* keep the run outcome */ } };
  const unsubscribeWrites = coordinator?.onChildWrites(session.childRunId, appendWrites);
  const unsubscribeConflict = coordinator?.onChildTerminated(session.childRunId, error => controller.abort(error));
  const unsubscribeModel = parent.modelExecutionRecorder?.subscribe(appendExecutionEvent);
  const executionEvidence = () => {
    if (coordinator) appendWrites(coordinator.getChildWrites(session.childRunId));
    const current = store.get(session.id);
    return {
      ...(coordinator ? { writes: (current?.writes ?? []).filter(write => write.childRunId === session.childRunId) } : {}),
      ...(parent.modelExecutionRecorder ? { executionEvents: (current?.executionEvents ?? []).filter(event => event.childRunId === session.childRunId) } : {}),
    };
  };
  const drain = (close: () => Promise<void>) => coordinator
    ? settleChildExecution({ coordinator, childRunId: session.childRunId, close }) : close();
  const closeCanonicalRun = async (interrupted: boolean): Promise<void> => {
    if (interrupted) controller.abort();
    if (interrupted) await sink?.closeInterruption({ reason: "user_cancel", runSession: runStore?.get(session.childRunId) ?? null });
    await sink?.checkpoint();
    // Memory close also drains genuine prepared SDK operations that outlive cancellation.
    await memoryRun?.close(); await prepared?.close();
  };
  const source = {};
  const issuer = createBackgroundMemoryIngressIssuer({ entry: "child", isCurrent: candidate => active && candidate === source });
  try {
    if (input.recoverRunId && !parent.backgroundMemory) store.checkpoint(session.id, { recoveryRunId: null });
    if (parent.backgroundMemory) {
      const ingress = issuer.capture({ source, sessionId: session.id, sourceKey: session.id, instructionText: input.prompt, signal });
      prepared = await parent.backgroundMemory.prepareBackgroundRun({ ingress, modelProfileId: session.agent.savedModelProfileId,
        runId: session.childRunId, userTurnId: `${session.childRunId}-instruction`, assistantTurnId: `${session.childRunId}-assistant`,
        instructionText: input.prompt, signal, ...(input.recoverRunId ? { recoverRunId: input.recoverRunId } : {}), ...(parent.memoryRun ? { readParentGrant: parent.memoryRun } : {}),
        ...(parent.modelExecutionRecorder ? { createModelExecutionObserver: () => parent.modelExecutionRecorder!.observe({
          agentId: session.agent.id, parentRunId: parent.parentRunId, childRunId: session.childRunId, executionId: randomUUID(),
        }) } : {}),
      });
      // A resolved Main host preparation has durably closed this exact prior run.
      if (input.recoverRunId) store.checkpoint(session.id, { recoveryRunId: null });
      memoryRun = await prepared.openMemoryRun({ settings: { ...parent.vendorConfig, contextWindowTokens: input.config.contextWindowTokens ?? DEFAULT_HARNESS_CONFIG.contextWindowTokens },
        messages: [{ role: "user", content: input.prompt }], runId: session.childRunId, conversationId: session.id,
        signal: prepared.signal, transcriptSink: prepared.transcriptSink, toolSystemContent: "", soulSystemBaseContent: input.systemPrompt,
        timeoutMs: input.config.modelRequestTimeoutMs ?? DEFAULT_HARNESS_CONFIG.modelRequestTimeoutMs });
      sink = memoryRun.bindSink(prepared.transcriptSink);
      runStore = input.runStore ?? getHarnessRunStore(getStorageContext().dataRoot);
      const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
      runStore.create({ conversationId: session.id, runId: session.childRunId, messages: [{ role: "user", content: input.prompt }],
        state: { todoItems: session.todoItems, uncertainEffects: session.uncertainEffects ?? [] }, request: {
          provider: parent.vendorConfig.provider, model: parent.vendorConfig.model,
          contextWindowTokens: input.config.contextWindowTokens ?? DEFAULT_HARNESS_CONFIG.contextWindowTokens,
          mode: parent.mode, promptFingerprint: fingerprint(input.systemPrompt), toolSchemaFingerprint: fingerprint(input.tools.map(tool => [tool.id, tool.inputSchema])),
          enabledToolIds: input.tools.map(tool => tool.id).sort(), workspaceRoot: parent.resolvedWorkspaceRoot,
        } });
    }
    if (presentation) input.onLifecycle?.({ ...presentation, status: "running" });
    const promptLayers = buildChildPromptLayers(parent, input.systemPrompt);
    const result = await (input.runHarness ?? runFireflyHarness)({
      runId: session.childRunId, systemPrompt: promptLayers.stablePrefix, promptLayers,
      messages: parent.backgroundMemory ? [{ role: "user", content: input.prompt }] : session.messages as ChatMessage[], tools: input.tools, vendorConfig: parent.vendorConfig,
      config: input.config, initialState: { todoItems: session.todoItems, uncertainEffects: session.uncertainEffects ?? [] },
      quiesceExecution: () => { executionQuiesced = true; controller.abort(); },
      signal: prepared?.signal ?? signal, toolContext: { ...toolContext, signal: prepared?.signal ?? signal }, toolOutputStore: parent.toolOutputStore,
      ...(memoryRun ? { memoryRun, transcriptSink: sink } : {}),
      onToolsPlanned: events => runStore?.recordTools(session.childRunId, events.map(event => ({ toolCallId: event.toolCallId, toolName: event.toolName, sideEffect: event.toolSideEffect, status: event.status }))),
      onToolLifecycle: event => runStore?.recordTool(session.childRunId, { toolCallId: event.toolCallId, toolName: event.toolName, sideEffect: event.toolSideEffect, status: event.status }),
      onCompactionLifecycle: event => runStore?.recordCompaction(session.childRunId, event),
      checkPermission: parent.checkPermission && ((toolId, args, signal, origin) => parent.checkPermission!(
        toolId, args, signal, { ...origin, agentId: session.agent.id, childRunId: session.childRunId },
      )), includeInteractiveTools: parent.includeInteractiveTools,
      allowedBuiltinToolIds: new Set(["update_todo", "read_tool_result"]),
      onEvent: event => {
        const trace = projectTaskTraceEvent(event);
        if (trace) traceBuffer.add(trace);
      },
      onCheckpoint: checkpoint => {
        runStore?.checkpoint(session.childRunId, { messages: checkpoint.messages, state: checkpoint.state, toolOutputs: checkpoint.toolOutputs, rounds: checkpoint.rounds, cache: checkpoint.cache });
        store.checkpoint(session.id, {
          messages: auditPrefix ? [...auditPrefix, ...checkpoint.messages.slice(
            checkpoint.messages[0]?.role === "user" && checkpoint.messages[0]?.content === input.prompt ? 1 : 0,
          )] as TaskTranscriptMessage[] : checkpoint.messages as TaskTranscriptMessage[], todoItems: checkpoint.state.todoItems,
          uncertainEffects: checkpoint.state.uncertainEffects,
        });
      },
    });
    await drain(async () => {
      const mapped = coordinator?.getChildFailure(session.childRunId) ? { status: "failed" as const } : taskStatus(result);
      await closeCanonicalRun(mapped.status !== "completed");
    });
    const failure = coordinator?.getChildFailure(session.childRunId);
    const mapped = failure ? { status: "failed" as const, error: { code: failure.code, message: failure.message } } : taskStatus(result);
    const evidence = executionEvidence();
    runStore?.markTerminal(session.childRunId, mapped.status);
    flushTrace();
    store.checkpoint(session.id, {
      status: mapped.status, resultText: result.finalAnswer, todoItems: result.finalState.todoItems,
      uncertainEffects: result.finalState.uncertainEffects, ...(mapped.error ? { error: mapped.error } : {}), completedAt: Date.now(),
    });
    if (presentation) input.onLifecycle?.({ ...presentation, status: mapped.status });
    return { taskId: session.id, status: mapped.status, text: result.finalAnswer, ...evidence, ...(mapped.error ? { error: mapped.error } : {}) };
  } catch (error) {
    const cancelledBeforeClosure = parent.signal?.aborted || (prepared?.signal ?? signal).aborted && !executionQuiesced;
    await drain(() => closeCanonicalRun(true));
    const failure = coordinator?.getChildFailure(session.childRunId);
    const status = failure ? "failed" : cancelledBeforeClosure ? "cancelled" : "failed";
    const taskError = failure ? { code: failure.code, message: failure.message } : {
      code: status === "cancelled" ? "TASK_CANCELLED" : "TASK_RUNTIME_ERROR", message: error instanceof Error ? error.message : String(error),
    };
    const evidence = executionEvidence();
    if (runStore?.get(session.childRunId)) runStore.markTerminal(session.childRunId, status);
    flushTrace();
    store.checkpoint(session.id, { status, error: taskError, completedAt: Date.now() });
    if (presentation) input.onLifecycle?.({ ...presentation, status });
    return { taskId: session.id, status, text: taskError.message, error: taskError, ...evidence };
  } finally {
    // Even closure/persistence failures cannot release the role before real operations settle.
    try { await coordinator?.whenChildSettled(session.childRunId); await memoryRun?.close(); }
    finally {
      try { await prepared?.close(); }
      finally { active = false; unsubscribeWrites?.(); unsubscribeConflict?.(); unsubscribeModel?.(); lease?.release(); }
    }
  }
}

function taskStatus(result: HarnessResult): { status: "completed" | "cancelled" | "failed"; error?: { code: string; message: string } } {
  const terminal = result.terminal?.status;
  if (terminal === "cancelled" || result.terminateReason === "cancelled") return { status: "cancelled" };
  if (terminal === "timeout" || result.terminateReason === "timeout") {
    return { status: "failed", error: { code: "TASK_TIMEOUT", message: "子任务超过执行时间上限" } };
  }
  if (terminal === "runtime_error" || result.terminateReason === "error") {
    return { status: "failed", error: { code: "TASK_RUNTIME_ERROR", message: result.finalAnswer || "子任务运行失败" } };
  }
  return { status: "completed" };
}
