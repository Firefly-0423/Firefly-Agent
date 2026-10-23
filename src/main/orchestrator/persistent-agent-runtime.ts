import path from "node:path";
import { getStorageContext } from "../storage-context";
import { getHarnessRunStore } from "./harness/run-store";
import { prepareHarnessRecovery } from "./harness/run-recovery";
import { randomUUID } from "node:crypto";
import { createModelExecutionRecorder } from "./harness/model-execution-evidence";
import type { TaskWriteEvidence, ModelExecutionEvent } from "../../shared/agent-execution-evidence";
import type { AgentProfile } from "../../shared/agent-profile";
import type { TaskDelegationPresentation, TaskSessionStatus, TaskTranscriptMessage } from "../../shared/task-session";
import { AgentSessionRegistry } from "../tasks/agent-session-registry";
import { taskCharacterLeasePool, type TaskCharacterLeasePool } from "../tasks/task-character-pool";
import type { TaskSessionStore } from "../tasks/task-session-store";
import { resolveSpecialistModelProfile, type AgentModelRoutingSettings } from "../settings/agent-model-routing";
import { buildSkillCatalog, buildAutoInjectedSkillContext } from "../skills/skill-catalog";
import { skillRegistry } from "../skills/skill-registry";
import { resolveAgentCapabilities } from "./agent-capabilities";
import { runChildSession } from "./child-session-runtime";
import type { ChildSessionParent, DelegationScope } from "./child-session-types";
import type { runFireflyHarness } from "./harness/firefly-harness";
import { createAbortError } from "../abort-utils";

export interface AgentExecuteRequest { agentId: string; prompt: string }
export interface AgentExecuteResult { agentId: string; sessionId: string; status: TaskSessionStatus; text: string; writes?: TaskWriteEvidence[]; executionEvents?: ModelExecutionEvent[]; error?: { code: string; message: string } }

export function createAgentExecutor(input: {
  parent: ChildSessionParent;
  store: TaskSessionStore;
  profiles: readonly AgentProfile[];
  modelSettings: AgentModelRoutingSettings;
  runHarness?: typeof runFireflyHarness;
  runStore?: import("./harness/run-store").HarnessRunStore;
  characterPool?: Pick<TaskCharacterLeasePool, "acquire">;
  onLifecycle?: (event: TaskDelegationPresentation) => void;
}): (request: AgentExecuteRequest, delegationScope?: DelegationScope) => Promise<AgentExecuteResult> {
  const registry = new AgentSessionRegistry(input.store);
  const modelExecutionRecorder = input.parent.modelExecutionRecorder ?? createModelExecutionRecorder(
    { domainId: randomUUID(), now: () => performance.now() }, () => undefined,
  );
  return async (request, delegationScope) => {
    if (input.parent.signal?.aborted) throw createAbortError();
    const profile = input.profiles.find(entry => entry.id === request.agentId);
    if (!profile) throw new Error("AGENT_NOT_FOUND");
    if (!request.prompt.trim()) throw new Error("AGENT_PROMPT_REQUIRED");
    const capabilities = resolveAgentCapabilities(profile, input.parent.mode, input.parent.tools, input.parent.capabilities?.skills ?? []);
    const skillBodies = new Map<string, string>();
    for (const skill of capabilities.skills) {
      if (!skill.enabled || skill.manifest?.autoInject !== true) continue;
      const body = skillRegistry.getBody(skill.id);
      if (!body?.trim()) throw new Error("AGENT_SKILL_BODY_UNAVAILABLE");
      skillBodies.set(skill.id, body);
    }
    const skillContext = buildAutoInjectedSkillContext([...capabilities.skills], id => skillBodies.get(id) ?? null);
    const model = resolveSpecialistModelProfile(input.modelSettings, profile.id, profile.modelProfile);
    // Restore only factual interruption state from the real prior run. A new run
    // receives fresh source capabilities; this audit projection authorizes no send.
    const previous = input.store.listForParent(input.parent.parentConversationId).find(session => session.agent.id === profile.id
      && session.resolvedWorkspaceRoot === (input.parent.resolvedWorkspaceRoot ? path.resolve(input.parent.resolvedWorkspaceRoot) : undefined));
    let recoverRunId: string | undefined;
    if (previous && (previous.status === "interrupted" || previous.recoveryRunId)) {
      const recoveryStore = input.runStore ?? (input.parent.backgroundMemory ? getHarnessRunStore(getStorageContext().dataRoot) : undefined);
      const priorId = previous.recoveryRunId ?? previous.childRunId;
      const priorRun = recoveryStore?.get(priorId);
      if (!priorRun) throw Error("AGENT_RECOVERY_EVIDENCE_UNAVAILABLE");
      if (priorRun.conversationId !== previous.id || priorRun.runId !== priorId) throw Error("AGENT_RECOVERY_EVIDENCE_MISMATCH");
      if (priorRun) {
        if (priorRun.status === "running" || priorRun.status === "interrupted") recoverRunId = priorId;
        const recovered = prepareHarnessRecovery({ ...priorRun, status: "interrupted" }, {
          workspaceRoot: input.parent.resolvedWorkspaceRoot, provider: model.provider, model: model.model, enabledToolIds: capabilities.tools.map(tool => tool.id),
        });
        const instructionIndex = previous.messages.map(message => message.role).lastIndexOf("user");
        const prefix = instructionIndex >= 0 ? previous.messages.slice(0, instructionIndex) : previous.messages;
        const effects = [...previous.uncertainEffects ?? []];
        for (const effect of recovered.state.uncertainEffects) {
          const existing = effects.find(entry => entry.id === effect.id);
          if (!existing) effects.push(effect);
          else if (effect.argumentsUnavailable === true) existing.argumentsUnavailable = true;
        }
        input.store.checkpoint(previous.id, {
          ...(previous.recoveryRunId ? {} : { messages: [...prefix, ...recovered.messages] as TaskTranscriptMessage[] }),
          uncertainEffects: effects, recoveryRunId: recoverRunId ?? null,
        });
      }
    }
    const lease = (input.characterPool ?? taskCharacterLeasePool).acquire(input.parent.parentConversationId, profile.nickname);
    let session;
    try {
      session = registry.acquire({
        agentId: profile.id, modelProfile: profile.modelProfile, savedModelProfileId: model.id,
        parentConversationId: input.parent.parentConversationId, parentRunId: input.parent.parentRunId,
        mode: input.parent.mode, resolvedWorkspaceRoot: input.parent.resolvedWorkspaceRoot ?? "",
        description: profile.role, prompt: request.prompt,
      });
    } catch (error) {
      lease.release();
      throw error;
    }
    const result = await runChildSession({
      ...input, session, lease, delegationScope, recoverRunId, prompt: request.prompt, description: profile.role,
      systemPrompt: [profile.systemPrompt, buildSkillCatalog([...capabilities.skills]), skillContext].filter(Boolean).join("\n\n"),
      tools: [...capabilities.tools],
      config: { totalTimeoutMs: profile.timeoutMs, ...(model.contextWindowTokens ? { contextWindowTokens: model.contextWindowTokens } : {}) },
      parent: {
        ...input.parent, capabilities, includeInteractiveTools: false, modelExecutionRecorder,
        vendorConfig: { provider: model.provider, baseUrl: model.baseUrl, model: model.model,
          apiKey: model.apiKey, explicitTransport: model.explicitTransport, reasoning: model.reasoning },
      },
    });
    return { agentId: profile.id, sessionId: result.taskId, status: result.status, text: result.text,
      ...(result.writes ? { writes: result.writes } : {}), ...(result.executionEvents ? { executionEvents: result.executionEvents } : {}),
      ...(result.error ? { error: result.error } : {}),
    };
  };
}
