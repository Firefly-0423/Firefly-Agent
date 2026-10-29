import type { ToolCall } from "../vendors/types";
import type { ToolDefinition } from "../tools/registry/tool-registry";
import type { ApprovalOrigin } from "../../../shared/permission-approval";
import type { ToolCallResult, ToolExecutionOutcome } from "../types";
import type { ToolObservation, HarnessEvent, AgentState } from "./types";
import { tryParseToolCallArgs, parseToolCallArgs, toolCallFingerprint, ToolCallArgumentsError, invalidToolCallArguments } from "./types";
import { isHarnessBuiltin, isInteractiveHarnessBuiltin, DELEGATE_AGENT_TOOL_ID,
  executeUpdateTodo, executeAskUser, executeDelegateAgent, executeConfirmUncertainEffect, CONFIRM_UNCERTAIN_EFFECT_TOOL_ID } from "./builtin-tools";
import { ENTER_PLAN_MODE_TOOL_ID, WRITE_PLAN_TOOL_ID, executeEnterPlanMode, executeWritePlan } from "./plan-tools";
import { executeReadToolResult, READ_TOOL_RESULT_TOOL_ID } from "./tool-output/read-tool-result";
import { resolveSideEffect } from "./side-effect-resolver";
import { extractFileChangesFromOutput } from "../tools/registry/tool-evidence";
import { findBlockingUncertainEffect } from "./uncertain-effect-guard";
import { ExecutionLedger } from "../execution-ledger";
import { executeToolDefinition } from "../tools/registry/tool-executor";
import type { ToolOutputStore } from "./tool-output/tool-output-store";
import { ToolOutputPersistenceError } from "./tool-output/file-tool-output-store";
import { getCurrentLevel } from "../../permission/permission";
import { isPlanReadOnly } from "../plan-mode";
import { classifyToolExecutionMode } from "./tool-call-scheduler";
import { isShellJobControlAuthorized } from "../tools/builtin-tools/shell-job-manager";
import { shellJobTool } from "../tools/builtin-tools/shell-job-tool";
import type { DelegationScope } from "../child-session-types";
import { isAbortError, raceWithSignal } from "../../utils/abort-utils";
import type { LeafPermit } from "./execution-coordinator";
import { policyFor } from "../../permission/permission-policy";
import { createToolInvocationContext } from "../tools/registry/tool-context";

export type TruncationConfig = { tailChars: number; headChars: number; thresholdChars: number };
export const DEFAULT_TRUNCATION: TruncationConfig = { thresholdChars: 30_000, headChars: 12_000, tailChars: 8_000 };
export const TOOL_RESULT_PRUNE_MARKER = "\n\n[... tool result middle pruned ...]\n\n";
export function truncateOutput(output: string, config: TruncationConfig, _toolCallId: string): {
  preview: string; truncated: boolean; fullOutputRef?: string;
} {
  const characters = Array.from(output);
  if (characters.length <= config.thresholdChars) return { preview: output, truncated: false };
  const excerpt = characters.slice(0, config.headChars).join("") + TOOL_RESULT_PRUNE_MARKER + characters.slice(-config.tailChars).join("");
  return { preview: excerpt, truncated: true, fullOutputRef: undefined };
}
export type ToolDispatchContext = {
  onExecutionStarted?: () => void;
  delegationScope?: DelegationScope;
  allowedBuiltinToolIds?: ReadonlySet<string>;
  agentExecutor?: import("./types").HarnessInput["agentExecutor"];
  executionLedger?: ExecutionLedger;
  deferOutputPersistence?: boolean;
  toolOutputStore?: ToolOutputStore;
  truncation?: TruncationConfig;
  toolContext?: import("../tools/registry/tool-context").ToolContext;
  checkPermission?: (toolId: string, args: Record<string, unknown>, signal?: AbortSignal, origin?: ApprovalOrigin) => Promise<boolean>;
  includeInteractiveTools?: boolean;
  requestUserClarification?: (card: unknown) => Promise<unknown>;
  onEvent?: (event: HarnessEvent) => void;
  tools: ToolDefinition[];
  state: AgentState;
};
export type ToolDispatchResult = ToolObservation & { rawResult?: ToolCallResult };
function cancelledBeforeDispatch(call: ToolCall): ToolDispatchResult {
  return { outcome: "not_executed", category: "runtime_safety", tool: call.name, message: "aborted_before_dispatch" };
}
function revalidateToolPermission(ctx: ToolDispatchContext, tool: ToolDefinition, args: Record<string, unknown>, approvalRequired: boolean): boolean {
  if (ctx.toolContext?.revalidateToolPermission) return ctx.toolContext.revalidateToolPermission(tool.id, args, approvalRequired);
  const risk = tool.risk ?? "safe";
  if (ctx.toolContext?.conversationId && isPlanReadOnly(ctx.toolContext.conversationId)
    && (risk === "shell" || policyFor("read-only", risk) !== "allow")) return false;
  if (ctx.toolContext?.permissionMode === "allow_all") return true;
  if (!ctx.checkPermission) return true;
  const level = getCurrentLevel();
  const decisions = [policyFor(level, risk), policyFor(ctx.toolContext?.fileAccessLevel ?? level, risk)];
  return !decisions.includes("deny") && (!decisions.includes("ask") || approvalRequired);
}
export async function dispatchToolCall(call: ToolCall, ctx: ToolDispatchContext): Promise<ToolDispatchResult> {
  if (ctx.toolContext?.signal?.aborted) return cancelledBeforeDispatch(call);
  let parsed: Record<string, unknown>;
  try { parsed = parseToolCallArgs(call); }
  catch (cause) {
    if (!(cause instanceof ToolCallArgumentsError)) throw cause;
    return invalidToolCallArguments(call);
  }
  if (isHarnessBuiltin(call.name)) {
    if (ctx.allowedBuiltinToolIds && !ctx.allowedBuiltinToolIds.has(call.name)) return {
      outcome: "not_executed", category: "runtime_safety", tool: call.name, message: "当前运行未授权该控制工具",
    };
    if (ctx.includeInteractiveTools === false && isInteractiveHarnessBuiltin(call.name)) return {
      outcome: "failure", category: "not_found", tool: call.name, message: "当前渠道不支持交互式工具",
    };
    const owner = ctx.toolContext?.execution;
    const invoke = async (): Promise<ToolDispatchResult> => {
      if (ctx.toolContext?.signal?.aborted) return cancelledBeforeDispatch(call);
      if (call.name !== DELEGATE_AGENT_TOOL_ID) ctx.onExecutionStarted?.();
      // Interactive built-ins announce themselves in the tool round; the rest start here like registry tools,
      // or the UI only learns of them from their result. The renderer names them in the user's language.
      if (!isInteractiveHarnessBuiltin(call.name)) ctx.onEvent?.({ type: "tool_start", toolCallId: call.id, toolName: call.name, args: tryParseToolCallArgs(call) ?? {} });
      return executeHarnessBuiltin(call, ctx);
    };
    const observed = owner && call.name !== DELEGATE_AGENT_TOOL_ID && !isInteractiveHarnessBuiltin(call.name)
      ? await owner.coordinator.runLeaf({ ...owner.scope, toolCallId: call.id },
        classifyToolExecutionMode(call, ctx.tools) === "parallel" ? "shared" : "exclusive", ctx.toolContext?.signal, invoke)
      : await invoke();
    return ctx.deferOutputPersistence ? observed : persistToolDispatchResult(call, observed, ctx);
  }
  const definition = ctx.tools.find((entry) => entry.id === call.name);
  const identity = toolCallFingerprint(call.name, parsed);
  const uncertain = findBlockingUncertainEffect(ctx.state, identity, call.name);
  if (uncertain) return { outcome: "not_executed", category: "runtime_safety", tool: call.name,
    message: `该副作用已有一次未确认结果（${uncertain?.id ?? "unknown"}），在 reconcile 或 ask 用户前不能重复执行` };
  if (!definition) return { outcome: "failure", category: "not_found", tool: call.name, message: `工具 "${call.name}" 未注册` };
  let approvalRequired = false;
  if (ctx.checkPermission) {
    const level = getCurrentLevel();
    const risk = definition.risk ?? "safe";
    approvalRequired = ctx.toolContext?.permissionMode !== "allow_all"
      && (policyFor(level, risk) === "ask" || policyFor(ctx.toolContext?.fileAccessLevel ?? level, risk) === "ask");
    let permitted: boolean;
    try {
      const signal = ctx.toolContext?.signal;
      const answer = signal ? ctx.checkPermission(definition.id, parsed, signal) : ctx.checkPermission(definition.id, parsed);
      permitted = await raceWithSignal(answer, signal);
    } catch (cause) {
      if (isAbortError(cause) || ctx.toolContext?.signal?.aborted) return cancelledBeforeDispatch(call);
      throw cause;
    }
    if (!permitted) return { outcome: "failure", category: "permission_denied", tool: call.name, message: `工具 "${definition.id}" 被权限系统拒绝` };
  }
  if (ctx.toolContext?.signal?.aborted) return cancelledBeforeDispatch(call);
  let executed: ToolCallResult;
  const targets = parsed.path !== undefined ? [String(parsed.path)] : parsed.file !== undefined ? [String(parsed.file)]
    : parsed.url !== undefined ? [String(parsed.url)] : [];
  const owner = ctx.toolContext?.execution;
  const scope = owner ? { ...owner.scope, toolCallId: call.id } : undefined;
  const denied = (): ToolCallResult => ({ toolId: definition.id, args: parsed, status: "failed",
    output: `工具 "${definition.id}" 当前策略不再允许执行`, category: "permission_denied", errorCode: "E_PERMISSION_CHANGED", effectState: "not_applied" });
  const invoke = async (permit?: LeafPermit): Promise<ToolExecutionOutcome> => {
    if (ctx.toolContext?.signal?.aborted) return { status: "failed", output: "aborted_before_dispatch", category: "runtime_safety", effectState: "not_applied" };
    if (!revalidateToolPermission(ctx, definition, parsed, approvalRequired)) return denied();
    const context = ctx.toolContext ? createToolInvocationContext(ctx.toolContext, {
      ...(owner && scope ? { execution: { coordinator: owner.coordinator, scope, ...(permit ? { permit } : {}) } } : {}),
      authorizedToolCall: ctx.checkPermission ? { toolId: definition.id, args: parsed, approvalRequired } : undefined,
    }) : undefined;
    ctx.onExecutionStarted?.();
    ctx.onEvent?.({ type: "tool_start", toolCallId: call.id, toolName: call.name, args: parsed, displayName: definition.name });
    return executeToolDefinition(definition, parsed, context);
  };
  const coordinate = (): Promise<ToolExecutionOutcome> => {
    if (!owner || !scope) return invoke();
    const job = typeof parsed.job_id === "string" ? parsed.job_id.trim() : "";
    const ownedControl = definition === shellJobTool && (parsed.action === undefined || parsed.action === "status" || parsed.action === "stop")
      && isShellJobControlAuthorized(job, scope);
    if (ownedControl) return invoke();
    return owner.coordinator.runLeaf(scope, classifyToolExecutionMode(call, ctx.tools) === "parallel" ? "shared" : "exclusive", ctx.toolContext?.signal, invoke);
  };
  if (ctx.executionLedger) {
    const cached = await ctx.executionLedger.execute({ logicalInvocationId: `${ctx.toolContext?.runId ?? "unknown"}:${call.id}`,
      capability: definition.id, targetRefs: targets, args: parsed }, coordinate);
    executed = { toolId: definition.id, args: parsed, ...cached.outcome, ...(cached.cached ? { deduplicated: true } : {}) };
  } else executed = { toolId: definition.id, args: parsed, ...await coordinate() };
  const limits = ctx.truncation ?? DEFAULT_TRUNCATION;
  const effect = resolveSideEffect(definition, parsed);
  const projected = truncateOutput(executed.output, limits, call.id);
  const outcome: ToolObservation["outcome"] = executed.status === "succeeded" ? "success"
    : executed.effectState === "unknown" && effect === "non_idempotent_side_effect" ? "unknown" : "failure";
  if (outcome === "unknown") {
    const effectId = `${ctx.toolContext?.runId ?? "unknown-run"}:${call.id}`;
    if (!ctx.state.uncertainEffects.some((entry) => entry.id === effectId)) ctx.state.uncertainEffects.push({
      id: effectId, toolCallId: call.id, fingerprint: identity, toolName: call.name, message: "副作用已发起，但 Runtime 无法确认是否生效",
    });
  }
  const observed: ToolDispatchResult = {
    outcome, category: executed.category, toolSideEffect: effect, retryDecision: executed.retryable ? "retry" : "no_retry", tool: call.name,
    target: (parsed.path as string | undefined) ?? (parsed.command as string | undefined) ?? (parsed.query as string | undefined),
    message: projected.preview, output: executed.output, truncated: projected.truncated, preview: projected.preview, rawResult: executed,
  };
  const durable = ctx.deferOutputPersistence ? observed : await persistToolDispatchResult(call, observed, ctx);
  if (!ctx.deferOutputPersistence) ctx.onEvent?.({ type: "tool_end", toolCallId: call.id,
    outcome: executed.status === "succeeded" ? "success" : "failure", preview: projected.preview.slice(0, 200), changes: extractFileChangesFromOutput(executed.output) });
  return durable;
}
function shouldPersistResult(call: ToolCall, result: ToolDispatchResult): result is ToolDispatchResult & {
  output: string; outcome: "success" | "failure" | "unknown";
} {
  return (call.name === DELEGATE_AGENT_TOOL_ID || !isHarnessBuiltin(call.name)) && result.output !== undefined
    && (result.outcome === "success" || result.outcome === "failure" || result.outcome === "unknown");
}
export async function persistToolDispatchResult(call: ToolCall, result: ToolDispatchResult, ctx: ToolDispatchContext): Promise<ToolDispatchResult> {
  if (!shouldPersistResult(call, result) || !ctx.toolOutputStore || result.toolOutputRef) return result;
  const conversation = ctx.toolContext?.conversationId;
  const run = ctx.toolContext?.runId;
  if (!conversation || !run) throw new ToolOutputPersistenceError("工具结果保存缺少会话或运行标识");
  const content = result.output;
  if (content === undefined) return result;
  const projected = result.preview !== undefined && result.truncated !== undefined
    ? { preview: result.preview, truncated: result.truncated } : truncateOutput(content, ctx.truncation ?? DEFAULT_TRUNCATION, call.id);
  const saved = await ctx.toolOutputStore.put({ conversationId: conversation, ownerSessionId: ctx.toolContext?.ownerSessionId,
    runId: run, toolCallId: call.id, toolName: call.name, outcome: result.outcome, output: content, truncatedForModel: projected.truncated });
  return { ...result, preview: projected.preview, truncated: projected.truncated, fullOutputRef: saved.resultRef, toolOutputRef: saved };
}
async function executeHarnessBuiltin(call: ToolCall, ctx: ToolDispatchContext): Promise<ToolDispatchResult> {
  if (call.name === "update_todo") return executeUpdateTodo(call, ctx.state, ctx.onEvent);
  if (call.name === "ask_user") return executeAskUser(call, ctx.requestUserClarification, ctx.onEvent);
  if (call.name === CONFIRM_UNCERTAIN_EFFECT_TOOL_ID) return executeConfirmUncertainEffect(call, ctx.state, ctx.requestUserClarification, ctx.toolContext?.signal);
  if (call.name === ENTER_PLAN_MODE_TOOL_ID) return executeEnterPlanMode(call, ctx.toolContext, ctx.onEvent);
  if (call.name === WRITE_PLAN_TOOL_ID) return executeWritePlan(call, ctx.toolContext, ctx.onEvent);
  if (call.name === DELEGATE_AGENT_TOOL_ID) return executeDelegateAgent(call, ctx.agentExecutor, ctx.delegationScope, ctx.onExecutionStarted);
  if (call.name === READ_TOOL_RESULT_TOOL_ID) return executeReadToolResult(call, ctx.toolOutputStore, ctx.toolContext);
  return { outcome: "failure", category: "not_found", tool: call.name, message: `未知的 Harness 内置工具: ${call.name}` };
}
