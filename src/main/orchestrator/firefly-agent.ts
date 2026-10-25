import type { BackgroundMemoryHost } from "../memory-context/background-memory-ingress";
import { AbstractAgent, type RunAgentInput } from "@ag-ui/client";
import { EventType, type BaseEvent } from "@ag-ui/core";
import { AgentRuntimeError } from "./agent-runtime-error";
import { AgentExecutionError, type RunPhase } from "./run-execution-status";
import { Observable } from "rxjs";
import { toolRegistry, type ToolDefinition } from "./tools/registry/tool-registry";
import type { ToolCallResult, ToolExecutionOutcome } from "./types";
import { checkPermission, type ToolRiskLevel } from "../permission/permission";
import { getAdapterForConfig, type ChatMessage } from "./vendors";
import { contextRefRegistry, extractLastUserQuery, type ToolContext } from "./tools/registry/tool-context";
import { runChatLoop } from "./chat-loop";
import type { RunCapabilities } from "./run-capabilities";
import { runHarnessWithAdapter } from "./harness-adapter";
import type { MainMemoryRun } from "../memory-context/main-memory-runtime";
import { publicRunFailure } from "../../shared/run-failure";
import type { SocialAtom } from "../social-context/types";
import { ExecutionLedgerStore, type ExecutionLedger } from "./execution-ledger";
import { perf } from "../logging/perf-trace";
import { debugLog, flowLog } from "../logging/agent-log";
import { requestUserClarification } from "../chat/user-choice";
import type { ConversationMode } from "../../shared/chat-types";
import type { FireflyRunTerminalResult } from "../../shared/run-terminal";
import { executeToolDefinition } from "./tools/registry/tool-executor";
import { createLive2dWorkRunTracker } from "./live2d-work-signal";
import { recordMessage, recordPluginCall } from "../storage/token-usage-store";
import { runWithUsageAttribution, usageFeatureForMode } from "../storage/usage-attribution";

export type SkillRouteInfo = {
  defaultExecutionMode?: "direct" | "plan";
  description: string;
  id: string;
};

export type AgentLoopResult = {
  terminal?: FireflyRunTerminalResult;
  totalUsage?: { input: number; output: number };
  completionReason: "no_tool" | "timeout" | "max_rounds" | "tool_error";
  toolResults: import("./types").ToolCallResult[];
  reply: string;
};

export type AgentLoopEvent = {
  contextUsage?: import("../../shared/context-usage").ContextUsageSnapshot;
  taskPlan?: unknown;
  snapshot?: unknown;
  status?: string;
  content?: string;
  totalUsage?: unknown;
  stepName?: string;
  toolCallName?: string;
  toolCallId?: string;
  delta?: string;
  role?: string;
  messageId?: string;
  type: string;
};

export type AgentLoopSettings = {
  contextWindowTokens: number;
  reasoningLevels?: import("../../shared/reasoning").ReasoningLevelsConfig;
  reasoning?: import("../../shared/reasoning").ReasoningPreference;
  explicitTransport?: "openai" | "anthropic" | "responses";
  apiKey: string;
  model: string;
  baseUrl: string;
  provider: string;
};

export type FireflyRunOptions = {
  transcriptSink?: import("./transcript-sink").TranscriptSink;
  pollRunAdjustments?: () => Promise<import("./harness/types").RunAdjustmentMessage[]> | undefined;
  onToolFinished?: (event: import("./harness/types").HarnessToolFinishedEvent) => void;
  signal?: AbortSignal;
  resolvedWorkspaceRoot?: string;
  executionLedger?: ExecutionLedger;
  availableSkills?: SkillRouteInfo[];
  socialContext?: { enabled: true; conversationId: string; userTurnId: string; assistantTurnId: string; retrievedAtoms: SocialAtom[]; now: number; };
  requestUserClarification?: ( card: import("../../shared/ask-clarification").AskClarificationCard, signal?: AbortSignal, ) => Promise<import("../../shared/ask-clarification").AskUserAnswer>;
  recoveryContext?: string;
  runtimeEnvironmentContext?: string;
  cleanMessages?: ChatMessage[];
  planSkillContext?: string;
  soulRuntimeContext?: string;
  soulSystemBaseContent: string;
  skillLayerContent?: string;
  toolSystemContent: string;
  imageCaptionFallback?: () => Promise<ChatMessage[]>;
  permissionMode?: "normal" | "allow_all";
  harnessInteractiveTools?: boolean;
  capabilities?: RunCapabilities;
  tools?: ToolDefinition[];
  timeoutMs: number;
  workReadScopes?: import("../../shared/chat-types").WorkReadScope[];
  conversationMode?: ConversationMode;
  executionMode?: AgentExecutionMode;
  conversationId?: string;
  messages: ChatMessage[];
  resumeFromRunId?: string;
  runId?: string;
  runTimeoutMs?: number;
  maxToolRounds?: number;
  maxParallelToolCalls?: number;
  settings: AgentLoopSettings;
  isControlledRunCurrent?:()=>boolean;
  controlledResponses?:import("./controlled-responses").ControlledResponsesRun;
  openMemoryRun?: (input: FireflyRunOptions) => Promise<MainMemoryRun>;
  backgroundMemory?: BackgroundMemoryHost;
  memoryRun?: MainMemoryRun;
};

export type FireflyRunResult = {
  terminal?: FireflyRunTerminalResult;
  socialContext?: FireflyRunOptions["socialContext"];
  executionMode?: AgentExecutionMode;
  soulPhaseReason?: "no_tool" | "max_rounds" | "timeout" | "tool_error";
  totalUsage?: { input: number; output: number };
  toolResults: ToolCallResult[];
  reply: string;
};

export type AbortDiagnostic = {
  diagnostics: Record<string, unknown>;
  userMessage: string;
  phase: AbortPhase;
  source: AbortSource;
};

export type AgentExecutionMode = "work" | "chat";
export type AbortSource = "user_cancelled" | "call_timeout" | "run_timeout" | "window_destroyed" | "upstream_cleanup";
export type AbortPhase = RunPhase | "decide" | "execute";
const ledgers = new ExecutionLedgerStore();

function safeTerminalError(error: unknown, message: string): Error {
  const visited = new Set<unknown>();
  while (error instanceof AgentExecutionError && error.cause instanceof Error && !visited.has(error)) { visited.add(error); error = error.cause; }
  return Object.assign(new Error(message), publicRunFailure(error));
}
function createRunId(): string { return `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }
function terminalFromCompletionReason(completionReason: "no_tool" | "max_rounds" | "timeout" | "tool_error" | undefined): FireflyRunTerminalResult {
  if (completionReason === "max_rounds") return { status: "timeout", reason: "max_rounds", externalEffectsMayContinue: true };
  if (completionReason === "timeout") return { status: "timeout", reason: "timeout", externalEffectsMayContinue: true };
  return { status: "success", externalEffectsMayContinue: false };
}
export function resolveExecutionMode(mode: unknown): AgentExecutionMode { return mode === "chat" ? "chat" : "work"; }

export function toAguiEvent(event: AgentLoopEvent): BaseEvent {
  const category = event.type;
  switch (category) {
    case "step_started": case "step_finished":
      return { type: category === "step_started" ? EventType.STEP_STARTED : EventType.STEP_FINISHED, stepName: event.stepName };
    case "tool_call_start": {
      const definition = toolRegistry.getById(event.toolCallName ?? "");
      return { type: EventType.TOOL_CALL_START, toolCallId: event.toolCallId, toolCallName: event.toolCallName, toolCallDisplayName: definition?.name };
    }
    case "tool_call_args": return { type: EventType.TOOL_CALL_ARGS, toolCallId: event.toolCallId, delta: event.delta };
    case "tool_call_result": return { type: EventType.TOOL_CALL_RESULT, toolCallId: event.toolCallId, messageId: event.messageId, content: event.content, status: event.status } as BaseEvent;
    case "tool_call_end": return { type: EventType.TOOL_CALL_END, toolCallId: event.toolCallId };
    case "text_message_start": case "reasoning_message_start":
      return { type: category === "text_message_start" ? EventType.TEXT_MESSAGE_START : EventType.REASONING_MESSAGE_START, messageId: event.messageId, role: event.role };
    case "text_message_content": case "reasoning_message_content":
      return { type: category === "text_message_content" ? EventType.TEXT_MESSAGE_CONTENT : EventType.REASONING_MESSAGE_CONTENT, messageId: event.messageId, delta: event.delta };
    case "text_message_end": case "reasoning_message_end":
      return { type: category === "text_message_end" ? EventType.TEXT_MESSAGE_END : EventType.REASONING_MESSAGE_END, messageId: event.messageId };
    case "compressing_context": return { type: EventType.CUSTOM, name: "firefly.compressingContext", value: { text: "流萤正在压缩上下文…" } };
    case "context_usage": return { type: EventType.CUSTOM, name: "firefly.context.usage", value: event.contextUsage } as BaseEvent;
    default: return { type: EventType.CUSTOM, name: "firefly.unknown", value: event } as BaseEvent;
  }
}

async function executeToolCall(tc: { id: string; name: string; arguments: string }, runnableToolIds: Set<string>, ctx?: ToolContext): Promise<ToolExecutionOutcome> {
  const failed = (errorCode: string, output: string): ToolExecutionOutcome => ({ status: "failed", errorCode, output });
  const definition = toolRegistry.getById(tc.name);
  let arguments_: Record<string, unknown> = {};
  try { arguments_ = JSON.parse(tc.arguments || "{}"); } catch { return failed("E_TOOL_ARGS_INVALID", "工具参数解析失败"); }
  if (!runnableToolIds.has(tc.name)) return failed("E_TOOL_UNAVAILABLE", "工具不可用: " + tc.name);
  if (!definition || !definition.enabled) return failed("E_TOOL_UNAVAILABLE", "工具不可用: " + tc.name);
  const risk: ToolRiskLevel = (definition as ToolDefinition & { risk?: ToolRiskLevel }).risk || "safe";
  const access = await checkPermission({ toolId: tc.name, toolName: definition.name, toolDescription: definition.description, args: arguments_, risk, runId: ctx?.runId });
  if (!access.allowed) return failed("E_PERMISSION_DENIED", access.reason || "权限不足");
  return executeToolDefinition(definition, arguments_, ctx);
}

export class FireflyAgent extends AbstractAgent {
  lastResult?: FireflyRunResult;
  protected _runOptions?: FireflyRunOptions;

  runWithEvents(options: FireflyRunOptions): Observable<BaseEvent> {
    const thread = this.threadId;
    const run = options.runId ?? createRunId();
    const current: FireflyRunOptions = { ...options, runId: run, executionLedger: options.executionLedger ?? ledgers.forScope(run) };
    const conversation = current.conversationId ?? "default";
    const cancellation = new AbortController();
    const work = createLive2dWorkRunTracker();
    let firstAbort: AbortSource | undefined;
    const markAbort = (source: AbortSource) => {
      if (firstAbort) return;
      firstAbort = source;
      cancellation.abort({ source });
    };
    return new Observable<BaseEvent>((observer) => {
      let unsubscribed = false, settled = false;
      const externalCancel = () => markAbort("user_cancelled");
      const detach = () => { current.signal?.removeEventListener("abort", externalCancel); };
      if (current.signal?.aborted) externalCancel();
      else current.signal?.addEventListener("abort", externalCancel, { once: true });
      const plugin = conversation.startsWith("plugin:") ? conversation.slice("plugin:".length) : undefined;
      if (plugin) recordPluginCall(plugin);
      void runWithUsageAttribution(plugin ? { feature: "plugin", pluginId: plugin }
        : { feature: usageFeatureForMode(current.conversationMode ?? options.executionMode), sessionId: current.conversationId }, async () => {
        if (!plugin) recordMessage();
        let owned: MainMemoryRun | undefined;
        let finishEvent: BaseEvent | undefined;
        let finishError: Error | undefined;
        try {
          if (!current.memoryRun && current.openMemoryRun) {
            owned = await current.openMemoryRun({ ...current, signal: cancellation.signal });
            if (!owned) throw new Error("MEMORY_CONTEXT_RUN_UNAVAILABLE");
            current.memoryRun = owned;
            if (cancellation.signal.aborted) throw new Error("MEMORY_CONTEXT_CANCELLED");
          }
          if (current.memoryRun && current.transcriptSink) current.transcriptSink = current.memoryRun.bindSink(current.transcriptSink);
          observer.next({ type: EventType.RUN_STARTED, threadId: thread, runId: run });
          const timing = perf.begin("get_adapter");
          const vendor = getAdapterForConfig(options.settings);
          timing.end();
          const notify = (event: AgentLoopEvent) => {
            if (event.type === "tool_call_start") work.markToolStarted();
            if (unsubscribed) return;
            observer.next(toAguiEvent(event));
          };
          const mode = resolveExecutionMode(options.executionMode);
          const chatTools = (options.tools ?? []).length;
          const toolChat = mode === "chat" && chatTools > 0;
          debugLog(`[FireflyAgent] executionMode=${mode} loop=${mode === "chat" && !toolChat ? "chat" : "harness"} provider=${options.settings.provider} model=${options.settings.model}`);
          const toolCount = mode === "chat" ? chatTools : (options.tools ?? toolRegistry.getEnabledTools()).filter((definition) => definition.enabled).length;
          flowLog("── 新请求 ─────────────────────────");
          flowLog(`1. 准备上下文：${mode === "chat" ? "Chat" : "Work"} 模式，模型 ${options.settings.model}，${toolCount} 个工具可用`);
          flowLog(`2. 理解用户请求：${mode === "chat" ? "Chat 模式无需工具上下文" : `完成`}`);
          let completed: AgentLoopResult;
          if (current.controlledResponses) completed = await current.controlledResponses(current, cancellation.signal, notify);
          else if (mode === "chat" && !toolChat) {
            flowLog("3. Chat 模式：生成回复");
            completed = await perf.track("chat_loop", () => runChatLoop({
              settings: options.settings, adapter: vendor, messages: options.messages, soulSystemBaseContent: options.soulSystemBaseContent,
              runtimeContext: options.soulRuntimeContext ?? "", timeoutMs: options.timeoutMs, imageCaptionFallback: options.imageCaptionFallback,
              onEvent: notify, signal: cancellation.signal, mode: options.conversationMode, transcriptSink: current.transcriptSink, memoryRun: current.memoryRun,
            }));
          } else {
            const executeTool = (call: Parameters<typeof executeToolCall>[0], allowed: Set<string>) => executeToolCall(call, allowed, {
              userQuery: extractLastUserQuery(options.messages), conversationId: options.conversationId ?? "default", runId: run,
              contextRefs: contextRefRegistry, signal: cancellation.signal, resolvedWorkspaceRoot: options.resolvedWorkspaceRoot,
              mode: options.conversationMode, allowedSkillIds: options.capabilities?.skillIds, workReadScopes: options.workReadScopes,
            });
            const conversationId = options.conversationId ?? "default";
            completed = await perf.track("harness_loop", () => runHarnessWithAdapter(current, cancellation.signal, (event: BaseEvent) => {
              if (event.type === EventType.TOOL_CALL_START) work.markToolStarted();
              if (!unsubscribed) observer.next(event);
            }));
          }
          this.lastResult = {
            reply: completed.reply, toolResults: completed.toolResults, totalUsage: completed.totalUsage, soulPhaseReason: completed.completionReason,
            executionMode: mode, socialContext: options.socialContext, terminal: completed.terminal ?? terminalFromCompletionReason(completed.completionReason),
          };
          flowLog("── 本轮完成 ────────────────────────");
          if (unsubscribed) return;
          if (mode === "chat" && !toolChat && this.lastResult.terminal?.status === "success") {
            await current.transcriptSink?.checkpoint();
            if (unsubscribed) return;
          }
          finishEvent = { type: EventType.RUN_FINISHED, threadId: thread, runId: run, result: this.lastResult.terminal };
        } catch (failure) {
          if (unsubscribed) return;
          const execution = failure instanceof AgentExecutionError ? failure.executionStatus : undefined;
          const hasResults = (execution?.successfulTools.length ?? 0) > 0;
          const phase = execution?.phase ?? "unknown";
          const diagnostic = classifyRunError(failure, firstAbort, run, conversation, phase, hasResults);
          console.error("[FireflyAgent]", `run 失败 [${diagnostic.source}]:`, diagnostic.diagnostics);
          if (diagnostic.source === "user_cancelled") {
            try { await current.transcriptSink?.closeInterruption({ reason: "user_cancel", runSession: null }); }
            catch (closureFailure) {
              console.error("[FireflyAgent]", "transcript interruption closure failed:", closureFailure);
              finishEvent = { type: EventType.RUN_FINISHED, threadId: thread, runId: run,
                result: { status: "runtime_error", reason: "transcript_interruption_closure_failed", externalEffectsMayContinue: true } };
              return;
            }
            finishEvent = { type: EventType.RUN_FINISHED, threadId: thread, runId: run, result: { status: "cancelled", reason: "user_cancelled", externalEffectsMayContinue: true } };
            return;
          }
          finishError = safeTerminalError(failure, diagnostic.userMessage);
        } finally {
          try { await owned?.close(); }
          catch (closureFailure) {
            const diagnostic = classifyRunError(closureFailure, undefined, run, conversation, "unknown", false);
            console.error("[FireflyAgent]", "memory run closure failed:", diagnostic.diagnostics);
            finishEvent = undefined;
            finishError = safeTerminalError(closureFailure, diagnostic.userMessage);
          }
          work.finish();
          settled = true;
          detach();
          if (!unsubscribed) {
            if (finishError) observer.error(finishError);
            else { if (finishEvent) observer.next(finishEvent); observer.complete(); }
          }
        }
      });
      return () => { unsubscribed = true; detach(); if (!settled && !cancellation.signal.aborted) markAbort("upstream_cleanup"); };
    });
  }
  run(input: RunAgentInput): Observable<BaseEvent> {
    if (!this._runOptions) return new Observable<BaseEvent>((observer) => { observer.error(new Error("FireflyAgent.run 被直接调用，但未设置 _runOptions。请用 runWithEvents。")); });
    void input;
    return this.runWithEvents(this._runOptions);
  }
}

export function classifyRunError(err: unknown, abortSource: AbortSource | undefined, runId: string, conversationId: string, phase: AbortPhase, hasToolResults: boolean): AbortDiagnostic {
  const facts: Record<string, unknown> = { runId, conversationId, abortSource, phase, hasToolResults,
    errorName: err instanceof Error ? err.name : undefined, errorMessage: err instanceof Error ? err.message : String(err) };
  if (err instanceof Error && err.message === "E_AGENT_GRAPH_TIMEOUT") {
    const message = phase === "soul" && hasToolResults ? "工具结果已获得，但最终回复生成超时，请重试。" : "请求处理超时，请重试。";
    return { source: "run_timeout", phase, userMessage: message, diagnostics: facts };
  }
  if (err instanceof Error && err.message === "E_AGENT_GRAPH_CANCELLED") {
    if (abortSource === "user_cancelled") return { source: "user_cancelled", phase, userMessage: "", diagnostics: facts };
    return { source: abortSource ?? "upstream_cleanup", phase, userMessage: "操作已中断，请重试。", diagnostics: facts };
  }
  const aborted = (err instanceof DOMException && err.name === "AbortError") || (err instanceof Error && err.name === "AbortError")
    || (typeof err === "object" && err !== null && "name" in err && (err as { name: string }).name === "AbortError");
  if (err instanceof AgentExecutionError && err.cause instanceof Error) return classifyRunError(err.cause, abortSource, runId, conversationId, phase, hasToolResults);
  if (err instanceof AgentRuntimeError) {
    const safe: Record<string, string> = {
      E_MODEL_REQUEST_FAILED: "模型服务暂时不可用，请稍后重试。", E_MODEL_REQUEST_TIMEOUT: "模型响应超时，请稍后重试。", E_MODEL_HTTP_ERROR: "模型服务请求失败，请稍后重试。",
      E_MODEL_RESPONSE_PARSE_FAILED: "模型返回格式异常，请重试。", E_AGENT_NO_PROGRESS: "请求处理遇到问题，请重试。", E_AGENT_GRAPH_ITERATION_LIMIT: "请求处理步骤过多，请简化问题后重试。",
    };
    const message = safe[err.code] ?? "请求处理出错，请重试。";
    const http = err.message.match(/HTTP\s+(\d{3})/);
    if (http) facts.httpStatus = Number(http[1]);
    facts.errorCode = err.code;
    return { source: abortSource ?? "upstream_cleanup", phase, userMessage: message, diagnostics: facts };
  }
  if (!aborted) return { source: abortSource ?? "upstream_cleanup", phase, userMessage: "请求处理失败，请重试。", diagnostics: facts };
  const source = abortSource ?? "unknown_abort" as AbortSource;
  if (source === "user_cancelled") return { source, phase, userMessage: "", diagnostics: facts };
  if (source === "call_timeout") {
    const message = phase === "soul" && hasToolResults ? "工具结果已获得，但最终回复生成超时，请重试。" : "请求处理超时，请重试。";
    return { source, phase, userMessage: message, diagnostics: facts };
  }
  return { source, phase, userMessage: "操作已中断，请重试。", diagnostics: facts };
}
