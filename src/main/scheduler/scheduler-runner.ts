import { createHash } from "node:crypto";
import type { RunFinishedEvent } from "@ag-ui/core";
import { createBackgroundMemoryIngressIssuer, type BackgroundMemoryHost, type BackgroundMemoryPreparedRun } from "../memory-context/background-memory-ingress";
import type { WebContents } from "electron";
import { IPC } from "../../shared/ipc-channels";
import type { FireflyRunTerminalResult } from "../../shared/run-terminal";
import type { PluginPromptMode, PluginTurnStatus } from "../../plugins/api";
import { AgentRuntimeError } from "../orchestrator/agent-runtime-error";
import { FireflyAgent, type FireflyRunOptions } from "../orchestrator/firefly-agent";
import type { LifecyclePublisher } from "../plugin-host/lifecycle-publisher";
import { toolRegistry } from "../orchestrator/tools/registry/tool-registry";
import { toastEvents } from "../toast/toast-events";
import { filterToolsForTask } from "./tool-filter";
import type { ScheduledRunResult, ScheduledTask, ScheduledTaskHistoryEntry } from "./types";

/**
 * 第一期：scheduler 的 buildOptions 返回"传统"形式（包含 system 消息）。
 * FireflyAgent 暂时通过 fallback 兼容：检测 options.messages[0].role === "system" 时，
 * 用它作为 soulSystemBaseContent（重复一次），toolSystemContent 用同一个串（暂时不拆分）。
 *
 * 第二期：scheduler 同步迁移到 tool_system / soul_system 分阶段，buildOptions 改为返回
 * 带 toolSystemContent / soulSystemBaseContent 的 FireflyRunOptions。
 */
type LegacyRunOptions = Omit<FireflyRunOptions, "toolSystemContent" | "soulSystemBaseContent"> & { modelProfileId?: string };

type RunnerDeps = {
  /** 生命周期事件发布器；缺省时不发布（早期装配和纯策略测试会用到）。 */
  publishLifecycle?: LifecyclePublisher;
  now: () => Date;
  id: () => string;
  recordHistory: (entry: ScheduledTaskHistoryEntry) => void;
  getChatWebContents: () => WebContents | null;
  buildOptions: (task: ScheduledTask) => Promise<LegacyRunOptions>;
  memoryHost?: BackgroundMemoryHost;
};

/**
 * 定时任务是无人值守的 Work Harness：不询问、不审批，直接执行已分配工具。
 * 会话模式来自任务冻结的 mode 字段（旧任务默认 work）；执行循环沿用现有
 * 映射：chat 走 chat loop，其余模式走 work harness。
 */
export function applyScheduledExecutionPolicy(options: FireflyRunOptions, mode: PluginPromptMode = "work"): FireflyRunOptions {
  const executionMode = mode === "chat" ? "chat" : "work";
  return { ...options, executionMode, conversationMode: mode, harnessInteractiveTools: false, permissionMode: "allow_all" };
}

export function createSchedulerRunner(deps: RunnerDeps) {
  let closed = false;
  const active = new Map<object, AbortController>();
  const pending = new Set<Promise<ScheduledRunResult>>();
  const issuer = createBackgroundMemoryIngressIssuer({ entry: "scheduler", isCurrent: source => !closed && active.has(source) });
  const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);
  function deliver(action: () => void): void {
    try { action(); }
    catch (error) {
      try { console.error("[SchedulerRunner] notification failed:", error); }
      catch { /* Delivery and logging cannot rewrite the execution outcome. */ }
    }
  }
  function runScheduledTask(task: ScheduledTask, scheduledFireAt: Date, manual: boolean): Promise<ScheduledRunResult> {
    if (closed) return Promise.reject(Error("MEMORY_CONTEXT_RUNTIME_CLOSED"));
    const source = {}, controller = new AbortController(); active.set(source, controller);
    const operation = execute(task, scheduledFireAt, manual, source, controller.signal).finally(() => { active.delete(source); pending.delete(operation); });
    pending.add(operation); return operation;
  }
  async function execute(task: ScheduledTask, _scheduledFireAt: Date, manual: boolean, source: object, signal: AbortSignal): Promise<ScheduledRunResult> {
    const historyId = deps.id();
    const startedAt = deps.now();
    const allTools = toolRegistry.getAllTools();
    const effectiveTools = filterToolsForTask(task, deps.memoryHost ? allTools.filter(tool => !["user_memory", "read_memory", "write_memory", "recall_history"].includes(tool.id)) : allTools);
    const effectiveToolIds = effectiveTools.map(t => t.id);

    const send = (event: unknown): void => {
      deliver(() => {
        const wc = deps.getChatWebContents();
        if (wc && !wc.isDestroyed()) wc.send(IPC.SCHEDULER_EVENT, event);
      });
    };
    let prepared: BackgroundMemoryPreparedRun | undefined;
    let finishedEvent: RunFinishedEvent | undefined;
    let terminalResult: FireflyRunTerminalResult | undefined;
    let status: PluginTurnStatus = "success", reply = "", failure: string | undefined, errorCode: string | undefined;
    let historyWritable = true;
    try {
      try {
        deps.recordHistory({ id: historyId, taskId: task.id, taskTitle: task.title, firedAt: startedAt.toISOString(),
          status: "running", reason: manual ? "manual fireNow" : undefined, effectiveToolIds });
      } catch (error) { historyWritable = false; throw error; }
      send({ type: "CUSTOM", name: "scheduler.started", schedulerRunId: historyId, schedulerTaskId: task.id,
        value: { taskId: task.id, title: task.title, manual, firedAt: startedAt.toISOString(), runId: historyId } });
      // Scheduler turns have no desktop conversation; publish only their real task/run identity.
      deliver(() => deps.publishLifecycle?.publishTurnStarted({ source: "scheduler", runId: historyId,
        mode: task.mode ?? "work", taskId: task.id, schedulerRunId: historyId }));
      const legacyOptions = await deps.buildOptions(task);
      legacyOptions.tools = effectiveTools;

      // 第一期兼容：把 messages 里的 system 消息拆出来，作为 soulSystemBaseContent。
      // toolSystemContent 暂时与它保持同一份内容，留到第二期再分开。
      const systemIndex = legacyOptions.messages.findIndex((m) => m.role === "system");
      const systemMessage = systemIndex >= 0 ? legacyOptions.messages[systemIndex] : undefined;
      const soulSystemBaseContent = systemMessage && typeof systemMessage.content === "string" ? systemMessage.content : "";
      const messages = systemIndex >= 0 ? legacyOptions.messages.filter((_, i) => i !== systemIndex) : legacyOptions.messages;
      const toolSystemContent = soulSystemBaseContent;

      if (deps.memoryHost) {
        if (!legacyOptions.modelProfileId) throw Error("MEMORY_RUN_PROFILE_DENIED");
        const key = createHash("sha256").update(task.id).digest("hex");
        const ingress = issuer.capture({ source, sessionId: `scheduler-${key}`, sourceKey: `scheduler-task-${key}`, instructionText: task.prompt, signal });
        prepared = await deps.memoryHost.prepareBackgroundRun({ ingress, modelProfileId: legacyOptions.modelProfileId,
          runId: historyId, userTurnId: `${historyId}-instruction`, assistantTurnId: `${historyId}-assistant`, instructionText: task.prompt, signal });
      }
      const runSignal = prepared?.signal ?? signal;
      const options = applyScheduledExecutionPolicy({
        ...legacyOptions, messages, toolSystemContent, soulSystemBaseContent, signal: runSignal, runId: historyId,
        ...(prepared ? { conversationId: prepared.sessionId, transcriptSink: prepared.transcriptSink,
          openMemoryRun: prepared.openMemoryRun, backgroundMemory: deps.memoryHost } : {}),
      }, task.mode ?? "work");

      const agent = new FireflyAgent({ threadId: `scheduler-${task.id}`, description: `Scheduled task: ${task.title}` });

      await new Promise<void>((resolve, reject) => {
        const sub = agent.runWithEvents(options).subscribe({
          next: (event) => {
            // The renderer removes its stream at the first terminal. Settle only after cleanup/history.
            if (event.type === "RUN_FINISHED") { finishedEvent = event as RunFinishedEvent; return; }
            send({ ...event, schedulerRunId: historyId, schedulerTaskId: task.id });
          },
          error: (err) => {
            sub.unsubscribe();
            reject(err instanceof Error ? err : Error(String(err)));
          },
          complete: () => {
            sub.unsubscribe();
            resolve(undefined);
          },
        });
      });

      reply = agent.lastResult?.reply ?? "";
      // Normal completion can still represent timeout/cancellation. Keep legacy no-terminal fallback.
      terminalResult = finishedEvent?.result ?? agent.lastResult?.terminal;
      status = terminalResult?.status ?? "success";
      if (status !== "success") failure = `Scheduled run ended with ${status}`;
    } catch (err) {
      status = "runtime_error";
      failure = messageOf(err);
      errorCode = err instanceof AgentRuntimeError ? err.code : undefined;
    } finally {
      try { await prepared?.close(); }
      catch (error) {
        status = "runtime_error";
        failure = [failure, `Cleanup failed; execution may already have taken effect: ${messageOf(error)}`].filter(Boolean).join("; ");
      }
    }

    const finishedAt = deps.now(), durationMs = finishedAt.getTime() - startedAt.getTime();
    if (historyWritable) {
      try {
        deps.recordHistory({ id: historyId, taskId: task.id, taskTitle: task.title, firedAt: startedAt.toISOString(),
          finishedAt: finishedAt.toISOString(), durationMs, status: status === "success" ? "success" : "failed",
          ...(status !== "success" ? { reason: status, errorMessage: failure } : {}), outputPreview: reply.slice(0, 160), effectiveToolIds });
      } catch (error) {
        // A failed writer cannot reliably persist a second failure record either.
        status = "runtime_error";
        failure = [failure, `History write failed; execution may already have taken effect: ${messageOf(error)}`].filter(Boolean).join("; ");
      }
    }
    deliver(() => deps.publishLifecycle?.publishTurnFinished({ source: "scheduler", runId: historyId,
      mode: task.mode ?? "work", taskId: task.id, schedulerRunId: historyId, status, durationMs }));
    deliver(() => deps.publishLifecycle?.publishSchedulerFinished({ taskId: task.id, schedulerRunId: historyId, status, durationMs }));
    if (status === "success") {
      send({ ...finishedEvent, type: "RUN_FINISHED", threadId: finishedEvent?.threadId ?? `scheduler-${task.id}`,
        runId: finishedEvent?.runId ?? historyId, result: terminalResult ?? { status, externalEffectsMayContinue: false },
        schedulerRunId: historyId, schedulerTaskId: task.id });
      deliver(() => toastEvents.publishSchedulerFinished({ schedulerRunId: historyId, taskId: task.id,
        taskTitle: task.title, status, outputPreview: reply.slice(0, 160) }));
    } else {
      send({ type: "RUN_ERROR", message: failure, code: errorCode, threadId: `scheduler-${task.id}`,
        runId: historyId, schedulerRunId: historyId, schedulerTaskId: task.id });
    }
    return { ok: status === "success", historyId, reply, ...(failure ? { error: failure } : {}), effectiveToolIds };
  }

  return { runScheduledTask, async close(): Promise<void> {
    closed = true;
    for (const controller of active.values()) controller.abort(Error("MEMORY_CONTEXT_CANCELLED"));
    await Promise.allSettled([...pending]);
  } };
}
