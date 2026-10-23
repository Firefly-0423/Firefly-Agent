import OpenAI from "openai";
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnthropicAdapter } from "./anthropic-adapter";
import { OpenAICompatAdapter } from "./openai-adapter";
import { ResponsesAdapter } from "./responses-adapter";
import { setVendorRuntimeSettingsGetter } from "./runtime-settings";
import * as promptDump from "./prompt-dump";
import type { ChatRequest, ProviderCapability, Transport, VendorConfig } from "./types";
import { dispatchPreparedModelCall, prepareModelCall } from "./prepared-model-call";

const transports: Transport[] = ["openai", "responses", "anthropic"];
function fixture(transport: Transport) {
  const capability: ProviderCapability = {
    id: transport === "anthropic" ? "claude" : "chatgpt", displayName: "Synthetic",
    transport, baseUrl: "https://synthetic.invalid/v1", authStyle: transport === "anthropic" ? "x-api-key" : "bearer",
    defaultModel: "synthetic-model", supportsTools: true, supportsThinking: true,
    thinkingField: transport === "anthropic" ? "thinking" : "reasoning_content",
    cacheStrategy: "none", testStrategy: "text+tool",
  };
  const config: VendorConfig = { provider: "Synthetic", baseUrl: capability.baseUrl,
    model: "synthetic-model", apiKey: "synthetic-secret-do-not-log", explicitTransport: transport };
  const adapter = transport === "openai" ? new OpenAICompatAdapter(capability.id, capability)
    : transport === "responses" ? new ResponsesAdapter(capability.id, capability)
      : new AnthropicAdapter(capability.id, capability);
  const request: ChatRequest = { model: config.model, ...(transport === "anthropic" ? { maxTokens: 32768 } : {}), messages: [
    { role: "system", content: "用中文回答" },
    { role: "user", content: [{ type: "text", text: "查看这张图片 🪷" },
      { type: "image_url", image_url: { url: "data:image/png;base64,c3ludGhldGlj" } }] },
  ], tools: [{ name: "lookup", description: "检索资料".repeat(100), parameters: { type: "object", properties: { query: { type: "string" } } } }] };
  const identity = { providerId: capability.id, model: config.model, transport, framingVersion: "synthetic-v1" };
  return { adapter, request, config, identity };
}
function sse(transport: Transport): Response {
  const events = transport === "openai" ? [
    { choices: [{ delta: { reasoning_content: "思考" }, finish_reason: null }] },
    { choices: [{ delta: { content: "完成" }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 3 } },
  ] : transport === "responses" ? [
    { type: "response.output_text.delta", delta: "完成" },
    { type: "response.completed", response: { status: "completed", output: [
      { type: "reasoning", id: "r1", encrypted_content: "synthetic-envelope" },
      { type: "message", id: "m1", role: "assistant", content: [{ type: "output_text", text: "完成" }] },
    ], usage: { input_tokens: 12, output_tokens: 3 } } },
  ] : [
    { type: "message_start", message: { id: "m1", type: "message", role: "assistant", content: [], model: "synthetic-model", stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "完成" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } },
    { type: "message_stop" },
  ];
  return new Response(events.map(event => `${transport === "anthropic" ? `event: ${(event as {type: string}).type}\n` : ""}data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "Content-Type": "text/event-stream" } });
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); setVendorRuntimeSettingsGetter(() => ({})); });

describe("prepared provider calls", () => {
  it.each(transports)("sends the identical counted body through the real %s SDK serializer", async transport => {
    const f = fixture(transport);
    let outgoing: Request | undefined;
    let body: string | undefined;
    const order: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      outgoing = new Request(input, init); body = await outgoing.text(); order.push("fetch"); return sse(transport);
    }));
    const prepared = prepareModelCall(f.adapter, f.request, f.config, f.identity);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.request.body)).toBe(true);
    expect(JSON.stringify(prepared.request.body)).toBe(prepared.serializedBody);
    expect(prepared.request.inputTypes).toEqual(["text", "function-tools", "image"]);
    expect(JSON.stringify(prepared)).not.toContain(f.config.apiKey);
    f.request.messages[0].content = "mutation must not reach wire";
    const response = await dispatchPreparedModelCall({ prepared, config: f.config, timeoutMs: 1_000,
      onModelExecution: phase => { order.push(phase); },
      onDelta: delta => { if (delta.type === "text_delta") order.push("delta"); },
    });
    expect(body).toBe(prepared.serializedBody);
    expect(outgoing?.url).toBe(prepared.endpoint);
    expect(response.text).toBe("完成");
    expect(response.usage).toMatchObject({ input: 12, output: 3 });
    expect(order[0]).toBe("start"); expect(order[1]).toBe("fetch"); expect(order.at(-1)).toBe("end");
    expect(order).toContain("delta");
    if (transport === "responses") expect(response.assistantMessage.rawAssistant).toContainEqual(expect.objectContaining({ type: "reasoning" }));
    if (transport === "anthropic") expect(response.assistantMessage.rawAssistant).toEqual([{ type: "text", text: "完成" }]);
  });

  it.each(["apiKey", "baseUrl", "model"] as const)("fails closed when %s changes after preparation", async key => {
    const f = fixture("openai"), fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const prepared = prepareModelCall(f.adapter, f.request, f.config, f.identity);
    f.config[key] += "-changed";
    await expect(dispatchPreparedModelCall({ prepared, config: f.config, timeoutMs: 1000 })).rejects.toThrow("MEMORY_CONTEXT_REQUEST_CHANGED");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects forged prepared objects and runtime-settings drift without dispatch", async () => {
    const f = fixture("openai"), fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const prepared = prepareModelCall(f.adapter, f.request, f.config, f.identity);
    await expect(dispatchPreparedModelCall({ prepared: { ...prepared }, config: f.config, timeoutMs: 1000 })).rejects.toThrow("MEMORY_CONTEXT_REQUEST_CHANGED");
    setVendorRuntimeSettingsGetter(() => ({ disableMaxToken: true }));
    await expect(dispatchPreparedModelCall({ prepared, config: f.config, timeoutMs: 1000 })).rejects.toThrow("MEMORY_CONTEXT_REQUEST_CHANGED");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("cancels before dispatch with zero fetches and no execution span", async () => {
    const f = fixture("openai"), fetch = vi.fn(), observer = vi.fn(); vi.stubGlobal("fetch", fetch);
    const prepared = prepareModelCall(f.adapter, f.request, f.config, f.identity);
    const controller = new AbortController(); controller.abort(new Error("cancelled by owner"));
    await expect(dispatchPreparedModelCall({ prepared, config: f.config, timeoutMs: 1000, signal: controller.signal, onModelExecution: observer })).rejects.toThrow("cancelled by owner");
    expect(fetch).not.toHaveBeenCalled(); expect(observer).not.toHaveBeenCalled();
  });

  it.each(transports)("preserves %s output limits without changing configuration", transport => {
    const f = fixture(transport), before = JSON.stringify(f.config);
    const prepared = prepareModelCall(f.adapter, f.request, f.config, f.identity);
    expect(prepared.request.maxOutputTokens).toBe(transport === "anthropic" ? 32768 : undefined);
    f.request.maxTokens = 600;
    const capped = prepareModelCall(f.adapter, f.request, f.config, f.identity);
    expect(capped.request.maxOutputTokens).toBe(600);
    expect(JSON.stringify(f.config)).toBe(before);
  });
});


describe("prepared dispatch boundary", () => {
  it("rejects source configuration mutation even when handed an old detached copy", async () => {
    const f = fixture("openai"), fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const previous = { ...f.config };
    const prepared = prepareModelCall(f.adapter, f.request, f.config, f.identity);
    f.config.apiKey = "changed-synthetic-key";
    await expect(dispatchPreparedModelCall({ prepared, config: previous, timeoutMs: 1000 })).rejects.toThrow("MEMORY_CONTEXT_REQUEST_CHANGED");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(transports)("sends %s nonstream bodies unchanged and parses tools/reasoning", async transport => {
    const f = fixture(transport); f.request.stream = false;
    const raw = transport === "openai" ? { choices: [{ message: { content: "完成", reasoning_content: "思考", tool_calls: [
      { id: "call-1", type: "function", function: { name: "lookup", arguments: '{"query":"中文"}' } },
    ] }, finish_reason: "tool_calls" }] }
      : transport === "responses" ? { status: "completed", output: [
        { type: "reasoning", id: "r1", summary: [{ type: "summary_text", text: "思考" }] },
        { type: "message", id: "m1", role: "assistant", content: [{ type: "output_text", text: "完成" }] },
        { type: "function_call", id: "fc1", call_id: "call-1", name: "lookup", arguments: '{"query":"中文"}' },
      ] } : { stop_reason: "tool_use", content: [
        { type: "thinking", thinking: "思考", signature: "synthetic-signature" },
        { type: "text", text: "完成" },
        { type: "tool_use", id: "call-1", name: "lookup", input: { query: "中文" } },
      ] };
    let body: string | undefined;
    const fetch = vi.fn(async (source: RequestInfo | URL, init?: RequestInit) => {
      const outgoing = new Request(source, init); body = await outgoing.text();
      expect(outgoing.headers.get(transport === "anthropic" ? "x-api-key" : "authorization")).toBe(
        transport === "anthropic" ? f.config.apiKey : `Bearer ${f.config.apiKey}`);
      return Response.json(raw);
    }); vi.stubGlobal("fetch", fetch);
    const observer = vi.fn();
    const prepared = prepareModelCall(f.adapter, f.request, f.config, f.identity);
    expect(prepared.request.body.stream).toBe(false);
    const response = await dispatchPreparedModelCall({ prepared, config: f.config, timeoutMs: 1000, onModelExecution: observer });
    expect(body).toBe(prepared.serializedBody);
    expect(response).toMatchObject({ text: "完成", thinking: "思考", toolCalls: [
      { id: "call-1", name: "lookup", arguments: '{"query":"中文"}' },
    ] });
    expect(observer.mock.calls).toEqual([["start", undefined], ["end", "completed"]]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("checks the live Main profile revision again at actual SDK dispatch", async () => {
    const f = fixture("openai"), fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    let revision = 1;
    const prepared = prepareModelCall(f.adapter, f.request, f.config, f.identity, {
      validateCurrent: () => { if (revision !== 1) throw new Error("MEMORY_PROFILE_STALE"); },
    });
    const pending = dispatchPreparedModelCall({ prepared, config: f.config, timeoutMs: 1000 });
    revision = 2;
    await expect(pending).rejects.toThrow("MEMORY_PROFILE_STALE");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["body", "endpoint"])("rejects SDK %s drift before fetching", async drift => {
    const f = fixture("openai"), fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const prepared = prepareModelCall(f.adapter, f.request, f.config, f.identity);
    if (drift === "body") vi.spyOn(OpenAI.prototype as any, "buildBody").mockReturnValue({
      bodyHeaders: { "content-type": "application/json" }, body: '{"model":"tampered"}', isStreamingBody: false,
    });
    else vi.spyOn(OpenAI.prototype as any, "buildURL").mockReturnValue("https://wrong.invalid/chat/completions");
    await expect(dispatchPreparedModelCall({ prepared, config: f.config, timeoutMs: 1000 })).rejects.toThrow("MEMORY_CONTEXT_REQUEST_CHANGED");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not let an execution observer throw or reuse a consumed request", async () => {
    const f = fixture("openai"), fetch = vi.fn(async () => sse("openai")); vi.stubGlobal("fetch", fetch);
    const prepared = prepareModelCall(f.adapter, f.request, f.config, f.identity);
    const observer = vi.fn(() => { throw new Error("telemetry failed"); });
    await expect(dispatchPreparedModelCall({ prepared, config: f.config, timeoutMs: 1000, onModelExecution: observer })).resolves.toMatchObject({ text: "完成" });
    await expect(dispatchPreparedModelCall({ prepared, config: f.config, timeoutMs: 1000 })).rejects.toThrow("MEMORY_CONTEXT_REQUEST_CHANGED");
    expect(fetch).toHaveBeenCalledTimes(1); expect(observer).toHaveBeenCalledTimes(2);
  });

  it("pins nonstandard Anthropic endpoints before wire verification", async () => {
    const f = fixture("anthropic"); f.config.baseUrl = "https://synthetic.invalid/custom/anthropic/messages";
    let endpoint: string | undefined;
    vi.stubGlobal("fetch", vi.fn(async (source: RequestInfo | URL, init?: RequestInit) => {
      endpoint = new Request(source, init).url; return sse("anthropic");
    }));
    const prepared = prepareModelCall(f.adapter, f.request, f.config, f.identity);
    await expect(dispatchPreparedModelCall({ prepared, config: f.config, timeoutMs: 1000 })).resolves.toMatchObject({ text: "完成" });
    expect(endpoint).toBe(prepared.endpoint);
  });

  it.each([true, false])("waits for actual fetch settlement on cancellation (stream=%s)", async stream => {
    const f = fixture("openai"); f.request.stream = stream;
    let settle!: () => void;
    let entered!: () => void;
    const dispatched = new Promise<void>(resolve => { entered = resolve; });
    vi.stubGlobal("fetch", vi.fn(() => { entered(); return new Promise<Response>(resolve => { settle = () => resolve(stream ? sse("openai") : Response.json({ choices: [] })); }); }));
    const observer = vi.fn(), controller = new AbortController();
    const prepared = prepareModelCall(f.adapter, f.request, f.config, f.identity);
    const pending = dispatchPreparedModelCall({ prepared, config: f.config, timeoutMs: 1000, signal: controller.signal, onModelExecution: observer });
    const result = pending.catch(error => error);
    await dispatched; controller.abort(new Error("owner cancelled"));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(observer.mock.calls).toEqual([["start", undefined]]);
    settle();
    expect(await result).toMatchObject({ message: "owner cancelled" });
    expect(observer.mock.calls.at(-1)).toEqual(["end", "cancelled"]);
  });

  it.each([true, false])("preserves runtime timeout errors (stream=%s)", async stream => {
    const f = fixture("openai"); f.request.stream = stream;
    vi.stubGlobal("fetch", vi.fn((source: RequestInfo | URL, init?: RequestInit) => {
      const outgoing = new Request(source, init);
      return new Promise<Response>((_resolve, reject) => outgoing.signal.addEventListener("abort", () => reject(outgoing.signal.reason), { once: true }));
    }));
    const observer = vi.fn();
    const prepared = prepareModelCall(f.adapter, f.request, f.config, f.identity);
    await expect(dispatchPreparedModelCall({ prepared, config: f.config, timeoutMs: 15, onModelExecution: observer })).rejects.toMatchObject({ code: "E_MODEL_REQUEST_TIMEOUT" });
    expect(observer.mock.calls).toEqual([["start", undefined], ["end", "failed"]]);
  });

  it.each([401, 429, 500])("retains HTTP %s cause and does not retry", async status => {
    const f = fixture("openai"), fetch = vi.fn(async () => Response.json({ error: { message: "synthetic failure" } }, { status }));
    vi.stubGlobal("fetch", fetch);
    const observer = vi.fn();
    const prepared = prepareModelCall(f.adapter, f.request, f.config, f.identity);
    await expect(dispatchPreparedModelCall({ prepared, config: f.config, timeoutMs: 1000, onModelExecution: observer })).rejects.toMatchObject({ code: "E_MODEL_REQUEST_FAILED", cause: { status } });
    expect(fetch).toHaveBeenCalledTimes(1); expect(observer.mock.calls.at(-1)).toEqual(["end", "failed"]);
  });

  it("rejects unsupported content classes and accessors without invoking them", () => {
    const f = fixture("anthropic"), getter = vi.fn(() => "unsafe");
    f.request.messages.push({ role: "assistant", rawAssistant: [{ type: "document", source: { type: "url", url: "https://synthetic.invalid/doc" } }] });
    expect(() => prepareModelCall(f.adapter, f.request, f.config, f.identity)).toThrow("MEMORY_CONTEXT_COUNTER_UNSUPPORTED");
    Object.defineProperty(f.request, "model", { get: getter });
    expect(() => prepareModelCall(f.adapter, f.request, f.config, f.identity)).toThrow("MEMORY_CONTEXT_COUNTER_UNSUPPORTED");
    expect(getter).not.toHaveBeenCalled();
  });
});


describe("prepared late settlements", () => {
  it.each([true, false])("reports timeout after a transport ignoring abort eventually settles (stream=%s)", async stream => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = fixture("openai"); f.request.stream = stream;
    let settle!: () => void;
    let entered!: () => void;
    const dispatched = new Promise<void>(resolve => { entered = resolve; });
    vi.stubGlobal("fetch", vi.fn(() => { entered(); return new Promise<Response>(resolve => { settle = () => resolve(stream ? sse("openai") : Response.json({ choices: [] })); }); }));
    const observer = vi.fn(), delta = vi.fn();
    const prepared = prepareModelCall(f.adapter, f.request, f.config, f.identity);
    const pending = dispatchPreparedModelCall({ prepared, config: f.config, timeoutMs: 10, onModelExecution: observer, onDelta: delta }).catch(error => error);
    await dispatched;
    await vi.advanceTimersByTimeAsync(10);
    expect(observer.mock.calls).toEqual([["start", undefined]]);
    settle();
    expect(await pending).toMatchObject({ code: "E_MODEL_REQUEST_TIMEOUT" });
    expect(delta).not.toHaveBeenCalled();
    expect(observer.mock.calls.at(-1)).toEqual(["end", "failed"]);
  });

  it("refuses a mutation made by the execution observer before calling fetch", async () => {
    const f = fixture("openai"), fetch = vi.fn(async () => sse("openai")); vi.stubGlobal("fetch", fetch);
    const prepared = prepareModelCall(f.adapter, f.request, f.config, f.identity);
    await expect(dispatchPreparedModelCall({ prepared, config: f.config, timeoutMs: 1000,
      onModelExecution: phase => { if (phase === "start") f.config.apiKey = "changed-in-observer"; },
    })).rejects.toThrow("MEMORY_CONTEXT_REQUEST_CHANGED");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("prepared tool and reasoning fidelity", () => {
  it.each(transports)("parses streamed %s tool arguments through the existing normalizer", async transport => {
    const f = fixture(transport);
    const argumentsJson = '{"query":"中文"}';
    const tool = { type: "function_call", id: "fc1", call_id: "call-1", name: "lookup", arguments: argumentsJson };
    const events = transport === "openai" ? [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "lookup", arguments: '{"query":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"中文"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ] : transport === "responses" ? [
      { type: "response.output_item.added", output_index: 0, item: { ...tool, arguments: "" } },
      { type: "response.function_call_arguments.delta", output_index: 0, delta: argumentsJson },
      { type: "response.function_call_arguments.done", output_index: 0, arguments: argumentsJson },
      { type: "response.completed", response: { status: "completed", output: [tool] } },
    ] : [
      { type: "message_start", message: { id: "m1", type: "message", role: "assistant", content: [], model: "synthetic-model", stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call-1", name: "lookup", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: argumentsJson } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 3 } },
      { type: "message_stop" },
    ];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(events.map(event =>
      `${transport === "anthropic" ? `event: ${(event as {type: string}).type}\n` : ""}data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "Content-Type": "text/event-stream" } })));
    const prepared = prepareModelCall(f.adapter, f.request, f.config, f.identity), onDelta = vi.fn();
    const response = await dispatchPreparedModelCall({ prepared, config: f.config, timeoutMs: 1000, onDelta });
    expect(response.toolCalls).toEqual([{ id: "call-1", name: "lookup", arguments: argumentsJson }]);
    expect(onDelta.mock.calls).toContainEqual([expect.objectContaining({ type: "tool_call_start", id: "call-1" })]);
    expect(onDelta.mock.calls).toContainEqual([expect.objectContaining({ type: "tool_call_end" })]);
    if (transport !== "openai") expect(response.assistantMessage.rawAssistant).toBeDefined();
  });

  it.each(["responses", "anthropic"] as const)("preserves %s rawAssistant envelopes in the frozen request without rebuilding", async transport => {
    const f = fixture(transport), build = vi.spyOn(f.adapter, "buildRequest");
    if (transport === "responses") {
      f.config.baseUrl = "https://api.openai.com/v1";
      f.adapter.capability.responsesEncryptedReasoning = true;
    }
    const raw = transport === "responses" ? [
      { type: "reasoning", id: "r1", summary: [{ type: "summary_text", text: "需要检索" }], encrypted_content: "synthetic-envelope" },
      { type: "function_call", id: "fc1", call_id: "call-1", name: "lookup", arguments: '{"query":"中文"}' },
    ] : [
      { type: "thinking", thinking: "需要检索", signature: "synthetic-envelope" },
      { type: "tool_use", id: "call-1", name: "lookup", input: { query: "中文" } },
    ];
    f.request.messages.push({ role: "assistant", rawAssistant: raw, toolCalls: [{ id: "call-1", name: "lookup", arguments: '{"query":"中文"}' }] },
      { role: "tool", toolCallId: "call-1", content: "查到了" }, { role: "user", content: "继续" });
    let actual: string | undefined;
    vi.stubGlobal("fetch", vi.fn(async (source: RequestInfo | URL, init?: RequestInit) => {
      actual = await new Request(source, init).text(); return sse(transport);
    }));
    const prepared = prepareModelCall(f.adapter, f.request, f.config, f.identity);
    expect(prepared.serializedBody).toContain("synthetic-envelope");
    raw.length = 0;
    await dispatchPreparedModelCall({ prepared, config: f.config, timeoutMs: 1000 });
    expect(actual).toBe(prepared.serializedBody); expect(build).toHaveBeenCalledTimes(1);
  });

  it("retains protocol errors and closes the execution span on failed stream parsing", async () => {
    const f = fixture("responses"), fetch = vi.fn(async () => new Response(
      `data: ${JSON.stringify({ type: "response.failed", response: { error: { message: "synthetic stream error" } } })}\n\n`,
      { headers: { "Content-Type": "text/event-stream" } }));
    vi.stubGlobal("fetch", fetch); const observer = vi.fn();
    const prepared = prepareModelCall(f.adapter, f.request, f.config, f.identity);
    await expect(dispatchPreparedModelCall({ prepared, config: f.config, timeoutMs: 1000, onModelExecution: observer })).rejects.toMatchObject({ name: "ProviderProtocolError" });
    expect(fetch).toHaveBeenCalledTimes(1); expect(observer.mock.calls.at(-1)).toEqual(["end", "failed"]);
  });
});

describe("prepared transport hardening", () => {
  it.each([true, false])("disallows implicit fetch redirects after endpoint validation (stream=%s)", async stream => {
    const f = fixture("openai"); f.request.stream = stream;
    let redirect: RequestRedirect | undefined;
    vi.stubGlobal("fetch", vi.fn(async (source: RequestInfo | URL, init?: RequestInit) => {
      redirect = new Request(source, init).redirect;
      return stream ? sse("openai") : Response.json({ choices: [] });
    }));
    const prepared = prepareModelCall(f.adapter, f.request, f.config, f.identity);
    await dispatchPreparedModelCall({ prepared, config: f.config, timeoutMs: 1000 });
    expect(redirect).toBe("error");
  });

  it("isolates asynchronous observer rejection from transport completion", async () => {
    const f = fixture("openai");
    vi.stubGlobal("fetch", vi.fn(async () => sse("openai")));
    const prepared = prepareModelCall(f.adapter, f.request, f.config, f.identity);
    let observed = 0;
    const observer = async () => { observed += 1; throw new Error("synthetic observer rejection"); };
    await expect(dispatchPreparedModelCall({ prepared, config: f.config, timeoutMs: 1000, onModelExecution: observer })).resolves.toMatchObject({ text: "完成" });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(observed).toBe(2);
  });
});


it.each([true, false])("never follows a native-fetch 307 to another model endpoint (stream=%s)", async stream => {
  const f = fixture("openai"); f.request.stream = stream;
  const previous = getGlobalDispatcher(), agent = new MockAgent();
  let approvedCalls = 0, redirectedCalls = 0;
  agent.disableNetConnect(); setGlobalDispatcher(agent);
  agent.get("https://synthetic.invalid").intercept({ path: "/v1/chat/completions", method: "POST" }).reply(() => {
    approvedCalls += 1;
    return { statusCode: 307, data: "", responseOptions: { headers: { location: "https://redirect.invalid/v1/chat/completions" } } };
  });
  agent.get("https://redirect.invalid").intercept({ path: "/v1/chat/completions", method: "POST" }).reply(() => {
    redirectedCalls += 1;
    return { statusCode: 200, data: JSON.stringify({ choices: [] }), responseOptions: { headers: { "content-type": "application/json" } } };
  });
  try {
    const prepared = prepareModelCall(f.adapter, f.request, f.config, f.identity);
    await expect(dispatchPreparedModelCall({ prepared, config: f.config, timeoutMs: 1000 })).rejects.toMatchObject({ code: "E_MODEL_REQUEST_FAILED" });
    expect(approvedCalls).toBe(1); expect(redirectedCalls).toBe(0);
  } finally {
    setGlobalDispatcher(previous); await agent.close();
  }
});

it("compares canonical endpoint URLs while preserving saved configuration", async () => {
  const f = fixture("openai"); f.config.baseUrl = "https://SYNTHETIC.invalid/v1";
  const before = JSON.stringify(f.config);
  vi.stubGlobal("fetch", vi.fn(async () => sse("openai")));
  const prepared = prepareModelCall(f.adapter, f.request, f.config, f.identity);
  await expect(dispatchPreparedModelCall({ prepared, config: f.config, timeoutMs: 1000 })).resolves.toMatchObject({ text: "完成" });
  expect(prepared.endpoint).toBe("https://synthetic.invalid/v1/chat/completions");
  expect(JSON.stringify(f.config)).toBe(before);
});

it.each([true, false])("preserves timeout classification before wire verification finishes (stream=%s)", async stream => {
  const f = fixture("openai"); f.request.stream = stream;
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const originalClone = Request.prototype.clone;
  vi.spyOn(Request.prototype, "clone").mockImplementation(function(this: Request) {
    const clone = originalClone.call(this), text = clone.text.bind(clone);
    clone.text = async () => { await new Promise(resolve => setTimeout(resolve, 25)); return text(); };
    return clone;
  });
  const observer = vi.fn();
  const prepared = prepareModelCall(f.adapter, f.request, f.config, f.identity);
  await expect(dispatchPreparedModelCall({ prepared, config: f.config, timeoutMs: 5, onModelExecution: observer })).rejects.toMatchObject({ code: "E_MODEL_REQUEST_TIMEOUT" });
  expect(fetch).not.toHaveBeenCalled(); expect(observer).not.toHaveBeenCalled();
});


it("waits for Anthropic background reader settlement when the delta sink throws", async () => {
  const f = fixture("anthropic");
  let body!: ReadableStreamDefaultController<Uint8Array>;
  const events = [
    { type: "message_start", message: { id: "m1", type: "message", role: "assistant", content: [], model: "synthetic-model", stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } },
  ];
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      body = controller;
      controller.enqueue(new TextEncoder().encode(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")));
    },
  }), { headers: { "Content-Type": "text/event-stream" } })));
  let entered!: () => void;
  const deltaSeen = new Promise<void>(resolve => { entered = resolve; });
  const observer = vi.fn();
  const prepared = prepareModelCall(f.adapter, f.request, f.config, f.identity);
  let settled = false;
  const pending = dispatchPreparedModelCall({ prepared, config: f.config, timeoutMs: 1000, onModelExecution: observer,
    onDelta: delta => { if (delta.type === "text_delta") { entered(); throw new Error("sink failed"); } },
  }).catch(error => error).finally(() => { settled = true; });
  await deltaSeen;
  await new Promise(resolve => setImmediate(resolve));
  try {
    expect(settled).toBe(false);
    expect(observer.mock.calls).toEqual([["start", undefined]]);
  } finally { body.error(new Error("synthetic provider finally settled")); }
  expect(await pending).toMatchObject({ code: "E_MODEL_REQUEST_FAILED", cause: { message: "sink failed" } });
  expect(observer.mock.calls.at(-1)).toEqual(["end", "failed"]);
});

it.each(["input_image", "input_file"])("classifies Responses function output content %s before budget admission", type => {
  const f = fixture("responses");
  f.request.messages = [{ role: "user", content: "inspect tool output" }];
  f.request.extraBody = { input: [{ type: "function_call_output", call_id: "call-1", output: [
    type === "input_image" ? { type, image_url: "data:image/png;base64,c3ludGhldGlj" } : { type, file_id: "file-synthetic" },
  ] }] };
  if (type === "input_file") {
    expect(() => prepareModelCall(f.adapter, f.request, f.config, f.identity)).toThrow("MEMORY_CONTEXT_COUNTER_UNSUPPORTED");
  } else {
    expect(prepareModelCall(f.adapter, f.request, f.config, f.identity).request.inputTypes).toEqual(["text", "function-tools", "image"]);
  }
});

it.each(["openai", "responses", "anthropic"] as const)("uses the adapter's private authentication headers for %s streaming", async transport => {
  const f = fixture(transport);
  f.adapter.capability.authStyle = transport === "anthropic" ? "bearer" : "x-api-key";
  let headers: Headers | undefined;
  vi.stubGlobal("fetch", vi.fn(async (source: RequestInfo | URL, init?: RequestInit) => {
    headers = new Request(source, init).headers; return sse(transport);
  }));
  const prepared = prepareModelCall(f.adapter, f.request, f.config, f.identity);
  await dispatchPreparedModelCall({ prepared, config: f.config, timeoutMs: 1000 });
  expect(headers?.get(transport === "anthropic" ? "authorization" : "x-api-key"))
    .toBe(transport === "anthropic" ? `Bearer ${f.config.apiKey}` : f.config.apiKey);
  expect(headers?.has(transport === "anthropic" ? "x-api-key" : "authorization")).toBe(false);
  expect(JSON.stringify(prepared)).not.toContain(f.config.apiKey);
});

it("stops synthesized tool endings immediately when a delta listener cancels", async () => {
  const f = fixture("openai"), controller = new AbortController();
  const events = [
    { choices: [{ delta: { tool_calls: [
      { index: 0, id: "call-1", type: "function", function: { name: "lookup", arguments: "{}" } },
      { index: 1, id: "call-2", type: "function", function: { name: "lookup", arguments: "{}" } },
    ] } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  ];
  vi.stubGlobal("fetch", vi.fn(async () => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "Content-Type": "text/event-stream" } })));
  const received: string[] = [];
  const prepared = prepareModelCall(f.adapter, f.request, f.config, f.identity);
  await expect(dispatchPreparedModelCall({ prepared, config: f.config, timeoutMs: 1000, signal: controller.signal,
    onDelta: delta => {
      received.push(delta.type);
      if (delta.type === "tool_call_end") controller.abort(new Error("cancelled after first tool"));
    },
  })).rejects.toThrow("cancelled after first tool");
  expect(received.filter(type => type === "tool_call_end")).toHaveLength(1);
  expect(received).not.toContain("finish");
});


it("forwards existing stream diagnostics without rebuilding or resending the prepared body", async () => {
  const f = fixture("anthropic"), onDiagnostic = vi.fn();
  let sentBody: string | undefined;
  const fetch = vi.fn(async (source: RequestInfo | URL, init?: RequestInit) => {
    sentBody = await new Request(source, init).text();
    // Delay usage until the terminal event so the think filter is exercised.
    const events = (await sse("anthropic").text()).replace('"usage":{"input_tokens":12,"output_tokens":0}', '"usage":{}').replace('"完成"', '"<think>思考</think>完成"');
    return new Response(events, { headers: { "Content-Type": "text/event-stream" } });
  });
  vi.stubGlobal("fetch", fetch);
  const prepared = prepareModelCall(f.adapter, f.request, f.config, f.identity);
  await dispatchPreparedModelCall({ prepared, config: f.config, timeoutMs: 1000, onDiagnostic });
  expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ code: "E_STREAM_TERMINAL_MISMATCH", differences: expect.arrayContaining(["text"]) }));
  expect(sentBody).toBe(prepared.serializedBody); expect(fetch).toHaveBeenCalledTimes(1);
});

it.each(transports)("keeps %s prepared provider error diagnostics reason-only", async transport => {
  const f = fixture(transport), canary = "SYNTHETIC_SECRET_ERROR_CANARY_6fbd8c";
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { message: canary, code: canary, type: canary } }, { status: 401 })));
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(promptDump, "dumpRequest").mockReturnValue("synthetic-trace");
  const dump = vi.spyOn(promptDump, "dumpResponse").mockImplementation(() => {});
  const prepared = prepareModelCall(f.adapter, f.request, f.config, f.identity);
  await expect(dispatchPreparedModelCall({ prepared, config: f.config, timeoutMs: 1000 })).rejects.toMatchObject({ code: "E_MODEL_REQUEST_FAILED" });
  expect(log).toHaveBeenCalled(); expect(dump).toHaveBeenCalled();
  expect(JSON.stringify(log.mock.calls)).not.toContain(canary);
  expect(JSON.stringify(dump.mock.calls)).not.toContain(canary);
  expect(JSON.stringify(log.mock.calls)).toContain("E_MODEL_REQUEST_FAILED");
  expect(dump).toHaveBeenCalledWith("synthetic-trace", expect.objectContaining({ error: "E_MODEL_REQUEST_FAILED", raw: null }));
});
