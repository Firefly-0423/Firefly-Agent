import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http, { type ServerResponse } from "node:http";
import { afterAll, afterEach, expect, it, vi } from "vitest";
// Real SQLite / filesystem integration case: the 5 s default is too tight on CI runners, so this file allows 30 s. Other files keep the default.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
import { runFireflyHarness } from "./harness/firefly-harness";
import { createBackgroundMemoryIngressIssuer } from "../memory-context/background-memory-ingress";
import { toolRegistry } from "./tools/registry/tool-registry";
import type { HarnessEvent } from "./harness/types";
import { initializeStorageContext, getStorageContext } from "../storage-context";
import { resolveRuntimeProfile } from "../runtime-profile";
import { createSmhFixture } from "../memory-context/smh-fixture.test-support";
import { createMainDefaultMemory } from "../memory-context/main-default-memory";
import { createActiveChatTargetRegistry } from "../plugin-host/active-chat-target";
import { ConversationTranscriptStore } from "./conversation-transcript-store";
import { HarnessRunStore } from "./harness/run-store";
import { TaskSessionStore } from "../tasks/task-session-store";
import { createAgentExecutor } from "./persistent-agent-runtime";
import { RunExecutionCoordinator } from "./harness/execution-coordinator";
import { createSpecialistProfiles } from "./specialist-profiles";
import { SPECIALIST_AGENTS } from "../../shared/specialist-agents";
import type { ModelSettings } from "../settings/model-settings";

vi.mock("electron", () => ({ app: { getPath: () => getStorageContext().dataRoot } }));
vi.mock("../token-usage-store", () => ({ recordModelCall: () => undefined, recordToolCall: () => undefined, recordRequest: vi.fn(), recordUsage: vi.fn() }));
vi.mock("../timeout-manager", () => ({ getTimeoutSettings: () => ({ chatRequestTimeout: 20000 }) }));
const isolation = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-twelve-agents-storage-"));
initializeStorageContext(resolveRuntimeProfile({ argv: ["--firefly-profile=test", "--firefly-isolation-root=" + isolation], env: {}, isPackaged: false, productionAppData: path.join(os.tmpdir(), "synthetic-production-unopened") }));
afterAll(() => fs.rmSync(isolation, { recursive: true, force: true }));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

function toolsReply(res: ServerResponse, calls: Array<{ id: string; name: string; arguments: string }>) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const delta = { tool_calls: calls.map((call, index) => ({ index, id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })) };
  res.end("data: " + JSON.stringify({ id: "synthetic-tools", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: "tool_calls" }] }) + "\n\ndata: [DONE]\n\n");
}
function textReply(res: ServerResponse, text: string) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end("data: " + JSON.stringify({ id: "synthetic-text", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: text }, finish_reason: "stop" }] }) + "\n\ndata: [DONE]\n\n");
}

it("the main agent can delegate to all twelve specialists in one round and each writes its own introduction file", async () => {
  await import("./tools/fs-tools");
  const write = toolRegistry.getById("write_file")!;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-twelve-agents-"));
  const profiles = createSpecialistProfiles("work", [write], []);
  expect(profiles.map(profile => profile.id).sort()).toEqual(SPECIALIST_AGENTS.map(agent => agent.id).sort());

  let parentRounds = 0;
  const childRounds = new Map<string, number>();
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages: unknown };
    const wire = JSON.stringify(body.messages);
    const agent = SPECIALIST_AGENTS.find(item => wire.includes(`你是${item.nickname}，Firefly 主代理的`));
    if (agent) {
      const round = (childRounds.get(agent.id) ?? 0) + 1; childRounds.set(agent.id, round);
      if (round === 1) {
        toolsReply(res, [{ id: `write-${agent.id}`, name: "write_file", arguments: JSON.stringify({ path: `${agent.nickname}.txt`, content: `我是${agent.nickname}，负责${agent.role}。${agent.description}` }) }]);
      } else textReply(res, `${agent.nickname}已写入 ${agent.nickname}.txt`);
    } else if (++parentRounds === 1) {
      toolsReply(res, profiles.map(profile => ({ id: `delegate-${profile.id}`, name: "delegate_agent", arguments: JSON.stringify({ agent_id: profile.id, prompt: `写出介绍你自己的 ${profile.nickname}.txt` }) })));
    } else textReply(res, "12 位全部回来了");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const smh = createSmhFixture(root, { clock: Date.now }), transcripts = new ConversationTranscriptStore(root), store = new TaskSessionStore(root), runStore = new HarnessRunStore(root);
  const model = { id: "synthetic-saved-profile", provider: "OpenRouter", baseUrl: `http://127.0.0.1:${port}/v1`, model: "synthetic-model", apiKey: "synthetic-no-account", explicitTransport: "openai" as const, contextWindowTokens: 128000 };
  const tiers = Object.fromEntries(["reasoning", "coding", "research", "vision", "document", "fast"].map(tier => [tier, model.id]));
  const settings = { ...model, modelProfiles: [model], contextWindowTokens: 128000, defaultModelProfileId: model.id, chatRequestTimeoutSec: 20, agentModelProfiles: tiers } as ModelSettings;
  const memory = createMainDefaultMemory({ getChatWindow: () => null, targets: createActiveChatTargetRegistry(), getSession: () => null, listSessionIds: () => [],
    store: transcripts, runReader: runStore, settings: () => settings, openBackend: async () => ({ transport: smh.transport, endpointFactory: async () => { throw Error("SYNTHETIC_NATIVE_HISTORY_NOT_NEEDED"); }, close: async () => undefined }) });
  const coordinator = new RunExecutionCoordinator(root), controller = new AbortController();
  cleanups.push(async () => { controller.abort(); try { await memory.close(); } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); smh.close(); fs.rmSync(root, { recursive: true, force: true }); } });
  const execute = createAgentExecutor({ parent: { backgroundMemory: memory, parentConversationId: "twelve-parent", parentRunId: "twelve-parent-run", mode: "work",
    systemPrompt: "parent", vendorConfig: model, tools: [write], resolvedWorkspaceRoot: root, signal: controller.signal, executionCoordinator: coordinator,
    permissionMode: "allow_all", fileAccessLevel: "full", checkPermission: async () => true }, store, runStore, profiles, modelSettings: settings });

  const source = {}, issuer = createBackgroundMemoryIngressIssuer({ entry: "scheduler", isCurrent: candidate => candidate === source });
  const instruction = "让 12 个 agent 分别写出介绍他们自己的 txt", parentRunId = "twelve-parent-run";
  const ingress = issuer.capture({ source, sessionId: "twelve-parent", sourceKey: "twelve-parent", instructionText: instruction, signal: controller.signal });
  const prepared = await memory.prepareBackgroundRun({ ingress, modelProfileId: model.id, runId: parentRunId, userTurnId: parentRunId + "-instruction", assistantTurnId: parentRunId + "-assistant", instructionText: instruction });
  const memoryRun = await prepared.openMemoryRun({ settings: model, runId: parentRunId, conversationId: "twelve-parent", signal: prepared.signal,
    transcriptSink: prepared.transcriptSink, messages: [{ role: "user", content: instruction }], toolSystemContent: "", soulSystemBaseContent: "Synthetic parent", timeoutMs: 20000 });
  const events: HarnessEvent[] = [];
  const vendorConfig = { provider: model.provider, model: model.model, baseUrl: model.baseUrl, apiKey: model.apiKey, explicitTransport: model.explicitTransport };
  try {
    const parent = await runFireflyHarness({ runId: parentRunId, systemPrompt: "Synthetic parent", messages: [{ role: "user", content: instruction }],
      tools: [write], vendorConfig, config: { maxParallelToolCalls: 12, totalTimeoutMs: 25000 }, memoryRun, transcriptSink: memoryRun.bindSink(prepared.transcriptSink),
      signal: prepared.signal, includeInteractiveTools: false, checkPermission: async () => true, agentExecutor: execute, agentDefinitions: profiles,
      toolContext: { userQuery: instruction, conversationId: "twelve-parent", runId: parentRunId, resolvedWorkspaceRoot: root, mode: "work", permissionMode: "allow_all", fileAccessLevel: "full",
        execution: { coordinator, scope: { workspaceId: root, parentRunId, groupId: parentRunId, agentId: "main", childRunId: parentRunId, toolCallId: "main" } } },
      onEvent: event => events.push(event),
    });
    expect(parent.terminated).toBe(false);
    expect(parent.finalAnswer).toBe("12 位全部回来了");
    const results = events.flatMap(event => event.type === "tool_end" && event.taskResult ? [event.taskResult] : []);
    expect(results).toHaveLength(12);
    expect(results.map(result => result.status)).toEqual(Array(12).fill("completed"));
    expect(new Set(results.map(result => result.agentId)).size).toBe(12);
    for (const agent of SPECIALIST_AGENTS) {
      const file = path.join(root, `${agent.nickname}.txt`);
      expect(fs.readFileSync(file, "utf8"), agent.id).toContain(`我是${agent.nickname}`);
    }
    expect(fs.readdirSync(root).filter(name => name.endsWith(".txt"))).toHaveLength(12);
    expect(parentRounds).toBe(2);
    expect([...childRounds.values()]).toEqual(Array(12).fill(2));
  } finally { for (const close of [() => memoryRun.close(), () => prepared.close()]) await close(); }
});
