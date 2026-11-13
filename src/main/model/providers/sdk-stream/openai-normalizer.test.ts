import { it, expect, describe } from "vitest";
import { normalizeOpenAIChunk as normalize } from "./openai-normalizer";

describe("Chat Completions deltas admitted to the unified stream", () => {
  it("emits answer, refusal, usage and finish in wire processing order", () => {
    expect(normalize({ choices: [{ delta: { role: "assistant", content: "Calendar ready", refusal: "Access restricted" }, finish_reason: "content_filter" }],
      usage: { prompt_tokens: 28, completion_tokens: 9, total_tokens: 37, prompt_tokens_details: { cached_tokens: 16 } },
    })).toStrictEqual([
      { type: "text_delta", delta: "Calendar ready" }, { type: "refusal", reason: "Access restricted" },
      { type: "usage", inputTokens: 28, outputTokens: 9, cachedInputTokens: 16 }, { type: "finish", reason: "content_filter" },
    ]);
    expect(normalize({ choices: [], usage: { prompt_tokens: 36, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 24 } } })).toEqual([
      { type: "usage", inputTokens: 36, outputTokens: 12, cachedInputTokens: 24 },
    ]);
  });

  it.each(["thinking", "reasoning", "reasoning_content"])("accepts readable reasoning from %s", (field) => {
    expect(normalize({ choices: [{ delta: { [field]: "Inspect the agenda" }, finish_reason: null }] })).toEqual([{ type: "reasoning_delta", delta: "Inspect the agenda" }]);
  });

  it("takes only readable reasoning details and ignores encrypted data", () => {
    expect(normalize({ choices: [{ delta: { reasoning_details: [{ type: "reasoning.text", text: "Check timezone" }, { type: "encrypted", data: "private-agenda" }] } }] })).toEqual([{ type: "reasoning_delta", delta: "Check timezone" }]);
  });

  it("preserves interleaved tool indexes, repeated IDs, and split name fragments", () => {
    expect(normalize({ choices: [{ delta: { tool_calls: [
      { index: 4, id: "export-later", type: "function", function: { name: "agenda_", arguments: '{"file":' } },
      { index: 2, id: "lookup-first", type: "function", function: { name: "lookup", arguments: '{"day":' } },
    ] }, finish_reason: null }] })).toStrictEqual([
      { type: "tool_call_start", index: 4, id: "export-later", nameDelta: "agenda_" },
      { type: "tool_call_arguments_delta", index: 4, id: "export-later", delta: '{"file":' },
      { type: "tool_call_start", index: 2, id: "lookup-first", nameDelta: "lookup" },
      { type: "tool_call_arguments_delta", index: 2, id: "lookup-first", delta: '{"day":' },
    ]);
    expect(normalize({ choices: [{ delta: { tool_calls: [
      { index: 4, id: "export-later", function: { name: "export", arguments: "" } },
      { index: 2, function: { name: "date", arguments: "{}" } },
    ] } }] })).toStrictEqual([
      { type: "tool_call_start", index: 4, id: "export-later", nameDelta: "export" },
      { type: "tool_call_start", index: 2, nameDelta: "date" }, { type: "tool_call_arguments_delta", index: 2, delta: "{}" },
    ]);
  });

  it.each([null, { choices: "invalid" }, { choices: [{ delta: { role: "assistant" }, finish_reason: null }] }])("ignores chunks with no visible payload: %j", (chunk) => {
    expect(normalize(chunk)).toStrictEqual([]);
  });
});
