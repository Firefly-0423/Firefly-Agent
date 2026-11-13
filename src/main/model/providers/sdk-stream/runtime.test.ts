import { afterEach, describe, it, expect, vi } from "vitest";
import { OpenAICompatAdapter } from "../openai-adapter";
import { AnthropicAdapter } from "../anthropic-adapter";
import { ResponsesAdapter } from "../responses-adapter";
import { streamChatWithSdk, type SdkStreamRuntimeDeps } from "./runtime";
import type { ChatRequest, ProviderCapability, VendorConfig } from "../types";
import type { UnifiedStreamDelta } from "./types";

const provider: ProviderCapability = { id: "chatgpt", displayName: "Agenda model", transport: "openai", baseUrl: "https://api.openai.com/v1", authStyle: "bearer", defaultModel: "agenda-model", supportsTools: true, supportsThinking: true, thinkingField: "reasoning_content", cacheStrategy: "none", testStrategy: "text" };
const request: ChatRequest = { model: "agenda-model", messages: [{ role: "user", content: "Read the calendar" }] };
const config: VendorConfig = { provider: "Agenda model", baseUrl: provider.baseUrl, model: "agenda-model", apiKey: "agenda-stream-key", explicitTransport: "openai" };
async function* events(...payloads: unknown[]) { yield* payloads; }
const unexpected = async (): Promise<never> => { throw Error("Wrong calendar transport selected"); };
function run(transport: "openai" | "anthropic" | "responses", deps: Partial<SdkStreamRuntimeDeps>, options: Partial<Parameters<typeof streamChatWithSdk>[0]> = {}) {
  const cap: ProviderCapability = { ...provider, transport, ...(transport === "anthropic" ? { id: "claude", authStyle: "x-api-key" as const, thinkingField: "thinking" as const } : {}) };
  const adapter = transport === "openai" ? new OpenAICompatAdapter(cap.id, cap) : transport === "responses" ? new ResponsesAdapter(cap.id, cap) : new AnthropicAdapter(cap.id, cap);
  return streamChatWithSdk({ adapter, request, config: { ...config, explicitTransport: transport, ...(transport === "anthropic" ? { baseUrl: "https://api.anthropic.com" } : {}) }, timeoutMs: 900, ...options }, { openAI: unexpected, responses: unexpected, anthropic: unexpected, ...deps });
}
function latch() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }
afterEach(() => vi.useRealTimers());

describe("SDK streaming transport dispatch and visible deltas", () => {
  it.each(["openai", "responses"] as const)("streams %s reasoning, answer and usage before returning", async (transport) => {
    const seen: UnifiedStreamDelta[] = [], output = [{ type: "reasoning", summary: [] }, { type: "message", content: [{ type: "output_text", text: "Tuesday is free" }] }];
    let captured!: Parameters<SdkStreamRuntimeDeps["openAI"]>[0];
    const factory = async (input: typeof captured) => {
      captured = input;
      return transport === "openai" ? events(
        { choices: [{ delta: { reasoning_content: "Checking agenda" }, finish_reason: null }] },
        { choices: [{ delta: { content: "Tuesday is free" }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 28, completion_tokens: 9 } },
      ) : events({ type: "response.reasoning_summary_text.delta", delta: "Checking agenda" }, { type: "response.output_text.delta", delta: "Tuesday is free" }, { type: "response.completed", response: { id: "agenda-response", output, usage: { input_tokens: 28, output_tokens: 9 } } });
    };
    const result = await run(transport, { [transport === "openai" ? "openAI" : "responses"]: factory }, { onDelta: (delta) => seen.push(delta) });
    expect(captured.body).toMatchObject({ model: "agenda-model", stream: true, ...(transport === "responses" ? { store: false } : {}) });
    expect(captured.client).toMatchObject({ baseURL: "https://api.openai.com/v1", apiKey: "agenda-stream-key", maxRetries: 0 });
    if (transport === "openai") expect(captured.signal.aborted).toEqual(false);
    expect(seen).toEqual([{ type: "reasoning_delta", delta: "Checking agenda" }, { type: "text_delta", delta: "Tuesday is free" }, { type: "usage", inputTokens: 28, outputTokens: 9 }, { type: "finish", reason: "stop" }]);
    expect(result).toMatchObject({ text: "Tuesday is free", thinking: "Checking agenda", finishReason: "stop", usage: { input: 28, output: 9 } });
    if (transport === "responses") expect(result.assistantMessage.rawAssistant).toEqual(output);
  });

  it("moves fragmented leading think tags into reasoning without leaking them into answer text", async () => {
    const seen: UnifiedStreamDelta[] = [];
    const result = await run("openai", { openAI: async () => events(...["<thi", "nk>Check calendar", " dates</think>Tuesday is free"].map((content) => ({ choices: [{ delta: { content }, finish_reason: null }] })), { choices: [{ delta: {}, finish_reason: "stop" }] }) }, { onDelta: (delta) => seen.push(delta) });
    expect(seen.filter((delta) => delta.type === "reasoning_delta").map((delta) => delta.delta).join("")).toEqual("Check calendar dates");
    expect(seen.filter((delta) => delta.type === "text_delta").map((delta) => delta.delta).join("")).toEqual("Tuesday is free");
    expect(result).toMatchObject({ thinking: "Check calendar dates", text: "Tuesday is free" });
  });

  it("delivers Anthropic deltas before requesting the signed final message", async () => {
    const order: string[] = [], raw = [{ type: "thinking", thinking: "Check calendar", signature: "agenda-proof" }, { type: "text", text: "Tuesday is free" }];
    const result = await run("anthropic", { anthropic: async () => ({
      events: events(
        { type: "content_block_start", index: 3, content_block: { type: "thinking", thinking: "" } },
        { type: "content_block_delta", index: 3, delta: { type: "thinking_delta", thinking: "Check calendar" } }, { type: "content_block_stop", index: 3 },
        { type: "content_block_start", index: 4, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 4, delta: { type: "text_delta", text: "Tuesday is free" } }, { type: "content_block_stop", index: 4 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } }, { type: "message_stop" },
      ),
      finalMessage: async () => { order.push("terminal"); return { content: raw, stop_reason: "end_turn", usage: { input_tokens: 28, output_tokens: 9 } }; },
    }) }, { onDelta: ({ type }) => { if (type === "reasoning_delta" || type === "text_delta") order.push(type); } });
    expect(order).toEqual(["reasoning_delta", "text_delta", "terminal"]);
    expect(result.assistantMessage.rawAssistant).toEqual(raw);
  });

  it("publishes each Anthropic text fragment while later chunks remain blocked", async () => {
    const next = latch(), finish = latch(), seen: string[] = [];
    const fragments = ["Calendar opened. ", "Reading appointments. ", "Tuesday is free."];
    async function* source() {
      yield { type: "content_block_start", index: 3, content_block: { type: "text", text: "" } };
      yield { type: "content_block_delta", index: 3, delta: { type: "text_delta", text: fragments[0] } };
      await next.promise;
      yield { type: "content_block_delta", index: 3, delta: { type: "text_delta", text: fragments[1] } };
      await finish.promise;
      yield { type: "content_block_delta", index: 3, delta: { type: "text_delta", text: fragments[2] } };
      yield { type: "content_block_stop", index: 3 };
      yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } };
      yield { type: "message_stop" };
    }
    const running = run("anthropic", { anthropic: async () => ({ events: source(), finalMessage: async () => ({ stop_reason: "end_turn", usage: { input_tokens: 28, output_tokens: 9 }, content: [{ type: "text", text: fragments.join("") }] }) }) }, { onDelta: (delta) => { if (delta.type === "text_delta") seen.push(delta.delta); } });
    await vi.waitFor(() => expect(seen).toEqual(fragments.slice(0, 1)));
    next.release(); await vi.waitFor(() => expect(seen).toEqual(fragments.slice(0, 2)));
    finish.release(); await running; expect(seen).toEqual(fragments);
  });
});

describe("Responses terminal authority", () => {
  it("keeps incomplete output items and marks the output budget finish reason", async () => {
    const output = [{ type: "message", content: [{ type: "output_text", text: "Partial calendar" }] }];
    const result = await run("responses", { responses: async () => events({ type: "response.output_text.delta", delta: "Partial calendar" }, { type: "response.incomplete", response: { output, incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 36, output_tokens: 12 } } }) });
    expect(result).toMatchObject({ text: "Partial calendar", finishReason: "length", usage: { input: 36, output: 12 } });
    expect(result.assistantMessage.rawAssistant).toEqual(output);
  });
  it("omits canonical raw output if the provider never sent a terminal event", async () => {
    const result = await run("responses", { responses: async () => events({ type: "response.output_text.delta", delta: "Partial calendar" }) });
    expect(result).toMatchObject({ text: "Partial calendar", finishReason: "unknown" });
    expect(result.assistantMessage.rawAssistant).toBeUndefined();
  });
  it("closes a function call on finish even if no explicit call-end event arrived", async () => {
    const output = [{ type: "function_call", call_id: "calendar-call", name: "calendar_read", arguments: '{"day":"Tuesday"}' }];
    const result = await run("responses", { responses: async () => events({ type: "response.output_item.added", output_index: 3, item: { type: "function_call", call_id: "calendar-call", name: "calendar_read", arguments: "" } }, { type: "response.function_call_arguments.delta", output_index: 3, delta: '{"day"' }, { type: "response.function_call_arguments.delta", output_index: 3, delta: ':"Tuesday"}' }, { type: "response.completed", response: { output, usage: { input_tokens: 28, output_tokens: 9 } } }) });
    expect(result.toolCalls).toEqual([{ id: "calendar-call", name: "calendar_read", arguments: '{"day":"Tuesday"}' }]);
    expect(result.assistantMessage.rawAssistant).toEqual(output);
  });
});

describe("Request deadlines and caller cancellation", () => {
  function waiting(signal: AbortSignal): AsyncIterable<unknown> { return { [Symbol.asyncIterator]: () => ({ next: () => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })) }) }; }
  it("leaves timeout=0 unlimited and clears a positive deadline after success", async () => {
    vi.useFakeTimers();
    async function* delayed() { await new Promise((resolve) => setTimeout(resolve, 10)); yield { choices: [{ delta: { content: "Calendar complete" }, finish_reason: "stop" }] }; await new Promise((resolve) => setTimeout(resolve, 10)); }
    const unlimited = run("openai", { openAI: async () => delayed() }, { timeoutMs: 0 });
    await vi.advanceTimersByTimeAsync(20); await expect(unlimited).resolves.toMatchObject({ text: "Calendar complete" });
    let captured!: AbortSignal;
    await run("openai", { openAI: async ({ signal }) => { captured = signal; return events({ choices: [{ delta: { content: "Calendar complete" }, finish_reason: "stop" }] }); } }, { timeoutMs: 25 });
    await vi.advanceTimersByTimeAsync(100);
    expect(captured.aborted).toEqual(false);
  });
  it("maps only its own elapsed deadline to the timeout code", async () => {
    vi.useFakeTimers();
    let captured!: AbortSignal;
    const pending = run("openai", { openAI: async ({ signal }) => { captured = signal; return waiting(signal); } }, { timeoutMs: 25 });
    const rejected = expect(pending).rejects.toEqual(expect.objectContaining({ code: "E_MODEL_REQUEST_TIMEOUT" }));
    await vi.advanceTimersByTimeAsync(25); await rejected; expect(captured.aborted).toEqual(true);
  });
  it("preserves the exact caller cancellation error", async () => {
    const caller = new AbortController(), started = latch(), cancelled = new DOMException("Calendar request cancelled", "AbortError");
    const pending = run("openai", { openAI: async ({ signal }) => { started.release(); return waiting(signal); } }, { signal: caller.signal, timeoutMs: 10_000 });
    await started.promise; caller.abort(cancelled);
    await expect(pending).rejects.toBe(cancelled);
  });
});
