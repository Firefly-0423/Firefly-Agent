import * as fs from "fs";
import * as path from "path";
import { getCurrentLevel } from "../../permission";
import type { AgentFileAccessLevel } from "../../permission-policy";
import type { ToolContext } from "./registry/tool-context";
import { ToolExecutionError, type ToolEffectState } from "./registry/tool-execution-error";

/** Resolve existing ancestors too, so creating a missing file cannot escape via a junction.
 * lstat distinguishes a missing entry from a dangling link: never fall back past a link
 * whose realpath fails, or past an inaccessible ancestor.
 * https://nodejs.org/docs/latest-v24.x/api/fs.html#fsrealpathsyncpath-options
 */
function resolveTarget(file: string): string {
  let ancestor = path.resolve(file);
  const missing: string[] = [];
  for (;;) {
    try {
      fs.lstatSync(ancestor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      missing.unshift(path.basename(ancestor));
      ancestor = parent;
      continue;
    }
    return path.resolve(fs.realpathSync(ancestor), ...missing);
  }
}

/** 硬链接共享同一 inode，真实路径无法证明它没有指向工作区外的文件；受限档位下一律拒绝。 */
function assertNotHardLinked(target: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (stat.isFile() && stat.nlink > 1) {
    throw new ToolExecutionError("E_WORKSPACE_BOUNDARY", "目标文件存在多个硬链接，受限档位下无法确认它位于当前工作区内", "permission_denied");
  }
}

/** Filesystem scope only; approval and operation ownership remain with the dispatcher.
 * Mirrors resolveSandboxSessionFilesystem: project-read-only limits reads; scoped
 * limits writes, but permits reads outside the project. Approved per-action/full
 * calls and legacy callers without a session snapshot keep their existing scope.
 *
 * Known limit: this is a check-then-use guard on a path name. A process that can retarget
 * a link inside the workspace between this check and the caller's fs call can still win the
 * race. Restricted Windows callers now use workspace-handle's native operations.
 * This function remains the explicit fallback on non-Windows; closing that race
 * requires a future Unix handle-relative backend.
 */
export function workspaceRestriction(access: "read" | "write", context?: ToolContext, platform = process.platform): string | undefined {
  // 运行快照与实时全局档位取交集：运行中降级也必须收紧，与 prepareToolRuntime 的口径一致。
  const snapshot = context?.fileAccessLevel;
  // allow_all（定时/渠道无人值守）的快照本就是 full，派发与 run_shell 都绕过实时档位，这里保持一致。
  const levels: AgentFileAccessLevel[] = snapshot === undefined ? []
    : context?.permissionMode === "allow_all" ? [snapshot] : [snapshot, getCurrentLevel()];
  if (access === "write" && levels.some(level => level === "project-read-only" || level === "read-only")) {
    throw new ToolExecutionError("E_FILESYSTEM_READ_ONLY", "当前会话不允许写入文件", "permission_denied");
  }
  const restricted = levels.some(level =>
    (access === "read" && level === "project-read-only") || (access === "write" && level === "scoped"));
  if (!restricted) return undefined;

  const root = context?.resolvedWorkspaceRoot;
  if (!root || !(platform === "win32" ? path.win32 : path.posix).isAbsolute(root)) {
    throw new ToolExecutionError("E_WORKSPACE_REQUIRED", "当前权限档位需要可信的工作区根目录", "permission_denied");
  }
  return root;
}

/** Direct-path callers must recheck after an await or subscriber callback. A
 * downgrade cannot leave an already-selected Windows path branch using fs. */
export function assertWorkspacePathFallback(file: string, access: "read" | "write", context?: ToolContext, effectState: ToolEffectState = "not_applied"): void {
  try {
  if (process.platform === "win32" && workspaceRestriction(access, context)) {
    throw new ToolExecutionError("E_WORKSPACE_BOUNDARY", "权限已收紧，需要重新通过工作区句柄访问目标", "permission_denied");
  }
  assertWorkspaceBoundary(file, access, context);
  } catch (error) {
    if (error instanceof ToolExecutionError && effectState === "unknown") throw new ToolExecutionError(error.code, error.message, error.category, error.retryable, effectState);
    throw error;
  }
}

/** Legacy path guard. Non-Windows workspace I/O still uses this fallback with
 * the known check/use race; restricted Windows callers use workspace-handle. */
export function assertWorkspaceBoundary(file: string, access: "read" | "write", context?: ToolContext): void {
  const root = workspaceRestriction(access, context);
  if (!root) return;
  let relative: string;
  try {
    const canonicalRoot = fs.realpathSync(root);
    if (!fs.statSync(canonicalRoot).isDirectory()) throw new Error("Workspace is not a directory");
    const target = resolveTarget(file);
    relative = path.relative(canonicalRoot, target);
    assertNotHardLinked(target);
  } catch (error) {
    if (error instanceof ToolExecutionError) throw error;
    throw new ToolExecutionError("E_WORKSPACE_BOUNDARY", "无法确认目标路径位于当前工作区内", "permission_denied");
  }
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ToolExecutionError("E_WORKSPACE_BOUNDARY", "目标路径超出当前工作区", "permission_denied");
  }
}
