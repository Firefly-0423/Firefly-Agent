// A connection failure is shown to the user only as one of these fixed reasons.
// The error text itself can echo the command line, URLs or credentials and never leaves Main.
export const MCP_FAILURE_REASONS = ["command-not-found", "permission-denied", "timeout", "exited", "unreachable", "failed"] as const;
export type McpFailureReason = typeof MCP_FAILURE_REASONS[number];

function field(error: unknown, key: string): unknown {
  return error && typeof error === "object" ? (error as Record<string, unknown>)[key] : undefined;
}

/** SDK HTTP transports expose status through status/statusCode or SseError.code. */
export function isMcpAuthFailure(error: unknown): boolean {
  return [field(error, "status"), field(error, "statusCode"), field(error, "code")]
    .some(value => value === 401 || value === 403 || value === "401" || value === "403")
    || field(error, "name") === "UnauthorizedError";
}

/** Map a connection error to a content-free reason. Unknown shapes become "failed". */
export function classifyMcpFailure(error: unknown): McpFailureReason {
  if (isMcpAuthFailure(error)) return "permission-denied";
  const code = String(field(error, "code") ?? field(field(error, "cause"), "code") ?? "");
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (code === "ENOENT" || /\bENOENT\b|is not recognized as an internal or external command|command not found/i.test(message)) return "command-not-found";
  if (code === "EACCES" || code === "EPERM" || /\bEACCES\b|\bEPERM\b|permission denied/i.test(message)) return "permission-denied";
  if (code === "ETIMEDOUT" || code === "-32001" || /timed? ?out/i.test(message)) return "timeout";
  if (/^(ECONNREFUSED|ENOTFOUND|ECONNRESET|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH)$/.test(code)
    || /\b(ECONNREFUSED|ENOTFOUND|ECONNRESET|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH)\b|fetch failed|SSE error/i.test(message)) return "unreachable";
  if (code === "-32000" || /connection closed/i.test(message)) return "exited";
  return "failed";
}
