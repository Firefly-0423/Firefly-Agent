/** Public failure metadata is a finite vocabulary, never an exception message/body. */
const sources = {
 E_HARNESS_FAILURE:"runtime", E_CONTEXT_FAILURE:"context", E_TOOL_EXECUTION_FAILED:"tool",
 E_AGENT_NO_PROGRESS:"runtime", E_AGENT_GRAPH_ITERATION_LIMIT:"runtime",
 E_MODEL_REQUEST_FAILED:"model", E_MODEL_REQUEST_TIMEOUT:"model", E_MODEL_HTTP_ERROR:"model", E_MODEL_RESPONSE_PARSE_FAILED:"model",
 E_SHELL_EXIT:"tool", E_SHELL_SPAWN:"tool", E_TOOL_TIMEOUT:"tool",
 MEMORY_CONTEXT_TRANSCRIPT_SECRET:"context", MEMORY_CONTEXT_INPUT_INVALID:"context",
 MEMORY_CONTEXT_TOOL_PAIR_INVALID:"context", MEMORY_CONTEXT_CAPTURE_FAILED:"context",
 MEMORY_CONTEXT_REQUEST_CHANGED:"context", MEMORY_CONTEXT_RECENT_INCOMPLETE:"context",
 MEMORY_CONTEXT_SEND_UNKNOWN:"context", MEMORY_CONTEXT_SETTLEMENT_UNKNOWN:"context",
 MEMORY_CONTEXT_SOURCE_UNAVAILABLE:"context", MEMORY_CONTEXT_RESPONSE_FAILED:"context",
 MEMORY_CONTEXT_CANCELLED:"context",
 MEMORY_CONTEXT_BUDGET_EXCEEDED:"context", MEMORY_CONTEXT_BUDGET_UNKNOWN:"context", MEMORY_CONTEXT_BUDGET_UNPROVEN:"context",
 MEMORY_CONTEXT_RECENT_OVER_BUDGET:"context", MEMORY_CONTEXT_FIXED_OVER_BUDGET:"context", MEMORY_CONTEXT_OVER_BUDGET:"context",
 MEMORY_CONTEXT_COUNT_FAILED:"context", MEMORY_CONTEXT_COUNTER_MISMATCH:"context", MEMORY_CONTEXT_COUNTER_UNSUPPORTED:"context",
 MEMORY_SOURCE_STALE:"context",
} as const;

export type RunFailureSource = "context" | "model" | "tool" | "runtime";
export interface RunFailure { code: keyof typeof sources; source: RunFailureSource }
const fallbackCodes = {context:"E_CONTEXT_FAILURE",model:"E_MODEL_REQUEST_FAILED",tool:"E_TOOL_EXECUTION_FAILED",runtime:"E_HARNESS_FAILURE"} as const;

export function publicRunFailure(error: unknown, fallback: RunFailureSource = "runtime"): RunFailure {
 const candidate = typeof error === "object" && error !== null ? error as {code?:unknown;message?:unknown} : {};
 for (const value of [candidate.code, candidate.message]) {
  if (typeof value === "string" && Object.hasOwn(sources,value)) {
   const code=value as keyof typeof sources;
   return {code,source:sources[code]};
  }
 }
 return {code:fallbackCodes[fallback],source:fallback};
}
