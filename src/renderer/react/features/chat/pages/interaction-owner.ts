import { findSessionIdForRun } from "./session-runtime-state";

/** A background run owns its card even after the user switches conversations. */
export function interactionOwner(
  activeRuns: Record<string, { runId?: string }>,
  runId: string | undefined,
  visibleSessionId: string | undefined,
): string | undefined {
  // 带了 run ID 却找不到持有者的卡直接丢弃，不落到恰好可见的会话里。
  if (runId) return findSessionIdForRun(activeRuns, runId);
  return visibleSessionId;
}
