import { describe, expect, it, vi } from "vitest";
import { buildVendorUrl, createSseReader, getAdapterForConfig } from "./index";
import { OpenAICompatAdapter } from "./openai-adapter";
import { AnthropicAdapter } from "./anthropic-adapter";
import { ResponsesAdapter } from "./responses-adapter";
import type { ChatMessage, ProviderCapability, VendorConfig } from "./types";
it.each([["openai", OpenAICompatAdapter], ["anthropic", AnthropicAdapter], ["responses", ResponsesAdapter]] as const)("selects and reuses %s adapters independently of credentials", (explicitTransport, Type) => {
  const cfg = { provider: "unit-provider", baseUrl: "https://example.test", model: "a", apiKey: "test", explicitTransport };
  const adapter = getAdapterForConfig(cfg); expect(adapter).toBeInstanceOf(Type); expect(getAdapterForConfig({ ...cfg, model: "b", apiKey: "changed" })).toBe(adapter);
});
it("keeps transport/provider caches separate and falls back to OpenAI for unknown providers", () => {
  const cfg = { provider: "unknown-provider", baseUrl: "https://example.test", model: "m", apiKey: "test" };
  expect(getAdapterForConfig(cfg)).toBeInstanceOf(OpenAICompatAdapter);
  expect(getAdapterForConfig(cfg)).not.toBe(getAdapterForConfig({ ...cfg, explicitTransport: "anthropic" }));
  expect(getAdapterForConfig(cfg)).not.toBe(getAdapterForConfig({ ...cfg, provider: "another" }));
});
it.each([["https://example.test/v1/", "openai", "https://example.test/v1/chat/completions"], ["https://example.test", "anthropic", "https://example.test/v1/messages"], ["https://example.test/v1", "anthropic", "https://example.test/v1/messages"], ["https://example.test/v1", "responses", "https://example.test/v1/responses"]] as const)("builds %s %s endpoint", (base, transport, expected) => { expect(buildVendorUrl(base, transport)).toBe(expected); });
it("decodes split multibyte UTF-8, multiline data, ignored fields and trailing event", async () => {
  const bytes = new TextEncoder().encode(": heartbeat\r\n\r\nevent: message\r\nid: 1\r\nretry: 10\r\ndata: 中文\r\ndata:  second\r\n\r\ndata: tail");
  const stream = new ReadableStream<Uint8Array>({ start(c) { for (const byte of bytes) c.enqueue(Uint8Array.of(byte)); c.close(); } });
  const found = []; for await (const event of createSseReader({} as never, stream)) found.push(event);
  expect(found).toEqual([{ eventType: "message", data: "中文\n second" }, { eventType: "data", data: "tail" }]);
});
it("cancels a reader on early iteration exit", async () => {
  const cancel = vi.fn(); const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode("data: a\n\n")); }, cancel });
  for await (const event of createSseReader({} as never, stream)) { expect(event.data).toBe("a"); break; } expect(cancel).toHaveBeenCalledOnce();
});
it("propagates stream read failures", async () => {
  const error = Error("read failed"), stream = new ReadableStream<Uint8Array>({ start(c) { c.error(error); } });
  await expect(createSseReader({} as never, stream)[Symbol.asyncIterator]().next()).rejects.toBe(error);
});

describe("one session switching between Anthropic and Responses transports", () => {
  const capability: ProviderCapability = { id: "unit", displayName: "Unit", transport: "anthropic",
    baseUrl: "https://example.test", authStyle: "x-api-key", defaultModel: "unit-model",
    supportsTools: true, supportsThinking: true, thinkingField: "thinking", cacheStrategy: "cache_control", testStrategy: "text" };
  const cfg: VendorConfig = { provider: "unit", baseUrl: capability.baseUrl, model: capability.defaultModel, apiKey: "test" };
  const toolCall = { id: "call-1", name: "calendar_read", arguments: '{"day":"Tuesday"}' };
  /** 同一会话：上一轮 assistant 由另一种 transport 产生，下一轮换了接口继续。 */
  const session = (rawAssistant: unknown): ChatMessage[] => [
    { role: "user", content: "Read Tuesday" },
    { role: "assistant", content: "Tuesday is free", toolCalls: [toolCall], rawAssistant },
    { role: "tool", toolCallId: "call-1", content: "09:30 dentist" },
    { role: "user", content: "And Wednesday?" },
  ];

  it("does not replay Responses output items as Anthropic content blocks", () => {
    const responsesRaw = [
      { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "check" }] },
      { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "Tuesday is free" }] },
      { type: "function_call", id: "fc_1", call_id: "call-1", name: "calendar_read", arguments: '{"day":"Tuesday"}' },
    ];
    const adapter = new AnthropicAdapter("unit", capability);
    const body = JSON.parse(adapter.buildRequest({ model: capability.defaultModel, messages: session(responsesRaw) }, cfg).body);
    expect(body.messages[1].content).toEqual([
      { type: "text", text: "Tuesday is free" },
      { type: "tool_use", id: "call-1", name: "calendar_read", input: { day: "Tuesday" } },
    ]);
  });

  it("rebuilds a foreign history that declares no tool calls", () => {
    const responsesRaw = [{ type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "hello" }] }];
    const adapter = new AnthropicAdapter("unit", capability);
    const body = JSON.parse(adapter.buildRequest({ model: capability.defaultModel, messages: [
      { role: "user", content: "hi" }, { role: "assistant", content: "hello", rawAssistant: responsesRaw }, { role: "user", content: "again" },
    ] }, cfg).body);
    expect(body.messages[1].content).toEqual([{ type: "text", text: "hello" }]);
  });

  it("does not drop the prior Anthropic turn when replaying through Responses", () => {
    const anthropicRaw = [
      { type: "thinking", thinking: "check", signature: "sig" },
      { type: "text", text: "Tuesday is free" },
      { type: "tool_use", id: "call-1", name: "calendar_read", input: { day: "Tuesday" } },
    ];
    const adapter = new ResponsesAdapter("unit", { ...capability, transport: "responses" });
    const body = JSON.parse(adapter.buildRequest({ model: capability.defaultModel, messages: session(anthropicRaw) }, cfg).body);
    const kinds = body.input.map((item: { type?: string; role?: string }) => item.type ?? item.role);
    expect(kinds).toContain("function_call");
    expect(kinds).toContain("assistant");
    // 工具结果必须有对应的 function_call，否则 Responses 会拒绝这条孤立的结果。
    expect(kinds.filter((kind: string) => kind === "function_call")).toHaveLength(kinds.filter((kind: string) => kind === "function_call_output").length);
  });
});
