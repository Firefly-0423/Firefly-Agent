import type { ToolExecutionOutcome } from "../../types";

export function normalizeToolExecutionOutcome(
  facts: ToolExecutionOutcome,
): ToolExecutionOutcome & { terminal: boolean; retryable: boolean } {
  return { ...facts, terminal: facts.terminal ?? true, retryable: facts.retryable ?? false };
}
