import { type RunFailure, publicRunFailure } from "../../../../shared/run-failure";
import type { FireflyRunTerminalResult } from "../../../../shared/run-terminal";

export type HarnessTerminateReason = undefined | "error" | "cancelled" | "timeout" | "max_rounds";

export function mapTerminateReason(
  termination: HarnessTerminateReason,
): "no_tool" | "timeout" | "max_rounds" | "tool_error" {
  if (termination === "max_rounds") return "max_rounds";
  if (termination === "timeout") return "timeout";
  return termination === "error" ? "tool_error" : "no_tool";
}

export function mapTerminateReasonToTerminal(
  termination: HarnessTerminateReason,
  uncertain: boolean = false,
  diagnostic?: RunFailure,
): FireflyRunTerminalResult {
  if (termination === "timeout" || termination === "max_rounds") {
    return { status: "timeout", reason: termination, externalEffectsMayContinue: true };
  }
  if (termination === "cancelled") {
    return { status: "cancelled", reason: "user_cancelled", externalEffectsMayContinue: true };
  }
  if (termination !== "error") {
    return { status: "success", externalEffectsMayContinue: uncertain };
  }
  if (!diagnostic) {
    return { status: "runtime_error", reason: "E_HARNESS_FAILURE", externalEffectsMayContinue: true };
  }
  const exposed = publicRunFailure(diagnostic);
  return {
    status: "runtime_error", reason: exposed.code,
    errorSource: exposed.source, externalEffectsMayContinue: true,
  };
}
