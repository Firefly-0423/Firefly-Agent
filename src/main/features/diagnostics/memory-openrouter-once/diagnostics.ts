/** Only closed reason codes and bounded status numbers cross the diagnostic boundary. */
const stages = {
  ADMISSION_REFUSED: "admission", PROFILE_REFUSED: "profile", PERMIT_EXPIRED: "admission",
  NETWORK_FAILED: "network", HTTP_REJECTED: "http", BODY_MISSING: "body",
  BODY_TOO_LARGE: "body", BODY_READ_FAILED: "body", BODY_LENGTH_INVALID: "body",
  JSON_INVALID: "json", ENVELOPE_INVALID: "response", IDENTITY_MISMATCH: "identity",
  USAGE_INVALID: "usage", BILLING_SOURCE_INVALID: "cost", COST_INVALID: "cost",
  DEADLINE_EXCEEDED: "network", CANCELLED: "admission", STORAGE_FAILED: "storage", INTERNAL_FAILURE: "internal",
} as const;
export type FailureCode = keyof typeof stages;
export type FailureStage = typeof stages[FailureCode];
export interface SafeFailure { code: FailureCode; stage: FailureStage; httpStatus?: number; }
export function safeFailure(code: FailureCode, httpStatus?: unknown, during?: FailureStage): SafeFailure {
  const stage = (code === "DEADLINE_EXCEEDED" || code === "CANCELLED") && during ? during : stages[code];
  return { code, stage, ...(typeof httpStatus === "number" && Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? { httpStatus } : {}) };
}
export function projectFailure(value: unknown): SafeFailure | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.code !== "string" || !Object.prototype.hasOwnProperty.call(stages, raw.code)) return undefined;
  const during = typeof raw.stage === "string" && Object.values(stages).includes(raw.stage as FailureStage) ? raw.stage as FailureStage : undefined;
  return safeFailure(raw.code as FailureCode, raw.httpStatus, during);
}
