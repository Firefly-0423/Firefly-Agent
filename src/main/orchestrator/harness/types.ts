import type { ToolSpec, ToolCall, ChatMessage } from "../vendors/types";
import type { ToolDefinition } from "../tools/registry/tool-registry";
import type { FireflyRunTerminalResult } from "../../../shared/run-terminal";
import type { ApprovalOrigin } from "../../../shared/permission-approval";
import type { TodoItem } from "../../../shared/task-session";
import type { ToolErrorCategory } from "../tools/registry/tool-execution-error";
import type { ToolRiskLevel } from "../../permission-policy";
import type { ToolTaskResult, ToolFileChange } from "../../../shared/chat-types";
import type { ContextUsageSnapshot } from "../../../shared/context-usage";
import type { ToolOutputStore, ToolOutputRef } from "./tool-output/tool-output-store";
import { AUTO_COMPACT_THRESHOLD, DEFAULT_CONTEXT_WINDOW_TOKENS } from "../../../shared/context-window";
export type { ToolErrorCategory } from "../tools/registry/tool-execution-error";
export type { TodoStatus, TodoItem } from "../../../shared/task-session";

export type RetryDecision = "no_retry" | "retry";
export type SideEffectKind = "non_idempotent_side_effect" | "idempotent_mutation" | "read_only";
export type ToolCallOutcome = "not_executed" | "unknown" | "failure" | "success";
export type ToolObservation = {
  output?: string; toolOutputRef?: ToolOutputRef; fullOutputRef?: string; preview?: string; truncated?: boolean;
  suggestion?: string; message: string; target?: string; tool: string; retryCount?: number;
  retryDecision?: RetryDecision; toolSideEffect?: SideEffectKind; category?: ToolErrorCategory; outcome: ToolCallOutcome;
};
export type UncertainEffect = import("../../../shared/task-session").TaskUncertainEffect;
export type AgentState = { toolFailureStreaks?: Record<string, number>; uncertainEffects: UncertainEffect[]; todoItems: TodoItem[] };
export type HarnessCacheEpochReason =
  | "prompt_version_changed" | "tool_catalog_changed" | "model_changed" | "recovery" | "compaction" | "run_start";
export type HarnessCacheState = { epochReason: HarnessCacheEpochReason; cacheEpoch: number };
export type HarnessCacheDiagnostic = {
  messageCount: number; messagePrefixFingerprint: string; toolSchemaFingerprint: string; stablePromptFingerprint: string;
  round: number; cacheEpoch: number; runId?: string;
};
export const INITIAL_HARNESS_CACHE_STATE: HarnessCacheState = { cacheEpoch: 1, epochReason: "run_start" };
export type HarnessConfig = {
  compactionRetainRatio: number; compactionThreshold: number; safetyMarginTokens: number; reservedOutputTokens: number;
  contextWindowTokens: number; userWaitTimeoutMs: number; modelRequestTimeoutMs: number; totalTimeoutMs: number;
  maxRounds: number; maxParallelToolCalls: number;
};
export const DEFAULT_MAX_TOOL_ROUNDS = 200;
export const DEFAULT_RUN_TIMEOUT_MS = 2 * 60 * 60 * 1000;
export const DEFAULT_HARNESS_MODEL_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_HARNESS_CONFIG: HarnessConfig = {
  maxParallelToolCalls: 4, maxRounds: DEFAULT_MAX_TOOL_ROUNDS, totalTimeoutMs: DEFAULT_RUN_TIMEOUT_MS,
  modelRequestTimeoutMs: DEFAULT_HARNESS_MODEL_REQUEST_TIMEOUT_MS, userWaitTimeoutMs: 120_000,
  contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS, reservedOutputTokens: 8_192, safetyMarginTokens: 512,
  compactionThreshold: AUTO_COMPACT_THRESHOLD, compactionRetainRatio: 0.16,
};
export type HarnessEvent =
  | { message: string; type: "error" }
  | { message: string; type: "runtime_feedback" }
  | { planPath: string; type: "plan_written" }
  | { state: import("../plan-mode").PlanStateName; type: "plan_mode_changed" }
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
export type HarnessToolLifecycleEvent = {
  status: "planned" | "started" | "committed" | "unknown" | "not_executed";
  toolSideEffect: SideEffectKind; toolName: string; toolCallId: string;
};
export type HarnessToolFinishedEvent = {
  durationMs?: number; risk: ToolRiskLevel; status: ToolCallOutcome; runId: string; toolCallId: string; toolId: string;
};
export type HarnessCompactionLifecycleEvent = {
  cache?: HarnessCacheState; messageCountAfter?: number; messageCountBefore: number; status: "started" | "committed";
};
export type HarnessCheckpoint = {
  at: number; cache: HarnessCacheState; rounds: number; toolOutputs: ToolOutputRef[]; state: AgentState; messages: ChatMessage[];
};
export type RunAdjustmentMessage = { rawContent: string; id: string };
export type HarnessToolSpec = ToolSpec & { harnessBuiltin?: boolean };
export type HarnessInput = {
  allowedBuiltinToolIds?: ReadonlySet<string>;
  agentDefinitions?: readonly { description: string; nickname: string; id: string }[];
  agentExecutor?: (request: import("../persistent-agent-runtime").AgentExecuteRequest, scope?: import("../child-session-types").DelegationScope) => Promise<import("../persistent-agent-runtime").AgentExecuteResult>;
  transcriptSink?: import("../transcript-sink").TranscriptSink;
  toolOutputStore?: ToolOutputStore;
  executionLedger?: import("../execution-ledger").ExecutionLedger;
  checkPermission?: (toolId: string, args: Record<string, unknown>, signal?: AbortSignal, origin?: ApprovalOrigin) => Promise<boolean>;
  toolContext?: import("../tools/registry/tool-context").ToolContext;
  planState?: import("../plan-mode").PlanStateName;
  includeInteractiveTools?: boolean;
  requestUserClarification?: (card: unknown) => Promise<unknown>;
  pollRunAdjustments?: () => Promise<RunAdjustmentMessage[]> | undefined;
  onCacheDiagnostic?: (diagnostic: HarnessCacheDiagnostic) => void;
  onCompactionLifecycle?: (event: HarnessCompactionLifecycleEvent) => void;
  onToolFinished?: (event: HarnessToolFinishedEvent) => void;
  onToolLifecycle?: (event: HarnessToolLifecycleEvent) => void;
  onToolsPlanned?: (events: readonly (HarnessToolLifecycleEvent & { status: "planned" })[]) => void;
  // 回调收到活引用，必须在返回前同步保存快照。
  onCheckpoint?: (checkpoint: HarnessCheckpoint) => void;
  onEvent?: (event: HarnessEvent) => void;
  quiesceExecution?: () => void;
  signal?: AbortSignal;
  config?: Partial<HarnessConfig>;
  vendorConfig: import("../vendors/types").VendorConfig;
  tools: ToolDefinition[];
  initialState?: AgentState;
  initialCache?: HarnessCacheState;
  initialInternalContext?: { content: string; kind: "run_start" | "recovery" };
  runId?: string;
  messages: ChatMessage[];
  usageParts?: { skillLayerContent?: string; toolLayerContent: string; personaContent: string };
  promptLayers?: import("../prompt-layers").PromptLayers;
  systemPrompt: string;
  memoryRun?: import("../../memory-context/main-memory-runtime").MainMemoryRun;
};
export type HarnessResult = {
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
export function toolCallFingerprint(toolName: string, args: Record<string, unknown>): string {
  const fields = Object.keys(args).sort().map((name) => `${name}=${String(args[name])}`);
  return `${toolName}(${fields.join(",")})`;
}
