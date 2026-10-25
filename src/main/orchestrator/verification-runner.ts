import spawn from "cross-spawn";
import * as path from "path";
import * as fs from "fs";
import { policyFor, type AgentFileAccessLevel } from "../permission/permission-policy";

export type VerificationType = "typecheck" | "test" | "lint" | "build";
export type VerificationCommandTrust = "builtin" | "workspace_script" | "custom";
export type PermissionLevel = AgentFileAccessLevel;
export type VerificationSummaryStatus = "passed" | "failed" | "not_run" | "approval_required" | "plan_not_found";
export interface VerificationStep {
  source: "firefly_config" | "package_script" | "tsconfig" | "vitest" | "jest" | "builtin_fallback";
  args: string[];
  executable: string;
  trust: VerificationCommandTrust;
  configPath?: string;
  cwd: string;
  packageRoot: string;
  type: VerificationType;
  id: string;
}
export interface VerificationResult {
  errorCode?: string;
  durationMs: number;
  timedOut: boolean;
  stderr: string;
  stdout: string;
  exitCode: number | null;
  cwd: string;
  args: string[];
  executable: string;
  trust: VerificationCommandTrust;
  skipped: boolean;
  passed: boolean;
  type: VerificationType;
  stepId: string;
}
export interface VerificationSummary {
  errorCode?: "VERIFICATION_PLAN_NOT_FOUND" | "VERIFICATION_CONFIG_INVALID" | "VERIFICATION_APPROVAL_REQUIRED"
    | "VERIFICATION_APPROVAL_REJECTED" | "VERIFICATION_PERMISSION_DENIED" | "VERIFICATION_TIMEOUT" | "VERIFICATION_EXECUTION_FAILED";
  steps: VerificationResult[];
  passed: boolean;
  status: VerificationSummaryStatus;
}
export interface VerificationPermissionDecision { reason?: string; requiresApproval: boolean; allowed: boolean }
export interface RunnerOptions {
  defaultTimeoutMs?: number;
  signal?: AbortSignal;
  onApprovalRequest?: (step: VerificationStep) => Promise<boolean>;
  permissionLevel: PermissionLevel;
}
export const DEFAULT_TIMEOUT_MS_BY_TYPE: Record<VerificationType, number> = {
  typecheck: 2 * 60_000, lint: 2 * 60_000, build: 5 * 60_000, test: 10 * 60_000,
};
const perStreamLimit = 2 * 1024 * 1024;

function isWithinPath(candidate: string, root: string): boolean {
  const suffix = path.relative(root, candidate);
  return suffix === "" || (!suffix.startsWith("..") && !path.isAbsolute(suffix));
}
function isLocalDependencyCli(cliPath: string, cwd: string): boolean {
  if (!path.isAbsolute(cliPath) || !fs.existsSync(cliPath)) return false;
  let entry: string, directory: string;
  try { entry = fs.realpathSync(cliPath); directory = fs.realpathSync(cwd); } catch { return false; }
  for (;;) {
    const manifest = path.join(directory, "package.json");
    const dependencies = path.join(directory, "node_modules");
    if (fs.existsSync(manifest) && fs.existsSync(dependencies)) {
      try { if (isWithinPath(entry, fs.realpathSync(dependencies))) return true; } catch { /* 再尝试父目录。 */ }
    }
    const parent = path.dirname(directory);
    if (parent === directory) return false;
    directory = parent;
  }
}

export function resolveBuiltinExecutable(executable: string, cwd: string, configPath?: string): { executable: string; args: string[] } | null {
  const local = (entry: string, suffix: string[] = []) => isLocalDependencyCli(entry, cwd) ? { executable: process.execPath, args: [entry, ...suffix] } : null;
  if (executable === "builtin:tsc") {
    try { return local(require.resolve("typescript/bin/tsc", { paths: [cwd] })); } catch { return null; }
  }
  if (executable === "builtin:vitest") {
    try { return local(require.resolve("vitest/vitest.mjs", { paths: [cwd] }), ["run"]); }
    catch {
      try {
        const manifest = require.resolve("vitest/package.json", { paths: [cwd] });
        return local(path.join(path.dirname(manifest), "vitest.mjs"), ["run"]);
      } catch { return null; }
    }
  }
  if (executable === "builtin:jest") {
    try { return local(require.resolve("jest/bin/jest.js", { paths: [cwd] })); } catch { return null; }
  }
  return { executable, args: [] };
}
function truncateOutput(s: string, headLen = 4000, tailLen = 2000): string {
  if (s.length <= headLen + tailLen) return s;
  const marker = `\n... (truncated, total ${s.length} chars, head ${headLen} + tail ${tailLen} kept)\n`;
  return s.slice(0, headLen) + marker + s.slice(-tailLen);
}
function skippedStep(step: VerificationStep, stderr: string, errorCode: string): VerificationResult {
  return { stepId: step.id, type: step.type, passed: false, skipped: true, trust: step.trust, executable: step.executable,
    args: step.args, cwd: step.cwd, exitCode: null, stdout: "", stderr, timedOut: false, durationMs: 0, errorCode };
}

export class VerificationRunner {
  private readonly attempted = new Set<string>();
  decidePermission(step: VerificationStep, permissionLevel: PermissionLevel): VerificationPermissionDecision {
    switch (step.trust) {
      case "builtin": return { allowed: true, requiresApproval: false };
      case "custom": return { allowed: true, requiresApproval: true, reason: "custom 命令需要审批" };
      case "workspace_script": {
        const policy = policyFor(permissionLevel, "shell");
        if (policy === "allow") return { allowed: true, requiresApproval: false };
        if (policy === "ask") return { allowed: true, requiresApproval: true, reason: "workspace_script 需要审批" };
        return { allowed: false, requiresApproval: false, reason: "当前权限档位不允许执行 workspace script" };
      }
      default: return { allowed: false, requiresApproval: false, reason: "未知验证命令信任级别" };
    }
  }
  async runStep(step: VerificationStep, options: RunnerOptions): Promise<VerificationResult> {
    const access = this.decidePermission(step, options.permissionLevel);
    if (!access.allowed) return skippedStep(step, access.reason ?? "permission denied", access.requiresApproval ? "VERIFICATION_APPROVAL_REQUIRED" : "VERIFICATION_PERMISSION_DENIED");
    if (access.requiresApproval && !options.onApprovalRequest) return skippedStep(step, access.reason ?? "需要用户审批", "VERIFICATION_APPROVAL_REQUIRED");
    if (access.requiresApproval && options.onApprovalRequest) {
      const permitted = await options.onApprovalRequest(step);
      if (!permitted) return skippedStep(step, "用户拒绝审批", "VERIFICATION_APPROVAL_REJECTED");
    }
    const resolved = resolveBuiltinExecutable(step.executable, step.cwd, step.configPath);
    if (step.executable.startsWith("builtin:") && !resolved) return skippedStep(step, `无法解析 builtin 执行入口: ${step.executable}`, "VERIFICATION_EXECUTION_FAILED");
    const command = resolved ?? { executable: step.executable, args: step.args };
    const arguments_ = [...command.args, ...step.args];
    return this.executeCommand(step, command.executable, arguments_, options);
  }
  async runPlan(steps: VerificationStep[], options: RunnerOptions): Promise<VerificationSummary> {
    if (steps.length === 0) return { status: "not_run", passed: false, steps: [] };
    const outcomes: VerificationResult[] = [];
    for (const step of steps) {
      const identity = this.fingerprint(step);
      if (this.attempted.has(identity)) {
        outcomes.push(skippedStep(step, "同一失败指纹已执行过，不重复运行", "VERIFICATION_EXECUTION_FAILED"));
        continue;
      }
      const outcome = await this.runStep(step, options);
      outcomes.push(outcome);
      this.attempted.add(identity);
    }
    const passed = outcomes.every((outcome) => outcome.passed);
    const approval = outcomes.some((outcome) => outcome.errorCode === "VERIFICATION_APPROVAL_REQUIRED");
    const status: VerificationSummaryStatus = approval ? "approval_required" : passed ? "passed" : "failed";
    const errorCode: VerificationSummary["errorCode"] = approval ? "VERIFICATION_APPROVAL_REQUIRED" : undefined;
    return { status, passed, steps: outcomes, errorCode };
  }
  resetFingerprints(): void { this.attempted.clear(); }
  private fingerprint(step: VerificationStep): string { return [step.type, step.cwd, step.executable, step.args.join("\x00")].join("|"); }

  private executeCommand(step: VerificationStep, executable: string, args: string[], options: RunnerOptions): Promise<VerificationResult> {
    const began = Date.now();
    const timeout = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS_BY_TYPE[step.type];
    return new Promise((complete) => {
      let output = "", errors = "", expired = false;
      let process_: ReturnType<typeof spawn> | null = null;
      try {
        const environment = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
        process_ = spawn(executable, args, { cwd: step.cwd, env: environment, shell: false, stdio: ["ignore", "pipe", "pipe"] });
      } catch (failure) {
        complete({ stepId: step.id, type: step.type, passed: false, skipped: false, trust: step.trust, executable: step.executable,
          args: step.args, cwd: step.cwd, exitCode: null, stdout: "", stderr: (failure as Error).message, timedOut: false,
          durationMs: Date.now() - began, errorCode: "VERIFICATION_EXECUTION_FAILED" });
        return;
      }
      const deadline = setTimeout(() => { expired = true; if (process_ && !process_.killed) process_.kill("SIGTERM"); }, timeout);
      if (options.signal) options.signal.addEventListener("abort", () => { if (process_ && !process_.killed) process_.kill("SIGTERM"); }, { once: true });
      process_.stdout?.on("data", (part) => {
        if (output.length >= perStreamLimit) return;
        output += part.toString();
        if (output.length > perStreamLimit) output = output.slice(0, perStreamLimit);
      });
      process_.stderr?.on("data", (part) => {
        if (errors.length >= perStreamLimit) return;
        errors += part.toString();
        if (errors.length > perStreamLimit) errors = errors.slice(0, perStreamLimit);
      });
      process_.on("error", (failure) => {
        clearTimeout(deadline);
        complete({ stepId: step.id, type: step.type, passed: false, skipped: false, trust: step.trust, executable: step.executable,
          args: step.args, cwd: step.cwd, exitCode: null, stdout: truncateOutput(output), stderr: truncateOutput(errors) + `\n[spawn error] ${failure.message}`,
          timedOut: false, durationMs: Date.now() - began, errorCode: "VERIFICATION_EXECUTION_FAILED" });
      });
      process_.on("close", (code) => {
        clearTimeout(deadline);
        const elapsed = Date.now() - began;
        const outcome: VerificationResult = { stepId: step.id, type: step.type, passed: code === 0, skipped: false, trust: step.trust,
          executable: step.executable, args: step.args, cwd: step.cwd, exitCode: code, stdout: truncateOutput(output), stderr: truncateOutput(errors), timedOut: expired, durationMs: elapsed };
        if (expired) outcome.errorCode = "VERIFICATION_TIMEOUT";
        else if (code !== 0) outcome.errorCode = "VERIFICATION_EXECUTION_FAILED";
        complete(outcome);
      });
    });
  }
}
