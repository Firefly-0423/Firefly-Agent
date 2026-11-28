import { describe, it, expect } from "vitest";
import { OpenAICompatAdapter } from "./openai-adapter";
import type { ProviderCapability, ChatRequest, VendorConfig } from "./types";

const base: ProviderCapability = { id: "agenda-openai", displayName: "Agenda gateway", transport: "openai", baseUrl: "https://agenda.invalid/v1", authStyle: "bearer", defaultModel: "agenda-model", supportsTools: true, supportsThinking: false, thinkingField: null, cacheStrategy: "none", testStrategy: "text" };
const config: VendorConfig = { provider: base.displayName, baseUrl: base.baseUrl, model: base.defaultModel, apiKey: "agenda-adapter-key" };
const tool = { name: "calendar_read", description: "Read calendar appointments", parameters: { type: "object" } };
function adapter(patch: Partial<ProviderCapability> = {}) { const cap = { ...base, ...patch }; return new OpenAICompatAdapter(cap.id, cap); }
const input: ChatRequest = { model: "agenda-model", messages: [{ role: "user", content: "Read Tuesday's calendar" }] };
const body = (request: Partial<ChatRequest> = {}, selected: Partial<VendorConfig> = {}, cap: Partial<ProviderCapability> = {}) => JSON.parse(adapter(cap).buildRequest({ ...input, ...request }, { ...config, ...selected }).body);

describe("OpenAI-compatible request serialization", () => {
  it("maps structured output schema and both JSON-object hints", () => {
    const schema = { type: "object", properties: { slot: { type: "string", enum: ["morning"] } }, required: ["slot"], additionalProperties: false };
    expect(body({ structuredOutput: { mode: "json_schema", name: "calendar_slot", schema, strict: true } }).response_format).toEqual({ type: "json_schema", json_schema: { name: "calendar_slot", schema, strict: true } });
    expect(body({ structuredOutput: { mode: "json_object" } }).response_format).toEqual({ type: "json_object" });
    expect(body({ structuredOutput: { mode: "prompt_json", sendJsonObjectHint: true } }).response_format).toEqual({ type: "json_object" });
  });

  it("keeps optional tools automatic and applies named, omitted and required policies", () => {
    expect(body({ tools: [tool] }).tool_choice).toEqual("auto");
    const must = { tools: [tool], toolChoiceIntent: { mode: "must_call" as const, toolName: tool.name } };
    expect(body(must, { model: "qwen3-7b", reasoning: { mode: "off" } }, { id: "qwen" }).tool_choice).toEqual({ type: "function", function: { name: "calendar_read" } });
    const deepseek = body(must, { model: "deepseek-v4-pro", reasoning: { mode: "on", effort: "high" } }, { id: "deepseek" });
    expect(deepseek.tools).toHaveLength(1); expect(deepseek.tool_choice).toBeUndefined();
    expect(body(must, { model: "MiniMax-M3", reasoning: { mode: "on" } }, { id: "minimax" }).tool_choice).toEqual("auto");
    expect(body(must, { reasoning: { mode: "off" } }, { id: "required-only", toolChoiceModes: ["required"] }).tool_choice).toEqual("required");
  });

  it("preserves multimodal input and the complete ordered multi-turn tool exchange", () => {
    const blocks = [{ type: "text" as const, text: "Inspect this agenda image" }, { type: "image_url" as const, image_url: { url: "data:image/png;base64,YWdlbmRh" } }];
    expect(body({ messages: [{ role: "system", content: "Calendar rules" }, { role: "user", content: blocks }] }).messages[1]).toEqual({ role: "user", content: blocks });
    const exchange = body({ messages: [
      { role: "user", content: "Read Tuesday" }, { role: "assistant", content: undefined, toolCalls: [{ id: "calendar-call", name: tool.name, arguments: '{"day":"Tuesday"}' }] },
      { role: "tool", name: tool.name, toolCallId: "calendar-call", content: "09:30 dentist" }, { role: "user", content: "And Wednesday?" },
    ] }).messages;
    expect(exchange).toHaveLength(4);
    expect(exchange).toEqual([
      { role: "user", content: "Read Tuesday" },
      { role: "assistant", content: null, tool_calls: [{ id: "calendar-call", type: "function", function: { name: "calendar_read", arguments: '{"day":"Tuesday"}' } }] },
      { role: "tool", tool_call_id: "calendar-call", content: "09:30 dentist", name: "calendar_read" },
      { role: "user", content: "And Wednesday?" },
    ]);
  });

  it.each(["bearer", "x-api-key"] as const)("uses the capability's %s authentication", (authStyle) => {
    const headers = adapter({ authStyle }).buildRequest(input, config).headers;
    expect(headers[authStyle === "bearer" ? "Authorization" : "x-api-key"]).toEqual(authStyle === "bearer" ? "Bearer agenda-adapter-key" : "agenda-adapter-key");
    expect(headers[authStyle === "bearer" ? "x-api-key" : "Authorization"]).toBeUndefined();
  });

  it("keeps Kimi cache identity stable across user input changes", () => {
    const kimi = adapter({ id: "kimi", cacheStrategy: "prompt_cache_key" });
    const stable: ChatRequest = { ...input, model: "kimi-k2.7-code", tools: [tool], promptLayers: { stablePrefix: "Calendar operating rules", mode: "code", promptVersion: "v1" } };
    const original = kimi.applyCacheHints(stable, config), changed = kimi.applyCacheHints({ ...stable, messages: [{ role: "user", content: "Read another calendar" }] }, config);
    expect(original.extraBody?.prompt_cache_key).toMatch(/^firefly:kimi:[a-f0-9]{16}$/);
    expect(changed.extraBody?.prompt_cache_key).toBe(original.extraBody?.prompt_cache_key);
  });
});

describe("OpenAI-compatible response channels", () => {
  const openai = adapter();
  const stream = (payload: unknown) => openai.parseStreamEvent({ eventType: "data", data: JSON.stringify(payload) });
  it("separates answer and reasoning chunks and recognizes the done sentinel", () => {
    expect(stream({ choices: [{ delta: { reasoning_content: "Inspecting calendar" } }] })).toEqual({ deltaThinking: "Inspecting calendar" });
    expect(stream({ choices: [{ delta: { content: "Tuesday is free" } }] })).toEqual({ deltaText: "Tuesday is free" });
    expect(openai.parseStreamEvent({ eventType: "data", data: "[DONE]" })?.done).toEqual(true);
    expect(stream({ choices: [{ delta: { thinking: "Checking timezone" } }] })?.deltaThinking).toEqual("Checking timezone");
    expect(stream({ error: { message: "Calendar stream failed" } })?.error).toEqual("Calendar stream failed");
  });

  it("reads usage-only terminal events and usage accompanying an empty delta", () => {
    expect(stream({ usage: { prompt_tokens: 28, completion_tokens: 16, prompt_tokens_details: { cached_tokens: 12 } } })?.usage).toEqual({ input: 28, output: 16, cachedInput: 12 });
    expect(stream({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 36, completion_tokens: 9 } })).toMatchObject({ usage: { input: 36, output: 9 }, finishReason: "stop" });
  });

  it("retains answer, reasoning, usage, tool calls and refusals in parsed responses", () => {
    const response = openai.parseResponse({ choices: [{ message: { role: "assistant", content: "Tuesday is free", reasoning_content: "Checked the agenda" }, finish_reason: "stop" }], usage: { prompt_tokens: 28, completion_tokens: 16, prompt_tokens_details: { cached_tokens: 12 } } });
    expect(response).toMatchObject({ text: "Tuesday is free", thinking: "Checked the agenda", assistantMessage: { content: "Tuesday is free", thinking: "Checked the agenda" }, usage: { input: 28, output: 16, cachedInput: 12 }, finishReason: "stop" });
    const calls = openai.parseResponse({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "calendar-call", type: "function", function: { name: "calendar_read", arguments: '{"day":"Tuesday"}' } }] }, finish_reason: "tool_calls" }] });
    expect(calls.toolCalls).toEqual([{ id: "calendar-call", name: "calendar_read", arguments: '{"day":"Tuesday"}' }]);
    expect(calls.finishReason).toEqual("tool_calls"); expect(calls.assistantMessage.toolCalls).toEqual(calls.toolCalls);
    expect(openai.parseResponse({ choices: [{ message: { role: "assistant", content: null, refusal: "Calendar is private" }, finish_reason: "stop" }] })).toMatchObject({ text: "", refusal: "Calendar is private", finishReason: "stop" });
  });
});

describe("OpenRouter Chat Completions behavior", () => {
  const router = adapter({ id: "openrouter", displayName: "OpenRouter" });
  const selected = { ...config, provider: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-5.6" };
  it("uses bearer Chat Completions with no optional attribution headers and requests streaming usage", () => {
    const http = router.buildRequest(input, selected);
    expect(http.url).toEqual("https://openrouter.ai/api/v1/chat/completions");
    expect(http.headers.Authorization).toEqual("Bearer agenda-adapter-key");
    expect(http.headers).not.toHaveProperty("HTTP-Referer"); expect(http.headers).not.toHaveProperty("X-Title");
    expect(JSON.parse(router.buildStreamRequest(input, selected).body)).toMatchObject({ stream: true, stream_options: { include_usage: true } });
  });
  it("writes nested effort for max and off while omitting it for automatic reasoning", () => {
    const enabled = JSON.parse(router.buildRequest(input, { ...selected, reasoning: { mode: "on", effort: "max" } }).body);
    expect(enabled.reasoning).toEqual({ effort: "xhigh" }); expect(enabled).not.toHaveProperty("reasoning_effort");
    expect(JSON.parse(router.buildRequest(input, { ...selected, reasoning: { mode: "off" } }).body).reasoning).toEqual({ effort: "none" });
    expect(JSON.parse(router.buildRequest(input, { ...selected, reasoning: { mode: "auto" } }).body)).not.toHaveProperty("reasoning");
  });
  it("accepts readable message.reasoning and ignores non-string values", () => {
    const parsed = router.parseResponse({ choices: [{ message: { content: "Agenda answer", reasoning: "Agenda reasoning" }, finish_reason: "stop" }] });
    expect(parsed.thinking).toEqual("Agenda reasoning"); expect(parsed.assistantMessage.thinking).toEqual("Agenda reasoning"); expect(parsed.text).toEqual("Agenda answer");
    expect(router.parseResponse({ choices: [{ message: { content: "Agenda answer", reasoning: { text: "private structured value" } }, finish_reason: "stop" }] }).thinking).toBeUndefined();
  });
});
