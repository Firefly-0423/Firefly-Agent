import { DEFAULT_MAX_TOOL_ROUNDS, DEFAULT_RUN_TIMEOUT_MS } from "../../platform/settings/run-defaults";
import type { ToolCallOutcome } from "../../../shared/tool-call-outcome";
import type { ToolSpec, ToolCall, ChatMessage } from "../../model/providers/types";
import type { ToolDefinition } from "../../tooling/registry/tool-registry";
import type { FireflyRunTerminalResult } from "../../../shared/run-terminal";
import type { ApprovalOrigin } from "../../../shared/permission-approval";
import type { TodoItem } from "../../../shared/task-session";
import type { ToolErrorCategory } from "../../tooling/registry/tool-execution-error";
import type { ToolRiskLevel } from "../../platform/permission/permission-policy";
import type { ToolTaskResult, ToolFileChange } from "../../../shared/chat-types";
import type { ContextUsageSnapshot } from "../../../shared/context-usage";
import type { ToolOutputStore, ToolOutputRef } from "./tool-output/tool-output-store";
import { AUTO_COMPACT_THRESHOLD, DEFAULT_CONTEXT_WINDOW_TOKENS } from "../../../shared/context-window";
export type { ToolErrorCategory } from "../../tooling/registry/tool-execution-error";
export type { TodoStatus, TodoItem } from "../../../shared/task-session";

export type RetryDecision = "no_retry" | "retry";
export type SideEffectKind = "non_idempotent_side_effect" | "idempotent_mutation" | "read_only";
export type { ToolCallOutcome } from "../../../shared/tool-call-outcome";
export type ToolObservation = {
  output?: string; toolOutputRef?: ToolOutputRef; fullOutputRef?: string; preview?: string; truncated?: boolean;
  suggestion?: string; message: string; target?: string; tool: string; retryCount?: number;
  retryDecision?: RetryDecision; toolSideEffect?: SideEffectKind; category?: ToolErrorCategory; outcome: ToolCallOutcome;
};
export type UncertainEffect = import("../../../shared/task-session").TaskUncertainEffect;
export type AgentState = { toolFailureStreaks?: Record<string, number>; uncertainEffects: UncertainEffect[]; todoItems: TodoItem[] };
export type AgentLoopCacheEpochReason =
  | "prompt_version_changed" | "tool_catalog_changed" | "model_changed" | "recovery" | "compaction" | "run_start";
export type AgentLoopCacheState = { epochReason: AgentLoopCacheEpochReason; cacheEpoch: number };
export type AgentLoopCacheDiagnostic = {
  messageCount: number; messagePrefixFingerprint: string; toolSchemaFingerprint: string; stablePromptFingerprint: string;
  round: number; cacheEpoch: number; runId?: string;
};
export const INITIAL_AGENT_LOOP_CACHE_STATE: AgentLoopCacheState = { cacheEpoch: 1, epochReason: "run_start" };
export type AgentLoopConfig = {
  compactionRetainRatio: number; compactionThreshold: number; safetyMarginTokens: number; reservedOutputTokens: number;
  contextWindowTokens: number; userWaitTimeoutMs: number; modelRequestTimeoutMs: number; totalTimeoutMs: number;
  maxRounds: number; maxParallelToolCalls: number;
};
export { DEFAULT_MAX_TOOL_ROUNDS, DEFAULT_RUN_TIMEOUT_MS };
export const DEFAULT_AGENT_LOOP_MODEL_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_AGENT_LOOP_CONFIG: AgentLoopConfig = {
  maxParallelToolCalls: 4, maxRounds: DEFAULT_MAX_TOOL_ROUNDS, totalTimeoutMs: DEFAULT_RUN_TIMEOUT_MS,
  modelRequestTimeoutMs: DEFAULT_AGENT_LOOP_MODEL_REQUEST_TIMEOUT_MS, userWaitTimeoutMs: 120_000,
  contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS, reservedOutputTokens: 8_192, safetyMarginTokens: 512,
  compactionThreshold: AUTO_COMPACT_THRESHOLD, compactionRetainRatio: 0.16,
};
export type AgentLoopEvent =
  | { message: string; type: "error" }
  | { message: string; type: "runtime_feedback" }
  | { planPath: string; type: "plan_written" }
  | { state: import("../tools/plan-mode").PlanStateName; type: "plan_mode_changed" }
  | { card: unknown; type: "ask_user" }
  | { snapshot: ContextUsageSnapshot; type: "context_usage" }
  | { items: TodoItem[]; type: "todo_update" }
  | { taskResult?: ToolTaskResult; changes?: ToolFileChange[]; preview: string; outcome: ToolCallOutcome; toolCallId: string; type: "tool_end" }
  | { displayName?: string; args: Record<string, unknown>; toolName: string; toolCallId: string; type: "tool_start" }
  | { messageId: string; type: "reasoning_end" }
  | { delta: string; messageId: string; type: "reasoning_delta" }
  | { messageId: string; type: "reasoning_start" }
  | { content: string; type: "final_answer" }
  | { content: string; type: "progress_text" }
  | { roundId: string; type: "candidate_text_discard" }
  | { delta: string; roundId: string; type: "candidate_text_delta" }
  | { roundId: string; type: "round_end" }
  | { roundId: string; type: "round_start" };
export type AgentLoopToolLifecycleEvent = {
  status: "planned" | "started" | "committed" | "unknown" | "not_executed";
  toolSideEffect: SideEffectKind; toolName: string; toolCallId: string;
};
export type AgentLoopToolFinishedEvent = {
  durationMs?: number; risk: ToolRiskLevel; status: ToolCallOutcome; runId: string; toolCallId: string; toolId: string;
};
export type AgentLoopCompactionLifecycleEvent = {
  cache?: AgentLoopCacheState; messageCountAfter?: number; messageCountBefore: number; status: "started" | "committed";
};
export type AgentLoopCheckpoint = {
  at: number; cache: AgentLoopCacheState; rounds: number; toolOutputs: ToolOutputRef[]; state: AgentState; messages: ChatMessage[];
};
export type RunAdjustmentMessage = { rawContent: string; id: string };
export type AgentLoopToolSpec = ToolSpec & { harnessBuiltin?: boolean };
export type AgentLoopInput = {
  allowedBuiltinToolIds?: ReadonlySet<string>;
  agentDefinitions?: readonly { description: string; nickname: string; id: string }[];
  agentExecutor?: (request: import("./run-ports").AgentExecuteRequest, scope?: import("./run-ports").DelegationScope) => Promise<import("./run-ports").AgentExecuteResult>;
  transcriptSink?: import("./transcript-sink").TranscriptSink;
  toolOutputStore?: ToolOutputStore;
  executionLedger?: import("./execution-ledger").ExecutionLedger;
  checkPermission?: (toolId: string, args: Record<string, unknown>, signal?: AbortSignal, origin?: ApprovalOrigin) => Promise<boolean>;
  toolContext?: import("../../tooling/registry/tool-context").ToolContext;
  planState?: import("../tools/plan-mode").PlanStateName;
  includeInteractiveTools?: boolean;
  requestUserClarification?: (card: unknown) => Promise<unknown>;
  pollRunAdjustments?: () => Promise<RunAdjustmentMessage[]> | undefined;
  onCacheDiagnostic?: (diagnostic: AgentLoopCacheDiagnostic) => void;
  onCompactionLifecycle?: (event: AgentLoopCompactionLifecycleEvent) => void;
  onToolFinished?: (event: AgentLoopToolFinishedEvent) => void;
  onToolLifecycle?: (event: AgentLoopToolLifecycleEvent) => void;
  onToolsPlanned?: (events: readonly (AgentLoopToolLifecycleEvent & { status: "planned" })[]) => void;
  // 回调收到活引用，必须在返回前同步保存快照。
  onCheckpoint?: (checkpoint: AgentLoopCheckpoint) => void;
  onEvent?: (event: AgentLoopEvent) => void;
  quiesceExecution?: () => void;
  signal?: AbortSignal;
  config?: Partial<AgentLoopConfig>;
  vendorConfig: import("../../model/providers/types").VendorConfig;
  tools: ToolDefinition[];
  initialState?: AgentState;
  initialCache?: AgentLoopCacheState;
  initialInternalContext?: { content: string; kind: "run_start" | "recovery" };
  runId?: string;
  messages: ChatMessage[];
  usageParts?: { skillLayerContent?: string; toolLayerContent: string; personaContent: string };
  promptLayers?: import("../../model/prompt/prompt-layers").PromptLayers;
  systemPrompt: string;
  memoryRun?: import("./run-ports").MainMemoryRun;
};
export type AgentLoopResult = {
  rounds: number; terminal?: FireflyRunTerminalResult;
  terminateReason?: "max_rounds" | "timeout" | "cancelled" | "error";
  terminated: boolean; finalState: AgentState; finalAnswer: string;
  failure?: import("../../../shared/run-failure").RunFailure;
};

export class ToolCallArgumentsError extends Error {
  constructor() { super("工具参数必须是有效的 JSON 对象"); this.name = "ToolCallArgumentsError"; }
}
export function invalidToolCallArguments(call: ToolCall): ToolObservation {
  return { outcome: "failure", category: "invalid_arguments", tool: call.name, toolSideEffect: "read_only", message: "工具参数必须是有效的 JSON 对象" };
}
export function parseToolCallArgs(call: ToolCall): Record<string, unknown> {
  let decoded: unknown;
  try { decoded = JSON.parse(call.arguments); } catch { throw new ToolCallArgumentsError(); }
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) throw new ToolCallArgumentsError();
  return decoded as Record<string, unknown>;
}
export function tryParseToolCallArgs(call: ToolCall): Record<string, unknown> | undefined {
  try { return parseToolCallArgs(call); }
  catch (cause) {
    if (!(cause instanceof ToolCallArgumentsError)) throw cause;
    return undefined;
  }
}
/** 规范化 JSON：对象键递归排序，嵌套对象和数组保留完整结构，不同参数不会落到同一个字符串。 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** 工具调用的身份：工具名加上按键排序、每个值都规范化编码的参数。 */
export function toolCallFingerprint(toolName: string, args: Record<string, unknown>): string {
  const fields = Object.keys(args).sort().map((name) => `${name}=${canonicalJson(args[name])}`);
  return `${toolName}(${fields.join(",")})`;
}
