import { app } from "electron";
import type { BaseEvent } from "@ag-ui/core";
import type { ApprovalOrigin } from "../../../../shared/permission-approval";
import type { ToolDefinition } from "../../tools/registry/tool-registry";
import { toolRegistry } from "../../tools/registry/tool-registry";
import { checkPermission, getCurrentLevel, type ToolRiskLevel } from "../../../permission";
import { policyFor } from "../../../permission-policy";
import { isPlanReadOnly } from "../../plan-mode";
import { contextRefRegistry, extractLastUserQuery, type ToolContext } from "../../tools/registry/tool-context";
import type { HarnessInput } from "../index";
import { getTaskSessionStore } from "../../../tasks/task-session-store";
import { createAgentExecutor } from "../../persistent-agent-runtime";
import { createSpecialistProfiles } from "../../specialist-profiles";
import { loadModelSettings } from "../../../settings/model-settings";
import { FileToolOutputStore } from "../tool-output/file-tool-output-store";
import { sendTaskLifecycleAsAgui } from "./event-mapper";
import type { PreparedHarnessRun } from "./run-preparation";
import { getWorkspaceExecutionCoordinator } from "../execution-coordinator";
import type { FireflyRunOptions } from "../../firefly-agent";

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
  checkPermission: NonNullable<HarnessInput["checkPermission"]>;
  toolOutputStore: FileToolOutputStore;
  agentExecutor: HarnessInput["agentExecutor"];
  agentDefinitions: HarnessInput["agentDefinitions"];
}

type ToolRuntimeInput = {
  sendBaseEvent: (event: BaseEvent) => void;
  prepared: PreparedHarnessRun;
  options: FireflyRunOptions;
  signal: AbortSignal;
};

export function prepareToolRuntime(input: ToolRuntimeInput): PreparedToolRuntime {
  const { options, prepared } = input;
  const owner = new AbortController();
  const signal = AbortSignal.any([input.signal, owner.signal]);
  const quiesceExecution = () => owner.abort();
  const { threadId, runId, systemPrompt, vendorConfig, tools } = prepared;
  // 会话权限由可信设置捕获一次；随后全局档位只能进一步限制，不能扩大该快照。
  const fileAccessLevel = options.permissionMode === "allow_all" ? "full" : getCurrentLevel();
  const permissionCheck: NonNullable<HarnessInput["checkPermission"]> = async (
    toolId: string,
    args: Record<string, unknown>,
    invocationSignal?: AbortSignal,
    origin?: ApprovalOrigin,
  ): Promise<boolean> => {
    const tool = toolRegistry.getById(toolId);
    if (!tool) return false;
    const risk: ToolRiskLevel = (tool as ToolDefinition & { risk?: ToolRiskLevel }).risk ?? "safe";
    const blockedByPlan = (): boolean => isPlanReadOnly(threadId)
      && (risk === "shell" || policyFor("read-only", risk) !== "allow");
    // 计划限制先于显式免审批授权，并使用父会话实时状态，覆盖会话中途进入计划模式。
    if (blockedByPlan()) {
      console.log(`[HarnessAdapter] [Plan] read-only enforcement blocked tool=${toolId} risk=${risk}`);
      return false;
    }
    if (policyFor(fileAccessLevel, risk) === "deny") return false;
    if (options.permissionMode === "allow_all") return true;
    const requestSignal = invocationSignal && invocationSignal !== signal ? AbortSignal.any([signal, invocationSignal]) : signal;
    const decision = await checkPermission({ toolId, toolName: tool.name, toolDescription: tool.description, args, risk, runId, origin, signal: requestSignal, level: fileAccessLevel });
    // 等待用户审批期间也可能进入计划讨论，批准单次工具不能解除计划限制。
    return decision.allowed && !blockedByPlan();
  };

  const executionCoordinator = options.resolvedWorkspaceRoot
    ? getWorkspaceExecutionCoordinator(options.resolvedWorkspaceRoot) : undefined;
  const revalidateToolPermission: NonNullable<ToolContext["revalidateToolPermission"]> = (toolId, _args, approvalRequired) => {
    const tool = tools.find(candidate => candidate.id === toolId) ?? toolRegistry.getById(toolId);
    if (!tool) return false;
    const risk = tool.risk ?? "safe";
    if (isPlanReadOnly(threadId) && (risk === "shell" || policyFor("read-only", risk) !== "allow")) return false;
    if (options.permissionMode === "allow_all") return true;
    const policies = [policyFor(fileAccessLevel, risk), policyFor(getCurrentLevel(), risk)];
    return !policies.includes("deny") && (!policies.includes("ask") || approvalRequired);
  };
  const conversationId = options.conversationId ?? "default";
  const toolContext: ToolContext = {
    userQuery: extractLastUserQuery(options.messages), conversationId, runId, contextRefs: contextRefRegistry,
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
  const agentExecutor = options.conversationMode === "work" || options.conversationMode === "code"
    ? createAgentExecutor({
      profiles,
      modelSettings: loadModelSettings(),
      parent: {
        backgroundMemory: options.backgroundMemory, memoryRun: options.memoryRun, parentConversationId: threadId, parentRunId: runId,
        mode: options.conversationMode, capabilities: options.capabilities, systemPrompt, vendorConfig, tools,
        resolvedWorkspaceRoot: options.resolvedWorkspaceRoot, signal, checkPermission: permissionCheck,
        includeInteractiveTools: options.harnessInteractiveTools, permissionMode: options.permissionMode,
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
