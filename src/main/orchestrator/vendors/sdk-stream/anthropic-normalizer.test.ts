import { describe, it, expect, vi } from "vitest";
import { AnthropicEventNormalizer, reconcileAnthropicTerminal } from "./anthropic-normalizer";
import { AnthropicAdapter } from "../anthropic-adapter";
import type { ProviderCapability } from "../types";
import type { StreamAccumulatorSnapshot } from "./types";

const provider: ProviderCapability = { id: "claude", displayName: "Calendar Claude", transport: "anthropic", baseUrl: "https://calendar.invalid", authStyle: "x-api-key", defaultModel: "calendar-model", supportsTools: true, supportsThinking: true, thinkingField: "thinking", cacheStrategy: "cache_control", testStrategy: "text" };
const adapter = () => new AnthropicAdapter("claude", provider);

describe("Anthropic live event normalization", () => {
  it("emits readable reasoning and text while suppressing signatures", () => {
    const stream = new AnthropicEventNormalizer();
    expect(stream.normalize({ type: "content_block_start", index: 3, content_block: { type: "thinking", thinking: "" } })).toEqual([]);
    expect(stream.normalize({ type: "content_block_delta", index: 3, delta: { type: "thinking_delta", thinking: "Check the schedule" } })).toEqual([{ type: "reasoning_delta", delta: "Check the schedule" }]);
    expect(stream.normalize({ type: "content_block_delta", index: 3, delta: { type: "signature_delta", signature: "calendar-private-signature" } })).toEqual([]);
    expect(stream.normalize({ type: "content_block_start", index: 4, content_block: { type: "text", text: "" } })).toEqual([]);
    expect(stream.normalize({ type: "content_block_delta", index: 4, delta: { type: "text_delta", text: "Tuesday is available" } })).toEqual([{ type: "text_delta", delta: "Tuesday is available" }]);
  });

  it("preserves fragmented tool JSON and closes the same tool identity", () => {
    const stream = new AnthropicEventNormalizer();
    expect(stream.normalize({ type: "content_block_start", index: 5, content_block: { type: "tool_use", id: "agenda-read", name: "calendar_read", input: {} } })).toEqual([{ type: "tool_call_start", index: 5, id: "agenda-read", nameDelta: "calendar_read" }]);
    for (const fragment of ['{"day":', '"Tuesday"}']) expect(stream.normalize({ type: "content_block_delta", index: 5, delta: { type: "input_json_delta", partial_json: fragment } })).toEqual([{ type: "tool_call_arguments_delta", index: 5, id: "agenda-read", delta: fragment }]);
    expect(stream.normalize({ type: "content_block_stop", index: 5 })).toEqual([{ type: "tool_call_end", index: 5, id: "agenda-read" }]);
  });

  it("keeps partial usage partial and emits usage before finish", () => {
    const stream = new AnthropicEventNormalizer();
    expect(stream.normalize({ type: "message_start", message: { usage: { input_tokens: 28, output_tokens: 0, cache_read_input_tokens: 16 } } })).toStrictEqual([{ type: "usage", inputTokens: 28, outputTokens: 0, cachedInputTokens: 16 }]);
    expect(stream.normalize({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } })).toEqual([{ type: "usage", outputTokens: 9 }, { type: "finish", reason: "end_turn" }]);
    expect(stream.normalize({ type: "message_stop" })).toStrictEqual([]);
  });
});

describe("SDK terminal authority over live Anthropic text", () => {
  it("compares canonical arguments and retains signed original content without diagnostics", () => {
    const terminal = { stop_reason: "tool_use", usage: { input_tokens: 28, output_tokens: 9 }, content: [
      { type: "thinking", thinking: "Check the schedule", signature: "agenda-signature" },
      { type: "text", text: "Reading your calendar" }, { type: "tool_use", id: "agenda-read", name: "calendar_read", input: { day: "Tuesday" } },
    ] };
    const live: StreamAccumulatorSnapshot = { text: "Reading your calendar", thinking: "Check the schedule", toolCalls: [{ index: 5, id: "agenda-read", name: "calendar_read", arguments: '{"day": "Tuesday"}', ended: true }], finishReason: "tool_use", usage: { input: 28, output: 9 } };
    const diagnostics = vi.fn();
    const response = reconcileAnthropicTerminal(live, terminal, adapter(), diagnostics);
    expect(response.assistantMessage.rawAssistant).toStrictEqual(terminal.content);
    expect(response.toolCalls).toStrictEqual([{ id: "agenda-read", name: "calendar_read", arguments: '{"day":"Tuesday"}' }]);
    expect(diagnostics).not.toHaveBeenCalled();
  });

  it("reports mismatch metadata without exposing either stream's content", () => {
    const diagnostics = vi.fn();
    const response = reconcileAnthropicTerminal({ text: "live-calendar-secret", thinking: "live-calendar-private-reasoning", toolCalls: [] }, {
      stop_reason: "end_turn", content: [{ type: "thinking", thinking: "final-calendar-reasoning", signature: "agenda-signature" }, { type: "text", text: "final-calendar-answer" }],
    }, adapter(), diagnostics);
    expect(response.text).toEqual("final-calendar-answer");
    expect(diagnostics).toHaveBeenCalledOnce();
    const report = JSON.stringify(diagnostics.mock.calls[0][0]);
    expect(report).toContain("E_STREAM_TERMINAL_MISMATCH");
    expect(report).toContain("text_length");
    expect(report).not.toContain("live-calendar");
    expect(report).not.toContain("final-calendar-answer");
  });

  it("rejects terminal tool blocks lacking a usable identity", () => {
    expect(() => reconcileAnthropicTerminal({ text: "", toolCalls: [] }, { stop_reason: "tool_use", content: [{ type: "tool_use", id: "", name: "calendar_read", input: { day: "Tuesday" } }] }, adapter())).toThrowError(expect.objectContaining({ code: "E_TOOL_CALL_INCOMPLETE" }));
  });
});
