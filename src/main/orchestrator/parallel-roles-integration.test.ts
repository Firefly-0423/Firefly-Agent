import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { runFireflyHarness } from "./harness/firefly-harness";
import { createBackgroundMemoryIngressIssuer } from "../memory-context/background-memory-ingress";
import { toolRegistry, type ToolDefinition } from "./tools/registry/tool-registry";
import type { HarnessEvent } from "./harness/types";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { afterAll, afterEach, expect, it, vi } from "vitest";
// Real SQLite / filesystem integration cases: the 5 s default is too tight on CI runners, so this file allows 30 s. Other files keep the default.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
import { initializeStorageContext, getStorageContext } from "../storage-context";
import { resolveRuntimeProfile } from "../runtime-profile";
import { createSmhFixture } from "../memory-context/smh-fixture.test-support";
import { createMainDefaultMemory } from "../memory-context/main-default-memory";
import { createActiveChatTargetRegistry } from "../plugin-host/active-chat-target";
import { ConversationTranscriptStore } from "./conversation-transcript-store";
import { HarnessRunStore } from "./harness/run-store";
import { TaskSessionStore } from "../tasks/task-session-store";
import { createAgentExecutor } from "./persistent-agent-runtime";
import { scheduleToolCalls } from "./harness/tool-call-scheduler";
import { RunExecutionCoordinator } from "./harness/execution-coordinator";
import { canonicalWriteIdentity } from "./harness/write-ownership";
import { createModelExecutionRecorder } from "./harness/model-execution-evidence";
import type { ModelExecutionEvent } from "../../shared/agent-execution-evidence";
import type { AgentProfile } from "../../shared/agent-profile";
import type { ModelSettings } from "../settings/model-settings";

vi.mock("electron", () => ({ app: { getPath: () => getStorageContext().dataRoot } }));
vi.mock("../token-usage-store", () => ({ recordModelCall: () => undefined, recordToolCall: () => undefined, recordRequest: vi.fn(), recordUsage: vi.fn() }));
vi.mock("../timeout-manager", () => ({ getTimeoutSettings: () => ({ chatRequestTimeout: 5000 }) }));
const isolation = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-synthetic-main-storage-"));
initializeStorageContext(resolveRuntimeProfile({ argv: ["--firefly-profile=test", "--firefly-isolation-root=" + isolation], env: {}, isPackaged: false, productionAppData: path.join(os.tmpdir(), "synthetic-production-unopened") }));
afterAll(() => fs.rmSync(isolation, { recursive: true, force: true }));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function response(body: Record<string, unknown>, res: ServerResponse): void {
  if (res.destroyed) return;
  if (body.stream) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end('data: {"id":"synthetic","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"synthetic completion"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  } else {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "synthetic completion" }, finish_reason: "stop" }] }));
  }
}
async function fixture(handler: (body: Record<string, unknown>, res: ServerResponse, req: IncomingMessage) => Promise<void> | void, options: { tools?: ToolDefinition[] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-synthetic-parallel-model-"));
  const server = http.createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      await handler(JSON.parse(Buffer.concat(chunks).toString("utf8")), res, req);
    } catch (error) { if (!res.destroyed) { res.statusCode = 500; res.end(String(error)); } }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const smh = createSmhFixture(root, { clock: Date.now }), transcripts = new ConversationTranscriptStore(root), store = new TaskSessionStore(root), runStore = new HarnessRunStore(root);
  const model = { id: "synthetic-saved-profile", provider: "OpenRouter", baseUrl: `http://127.0.0.1:${port}/v1`, model: "synthetic-model", apiKey: "synthetic-no-account", explicitTransport: "openai" as const, contextWindowTokens: 128000 };
  const settings = { ...model, modelProfiles: [model], contextWindowTokens: 128000, defaultModelProfileId: model.id, chatRequestTimeoutSec: 5, agentModelProfiles: { coding: model.id } } as ModelSettings;
  const memory = createMainDefaultMemory({ getChatWindow: () => null, targets: createActiveChatTargetRegistry(), getSession: () => null, listSessionIds: () => [],
    store: transcripts, runReader: runStore, settings: () => settings, openBackend: async () => ({ transport: smh.transport, endpointFactory: async () => { throw Error("SYNTHETIC_NATIVE_HISTORY_NOT_NEEDED"); }, close: async () => undefined }) });
  const events: ModelExecutionEvent[] = [];
  const recorder = createModelExecutionRecorder({ domainId: "synthetic-test-main-clock", now: () => performance.now() }, event => events.push(event));
  const coordinator = new RunExecutionCoordinator(root), controller = new AbortController();
  const profiles: AgentProfile[] = [
    { id: "role-A", nickname: "艾利欧", role: "synthetic A", description: "synthetic A", systemPrompt: "Fixture role A", modelProfile: "coding", allowedToolIds: (options.tools ?? []).map(tool => tool.id), allowedSkillIds: [], supportedModes: ["code"], persistent: true, timeoutMs: 5000, maxConcurrency: 1 },
    { id: "role-B", nickname: "卡芙卡", role: "synthetic B", description: "synthetic B", systemPrompt: "Fixture role B", modelProfile: "coding", allowedToolIds: (options.tools ?? []).map(tool => tool.id), allowedSkillIds: [], supportedModes: ["code"], persistent: true, timeoutMs: 5000, maxConcurrency: 1 },
  ];
  const execute = createAgentExecutor({ parent: { backgroundMemory: memory, parentConversationId: "synthetic-parent", parentRunId: "synthetic-parent-run", mode: "code",
    systemPrompt: "synthetic parent", vendorConfig: model, tools: options.tools ?? [], resolvedWorkspaceRoot: root, signal: controller.signal, executionCoordinator: coordinator, modelExecutionRecorder: recorder,
    permissionMode: options.tools ? "allow_all" : "auto", fileAccessLevel: options.tools ? "full" : "read-only", checkPermission: async () => true }, store, runStore, profiles, modelSettings: settings });
  cleanups.push(async () => { controller.abort(); try { await memory.close(); } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); smh.close(); fs.rmSync(root, { recursive: true, force: true }); } });
  return { root, events, recorder, memory, model, transcripts, store, runStore, execute, profiles, controller, coordinator, settings };
}
async function schedule(f: Awaited<ReturnType<typeof fixture>>, maxParallel: number) {
  const results: Awaited<ReturnType<typeof f.execute>>[] = [];
  await scheduleToolCalls({ calls: f.profiles.map(profile => ({ id: `delegate-${profile.id}`, name: "delegate_agent", arguments: JSON.stringify({ agent_id: profile.id, prompt: `synthetic instruction ${profile.id}` }) })), maxParallel,
    classify: () => "delegation", execute: ({ call, delegationScope }) => {
      const args = JSON.parse(call.arguments); return f.execute({ agentId: args.agent_id, prompt: args.prompt }, delegationScope);
    }, commit: async (_execution, result) => { results.push(result); return "continue"; }, notExecuted: async () => { throw Error("UNEXPECTED_SYNTHETIC_SKIP"); }, closeGroup: groupId => f.coordinator.closeGroup(groupId) });
  return results;
}
function paired(events: ModelExecutionEvent[]) {
  const requests = new Map<string, ModelExecutionEvent[]>();
  for (const event of events) requests.set(event.executionId, [...requests.get(event.executionId) ?? [], event]);
  for (const request of requests.values()) expect(request.map(event => event.phase)).toEqual(["start", "end"]);
  return [...requests.values()];
}

it("synthetic_provider_entry_intervals_overlap", async () => {
  const bothEntered = deferred(), release = deferred(); let entered = 0;
  const f = await fixture(async (body, res) => { entered++; if (entered === 2) bothEntered.resolve(); await release.promise; response(body, res); });
  const running = schedule(f, 2);
  await Promise.race([bothEntered.promise, running.then(results => { throw Error(JSON.stringify(results)); })]);
  try { expect(f.events.map(event => event.phase)).toEqual(["start", "start"]); } finally { release.resolve(); }
  const results = await running, requests = paired(f.events), [a, b] = requests;
  expect(entered).toBe(2); expect(results.map(result => result.status)).toEqual(["completed", "completed"]);
  expect(a[0].monotonicMs).toBeLessThan(b[0].monotonicMs);
  expect(b[0].monotonicMs).toBeLessThan(Math.min(a[1].monotonicMs, b[1].monotonicMs));
  expect(new Set(f.events.map(event => event.clockDomainId)).size).toBe(1);
  expect(new Set(f.events.map(event => event.childRunId)).size).toBe(2);
  expect(f.events.map(event => event.seq)).toEqual([1, 2, 3, 4]);
  for (const result of results) {
    expect(result.executionEvents).toEqual(f.events.filter(event => event.agentId === result.agentId));
    expect(f.store.get(result.sessionId)?.executionEvents).toEqual(result.executionEvents);
  }
  const evidenceFile = path.join(f.root, "synthetic-model-evidence.json"); fs.writeFileSync(evidenceFile, JSON.stringify(f.events));
  expect(JSON.parse(fs.readFileSync(evidenceFile, "utf8"))).toEqual(f.events);
  console.info("[synthetic-model-overlap]", JSON.stringify(f.events));
}, 15000);

it("serial_control_has_no_overlap", async () => {
  let entered = 0; const f = await fixture((body, res) => { entered++; response(body, res); });
  const results = await schedule(f, 1), [a, b] = paired(f.events);
  expect(results.every(result => result.status === "completed"), JSON.stringify(results)).toBe(true);
  expect(entered).toBe(2);
  expect(a[1].monotonicMs).toBeLessThanOrEqual(b[0].monotonicMs);
  expect(f.events.map(event => event.phase)).toEqual(["start", "end", "start", "end"]);
  console.info("[synthetic-model-serial-control]", JSON.stringify(f.events));
}, 15000);

it("failed_and_zero_delta_fallback_requests_close_events_with_unique_ids", async () => {
  const failed = await fixture((_body, res) => { res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "synthetic rejection" } })); });
  const failure = await failed.execute({ agentId: "role-A", prompt: "synthetic rejected request" });
  expect(failure.status).toBe("failed"); expect(paired(failed.events)).toHaveLength(1); expect(failed.events[1].terminal).toBe("failed");
  const fallback = await fixture((body, res) => {
    if (body.stream) { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "stream not supported" } })); }
    else response(body, res);
  });
  const completed = await fallback.execute({ agentId: "role-A", prompt: "synthetic stream fallback" });
  expect(completed.status).toBe("completed"); expect(paired(fallback.events)).toHaveLength(2);
  expect(fallback.events.filter(event => event.phase === "end").map(event => event.terminal)).toEqual(["failed", "completed"]);
  expect(new Set(fallback.events.map(event => event.executionId)).size).toBe(2);
}, 15000);

it("stream_cancellation_closes_actual_request_events_and_never_starts_another_request", async () => {
  const entered = deferred();
  const f = await fixture((_body, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"id":"synthetic","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"started"},"finish_reason":null}]}\n\n');
    entered.resolve();
  });
  const running = f.execute({ agentId: "role-A", prompt: "synthetic cancellation" });
  await Promise.race([entered.promise, running.then(result => { throw Error(JSON.stringify(result)); })]); f.controller.abort(); const result = await running;
  expect(result.status).toBe("cancelled"); expect(paired(f.events)).toHaveLength(1);
  expect(f.events[1].terminal).toBe("cancelled"); expect(result.executionEvents).toEqual(f.events);
}, 15000);

it("saved_profile_configuration_failure_has_no_provider_start_evidence", async () => {
  let entered = 0; const f = await fixture((body, res) => { entered++; response(body, res); });
  f.settings.modelProfiles![0].model = "";
  await expect(f.execute({ agentId: "role-A", prompt: "synthetic invalid profile" })).rejects.toThrow("AGENT_MODEL_PROFILE_INCOMPLETE"); expect(entered).toBe(0); expect(f.events).toEqual([]);
}, 15000);


it("parent_harness_delegation_bridge_preserves_real_prior_writes_and_failed_child_evidence", async () => {
  await import("./tools/fs-tools");
  const write = toolRegistry.getById("write_file")!;
  const releaseB = deferred();
  let parentRounds = 0, aRounds = 0, bRounds = 0;
  const toolsReply = (res: ServerResponse, calls: Array<{ id: string; name: string; arguments: string }>) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const delta = { tool_calls: calls.map((call, index) => ({ index, id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })) };
    res.end("data: " + JSON.stringify({ id: "synthetic-tools", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: "tool_calls" }] }) + "\n\ndata: [DONE]\n\n");
  };
  const f = await fixture(async (body, res) => {
    const wire = JSON.stringify(body.messages);
    if (wire.includes("Fixture role A")) {
      if (++aRounds === 1) toolsReply(res, [{ id: "A-shared-write", name: "write_file", arguments: JSON.stringify({ path: "shared.txt", content: "A owns shared fixture" }) }]);
      else response(body, res);
    } else if (wire.includes("Fixture role B")) {
      bRounds++; await releaseB.promise;
      toolsReply(res, [
        { id: "B-own-write", name: "write_file", arguments: JSON.stringify({ path: "own.txt", content: "B prior write remains" }) },
        { id: "B-conflicting-write", name: "write_file", arguments: JSON.stringify({ path: "shared.txt", content: "B must never overwrite A" }) },
      ]);
    } else if (++parentRounds === 1) {
      toolsReply(res, f.profiles.map(profile => ({ id: "delegate-" + profile.id, name: "delegate_agent", arguments: JSON.stringify({ agent_id: profile.id, prompt: "synthetic instruction " + profile.id }) })));
    } else response(body, res);
  }, { tools: [write] });
  const releases: Array<() => void> = [];
  releases.push(f.recorder.subscribe(event => {
    if (event.agentId === "role-A" && event.phase === "start") releases.push(f.coordinator.onChildWrites(event.childRunId, writes => {
      if (writes.some(item => item.state === "applied" && item.canonicalPath === canonicalWriteIdentity(path.join(f.root, "shared.txt")))) releaseB.resolve();
    }));
  }));
  const source = {}, issuer = createBackgroundMemoryIngressIssuer({ entry: "scheduler", isCurrent: candidate => candidate === source });
  const instruction = "synthetic parent delegation fixture", parentRunId = "synthetic-parent-run";
  const ingress = issuer.capture({ source, sessionId: "synthetic-parent", sourceKey: "synthetic-parent", instructionText: instruction, signal: f.controller.signal });
  const prepared = await f.memory.prepareBackgroundRun({ ingress, modelProfileId: f.model.id, runId: parentRunId,
    userTurnId: parentRunId + "-instruction", assistantTurnId: parentRunId + "-assistant", instructionText: instruction });
  const memoryRun = await prepared.openMemoryRun({ settings: f.model, runId: parentRunId, conversationId: "synthetic-parent", signal: prepared.signal,
    transcriptSink: prepared.transcriptSink, messages: [{ role: "user", content: instruction }], toolSystemContent: "", soulSystemBaseContent: "Synthetic parent", timeoutMs: 5000 });
  const events: HarnessEvent[] = [];
  const vendorConfig = { provider: f.model.provider, model: f.model.model, baseUrl: f.model.baseUrl, apiKey: f.model.apiKey, explicitTransport: f.model.explicitTransport };
  try {
    const parent = await runFireflyHarness({ runId: parentRunId, systemPrompt: "Synthetic parent", messages: [{ role: "user", content: instruction }],
      tools: [write], vendorConfig, config: { maxParallelToolCalls: 2, totalTimeoutMs: 5000 }, memoryRun, transcriptSink: memoryRun.bindSink(prepared.transcriptSink),
      signal: prepared.signal, includeInteractiveTools: false, checkPermission: async () => true, agentExecutor: f.execute, agentDefinitions: f.profiles,
      toolContext: { userQuery: instruction, conversationId: "synthetic-parent", runId: parentRunId, resolvedWorkspaceRoot: f.root, mode: "code", permissionMode: "allow_all", fileAccessLevel: "full",
        execution: { coordinator: f.coordinator, scope: { workspaceId: f.root, parentRunId, groupId: parentRunId, agentId: "main", childRunId: parentRunId, toolCallId: "main" } } },
      onEvent: event => events.push(event),
    });
    expect(parent.terminated).toBe(false); expect(parent.finalAnswer).toBe("synthetic completion");
    const results = events.filter(event => event.type === "tool_end" && event.taskResult).map(event => event.type === "tool_end" ? event.taskResult! : neverResult());
    const successful = results.find(result => result.agentId === "role-A")!, failed = results.find(result => result.agentId === "role-B")!;
    expect(successful).toMatchObject({ status: "completed", writes: [{ state: "applied", toolCallId: "A-shared-write" }] });
    expect(failed).toMatchObject({ status: "failed", error: { code: "AGENT_WRITE_CONFLICT" }, writes: [{ state: "applied", toolCallId: "B-own-write" }] });
    expect(fs.readFileSync(path.join(f.root, "shared.txt"), "utf8")).toBe("A owns shared fixture");
    expect(fs.readFileSync(path.join(f.root, "own.txt"), "utf8")).toBe("B prior write remains");
    for (const result of [successful, failed]) {
      const evidence = result.writes![0], hash = createHash("sha256").update(fs.readFileSync(evidence.canonicalPath)).digest("hex");
      expect(evidence.after?.sha256).toBe(hash); expect(evidence.eventIds.length).toBeGreaterThanOrEqual(3);
      expect(result.executionEvents?.length).toBeGreaterThanOrEqual(2);
      expect(f.store.get(result.sessionId)?.writes).toEqual(result.writes);
      expect(f.store.get(result.sessionId)?.executionEvents).toEqual(result.executionEvents);
    }
    expect(parentRounds).toBe(2); expect(aRounds).toBe(2); expect(bRounds).toBe(1);
    console.info("[synthetic-full-delegation-write-evidence]", JSON.stringify(results));
  } finally { releaseB.resolve(); for (const release of releases) release(); await memoryRun.close(); await prepared.close(); }
}, 15000);
function neverResult(): never { throw Error("unexpected event type"); }

it("actual_model_failure_quiesces_its_child_and_drains_a_real_retained_Node_process", async () => {
  const { startShellJob, stopShellJob, waitForShellJob } = await import("./tools/builtin-tools/shell-job-manager");
  let f: Awaited<ReturnType<typeof fixture>>, jobId = "", childSignal: AbortSignal | undefined, statusAtModelFailure: string | undefined, modelCalls = 0;
  const background: ToolDefinition = { id: "synthetic_background", name: "synthetic background Node", description: "offline test fixture", enabled: true,
    inputSchema: { type: "object", properties: {} }, risk: "shell", effectKind: "unknown", execute: async (_args, context) => {
      const execution = context!.execution!; childSignal = context!.signal;
      const job = startShellJob({ spec: { command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], cwd: f.root, env: process.env, windowsVerbatimArguments: false, ranViaSandbox: false },
        command: "synthetic retained Node process", shell: "node", logDir: f.root, executionScope: execution.scope, signal: context!.signal });
      jobId = job.jobId; execution.coordinator.retainUntil(execution.permit!, job.completion); return "synthetic Node process started";
    } };
  f = await fixture(async (_body, res) => {
    if (++modelCalls === 1) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end('data: {"id":"background","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"launch-background","type":"function","function":{"name":"synthetic_background","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n');
    } else {
      statusAtModelFailure = (await waitForShellJob(jobId, 0))?.status;
      res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "synthetic model failure with live process" } }));
    }
  }, { tools: [background] });
  try {
    const result = await f.execute({ agentId: "role-A", prompt: "synthetic launch then model failure" });
    expect(statusAtModelFailure).toBe("running"); expect(result.status).toBe("failed"); expect(childSignal?.aborted).toBe(true); expect(f.controller.signal.aborted).toBe(false);
    expect((await waitForShellJob(jobId, 0))?.status).toBe("stopped");
    let nextEntered = false;
    await f.coordinator.runLeaf({ workspaceId: f.root, parentRunId: "next-parent", groupId: "next-group", agentId: "main", childRunId: "next-parent", toolCallId: "post-failure-read" }, "shared", undefined, async () => { nextEntered = true; });
    expect(nextEntered).toBe(true); expect(f.store.get(result.sessionId)?.status).toBe("failed");
    expect(paired(f.events)).toHaveLength(2); expect(f.events.filter(event => event.phase === "end").map(event => event.terminal)).toEqual(["completed", "failed"]);
  } finally { if (jobId) stopShellJob(jobId); }
}, 15000);
