import type { PlanReviewPhase } from "../components/PlanReviewPanel";

/**
 * A Code-mode plan as the page tracks it: what the model proposed, where the plan file lives, how far it got,
 * and which approval, assistant message and run carry it out.
 */
export type PlanReview = {
  content: string;
  planPath: string;
  phase: PlanReviewPhase;
  /** Set on approval; lets a late enqueue failure recognize that it belongs to this approval only. */
  dispatchAttemptId?: string;
  /** The assistant message whose run executes the plan. */
  executionAssistantId?: string;
  executionRunId?: string;
};

export type PlanReviewBySession = Record<string, PlanReview>;

/** A state update for `setPlanReviewBySession`; returns the same object when nothing changes. */
export type PlanReviewUpdate = (plans: PlanReviewBySession) => PlanReviewBySession;

/** Applies `change` to one session's plan; `undefined` from `change` (or a missing plan) means no change. */
function onPlan(sessionId: string, change: (plan: PlanReview) => PlanReview | undefined): PlanReviewUpdate {
  return (plans) => {
    const plan = plans[sessionId];
    const next = plan && change(plan);
    return next ? { ...plans, [sessionId]: next } : plans;
  };
}

/** The model proposed a plan; it replaces whatever the session had. */
export function planProposed(sessionId: string, content: string, planPath = ""): PlanReviewUpdate {
  return (plans) => ({ ...plans, [sessionId]: { content, planPath, phase: "review" } });
}

/** The user approved; execution is about to be requested under `attemptId`. */
export function planApproved(sessionId: string, attemptId: string): PlanReviewUpdate {
  return onPlan(sessionId, (plan) => ({ ...plan, phase: "executing", dispatchAttemptId: attemptId }));
}

/**
 * Sending the execution message failed. Only this approval's attempt may fail the plan, and only before a run
 * took it over; a newer review or a started execution is left alone.
 */
export function planDispatchFailed(sessionId: string, attemptId: string): PlanReviewUpdate {
  return onPlan(sessionId, (plan) => {
    const ownAttempt = plan.phase === "executing" && plan.dispatchAttemptId === attemptId;
    const unclaimed = !plan.executionAssistantId && !plan.executionRunId;
    return ownAttempt && unclaimed ? { ...plan, phase: "failed" } : undefined;
  });
}

/**
 * An assistant message starts executing the plan. Accepted while the plan is executing and not yet claimed by
 * another message, or after a dispatch failure that never reached a run (the retry).
 */
export function planClaimedByMessage(sessionId: string, assistantId: string): PlanReviewUpdate {
  return onPlan(sessionId, (plan) => {
    const retryAfterDispatchFailure = plan.phase === "failed" && !plan.executionRunId;
    if (plan.phase !== "executing" && !retryAfterDispatchFailure) return undefined;
    if (plan.phase === "executing" && plan.executionAssistantId && plan.executionAssistantId !== assistantId) return undefined;
    return { ...plan, phase: "executing", executionAssistantId: assistantId };
  });
}

/** The claiming message's run got its id; the first run id sticks. */
export function planRunStarted(sessionId: string, assistantId: string, runId: string): PlanReviewUpdate {
  return onPlan(sessionId, (plan) =>
    plan.phase === "executing" && !plan.executionRunId && plan.executionAssistantId === assistantId
      ? { ...plan, executionRunId: runId }
      : undefined);
}

/**
 * The claiming message's execution ended without completing the plan. `runId` is undefined when it ended before
 * its run was created; it then matches a plan that has no run either.
 */
export function planRunEnded(sessionId: string, assistantId: string, runId: string | undefined, phase: PlanReviewPhase): PlanReviewUpdate {
  return onPlan(sessionId, (plan) =>
    plan.executionRunId === runId && plan.executionAssistantId === assistantId ? { ...plan, phase } : undefined);
}

/** The executing run reported the plan file as done. */
export function planCompleted(sessionId: string, planPath: string, runId: string): PlanReviewUpdate {
  return onPlan(sessionId, (plan) =>
    plan.phase === "executing" && plan.planPath === planPath && plan.executionRunId === runId
      ? { ...plan, phase: "completed" }
      : undefined);
}
