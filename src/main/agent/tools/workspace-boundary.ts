import { getCurrentLevel } from "../../platform/permission/permission";
import type { AgentFileAccessLevel } from "../../platform/permission/permission-policy";
import type { ToolContext } from "../../tooling/registry/tool-context";
import { ToolExecutionError, type ToolEffectState } from "../../tooling/registry/tool-execution-error";

/** Filesystem write-denial check; approval and operation ownership remain with the dispatcher.
 * Legacy `project-read-only` and `scoped` workspace containment levels have been removed:
 * `read-only` denies writes while allowing reads, and approved `per-action` / `full` calls
 * are unrestricted.
 */
export function workspaceRestriction(access: "read" | "write", context?: ToolContext, _platform = process.platform): string | undefined {
  // 运行快照与实时全局档位取交集：运行中降级也必须收紧，与 prepareToolRuntime 的口径一致。
  const snapshot = context?.fileAccessLevel;
  // allow_all（定时/渠道无人值守）的快照本就是 full，派发与 run_shell 都绕过实时档位，这里保持一致。
  const levels: AgentFileAccessLevel[] = snapshot === undefined ? []
    : context?.permissionMode === "allow_all" ? [snapshot] : [snapshot, getCurrentLevel()];
  if (access === "write" && levels.some(level => level === "read-only")) {
    throw new ToolExecutionError("E_FILESYSTEM_READ_ONLY", "当前会话不允许写入文件", "permission_denied");
  }
  return undefined;
}

/** Direct-path callers must recheck after an await or subscriber callback. */
export function assertWorkspacePathFallback(file: string, access: "read" | "write", context?: ToolContext, effectState: ToolEffectState = "not_applied"): void {
  try {
    assertWorkspaceBoundary(file, access, context);
  } catch (error) {
    if (error instanceof ToolExecutionError && effectState === "unknown") throw new ToolExecutionError(error.code, error.message, error.category, error.retryable, effectState);
    throw error;
  }
}

/** Checks read-only write denial for callers using the path fallback interface. */
export function assertWorkspaceBoundary(_file: string, access: "read" | "write", context?: ToolContext): void {
  workspaceRestriction(access, context);
}
