import { describe, it, expect } from "vitest";
import { FireflyStreamAccumulator } from "./accumulator";
import type { UnifiedStreamDelta } from "./types";

describe("Normalized streaming response assembly", () => {
  it("keeps reasoning and answer channels separate in snapshots and final messages", () => {
    const response = new FireflyStreamAccumulator();
    for (const [type, delta] of [["text_delta", "Next appointment"], ["reasoning_delta", "Inspect the agenda"], ["text_delta", " is Tuesday"], ["reasoning_delta", " and confirm the date"]] as const) response.apply({ type, delta });
    response.apply({ type: "finish", reason: "stop" });
    const expected = { text: "Next appointment is Tuesday", thinking: "Inspect the agenda and confirm the date", finishReason: "stop" };
    expect(response.snapshot()).toMatchObject(expected);
    expect(response.finalize({ source: "agenda-stream" })).toMatchObject({ ...expected, raw: { source: "agenda-stream" }, assistantMessage: { role: "assistant", content: expected.text, thinking: expected.thinking } });
  });

  it("assembles fragmented calls by index and returns them in index order", () => {
    const response = new FireflyStreamAccumulator();
    const deltas: UnifiedStreamDelta[] = [
      { type: "tool_call_start", index: 4, nameDelta: "agenda_" },
      { type: "tool_call_start", index: 2, id: "lookup-early", nameDelta: "lookup" },
      { type: "tool_call_start", index: 4, id: "export-later", nameDelta: "export" },
      { type: "tool_call_arguments_delta", index: 4, id: "export-later", delta: '{"file":' },
      { type: "tool_call_arguments_delta", index: 2, id: "lookup-early", delta: '{"day":"Tuesday"}' },
      { type: "tool_call_arguments_delta", index: 4, delta: '"agenda.ics"}' },
      { type: "tool_call_end", index: 4, id: "export-later" }, { type: "tool_call_end", index: 2, id: "lookup-early" },
      { type: "finish", reason: "tool_calls" },
    ];
    deltas.forEach((delta) => response.apply(delta));
    const calls = [{ id: "lookup-early", name: "lookup", arguments: '{"day":"Tuesday"}' }, { id: "export-later", name: "agenda_export", arguments: '{"file":"agenda.ics"}' }];
    expect(response.snapshot().toolCalls).toStrictEqual(calls.map((call, index) => ({ index: index ? 4 : 2, ...call, ended: true })));
    expect(response.finalize(null).toolCalls).toStrictEqual(calls);
  });

  it("rejects a different ID for an already identified call", () => {
    const response = new FireflyStreamAccumulator();
    response.apply({ type: "tool_call_start", index: 3, id: "agenda-lookup", nameDelta: "lookup" });
    expect(() => response.apply({ type: "tool_call_arguments_delta", index: 3, id: "agenda-forged", delta: "{}" })).toThrowError(expect.objectContaining({ code: "E_TOOL_CALL_ID_CHANGED", name: "ProviderProtocolError" }));
  });

  it.each(["id", "name", "json", "end"])("rejects finalization with missing or incomplete %s", (missing) => {
    const response = new FireflyStreamAccumulator();
    response.apply({ type: "tool_call_start", index: 3, ...(missing === "id" ? {} : { id: "agenda-lookup" }), ...(missing === "name" ? {} : { nameDelta: "lookup" }) });
    response.apply({ type: "tool_call_arguments_delta", index: 3, delta: missing === "json" ? '{"day":' : "{}" });
    if (missing !== "end") response.apply({ type: "tool_call_end", index: 3 });
    response.apply({ type: "finish", reason: "tool_calls" });
    expect(() => response.finalize(null)).toThrowError(expect.objectContaining({ code: "E_TOOL_CALL_INCOMPLETE", name: "ProviderProtocolError" }));
  });

  it("fills absent usage channels with zero and preserves cached input in the final result", () => {
    const response = new FireflyStreamAccumulator();
    response.apply({ type: "usage", inputTokens: 28 });
    expect(response.snapshot().usage).toEqual({ input: 28, output: 0 });
    response.apply({ type: "usage", outputTokens: 9 });
    expect(response.snapshot().usage).toEqual({ input: 28, output: 9 });
    response.apply({ type: "usage", inputTokens: 36, cachedInputTokens: 24 });
    response.apply({ type: "usage", outputTokens: 9 });
    expect(response.finalize(null).usage).toEqual({ input: 36, output: 9, cachedInput: 24 });
  });

  it("retains refusal explanations and the provider's terminal reason", () => {
    const response = new FireflyStreamAccumulator();
    response.apply({ type: "refusal", reason: "restricted content" });
    response.apply({ type: "finish", reason: "content_filter" });
    expect(response.finalize({})).toMatchObject({ refusal: "restricted content", finishReason: "content_filter" });
  });
});
