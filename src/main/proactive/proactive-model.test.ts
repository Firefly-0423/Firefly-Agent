import { beforeEach, describe, it, expect, vi } from "vitest";
import type { ChatMessage } from "../orchestrator/vendors";
import type { RunProactiveModelInput } from "./proactive-model";

const provider = vi.hoisted(() => ({ encode: vi.fn(), decode: vi.fn(), usage: vi.fn(), request: vi.fn() }));
vi.mock("../token-usage-store", () => ({ recordRequest: provider.request, recordUsage: provider.usage }));
vi.mock("../orchestrator/vendors", () => ({
  getAdapterForConfig: () => ({ parseResponse: provider.decode, buildRequest: provider.encode }),
}));
import { runProactiveModel } from "./proactive-model";

const config = { provider: "test", baseUrl: "https://relay.invalid/v1", model: "companion-small", apiKey: "unit-credential" };
const dialogue: ChatMessage[] = [{ role: "system", content: "Be considerate." }, { role: "user", content: "Choose a decision." }];
const packet = { url: "https://relay.invalid/v1/reply", headers: { Authorization: "Bearer unit-credential" }, body: "encoded-payload" };
function execute(fetchFn: typeof fetch, changes: Partial<RunProactiveModelInput> = {}) {
  return runProactiveModel({ messages: dialogue, settings: config, timeoutMs: 850, fetchFn, ...changes });
}
const success = () => vi.fn(async () => new Response('{"accepted":true}', { status: 200 }));

beforeEach(() => {
  vi.resetAllMocks();
  provider.encode.mockReturnValue(packet);
});

describe("proactive provider boundary", () => {
  it.each([
    { role: "tool", content: "untrusted result", toolCallId: "tool-72" },
    { role: "assistant", content: "", toolCalls: [{ id: "tool-81", name: "read", arguments: "{}" }] },
    { role: "user", content: "unexpected reference", toolCallId: "tool-93" },
  ])("blocks tool traffic before constructing a request: $role", async (message) => {
    const network = vi.fn();
    expect(await execute(network, { messages: [message as ChatMessage] }))
      .toEqual({ reason: "tool_content_forbidden", kind: "error" });
    expect(network.mock.calls).toEqual([]);
    expect(provider.encode.mock.calls).toEqual([]);
  });

  it("sends an ordinary nonstreaming request without any tool capability and accounts for usage", async () => {
    provider.decode.mockReturnValue({ text: JSON.stringify({ decision: "send", text: "Take a stretch?" }), usage: { input: 12, output: 8 } });
    const network = success();
    expect(await execute(network)).toEqual({ text: "Take a stretch?", kind: "send" });
    expect(provider.encode.mock.calls).toEqual([[{ model: config.model, messages: dialogue, stream: false, maxTokens: 600 }, config]]);
    const request = provider.encode.mock.calls[0][0];
    expect(request).not.toHaveProperty("tools");
    expect(JSON.stringify(request)).not.toContain("tool_calls");
    expect(network).toHaveBeenCalledExactlyOnceWith(packet.url, {
      method: "POST", headers: packet.headers, body: packet.body, signal: expect.any(AbortSignal),
    });
    expect(provider.decode.mock.calls).toEqual([[{ accepted: true }]]);
    expect(provider.request.mock.calls).toEqual([[config.model, "proactive"]]);
    expect(provider.usage).toHaveBeenCalledExactlyOnceWith(12, 8, 1, undefined, config.model, undefined, "proactive");
  });

  it("decodes a complete response before accepting silence", async () => {
    provider.decode.mockReturnValue({ text: '{"decision":"silent","text":"discard this"}' });
    expect(await execute(success())).toEqual({ kind: "silent" });
    expect(provider.decode).toHaveBeenCalledTimes(1);
    expect(provider.request).toHaveBeenCalledExactlyOnceWith(config.model, "proactive");
    expect(provider.usage.mock.calls).toEqual([]);
  });

  it("separates malformed model JSON from HTTP and provider decoding failures", async () => {
    provider.decode.mockReturnValue({ text: "an informal answer" });
    expect(await execute(success())).toEqual({ reason: "invalid_json", kind: "invalid" });
    expect(await execute(vi.fn(async () => new Response("maintenance", { status: 503 }))))
      .toEqual({ reason: "http_503", kind: "error" });
    expect(provider.decode).toHaveBeenCalledTimes(1);
    provider.decode.mockImplementation(() => { throw new Error("unrecognized envelope"); });
    expect(await execute(success())).toEqual({ reason: "invalid_provider_response", kind: "invalid" });
  });

  it.each([
    [new Error("socket disconnected"), "network_error"],
    [Object.assign(new Error("deadline reached"), { name: "AbortError" }), "timeout"],
    [new Error("MEMORY_CONTEXT_CANCELLED"), "MEMORY_CONTEXT_CANCELLED"],
  ])("maps a rejected transport to %s", async (failure, reason) => {
    expect(await execute(vi.fn(async () => { throw failure; }))).toEqual({ kind: "error", reason });
  });
});

describe("Main memory generation", () => {
  it("commits the assistant transcript and checkpoint before parsing the decision, without direct fetch", async () => {
    const order: string[] = [];
    const assistantMessage = { role: "assistant" as const, content: '{"decision":"send","text":"A quiet reminder"}' };
    const sink = {
      appendAssistant: vi.fn(async () => { order.push("assistant"); return "entry-28"; }),
      checkpoint: vi.fn(async () => { order.push("checkpoint"); }),
    };
    const runtime = {
      call: vi.fn<NonNullable<RunProactiveModelInput["memoryRun"]>["call"]>(async () => {
        order.push("model");
        return { text: assistantMessage.content, assistantMessage };
      }),
      bindSink: vi.fn((target: unknown) => target), close: vi.fn(),
    };
    provider.request.mockImplementation(() => order.push("account"));
    const network = vi.fn();
    const result = await execute(network, {
      memoryRun: runtime as unknown as RunProactiveModelInput["memoryRun"],
      transcriptSink: sink as unknown as RunProactiveModelInput["transcriptSink"],
    });
    expect(result).toEqual({ text: "A quiet reminder", kind: "send" });
    expect(order).toEqual(["model", "assistant", "checkpoint", "account"]);
    expect(runtime.call).toHaveBeenCalledExactlyOnceWith({ adapter: expect.any(Object),
      request: { model: config.model, messages: dialogue, maxTokens: 600, stream: false },
      config, timeoutMs: 850, signal: expect.any(AbortSignal) });
    expect(runtime.call.mock.calls[0][0].request).not.toHaveProperty("tools");
    expect(runtime.bindSink).toHaveBeenCalledExactlyOnceWith(sink);
    expect(sink.appendAssistant).toHaveBeenCalledExactlyOnceWith({ message: assistantMessage });
    expect(sink.checkpoint.mock.calls).toEqual([[]]);
    expect(network.mock.calls).toEqual([]);
    expect(provider.encode.mock.calls).toEqual([]);
  });

  it("requires a transcript sink before calling the memory runtime", async () => {
    const call = vi.fn();
    const network = vi.fn();
    expect(await execute(network, { memoryRun: { call } as unknown as RunProactiveModelInput["memoryRun"] }))
      .toEqual({ reason: "MEMORY_CONTEXT_STREAM_SINK_DENIED", kind: "error" });
    expect(call.mock.calls).toEqual([]);
    expect(network.mock.calls).toEqual([]);
  });
});
