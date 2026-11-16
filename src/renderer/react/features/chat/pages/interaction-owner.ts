import { findSessionIdForRun } from "./session-runtime-state";

/**
 * A background run owns its card even after the user switches conversations.
 * A card is never routed by which conversation happens to be visible: one that
 * names a run nobody here owns, or names no run at all, has no owner. Main
 * shows an approval without a run id in the toast window instead.
 */
export function interactionOwner(
  activeRuns: Record<string, { runId?: string }>,
  runId: string | undefined,
): string | undefined {
  return findSessionIdForRun(activeRuns, runId);
}
