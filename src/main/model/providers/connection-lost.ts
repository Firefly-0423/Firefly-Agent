const CONNECTION_LOST_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "EPIPE", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN",
  "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_CLOSED"]);
/** A transport-level failure somewhere along the cause chain; an HTTP error from the provider never matches. */
export function connectionLost(error: unknown): boolean {
  for (let cause = error, depth = 0; cause && typeof cause === "object" && depth < 6; cause = (cause as { cause?: unknown }).cause, depth++) {
    const { code, status } = cause as { code?: unknown; status?: unknown };
    if (typeof status === "number") return false;
    if (typeof code === "string" && CONNECTION_LOST_CODES.has(code)) return true;
  }
  return false;
}
