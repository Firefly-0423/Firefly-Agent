import { expect, it, describe } from "vitest";
import { AgentRuntimeError, type AgentErrorCode } from "./agent-runtime-error";

describe("Runtime failures exposed to consumers", () => {
  it.each<AgentErrorCode>([
    "E_MODEL_RESPONSE_PARSE_FAILED", "E_MODEL_HTTP_ERROR", "E_MODEL_REQUEST_TIMEOUT",
    "E_MODEL_REQUEST_FAILED", "E_AGENT_GRAPH_ITERATION_LIMIT", "E_AGENT_NO_PROGRESS",
  ])("retains the %s classification independently of its explanation", (classification) => {
    const failure = new AgentRuntimeError(classification, "Unable to complete this turn");
    expect(failure instanceof Error).toBe(true);
    expect({ name: failure.name, code: failure.code, message: failure.message }).toEqual({
      name: "AgentRuntimeError", code: classification, message: "Unable to complete this turn",
    });
  });

  it("keeps the original exception available for diagnostics", () => {
    const transportFailure = new TypeError("connection interrupted");
    const wrapped = new AgentRuntimeError("E_MODEL_REQUEST_FAILED", "Request interrupted", { cause: transportFailure });
    expect(wrapped.cause).toBe(transportFailure);
    expect(new AgentRuntimeError("E_MODEL_HTTP_ERROR", "Service unavailable").cause).toBeUndefined();
  });
});
