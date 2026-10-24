import { getToolWriteEvidence } from "./file-write-evidence";
import { isAbortError } from "../../../utils/abort-utils";
import { recordSkillUse, recordToolCall } from "../../../storage/token-usage-store";
import { currentUsageAttribution, runWithUsageAttribution } from "../../../storage/usage-attribution";
import type { ToolContext } from "./tool-context";
import type { ToolDefinition } from "./tool-registry";
import { normalizeToolExecutionOutcome } from "./tool-outcome-normalizer";
import { ToolExecutionError, type ToolEffectState, type ToolErrorCategory } from "./tool-execution-error";
import type { ToolExecutionOutcome } from "../../types";

function knownCategory(candidate: unknown): candidate is ToolErrorCategory {
  return typeof candidate === "string" && [
    "transient", "timeout", "rate_limited", "not_found", "permission_denied",
    "invalid_arguments", "semantic_failure", "partial_failure", "fatal", "runtime_safety",
  ].includes(candidate);
}

function legacyOutcome(serialized: string): ToolExecutionOutcome | undefined {
  const prefix = serialized.trimStart();
  if (prefix.startsWith("[错误]") || prefix.startsWith("[拒绝]")) {
    const denied = !prefix.startsWith("[错误]");
    return {
      status: "failed", output: serialized,
      errorCode: denied ? "E_LEGACY_TOOL_REJECTED" : "E_LEGACY_TOOL_ERROR",
      category: denied ? "permission_denied" : "semantic_failure", effectState: "not_applied",
    };
  }
  try {
    const payload = JSON.parse(serialized) as Record<string, unknown> | null;
    if (!payload || typeof payload !== "object") return undefined;
    if (payload.timedOut === true) {
      const failed = payload.success === false;
      return {
        status: "failed", output: serialized,
        errorCode: failed && typeof payload.errorCode === "string" ? payload.errorCode : "E_TOOL_TIMEOUT",
        category: failed && knownCategory(payload.category) ? payload.category : "timeout",
        retryable: false,
        effectState: failed && payload.effectState === "not_applied" ? "not_applied" : "unknown",
      };
    }
    if (payload.success !== false) return undefined;
    let detail: string;
    if (typeof payload.error === "string") detail = payload.error;
    else detail = payload.error === undefined ? serialized : JSON.stringify(payload.error);
    return {
      status: "failed", output: detail,
      errorCode: typeof payload.errorCode === "string" ? payload.errorCode : "E_TOOL_BUSINESS_FAILED",
      category: knownCategory(payload.category) ? payload.category : "semantic_failure",
      retryable: payload.retryable === true,
      effectState: (payload.effectState === "unknown" ? "unknown" : "not_applied") as ToolEffectState,
    };
  } catch { return undefined; }
}

export async function executeToolDefinition(
  definition: ToolDefinition, input: Record<string, unknown>, runContext?: ToolContext,
): Promise<ReturnType<typeof normalizeToolExecutionOutcome>> {
  const finish = (facts: ToolExecutionOutcome) => {
    const evidence = getToolWriteEvidence(runContext);
    return normalizeToolExecutionOutcome({ ...facts, ...(evidence.length ? { writes: evidence } : {}) });
  };
  if (definition.id === "invoke_skill" && typeof input.skill_id === "string") recordSkillUse(input.skill_id);
  const inherited = currentUsageAttribution();
  const invocationUsage = inherited ? { ...inherited, delegations: 0 } : undefined;
  const began = performance.now();
  try {
    const response = await (invocationUsage
      ? runWithUsageAttribution(invocationUsage, () => definition.execute(input, runContext))
      : definition.execute(input, runContext));
    const failure = legacyOutcome(response);
    return finish(failure ?? { status: "succeeded", output: response });
  } catch (caught) {
    if (isAbortError(caught)) throw caught;
    if (caught instanceof ToolExecutionError) {
      return finish({
        status: "failed", output: caught.message, errorCode: caught.code,
        category: caught.category, retryable: caught.retryable, effectState: caught.effectState,
      });
    }
    const detail = caught instanceof Error ? caught.message : String(caught);
    const suppliedCode = typeof caught === "object" && caught !== null && "code" in caught
      && typeof (caught as { code?: unknown }).code === "string"
      ? String((caught as { code: string }).code) : undefined;
    return finish({
      status: "failed", output: detail, errorCode: suppliedCode ?? "E_TOOL_EXECUTION_FAILED",
      effectState: "not_applied",
    });
  } finally {
    const childRan = (invocationUsage?.delegations ?? 0) > 0;
    recordToolCall(childRan ? 0 : performance.now() - began);
  }
}
