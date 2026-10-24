import type { PluginAgentEvent, PluginAgentRunOptions, PluginAgentRunResult, PluginTool } from "../../plugins/api";
import type { AgentRuntime } from "../orchestrator/agent-runtime";
import { runFireflyHarness } from "../orchestrator/harness/firefly-harness";
import { mapTerminateReasonToTerminal } from "../orchestrator/harness/adapter/terminal-mapper";
import { buildHarnessPromptLayers } from "../orchestrator/harness/adapter/prompt-builder";
import { FileToolOutputStore } from "../orchestrator/harness/tool-output/file-tool-output-store";
import type { HarnessEvent } from "../orchestrator/harness/types";
import { ExecutionLedgerStore } from "../orchestrator/execution-ledger";
import { buildToolSystemPrompt } from "../orchestrator/system-prompt-builder";
import type { ToolDefinition } from "../orchestrator/tools/registry/tool-registry";
import { recordPluginCall } from "../storage/token-usage-store";
import { runWithUsageAttribution } from "../storage/usage-attribution";

const goalLedgers = new ExecutionLedgerStore();
export interface PluginAgentRunnerDeps {
  pluginId: string; pluginSignal: AbortSignal; userDataPath: string;
  agentRuntime: Pick<AgentRuntime, "buildOptions">;
  runHarness?: typeof runFireflyHarness;
  executionLedgers?: Pick<ExecutionLedgerStore, "forScope">;
  createDeadline?: (maxWallMs: number) => AbortSignal;
}
type CancellationOrigin = "external" | "plugin" | "deadline";

function checkedText(raw: unknown, name: string, limit: number): string {
  if (typeof raw !== "string") throw new Error(`${name} 必须是字符串`);
  const trimmed = raw.trim();
  if (!trimmed) throw new Error(`${name} 不能为空`);
  if (trimmed.length > limit) throw new Error(`${name} 不能超过 ${limit} 个字符`);
  return trimmed;
}
function checkedCount(raw: number | undefined, defaultCount: number, name: string, ceiling: number): number {
  const count = raw ?? defaultCount;
  if (!Number.isInteger(count) || count <= 0 || count > ceiling) throw new Error(`${name} 必须是 1-${ceiling} 的整数`);
  return count;
}
function goalLabel(identity: string, purpose: string | undefined): string {
  const title = purpose === undefined ? "goal" : checkedText(purpose, "purpose", 80);
  const safeTitle = title.replace(/[^a-zA-Z0-9._:-]+/g, "-");
  return `plugin:${identity}:${safeTitle || "goal"}`;
}

function snapshotGoalTools(identity: string, candidates: ReadonlyArray<PluginTool>): ToolDefinition[] {
  if (!Array.isArray(candidates) || candidates.length === 0) throw new Error("tools 必须是非空数组");
  const namespace = `${identity}_`;
  const knownIds = new Set<string>();
  const frozen = Object.freeze([...candidates]);
  return frozen.map((candidate): ToolDefinition => {
    if (!candidate || typeof candidate !== "object") throw new Error("tools 含有无效工具");
    if (!candidate.id.startsWith(namespace)) throw new Error(`目标工具 id 必须以 ${namespace} 开头: ${candidate.id}`);
    if (knownIds.has(candidate.id)) throw new Error(`目标工具 id 重复: ${candidate.id}`);
    knownIds.add(candidate.id);
    if (candidate.enabled !== true) throw new Error(`目标工具必须启用: ${candidate.id}`);
    if (candidate.inputSchema?.type !== "object" || !candidate.inputSchema.properties || typeof candidate.inputSchema.properties !== "object") {
      throw new Error(`目标工具 inputSchema 必须是带 properties 的 object: ${candidate.id}`);
    }
    if (!candidate.effectKind || candidate.effectKind === "unknown") throw new Error(`目标工具必须显式声明非 unknown 的 effectKind: ${candidate.id}`);
    if (typeof candidate.execute !== "function") throw new Error(`目标工具 execute 必须是函数: ${candidate.id}`);
    return {
      id: candidate.id, name: candidate.name, description: candidate.description,
      ...(candidate.catalogHint ? { catalogHint: candidate.catalogHint } : {}),
      ...(candidate.category ? { category: candidate.category } : {}),
      ...(candidate.capability ? { capability: candidate.capability } : {}),
      enabled: true,
      ...(candidate.risk ? { risk: candidate.risk } : {}),
      ...(candidate.modes ? { modes: [...candidate.modes] } : {}),
      inputSchema: { type: "object", properties: candidate.inputSchema.properties,
        ...(candidate.inputSchema.required ? { required: [...candidate.inputSchema.required] } : {}) },
      ...(candidate.needsContext ? { needsContext: true } : {}),
      ...(candidate.ledgerPolicy ? { ledgerPolicy: candidate.ledgerPolicy } : {}),
      ...(candidate.deprecated ? { deprecated: true } : {}),
      effectKind: candidate.effectKind,
      ...(candidate.verificationPolicy ? { verificationPolicy: candidate.verificationPolicy } : {}),
      execute: candidate.execute,
    };
  });
}

function emitEvent(callback: PluginAgentRunOptions["onEvent"], notification: PluginAgentEvent): void {
  try { callback?.(notification); }
  catch (failure) { console.warn("[plugin-agent] 插件进度回调失败，已忽略", failure); }
}
function progressProjector(callback: PluginAgentRunOptions["onEvent"], names: Map<string, string>) {
  return (notification: HarnessEvent): void => {
    switch (notification.type) {
      case "round_start": {
        const ordinal = Number(notification.roundId.replace(/^round-/, ""));
        emitEvent(callback, { kind: "round_started", round: Number.isFinite(ordinal) ? ordinal + 1 : 0 });
        break;
      }
      case "tool_start":
        names.set(notification.toolCallId, notification.toolName);
        emitEvent(callback, { kind: "tool_started", toolName: notification.toolName });
        break;
      case "tool_end": {
        const name = names.get(notification.toolCallId) ?? "unknown";
        names.delete(notification.toolCallId);
        emitEvent(callback, { kind: "tool_finished", toolName: name, ok: notification.outcome === "success" });
        break;
      }
    }
  };
}
function cancellationState(external: AbortSignal | undefined, plugin: AbortSignal, deadline: AbortSignal) {
  let earliest: CancellationOrigin | undefined;
  const candidates: Array<readonly [CancellationOrigin, AbortSignal]> = [];
  if (external) candidates.push(["external", external]);
  candidates.push(["plugin", plugin], ["deadline", deadline]);
  for (const [origin, cancellation] of candidates) {
    const remember = (): void => { earliest ??= origin; };
    if (cancellation.aborted) remember();
    else cancellation.addEventListener("abort", remember, { once: true });
  }
  return { signal: AbortSignal.any(candidates.map((entry) => entry[1])), origin: () => earliest };
}

export function createPluginAgentRunner(deps: PluginAgentRunnerDeps): NonNullable<import("../../plugins/api").PluginLlmService["runGoal"]> {
  const executeHarness = deps.runHarness ?? runFireflyHarness;
  const ledgerProvider = deps.executionLedgers ?? goalLedgers;
  return async (request) => {
    const identifier = checkedText(request.runId, "runId", 128);
    const objective = checkedText(request.goal, "goal", 8_000);
    const roundBudget = checkedCount(request.maxRounds, 50, "maxRounds", 1_000);
    const timeBudget = checkedCount(request.maxWallMs, 15 * 60_000, "maxWallMs", 24 * 60 * 60_000);
    const goalTools = snapshotGoalTools(deps.pluginId, request.tools);
    const diagnostic = goalLabel(deps.pluginId, request.purpose);
    const expiry = deps.createDeadline?.(timeBudget) ?? AbortSignal.timeout(timeBudget);
    const cancellation = cancellationState(request.signal, deps.pluginSignal, expiry);
    const prepared = await deps.agentRuntime.buildOptions({
      sessionId: `plugin:${deps.pluginId}`, workspaceBindingSessionId: null,
      executionMode: "work", mode: "work", promptSource: "plugin-agent", promptChannel: "minecraft",
      messages: [{ role: "user", content: objective }],
    });
    const toolPrompt = buildToolSystemPrompt("work", goalTools);
    const layers = buildHarnessPromptLayers({ ...prepared.options, conversationMode: "work", toolSystemContent: toolPrompt, tools: goalTools });
    const callNames = new Map<string, string>();
    console.info("[plugin-agent] 无头任务开始", { label: diagnostic, runId: identifier });
    recordPluginCall(deps.pluginId);
    const outcome = await runWithUsageAttribution({ feature: "plugin", pluginId: deps.pluginId }, () => executeHarness({
      systemPrompt: layers.stablePrefix, promptLayers: layers, usageParts: layers.usageParts,
      messages: prepared.options.messages, runId: identifier, tools: goalTools,
      vendorConfig: {
        provider: prepared.options.settings.provider, baseUrl: prepared.options.settings.baseUrl,
        model: prepared.options.settings.model, apiKey: prepared.options.settings.apiKey,
        explicitTransport: prepared.options.settings.explicitTransport, reasoning: prepared.options.settings.reasoning,
      },
      config: { maxRounds: roundBudget, maxParallelToolCalls: 1, totalTimeoutMs: timeBudget,
        contextWindowTokens: prepared.options.settings.contextWindowTokens },
      signal: cancellation.signal,
      onEvent: (event) => progressProjector(request.onEvent, callNames)(event),
      includeInteractiveTools: false, planState: undefined, agentExecutor: undefined, checkPermission: async () => true,
      toolContext: { userQuery: objective, conversationId: `plugin:${deps.pluginId}`, runId: identifier,
        signal: cancellation.signal, mode: "work", permissionMode: "allow_all", metadata: { pluginAgentDiagnosticLabel: diagnostic } },
      toolOutputStore: new FileToolOutputStore(deps.userDataPath), executionLedger: ledgerProvider.forScope(identifier),
    }));
    const completion = cancellation.origin() === "deadline"
      ? { status: "timeout" as const, reason: "timeout", externalEffectsMayContinue: true }
      : outcome.terminal ?? mapTerminateReasonToTerminal(outcome.terminateReason, outcome.finalState.uncertainEffects.length > 0, outcome.failure);
    console.info("[plugin-agent] 无头任务结束", { label: diagnostic, runId: identifier, status: completion.status });
    return { text: outcome.finalAnswer, terminal: completion, rounds: outcome.rounds } as PluginAgentRunResult;
  };
}