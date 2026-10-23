import { describe, it, expect } from "vitest";
import { normalizeToolExecutionOutcome as normalize } from "./tool-outcome-normalizer";
import type { ToolExecutionOutcome } from "../../types";

describe("execution completion flags", () => {
  it.each(["succeeded", "failed"] as const)("makes a %s result final unless told otherwise", (status) => {
    const input: ToolExecutionOutcome = { status, output: "finished request" };
    expect(normalize(input)).toEqual({ ...input, terminal: true, retryable: false });
    expect(input).toEqual({ status, output: "finished request" });
  });

  it("retains a parameter failure and its diagnostic", () => {
    expect(normalize({ status: "failed", output: "E_TOOL_ARGS_INVALID", errorCode: "E_TOOL_ARGS_INVALID" }))
      .toEqual({ status: "failed", output: "E_TOOL_ARGS_INVALID", errorCode: "E_TOOL_ARGS_INVALID", terminal: true, retryable: false });
  });

  it("lets a successful listener remain open", () => {
    expect(normalize({ status: "succeeded", output: "subscription active", terminal: false }))
      .toEqual({ status: "succeeded", output: "subscription active", terminal: false, retryable: false });
  });

  it("allows an explicit retry without replacing failure metadata", () => {
    const result = normalize({ status: "failed", output: "upstream did not respond", errorCode: "E_NETWORK_TIMEOUT", retryable: true });
    expect(result).toEqual({ status: "failed", output: "upstream did not respond", errorCode: "E_NETWORK_TIMEOUT", retryable: true, terminal: true });
    expect(normalize({ status: "failed", output: "diagnostic body", errorCode: "E_X" }))
      .toEqual({ status: "failed", output: "diagnostic body", errorCode: "E_X", terminal: true, retryable: false });
  });
});
