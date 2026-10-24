import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ChatRequest, VendorConfig } from "./vendors/types";

const fixture = vi.hoisted(() => ({ root: "", requests: [] as { request: ChatRequest; config: VendorConfig }[] }));
vi.mock("electron", () => ({ app: { getPath: () => fixture.root } }));
vi.mock("./vendors", () => ({
  getAdapterForConfig: () => ({ id: "offline-fixture" }),
  resolveTransport: () => "openai",
  streamChatWithSdk: async (input: { request: ChatRequest; config: VendorConfig }) => {
    fixture.requests.push(input);
    return { text: "Public fixture completed", toolCalls: [], finishReason: "stop", raw: {} };
  },
}));
vi.mock("../token-usage-store", () => ({ recordModelCall: () => undefined, recordToolCall: () => undefined, recordUsage: vi.fn(), recordRequest: vi.fn() }));

import { prepareToolRuntime } from "./harness/adapter/tool-runtime";
import { saveModelSettings } from "../settings/model-settings";
import { getTaskSessionStore, TaskSessionStore } from "../tasks/task-session-store";
import { SPECIALIST_AGENTS } from "../../shared/specialist-agents";
import { getHarnessBuiltinToolSpecs } from "./harness/builtin-tools";

afterEach(() => { if (fixture.root) fs.rmSync(fixture.root, { recursive: true, force: true }); fixture.requests.length = 0; });

it("uses Main's real factory, shared store and child Harness for all twelve identities and persistent resume", async () => {
  fixture.root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-specialist-main-"));
  saveModelSettings({ modelProfiles: [{ id: "fixture-saved", provider: "fixture", baseUrl: "http://127.0.0.1:12345", model: "offline-fixture", apiKey: "" }],
    agentModelProfiles: { reasoning: "fixture-saved", coding: "fixture-saved", document: "fixture-saved", research: "fixture-saved", vision: "fixture-saved", fast: "fixture-saved" } });
  const runtime = prepareToolRuntime({
    options: { conversationId: "public-conversation", conversationMode: "work", messages: [],
      settings: {}, resolvedWorkspaceRoot: fixture.root, capabilities: { tools: [], toolIds: new Set(), skills: [], skillIds: new Set(), mode: "work" } } as never,
    signal: new AbortController().signal,
    prepared: { threadId: "public-conversation", runId: "public-run", systemPrompt: "Main fixture", vendorConfig: {}, tools: [] } as never,
    sendBaseEvent: vi.fn(),
  });
  const spec = getHarnessBuiltinToolSpecs({ includeAgent: true, agentDefinitions: runtime.agentDefinitions });
  expect(spec.find(tool => tool.name === "delegate_agent")?.description).toContain("strategy-planning（艾利欧）");
  const sessions = new Map<string, string>();
  for (const id of SPECIALIST_AGENTS.map(agent => agent.id)) {
    const result = await runtime.agentExecutor!({ agentId: id, prompt: `Public ${id} fixture` });
    expect(result.status).toBe("completed");
    sessions.set(id, result.sessionId);
  }
  expect(new Set(sessions.values()).size).toBe(12);
  const again = await runtime.agentExecutor!({ agentId: "review", prompt: "Public follow-up" });
  expect(again.sessionId).toBe(sessions.get("review"));
  const store = getTaskSessionStore(fixture.root);
  expect(store.get(again.sessionId)?.messages.filter(message => message.role === "user")).toHaveLength(2);
  const restored = new TaskSessionStore(fixture.root);
  expect(restored.get(again.sessionId)?.agent?.savedModelProfileId).toBe("fixture-saved");
  expect(restored.get(again.sessionId)?.agent?.id).toBe("review");
  for (const { request, config } of fixture.requests) {
    expect(config.model).toBe("offline-fixture");
    expect(request.tools?.map(tool => tool.name)).not.toEqual(expect.arrayContaining(["delegate_agent"]));
    for (const blocked of ["task", "delegate_agent", "ask_user", "confirm_uncertain_effect", "enter_plan_mode"]) {
      expect(request.tools?.some(tool => tool.name === blocked)).toBe(false);
    }
  }
});
