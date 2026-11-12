import { describe, expect, it } from "vitest";
import { normalizeFinishReason } from "./finish-reason";

describe("Provider termination vocabulary", () => {
  const vocabulary = {
    truncated: ["length", "max_tokens"],
    tool_call: ["tool_use", "tool_calls"],
    complete: ["stop_sequence", "stop", "end_turn"],
    refused: ["refusal"],
    content_filtered: ["content_filter"],
    unknown: [undefined, "pause_turn", "vendor_extension", "", "STOP"],
  };
  for (const [category, reasons] of Object.entries(vocabulary)) {
    it(`classifies every ${category} spelling without accepting case variants`, () => {
      expect(reasons.map(normalizeFinishReason)).toStrictEqual(reasons.map(() => category));
    });
  }
});
