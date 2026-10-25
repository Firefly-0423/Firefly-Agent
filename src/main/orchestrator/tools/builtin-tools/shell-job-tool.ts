import type { ToolDefinition } from "../registry/tool-registry";
import type { ToolContext } from "../registry/tool-context";
import { clampWaitMs, stopShellJob, waitForShellJob } from "./shell-job-manager";
import { LogTag, logger } from "../../../logging/logger";

const STATUS_HINTS: Record<string, string> = {
  "running": "任务仍在执行。对比两次查询的 totalBytes 增量可判断活跃度：有增量=正常在跑；连续多次零增量且非预期静默任务=疑似卡死，可考虑 action=stop。",
  "exited": "任务已自然退出。exitCode=0 成功；非 0 失败，tail 里有错误输出。",
  "timed_out": "任务超过执行上限被强制终止。",
  "stopped": "任务被用户/应用主动终止。",
  "failed": "任务异常终止（输出超 64MB 上限或 spawn 失败），见 reason 字段。",
};

function missingJob(action: string, identity: string): string {
  logger.warn(LogTag.BuiltinTools, `[shell_job] ${action} unknown job: ${identity}`);
  return JSON.stringify({
    action, jobId: identity, errorCode: "JOB_NOT_FOUND",
    error: `未找到任务 ${identity}。任务可能来自其他应用会话（后台任务注册表不跨重启存活），请用 run_shell 重新启动命令。`,
    exitCode: -1, stdout: "", stderr: `[JOB_NOT_FOUND] 未找到任务 ${identity}`,
  });
}
async function executeShellJob(input: Record<string, unknown>, context?: ToolContext): Promise<string> {
  const received = Object.keys(input).join(", ") || "(无)";
  const operation = input.action === "stop" ? "stop" : "status";
  const identity = String(input.job_id ?? "").trim();
  if (!identity) return JSON.stringify({
    action: operation, errorCode: "MISSING_JOB_ID", error: "job_id 不能为空。请传 run_shell 后台模式返回的 jobId。",
    receivedParams: received, exitCode: -1, stdout: "",
    stderr: "[错误] job_id 不能为空（实际收到参数：" + received + "）",
  });
  if (operation === "stop") {
    const current = stopShellJob(identity);
    if (!current) return missingJob(operation, identity);
    logger.info(LogTag.BuiltinTools, `[shell_job] stop ${identity} → ${current.status}`);
    return JSON.stringify({
      action: operation, jobId: identity, pid: current.pid, stopped: current.status === "stopped",
      status: current.status, processSettled: current.processSettled, exitCode: current.exitCode, reason: current.reason,
      totalBytes: current.totalBytes, logFile: current.logFile, command: current.command, shell: current.shell,
      startedAt: current.startedAt, durationMs: current.durationMs, tail: current.tail,
    });
  }
  const duration = clampWaitMs(input.wait_ms);
  const current = await waitForShellJob(identity, duration, context?.signal);
  if (!current) return missingJob(operation, identity);
  if (duration > 0) logger.info(LogTag.BuiltinTools, `[shell_job] status ${identity} (waited≤${duration}ms) → ${current.status}`);
  return JSON.stringify({
    action: operation, jobId: identity, pid: current.pid, waitedMs: duration,
    status: current.status, processSettled: current.processSettled, exitCode: current.exitCode, reason: current.reason,
    totalBytes: current.totalBytes, logFile: current.logFile, command: current.command, shell: current.shell,
    startedAt: current.startedAt, durationMs: current.durationMs, statusHint: STATUS_HINTS[current.status] ?? "", tail: current.tail,
  });
}

export const shellJobTool: ToolDefinition = {
  "id": "shell_job",
  "name": "后台任务管理",
  "description": "查询或终止 run_shell 后台任务（run_in_background:true 启动的命令）。\n\n何时用：\n- run_shell 返回 jobId 后想知道命令跑完没有 → action=status\n- 需要等一个后台命令出结果再继续 → action=status + wait_ms（阻塞等待，任务到终态提前返回）\n- 后台任务卡死/不再需要 → action=stop（幂等，已终止的任务直接返回终态）\n\n状态含义（五态）：running=执行中 / exited=自然退出（看 exitCode）/ timed_out=超时终止 / stopped=主动终止 / failed=异常终止（输出超限或启动失败，看 reason）。\n\n判活技巧：status 返回 totalBytes（累计输出字节数）+ tail（日志最后 8KB）。两次查询 totalBytes 有增量说明任务真在跑；长时间零增量且任务本应持续输出则可能卡死。\n完整日志在 run_shell 返回的 logFile 路径，需要全文时用 read_file 读取。\n\n参数：action（status 或 stop，默认 status），job_id（run_shell 后台模式返回的任务 ID），wait_ms（可选，仅 status：阻塞等待毫秒数 0–60000，超范围自动钳制，默认 0 立即返回）。",
  "enabled": true,
  "risk": "safe",
  "modes": [
    "code",
    "work"
  ],
  "effectKind": "unknown",
  "ledgerPolicy": "bypass",
  "needsContext": true,
  "inputSchema": {
    "type": "object",
    "properties": {
      "action": {
        "type": "string",
        "enum": [
          "status",
          "stop"
        ],
        "default": "status",
        "description": "status=查询任务状态（可带 wait_ms 阻塞等待）；stop=终止任务（幂等）"
      },
      "job_id": {
        "type": "string",
        "description": "run_shell run_in_background:true 返回的 jobId，如 \"job-20260906-103000-001\""
      },
      "wait_ms": {
        "type": "number",
        "description": "仅 action=status：阻塞等待毫秒数（0–60000，超范围自动钳制，默认 0 立即返回当前快照）。任务先到终态则提前返回"
      }
    },
    "required": [
      "job_id"
    ]
  },
  execute: executeShellJob,
};
