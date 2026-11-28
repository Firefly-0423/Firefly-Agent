import { describe, it, expect } from "vitest";
import { ResponsesAdapter, isOfficialOpenAIEndpoint, shouldIncludeEncryptedReasoning } from "./responses-adapter";
import type { ChatMessage, ChatRequest, ProviderCapability, VendorConfig } from "./types";

const provider: ProviderCapability = { id: "agenda-responses", displayName: "Agenda Responses", transport: "openai", baseUrl: "https://agenda.invalid/v1", authStyle: "bearer", defaultModel: "agenda-model", supportsTools: true, supportsThinking: false, thinkingField: null, cacheStrategy: "none", testStrategy: "text" };
const config: VendorConfig = { provider: provider.displayName, baseUrl: provider.baseUrl, model: provider.defaultModel, apiKey: "agenda-responses-key" };
const question: ChatMessage = { role: "user", content: "Read the calendar" };
function build(messages: ChatMessage[] = [question], request: Partial<ChatRequest> = {}, selected: Partial<VendorConfig> = {}, patch: Partial<ProviderCapability> = {}) {
  const cap = { ...provider, ...patch }, cfg = { ...config, ...selected };
  const http = new ResponsesAdapter(cap.id, cap).buildRequest({ model: cfg.model, messages, ...request }, cfg);
  return { ...http, body: JSON.parse(http.body) };
}

describe("Stateless Responses requests", () => {
  it("normalizes endpoint suffixes, authenticates with bearer, and maps sampling and output budget fields", () => {
    const plain = build();
    expect(plain.url).toEqual("https://agenda.invalid/v1/responses");
    expect(build([question], {}, { baseUrl: "https://agenda.invalid/v1/responses" }).url).toEqual("https://agenda.invalid/v1/responses");
    expect(plain.headers.Authorization).toEqual("Bearer agenda-responses-key");
    expect(plain.body.store).toEqual(false);
    const tuned = build([question], { maxTokens: 1536, temperature: 0.6, topP: 0.85 }).body;
    expect(tuned).toMatchObject({ max_output_tokens: 1536, temperature: 0.6, top_p: 0.85 });
    expect(tuned).not.toHaveProperty("max_tokens");
  });

  it("aggregates system instructions and converts ordered user, assistant, call and tool items", () => {
    const instructions = build([{ role: "system", content: "Calendar access rules" }, { role: "system", content: "Calendar output rules" }, question]).body;
    expect(instructions.instructions).toEqual("Calendar access rules\n\nCalendar output rules");
    expect(instructions.input).toHaveLength(1); expect(instructions.input[0].role).toEqual("user");
    expect(instructions.input[0]).toEqual({ role: "user", content: [{ type: "input_text", text: "Read the calendar" }] });
    expect(build([{ role: "user", content: [{ type: "text", text: "Inspect the calendar" }, { type: "image_url", image_url: { url: "https://agenda.invalid/calendar.png" } }] }]).body.input[0]).toEqual({ role: "user", content: [{ type: "input_text", text: "Inspect the calendar" }, { type: "input_image", image_url: "https://agenda.invalid/calendar.png" }] });
    const exchange = build([question, { role: "assistant", content: "Reading appointments", toolCalls: [{ id: "calendar-call", name: "calendar_read", arguments: '{"day":"Tuesday"}' }] }, { role: "tool", toolCallId: "calendar-call", name: "calendar_read", content: '{"available":true}' }]).body.input;
    expect(exchange[1]).toEqual({ role: "assistant", content: [{ type: "input_text", text: "Reading appointments" }] });
    expect(exchange[2]).toEqual({ type: "function_call", call_id: "calendar-call", name: "calendar_read", arguments: '{"day":"Tuesday"}' });
    expect(exchange[3]).toEqual({ type: "function_call_output", call_id: "calendar-call", output: '{"available":true}' });
  });

  it("serializes flat tool schemas and appends unified results for the next request", () => {
    const tool = { name: "calendar_read", description: "Read appointments", parameters: { type: "object" } };
    const wire = build([question], { tools: [tool] }).body.tools;
    expect(wire).toHaveLength(1); expect(wire[0]).toMatchObject({ type: "function", ...tool }); expect(wire[0]).not.toHaveProperty("function");
    const adapter = new ResponsesAdapter(provider.id, provider);
    const next = adapter.appendToolResults([], [{ toolCall: { id: "calendar-call", name: tool.name, arguments: "{}" }, output: '{"available":true}' }]);
    expect(next).toEqual([{ role: "tool", toolCallId: "calendar-call", name: "calendar_read", content: '{"available":true}' }]);
    expect(build(next).body.input[0]).toEqual({ type: "function_call_output", call_id: "calendar-call", output: '{"available":true}' });
  });
});

describe("Encrypted reasoning endpoint boundary", () => {
  it.each([
    ["https://api.openai.com", true], ["https://api.openai.com/v1", true],
    ["https://proxy.agenda.invalid/v1", false], ["https://api.openai.com.evil.invalid/v1", false], ["invalid endpoint", false],
  ])("recognizes official host %s as %s", (endpoint, expected) => expect(isOfficialOpenAIEndpoint(endpoint as string)).toEqual(expected));

  it("requires both the capability flag and official host to include encrypted reasoning", () => {
    const flagged = { ...provider, id: "chatgpt", responsesEncryptedReasoning: true };
    expect(build([question], {}, { baseUrl: "https://api.openai.com/v1" }, flagged).body.include).toEqual(["reasoning.encrypted_content"]);
    expect(build([question], {}, { baseUrl: "https://proxy.agenda.invalid/v1" }, flagged).body).not.toHaveProperty("include");
    expect(build([question], {}, { baseUrl: "https://api.openai.com/v1" }).body).not.toHaveProperty("include");
    expect(shouldIncludeEncryptedReasoning({ ...config, baseUrl: "https://api.openai.com/v1" }, flagged)).toEqual(true);
    expect(shouldIncludeEncryptedReasoning({ ...config, baseUrl: "https://api.openai.com/v1" }, provider)).toEqual(false);
    expect(shouldIncludeEncryptedReasoning({ ...config, baseUrl: "https://api.deepseek.com" }, flagged)).toEqual(false);
  });

  const reasoning = { type: "reasoning", id: "calendar-reason", summary: [{ type: "summary_text", text: "Inspecting dates" }], encrypted_content: "encrypted-calendar" };
  const message = { type: "message", id: "calendar-message", role: "assistant", content: [{ type: "output_text", text: "Tuesday is free" }] };
  const call = { type: "function_call", id: "calendar-function", call_id: "calendar-call", name: "calendar_read", arguments: "{}" };
  it("replays official encrypted reasoning, message and function call in their original order", () => {
    const items = build([question, { role: "assistant", content: "", rawAssistant: [reasoning, message, call] }, { role: "user", content: "Continue with Wednesday" }], {}, { baseUrl: "https://api.openai.com/v1" }, { id: "chatgpt", responsesEncryptedReasoning: true }).body.input;
    expect(items).toHaveLength(5);
    expect(items[1]).toMatchObject({ type: "reasoning", id: "calendar-reason" });
    expect(items[2]).toMatchObject({ type: "message", id: "calendar-message" });
    expect(items[3]).toMatchObject({ type: "function_call", call_id: "calendar-call" });
  });
  it("filters third-party reasoning, unsigned official reasoning and unknown types while preferring raw items", () => {
    const { encrypted_content: _encrypted, ...unsigned } = reasoning;
    for (const [raw, endpoint, patch] of [
      [[reasoning, message], "https://api.deepseek.com", {}],
      [[unsigned, message], "https://api.openai.com/v1", { id: "chatgpt", responsesEncryptedReasoning: true }],
      [[{ type: "unknown-calendar-item" }, message], "https://api.deepseek.com", {}],
      [[message], "https://api.deepseek.com", {}],
    ] as const) {
      const items = build([{ role: "assistant", content: "Fallback must not be replayed", rawAssistant: [...raw] }], {}, { baseUrl: endpoint }, patch).body.input;
      expect(items).toHaveLength(1); expect(items[0]).toMatchObject({ type: "message", id: "calendar-message" });
    }
  });
});

describe("Responses parsing and output controls", () => {
  const adapter = new ResponsesAdapter(provider.id, provider);
  it("extracts text, reasoning, calls, usage and refusal while retaining all output items", () => {
    const output = [{ type: "reasoning", id: "calendar-reason", summary: [{ type: "summary_text", text: "Inspecting dates" }] }, { type: "message", id: "calendar-message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Tuesday is free" }] }];
    const parsed = adapter.parseResponse({ output, status: "completed" });
    expect(parsed.text).toEqual("Tuesday is free"); expect(parsed.thinking).toEqual("Inspecting dates"); expect(parsed.refusal).toBeUndefined();
    expect(parsed.assistantMessage.rawAssistant).toEqual(output); expect(parsed.finishReason).toEqual("stop");
    const refused = adapter.parseResponse({ output: [{ type: "message", id: "calendar-refusal", role: "assistant", content: [{ type: "refusal", refusal: "Calendar is private" }] }] });
    expect(refused.text).toEqual(""); expect(refused.refusal).toEqual("Calendar is private");
    const called = adapter.parseResponse({ output: [{ type: "function_call", id: "calendar-item", call_id: "calendar-call", name: "calendar_read", arguments: '{"day":"Tuesday"}' }] });
    expect(called.toolCalls).toEqual([{ id: "calendar-call", name: "calendar_read", arguments: '{"day":"Tuesday"}' }]); expect(called.assistantMessage.toolCalls).toEqual(called.toolCalls);
    expect(adapter.parseResponse({ output: [], usage: { input_tokens: 140, output_tokens: 60, input_tokens_details: { cached_tokens: 80 } } }).usage).toEqual({ input: 140, output: 60, cachedInput: 80 });
    expect(adapter.parseResponse({ output: [], status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }).finishReason).toEqual("length");
  });
  it("maps JSON schema and object output requests to text.format", () => {
    const schema = { type: "object", properties: { day: { type: "string" } } };
    expect(build([question], { structuredOutput: { mode: "json_schema", name: "calendar_day", schema, strict: true } }).body.text).toEqual({ format: { type: "json_schema", name: "calendar_day", strict: true, schema } });
    expect(build([question], { structuredOutput: { mode: "json_object" } }).body.text).toEqual({ format: { type: "json_object" } });
  });
  it("translates effort into the Responses shape and removes other protocol controls", () => {
    const low = build([question], {}, { model: "gpt-5.1", reasoning: { mode: "on", effort: "low" } }, { id: "chatgpt" }).body;
    expect(low.reasoning).toEqual({ effort: "low" });
    for (const foreign of ["reasoning_effort", "thinking", "output_config"]) expect(low).not.toHaveProperty(foreign);
    const high = build([question], {}, { model: "gpt-5.6", reasoning: { mode: "on", effort: "high" } }, { id: "chatgpt" }).body;
    expect(high.reasoning).toEqual({ effort: "high" }); expect(high.reasoning).not.toHaveProperty("mode");
    expect(build([question], {}, { model: "MiniMax-M3", reasoning: { mode: "on" } }, { id: "minimax" }).body.reasoning).toEqual({ effort: "minimal" });
    for (const mode of ["on", "off", "auto"] as const) {
      const body = build([question], {}, { model: "MiniMax-M3", reasoning: { mode } }, { id: "minimax" }).body;
      expect(body).not.toHaveProperty("thinking");
      if (mode !== "on") expect(body).not.toHaveProperty("reasoning");
    }
  });
});
