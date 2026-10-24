import { describe, it, expect } from "vitest";
import { normalizeResponsesEvent as normalize } from "./responses-normalizer";
import { ProviderProtocolError } from "./types";

describe("Responses events admitted to the unified stream", () => {
  it.each([
    ["response.output_text.delta", { delta: "Agenda ready" }, { type: "text_delta", delta: "Agenda ready" }],
    ["response.reasoning_text.delta", { delta: "Read the agenda" }, { type: "reasoning_delta", delta: "Read the agenda" }],
    ["response.reasoning_summary_text.delta", { delta: "Check the timezone" }, { type: "reasoning_delta", delta: "Check the timezone" }],
    ["response.refusal.delta", { delta: "Access denied" }, { type: "refusal", reason: "Access denied" }],
    ["response.refusal.done", { refusal: "Calendar is private" }, { type: "refusal", reason: "Calendar is private" }],
  ])("maps %s without mixing channels", (type, payload, expected) => {
    expect(normalize({ type, ...payload })).toStrictEqual([expected]);
  });

  it("opens and closes tool calls using output indexes without replaying complete arguments", () => {
    expect(normalize({ type: "response.output_item.added", output_index: 4, item: { type: "function_call", call_id: "agenda-lookup", name: "calendar_read" } })).toEqual([{ type: "tool_call_start", index: 4, id: "agenda-lookup", nameDelta: "calendar_read" }]);
    expect(normalize({ type: "response.function_call_arguments.delta", output_index: 4, delta: '{"day"' })).toEqual([{ type: "tool_call_arguments_delta", index: 4, delta: '{"day"' }]);
    expect(normalize({ type: "response.function_call_arguments.done", output_index: 4, arguments: '{"day":"Tuesday"}' })).toEqual([{ type: "tool_call_end", index: 4 }]);
    expect(normalize({ type: "response.output_item.done", output_index: 4, item: { type: "function_call", call_id: "agenda-lookup", name: "calendar_read", arguments: "{}" } })).toEqual([{ type: "tool_call_end", index: 4, id: "agenda-lookup" }]);
    expect(normalize({ type: "response.output_item.added", output_index: 1, item: { type: "message" } })).toEqual([]);
  });

  it("places usage before a completed or incomplete terminal reason", () => {
    expect(normalize({ type: "response.completed", response: { output: [], usage: { input_tokens: 28, output_tokens: 9, input_tokens_details: { cached_tokens: 16 } } } })).toStrictEqual([
      { type: "usage", inputTokens: 28, outputTokens: 9, cachedInputTokens: 16 }, { type: "finish", reason: "stop" },
    ]);
    expect(normalize({ type: "response.incomplete", response: { output: [], incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 36, output_tokens: 12 } } })).toStrictEqual([
      { type: "usage", inputTokens: 36, outputTokens: 12 }, { type: "finish", reason: "length" },
    ]);
    expect(normalize({ type: "response.incomplete", response: { output: [], incomplete_details: { reason: "content_filter" } } })).toEqual([{ type: "finish", reason: "content_filter" }]);
    expect(normalize({ type: "response.incomplete", response: {} })).toEqual([{ type: "finish", reason: "incomplete" }]);
  });

  it("throws protocol errors carrying upstream failure text and supplies an error fallback", () => {
    const failed = () => normalize({ type: "response.failed", response: { error: { message: "Agenda server unavailable" } } });
    expect(failed).toThrowError(ProviderProtocolError);
    expect(failed).toThrowError("Agenda server unavailable");
    expect(() => normalize({ type: "error", message: "Calendar permission denied" })).toThrowError(ProviderProtocolError);
    expect(() => normalize({ type: "error" })).toThrowError("Responses stream returned an error event");
  });

  it.each([
    null, 84, "response.output_text.delta", { delta: "untyped" },
    { type: "response.created" }, { type: "response.in_progress" }, { type: "response.reasoning_summary_part.added" },
    { type: "response.output_text.done", text: "Agenda ready" },
  ])("ignores non-delta or malformed input %j", (event) => expect(normalize(event)).toEqual([]));
});
