import { findSessionIdForRun } from "./session-runtime-state";

/** A background run owns its card even after the user switches conversations. */
export function interactionOwner(
  activeRuns: Record<string, { runId?: string }>,
  runId: string | undefined,
  visibleSessionId: string | undefined,
): string | undefined {
  return findSessionIdForRun(activeRuns, runId) ?? visibleSessionId;
}
