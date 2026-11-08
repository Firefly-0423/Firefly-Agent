import { describe, expect, it } from "vitest";
import {
  planApproved, planClaimedByMessage, planCompleted, planDispatchFailed, planProposed, planRunEnded, planRunStarted,
  type PlanReviewBySession,
} from "./plan-review-state";

const S = "session-1";
const proposed = (): PlanReviewBySession => planProposed(S, "1. 改代码\n2. 跑测试", "plans/p.md")({});
const executing = () => planApproved(S, "attempt-1")(proposed());

describe("plan review state", () => {
  it("walks a plan from proposal through approval, execution and completion", () => {
    let plans = executing();
    expect(plans[S]).toMatchObject({ phase: "executing", dispatchAttemptId: "attempt-1" });
    plans = planClaimedByMessage(S, "assistant-1")(plans);
    plans = planRunStarted(S, "assistant-1", "run-1")(plans);
    plans = planCompleted(S, "plans/p.md", "run-1")(plans);
    expect(plans[S]).toMatchObject({ phase: "completed", executionAssistantId: "assistant-1", executionRunId: "run-1" });
  });

  it("returns the same object when an event does not apply", () => {
    const plans = executing();
    expect(planApproved("other", "a")(plans)).toBe(plans);
    expect(planRunStarted(S, "assistant-1", "run-1")(plans)).toBe(plans);
    expect(planCompleted(S, "plans/p.md", "run-1")(plans)).toBe(plans);
    expect(planRunEnded(S, "assistant-1", "run-1", "failed")(plans)).toBe(plans);
  });

  it("lets only its own approval fail a dispatch that no run has taken over", () => {
    const plans = executing();
    expect(planDispatchFailed(S, "attempt-0")(plans)).toBe(plans);
    expect(planDispatchFailed(S, "attempt-1")(plans)[S]?.phase).toBe("failed");
    const claimed = planClaimedByMessage(S, "assistant-1")(plans);
    expect(planDispatchFailed(S, "attempt-1")(claimed)).toBe(claimed);
    expect(planDispatchFailed(S, "attempt-1")(proposed())[S]?.phase).toBe("review");
  });

  it("keeps the first claiming message and accepts a retry after a failed dispatch", () => {
    const claimed = planClaimedByMessage(S, "assistant-1")(executing());
    expect(planClaimedByMessage(S, "assistant-2")(claimed)).toBe(claimed);
    const failed = planDispatchFailed(S, "attempt-1")(executing());
    expect(planClaimedByMessage(S, "assistant-2")(failed)[S]).toMatchObject({ phase: "executing", executionAssistantId: "assistant-2" });
    expect(planClaimedByMessage(S, "assistant-1")(proposed())[S]?.phase).toBe("review");
  });

  it("binds only the claiming message's first run and ends only that run", () => {
    const claimed = planClaimedByMessage(S, "assistant-1")(executing());
    expect(planRunStarted(S, "assistant-2", "run-1")(claimed)).toBe(claimed);
    const running = planRunStarted(S, "assistant-1", "run-1")(claimed);
    expect(planRunStarted(S, "assistant-1", "run-2")(running)).toBe(running);
    expect(planRunEnded(S, "assistant-1", "run-2", "cancelled")(running)).toBe(running);
    expect(planRunEnded(S, "assistant-1", "run-1", "cancelled")(running)[S]?.phase).toBe("cancelled");
    expect(planCompleted(S, "plans/other.md", "run-1")(running)).toBe(running);
  });

  it("ends a claimed plan whose run never started", () => {
    const claimed = planClaimedByMessage(S, "assistant-1")(executing());
    expect(planRunEnded(S, "assistant-1", undefined, "failed")(claimed)[S]?.phase).toBe("failed");
    expect(planRunEnded(S, "assistant-2", undefined, "failed")(claimed)).toBe(claimed);
  });

  it("replaces an earlier plan when a new one is proposed", () => {
    const replaced = planProposed(S, "新计划")(executing());
    expect(replaced[S]).toEqual({ content: "新计划", planPath: "", phase: "review" });
  });
});
