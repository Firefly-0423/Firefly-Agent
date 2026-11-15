import { createHash } from "node:crypto";
import type { ConversationMode } from "../../../../shared/chat-types";
import type { FireflyRunOptions } from "../firefly-agent";
import type { PromptLayers } from "../../../model/prompt/prompt-layers";
import { toolRegistry, type ToolDefinition } from "../../../tooling/registry/tool-registry";
import type { VendorConfig, ChatMessage } from "../../../model/providers/types";
import { vendorConfigFromSettings } from "../../../model/providers/vendor-config";
import { prepareAgentRunRecovery } from "../../loop/run-recovery";
import { getAgentRunStore, type AgentRunRequestSnapshot } from "../../loop/run-store";
import { materializeAgentLoopStartTranscript, buildAgentLoopPromptLayers } from "./prompt-builder";
import { preparePlanRunContext } from "./plan-lifecycle";
import { app } from "electron";
import { logger, LogTag } from "../../../base/logging/logger";

const restrictedGitIds = new Set([
  "git_status", "git_init", "git_commit", "git_switch_branch", "git_push", "git_revert",
]);

export function filterToolsForConversationMode(
  conversation: ConversationMode | undefined,
  available: ToolDefinition[],
): ToolDefinition[] {
  return conversation === "code" ? available : available.filter(definition => !restrictedGitIds.has(definition.id));
}

function fingerprint(payload: unknown): string {
  const hash = createHash("sha256");
  return hash.update(JSON.stringify(payload)).digest("hex");
}

function snapshotAgentLoopRequest(
  config: FireflyRunOptions,
  layers: PromptLayers,
  available: ToolDefinition[],
): AgentRunRequestSnapshot {
  return {
    provider: config.settings.provider,
    model: config.settings.model,
    contextWindowTokens: config.settings.contextWindowTokens,
    ...(config.settings.reasoning ? { reasoning: JSON.stringify(config.settings.reasoning) } : {}),
    ...(config.conversationMode ? { mode: config.conversationMode } : {}),
    promptFingerprint: fingerprint(layers.stablePrefix),
    toolSchemaFingerprint: fingerprint(available.map(definition => ({
      id: definition.id, description: definition.description, schema: definition.inputSchema,
    })).sort((a, b) => a.id.localeCompare(b.id))),
    enabledToolIds: available.map(definition => definition.id).sort(),
    ...(config.resolvedWorkspaceRoot ? { workspaceRoot: config.resolvedWorkspaceRoot } : {}),
  };
}

export interface PreparedAgentLoopRun {
  runStore: ReturnType<typeof getAgentRunStore>;
  recovered?: ReturnType<typeof prepareAgentRunRecovery>;
  runMessages: ChatMessage[];
  systemPrompt: string;
  agentLoopPromptLayers: PromptLayers;
  promptLayers: ReturnType<typeof buildAgentLoopPromptLayers>;
  tools: ToolDefinition[];
  vendorConfig: VendorConfig;
  planState: Awaited<ReturnType<typeof preparePlanRunContext>>["planState"];
  messageId: string;
  runId: string;
  threadId: string;
}

export async function prepareAgentLoopRun(
  config: FireflyRunOptions,
  signal: AbortSignal,
): Promise<PreparedAgentLoopRun> {
  const responseId = `msg-${Date.now()}`;
  const executionId = config.runId;
  if (!executionId) throw new Error(
    "[AgentLoopAdapter] options.runId is required. FireflyAgent.runWithEvents must populate it before invoking the adapter.",
  );
  const conversationId = config.conversationId ?? "default";
  const { planState: plannedState, planContextBlock: approvedContext } = await preparePlanRunContext({ mode: config.conversationMode, threadId: conversationId });
  logger.info(LogTag.Runtime, `starting harness run, mode=${config.conversationMode ?? "work"}${plannedState ? ` plan=${plannedState}` : ""}`);
  const vendor: VendorConfig = vendorConfigFromSettings(config.settings);
  const available = [...(config.capabilities?.tools ?? config.tools ?? toolRegistry.getEnabledTools())];
  const store = getAgentRunStore(app.getPath("userData"));
  let restoration: ReturnType<typeof prepareAgentRunRecovery> | undefined;
  if (config.resumeFromRunId) {
    const stored = store.get(config.resumeFromRunId!);
    if (!stored || stored.conversationId !== conversationId) throw new Error("AGENT_RUN_RECOVERY_NOT_FOUND");
    restoration = prepareAgentRunRecovery(stored, {
      workspaceRoot: config.resolvedWorkspaceRoot,
      provider: config.settings.provider,
      model: config.settings.model,
      enabledToolIds: available.map(definition => definition.id),
    });
  }
  const incoming = config.messages.at(-1);
  const history = restoration
    ? [...restoration.messages, ...(incoming?.role === "user" ? [{ ...incoming }] : [])]
    : config.messages;
  const context = [config.recoveryContext, restoration?.recoveryContext, approvedContext].filter(Boolean).join("\n\n");
  const assembled = buildAgentLoopPromptLayers(context ? { ...config, recoveryContext: context } : config);
  const transcript = materializeAgentLoopStartTranscript({
    messages: history, runId: executionId,
    runtimeContext: assembled.runtimeContext, initialState: restoration?.state,
    kind: restoration ? "recovery" : "run_start",
  });
  const stable: PromptLayers = {
    stablePrefix: assembled.stablePrefix,
    ...(assembled.sessionPrefix ? { sessionPrefix: assembled.sessionPrefix } : {}),
    ...(assembled.mode ? { mode: assembled.mode } : {}),
  };
  const system = stable.stablePrefix;
  store.create({
    conversationId, runId: executionId, messages: transcript,
    request: snapshotAgentLoopRequest(config, stable, available),
    ...(restoration ? { state: restoration.state, cache: restoration.cache } : {}),
    ...(config.resumeFromRunId ? { resumedFromRunId: config.resumeFromRunId } : {}),
  });
  return {
    threadId: conversationId, runId: executionId, messageId: responseId,
    planState: plannedState, vendorConfig: vendor, tools: available,
    promptLayers: assembled, agentLoopPromptLayers: stable, systemPrompt: system,
    runMessages: transcript,
    ...(restoration ? { recovered: restoration } : {}),
    runStore: store,
  };
}
