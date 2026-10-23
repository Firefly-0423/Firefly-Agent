import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";

const fakeLLM = vi.hoisted(() => vi.fn());
vi.mock("./harness-llm", () => ({ callLLM: fakeLLM, summarizeHistory: vi.fn() }));

import { runFireflyHarness } from "./firefly-harness";
import { RunExecutionCoordinator } from "./execution-coordinator";
import { HarnessRunStore, type HarnessRunSession } from "./run-store";
import type { ToolDefinition } from "../tools/registry/tool-registry";
import type { TranscriptSink } from "../transcript-sink";
import type { HarnessToolLifecycleEvent } from "./types";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function read(id: string, execute: ToolDefinition["execute"]): ToolDefinition {
  return { id, name: id, description: "synthetic read", enabled: true,
    inputSchema: { type: "object", properties: {} }, effectKind: "read", isConcurrencySafe: () => true, execute };
}

const vendorConfig = { provider: "fixture", baseUrl: "http://127.0.0.1:1", model: "fixture", apiKey: "" };

beforeEach(() => { fakeLLM.mockReset(); });

it.each(["started persistence", "transcript append", "committed persistence", "result checkpoint", "started then checkpoint"] as const)(
  "quiesces nested %s failure before draining original siblings, preserving the initiating error",
  async failurePoint => {
    const coordinator = new RunExecutionCoordinator(`synthetic-scheduler-failure-${failurePoint}`);
    const external = new AbortController();
    const owner = new AbortController();
    const signal = AbortSignal.any([external.signal, owner.signal]);
    const scope = { workspaceId: coordinator.workspaceId, parentRunId: "main", groupId: "main", agentId: "main", childRunId: "main", toolCallId: "main" };
    const siblingStarted = deferred();
    const siblingAborted = deferred();
    const actualSettlement = deferred();
    const error = Object.assign(new Error(`synthetic ${failurePoint} failure`), {code:"E_TOOL_EXECUTION_FAILED"});
    let returned = false;
    let quiesceCalls = 0;
    let siblingSettled = false;
    let competingEntered = false;
    const terminalEvents: string[] = [];
    const lifecycle: HarnessToolLifecycleEvent[] = [];
    const tools = [read("read_first", async () => "first"), read("read_second", async (_args, context) => {
      siblingStarted.resolve();
      await new Promise<void>(resolve => {
        if (context!.signal!.aborted) resolve();
        else context!.signal!.addEventListener("abort", () => resolve(), { once: true });
      });
      siblingAborted.resolve();
      await actualSettlement.promise;
      siblingSettled = true;
      return "second genuinely settled";
    })];
    const calls = tools.map(tool => ({ id: tool.id, name: tool.id, arguments: "{}" }));
    fakeLLM.mockResolvedValueOnce({ assistantMessage: { role: "assistant", content: "", toolCalls: calls },
      text: "", toolCalls: calls, finishReason: "tool_calls", raw: {} });
    const sink = { appendAssistant: async () => "assistant-entry", appendToolResult: async ({ message }: { message: { toolCallId: string } }) => {
      if (failurePoint === "transcript append" && message.toolCallId === "read_first") throw error;
      return "result-entry";
    } } as unknown as TranscriptSink;
    const pending = runFireflyHarness({
      systemPrompt: "synthetic", messages: [], tools, vendorConfig, transcriptSink: sink,
      config: { maxParallelToolCalls: 2 }, signal,
      quiesceExecution: () => { quiesceCalls++; owner.abort(); },
      toolContext: { userQuery: "synthetic", signal, execution: { coordinator, scope } },
      onToolLifecycle: event => {
        lifecycle.push(event);
        if (event.toolCallId === "read_first" && (((failurePoint === "started persistence" || failurePoint === "started then checkpoint") && event.status === "started")
          || (failurePoint === "committed persistence" && event.status === "committed"))) throw error;
      },
      onCheckpoint: value => {
        if (value.messages.some(message => message.role === "tool")) {
          if (failurePoint === "result checkpoint") throw error;
          if (failurePoint === "started then checkpoint") throw new Error("secondary checkpoint failure");
        }
      },
      onEvent: event => { if (event.type === "context_usage" && event.snapshot.phase === "terminal") terminalEvents.push("terminal"); },
    }).then(result => { returned = true; return result; });
    let competing: Promise<unknown> | undefined;
    try {
      await siblingStarted.promise;
      competing = coordinator.runLeaf({ ...scope, groupId: "competitor", childRunId: "competitor", toolCallId: "competitor" }, "exclusive", undefined,
        async () => { competingEntered = true; return "competitor"; });
      await expect.poll(() => quiesceCalls).toBeGreaterThan(0);
      await siblingAborted.promise;
      expect(owner.signal.aborted).toBe(true);
      expect(external.signal.aborted).toBe(false);
      expect(returned).toBe(false);
      expect(siblingSettled).toBe(false);
      expect(competingEntered).toBe(false);
      expect(terminalEvents).toEqual([]);
      actualSettlement.resolve();
      const result = await pending;
      expect(result.terminateReason).toBe("error");
      expect(result.failure).toEqual({code:"E_TOOL_EXECUTION_FAILED",source:"tool"});
      expect(result.finalAnswer).toContain("E_TOOL_EXECUTION_FAILED");
      expect(result.finalAnswer).not.toContain(error.message);
      if (failurePoint === "started then checkpoint") {
        expect(result.finalAnswer).toContain("执行状态保存失败：E_HARNESS_FAILURE");
        expect(result.finalAnswer).not.toContain("secondary checkpoint failure");
      }
      expect(siblingSettled).toBe(true);
      expect(external.signal.aborted).toBe(false);
      expect(fakeLLM).toHaveBeenCalledOnce();
      if (failurePoint === "result checkpoint") {
        expect(lifecycle.filter(event => event.status === "committed")).toEqual([]);
      }
      await competing;
    } finally {
      owner.abort();
      actualSettlement.resolve();
      await pending;
      await competing;
      await coordinator.closeGroup("competitor");
    }
  },
);

it("checkpoints each canonical result before publishing its committed lifecycle", async () => {
  const calls = [{ id: "read_one", name: "read_one", arguments: "{}" }];
  fakeLLM.mockResolvedValueOnce({ assistantMessage: { role: "assistant", content: "", toolCalls: calls },
    text: "", toolCalls: calls, finishReason: "tool_calls", raw: {} })
    .mockResolvedValueOnce({ assistantMessage: { role: "assistant", content: "done" }, text: "done", toolCalls: [], finishReason: "stop", raw: {} });
  const trace: string[] = [];
  let committedSnapshot: HarnessRunSession | undefined;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-result-checkpoint-"));
  const store = new HarnessRunStore(root);
  store.create({ conversationId: "synthetic", runId: "snapshot", messages: [], request: {
    provider: "fixture", model: "fixture", contextWindowTokens: 128000, promptFingerprint: "synthetic", toolSchemaFingerprint: "synthetic",
  } });
  try {
    await runFireflyHarness({
      systemPrompt: "synthetic", messages: [], vendorConfig, tools: [read("read_one", async () => "known canonical result")],
      transcriptSink: { appendAssistant: async () => "assistant-entry", appendToolResult: async () => { trace.push("canonical result"); return "result-entry"; } } as unknown as TranscriptSink,
      onCheckpoint: value => {
        store.checkpoint("snapshot", value);
        if (value.messages.some(message => message.role === "tool")) trace.push("result checkpoint");
      },
      onToolLifecycle: event => {
        store.recordTool("snapshot", { toolCallId: event.toolCallId, toolName: event.toolName, sideEffect: event.toolSideEffect, status: event.status });
        if (event.status === "committed") {
          committedSnapshot = JSON.parse(fs.readFileSync(path.join(root, "firefly-runs", "sessions", "snapshot.json"), "utf8"));
          trace.push("committed");
        }
      },
    });
    expect(committedSnapshot?.messages.at(-1)).toMatchObject({ role: "tool", toolCallId: "read_one" });
    expect(committedSnapshot?.toolCalls).toEqual([expect.objectContaining({ toolCallId: "read_one", status: "committed" })]);
    expect(trace.slice(0, 3)).toEqual(["canonical result", "result checkpoint", "committed"]);
  } finally {
    store.markTerminal("snapshot", "completed");
    fs.rmSync(root, { recursive: true, force: true });
  }
});
