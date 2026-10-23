import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { EventType } from "@ag-ui/core";
import { FireflyAgent, classifyRunError, toAguiEvent, type FireflyRunOptions } from "./firefly-agent";
import { AgentRuntimeError } from "./agent-runtime-error";
import { AgentExecutionError } from "./run-execution-status";
import { runChatLoop } from "./chat-loop";
import { runHarnessWithAdapter } from "./harness-adapter";
import { executeToolDefinition } from "./tools/registry/tool-executor";
import type { TranscriptSink } from "./transcript-sink";

vi.mock("./vendors", () => ({ getAdapterForConfig: () => ({ id: "calendar-adapter" }) }));
vi.mock("./tools/registry/tool-registry", () => ({ toolRegistry: { getEnabledTools: () => [], getById: vi.fn() } }));
vi.mock("../permission", () => ({ checkPermission: vi.fn() }));
vi.mock("../user-choice", () => ({ requestUserClarification: vi.fn() }));
vi.mock("./chat-loop", () => ({ runChatLoop: vi.fn() }));
vi.mock("./harness-adapter", () => ({ runHarnessWithAdapter: vi.fn() }));

const chat = vi.mocked(runChatLoop), harness = vi.mocked(runHarnessWithAdapter);
const success = { reply: "Calendar ready", toolResults: [], completionReason: "no_tool" as const };
function options(patch: Partial<FireflyRunOptions> = {}): FireflyRunOptions {
  return { settings: { provider: "Calendar", baseUrl: "", model: "calendar-model", apiKey: "", contextWindowTokens: 256_000 }, messages: [{ role: "user", content: "Read my calendar" }], timeoutMs: 60_000, toolSystemContent: "", soulSystemBaseContent: "", executionMode: "chat", tools: [], conversationId: "calendar-session", ...patch };
}
function latch<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>((settle) => { resolve = settle; }); return { promise, resolve }; }
function transcript(patch: Partial<TranscriptSink> = {}): TranscriptSink {
  return { appendSAssistant: vi.fn(async () => "calendar-s-entry"), settleSAssistant: vi.fn(async () => {}), appendAssistant: vi.fn(async () => "calendar-answer-entry"), appendToolResult: vi.fn(async () => {}), closeInterruption: vi.fn(async () => {}), checkpoint: vi.fn(async () => {}), ...patch };
}
function ownedMemory(close: () => Promise<void> = async () => {}) {
  return { call: vi.fn(), bindSink: vi.fn((sink: TranscriptSink) => sink), close: vi.fn(close) };
}
function observe(input: FireflyRunOptions, onEvent?: (event: any) => void) {
  const agent = new FireflyAgent({ threadId: "calendar-thread" });
  const events: any[] = [], errors: unknown[] = [];
  const state = { agent, events, errors, completed: false };
  const subscription = agent.runWithEvents(input).subscribe({ next(event) { events.push(event); onEvent?.(event); }, error(error) { errors.push(error); }, complete() { state.completed = true; } });
  return Object.assign(state, { subscription });
}
const terminals = (state: ReturnType<typeof observe>) => state.events.filter(({ type }) => type === EventType.RUN_FINISHED);
beforeEach(() => { chat.mockReset().mockResolvedValue(success); harness.mockReset().mockResolvedValue(success); });
afterEach(() => vi.restoreAllMocks());

describe("Public AG-UI event translation", () => {
  it("preserves reasoning lifecycle and incremental tool argument payloads", () => {
    expect(toAguiEvent({ type: "reasoning_message_start", messageId: "calendar-reason", role: "reasoning" })).toMatchObject({ type: "REASONING_MESSAGE_START", messageId: "calendar-reason", role: "reasoning" });
    expect(toAguiEvent({ type: "reasoning_message_content", messageId: "calendar-reason", delta: "Inspecting dates" })).toMatchObject({ type: "REASONING_MESSAGE_CONTENT", messageId: "calendar-reason", delta: "Inspecting dates" });
    expect(toAguiEvent({ type: "reasoning_message_end", messageId: "calendar-reason" })).toMatchObject({ type: "REASONING_MESSAGE_END", messageId: "calendar-reason" });
    expect(toAguiEvent({ type: "tool_call_args", toolCallId: "calendar-call", delta: '{"day":' })).toMatchObject({ type: "TOOL_CALL_ARGS", toolCallId: "calendar-call", delta: '{"day":' });
  });
});

describe("Safe error classification", () => {
  const classify = (error: unknown, source: Parameters<typeof classifyRunError>[1] = undefined, phase: Parameters<typeof classifyRunError>[4] = "soul", hasTools = true) => classifyRunError(error, source, "calendar-run", "calendar-session", phase, hasTools);
  it("retains cancellation source and phase-aware timeout messages with complete diagnostics", () => {
    const aborted = new DOMException("Calendar operation aborted", "AbortError");
    expect(classify(aborted, "user_cancelled")).toMatchObject({ source: "user_cancelled", userMessage: "" });
    const timed = classify(aborted, "call_timeout");
    expect(timed.source).toEqual("call_timeout"); expect(timed.userMessage).toContain("工具结果已获得"); expect(timed.userMessage).toContain("超时");
    expect(timed.diagnostics).toMatchObject({ runId: "calendar-run", conversationId: "calendar-session", phase: "soul", hasToolResults: true });
    const early = classify(aborted, "call_timeout", "decide", false);
    expect(early.source).toEqual("call_timeout"); expect(early.userMessage).toEqual("请求处理超时，请重试。"); expect(early.userMessage).not.toContain("工具结果");
    expect(classify(Error("E_AGENT_GRAPH_TIMEOUT"), undefined, "execute", false)).toMatchObject({ source: "run_timeout", userMessage: "请求处理超时，请重试。" });
    const late = classify(Error("E_AGENT_GRAPH_TIMEOUT"));
    expect(late.source).toEqual("run_timeout"); expect(late.userMessage).toContain("工具结果已获得");
    expect(classify(aborted, undefined, "unknown", false)).toMatchObject({ source: "unknown_abort", userMessage: "操作已中断，请重试。" });
    const cleanup = classify(aborted, "upstream_cleanup");
    for (const privateText of ["aborted", "AbortError", "operation"]) expect(cleanup.userMessage).not.toContain(privateText);
    expect(classify(aborted, "call_timeout").source).toEqual("call_timeout");
  });
  it("uses a fixed unknown-error message and retains private details only in diagnostics", () => {
    const classified = classify(Error('Calendar request HTTP 529 - {"message":"overloaded","request_id":"calendar-private"} Authorization: Bearer secret'), undefined, "decide", false);
    expect(classified.source).toEqual("upstream_cleanup"); expect(classified.userMessage).toEqual("请求处理失败，请重试。");
    for (const fragment of ["HTTP", "overloaded", "request_id", "Authorization", "Bearer"]) expect(classified.userMessage).not.toContain(fragment);
    expect(classified.diagnostics.errorMessage).toContain("HTTP 529");
  });
  it.each([
    ["E_AGENT_NO_PROGRESS", "请求处理遇到问题，请重试。"],
    ["E_AGENT_GRAPH_ITERATION_LIMIT", "请求处理步骤过多，请简化问题后重试。"],
  ] as const)("maps structured code %s to its exact public message", (code, userMessage) => {
    const classified = classify(new AgentRuntimeError(code, "Calendar internal diagnostic"));
    expect(classified.userMessage).toEqual(userMessage); expect(classified.diagnostics.errorCode).toEqual(code);
  });
  it("extracts status codes from structured failures, including through an execution cause", () => {
    for (const status of [529, 429]) {
      const classified = classify(new AgentRuntimeError("E_MODEL_REQUEST_FAILED", "Calendar request HTTP " + status + " - overloaded"));
      expect(classified.userMessage).toEqual("模型服务暂时不可用，请稍后重试。");
      for (const fragment of [String(status), "HTTP", "overloaded"]) expect(classified.userMessage).not.toContain(fragment);
      expect(classified.diagnostics.httpStatus).toEqual(status); expect(classified.diagnostics.errorCode).toEqual("E_MODEL_REQUEST_FAILED");
    }
    const withoutStatus = classify(new AgentRuntimeError("E_MODEL_REQUEST_FAILED", "Calendar connection refused"));
    expect(withoutStatus.userMessage).toEqual("模型服务暂时不可用，请稍后重试。"); expect(withoutStatus.diagnostics.httpStatus).toBeUndefined(); expect(withoutStatus.diagnostics.errorCode).toEqual("E_MODEL_REQUEST_FAILED");
    const wrapped = new AgentExecutionError("Calendar execution failed", { phase: "soul", successfulTools: [], createdArtifacts: [], taskCompletionConfirmed: false }, { cause: new AgentRuntimeError("E_MODEL_REQUEST_FAILED", "Calendar HTTP 500 - internal") });
    const classified = classify(wrapped, undefined, "soul", false);
    expect(classified.userMessage).toEqual("模型服务暂时不可用，请稍后重试。"); expect(classified.diagnostics.httpStatus).toEqual(500); expect(classified.diagnostics.errorCode).toEqual("E_MODEL_REQUEST_FAILED");
  });
});

describe("Registered tool result compatibility", () => {
  it.each([
    [JSON.stringify({ error: "Calendar unavailable", success: false }), "failed", "E_TOOL_BUSINESS_FAILED"],
    [JSON.stringify({ path: "/calendar.ts", content: "export const day = 2;", truncated: false }), "succeeded", undefined],
    ["Calendar operation complete", "succeeded", undefined],
    [JSON.stringify({ error: "Calendar unavailable" }), "succeeded", undefined],
  ] as const)("observes the real execution boundary for output %s", async (output, status, code) => {
    const result = await executeToolDefinition({ id: "calendar-probe", name: "Calendar probe", description: "Calendar test operation", enabled: true, inputSchema: { type: "object", properties: {} }, execute: async () => output }, {});
    expect(result.status).toEqual(status); if (code) expect(result.errorCode).toEqual(code);
  });
});

describe("Loop routing, cancellation and transcript ordering", () => {
  it("routes tool-free chat to ChatLoop and enhanced chat to the harness", async () => {
    const plain = observe(options()); await vi.waitFor(() => expect(plain.completed).toEqual(true));
    expect(chat).toHaveBeenCalledOnce(); expect(harness).not.toHaveBeenCalled(); expect(terminals(plain)).toHaveLength(1);
    chat.mockClear();
    const enhanced = observe(options({ tools: [{ id: "calendar_read", name: "Calendar read", description: "Read appointments", enabled: true, inputSchema: { type: "object", properties: {} }, execute: async () => "Calendar probe complete" }] }));
    await vi.waitFor(() => expect(enhanced.completed).toEqual(true));
    expect(harness).toHaveBeenCalledOnce(); expect(chat).not.toHaveBeenCalled(); expect(terminals(enhanced)).toHaveLength(1);
  });
  it("links external cancellation and emits exactly one cancelled terminal without a synthetic reply", async () => {
    harness.mockImplementationOnce(async (_options, signal) => {
      if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      return { ...success, reply: "", terminal: { status: "cancelled", reason: "user_cancelled", externalEffectsMayContinue: true } };
    });
    const caller = new AbortController(), state = observe(options({ executionMode: "work", signal: caller.signal }));
    await vi.waitFor(() => expect(harness).toHaveBeenCalledOnce());
    const linked = harness.mock.calls[0][1]; expect(linked).toBeDefined(); expect(linked.aborted).toEqual(false);
    caller.abort(); expect(linked.aborted).toEqual(true);
    await vi.waitFor(() => expect(state.completed).toEqual(true));
    expect(terminals(state)).toHaveLength(1); expect(state.events.filter(({ type }) => type === EventType.RUN_ERROR)).toHaveLength(0);
    expect(terminals(state)[0].result).toMatchObject({ status: "cancelled", externalEffectsMayContinue: true });
    expect(state.agent.lastResult?.reply).not.toContain("最终回复被取消");
    expect(state.agent.lastResult?.terminal).toMatchObject({ status: "cancelled", externalEffectsMayContinue: true });
    state.subscription.unsubscribe();
  });
  it("detaches the caller listener after a normal completion without aborting the harness signal", async () => {
    const caller = new AbortController(), add = vi.spyOn(caller.signal, "addEventListener"), remove = vi.spyOn(caller.signal, "removeEventListener");
    const state = observe(options({ executionMode: "work", signal: caller.signal }));
    await vi.waitFor(() => expect(state.completed).toEqual(true));
    expect(add).toHaveBeenCalledWith("abort", expect.any(Function), { once: true }); expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(harness.mock.calls[0][1].aborted).toEqual(false);
  });
  it.each(["plain-chat", "enhanced-chat", "work", "code"])("passes memory and the guarded transcript sink into %s", async (mode) => {
    const original = transcript(), guarded = transcript(), memory = ownedMemory(); memory.bindSink.mockReturnValue(guarded);
    const state = observe(options({ transcriptSink: original, memoryRun: memory, executionMode: mode.includes("chat") ? "chat" : "work", conversationMode: mode === "code" ? "code" : mode === "work" ? "work" : "chat", tools: mode === "enhanced-chat" ? [{ id: "calendar_read", name: "Calendar", description: "Read appointments", enabled: true, inputSchema: { type: "object", properties: {} }, execute: async () => "Calendar probe complete" }] : [] }));
    await vi.waitFor(() => expect(state.completed).toEqual(true));
    expect(memory.bindSink).toHaveBeenCalledWith(original);
    if (mode === "plain-chat") expect(chat).toHaveBeenCalledWith(expect.objectContaining({ memoryRun: memory, transcriptSink: guarded }));
    else expect(harness).toHaveBeenCalledWith(expect.objectContaining({ memoryRun: memory, transcriptSink: guarded }), expect.any(AbortSignal), expect.any(Function));
  });
  it("passes an unguarded transcript sink into plain chat", async () => {
    const original = transcript(), state = observe(options({ transcriptSink: original }));
    await vi.waitFor(() => expect(state.completed).toEqual(true));
    expect(chat).toHaveBeenCalledOnce(); expect(chat).toHaveBeenCalledWith(expect.objectContaining({ transcriptSink: original })); expect(terminals(state)).toHaveLength(1);
  });
  it.each([false, true])("closes cancellation before the terminal and reports closure failure=%s", async (fails) => {
    const caller = new AbortController(), order: string[] = [];
    const closeInterruption = vi.fn(async () => { order.push("closed"); if (fails) throw Error("Calendar closure disk full"); });
    chat.mockImplementationOnce(async () => { if (!caller.signal.aborted) await new Promise<void>((resolve) => caller.signal.addEventListener("abort", () => resolve(), { once: true })); throw new DOMException("Calendar cancelled", "AbortError"); });
    const state = observe(options({ signal: caller.signal, transcriptSink: transcript({ closeInterruption }) }), (event) => { if (event.type === EventType.RUN_FINISHED) order.push("terminal"); });
    await vi.waitFor(() => expect(chat).toHaveBeenCalledOnce()); caller.abort();
    await vi.waitFor(() => expect(state.completed).toEqual(true));
    expect(closeInterruption).toHaveBeenCalledWith({ reason: "user_cancel", runSession: null });
    expect(terminals(state)[0].result).toMatchObject(fails ? { status: "runtime_error", reason: "transcript_interruption_closure_failed" } : { status: "cancelled" });
    expect(order).toEqual(["closed", "terminal"]);
  });
});

describe("Main memory factory ownership", () => {
  it.each(["work", "chat"] as const)("opens %s memory with canonical identity, sink and linked signal and drains before terminal", async (executionMode) => {
    const opening = latch<ReturnType<typeof ownedMemory>>(), draining = latch(), memory = ownedMemory(() => draining.promise), caller = new AbortController();
    const originalSink = transcript(), guarded = transcript(); memory.bindSink.mockReturnValue(guarded);
    const factory = vi.fn((_input: FireflyRunOptions) => opening.promise);
    const original = options({ executionMode, signal: caller.signal, transcriptSink: originalSink, openMemoryRun: factory }), state = observe(original);
    await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce());
    const opened = factory.mock.calls[0][0];
    expect(opened.runId).toBeTruthy(); expect(opened.conversationId).toEqual("calendar-session"); expect(opened.transcriptSink).toBe(originalSink);
    expect(opened.signal).toBeInstanceOf(AbortSignal); expect(opened.signal).not.toBe(caller.signal); expect(opened.signal?.aborted).toEqual(false);
    expect(chat).not.toHaveBeenCalled(); expect(harness).not.toHaveBeenCalled(); expect(original.runId).toBeUndefined(); expect(original.memoryRun).toBeUndefined();
    opening.resolve(memory); await vi.waitFor(() => expect(memory.close).toHaveBeenCalledOnce());
    const loop = executionMode === "chat" ? chat.mock.calls[0][0] : harness.mock.calls[0][0];
    expect(loop).toMatchObject({ memoryRun: memory, transcriptSink: guarded });
    expect(executionMode === "chat" ? loop.signal : harness.mock.calls[0][1]).toBe(opened.signal);
    expect(terminals(state)).toEqual([]); expect(state.completed).toEqual(false);
    caller.abort(); expect(opened.signal?.aborted).toEqual(true);
    draining.resolve(); await vi.waitFor(() => expect(state.completed).toEqual(true));
    expect(terminals(state)).toHaveLength(1); expect(terminals(state)[0].runId).toBe(opened.runId); expect(state.errors).toEqual([]); expect(memory.close).toHaveBeenCalledOnce();
  });
  it.each(["reject", "missing"] as const)("fails closed when memory opening is %s", async (kind) => {
    const state = observe(options({ openMemoryRun: async () => { if (kind === "reject") throw Error("MEMORY_RUN_DENIED"); return undefined as never; } }));
    await vi.waitFor(() => expect(state.errors).toHaveLength(1));
    expect(chat).not.toHaveBeenCalled(); expect(harness).not.toHaveBeenCalled(); expect(terminals(state)).toEqual([]); expect(state.completed).toEqual(false);
  });
  it("drains before reporting a loop failure and refuses success after a close failure", async () => {
    const draining = latch(), memory = ownedMemory(() => draining.promise);
    chat.mockRejectedValueOnce(Error("MEMORY_CONTEXT_SEND_UNKNOWN"));
    const state = observe(options({ openMemoryRun: async () => memory }));
    await vi.waitFor(() => expect(memory.close).toHaveBeenCalledOnce());
    expect(state.errors).toEqual([]); expect(terminals(state)).toEqual([]); expect(state.completed).toEqual(false);
    draining.resolve(); await vi.waitFor(() => expect(state.errors).toHaveLength(1));
    expect(terminals(state)).toEqual([]); expect(memory.close).toHaveBeenCalledOnce();
    const failed = ownedMemory(async () => { throw Error("MEMORY_CONTEXT_CLOSE_FAILED"); }), closure = observe(options({ openMemoryRun: async () => failed }));
    await vi.waitFor(() => expect(closure.errors).toHaveLength(1));
    expect(failed.close).toHaveBeenCalledOnce(); expect(terminals(closure)).toEqual([]); expect(closure.completed).toEqual(false);
  });
  it("closes memory opened during cancellation without entering a model loop", async () => {
    const opening = latch<ReturnType<typeof ownedMemory>>(), memory = ownedMemory(), caller = new AbortController(), factory = vi.fn(() => opening.promise);
    const state = observe(options({ signal: caller.signal, openMemoryRun: factory }));
    await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce()); caller.abort(); opening.resolve(memory);
    await vi.waitFor(() => expect(state.completed).toEqual(true));
    expect(chat).not.toHaveBeenCalled(); expect(memory.close).toHaveBeenCalledOnce(); expect(terminals(state)[0]?.result).toMatchObject({ status: "cancelled" });
  });
  it("waits for provider settlement and memory drain before acknowledging cancellation", async () => {
    const provider = latch(), draining = latch(), memory = ownedMemory(() => draining.promise), caller = new AbortController();
    chat.mockImplementationOnce(async () => { await provider.promise; throw new DOMException("Calendar provider cancelled", "AbortError"); });
    const state = observe(options({ signal: caller.signal, openMemoryRun: async () => memory }));
    await vi.waitFor(() => expect(chat).toHaveBeenCalledOnce()); caller.abort(); await Promise.resolve();
    expect(memory.close).not.toHaveBeenCalled(); expect(terminals(state)).toEqual([]);
    provider.resolve(); await vi.waitFor(() => expect(memory.close).toHaveBeenCalledOnce());
    expect(terminals(state)).toEqual([]); expect(state.completed).toEqual(false);
    draining.resolve(); await vi.waitFor(() => expect(state.completed).toEqual(true));
    expect(terminals(state)[0]?.result).toMatchObject({ status: "cancelled" });
  });
  it("closes an owned run after unsubscribe without publishing a terminal or completing the subscriber", async () => {
    const provider = latch<typeof success>(), memory = ownedMemory();
    chat.mockImplementationOnce(() => provider.promise);
    const state = observe(options({ openMemoryRun: async () => memory }));
    await vi.waitFor(() => expect(chat).toHaveBeenCalledOnce()); state.subscription.unsubscribe();
    expect(chat.mock.calls[0][0].signal?.aborted).toEqual(true); expect(memory.close).not.toHaveBeenCalled();
    provider.resolve(success); await vi.waitFor(() => expect(memory.close).toHaveBeenCalledOnce());
    expect(terminals(state)).toEqual([]); expect(state.completed).toEqual(false); expect(state.errors).toEqual([]);
  });
  it("leaves caller-provided memory ownership with the caller", async () => {
    const supplied = ownedMemory(), factory = vi.fn(async () => ownedMemory()), state = observe(options({ memoryRun: supplied, openMemoryRun: factory }));
    await vi.waitFor(() => expect(state.completed).toEqual(true));
    expect(factory).not.toHaveBeenCalled(); expect(supplied.close).not.toHaveBeenCalled(); expect(chat.mock.calls[0][0].memoryRun).toBe(supplied);
  });
});
