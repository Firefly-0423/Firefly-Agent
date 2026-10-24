export type AgentErrorCode =
  | "E_MODEL_RESPONSE_PARSE_FAILED"
  | "E_MODEL_HTTP_ERROR"
  | "E_MODEL_REQUEST_TIMEOUT"
  | "E_MODEL_REQUEST_FAILED"
  | "E_AGENT_GRAPH_ITERATION_LIMIT"
  | "E_AGENT_NO_PROGRESS";

export class AgentRuntimeError extends Error {
  constructor(public readonly code: AgentErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentRuntimeError";
  }
}
