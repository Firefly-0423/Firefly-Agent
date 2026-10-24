import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const harnessModel = vi.hoisted(() => vi.fn());
vi.mock("../token-usage-store", () => ({ recordModelCall: vi.fn(), recordToolCall: vi.fn(), recordUsage: vi.fn(), recordRequest: vi.fn() }));
vi.mock("./vendors", async (original) => ({ ...await original<typeof import("./vendors")>(), streamChatWithSdk: harnessModel }));
import { runChatLoop, type ChatLoopOptions } from "./chat-loop";
import { createSseReader } from "./vendors";
import type { ChatRequest, ChatMessage, ChatResponse, ChatVendorAdapter } from "./vendors/types";
import { ConversationTranscriptStore } from "./conversation-transcript-store";
import { materializeTranscript } from "./conversation-transcript-context";
import { createTranscriptSink, type TranscriptSink } from "./transcript-sink";
import { runFireflyHarness } from "./harness/firefly-harness";
import type { ToolDefinition } from "./tools/registry/tool-registry";

const completed = (text = "Calendar ready", thinking?: string): ChatResponse => ({ text, ...(thinking ? { thinking } : {}), assistantMessage: { role: "assistant", content: text, ...(thinking ? { thinking } : {}) }, toolCalls: [], finishReason: "stop", raw: {}, usage: { input: 28, output: 9 } });
function gateway() {
  const requests: ChatRequest[] = [];
  const build = (request: ChatRequest) => { requests.push(request); return { url: "https://calendar.invalid/model", method: "POST" as const, headers: {}, body: "{}" }; };
  const adapter: ChatVendorAdapter = {
    id: "calendar-gateway", transport: "openai", capability: { id: "calendar-gateway", displayName: "Calendar", transport: "openai", baseUrl: "https://calendar.invalid", authStyle: "bearer", defaultModel: "calendar-model", supportsTools: true, supportsThinking: false, thinkingField: null, cacheStrategy: "none", testStrategy: "text" },
    buildRequest: build, buildStreamRequest: build,
    parseResponse: (raw: any) => completed(raw?.answer ?? "Calendar ready", raw?.reason),
    parseStreamEvent: ({ data }) => data === "[DONE]" ? { done: true } : JSON.parse(data),
    appendToolResults: (messages) => messages, testConnection: async () => ({ ok: true, latency: 0 }),
  };
  return { requests, adapter };
}
const httpStream: NonNullable<ChatLoopOptions["streamChat"]> = async (input) => {
  const http = input.adapter.buildStreamRequest(input.request, input.config);
  const response = await fetch(http.url, { method: "POST", headers: http.headers, body: http.body, signal: input.signal });
  if (!response.ok) throw Object.assign(Error("HTTP " + response.status + " - " + await response.text()), { status: response.status });
  if (response.headers.get("content-type")?.includes("application/json")) return input.adapter.parseResponse(await response.json());
  const parts = { text: "", thinking: "", input: 0, output: 0 };
  for await (const event of createSseReader(input.adapter, response.body!)) {
    const chunk = input.adapter.parseStreamEvent(event);
    if (chunk?.deltaThinking) { parts.thinking += chunk.deltaThinking; input.onDelta?.({ type: "reasoning_delta", delta: chunk.deltaThinking }); }
    if (chunk?.deltaText) { parts.text += chunk.deltaText; input.onDelta?.({ type: "text_delta", delta: chunk.deltaText }); }
    if (chunk?.usage) { parts.input = Math.max(parts.input, chunk.usage.input); parts.output = Math.max(parts.output, chunk.usage.output); }
    if (chunk?.done) break;
  }
  return { ...completed(parts.text, parts.thinking), usage: { input: parts.input, output: parts.output } };
};
const streamResponse = (...chunks: unknown[]) => new Response(chunks.map((chunk) => "data: " + (chunk === "[DONE]" ? chunk : JSON.stringify(chunk)) + "\n\n").join(""), { headers: { "content-type": "text/event-stream" } });
function scenario(patch: Partial<ChatLoopOptions> = {}) {
  const { requests, adapter } = gateway(), emit = vi.fn(), record = vi.fn();
  const options: ChatLoopOptions = { adapter, settings: { provider: "Calendar", baseUrl: "https://calendar.invalid", model: "calendar-model", apiKey: "calendar-key", contextWindowTokens: 256_000 }, messages: [{ role: "user", content: "Read Tuesday" }], soulSystemBaseContent: "CALENDAR_PERSONA", timeoutMs: 30_000, fallbackRevealIntervalMs: 0, onEvent: emit, recordUsage: record, streamChat: httpStream, ...patch };
  return { requests, emit, record, options, run: () => runChatLoop(options) };
}
function sink(patch: Partial<TranscriptSink> = {}): TranscriptSink {
  return { appendSAssistant: vi.fn(async () => "calendar-s-entry"), settleSAssistant: vi.fn(async () => {}), appendAssistant: vi.fn(async () => "calendar-assistant-entry"), appendToolResult: vi.fn(async () => {}), closeInterruption: vi.fn(async () => {}), checkpoint: vi.fn(async () => {}), ...patch };
}
const roots: string[] = [];
beforeEach(() => {
  harnessModel.mockReset();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { headers: { "content-type": "application/json" } })));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); roots.splice(0).forEach((root) => fs.rmSync(root, { force: true, recursive: true })); });

describe("Plain chat request and event contract", () => {
  it("keeps persona stable and appends runtime context only to the outgoing request", async () => {
    const test = scenario({ runtimeContext: "Calendar timezone: UTC", timeoutMs: 0 });
    await test.run();
    expect(test.requests[0].messages[0]).toEqual({ role: "system", content: "CALENDAR_PERSONA" });
    expect(test.requests[0].messages.at(-1)).toEqual({ role: "user", content: "<runtime_context>\nCalendar timezone: UTC\n</runtime_context>" });
  });
  it("makes one unstructured tool-free request and reports usage and text lifecycle events", async () => {
    const test = scenario(), result = await test.run();
    expect(test.requests).toHaveLength(1);
    expect(test.requests[0]).toMatchObject({ stream: true, messages: [{ role: "system", content: "CALENDAR_PERSONA" }, { role: "user", content: "Read Tuesday" }] });
    expect(test.requests[0].tools).toBeUndefined(); expect(test.requests[0].structuredOutput).toBeUndefined();
    expect(result.toolResults).toEqual([]); expect(result.reply).toEqual("Calendar ready"); expect(result.totalUsage).toEqual({ input: 28, output: 9 });
    expect(test.record).toHaveBeenCalledWith(28, 9, 1, undefined, undefined);
    expect(test.emit).toHaveBeenCalledWith(expect.objectContaining({ type: "text_message_start" }));
    expect(test.emit).toHaveBeenCalledWith(expect.objectContaining({ type: "text_message_end" }));
  });
  it("uses an injected SDK runner once and emits pre-request then terminal usage including the answer", async () => {
    const streamChat = vi.fn(async (input: any) => { input.onDelta?.({ type: "text_delta", delta: "Calendar SDK answer" }); return completed("Calendar SDK answer"); });
    const test = scenario({ streamChat, runtimeContext: "Calendar timezone: UTC" }), result = await test.run();
    expect(streamChat).toHaveBeenCalledOnce(); expect(result.reply).toEqual("Calendar SDK answer");
    const snapshots = test.emit.mock.calls.map(([event]) => event).filter(({ type }) => type === "context_usage").map(({ contextUsage }) => contextUsage);
    expect(snapshots.map(({ phase }) => phase)).toEqual(["preRequest", "terminal"]);
    expect(snapshots[0].messageCount).toEqual(1); expect(snapshots[1].messageCount).toEqual(2);
    expect(snapshots[0].categories.find(({ key }: any) => key === "runtimeAndToolLogs").tokens).toBeGreaterThan(0);
    expect(snapshots[1].categories.find(({ key }: any) => key === "conversation").tokens).toBeGreaterThan(snapshots[0].categories.find(({ key }: any) => key === "conversation").tokens);
  });
  it("forwards provider chunks and merges usage reported separately at stream start and end", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(streamResponse({ deltaText: "Calendar " }, { deltaText: "ready", usage: { input: 16, output: 8 } }, "[DONE]"));
    const test = scenario(), result = await test.run();
    expect(test.emit.mock.calls.map(([event]) => event).filter(({ type }) => type === "text_message_content").map(({ delta }) => delta).join("")).toEqual("Calendar ready");
    expect(result.reply).toEqual("Calendar ready"); expect(result.totalUsage).toEqual({ input: 16, output: 8 });
    expect(test.requests).toHaveLength(1); expect(test.requests[0].stream).toEqual(true);
    vi.mocked(fetch).mockResolvedValueOnce(streamResponse({ usage: { input: 24, output: 0 } }, { deltaText: "Complete", usage: { input: 0, output: 12 } }, "[DONE]"));
    expect((await scenario().run()).totalUsage).toEqual({ input: 24, output: 12 });
  });
  it("finishes reasoning before opening visible text for real streams and for fallback reveal", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(streamResponse({ deltaThinking: "Inspect calendar" }, { deltaThinking: " dates" }, { deltaText: "Tuesday is free" }, "[DONE]"));
    const streamed = scenario(); await streamed.run();
    expect(streamed.emit.mock.calls.map(([event]) => event.type)).toEqual(["context_usage", "step_started", "reasoning_message_start", "reasoning_message_content", "reasoning_message_content", "reasoning_message_end", "text_message_start", "text_message_content", "context_usage", "text_message_end", "step_finished"]);
    expect(streamed.emit.mock.calls.map(([event]) => event).filter(({ type }) => type === "reasoning_message_content").map(({ delta }) => delta).join("")).toEqual("Inspect calendar dates");
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ answer: "OK", reason: "Inspect calendar dates" }), { headers: { "content-type": "application/json" } }));
    const revealed = scenario(); await revealed.run();
    expect(revealed.emit.mock.calls.map(([event]) => event.type)).toEqual(["context_usage", "step_started", "reasoning_message_start", "reasoning_message_content", "reasoning_message_end", "context_usage", "text_message_start", "text_message_content", "text_message_end", "step_finished"]);
  });
});

describe("Chat retries and canonical persistence", () => {
  it("falls back exactly once for explicit unsupported streaming before any visible content", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("stream unsupported", { status: 400 })).mockResolvedValueOnce(new Response(JSON.stringify({ answer: "Calendar fallback" }), { headers: { "content-type": "application/json" } }));
    const test = scenario(); expect((await test.run()).reply).toEqual("Calendar fallback");
    expect(test.requests.map(({ stream }) => stream)).toEqual([true, false]); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("does not retry a stream that already delivered text", async () => {
    let read = false;
    const bytes = new ReadableStream<Uint8Array>({ pull(controller) {
      if (read) controller.error(Error("Calendar connection lost"));
      else { read = true; controller.enqueue(new TextEncoder().encode('data: {"deltaText":"Calendar opened"}\n\n')); }
    } });
    vi.mocked(fetch).mockResolvedValueOnce(new Response(bytes, { headers: { "content-type": "text/event-stream" } }));
    const test = scenario(); await expect(test.run()).rejects.toThrow("Calendar connection lost");
    expect(fetch).toHaveBeenCalledTimes(1); expect(test.requests).toHaveLength(1);
  });
  it.each([500, 429, 401])("does not use nonstreaming retry for HTTP %s", async (status) => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("Calendar request failed", { status }));
    const test = scenario(); await expect(test.run()).rejects.toThrow("HTTP " + status);
    expect(fetch).toHaveBeenCalledTimes(1); expect(test.requests.map(({ stream }) => stream)).toEqual([true]);
  });
  it("persists normalized visible text along with untouched thinking and raw provider content", async () => {
    const transcript = sink(), rawAssistant = [{ type: "text", text: "Calendar provider content" }];
    const reply = "[2026-10-06 09:30, Asia/Shanghai] Tuesday is free";
    await scenario({ transcriptSink: transcript, streamChat: async () => ({ ...completed(reply, "Inspect calendar dates"), assistantMessage: { role: "assistant", content: reply, thinking: "Inspect calendar dates", rawAssistant } }) }).run();
    expect(transcript.appendAssistant).toHaveBeenCalledWith({ message: expect.objectContaining({ role: "assistant", content: "Tuesday is free", thinking: "Inspect calendar dates", rawAssistant }) });
  });
  it("rejects a turn if canonical assistant persistence fails", async () => {
    await expect(scenario({ transcriptSink: sink({ appendAssistant: async () => { throw Error("Calendar disk full"); } }), streamChat: async () => completed("Calendar ready") }).run()).rejects.toThrow("Calendar disk full");
  });
});

describe("Canonical history across chat and tool-enabled rounds", () => {
  function storage() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenda-cross-loop-")); roots.push(root);
    return new ConversationTranscriptStore(root);
  }
  it("feeds a normalized chat assistant to a real tools-enabled harness round", async () => {
    const store = storage(), conversationId = "calendar-cross-chat", transcript = createTranscriptSink({ store, conversationId, runId: "calendar-chat" });
    await store.append(conversationId, { id: "calendar-user-entry", kind: "user", turnId: "calendar-user", revision: 1, at: 84, payload: { text: "Open my calendar" } });
    await scenario({ messages: [{ role: "user", content: "Open my calendar" }], transcriptSink: transcript, streamChat: async () => ({ ...completed("[2026-10-06 09:30, Asia/Shanghai] Calendar opened"), assistantMessage: { role: "assistant", content: "[2026-10-06 09:30, Asia/Shanghai] Calendar opened", thinking: "Calendar reasoning", rawAssistant: [{ type: "text", text: "Calendar provider content" }] } }) }).run();
    const canonical = materializeTranscript((await store.read(conversationId)).entries, { get: () => null });
    expect(canonical.messages).toEqual([{ role: "user", content: "Open my calendar" }, expect.objectContaining({ role: "assistant", content: "Calendar opened", thinking: "Calendar reasoning" })]);
    harnessModel.mockResolvedValueOnce(completed("Tuesday appointments found"));
    const tool: ToolDefinition = { id: "calendar_probe", name: "calendar_probe", description: "Calendar test capability", enabled: true, inputSchema: { type: "object", properties: {} }, execute: async () => "Calendar probe complete" };
    const result = await runFireflyHarness({ systemPrompt: "Calendar assistant rules", messages: [...canonical.messages, { role: "user", content: "Find Tuesday appointments" }], tools: [tool], vendorConfig: { provider: "Calendar", baseUrl: "https://calendar.invalid", model: "calendar-model", apiKey: "calendar-key" } as any, transcriptSink: createTranscriptSink({ store, conversationId, runId: "calendar-work" }) });
    expect(result.finalAnswer).toEqual("Tuesday appointments found");
    expect(harnessModel.mock.calls[0][0].request.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: "user", content: "Open my calendar" }), expect.objectContaining({ role: "assistant", content: "Calendar opened" }), expect.objectContaining({ role: "user", content: "Find Tuesday appointments" })]));
    expect((await store.read(conversationId)).entries.filter(({ kind }) => kind === "assistant")).toHaveLength(2);
  });
  it("carries complete tool results into the next tool-free chat request", async () => {
    const store = storage(), conversationId = "calendar-cross-work", transcript = createTranscriptSink({ store, conversationId, runId: "calendar-work" });
    await store.append(conversationId, { id: "calendar-user-entry", kind: "user", turnId: "calendar-user", revision: 1, at: 84, payload: { text: "Read Tuesday appointments" } });
    const assistantEntryId = await transcript.appendAssistant({ message: { role: "assistant", content: "", toolCalls: [{ id: "calendar-call", name: "calendar_read", arguments: '{"day":"Tuesday"}' }] }, roundId: "calendar-round" });
    await transcript.appendToolResult({ assistantEntryId, message: { role: "tool", toolCallId: "calendar-call", name: "calendar_read", content: "09:30 dentist" }, outcome: "success", roundId: "calendar-round" });
    const canonical = materializeTranscript((await store.read(conversationId)).entries, { get: () => null });
    expect(canonical.messages).toEqual([{ role: "user", content: "Read Tuesday appointments" }, expect.objectContaining({ role: "assistant", toolCalls: [expect.objectContaining({ id: "calendar-call", name: "calendar_read" })] }), expect.objectContaining({ role: "tool", toolCallId: "calendar-call", content: "09:30 dentist" })]);
    let received: ChatMessage[] = [];
    await scenario({ messages: [...canonical.messages, { role: "user", content: "Thanks for checking" }], streamChat: async ({ request }) => { received = request.messages; return completed(); } }).run();
    expect(received).toEqual(expect.arrayContaining([expect.objectContaining({ role: "tool", toolCallId: "calendar-call", content: "09:30 dentist" }), expect.objectContaining({ role: "user", content: "Thanks for checking" })]));
  });
});

describe("Main-authorized image fallback", () => {
  it("retries a definite image-capability refusal only through the memory port", async () => {
    const caption = vi.fn(async () => [{ role: "user" as const, content: "Authorized calendar caption" }]);
    const call = vi.fn().mockRejectedValueOnce(Error("MEMORY_CONTEXT_IMAGE_UNSUPPORTED")).mockResolvedValueOnce(completed("Captioned calendar answer"));
    const result = await scenario({ memoryRun: { call, bindSink: (value) => value, close: async () => {} }, imageCaptionFallback: caption }).run();
    expect(result.reply).toEqual("Captioned calendar answer"); expect(call).toHaveBeenCalledTimes(2); expect(caption).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(call.mock.calls[1])).toContain("Authorized calendar caption"); expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["E_MODEL_REQUEST_TIMEOUT", "MEMORY_CONTEXT_CANCELLED", "MEMORY_RUN_DENIED", "MEMORY_CONTEXT_SEND_UNKNOWN"])("never retries captioning after %s", async (code) => {
    const caption = vi.fn(async () => [{ role: "user" as const, content: "Unread calendar caption" }]), call = vi.fn(async () => { throw Error(code); });
    await expect(scenario({ memoryRun: { call, bindSink: (value) => value, close: async () => {} }, imageCaptionFallback: caption }).run()).rejects.toThrow(code);
    expect(call).toHaveBeenCalledTimes(1); expect(caption).not.toHaveBeenCalled();
  });
});
