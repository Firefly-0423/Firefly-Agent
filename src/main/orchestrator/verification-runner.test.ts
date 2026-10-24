import { EventEmitter } from "node:events";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("cross-spawn", () => ({ default: vi.fn() }));
import spawn from "cross-spawn";
import { DEFAULT_TIMEOUT_MS_BY_TYPE, resolveBuiltinExecutable, VerificationRunner, type PermissionLevel, type VerificationStep } from "./verification-runner";

const step = (patch: Partial<VerificationStep> = {}): VerificationStep => ({ id: "unit", type: "test", packageRoot: process.cwd(), cwd: process.cwd(), trust: "builtin", executable: "fixture-cli", args: ["--check"], source: "firefly_config", ...patch });
const options = { permissionLevel: "full" as const };
let child: EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; killed: boolean; kill: ReturnType<typeof vi.fn> };
let runner: VerificationRunner;
beforeEach(() => {
  vi.useFakeTimers(); runner = new VerificationRunner();
  child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), killed: false, kill: vi.fn(() => { child.killed = true; return true; }) });
  vi.mocked(spawn).mockReset().mockReturnValue(child as never);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("verification permissions and executable resolution", () => {
  it.each(["project-read-only", "read-only", "scoped", "per-action", "full"] as PermissionLevel[])("allows builtins and requires custom approval at %s", level => {
    expect(runner.decidePermission(step(), level)).toEqual({ allowed: true, requiresApproval: false });
    expect(runner.decidePermission(step({ trust: "custom" }), level)).toEqual({ allowed: true, requiresApproval: true, reason: "custom 命令需要审批" });
    expect(runner.decidePermission(step({ trust: "workspace_script" }), level)).toEqual(level === "per-action"
      ? { allowed: true, requiresApproval: true, reason: "workspace_script 需要审批" }
      : { allowed: true, requiresApproval: false });
  });

  it("denies unknown trust and returns a normalized skipped result", async () => {
    const result = await runner.runStep(step({ trust: "unknown" as never }), options);
    expect(result).toMatchObject({ passed: false, skipped: true, exitCode: null, errorCode: "VERIFICATION_PERMISSION_DENIED", stderr: "未知验证命令信任级别", durationMs: 0 });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("returns approval required or rejected without starting a child", async () => {
    expect(await runner.runStep(step({ trust: "custom" }), options)).toMatchObject({ skipped: true, errorCode: "VERIFICATION_APPROVAL_REQUIRED", stderr: "custom 命令需要审批" });
    const approval = vi.fn(async () => false);
    expect(await runner.runStep(step({ trust: "custom" }), { ...options, onApprovalRequest: approval })).toMatchObject({ skipped: true, errorCode: "VERIFICATION_APPROVAL_REJECTED", stderr: "用户拒绝审批" });
    expect(approval).toHaveBeenCalledWith(step({ trust: "custom" }));
    expect(spawn).not.toHaveBeenCalled();
  });

  it("executes after approval and preserves executable, arguments and cwd", async () => {
    const pending = runner.runStep(step({ trust: "custom" }), { ...options, onApprovalRequest: async () => true });
    await Promise.resolve();
    expect(spawn).toHaveBeenCalledWith("fixture-cli", ["--check"], expect.objectContaining({ cwd: process.cwd(), shell: false, stdio: ["ignore", "pipe", "pipe"], env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: "1" }) }));
    child.emit("close", 0);
    expect(await pending).toMatchObject({ passed: true, skipped: false, exitCode: 0 });
  });

  it.each(["tsc", "vitest"])("resolves the local %s CLI and appends step arguments", async cli => {
    const executable = `builtin:${cli}`;
    const resolved = resolveBuiltinExecutable(executable, process.cwd())!;
    expect(resolved.executable).toBe(process.execPath);
    expect(path.isAbsolute(resolved.args[0])).toBe(true);
    expect(resolved.args.slice(1)).toEqual(cli === "vitest" ? ["run"] : []);
    const pending = runner.runStep(step({ executable }), options);
    expect(vi.mocked(spawn).mock.calls[0].slice(0, 2)).toEqual([process.execPath, [...resolved.args, "--check"]]);
    child.emit("close", 0); await pending;
  });

  it.each(["builtin:tsc", "builtin:vitest", "builtin:jest"])("rejects %s for a nonexistent working directory", async executable => {
    const cwd = path.join(process.cwd(), "nonexistent-verification-unit-directory");
    expect(resolveBuiltinExecutable(executable, cwd)).toBeNull();
    expect(await runner.runStep(step({ executable, cwd }), options)).toMatchObject({ skipped: true, errorCode: "VERIFICATION_EXECUTION_FAILED", stderr: `无法解析 builtin 执行入口: ${executable}` });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("passes ordinary executables through without adding arguments", () => {
    expect(resolveBuiltinExecutable("npm", process.cwd())).toEqual({ executable: "npm", args: [] });
  });
});

describe("verification execution", () => {
  it.each([0, 2, null])("normalizes exit code %s and captures both streams", async code => {
    const pending = runner.runStep(step(), options);
    child.stdout.emit("data", Buffer.from("hello")); child.stderr.emit("data", "warning");
    await vi.advanceTimersByTimeAsync(12); child.emit("close", code);
    expect(await pending).toEqual({ stepId: "unit", type: "test", passed: code === 0, skipped: false, trust: "builtin", executable: "fixture-cli", args: ["--check"], cwd: process.cwd(), exitCode: code, stdout: "hello", stderr: "warning", timedOut: false, durationMs: 12, ...(code === 0 ? {} : { errorCode: "VERIFICATION_EXECUTION_FAILED" }) });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("normalizes a synchronous spawn error", async () => {
    vi.mocked(spawn).mockImplementation(() => { throw new Error("spawn denied"); });
    expect(await runner.runStep(step(), options)).toMatchObject({ passed: false, skipped: false, exitCode: null, stderr: "spawn denied", errorCode: "VERIFICATION_EXECUTION_FAILED", timedOut: false });
  });

  it("normalizes asynchronous spawn errors and retains preceding output", async () => {
    const pending = runner.runStep(step(), options);
    child.stdout.emit("data", "partial"); child.stderr.emit("data", "warn");
    child.emit("error", new Error("ENOENT"));
    expect(await pending).toMatchObject({ stdout: "partial", stderr: "warn\n[spawn error] ENOENT", errorCode: "VERIFICATION_EXECUTION_FAILED", exitCode: null });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps exactly 6000 characters intact and truncates longer streams to head and tail", async () => {
    const pending = runner.runStep(step(), options);
    child.stdout.emit("data", "a".repeat(6000));
    child.stderr.emit("data", "h".repeat(4000) + "x" + "t".repeat(2000)); child.emit("close", 0);
    const result = await pending;
    expect(result.stdout).toBe("a".repeat(6000));
    expect(result.stderr).toBe("h".repeat(4000) + "\n... (truncated, total 6001 chars, head 4000 + tail 2000 kept)\n" + "t".repeat(2000));
  });

  it("caps capture independently per stream before rendering head and tail", async () => {
    const pending = runner.runStep(step(), options);
    const limit = 2 * 1024 * 1024;
    for (const stream of [child.stdout, child.stderr]) { stream.emit("data", "a".repeat(limit - 1)); stream.emit("data", "BC"); stream.emit("data", "discarded"); }
    child.emit("close", 0); const result = await pending;
    expect(result.stdout).toBe("a".repeat(4000) + `\n... (truncated, total ${limit} chars, head 4000 + tail 2000 kept)\n` + "a".repeat(1999) + "B");
    expect(result.stderr).toBe(result.stdout);
  });

  it.each(["typecheck", "lint", "build", "test"] as const)("uses the default %s deadline", async type => {
    const pending = runner.runStep(step({ type }), options);
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS_BY_TYPE[type] - 1);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.emit("close", null);
    expect(await pending).toMatchObject({ passed: false, timedOut: true, errorCode: "VERIFICATION_TIMEOUT" });
  });

  it("uses the explicit timeout and does not kill an already killed child twice", async () => {
    const signal = new AbortController();
    const pending = runner.runStep(step(), { ...options, defaultTimeoutMs: 10, signal: signal.signal });
    signal.abort(); await vi.advanceTimersByTimeAsync(10);
    expect(child.kill).toHaveBeenCalledTimes(1); child.emit("close", null);
    expect(await pending).toMatchObject({ timedOut: true, errorCode: "VERIFICATION_TIMEOUT" });
  });

  it("cancels a running child without claiming a timeout", async () => {
    const signal = new AbortController();
    const pending = runner.runStep(step(), { ...options, signal: signal.signal });
    signal.abort(); child.emit("close", null);
    expect(await pending).toMatchObject({ passed: false, timedOut: false, errorCode: "VERIFICATION_EXECUTION_FAILED" });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });
});

describe("verification plans", () => {
  it("returns not_run for an empty plan", async () => {
    expect(await runner.runPlan([], options)).toEqual({ status: "not_run", passed: false, steps: [] });
  });

  it("executes sequentially, continues after failures and suppresses repeated failures until reset", async () => {
    const first = step(), second = step({ id: "second", args: ["--second"] });
    const pending = runner.runPlan([first, second], options);
    expect(spawn).toHaveBeenCalledTimes(1); child.emit("close", 1); await vi.advanceTimersByTimeAsync(0);
    expect(spawn).toHaveBeenCalledTimes(2); child.emit("close", 0);
    const summary = await pending;
    expect(summary.status).toBe("failed"); expect(summary.steps.map(s => s.stepId)).toEqual(["unit", "second"]);
    const repeated = await runner.runPlan([first], options);
    expect(repeated.steps[0]).toMatchObject({ skipped: true, stderr: "同一失败指纹已执行过，不重复运行", errorCode: "VERIFICATION_EXECUTION_FAILED" });
    runner.resetFingerprints(); const retry = runner.runPlan([first], options); child.emit("close", 0);
    expect((await retry).status).toBe("passed");
  });

  it("gives approval_required precedence over other failed steps", async () => {
    const result = await runner.runPlan([step({ trust: "custom" }), step({ id: "bad", trust: "unknown" as never, args: [] })], options);
    expect(result).toMatchObject({ status: "approval_required", passed: false, errorCode: "VERIFICATION_APPROVAL_REQUIRED" });
    expect(spawn).not.toHaveBeenCalled();
  });
});
