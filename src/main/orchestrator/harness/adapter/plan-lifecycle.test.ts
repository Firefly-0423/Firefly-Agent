import { beforeEach, describe, expect, it, vi } from "vitest";

const services = vi.hoisted(() => ({
  state: vi.fn(), supplement: vi.fn(), path: vi.fn(), release: vi.fn(), read: vi.fn(),
}));
vi.mock("fs", () => ({ promises: { readFile: services.read } }));
vi.mock("../../plan-mode", () => ({
  getPlanState: services.state, supplementPlan: services.supplement, getPlanPath: services.path, completeExecution: services.release,
}));
import { completePlanRun, preparePlanRunContext } from "./plan-lifecycle";

beforeEach(() => {
  vi.resetAllMocks();
  services.path.mockReturnValue("D:\\workspace\\approved.md");
  services.release.mockReturnValue("D:\\workspace\\approved.md");
});

describe("Plan state at run boundaries", () => {
  it("reopens review before capturing the discussion state", async () => {
    services.state.mockReturnValueOnce("PLAN_REVIEW").mockReturnValueOnce("PLAN_DISCUSSING");
    expect(await preparePlanRunContext({ mode: "code", threadId: "planning-thread" })).toEqual({ planState: "PLAN_DISCUSSING" });
    expect(services.supplement).toHaveBeenCalledExactlyOnceWith("planning-thread");
    expect(services.state.mock.invocationCallOrder[0]).toBeLessThan(services.supplement.mock.invocationCallOrder[0]);
    expect(services.supplement.mock.invocationCallOrder[0]).toBeLessThan(services.state.mock.invocationCallOrder[1]);
  });

  it("publishes completion after releasing an execution prepared for this run", () => {
    const send = vi.fn();
    completePlanRun({ mode: "code", threadId: "planning-thread", runId: "execution-violet", planState: "EXECUTING", runStatus: "completed", signal: new AbortController().signal, send });
    expect(services.release).toHaveBeenCalledExactlyOnceWith("planning-thread");
    expect(services.release.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0]);
    expect(send).toHaveBeenCalledExactlyOnceWith({
      type: "CUSTOM", name: "firefly.plan.completed", threadId: "planning-thread", runId: "execution-violet",
      value: { planPath: "D:\\workspace\\approved.md", runStatus: "completed" },
    });
  });

  it.each(["failed", "cancelled", "halted", "aborted"] as const)("releases execution without a completion notice for %s", state => {
    const send = vi.fn();
    completePlanRun({ mode: "code", threadId: "planning-thread", runId: "execution-violet", planState: "EXECUTING",
      runStatus: state === "aborted" ? "completed" : state, signal: state === "aborted" ? AbortSignal.abort() : new AbortController().signal, send });
    expect(services.release).toHaveBeenCalledExactlyOnceWith("planning-thread");
    expect(send).not.toHaveBeenCalled();
  });

  it.each(["NORMAL", "PLAN_DISCUSSING", undefined, "PLAN_REVIEW"] as const)("does not consume a later approval when prepared in %s", planState => {
    const send = vi.fn();
    completePlanRun({ planState, mode: "code", threadId: "planning-thread", runId: "execution-violet", runStatus: "completed", signal: new AbortController().signal, send });
    expect(services.release).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("awaits and trims the approved plan when preparing an executing run", async () => {
    services.state.mockReturnValue("EXECUTING");
    services.read.mockResolvedValue(" \n- Verify cancellation\n ");
    expect(await preparePlanRunContext({ mode: "code", threadId: "planning-thread" })).toEqual({
      planState: "EXECUTING", planContextBlock: "[PLAN_CONTEXT]\n用户已批准以下实施计划。请严格按计划清单顺序执行，用 update_todo 维护任务进度：\n\n- Verify cancellation",
    });
    expect(services.read).toHaveBeenCalledExactlyOnceWith("D:\\workspace\\approved.md", "utf8");
  });
});
