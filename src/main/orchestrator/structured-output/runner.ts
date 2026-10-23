import type { StructuredErrorDisposition, StructuredValidationError } from "./errors";
import type { RecordStructuredOutputMetric } from "./metrics";
import type { StructuredOutputMode, StructuredOutputProfile, StructuredOutputStage } from "./types";
import { normalizeFinishReason } from "./finish-reason";
import { extractJsonCandidates } from "./json-candidates";
import { getTimeoutSettings } from "../../timeout-manager";
import { resolveModelRequestTimeoutMs, resolveTotalBudgetMs } from "../config/model-timeout";

export type StructuredGenerationResponse = {
  structuredValue?: unknown;
  refusal?: string;
  finishReason?: string;
  text: string;
};
export type StructuredRepairContext = {
  errors: StructuredValidationError[];
  minimal: boolean;
  attempt: number;
};
export type BusinessValidationResult<T> =
  | { value: T; status: "accepted" }
  | { error: StructuredValidationError; status: "rejected" };
export type StructuredOutputRunInput<T, TRequest> = {
  recordMetric?: RecordStructuredOutputMetric;
  now?: () => number;
  signal?: AbortSignal;
  validateBusiness: (value: T) => BusinessValidationResult<T>;
  parseSchema: (value: unknown) => T;
  generate: (request: TRequest, signal: AbortSignal) => Promise<StructuredGenerationResponse>;
  buildRequest: (context: StructuredRepairContext) => TRequest;
  profile: StructuredOutputProfile;
  stage: StructuredOutputStage;
};
export type StructuredOutputRunResult<T> =
  | { repairCount: number; attempts: number; mode: StructuredOutputMode; value: T; outcome: "success" }
  | { failure: { toolExecuted: false; attempts: number; disposition: StructuredErrorDisposition;
      code: string; stage: StructuredOutputStage }; outcome: "failure" };

function repairIssue(layer: StructuredValidationError["layer"], code: string): StructuredValidationError {
  return { layer, code, disposition: "repair" };
}
function requestFailure(cause: unknown, aborted: boolean): string {
  if (cause instanceof Error && cause.message === "STRUCTURED_OUTPUT_TIMEOUT") return "MODEL_REQUEST_TIMEOUT";
  if (cause instanceof Error && cause.name === "AbortError") return "MODEL_REQUEST_TIMEOUT";
  if (aborted) return "MODEL_REQUEST_TIMEOUT";
  if (cause instanceof Error) {
    if ("status" in cause && typeof cause.status === "number") return "MODEL_HTTP_ERROR";
    if ("statusCode" in cause && typeof cause.statusCode === "number") return "MODEL_HTTP_ERROR";
    if (cause.message.startsWith("E_MODEL_REQUEST_FAILED")) return "MODEL_HTTP_ERROR";
  }
  return cause instanceof SyntaxError ? "MODEL_RESPONSE_PARSE_FAILED" : "MODEL_REQUEST_FAILED";
}

export async function runStructuredOutput<T, TRequest>(
  input: StructuredOutputRunInput<T, TRequest>,
): Promise<StructuredOutputRunResult<T>> {
  const readTime = input.now ?? Date.now;
  const began = readTime();
  let selected = input.profile.repair[input.stage];
  let calls = 0;
  let repairsMade = 0;
  let issues: StructuredValidationError[] = [];
  let completion = "unknown";
  let proposed = 0;
  let conforming = 0;
  const settings = getTimeoutSettings();
  const requestLimit = resolveModelRequestTimeoutMs(settings);
  const overallLimit = resolveTotalBudgetMs(requestLimit, selected.maxAttempts);
  selected = { ...selected };
  selected.perAttemptTimeoutMs = requestLimit;
  selected.totalBudgetMs = overallLimit;
  console.log(`[StructuredOutput] stage=${input.stage} perAttempt=${requestLimit}ms totalBudget=${overallLimit}ms maxAttempts=${selected.maxAttempts}`);
  if (settings.profileMinimumRemainingBudgetMs !== -1) {
    selected.minimumRemainingBudgetMs = settings.profileMinimumRemainingBudgetMs;
  }

  const record = (outcome: StructuredOutputRunResult<T>, code?: string): StructuredOutputRunResult<T> => {
    input.recordMetric?.({
      stage: input.stage, mode: input.profile.mode, attempts: calls, repairCount: repairsMade,
      finishReason: completion, candidateCount: proposed, validCandidateCount: conforming,
      finalOutcome: outcome.outcome, ...(code ? { validationFailureCode: code } : {}),
      totalDurationMs: Math.max(0, readTime() - began),
    });
    return outcome;
  };
  const reject = (code: string, disposition: StructuredErrorDisposition): StructuredOutputRunResult<T> =>
    record({ outcome: "failure", failure: {
      stage: input.stage, code, disposition, attempts: calls, toolExecuted: false,
    } }, code);

  for (;;) {
    if (input.signal?.aborted) return reject("CANCELLED", "fail_closed");
    const left = selected.totalBudgetMs - (readTime() - began);
    if (left < selected.minimumRemainingBudgetMs) return reject("INSUFFICIENT_REPAIR_BUDGET", "fail_closed");
    const payload = input.buildRequest({ attempt: repairsMade, minimal: repairsMade >= 2, errors: issues });
    const cancellation = new AbortController();
    const relay = () => cancellation.abort(input.signal?.reason);
    input.signal?.addEventListener("abort", relay, { once: true });
    const limit = Math.min(selected.perAttemptTimeoutMs, left);
    let alarm: ReturnType<typeof setTimeout> | undefined;
    let generated: StructuredGenerationResponse;
    const callBegan = readTime();
    calls++;
    try {
      generated = await Promise.race([
        input.generate(payload, cancellation.signal),
        new Promise<never>((_done, fail) => {
          alarm = setTimeout(() => {
            cancellation.abort();
            fail(new Error("STRUCTURED_OUTPUT_TIMEOUT"));
          }, limit);
        }),
      ]);
    } catch (cause) {
      const duration = readTime() - callBegan;
      const name = cause instanceof Error ? cause.name : typeof cause;
      const message = cause instanceof Error ? cause.message : String(cause);
      const cancelled = cancellation.signal.aborted;
      const code = requestFailure(cause, cancelled);
      console.error("[StructuredOutput] request failed", {
        stage: input.stage, errorCode: code, errorName: name, errorMessage: message.slice(0, 200),
        elapsedMs: duration, timeoutMs: limit, aborted: cancelled, attempt: calls,
      });
      return reject(code, "fail_closed");
    } finally {
      if (alarm) clearTimeout(alarm);
      input.signal?.removeEventListener("abort", relay);
    }

    if (generated.refusal) return reject("REFUSED", "fail_closed");
    const reason = normalizeFinishReason(generated.finishReason);
    completion = reason;
    const terminalCode = {
      content_filtered: "CONTENT_FILTERED", refused: "REFUSED",
      tool_call: "UNEXPECTED_TOOL_CALL", unknown: "UNKNOWN_FINISH_REASON",
    }[reason as "content_filtered" | "refused" | "tool_call" | "unknown"];
    if (terminalCode) return reject(terminalCode, "fail_closed");
    if (reason === "truncated") {
      issues = [repairIssue("format", "TRUNCATED_OUTPUT")];
    } else {
      const values = generated.structuredValue !== undefined ? [generated.structuredValue]
        : extractJsonCandidates(generated.text).map((entry) => entry.value);
      proposed = values.length;
      const checked: T[] = [];
      for (const value of values) {
        try { checked.push(input.parseSchema(value)); }
        catch { /* 不合规候选不进入业务校验。 */ }
      }
      conforming = checked.length;
      if (checked.length === 0) {
        issues = [repairIssue(values.length === 0 ? "format" : "schema",
          values.length === 0 ? "NO_JSON_OBJECT" : "NO_SCHEMA_VALID_OBJECT")];
      } else if (checked.length > 1) {
        issues = [repairIssue("schema", "AMBIGUOUS_MULTIPLE_VALID_OBJECTS")];
      } else {
        const decision = input.validateBusiness(checked[0]);
        if (decision.status === "accepted") return record({
          outcome: "success", value: decision.value, mode: input.profile.mode,
          attempts: calls, repairCount: repairsMade,
        });
        if (decision.error.disposition !== "repair") return reject(decision.error.code, decision.error.disposition);
        issues = [decision.error];
      }
    }
    if (repairsMade >= selected.maxAttempts) return reject("REPAIR_EXHAUSTED", "fail_closed");
    repairsMade++;
  }
}
