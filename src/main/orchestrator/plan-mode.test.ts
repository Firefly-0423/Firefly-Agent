import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  approvePlan,
  buildWorkspacePlanPath,
  completeExecution,
  enterPlanDiscussing,
  exitPlanMode,
  getPlanPath,
  getPlanState,
  hasPlanWrittenThisRun,
  initPlanPaths,
  initPlanStateBroadcaster,
  isInPlanDiscussion,
  isPlanReadOnly,
  markPlanWritten,
  moveToReview,
  resetPlanSessionsForTest,
  supplementPlan,
} from "./plan-mode";

const CONV = "conv-1";

beforeEach(() => {
  resetPlanSessionsForTest();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 7, 17, 15, 30, 45));
});

afterEach(() => {
  vi.useRealTimers();
});

function enterReview(conversationId = CONV, workspaceRoot = "/workspace"): string {
  expect(enterPlanDiscussing(conversationId, workspaceRoot)).toEqual({ ok: true });
  markPlanWritten(conversationId);
  expect(moveToReview(conversationId)).toBe(true);
  return getPlanPath(conversationId);
}

describe("plan paths", () => {
  it("builds a timestamped workspace path and normalizes separators", () => {
    expect(buildWorkspacePlanPath("/workspace")).toBe(
      "/workspace/.firefly/docs/plan-20260817-153045.md",
    );
    expect(buildWorkspacePlanPath("C:\\workspace\\")).toBe(
      "C:/workspace/.firefly/docs/plan-20260817-153045.md",
    );
    expect(buildWorkspacePlanPath("/workspace//")).toBe(
      "/workspace/.firefly/docs/plan-20260817-153045.md",
    );
  });

  it("falls back to plans/<conversation>/plan.md before a root is injected", () => {
    expect(getPlanPath(CONV)).toBe("plans/conv-1/plan.md");
    initPlanPaths("/user-data");
    expect(getPlanPath(CONV)).toBe("/user-data/plans/conv-1/plan.md");
    initPlanPaths("C:\\user-data\\");
    expect(getPlanPath(CONV)).toBe("C:/user-data/plans/conv-1/plan.md");
  });

  it("uses the workspace path while discussing and keeps it after returning to NORMAL", () => {
    enterPlanDiscussing(CONV, "/workspace");
    const path = getPlanPath(CONV);
    expect(path).toMatch(/^\/workspace\/\.firefly\/docs\/plan-\d{8}-\d{6}\.md$/);

    exitPlanMode(CONV);
    expect(getPlanState(CONV)).toBe("NORMAL");
    expect(getPlanPath(CONV)).toBe(path);
  });

  it("uses the injected fallback root when no workspace is available", () => {
    initPlanPaths("/user-data");
    enterPlanDiscussing(CONV);
    expect(getPlanPath(CONV)).toBe("/user-data/plans/conv-1/plan.md");
  });

  it("generates a new timestamped file on a later plan cycle", () => {
    enterPlanDiscussing(CONV, "/workspace");
    const first = getPlanPath(CONV);
    exitPlanMode(CONV);
    vi.setSystemTime(new Date(2026, 7, 17, 15, 30, 46));
    enterPlanDiscussing(CONV, "/workspace");
    expect(getPlanPath(CONV)).not.toBe(first);
    expect(getPlanPath(CONV)).toBe("/workspace/.firefly/docs/plan-20260817-153046.md");
  });
});

describe("plan state machine", () => {
  it("defaults unknown conversations to NORMAL and not read-only", () => {
    expect(getPlanState("unknown")).toBe("NORMAL");
    expect(isInPlanDiscussion("unknown")).toBe(false);
    expect(isPlanReadOnly("unknown")).toBe(false);
    expect(hasPlanWrittenThisRun("unknown")).toBe(false);
  });

  it("enters discussion only from NORMAL and reports the blocking state otherwise", () => {
    expect(enterPlanDiscussing(CONV, "/workspace")).toEqual({ ok: true });
    expect(getPlanState(CONV)).toBe("PLAN_DISCUSSING");
    expect(isInPlanDiscussion(CONV)).toBe(true);
    expect(isPlanReadOnly(CONV)).toBe(true);
    expect(hasPlanWrittenThisRun(CONV)).toBe(false);

    expect(enterPlanDiscussing(CONV, "/workspace")).toEqual({
      ok: false,
      reason: "已在计划模式中",
    });

    markPlanWritten(CONV);
    expect(moveToReview(CONV)).toBe(true);
    expect(enterPlanDiscussing(CONV, "/workspace")).toEqual({
      ok: false,
      reason: "计划待审批，等待用户决定",
    });

    expect(approvePlan(CONV)).toBe(true);
    expect(enterPlanDiscussing(CONV, "/workspace")).toEqual({
      ok: false,
      reason: "计划执行中，不可进入计划模式",
    });
  });

  it("moves to review only after a plan was written in the current run", () => {
    expect(moveToReview("missing")).toBe(false);
    expect(enterPlanDiscussing(CONV)).toEqual({ ok: true });
    expect(moveToReview(CONV)).toBe(false);
    expect(getPlanState(CONV)).toBe("PLAN_DISCUSSING");

    markPlanWritten(CONV);
    expect(hasPlanWrittenThisRun(CONV)).toBe(true);
    expect(moveToReview(CONV)).toBe(true);
    expect(getPlanState(CONV)).toBe("PLAN_REVIEW");
    expect(hasPlanWrittenThisRun(CONV)).toBe(false);
    expect(moveToReview(CONV)).toBe(false);
  });

  it("allows supplements and approval only from review", () => {
    expect(supplementPlan("missing")).toBe(false);
    expect(approvePlan("missing")).toBe(false);

    enterReview();
    expect(supplementPlan(CONV)).toBe(true);
    expect(getPlanState(CONV)).toBe("PLAN_DISCUSSING");
    expect(supplementPlan(CONV)).toBe(false);

    markPlanWritten(CONV);
    expect(moveToReview(CONV)).toBe(true);
    expect(approvePlan(CONV)).toBe(true);
    expect(getPlanState(CONV)).toBe("EXECUTING");
    expect(approvePlan(CONV)).toBe(false);
    expect(supplementPlan(CONV)).toBe(false);
  });

  it("completes execution exactly once and returns the active plan path", () => {
    enterReview();
    expect(completeExecution(CONV)).toBeUndefined();
    expect(approvePlan(CONV)).toBe(true);
    const path = getPlanPath(CONV);

    expect(completeExecution(CONV)).toBe(path);
    expect(getPlanState(CONV)).toBe("NORMAL");
    expect(completeExecution(CONV)).toBeUndefined();
  });

  it("exits from any active state and clears the written flag", () => {
    enterPlanDiscussing(CONV, "/workspace");
    markPlanWritten(CONV);
    exitPlanMode(CONV);
    expect(getPlanState(CONV)).toBe("NORMAL");
    expect(hasPlanWrittenThisRun(CONV)).toBe(false);

    exitPlanMode("missing"); // no session: nothing to do
    expect(getPlanState("missing")).toBe("NORMAL");
  });

  it("marking a plan for an unknown conversation still records it", () => {
    markPlanWritten(CONV);
    expect(hasPlanWrittenThisRun(CONV)).toBe(true);
    expect(getPlanState(CONV)).toBe("NORMAL");
    expect(moveToReview(CONV)).toBe(false);
  });
});

describe("state broadcaster", () => {
  it("broadcasts every transition with conversation id and new state", () => {
    const events: Array<[string, string]> = [];
    initPlanStateBroadcaster((conversationId, state) => events.push([conversationId, state]));

    enterPlanDiscussing(CONV);
    markPlanWritten(CONV);
    moveToReview(CONV);
    supplementPlan(CONV);
    markPlanWritten(CONV);
    moveToReview(CONV);
    approvePlan(CONV);
    completeExecution(CONV);
    exitPlanMode(CONV);

    expect(events).toEqual([
      [CONV, "PLAN_DISCUSSING"],
      [CONV, "PLAN_REVIEW"],
      [CONV, "PLAN_DISCUSSING"],
      [CONV, "PLAN_REVIEW"],
      [CONV, "EXECUTING"],
      [CONV, "NORMAL"],
      [CONV, "NORMAL"],
    ]);
  });

  it("swallows broadcaster failures and can be disabled", () => {
    initPlanStateBroadcaster(() => {
      throw new Error("synthetic broadcast failure");
    });
    expect(enterPlanDiscussing(CONV)).toEqual({ ok: true });
    expect(getPlanState(CONV)).toBe("PLAN_DISCUSSING");

    const listener = vi.fn();
    initPlanStateBroadcaster(listener);
    initPlanStateBroadcaster(null);
    expect(supplementPlan(CONV)).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    expect(exitPlanMode(CONV)).toBeUndefined();
  });
});
