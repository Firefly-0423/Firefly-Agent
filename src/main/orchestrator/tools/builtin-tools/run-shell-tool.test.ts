import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ToolContext } from "../registry/tool-context";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), wrap: vi.fn(), level: vi.fn(), readOnly: vi.fn(), resolve: vi.fn(), direct: vi.fn(), kill: vi.fn(), background: vi.fn() }));
vi.mock("child_process", () => ({ spawn: mocks.spawn }));
vi.mock("../../sandbox/sandbox-exec", () => ({ wrapWithSandbox: mocks.wrap }));
vi.mock("../../../permission", () => ({ getCurrentLevel: mocks.level }));
vi.mock("../../plan-mode", () => ({ isPlanReadOnly: mocks.readOnly }));
vi.mock("../../shell-runtime", () => ({ resolveShellExecutable: mocks.resolve, buildDirectShellInvocation: mocks.direct }));
vi.mock("./shell-job-manager", () => ({ killTree: mocks.kill, startShellJob: mocks.background }));
vi.mock("../../../logger", () => ({ logger: { info: vi.fn(), warn: vi.fn() }, LogTag: { BuiltinTools: "tools" } }));

import { resolveTimeoutPolicy, runShellTool } from "./run-shell-tool";

class Child extends EventEmitter {
  stdout = new EventEmitter(); stderr = new EventEmitter();
}
let child: Child;
const ctx = (extra: Partial<ToolContext> = {}): ToolContext => ({ userQuery: "fixture", permissionMode: "allow_all", ...extra });
const run = async (args: Record<string, unknown>, context?: ToolContext) => JSON.parse(await runShellTool.execute(args, context));
async function launch(args: Record<string, unknown> = {}, context = ctx()) {
  const pending = run({ command: "echo fixture", ...args }, context);
  // Resolve interpreter lookup and permission rechecks before emitting OS events.
  for (let i = 0; i < 10 && mocks.spawn.mock.calls.length === 0; i++) await Promise.resolve();
  expect(mocks.spawn).toHaveBeenCalledTimes(1);
  return { pending };
}
beforeEach(() => {
  Object.values(mocks).forEach(mock => mock.mockReset());
  vi.useFakeTimers();
  child = new Child(); mocks.spawn.mockReturnValue(child);
  mocks.level.mockReturnValue("full"); mocks.readOnly.mockReturnValue(false);
  mocks.resolve.mockImplementation(async kind => ({ kind, executable: `${kind}.exe` }));
  mocks.direct.mockImplementation((shell, command) => ({ command: shell.executable, args: ["/c", command], windowsVerbatimArguments: shell.kind === "cmd" }));
  mocks.wrap.mockResolvedValue({ ok: true, argv: ["sandbox.exe", "wrapped"], env: { FIXTURE: "1" } });
  mocks.background.mockReturnValue({ jobId: "job-fixture", logFile: "fixture.log", completion: Promise.resolve() });
});
afterEach(() => { child.emit("close", 0); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("resolveTimeoutPolicy", () => {
  it.each([undefined, null, "", true, false, "bad", NaN, Infinity, -Infinity])("uses idle/total defaults for %s", raw => {
    expect(resolveTimeoutPolicy(raw)).toEqual({ idleMs: 120_000, totalMs: 1_800_000, explicitDeadline: false });
  });
  it.each([[0, 1000], [-1, 1000], [999, 1000], [1000, 1000], [1000.5, 1001], ["1500", 1500], [1_800_001, 1_800_000]])(
    "uses a clamped explicit deadline for %s", (raw, totalMs) => expect(resolveTimeoutPolicy(raw)).toEqual({ idleMs: undefined, totalMs, explicitDeadline: true }),
  );
});

describe("run_shell input and authorization", () => {
  it.each([{}, { command: " " }, { command: 0 }])("rejects empty commands %j", async args => {
    expect(await runShellTool.execute(args)).toBe("[错误] command 不能为空");
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it.each(["powershell", "CMD", null])("rejects unsupported shell %s", async shell => {
    expect(await run({ command: "echo fixture", shell })).toMatchObject({ success: false, errorCode: "SHELL_UNSUPPORTED", category: "invalid_arguments", effectState: "not_applied", retryable: false,
      exitCode: -1, stdout: "", stderr: "[SHELL_UNSUPPORTED] shell 仅支持 cmd 或 bash", timedOut: false, sandboxed: false });
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
  it("returns cancellation before resolving a shell", async () => {
    const ctrl = new AbortController(); ctrl.abort();
    expect(await run({ command: "echo fixture" }, ctx({ signal: ctrl.signal }))).toMatchObject({ errorCode: "E_ABORTED", exitCode: null, timedOut: true, effectState: "not_applied", stderr: "所在任务已被用户取消" });
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
  it("rejects catastrophic commands even in full trust mode", async () => {
    expect(await run({ command: "shutdown /s /t 0" }, ctx())).toMatchObject({ errorCode: "E_SHELL_REJECTED", category: "permission_denied", stderr: "[拒绝] 该命令被系统禁止执行" });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it("blocks plan read-only mode with an exact error code and message", async () => {
    mocks.readOnly.mockReturnValue(true);
    await expect(runShellTool.execute({ command: "echo fixture" }, ctx({ conversationId: "conversation" }))).rejects.toMatchObject({
      code: "E_PLAN_READ_ONLY", category: "permission_denied", message: "计划讨论与审阅期间不能执行 Shell 命令。",
    });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it("requires approval bound to this exact invocation", async () => {
    mocks.level.mockReturnValue("per-action"); const args = { command: "echo fixture" };
    for (const authorizedToolCall of [undefined, { toolId: "other", args, approvalRequired: true }, { toolId: "run_shell", args: { ...args }, approvalRequired: true }, { toolId: "run_shell", args, approvalRequired: false }]) {
      await expect(runShellTool.execute(args, { authorizedToolCall } as ToolContext)).rejects.toMatchObject({ code: "E_PERMISSION_APPROVAL_REQUIRED", message: "此命令需要当前调用的审批授权。" });
    }
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it("reports unavailable bash without trying another shell", async () => {
    mocks.resolve.mockResolvedValue(null);
    expect(await run({ command: "pwd", shell: "bash" }, ctx())).toMatchObject({ errorCode: "BASH_UNAVAILABLE", category: "not_found", shell: "bash", exitCode: -1,
      stderr: "[BASH_UNAVAILABLE] 未找到可用的 Bash。请安装 Git Bash，并确保 bash.exe 可执行。" });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it("rechecks permissions after asynchronous shell resolution", async () => {
    mocks.resolve.mockImplementationOnce(async () => { mocks.level.mockReturnValue("scoped"); return { kind: "cmd", executable: "cmd.exe" }; });
    await expect(runShellTool.execute({ command: "echo fixture" })).rejects.toMatchObject({ code: "E_PERMISSION_CHANGED", message: "命令准备期间权限已变化，请重新授权此次调用。" });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it.each(["disabled", "not_ready", "wrap_failed"])("fails closed for sandbox %s", async reason => {
    mocks.level.mockReturnValue("scoped"); mocks.wrap.mockResolvedValue({ ok: false, reason });
    const result = await run({ command: "git status", run_in_background: true });
    expect(result).toMatchObject({ success: false, errorCode: "E_SHELL_REJECTED", effectState: "not_applied", exitCode: -1, stdout: "", sandboxed: false });
    expect(mocks.spawn).not.toHaveBeenCalled(); expect(mocks.background).not.toHaveBeenCalled();
  });
  it("fails closed if the sandbox wrapper throws", async () => {
    mocks.level.mockReturnValue("scoped"); mocks.wrap.mockRejectedValue(new Error("broken wrapper"));
    expect(await run({ command: "git status" })).toMatchObject({ errorCode: "E_SHELL_REJECTED", stderr: "[拒绝] 沙箱包装异常，该命令已终止（未执行）" });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});

describe("foreground shell results", () => {
  it("defaults to cmd, trims the command, decodes UTF-8 and keeps stdout last", async () => {
    const { pending } = await launch({ command: " echo fixture ", cwd: "E:/fixture" });
    child.stdout.emit("data", Buffer.from("hello中")); child.stderr.emit("data", Buffer.from("warning")); child.emit("close", 0);
    const result = await pending;
    expect(result).toMatchObject({ success: true, command: "echo fixture", cwd: "E:/fixture", shell: "cmd", shellExecutable: "cmd.exe", exitCode: 0, stdout: "hello中", stderr: "warning", timedOut: false, captureTruncated: false, sandboxed: false });
    expect(Object.keys(result).at(-1)).toBe("stdout");
    expect(mocks.wrap).not.toHaveBeenCalled();
  });
  it.each([2, null])("reports nonzero/signalled exit %s as possibly applied", async code => {
    const { pending } = await launch(); child.emit("close", code);
    expect(await pending).toMatchObject({ success: false, errorCode: "E_SHELL_EXIT", category: "semantic_failure", effectState: "unknown", retryable: false, exitCode: code, timedOut: false });
  });
  it("reports spawn failures without claiming applied effects", async () => {
    const { pending } = await launch(); child.emit("error", new Error("ENOENT"));
    expect(await pending).toMatchObject({ errorCode: "E_SHELL_SPAWN", effectState: "not_applied", exitCode: -1, stderr: "\n[spawn error] ENOENT" });
  });
  it("reports synchronous setup failures", async () => {
    mocks.spawn.mockImplementation(() => { throw new Error("setup failed"); });
    expect(await run({ command: "echo fixture" }, ctx())).toMatchObject({ errorCode: "E_SHELL_SETUP", stderr: "[executePlan internal error] setup failed", effectState: "not_applied" });
  });
  it("executes a wrapped shell and reports sandbox telemetry", async () => {
    mocks.level.mockReturnValue("scoped");
    const { pending } = await launch({ shell: "bash" }, {} as ToolContext);
    child.stdout.emit("data", Buffer.from([0xd6, 0xd0])); child.emit("close", 0);
    expect(await pending).toMatchObject({ success: true, shell: "bash", stdout: "中", sandboxed: true });
    // 第五个参数是受信任的工作区根；本用例的上下文没有提供，因此为 undefined。
    expect(mocks.wrap).toHaveBeenCalledWith("echo fixture", undefined, "bash.exe", "scoped", undefined);
  });
  it("lets an approved per-action invocation run directly when the sandbox is disabled", async () => {
    mocks.level.mockReturnValue("per-action"); mocks.wrap.mockResolvedValue({ ok: false, reason: "disabled" });
    const args = { command: "echo fixture" };
    const pending = run(args, { userQuery: "fixture", authorizedToolCall: { toolId: "run_shell", args, approvalRequired: true } });
    for (let i = 0; i < 10 && mocks.spawn.mock.calls.length === 0; i++) await Promise.resolve();
    expect(mocks.spawn).toHaveBeenCalledTimes(1); child.emit("close", 0);
    expect(await pending).toMatchObject({ success: true, sandboxed: false });
  });
  it("enforces independent output budgets and preserves stderr when stdout overflows", async () => {
    const { pending } = await launch();
    child.stdout.emit("data", Buffer.alloc(2 * 1024 * 1024, 97));
    child.stdout.emit("data", Buffer.from("discarded")); child.stderr.emit("data", Buffer.from("important")); child.emit("close", 0);
    const result = await pending;
    expect(result.stdout).toBe("a".repeat(2 * 1024 * 1024)); expect(result.stderr).toBe("important"); expect(result.captureTruncated).toBe(true);
  });
  it("keeps output exactly at the capture limit without marking it truncated", async () => {
    const { pending } = await launch(); child.stderr.emit("data", Buffer.alloc(2 * 1024 * 1024, 98)); child.emit("close", 0);
    const result = await pending; expect(result.captureTruncated).toBe(false); expect(result.stderr.length).toBe(2 * 1024 * 1024);
  });
  it("returns deadline timeout after the kill grace period with partial output", async () => {
    const { pending } = await launch({ timeout_ms: 1000 }); child.stdout.emit("data", Buffer.from("partial"));
    await vi.advanceTimersByTimeAsync(1000); expect(mocks.kill).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await pending).toMatchObject({ errorCode: "E_TOOL_TIMEOUT", category: "timeout", effectState: "unknown", timedOut: true, exitCode: null, stdout: "partial" });
  });
  it("disables idle detection when an explicit deadline is supplied", async () => {
    const { pending } = await launch({ timeout_ms: 300_000 });
    await vi.advanceTimersByTimeAsync(120_001);
    expect(mocks.kill).not.toHaveBeenCalled();
    child.emit("close", 0); expect(await pending).toMatchObject({ success: true, timedOut: false });
  });
  it("removes cancellation handling after natural completion", async () => {
    const ctrl = new AbortController(); const { pending } = await launch({}, ctx({ signal: ctrl.signal }));
    child.emit("close", 0); await pending; ctrl.abort();
    await vi.advanceTimersByTimeAsync(1_800_000);
    expect(mocks.kill).not.toHaveBeenCalled();
  });
  it("resets idle detection on output and preserves timeout facts if close arrives first", async () => {
    const { pending } = await launch();
    await vi.advanceTimersByTimeAsync(119_999); child.stderr.emit("data", Buffer.from("alive"));
    await vi.advanceTimersByTimeAsync(119_999); expect(mocks.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); child.emit("close", 1);
    expect(await pending).toMatchObject({ errorCode: "E_TOOL_TIMEOUT", timedOut: true, exitCode: null, stderr: expect.stringContaining("连续 2 分钟") });
  });
  it("reports cancellation separately from a deadline and removes listeners after completion", async () => {
    const ctrl = new AbortController(); const { pending } = await launch({}, ctx({ signal: ctrl.signal }));
    ctrl.abort(); child.emit("close", 1);
    expect(await pending).toMatchObject({ errorCode: "E_ABORTED", category: "runtime_safety", effectState: "unknown", timedOut: true, exitCode: null, stderr: expect.stringContaining("所在任务已被用户取消") });
    expect(mocks.kill).toHaveBeenCalledTimes(1);
  });
});

describe("background shell", () => {
  it.each([true, "true"])("returns job metadata immediately for background=%s", async run_in_background => {
    const result = await run({ command: "echo fixture", run_in_background, timeout_ms: 2500 }, ctx());
    expect(result).toMatchObject({ success: true, ranInBackground: true, jobId: "job-fixture", logFile: "fixture.log", status: "running", totalTimeoutMs: 2500, sandboxed: false });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it("retains actual background completion with the trusted execution permit", async () => {
    const retainUntil = vi.fn(); const assertPermit = vi.fn(); const permit = { id: "permit" };
    const scope = { workspaceId: "w", parentRunId: "p" };
    const ctrl = new AbortController();
    const context = ctx({ signal: ctrl.signal, execution: { coordinator: { retainUntil, assertPermit }, scope, permit } as unknown as ToolContext["execution"] });
    await run({ command: "echo fixture", run_in_background: true }, context);
    expect(retainUntil).toHaveBeenCalledWith(permit, mocks.background.mock.results[0].value.completion);
    expect(mocks.background.mock.calls[0][0]).toMatchObject({ executionScope: scope, signal: ctrl.signal });
  });
});
