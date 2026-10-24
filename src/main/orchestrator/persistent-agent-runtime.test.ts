import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentProfile } from "../../shared/agent-profile";
import { TaskSessionStore } from "../tasks/task-session-store";
import { createAgentExecutor } from "./persistent-agent-runtime";
import type { HarnessInput, HarnessResult } from "./harness/types";
import type { ChildSessionParent } from "./child-session-types";
import type { ToolDefinition } from "./tools/registry/tool-registry";
import type { SkillEntry } from "../skills/types";
import { skillRegistry } from "../skills/skill-registry";
import { FileToolOutputStore } from "./harness/tool-output/file-tool-output-store";
import { dispatchToolCall } from "./harness/tool-dispatcher";

const roots: string[] = [];
const profile: AgentProfile = {
  id: "test-agent", nickname: "艾利欧", role: "Test review", description: "Test review", systemPrompt: "Fixture specialist identity",
  modelProfile: "coding", allowedToolIds: ["read_file"], allowedSkillIds: [], supportedModes: ["code"],
  persistent: true, timeoutMs: 0, maxConcurrency: 1,
};
const models = {
  modelProfiles: [{ id: "saved-code", provider: "fixture", baseUrl: "http://127.0.0.1:12345", model: "fixture-model", apiKey: "", contextWindowTokens: 64000 }],
  agentModelProfiles: { coding: "saved-code" },
};
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-persistent-agent-"));
  roots.push(root);
  const read: ToolDefinition = { id: "read_file", name: "read", description: "fixture", enabled: true,
    inputSchema: { type: "object", properties: {} }, execute: async () => "fixture", effectKind: "read" };
  const parent: ChildSessionParent = {
    parentConversationId: "conversation", parentRunId: "run", mode: "code", systemPrompt: "parent persona",
    vendorConfig: { provider: "fixture", model: "parent-model", baseUrl: "http://127.0.0.1:12345", apiKey: "" },
    tools: [read], resolvedWorkspaceRoot: root, checkPermission: vi.fn(async () => false), includeInteractiveTools: false,
  };
  return { store: new TaskSessionStore(root), parent, read };
}
function complete(input: HarnessInput): Promise<HarnessResult> {
  const state = { todoItems: [], uncertainEffects: [] };
  input.onCheckpoint?.({ messages: [...input.messages, { role: "assistant", content: "fixture result" }], state,
    toolOutputs: [], rounds: 1, cache: { cacheEpoch: 1, epochReason: "run_start" }, at: 1 });
  return Promise.resolve({ finalAnswer: "fixture result", finalState: state, terminated: false,
    rounds: 1, terminal: { status: "success", externalEffectsMayContinue: false } });
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("persistent specialist runtime", () => {
  it("isolates real dispatched results by persistent owner across workspaces and resumes", async () => {
    const { store, parent, read } = setup();
    const outputs = new FileToolOutputStore(parent.resolvedWorkspaceRoot!);
    const contexts: NonNullable<HarnessInput["toolContext"]>[] = [];
    const refs: string[] = [];
    const runHarness = async (input: HarnessInput) => {
      contexts.push(input.toolContext!);
      const result = await dispatchToolCall({ id: "owned-read", name: read.id,
        arguments: JSON.stringify({ ownerSessionId: "forged-owner" }) }, {
        state: { todoItems: [], uncertainEffects: [] }, tools: input.tools,
        toolContext: input.toolContext, toolOutputStore: input.toolOutputStore,
      });
      refs.push(result.fullOutputRef!);
      return complete(input);
    };
    const firstExecutor = createAgentExecutor({ store, parent: { ...parent, toolOutputStore: outputs },
      profiles: [profile], modelSettings: models, runHarness });
    const first = await firstExecutor({ agentId: profile.id, prompt: "first" });
    const sibling = { ...profile, id: "second-agent" };
    const second = await createAgentExecutor({ store,
      parent: { ...parent, resolvedWorkspaceRoot: path.join(parent.resolvedWorkspaceRoot!, "other"), toolOutputStore: outputs },
      profiles: [sibling], modelSettings: models, runHarness })({ agentId: sibling.id, prompt: "second" });
    await firstExecutor({ agentId: profile.id, prompt: "resume" });
    expect(contexts[0].conversationId).toBe(parent.parentConversationId);
    expect(contexts[0].ownerSessionId).toBe(first.sessionId);
    expect(contexts[1].ownerSessionId).toBe(second.sessionId);
    expect(contexts[2].ownerSessionId).toBe(first.sessionId);
    expect(contexts[2].runId).not.toBe(contexts[0].runId);
    const fetch = (context: NonNullable<HarnessInput["toolContext"]>, resultRef: string, query?: string) =>
      dispatchToolCall({ id: "fetch", name: "read_tool_result", arguments: JSON.stringify({
        result_ref: resultRef, query, ownerSessionId: first.sessionId,
      }) }, { state: { todoItems: [], uncertainEffects: [] }, tools: [], toolContext: context, toolOutputStore: outputs });
    for (const query of [undefined, "fixture"]) {
      expect(await fetch(contexts[2], refs[0], query)).toMatchObject({ outcome: "success" });
      expect(await fetch(contexts[1], refs[0], query)).toMatchObject({ outcome: "failure", category: "not_found" });
      expect(await fetch(contexts[0], refs[1], query)).toMatchObject({ outcome: "failure", category: "not_found" });
      expect(await fetch({ userQuery: "", conversationId: parent.parentConversationId }, refs[0], query))
        .toMatchObject({ outcome: "success" });
    }
    await outputs.deleteConversation(parent.parentConversationId);
    for (const ref of refs) expect(await fetch(contexts[2], ref)).toMatchObject({ outcome: "failure", category: "not_found" });
  });
  it("does not append a prompt or invoke a child after parent cancellation", async () => {
    const { store, parent } = setup();
    const controller = new AbortController();
    controller.abort();
    const runHarness = vi.fn(complete);
    const execute = createAgentExecutor({ parent: { ...parent, signal: controller.signal }, store,
      profiles: [profile], modelSettings: models, runHarness });
    await expect(execute({ agentId: profile.id, prompt: "fixture" })).rejects.toMatchObject({ name: "AbortError" });
    expect(runHarness).not.toHaveBeenCalled();
    expect(store.listForParent(parent.parentConversationId)).toEqual([]);
  });
  it("injects only authorized automatic Skill bodies and inherits confirmed read scopes", async () => {
    const { store, parent, read } = setup();
    const skill: SkillEntry = {
      id: "fixture-auto", name: "fixture-auto", description: "fixture", enabled: true, source: "user",
      dirPath: parent.resolvedWorkspaceRoot!, bodyPath: path.join(parent.resolvedWorkspaceRoot!, "SKILL.md"), references: [],
      modes: ["code"], effectKind: "read",
      manifest: { id: "fixture-auto", version: "1.0.0", defaultEnabled: true, entry: "", dependencies: [], autoInject: true },
    };
    fs.writeFileSync(skill.bodyPath, "---\nname: fixture-auto\ndescription: fixture\n---\nAuthorized fixture rules");
    skillRegistry.register(skill);
    const runHarness = vi.fn(complete);
    const scopes = [{ name: "fixture", path: path.join(parent.resolvedWorkspaceRoot!, "public.txt"), sha256: "a".repeat(64), totalLines: 10, endLine: 2, partialAccepted: true }];
    try {
      const execute = createAgentExecutor({ store, parent: { ...parent, workReadScopes: scopes,
        capabilities: { mode: "code", tools: [read], toolIds: new Set([read.id]), skills: [skill], skillIds: new Set([skill.id]) } },
        profiles: [{ ...profile, allowedSkillIds: [skill.id] }], modelSettings: models, runHarness });
      await execute({ agentId: profile.id, prompt: "fixture" });
      expect(runHarness.mock.calls[0][0].systemPrompt).toContain("Authorized fixture rules");
      expect(runHarness.mock.calls[0][0].toolContext?.workReadScopes).toEqual(scopes);
      expect(runHarness.mock.calls[0][0].allowedBuiltinToolIds).toEqual(new Set(["update_todo", "read_tool_result"]));
    } finally {
      skillRegistry.unregister(skill.id);
    }
  });
  it("reuses one private transcript and selected model while inheriting permission boundaries", async () => {
    const { store, parent, read } = setup();
    const runHarness = vi.fn(complete);
    const lifecycle = vi.fn();
    const execute = createAgentExecutor({ parent, store, profiles: [profile], modelSettings: models, runHarness, onLifecycle: lifecycle });
    const first = await execute({ agentId: profile.id, prompt: "Inspect fixture" });
    const second = await execute({ agentId: profile.id, prompt: "Continue inspection" });
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.agentId).toBe(profile.id);
    expect(store.listForParent(parent.parentConversationId)).toHaveLength(1);
    expect(runHarness.mock.calls[1][0].messages.map(message => message.content))
      .toEqual(["Inspect fixture", "fixture result", "Continue inspection"]);
    expect(runHarness).toHaveBeenCalledWith(expect.objectContaining({
      tools: [read], vendorConfig: expect.objectContaining({ model: "fixture-model" }),
      config: expect.objectContaining({ contextWindowTokens: 64000 }),
      checkPermission: expect.any(Function), includeInteractiveTools: false,
      toolContext: expect.objectContaining({ allowedSkillIds: new Set() }),
    }));
    // The child asks through the parent's checker (so the parent's decision still binds it) and tags itself.
    const childCheck = runHarness.mock.calls[0][0].checkPermission!;
    expect(await childCheck("read_file", { path: "x" }, undefined, { toolCallId: "call-1" })).toBe(false);
    expect(parent.checkPermission).toHaveBeenCalledWith("read_file", { path: "x" }, undefined, expect.objectContaining({
      toolCallId: "call-1", agentId: profile.id, childRunId: expect.any(String),
    }));
    expect(runHarness.mock.calls[0][0].systemPrompt).not.toContain("parent persona");
    expect(runHarness.mock.calls[0][0].agentExecutor).toBeUndefined();
    expect(lifecycle.mock.calls.map(([event]) => event.status)).toEqual(["running", "completed", "running", "completed"]);
  });

  it("rejects unknown agents and absent model routes before persistence or Harness execution", async () => {
    const { store, parent } = setup();
    const runHarness = vi.fn(complete);
    const execute = createAgentExecutor({ parent, store, profiles: [profile], modelSettings: {}, runHarness });
    await expect(execute({ agentId: "missing", prompt: "fixture" })).rejects.toThrow("AGENT_NOT_FOUND");
    await expect(execute({ agentId: profile.id, prompt: "fixture" })).rejects.toThrow("AGENT_MODEL_ROUTE_UNCONFIGURED");
    expect(runHarness).not.toHaveBeenCalled();
    expect(store.listForParent(parent.parentConversationId)).toEqual([]);
  });

  it("inherits cancellation and releases the character lease after a cancelled run", async () => {
    const { store, parent } = setup();
    const controller = new AbortController();
    const cancelled = vi.fn(async (input: HarnessInput): Promise<HarnessResult> => {
      expect(input.signal?.aborted).toBe(false);
      controller.abort();
      return { finalAnswer: "", finalState: { todoItems: [], uncertainEffects: [] }, terminated: false,
        rounds: 0, terminal: { status: "cancelled", externalEffectsMayContinue: false } };
    });
    const execute = createAgentExecutor({ parent: { ...parent, signal: controller.signal }, store,
      profiles: [profile], modelSettings: models, runHarness: cancelled });
    const first = await execute({ agentId: profile.id, prompt: "fixture" });
    expect(first.status).toBe("cancelled");
    const next = createAgentExecutor({ parent, store, profiles: [profile], modelSettings: models, runHarness: complete });
    expect((await next({ agentId: profile.id, prompt: "resume fixture" })).status).toBe("completed");
  });
});

it("late_settlement_keeps_lease_and_evidence_before_child_terminal", async () => {
  const { RunExecutionCoordinator } = await import("./harness/execution-coordinator");
  const { store, parent } = setup(), coordinator = new RunExecutionCoordinator(parent.resolvedWorkspaceRoot!);
  let release!: () => void, entered!: () => void, leaseReleased = false;
  const actual = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const controller = new AbortController();
  const execute = createAgentExecutor({ parent: { ...parent, executionCoordinator: coordinator, signal: controller.signal }, store,
    profiles: [profile], modelSettings: models, characterPool: { acquire: () => ({ nickname: "fixture", assetFileName: "fixture.png", release: () => { leaseReleased = true; } }) } as any,
    runHarness: async input => {
      const scope = input.toolContext!.execution?.scope ?? { workspaceId: coordinator.workspaceId, parentRunId: parent.parentRunId, groupId: "group", agentId: profile.id, childRunId: input.runId!, toolCallId: "delegate" };
      void coordinator.runLeaf({ ...scope, toolCallId: "slow-write" }, "exclusive", input.signal, async permit => {
        entered(); await actual;
        coordinator.recordWriteEvidence(permit, { path: "fixture.txt", canonicalPath: path.join(parent.resolvedWorkspaceRoot!, "fixture.txt"),
          agentId: profile.id, childRunId: scope.childRunId, toolCallId: "slow-write", state: "applied", after: { sha256: "a".repeat(64) }, eventIds: ["settled-write"] });
      }).catch(() => undefined);
      await started; controller.abort();
      return { finalAnswer: "", finalState: { todoItems: [], uncertainEffects: [] }, terminated: true, rounds: 0,
        terminal: { status: "cancelled", externalEffectsMayContinue: true } };
    } });
  const pending = execute({ agentId: profile.id, prompt: "write fixture" }, { groupId: "group", toolCallId: "delegate" });
  await started; await new Promise<void>(setImmediate);
  try {
    expect(leaseReleased).toBe(false);
    expect(store.listForParent(parent.parentConversationId)[0].status).toBe("running");
  } finally { release(); }
  const result = await pending;
  expect(leaseReleased).toBe(true); expect(result.status).toBe("cancelled");
  expect(result.writes).toEqual([expect.objectContaining({ state: "applied", toolCallId: "slow-write" })]);
});

it("conflict_returns_failed_child_with_prior_writes_and_preserves_sibling_success", async () => {
  const { RunExecutionCoordinator } = await import("./harness/execution-coordinator");
  const { store, parent } = setup(), coordinator = new RunExecutionCoordinator(parent.resolvedWorkspaceRoot!);
  const sibling = { ...profile, id: "sibling-agent", nickname: "卡芙卡" };
  let conflictSignal: AbortSignal | undefined;
  const execute = createAgentExecutor({ parent: { ...parent, executionCoordinator: coordinator }, store,
    profiles: [profile, sibling], modelSettings: models, runHarness: async input => {
      const execution = input.toolContext!.execution!, scope = execution.scope;
      if (scope.agentId === sibling.id) return complete(input);
      conflictSignal = input.signal;
      await coordinator.runLeaf({ ...scope, toolCallId: "prior-write" }, "exclusive", input.signal, async permit => {
        coordinator.recordWriteEvidence(permit, { path: "prior.txt", canonicalPath: path.join(parent.resolvedWorkspaceRoot!, "prior.txt"), agentId: profile.id,
          childRunId: scope.childRunId, toolCallId: "prior-write", state: "applied", eventIds: ["prior-event"] });
      });
      coordinator.terminateChild(scope.childRunId, "AGENT_WRITE_CONFLICT");
      return { finalAnswer: "prior write remains", finalState: { todoItems: [], uncertainEffects: [] }, terminated: true, rounds: 0,
        terminal: { status: "cancelled", externalEffectsMayContinue: false } };
    } });
  const [failed, completed] = await Promise.all([
    execute({ agentId: profile.id, prompt: "conflict" }, { groupId: "group", toolCallId: "delegate-A" }),
    execute({ agentId: sibling.id, prompt: "finish sibling" }, { groupId: "group", toolCallId: "delegate-B" }),
  ]);
  expect(conflictSignal?.aborted).toBe(true);
  expect(failed).toMatchObject({ status: "failed", error: { code: "AGENT_WRITE_CONFLICT" }, writes: [{ state: "applied", toolCallId: "prior-write" }] });
  expect(store.get(failed.sessionId)).toMatchObject({ status: "failed", error: { code: "AGENT_WRITE_CONFLICT" } });
  expect(completed).toMatchObject({ status: "completed", text: "fixture result" });
});

it("restart_preserves_unknown_without_replay_before_a_tool_result_checkpoint", async () => {
  const { HarnessRunStore } = await import("./harness/run-store");
  const { AgentSessionRegistry } = await import("../tasks/agent-session-registry");
  const { store, parent } = setup(), root = parent.resolvedWorkspaceRoot!, runStore = new HarnessRunStore(root);
  const session = new AgentSessionRegistry(store).acquire({ agentId: profile.id, modelProfile: profile.modelProfile, savedModelProfileId: "saved-code",
    parentConversationId: parent.parentConversationId, parentRunId: "old-parent", mode: "code", resolvedWorkspaceRoot: root, description: "fixture", prompt: "write fixture" });
  const call = { id: "crashed-write", name: "write_file", arguments: JSON.stringify({ path: "unknown.txt", content: "same invocation" }) };
  const messages = [{ role: "user" as const, content: "write fixture" }, { role: "assistant" as const, content: "", toolCalls: [call] }];
  const legacy = [{ role: "user", content: "legacy exact audit" }, { role: "assistant", content: "legacy assistant", rawAssistant: [{ type: "text", text: "legacy assistant" }] }];
  store.checkpoint(session.id, { messages: [...legacy, ...messages], uncertainEffects: [], writes: [{ path: "unknown.txt", canonicalPath: path.join(root, "unknown.txt"), agentId: profile.id,
    childRunId: session.childRunId, toolCallId: call.id, state: "unknown", eventIds: ["started-write"] }] });
  runStore.create({ conversationId: session.id, runId: session.childRunId, messages, state: { todoItems: [], uncertainEffects: [] },
    request: { provider: "fixture", model: "fixture-model", contextWindowTokens: 64000, mode: "code", promptFingerprint: "fixture", toolSchemaFingerprint: "fixture", workspaceRoot: root } });
  runStore.recordTool(session.childRunId, { toolCallId: call.id, toolName: call.name, sideEffect: "idempotent_mutation", status: "started" });
  const restartedStore = new TaskSessionStore(root), restartedRunStore = new HarnessRunStore(root);
  let writes = 0, observed: HarnessInput | undefined;
  const write: ToolDefinition = { id: "write_file", name: "fixture write", enabled: true, description: "fixture", inputSchema: { type: "object" },
    effectKind: "mutation", risk: "fs-write", execute: async () => { writes++; return "unexpected replay"; } };
  const result = await createAgentExecutor({ parent: { ...parent, parentRunId: "new-parent", tools: [write] }, store: restartedStore, runStore: restartedRunStore,
    profiles: [{ ...profile, allowedToolIds: [write.id] }], modelSettings: models, runHarness: async input => {
      observed = input;
      const dispatched = await dispatchToolCall(call, { tools: input.tools, state: { todoItems: [], uncertainEffects: input.initialState?.uncertainEffects ?? [] }, toolContext: input.toolContext });
      expect(dispatched.outcome).toBe("not_executed"); return complete(input);
    } })({ agentId: profile.id, prompt: "Continue carefully" });
  expect(writes).toBe(0); expect(observed?.initialState?.uncertainEffects).toEqual([expect.objectContaining({ toolCallId: call.id, toolName: "write_file" })]);
  const repaired = restartedStore.get(result.sessionId)!;
  expect(repaired.messages.slice(0, legacy.length)).toEqual(legacy);
  expect(repaired.writes?.[0].state).toBe("unknown");
  expect(repaired.messages.filter(message => message.toolCallId === call.id)).toHaveLength(1);
  expect(repaired.messages.find(message => message.toolCallId === call.id)?.content).toContain("unknown_after_interruption");
});

it("restart_merges_the_stronger_guard_into_an_existing_legacy_task_effect", async () => {
  const { HarnessRunStore } = await import("./harness/run-store");
  const { AgentSessionRegistry } = await import("../tasks/agent-session-registry");
  const { store, parent } = setup(), root = parent.resolvedWorkspaceRoot!, runs = new HarnessRunStore(root);
  const session = new AgentSessionRegistry(store).acquire({ agentId: profile.id, modelProfile: profile.modelProfile,
    savedModelProfileId: "saved-code", parentConversationId: parent.parentConversationId, parentRunId: "old-parent",
    mode: "code", resolvedWorkspaceRoot: root, description: "fixture", prompt: "old write" });
  const call = { id: "legacy", name: "write_file", arguments: "null" };
  const effects = [{ id: `${session.childRunId}:${call.id}`, toolCallId: call.id, toolName: call.name, fingerprint: "write_file()", message: "unknown" }];
  const messages = [{ role: "user" as const, content: "old write" }, { role: "assistant" as const, content: "", toolCalls: [call] }];
  store.checkpoint(session.id, { status: "interrupted", messages, uncertainEffects: effects });
  runs.create({ conversationId: session.id, runId: session.childRunId, messages, state: { todoItems: [], uncertainEffects: effects },
    request: { provider: "fixture", model: "fixture-model", contextWindowTokens: 64000, promptFingerprint: "p", toolSchemaFingerprint: "t", workspaceRoot: root } });
  runs.recordTool(session.childRunId, { toolCallId: call.id, toolName: call.name, sideEffect: "non_idempotent_side_effect", status: "started" });
  let executions = 0;
  const write: ToolDefinition = { id: call.name, name: "write", description: "fixture", enabled: true, inputSchema: { type: "object" },
    effectKind: "mutation", execute: async () => { executions++; return "unexpected replay"; } };
  const execute = createAgentExecutor({ parent: { ...parent, tools: [write] }, store: new TaskSessionStore(root), runStore: new HarnessRunStore(root),
    profiles: [{ ...profile, allowedToolIds: [write.id] }], modelSettings: models, runHarness: async input => {
      const result = await dispatchToolCall({ ...call, id: "corrected", arguments: '{"path":"new"}' }, { tools: input.tools,
        state: { todoItems: [], uncertainEffects: input.initialState?.uncertainEffects ?? [] }, toolContext: input.toolContext });
      expect(result).toMatchObject({ outcome: "not_executed", category: "runtime_safety" });
      expect(input.initialState?.uncertainEffects).toEqual([{ ...effects[0], argumentsUnavailable: true }]);
      return { finalAnswer: "unknown effect retained", finalState: { todoItems: [], uncertainEffects: input.initialState?.uncertainEffects ?? [] }, terminated: false, rounds: 0 };
    } });
  const result = await execute({ agentId: profile.id, prompt: "continue" });
  expect(result.status).toBe("completed");
  expect(executions).toBe(0);
  expect(new TaskSessionStore(root).get(result.sessionId)?.uncertainEffects).toEqual([{ ...effects[0], argumentsUnavailable: true }]);
});

it("quiesces_a_failed_child_before_draining_a_retained_operation_and_releasing_its_lease", async () => {
  const { RunExecutionCoordinator } = await import("./harness/execution-coordinator");
  const { store, parent } = setup(), coordinator = new RunExecutionCoordinator(parent.resolvedWorkspaceRoot!), parentController = new AbortController();
  let entered!: () => void, closeOperation!: () => void, leaseReleased = false, childAborted = false;
  const started = new Promise<void>(resolve => { entered = resolve; }), processClosed = new Promise<void>(resolve => { closeOperation = resolve; });
  const running = createAgentExecutor({ parent: { ...parent, executionCoordinator: coordinator, signal: parentController.signal }, store,
    profiles: [profile], modelSettings: models, characterPool: { acquire: () => ({ nickname: "fixture", assetFileName: "fixture.png", release: () => { leaseReleased = true; } }) },
    runHarness: async input => {
      const execution = input.toolContext!.execution!;
      input.signal!.addEventListener("abort", () => { childAborted = true; closeOperation(); }, { once: true });
      await coordinator.runLeaf({ ...execution.scope, toolCallId: "background-process" }, "exclusive", input.signal, async permit => { coordinator.retainUntil(permit, processClosed); entered(); });
      input.quiesceExecution?.();
      await coordinator.whenChildSettled(execution.scope.childRunId);
      return { finalAnswer: "synthetic model rejection", finalState: { todoItems: [], uncertainEffects: [] }, terminated: true, terminateReason: "error", rounds: 1 };
    } })({ agentId: profile.id, prompt: "synthetic background operation" }, { groupId: "group", toolCallId: "delegate" });
  await started; await new Promise<void>(setImmediate);
  let assertionError: unknown;
  try { expect(childAborted).toBe(true); expect(parentController.signal.aborted).toBe(false); } catch (error) { assertionError = error; }
  finally { parentController.abort(); closeOperation(); }
  const result = await running; if (assertionError) throw assertionError;
  expect(result.status).toBe("failed"); expect(leaseReleased).toBe(true);
});

it("shutdown_during_recovery_preserves_exact_old_target_for_the_next_continuation", async () => {
  const { HarnessRunStore } = await import("./harness/run-store");
  const { AgentSessionRegistry } = await import("../tasks/agent-session-registry");
  const { ConversationTranscriptStore } = await import("./conversation-transcript-store");
  const { createTranscriptSink } = await import("./transcript-sink");
  const { requireBackgroundMemoryIngress } = await import("../memory-context/background-memory-ingress");
  const { store, parent } = setup(), root = parent.resolvedWorkspaceRoot!, runs = new HarnessRunStore(root), transcripts = new ConversationTranscriptStore(root);
  const old = new AgentSessionRegistry(store).acquire({ agentId: profile.id, modelProfile: profile.modelProfile, savedModelProfileId: "saved-code", parentConversationId: parent.parentConversationId,
    parentRunId: "old-parent", mode: "code", resolvedWorkspaceRoot: root, description: "fixture", prompt: "old interrupted instruction" });
  const call = { id: "old-write", name: "write_file", arguments: '{"path":"old.txt","content":"same"}' }, messages = [{ role: "user" as const, content: "old interrupted instruction" }, { role: "assistant" as const, content: "", toolCalls: [call] }];
  store.checkpoint(old.id, { messages });
  runs.create({ conversationId: old.id, runId: old.childRunId, messages, request: { provider: "fixture", model: "fixture-model", contextWindowTokens: 64000, promptFingerprint: "fixture", toolSchemaFingerprint: "fixture", workspaceRoot: root } });
  runs.recordTool(old.childRunId, { toolCallId: call.id, toolName: call.name, sideEffect: "idempotent_mutation", status: "started" });
  await transcripts.append(old.id, { id: old.childRunId + "-instruction", turnId: old.childRunId + "-instruction", revision: 1, kind: "user", payload: { text: "old interrupted instruction" } });
  await createTranscriptSink({ store: transcripts, conversationId: old.id, runId: old.childRunId, assistantTurnId: old.childRunId + "-assistant" }).appendAssistant({ message: messages[1], roundId: "round-1" });
  const restartedStore = new TaskSessionStore(root), restartedRuns = new HarnessRunStore(root), controller = new AbortController(), targets: string[] = [];
  let first = true;
  const host: import("../memory-context/background-memory-ingress").BackgroundMemoryHost = { async prepareBackgroundRun(input) {
    const context = requireBackgroundMemoryIngress(input.ingress); targets.push(input.recoverRunId!);
    if (first) { first = false; controller.abort(); throw new DOMException("synthetic owner shutdown during recovery", "AbortError"); }
    await createTranscriptSink({ store: transcripts, conversationId: old.id, runId: input.recoverRunId!, assistantTurnId: input.recoverRunId! + "-assistant" }).closeInterruption({ reason: "user_cancel", runSession: restartedRuns.get(input.recoverRunId!) });
    await transcripts.append(context.sessionId, { id: input.userTurnId, turnId: input.userTurnId, revision: 1, kind: "user", payload: { text: input.instructionText } });
    const sink = createTranscriptSink({ store: transcripts, conversationId: context.sessionId, runId: input.runId, assistantTurnId: input.assistantTurnId });
    return { sessionId: context.sessionId, signal: context.signal, transcriptSink: sink, openMemoryRun: async () => ({ call: async () => ({ text: "fixture" }), bindSink: sink => sink, close: async () => undefined }), close: async () => undefined };
  } };
  const firstResult = await createAgentExecutor({ parent: { ...parent, backgroundMemory: host, signal: controller.signal }, store: restartedStore, runStore: restartedRuns,
    profiles: [profile], modelSettings: models, runHarness: complete })({ agentId: profile.id, prompt: "first continuation" });
  expect(firstResult.status).toBe("cancelled"); expect(restartedStore.get(old.id)?.recoveryRunId).toBe(old.childRunId);
  const secondResult = await createAgentExecutor({ parent: { ...parent, parentRunId: "new-parent", backgroundMemory: host }, store: restartedStore, runStore: restartedRuns,
    profiles: [profile], modelSettings: models, runHarness: complete })({ agentId: profile.id, prompt: "next continuation" });
  expect(targets).toEqual([old.childRunId, old.childRunId]); expect(secondResult.status).toBe("completed"); expect(restartedStore.get(old.id)?.recoveryRunId).toBeUndefined();
  const closed = (await transcripts.read(old.id)).entries.filter(entry => entry.kind === "tool_result" && entry.payload.toolCallId === call.id);
  expect(closed).toHaveLength(1); expect(closed[0].kind === "tool_result" && closed[0].payload.outcome).toBe("unknown");
});

it("rejects_a_tampered_foreign_pending_recovery_target_before_acquire_or_execution", async () => {
  const { HarnessRunStore } = await import("./harness/run-store");
  const { AgentSessionRegistry } = await import("../tasks/agent-session-registry");
  const { store, parent } = setup(), runs = new HarnessRunStore(parent.resolvedWorkspaceRoot!);
  const session = new AgentSessionRegistry(store).acquire({ agentId: profile.id, modelProfile: profile.modelProfile, savedModelProfileId: "saved-code", parentConversationId: parent.parentConversationId,
    parentRunId: "old-parent", mode: "code", resolvedWorkspaceRoot: parent.resolvedWorkspaceRoot!, description: "fixture", prompt: "fixture" });
  store.checkpoint(session.id, { status: "cancelled", recoveryRunId: "foreign-old-run" });
  runs.create({ conversationId: "foreign-private-session", runId: "foreign-old-run", messages: [{ role: "user", content: "foreign instruction" }],
    request: { provider: "fixture", model: "fixture-model", contextWindowTokens: 64000, promptFingerprint: "fixture", toolSchemaFingerprint: "fixture" } });
  const before = store.get(session.id), runHarness = vi.fn(complete);
  await expect(createAgentExecutor({ parent, store, runStore: runs, profiles: [profile], modelSettings: models, runHarness })({ agentId: profile.id, prompt: "Continue" })).rejects.toThrow("AGENT_RECOVERY_EVIDENCE_MISMATCH");
  expect(store.get(session.id)).toEqual(before); expect(runHarness).not.toHaveBeenCalled();
});
