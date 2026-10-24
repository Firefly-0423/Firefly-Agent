import { spawn } from "child_process";
import { resolveContainedPath } from "../path-containment";
import type { ToolDefinition } from "../registry/tool-registry";
import type { ToolContext } from "../registry/tool-context";
import { wrapWithSandbox, type SandboxWrapOutcome } from "../../sandbox/sandbox-exec";
import { getCurrentLevel } from "../../../permission/permission";
import { policyFor, type AgentFileAccessLevel } from "../../../permission/permission-policy";
import { isPlanReadOnly } from "../../plan-mode";
import { ToolExecutionError, type ToolErrorCategory, type ToolEffectState } from "../registry/tool-execution-error";
import { classifyShellEffect, isCatastrophicCommand, type ShellEffect } from "../../shell-execution-policy";
import { logger, LogTag } from "../../../logging/logger";
import { buildDirectShellInvocation, resolveShellExecutable, type ResolvedShellExecutable, type ShellKind } from "../../shell-runtime";
import { killTree, startShellJob, type ShellSpawnSpec } from "./shell-job-manager";

const LOG_PREFIX = "[BuiltinTools]";
const SHELL_IDLE_TIMEOUT_MS = 2 * 60_000;
const SHELL_TOTAL_TIMEOUT_MS = 30 * 60_000;
const SHELL_TIMEOUT_MS_MIN = 1_000;
const SHELL_TIMEOUT_MS_MAX = SHELL_TOTAL_TIMEOUT_MS;
const SHELL_KILL_GRACE_MS = 2_000;
const SHELL_CAPTURE_LIMIT_PER_STREAM = 2 * 1024 * 1024;
const utf8StrictDecoder = new TextDecoder("utf-8", { fatal: true });
let gbkDecoder: typeof utf8StrictDecoder | null = null;
try { gbkDecoder = new TextDecoder("gbk"); } catch { /* 精简 ICU 环境保留 UTF-8 回退。 */ }

function decodeShellOutput(parts: Buffer[]): string {
  if (parts.length === 0) return "";
  const bytes = Buffer.concat(parts).subarray(0, SHELL_CAPTURE_LIMIT_PER_STREAM);
  try { return utf8StrictDecoder.decode(bytes); }
  catch {
    if (gbkDecoder) { try { return gbkDecoder.decode(bytes); } catch { /* 最后宽松解码。 */ } }
    return bytes.toString("utf8");
  }
}
export interface ShellTimeoutPolicy {
  idleMs: number | undefined; totalMs: number; explicitDeadline: boolean;
}
const DEFAULT_TIMEOUT_POLICY: ShellTimeoutPolicy = { idleMs: SHELL_IDLE_TIMEOUT_MS, totalMs: SHELL_TOTAL_TIMEOUT_MS, explicitDeadline: false };
export function resolveTimeoutPolicy(raw: unknown): ShellTimeoutPolicy {
  if (raw === undefined || raw === null || raw === "" || typeof raw === "boolean") return DEFAULT_TIMEOUT_POLICY;
  const milliseconds = Number(raw);
  if (!Number.isFinite(milliseconds)) return DEFAULT_TIMEOUT_POLICY;
  return { idleMs: undefined, totalMs: Math.min(Math.max(Math.round(milliseconds), SHELL_TIMEOUT_MS_MIN), SHELL_TIMEOUT_MS_MAX), explicitDeadline: true };
}
function formatTimeoutMs(duration: number): string {
  return duration >= 60_000 ? `${Math.round(duration / 60_000)} 分钟` : `${Math.round(duration / 1000)} 秒`;
}
interface ShellResult {
  success: boolean; shell: ShellKind; shellExecutable?: string; errorCode?: string;
  category?: ToolErrorCategory; effectState?: ToolEffectState; retryable?: false;
  exitCode: number | null; stdout: string; stderr: string; captureTruncated: boolean;
  ranViaSandbox: boolean; timedOut: boolean;
}
function shellFailure(code: string, category: ToolErrorCategory, effects: ToolEffectState = "not_applied") {
  return { success: false, errorCode: code, category, effectState: effects, retryable: false as const };
}
type ExecutionPlan =
  | { kind: "sandboxed"; command: string; cwd?: string; requestedShell: ShellKind; argv: string[]; env: NodeJS.ProcessEnv }
  | { kind: "direct"; command: string; cwd?: string; requestedShell: ShellKind }
  | { kind: "rejected"; command: string; cwd?: string; requestedShell: ShellKind; reason: string };
type ExecutablePlan = Exclude<ExecutionPlan, { kind: "rejected" }>;

async function resolveExecutionPlan(command: string, cwd: string | undefined, requestedShell: ShellKind, resolvedShell: ResolvedShellExecutable, level: AgentFileAccessLevel, workspaceRoot: string | undefined): Promise<ExecutionPlan> {
  const details = { command, cwd, requestedShell };
  let wrapped: SandboxWrapOutcome;
  try { wrapped = await wrapWithSandbox(command, cwd, requestedShell === "bash" ? resolvedShell.executable : undefined, level, workspaceRoot); }
  catch (failure) {
    const detail = failure instanceof Error ? failure.message : String(failure);
    logger.warn(LogTag.BuiltinTools, `[run_shell] wrapWithSandbox threw unexpectedly, fail-closed: ${detail}`);
    return { ...details, kind: "rejected", reason: "沙箱包装异常，该命令已终止（未执行）" };
  }
  if (wrapped.ok) return { ...details, kind: "sandboxed", argv: wrapped.argv, env: wrapped.env };
  if (wrapped.reason === "disabled" && level === "per-action") return { ...details, kind: "direct" };
  const rejection: Record<"disabled" | "not_ready" | "wrap_failed", string> = {
    "disabled": "沙箱未启用，该命令可能修改工作区，已终止",
    "not_ready": "沙箱不可用（初始化失败），该命令已终止。请在设置中安装沙箱后重试。",
    "wrap_failed": "沙箱包装失败，该命令已终止（未执行）",
  };
  logger.warn(LogTag.BuiltinTools, `[run_shell] fail-closed before spawn: reason=${wrapped.reason} detail=${wrapped.detail ?? "(none)"} level=${level} command="${command.slice(0, 200)}"`);
  return { ...details, kind: "rejected", reason: rejection[wrapped.reason] };
}
function buildSpawnSpec(plan: ExecutablePlan, resolvedShell: ResolvedShellExecutable): ShellSpawnSpec {
  if (plan.kind === "sandboxed") return {
    command: plan.argv[0], args: plan.argv.slice(1), env: { ...plan.env }, cwd: plan.cwd,
    windowsVerbatimArguments: false, ranViaSandbox: true,
  };
  const invocation = buildDirectShellInvocation(resolvedShell, plan.command);
  return {
    command: invocation.command, args: invocation.args, env: { ...process.env }, cwd: plan.cwd,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments, ranViaSandbox: false,
  };
}

function executePlan(plan: ExecutablePlan, resolvedShell: ResolvedShellExecutable, signal?: AbortSignal,
  timeoutPolicy: ShellTimeoutPolicy = DEFAULT_TIMEOUT_POLICY, assertAllowed?: () => void,
  retainActualCompletion?: (completion: Promise<void>) => void): Promise<ShellResult> {
  return new Promise((deliver, fail) => {
    (async () => {
      const shell = plan.requestedShell;
      const command = plan.command;
      const cwd = plan.cwd;
      const launch = buildSpawnSpec(plan, resolvedShell);
      const sandboxed = launch.ranViaSandbox;
      assertAllowed?.();
      const processHandle = spawn(launch.command, launch.args, {
        cwd: launch.cwd || undefined, shell: false, windowsHide: true, env: launch.env,
        ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
        stdio: ["ignore", "pipe", "pipe"],
      });
      const closed = new Promise<void>(resolve => { processHandle.once("close", () => resolve()); });
      retainActualCompletion?.(closed);
      const capturedOut: Buffer[] = [], capturedErr: Buffer[] = [];
      let outSize = 0, errSize = 0, clipped = false;
      let delivered = false;
      let idle: NodeJS.Timeout | undefined, total: NodeJS.Timeout | undefined, grace: NodeJS.Timeout | undefined;
      const clearTimers = () => { clearTimeout(idle); clearTimeout(total); clearTimeout(grace); };
      const finish = (result: ShellResult) => {
        if (delivered) return;
        delivered = true;
        clearTimers();
        if (signal) signal.removeEventListener("abort", cancel);
        deliver(result);
      };
      type StopReason = "idle" | "total" | "cancelled";
      const explanation: Record<StopReason, string> = {
        idle: `命令连续 ${formatTimeoutMs(timeoutPolicy.idleMs ?? SHELL_IDLE_TIMEOUT_MS)} 无任何输出（疑似常驻进程或卡死）`,
        total: timeoutPolicy.explicitDeadline ? `命令超过 timeout_ms=${timeoutPolicy.totalMs} 毫秒执行上限` : `命令超过 ${formatTimeoutMs(timeoutPolicy.totalMs)} 总上限`,
        cancelled: "所在任务已被用户取消",
      };
      const suggestion: Record<StopReason, string> = {
        idle: "若这是正常的长时无输出任务（删除大目录/编译链接等），可传 timeout_ms 显式指定执行上限，设置后不再做无输出检测；若是需要长时间运行的进程，可改用 run_in_background:true 后台执行。",
        total: timeoutPolicy.explicitDeadline ? "如需更长时间，可增大 timeout_ms（1000–1800000 毫秒）后重试，或改用 run_in_background:true 后台执行。" : "如命令需要更长时间，可传 timeout_ms 参数（1000–1800000 毫秒）显式指定执行上限，或改用 run_in_background:true 后台执行。",
        cancelled: "",
      };
      let stopped: StopReason | null = null;
      const resultFacts = (code: number | null, error?: string) => {
        if (stopped === "cancelled") return shellFailure("E_ABORTED", "runtime_safety", "unknown");
        if (stopped !== null) return shellFailure("E_TOOL_TIMEOUT", "timeout", "unknown");
        if (error) return shellFailure("E_SHELL_SPAWN", "semantic_failure");
        return code === 0 ? { success: true } : shellFailure("E_SHELL_EXIT", "semantic_failure", "unknown");
      };
      const buildResult = (code: number | null, error?: string): ShellResult => ({
        ...resultFacts(code, error), shell, shellExecutable: resolvedShell.executable,
        exitCode: stopped !== null ? null : code,
        stderr: decodeShellOutput(capturedErr) + (stopped !== null ? `\n[已终止] ${explanation[stopped]}，进程树已被强制终止。${suggestion[stopped]}` : "")
          + (error ? "\n[spawn error] " + error + (sandboxed ? " [sandbox]" : "") : ""),
        stdout: decodeShellOutput(capturedOut), captureTruncated: clipped, ranViaSandbox: sandboxed, timedOut: stopped !== null,
      });
      const terminate = (why: StopReason) => {
        if (stopped !== null) return;
        stopped = why;
        console.warn(LOG_PREFIX, `run_shell 终止(${why})，kill 进程树:`, command);
        killTree(processHandle);
        grace = setTimeout(() => { finish(buildResult(null)); }, SHELL_KILL_GRACE_MS);
      };
      const resetIdle = () => {
        clearTimeout(idle);
        if (timeoutPolicy.idleMs === undefined) return;
        idle = setTimeout(() => terminate("idle"), timeoutPolicy.idleMs);
      };
      const cancel = () => terminate("cancelled");
      total = setTimeout(() => terminate("total"), timeoutPolicy.totalMs);
      resetIdle();
      if (signal) {
        if (signal.aborted) terminate("cancelled");
        else signal.addEventListener("abort", cancel, { once: true });
      }
      // 两条流各自保留预算，先重置空闲计时再采集。
      const capture = (data: Buffer, stderr: boolean) => {
        resetIdle();
        const count = stderr ? errSize : outSize;
        if (count >= SHELL_CAPTURE_LIMIT_PER_STREAM) { clipped = true; return; }
        (stderr ? capturedErr : capturedOut).push(data);
        if (stderr) errSize += data.length;
        else outSize += data.length;
        if ((stderr ? errSize : outSize) > SHELL_CAPTURE_LIMIT_PER_STREAM) clipped = true;
      };
      processHandle.stdout?.on("data", (data: Buffer) => capture(data, false));
      processHandle.stderr?.on("data", (data: Buffer) => capture(data, true));
      processHandle.on("error", error => { finish(buildResult(-1, error.message)); });
      processHandle.on("close", code => { finish(buildResult(code)); });
    })().catch(failure => {
      if (failure instanceof ToolExecutionError || (failure instanceof Error && failure.name === "AbortError")) { fail(failure); return; }
      const detail = failure instanceof Error ? failure.message : String(failure);
      deliver({ ...shellFailure("E_SHELL_SETUP", "semantic_failure"), shell: plan.requestedShell,
        exitCode: -1, stderr: "[executePlan internal error] " + detail, stdout: "",
        captureTruncated: false, ranViaSandbox: false, timedOut: false });
    });
  });
}

function retainShellCompletion(context: ToolContext | undefined, completion: Promise<void>): void {
  const active = context?.execution;
  if (!active) return;
  if (!active.permit) throw new Error("Shell process requires an active leaf permit");
  active.coordinator.retainUntil(active.permit, completion);
}
function resolveShellAccess(context: ToolContext | undefined, args: Record<string, unknown>): AgentFileAccessLevel {
  if (context?.conversationId && isPlanReadOnly(context.conversationId)) throw new ToolExecutionError("E_PLAN_READ_ONLY", "计划讨论与审阅期间不能执行 Shell 命令。", "permission_denied");
  if (context?.signal?.aborted) {
    const cancellation = new Error("Operation aborted"); cancellation.name = "AbortError"; throw cancellation;
  }
  if (context?.permissionMode === "allow_all") return "full";
  const live = getCurrentLevel();
  const intersection = [context?.fileAccessLevel ?? live, live];
  if (intersection.some(candidate => policyFor(candidate, "shell") === "ask") &&
    (context?.authorizedToolCall?.toolId !== "run_shell" || context.authorizedToolCall.args !== args || !context.authorizedToolCall.approvalRequired)) {
    throw new ToolExecutionError("E_PERMISSION_APPROVAL_REQUIRED", "此命令需要当前调用的审批授权。", "permission_denied");
  }
  for (const candidate of ["project-read-only", "read-only", "scoped", "per-action", "full"] as const) if (intersection.includes(candidate)) return candidate;
  throw new ToolExecutionError("E_PERMISSION_INVALID", "无效的文件权限档位。", "permission_denied");
}

function rejectedShell(command: string, cwd: string | undefined, shell: ShellKind, effect: ShellEffect, reason: string): string {
  return JSON.stringify({ ...shellFailure("E_SHELL_REJECTED", "permission_denied"), command, cwd, shell,
    exitCode: -1, timedOut: false, captureTruncated: false, effect, sandboxed: false,
    stderr: `[拒绝] ${reason}`, stdout: "" });
}
function serializeShellResult(result: ShellResult, command: string, cwd: string | undefined, effect: ShellEffect, sandboxed: boolean): string {
  return JSON.stringify({
    success: result.success, category: result.category, effectState: result.effectState, retryable: result.retryable,
    command, cwd, shell: result.shell, shellExecutable: result.shellExecutable, errorCode: result.errorCode,
    exitCode: result.exitCode, timedOut: result.timedOut, captureTruncated: result.captureTruncated,
    effect, sandboxed, stderr: result.stderr, stdout: result.stdout,
  });
}

async function executeRunShell(args: Record<string, unknown>, context?: ToolContext): Promise<string> {
  const command = String(args.command || "").trim();
  let cwd = args.cwd ? String(args.cwd) : undefined;
  const deadline = resolveTimeoutPolicy(args.timeout_ms);
  if (deadline.explicitDeadline) logger.info(LogTag.BuiltinTools, `[run_shell] explicit deadline: raw=${String(args.timeout_ms)} → total=${deadline.totalMs}ms, idle detection disabled`);
  const shell = args.shell === undefined || args.shell === "cmd" ? "cmd" : args.shell === "bash" ? "bash" : null;
  if (!command) return "[错误] command 不能为空";
  if (!shell) return JSON.stringify({ ...shellFailure("SHELL_UNSUPPORTED", "invalid_arguments"), command, cwd, shell: String(args.shell),
    exitCode: -1, timedOut: false, captureTruncated: false, effect: "unknown", sandboxed: false, stderr: "[SHELL_UNSUPPORTED] shell 仅支持 cmd 或 bash", stdout: "" });
  if (context?.signal?.aborted) return JSON.stringify({ ...shellFailure("E_ABORTED", "runtime_safety"), command, cwd, shell,
    exitCode: null, timedOut: true, captureTruncated: false, effect: "unknown", sandboxed: false, stderr: "所在任务已被用户取消", stdout: "" });
  if (isCatastrophicCommand(command)) {
    logger.info(LogTag.BuiltinTools, `[run_shell] rejected: catastrophic command="${command}"`);
    return rejectedShell(command, cwd, shell, "unknown", "该命令被系统禁止执行");
  }
  const level = resolveShellAccess(context, args);
  // 受限档位下，授权根目录由 Main 持有，不能由模型给出的 cwd 推导；full / allow_all 与无可信工作区的旧调用方保持原行为。
  const trustedRoot = level !== "full" ? context?.resolvedWorkspaceRoot : undefined;
  // 带会话快照的受限调用必须有可信工作区：否则沙箱根会退回到由模型 cwd 推导，与文件工具的 E_WORKSPACE_REQUIRED 保持一致。
  if (!trustedRoot && context?.fileAccessLevel !== undefined
    && (level === "project-read-only" || level === "read-only" || level === "scoped")) {
    return JSON.stringify({
      ...shellFailure("E_WORKSPACE_REQUIRED", "permission_denied"),
      command, cwd, shell, exitCode: -1,
      timedOut: false, captureTruncated: false, effect: "unknown", sandboxed: false,
      stderr: "[拒绝] 当前权限档位需要已绑定的工作区目录", stdout: "",
    });
  }
  const requestedCwd = cwd || trustedRoot;
  let sandboxWorkspaceRoot: string | undefined;
  if (trustedRoot) {
    sandboxWorkspaceRoot = resolveContainedPath(trustedRoot, trustedRoot) ?? undefined;
    const containedCwd = resolveContainedPath(trustedRoot, requestedCwd as string);
    if (!containedCwd || !sandboxWorkspaceRoot) {
      return JSON.stringify({
        ...shellFailure("E_SHELL_CWD_OUTSIDE_WORKSPACE", "permission_denied"),
        command, cwd, shell, exitCode: -1,
        timedOut: false, captureTruncated: false, effect: "unknown", sandboxed: false,
        stderr: "[拒绝] cwd 必须位于当前工作区内，且不能通过符号链接或联接越界", stdout: "",
      });
    }
    cwd = containedCwd;
  }
  const assertAllowed = (): void => {
    if (context?.execution) {
      if (!context.execution.permit) throw new Error("Shell process requires an active leaf permit");
      context.execution.coordinator.assertPermit(context.execution.permit, "exclusive");
    }
    if (resolveShellAccess(context, args) !== level) throw new ToolExecutionError("E_PERMISSION_CHANGED", "命令准备期间权限已变化，请重新授权此次调用。", "permission_denied");
    if (trustedRoot && (resolveContainedPath(trustedRoot, requestedCwd as string) !== cwd
      || resolveContainedPath(trustedRoot, trustedRoot) !== sandboxWorkspaceRoot)) {
      throw new ToolExecutionError("E_SHELL_CWD_OUTSIDE_WORKSPACE", "命令准备期间工作目录的真实路径已变化。", "permission_denied");
    }
  };
  const effect: ShellEffect = classifyShellEffect(command);
  logger.info(LogTag.BuiltinTools, `[run_shell] entry: command="${command}" cwd=${cwd || "(undefined)"} effect=${effect} level=${level}`);
  const resolvedShell = await resolveShellExecutable(shell);
  assertAllowed();
  if (!resolvedShell) return JSON.stringify({ ...shellFailure("BASH_UNAVAILABLE", "not_found"), command, cwd, shell,
    exitCode: -1, timedOut: false, captureTruncated: false, effect, sandboxed: false,
    stderr: "[BASH_UNAVAILABLE] 未找到可用的 Bash。请安装 Git Bash，并确保 bash.exe 可执行。", stdout: "" });
  if (args.run_in_background === true || args.run_in_background === "true") {
    const plan: ExecutionPlan = level === "full" ? { kind: "direct", command, cwd, requestedShell: shell } : await resolveExecutionPlan(command, cwd, shell, resolvedShell, level, sandboxWorkspaceRoot);
    assertAllowed();
    if (plan.kind === "rejected") return rejectedShell(command, cwd, shell, effect, plan.reason);
    const spec = buildSpawnSpec(plan, resolvedShell);
    assertAllowed();
    const started = startShellJob({ spec, command, shell, totalMs: deadline.totalMs,
      executionScope: context?.execution?.scope, signal: context?.execution ? context.signal : undefined });
    retainShellCompletion(context, started.completion);
    logger.info(LogTag.BuiltinTools, `[run_shell] background ${started.jobId} started: command="${command}" totalMs=${deadline.totalMs}`);
    return JSON.stringify({ success: true, command, cwd, shell, ranInBackground: true, jobId: started.jobId,
      logFile: started.logFile, status: "running", totalTimeoutMs: deadline.totalMs, sandboxed: spec.ranViaSandbox,
      note: "命令已在后台启动，不阻塞本轮。用 shell_job (action=status, job_id) 查询状态，可传 wait_ms=0-60000 阻塞等待；action=stop 终止。日志持续写入 logFile（stdout+stderr 合计上限 64MB，超限自动终止）。" });
  }
  if (level === "full") {
    logger.info(LogTag.BuiltinTools, `[run_shell] full level → direct ${shell} (no sandbox)`);
    const result = await executePlan({ kind: "direct", command, cwd, requestedShell: shell }, resolvedShell, context?.signal, deadline, assertAllowed, completion => retainShellCompletion(context, completion));
    logger.info(LogTag.BuiltinTools, `[run_shell] [full] done: exitCode=${result.exitCode} timedOut=${result.timedOut} stdout.len=${result.stdout.length} stderr.len=${result.stderr.length}`);
    return serializeShellResult(result, command, cwd, effect, false);
  }
  const plan = await resolveExecutionPlan(command, cwd, shell, resolvedShell, level, sandboxWorkspaceRoot);
  assertAllowed();
  if (plan.kind === "rejected") return rejectedShell(command, cwd, shell, effect, plan.reason);
  const result = await executePlan(plan, resolvedShell, context?.signal, deadline, assertAllowed, completion => retainShellCompletion(context, completion));
  logger.info(LogTag.BuiltinTools, `[run_shell] [${level}] done: exitCode=${result.exitCode} timedOut=${result.timedOut} stdout.len=${result.stdout.length} stderr.len=${result.stderr.length} sandboxed=${result.ranViaSandbox}`);
  return serializeShellResult(result, command, cwd, effect, result.ranViaSandbox);
}

export const runShellTool: ToolDefinition = {
  "id": "run_shell",
  "name": "执行命令",
  "description": "在用户电脑上执行一条 Shell 命令字符串。默认由 cmd.exe 解析；需要类 Unix 语法时可显式选择 bash。返回 exitCode + stdout + stderr。\n\ncmd 模式语义：\n- 管道：git status | findstr TODO\n- 重定向：npm run build > build.log 或 echo hello >> out.txt\n- 命令串联：cd src && dir 或 git add . && git commit -m msg\n- cmd 内建命令：dir / type / echo / del / copy / set 等可直接用\n- 环境变量：%VAR% 会被展开\n\nbash 模式语义：\n- 设置 shell=\"bash\"，可使用 pwd / grep / sed / awk、$VAR、POSIX 管道及脚本语法\n- 仅在检测到可用 Git Bash 时执行；不可用会明确返回 BASH_UNAVAILABLE，不会改用 cmd\n\n何时用：\n- git clone / git status / git log 等版本控制操作\n- npm install / npm run / pip install / node xxx.js 等开发操作\n- node --version / python --version 等查环境\n- 用户明确要求'跑一下这条命令'\n- 需要管道/重定向组合的命令\n- 建目录/建文件等文件工具做不到时的兜底（如 mkdir、echo 内容 > 文件、type nul > 新建空文件）\n\n不要用于：\n- 读文件 → read_file（更安全）\n- 列目录 → list_dir\n- 搜索代码内容 → search_text\n- 下载网页 → fetch_url\n- 启动常驻进程（dev server / npx serve / watch / tail -f）→ 前台模式会在 2 分钟无输出后被强制终止，确需后台长驻时传 run_in_background:true，随后用 shell_job 工具查询状态/终止\n- 能用专用工具完成的事\n\n超时行为：默认 2 分钟无任何输出即判卡死终止，30 分钟总上限。长时间无输出的任务（删除大目录/编译链接等）可传 timeout_ms（1000–1800000 毫秒）显式指定执行上限，设置后不再做无输出检测，仅受该上限约束。\n\n后台模式：传 run_in_background:true 后命令在后台启动，立即返回 jobId 与 logFile（输出流式写日志文件，stdout+stderr 合计上限 64MB，超限自动终止），不阻塞本轮对话。执行上限沿用 timeout_ms（未传则 30 分钟）。之后用 shell_job 工具查询状态（可带 wait_ms 阻塞等待）或终止任务。\n\n安全说明：非完全信任档位下，写副作用的命令会在沙箱中执行（限制文件系统访问范围）。灾难命令（format/shutdown/dd 等）一律拒绝。\n参数：command (完整命令行字符串，如 \"git status\")，cwd (可选工作目录)，shell (cmd 或 bash，默认 cmd)，timeout_ms (可选执行上限毫秒数，1000–1800000，设置后禁用无输出检测)，run_in_background (可选 true，后台执行并用 shell_job 管理)。",
  "enabled": true,
  "risk": "shell",
  "modes": [
    "code",
    "work"
  ],
  "effectKind": "unknown",
  "inputSchema": {
    "type": "object",
    "properties": {
      "command": {
        "type": "string",
        "description": "完整命令行字符串，如 \"git status\"、\"npm install\"、\"dir | findstr TODO\""
      },
      "cwd": {
        "type": "string",
        "description": "工作目录绝对路径，可选"
      },
      "shell": {
        "type": "string",
        "enum": [
          "cmd",
          "bash"
        ],
        "default": "cmd",
        "description": "命令解释器：cmd（默认，兼容旧命令）或 bash（需要用户已安装 Git Bash）"
      },
      "timeout_ms": {
        "type": "number",
        "description": "执行上限毫秒数，可选（1000–1800000，超出范围自动钳制）。语义=执行生命周期上限，超时进程树被强制终止；设置后不再做\"2 分钟无输出判卡死\"检测，适合删除大目录/编译链接等长时间无输出任务。不传则默认：2 分钟无输出判卡死 + 30 分钟总上限"
      },
      "run_in_background": {
        "type": "boolean",
        "description": "可选 true：后台执行命令，立即返回 jobId 与 logFile 不阻塞本轮。输出流式写日志文件（合计上限 64MB）。之后用 shell_job 工具查询状态（action=status，可带 wait_ms 阻塞等待 0–60000 毫秒）或终止（action=stop）。后台任务不受无输出检测，执行上限沿用 timeout_ms（未传则 30 分钟），取消本轮对话不杀后台任务"
      }
    },
    "required": [
      "command"
    ]
  },
  execute: executeRunShell,
};
