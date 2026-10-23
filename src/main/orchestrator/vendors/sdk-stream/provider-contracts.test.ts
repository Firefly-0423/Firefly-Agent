import { describe, it, expect } from "vitest";
import { PROVIDER_CAPABILITIES as providers, getAdapterForConfig, resolveTransport, type ProviderCapability, type VendorConfig } from "../index";
import { deriveOpenAIClientConfig, deriveAnthropicClientConfig } from "./client-config";
import { AnthropicEventNormalizer } from "./anthropic-normalizer";
import { normalizeOpenAIChunk } from "./openai-normalizer";

const config = (provider: ProviderCapability, explicitTransport?: "openai" | "anthropic"): VendorConfig => ({
  provider: provider.displayName, model: provider.defaultModel || "calendar-configured-model", apiKey: "calendar-contract-key", baseUrl: provider.baseUrl, explicitTransport,
});

describe("Built-in provider SDK boundary contracts", () => {
  it.each(providers)("keeps $displayName's configured transport, tools, model and streaming request", (provider) => {
    const selected = config(provider), adapter = getAdapterForConfig(selected);
    const http = adapter.buildStreamRequest({ model: "calendar-configured-model", messages: [{ role: "user", content: "Check my calendar" }], tools: [{ name: "calendar_read", description: "Read appointments", parameters: { type: "object" } }] }, selected);
    const body = JSON.parse(http.body);
    expect(resolveTransport(selected)).toEqual(provider.transport);
    expect(adapter.transport).toEqual(provider.transport);
    expect(body).toMatchObject({ model: "calendar-configured-model", stream: true });
    expect(http.url).toMatch(provider.transport === "anthropic" ? /\/v1\/messages$/ : provider.transport === "responses" ? /\/responses$/ : /\/chat\/completions$/);
    expect(body.tools).toBeDefined();
  });

  it.each(providers.filter(({ transport }) => transport === "openai"))("normalizes $displayName's full ordered reasoning, text, call and usage sequence", (provider) => {
    const id = provider.id + "-calendar-call", text = provider.id + "-calendar-answer", reason = provider.id + "-calendar-reason";
    expect(normalizeOpenAIChunk({ choices: [{ delta: { content: text, [provider.thinkingField === "thinking" ? "thinking" : "reasoning_content"]: reason, tool_calls: [{ index: 3, id, function: { name: "calendar_read", arguments: '{"day":"Tuesday"}' } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 28, completion_tokens: 9 } })).toStrictEqual([
      { type: "reasoning_delta", delta: reason }, { type: "text_delta", delta: text },
      { type: "tool_call_start", index: 3, id, nameDelta: "calendar_read" }, { type: "tool_call_arguments_delta", index: 3, id, delta: '{"day":"Tuesday"}' },
      { type: "usage", inputTokens: 28, outputTokens: 9 }, { type: "finish", reason: "tool_calls" },
    ]);
  });

  it("normalizes the full Anthropic reasoning, answer, fragmented call and finish flow", () => {
    const stream = new AnthropicEventNormalizer();
    const deltas = [
      { type: "content_block_start", index: 3, content_block: { type: "thinking" } },
      { type: "content_block_delta", index: 3, delta: { type: "thinking_delta", thinking: "Check timezone" } },
      { type: "content_block_start", index: 4, content_block: { type: "text" } },
      { type: "content_block_delta", index: 4, delta: { type: "text_delta", text: "Reading calendar" } },
      { type: "content_block_start", index: 5, content_block: { type: "tool_use", id: "calendar-call", name: "calendar_read" } },
      { type: "content_block_delta", index: 5, delta: { type: "input_json_delta", partial_json: '{"day":' } },
      { type: "content_block_delta", index: 5, delta: { type: "input_json_delta", partial_json: '"Tuesday"}' } },
      { type: "content_block_stop", index: 5 }, { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } },
    ].flatMap((event) => stream.normalize(event));
    expect(deltas).toEqual([
      { type: "reasoning_delta", delta: "Check timezone" }, { type: "text_delta", delta: "Reading calendar" },
      { type: "tool_call_start", index: 5, id: "calendar-call", nameDelta: "calendar_read" },
      { type: "tool_call_arguments_delta", index: 5, id: "calendar-call", delta: '{"day":' },
      { type: "tool_call_arguments_delta", index: 5, id: "calendar-call", delta: '"Tuesday"}' },
      { type: "tool_call_end", index: 5, id: "calendar-call" }, { type: "usage", outputTokens: 9 }, { type: "finish", reason: "tool_use" },
    ]);
    expect(deltas.filter(({ type }) => type === "tool_call_arguments_delta")).toHaveLength(2);
  });

  it("uses MiniMax's Anthropic default while supporting explicit MiMo Anthropic authentication", () => {
    const mini = providers.find(({ id }) => id === "minimax")!, mimo = providers.find(({ id }) => id === "mimo")!;
    expect(getAdapterForConfig(config(mini)).transport).toEqual("anthropic");
    expect(getAdapterForConfig({ ...config(mini, "anthropic"), baseUrl: "https://api.minimaxi.com/anthropic" }).transport).toEqual("anthropic");
    expect(getAdapterForConfig({ ...config(mimo, "anthropic"), baseUrl: "https://api.xiaomimimo.com/anthropic" }).transport).toEqual("anthropic");
    expect(deriveAnthropicClientConfig("https://api.minimaxi.com/anthropic/v1/messages", "calendar-key", "x-api-key")).toMatchObject({ apiKey: "calendar-key", maxRetries: 0 });
    expect(deriveAnthropicClientConfig("https://api.xiaomimimo.com/anthropic/v1/messages", "calendar-key", "bearer")).toMatchObject({ authToken: "calendar-key", maxRetries: 0 });
    expect(deriveOpenAIClientConfig("https://api.minimaxi.com/v1/chat/completions", "calendar-key")).toMatchObject({ baseURL: "https://api.minimaxi.com/v1", maxRetries: 0 });
  });
});
