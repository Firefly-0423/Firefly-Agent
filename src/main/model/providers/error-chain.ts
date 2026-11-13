/**
 * Class names, HTTP statuses and system error codes along an error's cause chain.
 * A provider error's `code` comes from the response body, so it is never logged; only
 * Node-style socket codes (ECONNRESET, UND_ERR_SOCKET) are.
 */
export function causeCodes(error: unknown): string {
  const parts: string[] = [];
  for (let cause = error, depth = 0; cause && typeof cause === "object" && depth < 6; cause = (cause as { cause?: unknown }).cause, depth++) {
    const { name, code, status } = cause as { name?: unknown; code?: unknown; status?: unknown };
    const label = [
      typeof name === "string" && /^[A-Z][A-Za-z]{0,40}$/.test(name) ? name : undefined,
      typeof status === "number" ? status : typeof code === "string" && /^(E[A-Z0-9_]{2,30}|UND_ERR_[A-Z_]{2,40})$/.test(code) ? code : undefined,
    ].filter(value => value !== undefined).join(":");
    if (label) parts.push(label);
  }
  return parts.join(" <- ");
}
