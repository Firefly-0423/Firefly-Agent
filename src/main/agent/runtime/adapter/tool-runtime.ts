import { app } from "electron";
import type { BaseEvent } from "@ag-ui/core";
import type { ApprovalOrigin } from "../../../../shared/permission-approval";
import type { ToolDefinition } from "../../../tooling/registry/tool-registry";
import { toolRegistry } from "../../../tooling/registry/tool-registry";
import { checkPermission, getCurrentLevel, type ToolRiskLevel } from "../../../platform/permission/permission";
import { policyForTool } from "../../../platform/permission/permission-policy";
import { isPlanReadOnly } from "../../tools/plan-mode";
import { contextRefRegistry, extractLastUserQuery, type ToolContext } from "../../../tooling/registry/tool-context";
import type { AgentLoopInput } from "../../loop/index";
import { getTaskSessionStore } from "../../tasks/task-session-store";
import { createAgentExecutor } from "../persistent-agent-runtime";
import { createSpecialistProfiles } from "../specialist-profiles";
import { loadModelSettings } from "../../../model/config/model-settings";
import { FileToolOutputStore } from "../../loop/tool-output/file-tool-output-store";
import { sendTaskLifecycleAsAgui } from "./event-mapper";
import type { PreparedAgentLoopRun } from "./run-preparation";
import { getWorkspaceExecutionCoordinator } from "../../../tooling/execution/execution-coordinator";
import type { FireflyRunOptions } from "../firefly-agent";
import { logger, LogTag } from "../../../base/logging/logger";

/**
 * 为一次 Harness run 构造工具运行时（tool runtime）。
 * Main owns one internal stop controller. Its composite signal preserves external
 * cancellation and is shared by Harness, tools, approvals and delegated children.
 */
export interface PreparedToolRuntime {
  signal: AbortSignal;
  /** Stop only this Main execution's owned work before error/cancellation drain. */
  quiesceExecution: () => void;
  toolContext: ToolContext;
  checkPermission: NonNullable<AgentLoopInput["checkPermission"]>;
  toolOutputStore: FileToolOutputStore;
  agentExecutor: AgentLoopInput["agentExecutor"];
  agentDefinitions: AgentLoopInput["agentDefinitions"];
}

type ToolRuntimeInput = {
  sendBaseEvent: (event: BaseEvent) => void;
  prepared: PreparedAgentLoopRun;
  options: FireflyRunOptions;
  signal: AbortSignal;
};

const DESCRIBE_APPROVAL_TIMEOUT_MS = 1_000;

async function resolvePluginApprovalTarget(
  tool: ToolDefinition,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string | undefined> {
  if (!tool.describeApproval || signal.aborted) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const described = await Promise.race([
      Promise.resolve(tool.describeApproval(args, controller.signal)).catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve(null);
        }, DESCRIBE_APPROVAL_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
    if (!described || typeof described.summary !== "string" || !described.summary.trim()) return undefined;
    const summary = described.summary.trim();
    const target = typeof described.target === "string" ? described.target.trim() : "";
    return target ? `${summary} — ${target}` : summary;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

export function prepareToolRuntime(input: ToolRuntimeInput): PreparedToolRuntime {
  const { options, prepared } = input;
  const owner = new AbortController();
  const signal = AbortSignal.any([input.signal, owner.signal]);
  const quiesceExecution = () => owner.abort();
  const { threadId, runId, systemPrompt, vendorConfig, tools } = prepared;
  // 会话权限由可信设置捕获一次；随后全局档位只能进一步限制，不能扩大该快照。
  const fileAccessLevel = options.permissionMode === "allow_all" ? "full" : getCurrentLevel();
  const permissionCheck: NonNullable<AgentLoopInput["checkPermission"]> = async (
    toolId: string,
    args: Record<string, unknown>,
    invocationSignal?: AbortSignal,
    origin?: ApprovalOrigin,
  ): Promise<boolean> => {
    const tool = tools.find(candidate => candidate.id === toolId) ?? toolRegistry.getById(toolId);
    if (!tool) return false;
    const risk: ToolRiskLevel = (tool as ToolDefinition & { risk?: ToolRiskLevel }).risk ?? "safe";
    const policyTarget = { risk, risks: tool.risks, isPlugin: Boolean(tool.pluginMeta) };
    const blockedByPlan = (): boolean => isPlanReadOnly(threadId)
      && (risk === "shell" || policyForTool("read-only", policyTarget) !== "allow");
    // 计划限制先于显式免审批授权，并使用父会话实时状态，覆盖会话中途进入计划模式。
    if (blockedByPlan()) {
      logger.info(LogTag.Runtime, `plan: read-only enforcement blocked tool=${toolId} risk=${risk}`);
      return false;
    }
    if (policyForTool(fileAccessLevel, policyTarget) === "deny") return false;
    if (options.permissionMode === "allow_all") return true;
    const policies = [policyForTool(fileAccessLevel, policyTarget), policyForTool(getCurrentLevel(), policyTarget)];
    if (!runId || options.approvals === "refuse") {
      // 与权限宿主取更严判定的规则一致：只有真正要问用户的审批才需要所属运行。
      // 桌面上没人能回答的运行（插件 model.run）也一样：要审批的操作直接拒绝，不挂起等待。
      if (!policies.includes("deny") && policies.includes("ask")) return false;
    }
    const requestSignal = invocationSignal && invocationSignal !== signal ? AbortSignal.any([signal, invocationSignal]) : signal;
    const needsPrompt = !policies.includes("deny") && policies.includes("ask");
    const approvalTarget = needsPrompt && tool.describeApproval
      ? await resolvePluginApprovalTarget(tool, args, requestSignal)
      : undefined;
    const decision = await checkPermission({
      toolId,
      toolName: tool.name,
      toolDescription: tool.description,
      args,
      risk,
      ...(approvalTarget ? { approvalTarget } : {}),
      ...(tool.risks?.length ? { risks: tool.risks } : {}),
      ...(tool.pluginMeta ? { isPlugin: true, declaredBy: tool.pluginMeta.pluginName } : {}),
      runId,
      origin,
      signal: requestSignal,
      level: fileAccessLevel,
    });
    // 等待用户审批期间也可能进入计划讨论，批准单次工具不能解除计划限制。
    return decision.allowed && !blockedByPlan();
  };

  const executionCoordinator = options.resolvedWorkspaceRoot
    ? getWorkspaceExecutionCoordinator(options.resolvedWorkspaceRoot) : undefined;
  const revalidateToolPermission: NonNullable<ToolContext["revalidateToolPermission"]> = (toolId, _args, approvalRequired) => {
    const tool = tools.find(candidate => candidate.id === toolId) ?? toolRegistry.getById(toolId);
    if (!tool) return false;
    const risk = tool.risk ?? "safe";
    const policyTarget = { risk, risks: tool.risks, isPlugin: Boolean(tool.pluginMeta) };
    if (isPlanReadOnly(threadId) && (risk === "shell" || policyForTool("read-only", policyTarget) !== "allow")) return false;
    if (options.permissionMode === "allow_all") return true;
    const policies = [policyForTool(fileAccessLevel, policyTarget), policyForTool(getCurrentLevel(), policyTarget)];
    return !policies.includes("deny") && (!policies.includes("ask") || approvalRequired);
  };
  const conversationId = options.conversationId ?? "default";
  const toolContext: ToolContext = {
    userQuery: extractLastUserQuery(options.messages), conversationId, runId, caller: "firefly", contextRefs: contextRefRegistry,
    signal, resolvedWorkspaceRoot: options.resolvedWorkspaceRoot, mode: options.conversationMode,
    workReadScopes: options.workReadScopes, allowedSkillIds: options.capabilities?.skillIds,
    permissionMode: options.permissionMode, fileAccessLevel, revalidateToolPermission,
    ...(executionCoordinator ? { execution: { coordinator: executionCoordinator, scope: {
      workspaceId: executionCoordinator.workspaceId, parentRunId: runId, groupId: runId,
      agentId: "main", childRunId: runId, toolCallId: runId,
    } } } : {}),
  };
  const toolOutputStore = new FileToolOutputStore(app.getPath("userData"));
  // 只有 work/code 模式允许派生任务；chat 模式不创建 TaskSession，避免出现不可见的后台执行。
  const profiles = createSpecialistProfiles(options.conversationMode ?? "chat", tools, options.capabilities?.skills ?? []);
  const agentExecutor = options.allowDelegation !== false && (options.conversationMode === "work" || options.conversationMode === "code")
    ? createAgentExecutor({
      profiles,
      modelSettings: loadModelSettings(),
      parent: {
        backgroundMemory: options.backgroundMemory, memoryRun: options.memoryRun, parentConversationId: threadId, parentRunId: runId,
        mode: options.conversationMode, capabilities: options.capabilities, systemPrompt, vendorConfig, tools,
        resolvedWorkspaceRoot: options.resolvedWorkspaceRoot, signal, checkPermission: permissionCheck,
        includeInteractiveTools: options.interactiveTools, permissionMode: options.permissionMode,
        fileAccessLevel, toolOutputStore, workReadScopes: options.workReadScopes, executionCoordinator, revalidateToolPermission,
      },
      store: getTaskSessionStore(app.getPath("userData")),
      runStore: prepared.runStore,
      onLifecycle: (event) => sendTaskLifecycleAsAgui(event, threadId, runId, input.sendBaseEvent),
    })
    : undefined;

  return { signal, quiesceExecution, toolContext, checkPermission: permissionCheck, toolOutputStore, agentExecutor,
    agentDefinitions: profiles.map(({ id, nickname, description }) => ({ id, nickname, description })) };
}
