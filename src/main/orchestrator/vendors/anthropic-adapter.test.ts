import { describe, it, expect } from "vitest";
import { AnthropicAdapter } from "./anthropic-adapter";
import type { ChatRequest, ProviderCapability, VendorConfig } from "./types";

const provider: ProviderCapability = { id: "agenda-anthropic", displayName: "Agenda messages", transport: "anthropic", baseUrl: "https://agenda.invalid/v1", authStyle: "x-api-key", defaultModel: "agenda-model", supportsTools: true, supportsThinking: true, thinkingField: "thinking", cacheStrategy: "cache_control", testStrategy: "text" };
const selected: VendorConfig = { provider: provider.displayName, baseUrl: provider.baseUrl, model: provider.defaultModel, apiKey: "agenda-messages-key" };
const request: ChatRequest = { model: "agenda-model", messages: [{ role: "user", content: "Read Tuesday's calendar" }] };
const tool = { name: "calendar_read", description: "Read appointments", parameters: { type: "object" } };
function create(patch: Partial<ProviderCapability> = {}) { const cap = { ...provider, ...patch }; return new AnthropicAdapter(cap.id, cap); }
function wire(req: Partial<ChatRequest> = {}, cfg: Partial<VendorConfig> = {}, cap: Partial<ProviderCapability> = {}) { return JSON.parse(create(cap).buildRequest({ ...request, ...req }, { ...selected, ...cfg }).body); }

describe("Anthropic request shapes and selection policies", () => {
  it("uses the Anthropic schema format and omits invented prompt-JSON fields", () => {
    const schema = { type: "object", properties: { slot: { type: "string", enum: ["morning"] } }, required: ["slot"], additionalProperties: false };
    expect(wire({ maxTokens: 256, structuredOutput: { mode: "json_schema", name: "calendar_slot", schema, strict: true } }).output_config).toEqual({ format: { type: "json_schema", schema } });
    expect(wire({ structuredOutput: { mode: "prompt_json", sendJsonObjectHint: false } }).output_config).toBeUndefined();
  });
  it("uses automatic optional calling and downgrades must-call while thinking may be enabled", () => {
    expect(wire({ tools: [tool] }).tool_choice).toEqual({ type: "auto" });
    const must = { tools: [tool], toolChoiceIntent: { mode: "must_call" as const, toolName: "calendar_read" } };
    const cfg = { model: "claude-sonnet-4-6" }, cap = { id: "claude" };
    expect(wire(must, { ...cfg, reasoning: { mode: "off" } }, cap).tool_choice).toEqual({ type: "tool", name: "calendar_read" });
    expect(wire(must, cfg, cap).tool_choice).toEqual({ type: "auto" });
    expect(wire(must, { ...cfg, reasoning: { mode: "on", effort: "high" } }, cap).tool_choice).toEqual({ type: "auto" });
    expect(wire(must, { reasoning: { mode: "off" } }, { id: "required-only", toolChoiceModes: ["required"] }).tool_choice).toEqual({ type: "any" });
  });
  it.each(["x-api-key", "bearer"] as const)("keeps Anthropic version metadata with %s authentication", (authStyle) => {
    const headers = create({ authStyle, ...(authStyle === "bearer" ? { id: "mimo" } : {}) }).buildRequest(request, selected).headers;
    expect(headers[authStyle === "bearer" ? "Authorization" : "x-api-key"]).toEqual(authStyle === "bearer" ? "Bearer agenda-messages-key" : "agenda-messages-key");
    expect(headers[authStyle === "bearer" ? "x-api-key" : "Authorization"]).toBeUndefined();
    expect(headers["anthropic-version"]).toBeDefined();
  });
});

describe("Anthropic response channels and canonical replay", () => {
  const adapter = create();
  const stream = (eventType: string, payload: unknown) => adapter.parseStreamEvent({ eventType, data: JSON.stringify(payload) });
  it("keeps thinking and text deltas separate and accepts data-only typed events", () => {
    expect(stream("content_block_delta", { delta: { type: "thinking_delta", thinking: "Check the agenda" } })).toEqual({ deltaThinking: "Check the agenda" });
    expect(stream("content_block_delta", { delta: { type: "text_delta", text: "Tuesday is free" } })).toEqual({ deltaText: "Tuesday is free" });
    expect(stream("data", { type: "content_block_delta", delta: { type: "text_delta", text: "Compatible calendar stream" } })?.deltaText).toEqual("Compatible calendar stream");
    expect(stream("error", { type: "error", error: { message: "Calendar overloaded" } })?.error).toEqual("Calendar overloaded");
  });
  it("reads usage at start and finish even when only output usage arrives at the end", () => {
    expect(stream("message_start", { message: { usage: { input_tokens: 28, output_tokens: 0, cache_read_input_tokens: 16 } } })?.usage).toEqual({ input: 28, output: 0, cachedInput: 16 });
    expect(stream("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } })).toMatchObject({ finishReason: "end_turn", usage: { input: 0, output: 9 } });
  });
  it("parses all canonical blocks and replays signed assistant content in order across a tool result", () => {
    const blocks = [
      { type: "thinking", thinking: "Check Tuesday", signature: "agenda-signed-proof" },
      { type: "text", text: "Reading your calendar" }, { type: "tool_use", id: "calendar-call", name: "calendar_read", input: { day: "Tuesday" } },
    ];
    const expectedBlocks = structuredClone(blocks);
    const parsed = adapter.parseResponse({ stop_reason: "tool_use", content: blocks });
    expect(parsed.thinking).toEqual("Check Tuesday"); expect(parsed.text).toEqual("Reading your calendar");
    expect(parsed.toolCalls).toEqual([{ id: "calendar-call", name: "calendar_read", arguments: '{"day":"Tuesday"}' }]);
    expect(parsed.finishReason).toEqual("tool_calls");
    const appended = adapter.appendToolResults([
      { role: "user", content: "Read Tuesday" }, { role: "assistant", content: undefined, rawAssistant: blocks }, { role: "user", content: "And Wednesday?" },
    ], [{ toolCall: parsed.toolCalls[0], output: "09:30 dentist" }]);
    const messages = wire({ messages: appended }).messages;
    expect(messages).toHaveLength(4);
    expect(messages[0]).toEqual({ role: "user", content: "Read Tuesday" });
    expect(messages[1].role).toEqual("assistant"); expect(Array.isArray(messages[1].content)).toEqual(true); expect(messages[1].content).toEqual(expectedBlocks);
    expect(messages[2]).toEqual({ role: "user", content: "And Wednesday?" });
    expect(messages[3].role).toEqual("user"); expect(Array.isArray(messages[3].content)).toEqual(true);
    expect(messages[3].content).toEqual([{ type: "tool_result", tool_use_id: "calendar-call", content: "09:30 dentist" }]);
  });
});

describe("Anthropic explicit prefix caching", () => {
  it("marks the last two messages and system without changing earlier history", () => {
    const body = wire({ model: "claude-sonnet-4-6", messages: [{ role: "system", content: "Calendar rules" }, { role: "user", content: "Read Monday" }, { role: "assistant", content: "Monday is full" }, { role: "user", content: "Read Tuesday" }] }, { model: "claude-sonnet-4-6" }, { id: "claude" });
    expect(body.system).toEqual([{ type: "text", text: "Calendar rules", cache_control: { type: "ephemeral" } }]);
    expect(body.messages[0].content).toEqual("Read Monday");
    expect(body.messages[1].content[0].cache_control).toEqual({ type: "ephemeral" });
    expect(body.messages[2].content).toEqual([{ type: "text", text: "Read Tuesday", cache_control: { type: "ephemeral" } }]);
  });
  it("marks tool results and copied assistant blocks without mutating persisted raw content", () => {
    const adapter = create({ id: "claude" }), rawAssistant: Array<Record<string, unknown>> = [{ type: "text", text: "Reading calendar" }, { type: "tool_use", id: "calendar-call", name: "calendar_read", input: { day: "Tuesday" } }];
    const messages = adapter.appendToolResults([{ role: "user", content: "Read Tuesday" }, { role: "assistant", rawAssistant }], [{ toolCall: { id: "calendar-call", name: "calendar_read", arguments: "{}" }, output: "09:30 dentist" }]);
    const body = JSON.parse(adapter.buildRequest({ ...request, model: "claude-sonnet-4-6", messages }, { ...selected, model: "claude-sonnet-4-6" }).body);
    expect(body.messages[2].content).toEqual([{ type: "tool_result", tool_use_id: "calendar-call", content: "09:30 dentist", cache_control: { type: "ephemeral" } }]);
    expect(body.messages[1].content.at(-1).cache_control).toEqual({ type: "ephemeral" });
    expect(rawAssistant[1].cache_control).toBeUndefined();
  });
  it("uses explicit message breakpoints for MiniMax M2.7 and leaves M3 messages unchanged", () => {
    expect(wire({ model: "MiniMax-M2.7" }, { model: "MiniMax-M2.7" }, { id: "minimax" }).messages[0].content).toEqual([{ type: "text", text: "Read Tuesday's calendar", cache_control: { type: "ephemeral" } }]);
    expect(wire({ model: "MiniMax-M3" }, { model: "MiniMax-M3" }, { id: "minimax" }).messages[0]).toEqual({ role: "user", content: "Read Tuesday's calendar" });
  });
});

describe("Anthropic multimodal input conversion", () => {
  const image = (url: string) => ({ type: "image_url" as const, image_url: { url } });
  const content = (blocks: ChatRequest["messages"][number]["content"]) => wire({ messages: [{ role: "user", content: blocks }] }).messages[0].content;
  it("maps PNG and remote URL images to the supported source representations", () => {
    expect(content([image("data:image/png;base64,YWdlbmRh")])).toEqual([{ type: "image", source: { type: "base64", media_type: "image/png", data: "YWdlbmRh" } }]);
    expect(content([image("https://agenda.invalid/calendar.png")])).toEqual([{ type: "image", source: { type: "url", url: "https://agenda.invalid/calendar.png" } }]);
  });
  it("downgrades unsupported MIME while preserving text and JPEG block order", () => {
    const unsupported = content([image("data:image/bmp;base64,YWc=")]);
    expect(unsupported[0].type).toEqual("text"); expect(unsupported[0].text).toContain("image/bmp");
    expect(content([{ type: "text", text: "Inspect the calendar" }, image("data:image/jpeg;base64,Y2Fs")])).toEqual([{ type: "text", text: "Inspect the calendar" }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "Y2Fs" } }]);
    expect(content([image("data:image/webp;base64,V0VCUA=="), image("data:image/gif;base64,R0lG")]).map((block: { type: string }) => block.type)).toEqual(["image", "image"]);
  });
});
