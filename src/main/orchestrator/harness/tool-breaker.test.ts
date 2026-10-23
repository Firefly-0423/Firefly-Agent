import { describe, expect, it } from "vitest";
import { isToolBreakerTripped, nextToolFailureStreak, toolBreakerMessage, TOOL_FAILURE_STREAK_THRESHOLD } from "./tool-breaker";
import type { ToolCallOutcome } from "./types";

describe("Failure streak accounting", () => {
  it("trips at five failures, including counts beyond the boundary", () => {
    expect(TOOL_FAILURE_STREAK_THRESHOLD).toEqual(5);
    expect([undefined, 0, 1, 4, 5, 17].map(isToolBreakerTripped)).toEqual([false, false, false, false, true, true]);
  });

  it("increments actual failures and resets only on confirmed success", () => {
    expect([undefined, 1, 4].map(n => nextToolFailureStreak(n, "failure"))).toEqual([1, 2, 5]);
    expect([undefined, 3, 5, 30].map(n => nextToolFailureStreak(n, "success"))).toEqual([0, 0, 0, 0]);
    expect([undefined, 0, 3, 5].map(n => nextToolFailureStreak(n, "not_executed"))).toEqual([0, 0, 3, 5]);
    expect([undefined, 2, 5].map(n => nextToolFailureStreak(n, "unknown"))).toEqual([0, 2, 5]);
  });

  it("does not let a synthesized refusal or an unknown result release a tripped tool", () => {
    const sequence: ToolCallOutcome[] = ["failure", "not_executed", "failure", "unknown", "failure", "not_executed", "failure", "failure", "not_executed", "unknown"];
    let count: number | undefined;
    expect(sequence.map(outcome => count = nextToolFailureStreak(count, outcome))).toEqual([1, 1, 2, 2, 3, 3, 4, 5, 5, 5]);
    expect(isToolBreakerTripped(count)).toEqual(true);
  });

  it("tells the model the tool and failure count and requests an alternative or user assistance", () => {
    const text = toolBreakerMessage("archive_notes", 5);
    expect(text).toEqual("工具 archive_notes 在本次运行中已连续失败 5 次，已被熔断停用。请停止调用该工具，改用其他方案（换用别的工具、分步或调整参数），或向用户说明情况并求助。");
    expect(text.length).toBeGreaterThan(20);
  });
});
