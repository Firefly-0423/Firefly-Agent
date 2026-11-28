import type { ToolCallOutcome } from "./types";

export const TOOL_FAILURE_STREAK_THRESHOLD = 5;
export function isToolBreakerTripped(streak: number | undefined): boolean {
  return (streak ?? 0) >= TOOL_FAILURE_STREAK_THRESHOLD;
}
export function nextToolFailureStreak(streak: number | undefined, outcome: ToolCallOutcome): number {
  switch (outcome) {
    case "failure": return (streak ?? 0) + 1;
    case "success": return 0;
    default: return streak ?? 0;
  }
}
export function toolBreakerMessage(toolName: string, streak: number): string {
  return `工具 ${toolName} 在本次运行中已连续失败 ${streak} 次，已被熔断停用。请停止调用该工具，改用其他方案（换用别的工具、分步或调整参数），或向用户说明情况并求助。`;
}
