import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { legacyStream, adapter } = vi.hoisted(() => ({
  legacyStream: vi.fn(async () => { throw new Error("legacy model dispatch forbidden"); }),
  adapter: {
    id: "memory-fixture", transport: "anthropic",
    applyCacheHints: (request: object) => ({ ...request, extraBody: { prompt_cache_key: "fixture-cache" } }),
    buildRequest: () => ({ url: "https://fixture.invalid", headers: {}, body: "{}" }),
    parseResponse: (response: unknown) => response,
  },
}));
vi.mock("../orchestrator/vendors/sdk-stream/runtime", () => ({ streamChatWithSdk: legacyStream }));
vi.mock("../orchestrator/vendors", async (original) => ({
  ...await original<typeof import("../orchestrator/vendors")>(),
  getAdapterForConfig: () => adapter,
  resolveTransport: () => "anthropic",
  streamChatWithSdk: legacyStream,
}));
vi.mock("../token-usage-store", () => ({ recordModelCall: () => undefined, recordToolCall: () => undefined, recordUsage: vi.fn(), recordRequest: vi.fn() }));
vi.mock("../timeout-manager", () => ({ getTimeoutSettings: () => ({ chatRequestTimeout: 60000 }) }));

import { runChatLoop } from "../orchestrator/chat-loop";
import { runFireflyHarness } from "../orchestrator/harness/firefly-harness";
import { callLLM } from "../orchestrator/harness/harness-llm";
import { DEFAULT_HARNESS_CONFIG } from "../orchestrator/harness/types";
import { ConversationTranscriptStore } from "../orchestrator/conversation-transcript-store";
import { materializeTranscript } from "../orchestrator/conversation-transcript-context";
import { createTranscriptSink, type TranscriptSink } from "../orchestrator/transcript-sink";
import type { MainMemoryRun } from "./main-memory-runtime";
import type { SdkStreamRunInput } from "../orchestrator/vendors/sdk-stream/runtime";
import type { UnifiedStreamDelta } from "../orchestrator/vendors/sdk-stream/types";
import type { ChatMessage, ChatResponse, ChatVendorAdapter, ToolCall, VendorConfig } from "../orchestrator/vendors/types";
import type { ToolDefinition } from "../orchestrator/tools/registry/tool-registry";

const vendorConfig: VendorConfig = {
  provider: "anthropic", baseUrl: "https://fixture.invalid", model: "fixture-model", apiKey: "fixture-key",
  explicitTransport: "anthropic", reasoning: { mode: "on" },
};
const roots: string[] = [];
function response(text: string, toolCalls: ToolCall[] = []): ChatResponse {
  const thinking = `reasoning:${text}`;
  const rawAssistant = [{ type: "thinking", thinking, signature: "synthetic-signature" }, { type: "text", text }];
  return {
    text, toolCalls, thinking, finishReason: toolCalls.length ? "tool_calls" : "stop", raw: {},
    assistantMessage: { role: "assistant", content: text, thinking, rawAssistant, ...(toolCalls.length ? { toolCalls } : {}) },
  };
}

/** A synthetic controlled model port, with the real loops, dispatcher and canonical store underneath. */
function controlledModel(steps: Array<ChatResponse | ((input: SdkStreamRunInput) => Promise<ChatResponse>)>) {
  const requests: SdkStreamRunInput[] = [];
  const writes: string[] = [];
  const bound = new WeakMap<TranscriptSink, TranscriptSink>();
  const run: MainMemoryRun = {
    async call(input) {
      requests.push({ ...input, request: structuredClone(input.request) });
      if (input.signal?.aborted) throw new Error("MEMORY_CONTEXT_CANCELLED");
      const step = steps.shift();
      if (!step) throw new Error("synthetic model exhausted");
      return typeof step === "function" ? step(input) : step;
    },
    bindSink(sink) {
      const previous = bound.get(sink);
      if (previous) return previous;
      const facade = Object.fromEntries(Object.entries(sink).map(([name, method]) => [name, (...args: unknown[]) => {
        writes.push(name);
        return (method as (...args: unknown[]) => unknown)(...args);
      }])) as unknown as TranscriptSink;
      bound.set(sink, facade); bound.set(facade, facade);
      return facade;
    },
    async close() {},
  };
  return { run, requests, writes };
}

async function transcript() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-memory-rounds-")); roots.push(root);
  const store = new ConversationTranscriptStore(root);
  await store.append("conversation", {
    kind: "user", id: "user-1", runId: "run", turnId: "turn", revision: 1, at: 1,
    payload: { text: "请分两轮检查字段 api_key 和 password 的定义。" },
  });
  return { store, sink: createTranscriptSink({ store, conversationId: "conversation", runId: "run" }) };
}
function chatOptions() {
  return {
    settings: { ...vendorConfig, contextWindowTokens: 256000 }, adapter: adapter as unknown as ChatVendorAdapter,
    messages: [{ role: "user" as const, content: "你好" }], soulSystemBaseContent: "人物设定",
    runtimeContext: "可信运行时环境", timeoutMs: 30000, fallbackRevealIntervalMs: 0,
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("legacy fetch forbidden"); }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("default memory model rounds", () => {
  it.each(["chat", "work", "code"])("%s completes two tool rounds exclusively through the controlled port", async (mode) => {
    const { store, sink } = await transcript();
    const toolCalls = [1, 2].map(n => ({ id: `call-${n}`, name: "inspect_fields", arguments: JSON.stringify({ field: n === 1 ? "api_key" : "password" }) }));
    const first = response("第一轮", [toolCalls[0]]), second = response("第二轮", [toolCalls[1]]);
    const model = controlledModel([first, second, response("检查完成")]);
    const executed: unknown[] = [];
    const tool: ToolDefinition = {
      id: "inspect_fields", name: "inspect_fields", description: "读取字段定义", enabled: true, effectKind: "read",
      inputSchema: { type: "object", properties: { field: { type: "string", description: "字段名" } }, required: ["field"] },
      execute: async args => { executed.push(args); return JSON.stringify({ definition: args.field }); },
    };
    const result = await runFireflyHarness({
      systemPrompt: "角色", promptLayers: { stablePrefix: "角色", sessionPrefix: "会话规则", mode },
      messages: [{ role: "user", content: "请分两轮检查字段 api_key 和 password 的定义。" }],
      tools: [tool], vendorConfig, transcriptSink: sink, memoryRun: model.run,
      includeInteractiveTools: false, allowedBuiltinToolIds: new Set(),
    });
    expect(result.terminateReason).toBeUndefined();
    expect(result.finalAnswer).toContain("检查完成");
    expect(executed).toEqual([{ field: "api_key" }, { field: "password" }]);
    expect(model.requests).toHaveLength(3);
    for (const call of model.requests) {
      expect(call.request.messages[0]).toEqual({ role: "system", content: "角色\n\n---\n\n会话规则" });
      expect(call.request.tools).toEqual([{ name: tool.id, description: tool.description, parameters: tool.inputSchema }]);
      expect(call.request.extraBody).toEqual({ prompt_cache_key: "fixture-cache" });
      expect(call.request.maxTokens).toBe(32768);
      expect(call.config).toEqual(vendorConfig);
    }
    expect(model.requests[1].request.messages).toEqual(expect.arrayContaining([
      first.assistantMessage, expect.objectContaining({ role: "tool", toolCallId: "call-1", content: expect.stringContaining("api_key") }),
    ]));
    expect(model.requests[2].request.messages).toEqual(expect.arrayContaining([
      second.assistantMessage, expect.objectContaining({ role: "tool", toolCallId: "call-2", content: expect.stringContaining("password") }),
    ]));
    const restored = materializeTranscript((await store.read("conversation")).entries, { get: () => null });
    expect(restored.messages).toEqual(expect.arrayContaining([
      first.assistantMessage, second.assistantMessage,
      expect.objectContaining({ role: "tool", toolCallId: "call-1" }), expect.objectContaining({ role: "tool", toolCallId: "call-2" }),
    ]));
    expect(model.writes.filter(name => name === "appendAssistant")).toHaveLength(3);
    expect(model.writes.filter(name => name === "appendToolResult")).toHaveLength(2);
    expect(legacyStream).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it("Chat preserves final prompt layers, cache hints and provider reasoning in the bound sink", async () => {
    const { store, sink } = await transcript(); const answer = response("你好呀");
    const model = controlledModel([answer]);
    const result = await runChatLoop({ ...chatOptions(), memoryRun: model.run, transcriptSink: sink, streamChat: legacyStream });
    expect(result.reply).toBe("你好呀");
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0].request.messages).toEqual([
      { role: "system", content: "人物设定" }, { role: "user", content: "你好" },
      { role: "user", content: "<runtime_context>\n可信运行时环境\n</runtime_context>" },
    ]);
    expect(model.requests[0].request.extraBody).toEqual({ prompt_cache_key: "fixture-cache" });
    expect(model.writes).toEqual(["appendAssistant"]);
    const entries = (await store.read("conversation")).entries;
    expect(entries.find(entry => entry.kind === "assistant")?.payload).toEqual(answer.assistantMessage);
    expect(legacyStream).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["chat", "harness"])("%s stream fallback starts a fresh controlled call", async (mode) => {
    const model = controlledModel([async () => { throw new Error("MEMORY_CONTEXT_STREAM_UNSUPPORTED"); }, response("非流式完成")]);
    if (mode === "chat") await runChatLoop({ ...chatOptions(), memoryRun: model.run });
    else await callLLM(vendorConfig, { stablePrefix: "角色" }, [{ role: "user", content: "你好" }], [], DEFAULT_HARNESS_CONFIG, undefined, undefined, undefined, model.run);
    expect(model.requests).toHaveLength(2);
    expect(model.requests[0].request.stream).toBe(true); expect(model.requests[1].request.stream).toBe(false);
    expect({ ...model.requests[0].request, stream: false }).toEqual(model.requests[1].request);
    expect(legacyStream).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["chat", "harness"])("%s does not retry a partially delivered stream", async (mode) => {
    const model = controlledModel([async input => {
      input.onDelta?.({ type: "text_delta", delta: "已开始" });
      throw new Error("HTTP 400 stream not supported");
    }]);
    const operation = mode === "chat"
      ? runChatLoop({ ...chatOptions(), memoryRun: model.run })
      : callLLM(vendorConfig, { stablePrefix: "角色" }, [{ role: "user", content: "你好" }], [], DEFAULT_HARNESS_CONFIG, undefined, undefined, undefined, model.run);
    await expect(operation).rejects.toThrow("stream not supported");
    expect(model.requests).toHaveLength(1); expect(fetch).not.toHaveBeenCalled(); expect(legacyStream).not.toHaveBeenCalled();
  });

  it.each(["chat", "harness"])("%s permits a fresh fallback after usage and empty deltas only", async mode => {
    const model = controlledModel([async input => {
      input.onDelta?.({ type: "usage", inputTokens: 12 });
      input.onDelta?.({ type: "text_delta", delta: "" });
      input.onDelta?.({ type: "reasoning_delta", delta: "" });
      throw new Error("MEMORY_CONTEXT_STREAM_UNSUPPORTED");
    }, response("fallback allowed")]);
    if (mode === "chat") await runChatLoop({ ...chatOptions(), memoryRun: model.run });
    else await callLLM(vendorConfig, { stablePrefix: "角色" }, [{ role: "user", content: "你好" }], [], DEFAULT_HARNESS_CONFIG, undefined, undefined, undefined, model.run);
    expect(model.requests.map(input => input.request.stream)).toEqual([true, false]);
    expect(legacyStream).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  const meaningfulDeltas: UnifiedStreamDelta[] = [
    { type: "tool_call_start", index: 0, id: "partial-call", nameDelta: "inspect" },
    { type: "tool_call_arguments_delta", index: 0, delta: '{"field":' },
    { type: "reasoning_delta", delta: "正在分析" },
    { type: "refusal", reason: "model refusal" },
    { type: "text_delta", delta: "[2026-10-06" },
  ];
  it.each(["chat", "harness"].flatMap(mode => meaningfulDeltas.map(delta => ({ mode, delta }))))("$mode does not replay a meaningful $delta.type delta", async ({ mode, delta }) => {
    const model = controlledModel([async input => {
      input.onDelta?.(delta);
      throw new Error("MEMORY_CONTEXT_STREAM_UNSUPPORTED");
    }, response("unexpected replay")]);
    const operation = mode === "chat"
      ? runChatLoop({ ...chatOptions(), memoryRun: model.run })
      : callLLM(vendorConfig, { stablePrefix: "角色" }, [{ role: "user", content: "你好" }], [], DEFAULT_HARNESS_CONFIG, undefined, undefined, undefined, model.run);
    await expect(operation).rejects.toThrow("MEMORY_CONTEXT_STREAM_UNSUPPORTED");
    expect(model.requests).toHaveLength(1); expect(legacyStream).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["chat", "harness"])("%s cancellation between attempts is rejected by the controlled port", async (mode) => {
    const controller = new AbortController();
    const model = controlledModel([async () => { controller.abort(); throw new Error("HTTP 400 stream not supported"); }, response("禁止发送")]);
    const operation = mode === "chat"
      ? runChatLoop({ ...chatOptions(), memoryRun: model.run, signal: controller.signal })
      : callLLM(vendorConfig, { stablePrefix: "角色" }, [{ role: "user", content: "你好" }], [], DEFAULT_HARNESS_CONFIG, controller.signal, undefined, undefined, model.run);
    await expect(operation).rejects.toThrow(/MEMORY_CONTEXT_CANCELLED/);
    expect(fetch).not.toHaveBeenCalled(); expect(legacyStream).not.toHaveBeenCalled();
  });

  it.each(["chat", "harness"])("%s excessive history fails its S budget without an old compression request", async (mode) => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const messages: ChatMessage[] = Array.from({ length: 60 }, (_, n) => ({ role: n % 2 ? "assistant" : "user", content: "历史内容".repeat(300) }));
    const model = controlledModel([async () => { throw new Error("MEMORY_CONTEXT_BUDGET_EXCEEDED"); }]);
    if (mode === "chat") {
      await expect(runChatLoop({ ...chatOptions(), messages, settings: { ...vendorConfig, contextWindowTokens: 1000 }, memoryRun: model.run })).rejects.toThrow("MEMORY_CONTEXT_BUDGET_EXCEEDED");
    } else {
      const result = await runFireflyHarness({ systemPrompt: "角色", messages, tools: [], vendorConfig, memoryRun: model.run, config: { contextWindowTokens: 1000 } });
      expect(result.terminateReason).toBe("error"); expect(result.finalAnswer).toContain("MEMORY_CONTEXT_BUDGET_EXCEEDED");
      expect(result.failure).toEqual({code:"MEMORY_CONTEXT_BUDGET_EXCEEDED",source:"context"});
      expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("run failed"), expect.objectContaining({code:"MEMORY_CONTEXT_BUDGET_EXCEEDED",source:"context"}));
    }
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0].request.messages.filter(message => message.role !== "system")).toHaveLength(mode === "chat" ? 61 : 60);
    expect(fetch).not.toHaveBeenCalled(); expect(legacyStream).not.toHaveBeenCalled();
  });

  it.each(["MEMORY_CONTEXT_TRANSCRIPT_SECRET", "MEMORY_SOURCE_STALE", "MEMORY_CONTEXT_SEND_UNKNOWN"])("Chat cannot turn %s into a caption retry", async code => {
    const model = controlledModel([async () => { throw new Error(code); }, response("不得发送")]);
    let captionRequests = 0;
    await expect(runChatLoop({
      ...chatOptions(), memoryRun: model.run,
      imageCaptionFallback: async () => { captionRequests++; return [{ role: "user", content: "caption" }]; },
    })).rejects.toThrow(code);
    expect(captionRequests).toBe(0); expect(model.requests).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled(); expect(legacyStream).not.toHaveBeenCalled();
  });

  it.each(["chat", "harness"])("%s respects a cancelled bound sink instead of committing to the original sink", async mode => {
    const { store, sink } = await transcript();
    const initial = await store.read("conversation");
    const model = controlledModel([response("迟到的回复")]);
    model.run.bindSink = original => ({ ...original, appendAssistant: async () => { throw new Error("MEMORY_CONTEXT_CANCELLED"); } });
    if (mode === "chat") {
      await expect(runChatLoop({ ...chatOptions(), memoryRun: model.run, transcriptSink: sink })).rejects.toThrow("MEMORY_CONTEXT_CANCELLED");
    } else {
      const result = await runFireflyHarness({
        systemPrompt: "角色", messages: [{ role: "user", content: "你好" }], tools: [], vendorConfig,
        memoryRun: model.run, transcriptSink: sink,
      });
      expect(result.terminateReason).toBe("error"); expect(result.finalAnswer).toContain("MEMORY_CONTEXT_CANCELLED");
    }
    expect(await store.read("conversation")).toEqual(initial);
    expect(fetch).not.toHaveBeenCalled(); expect(legacyStream).not.toHaveBeenCalled();
  });

  it("restores interrupted call-result pairs without replaying historical tool calls", async () => {
    const { store, sink } = await transcript();
    const interrupted = response("正在读取", [
      { id: "started", name: "inspect_fields", arguments: '{"field":"api_key"}' },
      { id: "queued", name: "inspect_fields", arguments: '{"field":"password"}' },
    ]);
    await sink.appendAssistant({ message: interrupted.assistantMessage, roundId: "round-0" });
    await sink.closeInterruption({ reason: "user_cancel", runSession: {
      schemaVersion: 1, conversationId: "conversation", runId: "run", status: "interrupted",
      messages: [], state: { todoItems: [], uncertainEffects: [] }, toolOutputs: [], rounds: 1,
      cache: { cacheEpoch: 1, epochReason: "run_start" }, createdAt: 1, updatedAt: 1,
      request: { provider: vendorConfig.provider, model: vendorConfig.model, contextWindowTokens: 256000, promptFingerprint: "fixture", toolSchemaFingerprint: "fixture" },
      toolCalls: [
        { toolCallId: "started", toolName: "inspect_fields", sideEffect: "read_only", status: "started", updatedAt: 1 },
        { toolCallId: "queued", toolName: "inspect_fields", sideEffect: "read_only", status: "planned", updatedAt: 1 },
      ],
    } });
    const snapshot = await store.read("conversation");
    expect(snapshot.entries.filter(entry => entry.kind === "tool_result").map(entry => entry.payload.outcome)).toEqual(["unknown", "not_executed"]);
    const restored = materializeTranscript(snapshot.entries, { get: () => null });
    const executed: unknown[] = [];
    const model = controlledModel([response("上次读取是否完成还不确定")]);
    const result = await runFireflyHarness({
      systemPrompt: "角色", messages: restored.messages, vendorConfig, memoryRun: model.run,
      transcriptSink: createTranscriptSink({ store, conversationId: "conversation", runId: "resumed-run" }),
      tools: [{ id: "inspect_fields", name: "inspect_fields", description: "字段定义", enabled: true, effectKind: "read",
        inputSchema: { type: "object", properties: {} }, execute: async args => { executed.push(args); return "unexpected replay"; } }],
    });
    expect(result.finalAnswer).toContain("不确定"); expect(executed).toEqual([]);
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0].request.messages).toEqual(expect.arrayContaining([
      interrupted.assistantMessage,
      expect.objectContaining({ role: "tool", toolCallId: "started" }),
      expect.objectContaining({ role: "tool", toolCallId: "queued" }),
    ]));
    expect(fetch).not.toHaveBeenCalled(); expect(legacyStream).not.toHaveBeenCalled();
  });
});
