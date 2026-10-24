import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AgentSessionRegistry } from "../tasks/agent-session-registry";
import { TaskSessionStore } from "../tasks/task-session-store";
import { HarnessRunStore } from "../orchestrator/harness/run-store";
import { ConversationTranscriptStore } from "../orchestrator/conversation-transcript-store";
import { createTranscriptSink } from "../orchestrator/transcript-sink";
import { createAgentExecutor } from "../orchestrator/persistent-agent-runtime";
import { requireBackgroundMemoryIngress, type BackgroundMemoryHost } from "./background-memory-ingress";
import type { MainMemoryRun } from "./main-memory-runtime";

vi.mock("electron", () => ({ app: { getPath: () => "/tmp" } }));
vi.mock("../token-usage-store", () => ({ recordModelCall: () => undefined, recordToolCall: () => undefined, recordRequest: vi.fn(), recordUsage: vi.fn() }));
vi.mock("../timeout-manager", () => ({ getTimeoutSettings: () => ({ chatRequestTimeout: 60000 }) }));
const roots: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "entry-adapter-")); roots.push(root);
  const store = new TaskSessionStore(root), transcripts = new ConversationTranscriptStore(root), runStore = new HarnessRunStore(root);
  const profile = { id: "specialist", nickname: "艾利欧", role: "review", description: "review", systemPrompt: "system fixture", modelProfile: "coding", allowedToolIds: ["inspect"], allowedSkillIds: [], supportedModes: ["code" as const], persistent: true as const, timeoutMs: 0, maxConcurrency: 1 as const };
  const model = { id: "saved-luna", provider: "OpenAI", baseUrl: "https://synthetic.invalid/v1", model: "fixture", apiKey: "synthetic", contextWindowTokens: 64000 };
  const requests: any[] = [], prepared: any[] = [];
  let resolveTool!: () => void, toolEntered!: () => void;
  const toolReady = new Promise<void>(resolve => { toolEntered = resolve; });
  let held: Promise<void> | undefined;
  const tool = { id: "inspect", name: "inspect", description: "inspect fixture", enabled: true, effectKind: "read" as const,
    inputSchema: { type: "object", properties: {} }, execute: async () => { toolEntered(); await held; return "synthetic tool result"; } };
  const parentMemory: MainMemoryRun = { call: vi.fn(), bindSink: sink => sink, close: async () => {} };
  const host: BackgroundMemoryHost = { async prepareBackgroundRun(input) {
    const context = requireBackgroundMemoryIngress(input.ingress); prepared.push({ input, context });
    await transcripts.append(context.sessionId, { id: input.userTurnId, turnId: input.userTurnId, revision: 1, kind: "user", payload: { text: input.instructionText } });
    const sink = createTranscriptSink({ store: transcripts, conversationId: context.sessionId, runId: input.runId, assistantTurnId: input.assistantTurnId });
    let round = 0;
    const memoryRun: MainMemoryRun = { async call(call) {
      requests.push(call); round++;
      return round === 1 ? { text: "inspect", toolCalls: [{ id: "inspect-1", name: "inspect", arguments: "{}" }] } : { text: "finished" };
    }, bindSink: sink => sink, close: vi.fn(async () => {}) };
    return { sessionId: context.sessionId, signal: context.signal, transcriptSink: sink, openMemoryRun: async () => memoryRun, close: memoryRun.close };
  } };
  const controller = new AbortController();
  const execute = createAgentExecutor({ parent: { parentConversationId: "parent-json-id", parentRunId: "parent-run", mode: "code", systemPrompt: "parent",
    vendorConfig: model, tools: [tool], resolvedWorkspaceRoot: root, signal: controller.signal,
    permissionMode: "auto", fileAccessLevel: "read-only", checkPermission: async () => true,
    backgroundMemory: host, memoryRun: parentMemory } as any,
    profiles: [profile], modelSettings: { modelProfiles: [model], agentModelProfiles: { coding: model.id } }, store, runStore } as any);
  vi.stubGlobal("fetch", vi.fn(async () => { throw Error("legacy fetch forbidden"); }));
  return { root, execute, store, transcripts, runStore, requests, prepared, parentMemory, controller, toolReady,
    holdTool: () => { held = new Promise(resolve => { resolveTool = resolve; }); }, releaseTool: () => resolveTool() };
}
it("child uses its saved profile, own canonical run and real parent capability for a complete synthetic tool loop", async () => {
  const f = await fixture(), result = await f.execute({ agentId: "specialist", prompt: "I prefer PowerShell" });
  expect(result.status).toBe("completed"); expect(f.prepared).toHaveLength(1); expect(f.requests).toHaveLength(2);
  const { input, context } = f.prepared[0];
  expect(context).toMatchObject({ entry: "child", sourceTrust: "model", sessionId: result.sessionId });
  expect(input).toMatchObject({ modelProfileId: "saved-luna", readParentGrant: f.parentMemory });
  const entries = (await f.transcripts.read(result.sessionId)).entries;
  expect(entries.map(entry => entry.kind)).toEqual(["user", "assistant", "tool_result", "assistant"]);
  expect(f.runStore.get(input.runId)).toMatchObject({ status: "completed", conversationId: result.sessionId, toolCalls: [{ toolCallId: "inspect-1", status: "committed" }] });
  expect(fetch).not.toHaveBeenCalled();
});
it("child cancellation keeps the real tool pending until it settles before closing the canonical run", async () => {
  const f = await fixture(); f.holdTool();
  const running = f.execute({ agentId: "specialist", prompt: "inspect" });
  await f.toolReady; f.controller.abort();
  let settled = false; void running.then(() => { settled = true; }, () => { settled = true; });
  await Promise.resolve(); expect(settled).toBe(false);
  f.releaseTool(); await running;
  expect(f.prepared).toHaveLength(1);
  expect(f.runStore.get(f.prepared[0].input.runId)?.status).toBe("cancelled");
  const sessionId = f.prepared[0].context.sessionId;
  expect((await f.transcripts.read(sessionId)).entries.some(entry => entry.kind === "interruption")).toBe(true);
});

it("preserves pre-SMH child audit history across resumes without importing it into canonical S", async () => {
  const f = await fixture();
  const legacy = new AgentSessionRegistry(f.store).acquire({ parentConversationId: "parent-json-id", parentRunId: "legacy-run", mode: "code",
    resolvedWorkspaceRoot: f.root, agentId: "specialist", modelProfile: "coding", savedModelProfileId: "saved-luna", description: "review", prompt: "legacy user fact" });
  const original = [{ role: "user", content: "legacy user fact" }, { role: "assistant", content: "legacy assistant audit", rawAssistant: [{ type: "text", text: "legacy assistant audit" }] }];
  f.store.checkpoint(legacy.id, { status: "completed", messages: original });
  const first = await f.execute({ agentId: "specialist", prompt: "current delegation" });
  const afterFirst = f.store.get(first.sessionId)!.messages;
  expect(afterFirst.slice(0, original.length)).toEqual(original);
  expect(afterFirst.filter(message => message.content === "current delegation")).toHaveLength(1);
  expect(JSON.stringify(f.requests.map(request => request.request.messages))).not.toContain("legacy user fact");
  expect(JSON.stringify((await f.transcripts.read(first.sessionId)).entries)).not.toContain("legacy assistant audit");
  await f.execute({ agentId: "specialist", prompt: "next delegation" });
  const afterSecond = f.store.get(first.sessionId)!.messages;
  expect(afterSecond.slice(0, afterFirst.length)).toEqual(afterFirst);
  expect(afterSecond.filter(message => message.content === "next delegation")).toHaveLength(1);
  expect(afterSecond.filter(message => message.content === "current delegation")).toHaveLength(1);
});
