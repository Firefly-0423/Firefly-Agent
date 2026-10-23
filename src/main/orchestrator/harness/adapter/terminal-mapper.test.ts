import { describe, expect, it } from "vitest";
import { mapTerminateReason, mapTerminateReasonToTerminal } from "./terminal-mapper";

describe("Public run termination", () => {
  it("preserves legacy completion reasons for every termination path", () => {
    expect([undefined, "error", "max_rounds", "cancelled", "timeout"].map(
      reason => mapTerminateReason(reason as Parameters<typeof mapTerminateReason>[0]),
    )).toEqual(["no_tool", "tool_error", "max_rounds", "no_tool", "timeout"]);
  });

  it("reports the canonical failure status and possible continuing effects", () => {
    expect((["cancelled", "error", "timeout", "max_rounds"] as const).map(reason => mapTerminateReasonToTerminal(reason))).toStrictEqual([
      { reason: "user_cancelled", status: "cancelled", externalEffectsMayContinue: true },
      { reason: "E_HARNESS_FAILURE", status: "runtime_error", externalEffectsMayContinue: true },
      { reason: "timeout", status: "timeout", externalEffectsMayContinue: true },
      { reason: "max_rounds", status: "timeout", externalEffectsMayContinue: true },
    ]);
  });

  it("carries a safe context error through to the public result", () => {
    expect(mapTerminateReasonToTerminal("error", true, { code: "MEMORY_CONTEXT_TRANSCRIPT_SECRET", source: "context" })).toStrictEqual({
      errorSource: "context", externalEffectsMayContinue: true, status: "runtime_error", reason: "MEMORY_CONTEXT_TRANSCRIPT_SECRET",
    });
  });

  it("keeps natural completion successful while exposing outstanding uncertainty", () => {
    expect([false, true].map(uncertain => mapTerminateReasonToTerminal(undefined, uncertain))).toStrictEqual([
      { externalEffectsMayContinue: false, status: "success" },
      { externalEffectsMayContinue: true, status: "success" },
    ]);
  });
});
