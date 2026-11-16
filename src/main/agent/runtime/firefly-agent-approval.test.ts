import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lastValueFrom, toArray } from "rxjs";
import { EventType } from "@ag-ui/core";
import type { ApprovalRequest } from "../../../shared/permission-approval";
import { IPC } from "../../../shared/ipc-channels";

const host = vi.hoisted(() => ({ root: "", send: vi.fn(), handle: vi.fn(), llm: vi.fn() }));
vi.mock("electron", () => ({ app: { getPath: () => host.root, on: vi.fn() },
  BrowserWindow: { getAllWindows: () => [{ webContents: { send: host.send } }] },
  ipcMain: { handle: host.handle } }));
vi.mock("../loop/agent-loop-llm", () => ({ callLLM: host.llm, summarizeHistory: vi.fn() }));
vi.mock("../../model/providers", async original => ({ ...await original<typeof import("../../model/providers")>(),
  getAdapterForConfig: () => ({ id: "g2-model" }) }));
vi.mock("../../base/storage/token-usage-store", () => ({ recordMessage: vi.fn(), recordPluginCall: vi.fn(),
  recordModelCall: vi.fn(), recordToolCall: vi.fn(), recordUsage: vi.fn(), recordRequest: vi.fn() }));

import { FireflyAgent, type FireflyRunOptions } from "./firefly-agent";
import { toolRegistry, type ToolDefinition } from "../../tooling/registry/tool-registry";
import { cancelPendingApprovalsForRun, registerPermissionIpc, setCurrentLevel } from "../../platform/permission/permission";
import { prepareAgentLoopRun } from "./adapter/run-preparation";
import { prepareToolRuntime } from "./adapter/tool-runtime";
import { runChildSession } from "./child-session-runtime";
import { AgentSessionRegistry } from "../tasks/agent-session-registry";
import { TaskSessionStore } from "../tasks/task-session-store";
import { answerApproval, getPendingApproval } from "../../platform/permission/permission";
import { createApprovalReview } from "../../platform/toast/approval-review";
import { getConversationTranscriptStore } from "../../conversation/transcript/conversation-transcript-store";
import { createTranscriptSink } from "../loop/transcript-sink";

const execute = vi.fn(async () => "g2 saved");
const tool: ToolDefinition = { id: "g2_save", name: "G2 save", description: "Synthetic approval probe", enabled: true,
  risk: "fs-write", effectKind: "read", inputSchema: { type: "object", properties: {} }, execute };
const call = { id: "g2-call", name: tool.id, arguments: "{}" };
const cards = () => host.send.mock.calls.filter(([channel]) => channel === IPC.PERMISSION_APPROVAL_REQUEST)
  .map(([, card]) => card as ApprovalRequest);
function options(mode: "chat" | "work" | "code", runId: string): FireflyRunOptions {
  return { runId, conversationId: `g2-${mode}`, conversationMode: mode, executionMode: mode === "chat" ? "chat" : "work",
    tools: [tool], settings: { provider: "custom", baseUrl: "https://fixture.invalid/v1", model: "fixture", apiKey: "", contextWindowTokens: 96_000 },
    messages: [{ role: "user", content: "Save synthetic note" }], toolSystemContent: "", soulSystemBaseContent: "Synthetic",
    timeoutMs: 0, maxToolRounds: 3 };
}
function expectedCard(runId: string, origin = {}) {
  return { id: expect.stringMatching(/^approve-/), toolId: tool.id, toolName: tool.name,
    toolDescription: tool.description, args: {}, risk: "fs-write", runId, toolCallId: call.id, ...origin };
}
beforeEach(() => {
  host.root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-g2-"));
  host.send.mockReset(); host.handle.mockReset(); host.llm.mockReset(); execute.mockClear();
  registerPermissionIpc();
  setCurrentLevel("per-action");
  toolRegistry.register(tool);
  host.llm.mockResolvedValueOnce({ text: "", toolCalls: [call], finishReason: "tool_calls", raw: {},
    assistantMessage: { role: "assistant", content: "", toolCalls: [call] } })
    .mockResolvedValue({ text: "Saved", toolCalls: [], finishReason: "stop", raw: {},
      assistantMessage: { role: "assistant", content: "Saved" } });
});
afterEach(() => {
  for (const card of cards()) if (card.runId) cancelPendingApprovalsForRun(card.runId);
  toolRegistry.unregister(tool.id);
  fs.rmSync(host.root, { recursive: true, force: true });
});

describe("approval requests carry the run id (ChatPage G2)", () => {
  it.each(["work", "code", "chat"] as const)("%s tool run sends exactly its run id to approval before executing", async mode => {
    const runId = `g2-run-${mode}`;
    const controller = new AbortController();
    const pending = lastValueFrom(new FireflyAgent({ threadId: `g2-${mode}` }).runWithEvents({ ...options(mode, runId), signal: controller.signal }).pipe(toArray()));
    void pending.catch(() => {});
    try {
      // 先看到挂起的审批卡，再经真实的权限宿主放行。
      await vi.waitFor(() => expect(cards()).toEqual([expectedCard(runId)]));
      expect(execute).not.toHaveBeenCalled();
      const resolve = host.handle.mock.calls.find(([channel]) => channel === IPC.PERMISSION_APPROVAL_RESOLVE)![1];
      expect(resolve({}, { id: cards()[0].id, allowed: true })).toEqual({ ok: true });
      const events = await pending;
      expect(execute).toHaveBeenCalledTimes(1);
      expect(events.filter(event => event.type === EventType.RUN_STARTED).map(event => event.runId)).toEqual([runId]);
      expect(events.filter(event => event.type === EventType.RUN_FINISHED).map(event => event.runId)).toEqual([runId]);
      expect(cards()).toEqual([expectedCard(runId)]);
    } finally {
      controller.abort();
      await pending.catch(() => {});
    }
  });

  it("child approval uses the parent run id and child origin and is cancelled with the parent run", async () => {
    const parentRunId = "g2-parent";
    const config = options("code", parentRunId);
    const controller = new AbortController();
    const signal = controller.signal;
    const prepared = await prepareAgentLoopRun(config, signal);
    const runtime = prepareToolRuntime({ options: config, signal, prepared, sendBaseEvent: vi.fn() });
    const store = new TaskSessionStore(host.root);
    const session = new AgentSessionRegistry(store).acquire({ agentId: "g2-agent", modelProfile: "coding",
      savedModelProfileId: "g2-model", parentConversationId: config.conversationId!, parentRunId,
      mode: "code", resolvedWorkspaceRoot: host.root, description: "G2 child", prompt: "Save synthetic note" });
    const pending = runChildSession({ session, store, prompt: "Save synthetic note", description: "G2 child",
      systemPrompt: "Synthetic", tools: [tool], lease: null, config: { totalTimeoutMs: 0, maxRounds: 3 },
      parent: { parentConversationId: config.conversationId!, parentRunId, mode: "code", systemPrompt: "Synthetic",
        vendorConfig: prepared.vendorConfig, tools: [tool], signal: runtime.signal,
        fileAccessLevel: "per-action", checkPermission: runtime.checkPermission } });
    try {
      await vi.waitFor(() => expect(cards()).toEqual([expectedCard(parentRunId, {
        agentId: session.agent.id, childRunId: session.childRunId,
      })]));
      expect(execute).not.toHaveBeenCalled();
      cancelPendingApprovalsForRun(parentRunId);
      expect(host.send.mock.calls.filter(([channel]) => channel === IPC.PERMISSION_APPROVAL_SETTLED).map(([, payload]) => payload))
        .toEqual([{ id: cards()[0].id, runId: parentRunId, reason: "cancelled" }]);
      controller.abort();
      const result = await pending;
      expect(result.status).toBe("cancelled");
      expect(execute).not.toHaveBeenCalled();
    } finally {
      controller.abort();
      for (const card of cards()) if (card.runId) cancelPendingApprovalsForRun(card.runId);
      await pending;
    }
  });
});

describe("approval answered from the toast review", () => {
  it("lets the original run finish and records its tool result and answer once", async () => {
    const runId = "review-run";
    const config: FireflyRunOptions = { ...options("work", runId), conversationId: "review-session" };
    const store = getConversationTranscriptStore(host.root);
    config.transcriptSink = createTranscriptSink({ store, conversationId: "review-session", runId });
    // The renderer that started the run is gone; only Main's run registry still knows its session.
    const review = createApprovalReview({ getPendingApproval, answerApproval,
      findActiveSessionForRun: id => id === runId ? "review-session" : undefined });
    const pending = lastValueFrom(new FireflyAgent({ threadId: "review-session" }).runWithEvents(config).pipe(toArray()));
    await vi.waitFor(() => expect(cards()).toEqual([expectedCard(runId)]));
    const id = cards()[0].id;
    expect(review.inspect(id)).toMatchObject({ state: "pending", session: { id: "review-session" } });
    expect(review.answer(id, true)).toEqual({ ok: true });
    expect(review.answer(id, true)).toEqual({ ok: false });
    const events = await pending;
    expect(events.filter(event => event.type === EventType.RUN_FINISHED).map(event => event.runId)).toEqual([runId]);
    expect(execute).toHaveBeenCalledTimes(1);
    const { entries } = await store.read("review-session");
    // One assistant turn that called the tool, one tool result, one final answer: nothing replayed or duplicated.
    expect(entries.map(entry => entry.kind)).toEqual(["assistant", "tool_result", "assistant"]);
    expect(entries.filter(entry => entry.kind === "tool_result").map(entry => entry.payload.toolCallId)).toEqual([call.id]);
    expect(entries.at(-1)).toMatchObject({ kind: "assistant", payload: { role: "assistant", content: "Saved" } });
    expect(entries.every(entry => entry.runId === runId)).toEqual(true);
  });
});
