import type { ExecutionScope } from "../../harness/execution-coordinator";
import { spawn, type ChildProcess } from "child_process";
import { app } from "electron";
import * as path from "path";
import * as fs from "fs";
import { logger, LogTag } from "../../../logger";
import { spawnWindowsShellJob } from "./windows-shell-job";

export const SHELL_JOB_LOG_MAX_BYTES = 64 * 1024 * 1024;
export const SHELL_JOB_TOTAL_TIMEOUT_MS = 30 * 60_000;
export const SHELL_JOB_TAIL_BYTES = 8192;
export const SHELL_JOB_WAIT_MAX_MS = 60_000;
const SHELL_JOB_LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type ShellJobStatus = "running" | "exited" | "timed_out" | "stopped" | "failed";
export interface ShellSpawnSpec {
  command: string; args: string[]; env: NodeJS.ProcessEnv; cwd?: string;
  windowsVerbatimArguments: boolean; ranViaSandbox: boolean;
}
export interface ShellJobSnapshot {
  // Direct Windows jobs expose the supervisor PID.
  jobId: string; pid: number | null; status: ShellJobStatus; processSettled: boolean;
  exitCode: number | null; reason: string | null; totalBytes: number;
  logFile: string; command: string; shell: string; startedAt: string; durationMs: number; tail: string;
}
interface ShellJob {
  jobId: string; command: string; shell: string; status: ShellJobStatus;
  exitCode: number | null; reason: string | null; totalBytes: number; logMaxBytes: number;
  logFile: string; logStream: fs.WriteStream; child?: ChildProcess; totalTimer?: NodeJS.Timeout;
  startedAtMs: number; startedAtIso: string; terminalWaiters: Set<() => void>;
  // Completion includes process close, log flush and direct Windows descendant cleanup.
  completion: Promise<void>; processSettled: boolean; executionScope?: Readonly<ExecutionScope>;
}
const jobs = new Map<string, ShellJob>();
const windowsJobs = new WeakSet<ChildProcess>();
let jobCounter = 0, lifecycleInstalled = false;

export function killTree(child: ChildProcess | undefined | null): void {
  if (!child || child.pid == null) return;
  // EOF asks the supervisor to terminate its Job Object and wait for all members.
  if (windowsJobs.has(child)) { child.stdin!.end(); return; }
  switch (process.platform) {
    case "win32":
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, shell: false, stdio: "ignore" });
      break;
    default:
      try { process.kill(-child.pid, "SIGKILL"); }
      catch { try { child.kill("SIGKILL"); } catch { /* 进程已结束。 */ } }
  }
}
function defaultJobsDir(): string { return path.join(app.getPath("userData"), "shell-jobs"); }
function formatJobTimestamp(): string {
  const current = new Date();
  const twoDigits = (part: number) => String(part).padStart(2, "0");
  return `${current.getFullYear()}${twoDigits(current.getMonth() + 1)}${twoDigits(current.getDate())}-${twoDigits(current.getHours())}${twoDigits(current.getMinutes())}${twoDigits(current.getSeconds())}`;
}

async function cleanupOldJobLogs(directory: string): Promise<void> {
  try {
    const entries = await fs.promises.readdir(directory);
    const expiredBefore = Date.now() - SHELL_JOB_LOG_RETENTION_MS;
    await Promise.all(entries.filter(entry => entry.endsWith(".log")).map(async entry => {
      const candidate = path.join(directory, entry);
      try {
        const attributes = await fs.promises.stat(candidate);
        if (attributes.mtimeMs < expiredBefore) await fs.promises.unlink(candidate);
      } catch { /* 单文件清理失败可忽略。 */ }
    }));
  } catch { /* 本轮无需清理。 */ }
}
function ensureLifecycle(directory: string): void {
  if (lifecycleInstalled) return;
  lifecycleInstalled = true;
  void cleanupOldJobLogs(directory);
  try { app.on("before-quit", () => disposeAllShellJobs()); }
  catch { /* 测试宿主可能没有应用事件。 */ }
}

function settleJob(record: ShellJob, next: Exclude<ShellJobStatus, "running">, update: { exitCode?: number | null; reason?: string | null } = {}): void {
  if (record.status !== "running") return;
  record.status = next;
  record.exitCode = next === "exited" ? (update.exitCode ?? null) : null;
  record.reason = update.reason ?? null;
  clearTimeout(record.totalTimer);
  try { record.logStream.end(); } catch { /* 流可能已关闭。 */ }
  for (const notify of record.terminalWaiters) notify();
  record.terminalWaiters.clear();
  logger.info(LogTag.BuiltinTools, `[shell_job] ${record.jobId} → ${next}${record.reason ? ` (${record.reason})` : ""} bytes=${record.totalBytes}`);
}
function appendJobOutput(record: ShellJob, data: Buffer): void {
  if (record.status !== "running") return;
  record.totalBytes += data.length;
  record.logStream.write(data);
  if (record.totalBytes >= record.logMaxBytes) {
    settleJob(record, "failed", { reason: "output_limit_exceeded" });
    killTree(record.child);
  }
}
function readLogTail(file: string): string {
  try {
    const bytes = fs.statSync(file).size;
    if (bytes === 0) return "";
    const count = Math.min(bytes, SHELL_JOB_TAIL_BYTES);
    const handle = fs.openSync(file, "r");
    try {
      const window = Buffer.alloc(count);
      fs.readSync(handle, window, 0, count, bytes - count);
      return window.toString("utf8");
    } finally { fs.closeSync(handle); }
  } catch { return ""; }
}
function snapshotJob(record: ShellJob): ShellJobSnapshot {
  return {
    jobId: record.jobId, pid: record.child?.pid ?? null, status: record.status,
    processSettled: record.processSettled, exitCode: record.exitCode, reason: record.reason,
    totalBytes: record.totalBytes, logFile: record.logFile, command: record.command,
    shell: record.shell, startedAt: record.startedAtIso, durationMs: Date.now() - record.startedAtMs,
    tail: readLogTail(record.logFile),
  };
}

export function startShellJob(opts: {
  spec: ShellSpawnSpec; command: string; shell: string; totalMs?: number; logDir?: string;
  logMaxBytes?: number; executionScope?: Readonly<ExecutionScope>; signal?: AbortSignal;
}): { jobId: string; logFile: string; completion: Promise<void> } {
  const directory = opts.logDir ?? defaultJobsDir();
  fs.mkdirSync(directory, { recursive: true });
  ensureLifecycle(directory);
  const id = `job-${formatJobTimestamp()}-${String(++jobCounter).padStart(3, "0")}`;
  const limit = opts.logMaxBytes ?? SHELL_JOB_LOG_MAX_BYTES;
  const file = path.join(directory, `${id}.log`);
  fs.closeSync(fs.openSync(file, "w"));
  const output = fs.createWriteStream(file, { flags: "w" });
  output.on("error", failure => logger.warn(LogTag.BuiltinTools, `[shell_job] 日志写入失败 ${id}: ${failure.message}`));
  let release!: () => void;
  const completed = new Promise<void>(resolve => { release = resolve; });
  let closedProcess = false, closedLog = false;
  const checkCompletion = () => {
    if (closedProcess && closedLog) { record.processSettled = true; release(); }
  };
  output.once("close", () => { closedLog = true; checkCompletion(); });
  const created = Date.now();
  const record: ShellJob = {
    jobId: id, command: opts.command, shell: opts.shell, status: "running", exitCode: null,
    reason: null, totalBytes: 0, logMaxBytes: limit, logFile: file, logStream: output,
    startedAtMs: created, startedAtIso: new Date(created).toISOString(), terminalWaiters: new Set(),
    completion: completed, processSettled: false,
    executionScope: opts.executionScope ? Object.freeze({ ...opts.executionScope }) : undefined,
  };
  jobs.set(id, record);
  const managedWindowsJob = process.platform === "win32" && !opts.spec.ranViaSandbox;
  const startupErrorFile = `${file}.startup-error`;
  const processHandle = managedWindowsJob
    ? spawnWindowsShellJob(opts.spec, startupErrorFile)
    : spawn(opts.spec.command, opts.spec.args, {
      cwd: opts.spec.cwd || undefined, shell: false, windowsHide: true,
      ...(process.platform !== "win32" ? { detached: true } : {}),
      env: opts.spec.env,
      ...(opts.spec.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      stdio: ["ignore", "pipe", "pipe"],
    });
  if (managedWindowsJob) windowsJobs.add(processHandle);
  record.child = processHandle;
  const duration = Math.min(Math.max(opts.totalMs ?? SHELL_JOB_TOTAL_TIMEOUT_MS, 1_000), SHELL_JOB_TOTAL_TIMEOUT_MS);
  record.totalTimer = setTimeout(() => {
    settleJob(record, "timed_out", { reason: "total_timeout_exceeded" });
    killTree(processHandle);
  }, duration);
  processHandle.stdout?.on("data", (data: Buffer) => appendJobOutput(record, data));
  processHandle.stderr?.on("data", (data: Buffer) => appendJobOutput(record, data));
  processHandle.on("error", failure => { settleJob(record, "failed", { reason: `spawn_error: ${failure.message}` }); });
  processHandle.on("close", code => {
    if (managedWindowsJob) {
      try {
        settleJob(record, "failed", { reason: `spawn_error: ${fs.readFileSync(startupErrorFile, "utf8")}` });
      } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code !== "ENOENT") {
          settleJob(record, "failed", { reason: "spawn_error: cannot read Windows containment status" });
        }
      }
      try { fs.unlinkSync(startupErrorFile); } catch { /* absent or already removed */ }
    }
    settleJob(record, "exited", { exitCode: code });
    closedProcess = true;
    checkCompletion();
  });
  if (opts.executionScope && opts.signal) {
    const cancellation = opts.signal;
    const cancel = () => { stopShellJob(id); };
    if (cancellation.aborted) cancel();
    else cancellation.addEventListener("abort", cancel, { once: true });
    const detach = () => cancellation.removeEventListener("abort", cancel);
    void completed.then(detach, detach);
  }
  logger.info(LogTag.BuiltinTools, `[shell_job] started ${id}: ${opts.command}`);
  return { jobId: id, logFile: file, completion: completed };
}

export function clampWaitMs(raw: unknown): number {
  const duration = Number(raw);
  return !Number.isFinite(duration) || duration <= 0 ? 0 : Math.min(Math.round(duration), SHELL_JOB_WAIT_MAX_MS);
}

export async function waitForShellJob(jobId: string, waitMs: number, signal?: AbortSignal): Promise<ShellJobSnapshot | null> {
  const record = jobs.get(jobId);
  if (!record) return null;
  if (record.status !== "running" || waitMs <= 0) return snapshotJob(record);
  await new Promise<void>(resolve => {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      clearTimeout(deadline);
      signal?.removeEventListener("abort", onCancel);
      record.terminalWaiters.delete(onEnd);
      resolve();
    };
    const onEnd = () => release();
    const onCancel = () => release();
    const deadline = setTimeout(release, waitMs);
    record.terminalWaiters.add(onEnd);
    if (signal) {
      if (signal.aborted) release();
      else signal.addEventListener("abort", onCancel, { once: true });
    }
  });
  return snapshotJob(record);
}

export function stopShellJob(jobId: string): ShellJobSnapshot | null {
  const record = jobs.get(jobId);
  if (!record) return null;
  if (record.status === "running") { settleJob(record, "stopped"); killTree(record.child); }
  return snapshotJob(record);
}
export function disposeAllShellJobs(): void {
  for (const record of jobs.values()) {
    if (record.status !== "running") continue;
    settleJob(record, "stopped", { reason: "app_exiting" });
    killTree(record.child);
  }
}
export function isShellJobControlAuthorized(jobId: string, scope: Readonly<ExecutionScope>): boolean {
  const original = jobs.get(jobId)?.executionScope;
  return Boolean(original && original.workspaceId === scope.workspaceId && original.parentRunId === scope.parentRunId);
}
