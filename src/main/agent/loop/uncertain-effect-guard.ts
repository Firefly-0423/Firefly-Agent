import type { UncertainEffect, AgentState } from "./types";

export function findBlockingUncertainEffect(state: AgentState, fingerprint: string, toolName?: string): UncertainEffect | undefined {
  return state.uncertainEffects.find((entry) => {
    if (entry.fingerprint === fingerprint) return true;
    return entry.argumentsUnavailable === true && entry.toolName === toolName;
  });
}
export function isBlockedByUncertainEffect(state: AgentState, fingerprint: string, toolName?: string): boolean {
  const blocker = findBlockingUncertainEffect(state, fingerprint, toolName);
  return blocker !== undefined;
}
export function resolveUncertainEffect(state: AgentState, toolCallId: string): void {
  state.uncertainEffects = state.uncertainEffects.filter((entry) => entry.toolCallId !== toolCallId);
}
