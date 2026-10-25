import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), getPath: vi.fn(), on: vi.fn() }));
vi.mock("child_process", () => ({ spawn: mocks.spawn }));
vi.mock("electron", () => ({ app: { getPath: mocks.getPath, on: mocks.on } }));
vi.mock("../../../logging/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn() }, LogTag: { BuiltinTools: "tools" } }));

type Manager = typeof import("./shell-job-manager");
class Child extends EventEmitter {
  pid = 12345;
  stdin = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() });
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
}
let manager: Manager;
let dir: string;
let children: Child[];
let completions: Promise<void>[];
const scope = { workspaceId: "workspace", parentRunId: "parent", groupId: "group", agentId: "agent", childRunId: "child", toolCallId: "tool" };
function start(extra: Partial<Parameters<Manager["startShellJob"]>[0]> = {}) {
  const job = manager.startShellJob({ command: "echo fixture", shell: "cmd",
    spec: { command: "fixture.exe", args: ["arg"], env: { FIXTURE: "yes" }, cwd: dir, windowsVerbatimArguments: false, ranViaSandbox: false },
    logDir: dir, ...extra });
  completions.push(job.completion);
  return { ...job, child: children.at(-1)! };
}
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(new Date("2026-01-02T03:04:05Z"));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-manager-unit-"));
  children = []; completions = [];
  mocks.getPath.mockReturnValue(dir);
  mocks.spawn.mockImplementation((command: string) => {
    const child = new Child();
    if (command !== "taskkill") children.push(child);
    return child;
  });
  manager = await import("./shell-job-manager");
});
afterEach(async () => {
  manager?.disposeAllShellJobs();
  for (const child of children) child.emit("close", 0);
  await Promise.all(completions);
  vi.useRealTimers(); vi.restoreAllMocks();
  // Only the unique directory created by this test is removed.
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("clampWaitMs", () => {
  it.each([[undefined, 0], [null, 0], ["", 0], ["bad", 0], [NaN, 0], [Infinity, 0], [-1, 0], [0, 0],
    [0.49, 0], [0.5, 1], ["1.5", 2], [60_000, 60_000], [60_001, 60_000]])("clamps %s to %s", (raw, expected) => {
    expect(manager.clampWaitMs(raw)).toBe(expected);
  });
});

describe("shell job lifecycle", () => {
  it("returns a running snapshot immediately and flushes ordered stdout/stderr on exit", async () => {
    const job = start();
    expect(fs.existsSync(job.logFile)).toBe(true);
    expect(await manager.waitForShellJob(job.jobId, 0)).toMatchObject({
      jobId: job.jobId, pid: 12345, status: "running", processSettled: false, exitCode: null, reason: null,
      totalBytes: 0, command: "echo fixture", shell: "cmd", startedAt: "2026-01-02T03:04:05.000Z", durationMs: 0, tail: "",
    });
    job.child.stdout.emit("data", Buffer.from("first中"));
    job.child.stderr.emit("data", Buffer.from("last"));
    await vi.advanceTimersByTimeAsync(25);
    job.child.emit("close", 7); await job.completion;
    const snapshot = await manager.waitForShellJob(job.jobId, 0);
    expect(snapshot).toMatchObject({ status: "exited", exitCode: 7, totalBytes: Buffer.byteLength("first中last"), tail: "first中last", processSettled: true, durationMs: 25 });
    expect(Object.keys(snapshot!).at(-1)).toBe("tail");
    expect(fs.readFileSync(job.logFile, "utf8")).toBe("first中last");
  });
  it("returns null for unknown jobs and denies unknown control", async () => {
    expect(await manager.waitForShellJob("missing", 60_000)).toBeNull();
    expect(manager.stopShellJob("missing")).toBeNull();
    expect(manager.isShellJobControlAuthorized("missing", scope)).toBe(false);
  });
  it("keeps only the last 8192 bytes in snapshots", async () => {
    const job = start();
    job.child.stdout.emit("data", Buffer.from("prefix" + "z".repeat(manager.SHELL_JOB_TAIL_BYTES)));
    job.child.emit("close", 0); await job.completion;
    expect((await manager.waitForShellJob(job.jobId, 0))?.tail).toBe("z".repeat(8192));
  });
  it("returns an empty tail if the log disappears", async () => {
    const job = start(); job.child.emit("close", 0); await job.completion;
    fs.unlinkSync(job.logFile);
    expect((await manager.waitForShellJob(job.jobId, 0))?.tail).toBe("");
  });
  it("uses a unique ID for jobs created at the same instant", () => {
    const a = start(); const b = start();
    expect(a.jobId).not.toBe(b.jobId);
    expect(a.logFile).not.toBe(b.logFile);
  });
  it("uses the Electron user-data directory by default and installs one quit hook", async () => {
    const a = start({ logDir: undefined }); const b = start({ logDir: undefined });
    expect(a.logFile).toBe(path.join(dir, "shell-jobs", `${a.jobId}.log`));
    expect(mocks.getPath).toHaveBeenCalledWith("userData");
    expect(mocks.on.mock.calls.filter(([event]) => event === "before-quit")).toHaveLength(1);
    mocks.on.mock.calls[0][1]();
    for (const job of [a, b]) expect(await manager.waitForShellJob(job.jobId, 0)).toMatchObject({ status: "stopped", reason: "app_exiting" });
  });
  it("stops idempotently, ignores late output/exit and waits for actual close", async () => {
    const job = start(); let completed = false;
    void job.completion.then(() => { completed = true; });
    expect(manager.stopShellJob(job.jobId)).toMatchObject({ status: "stopped", exitCode: null, processSettled: false });
    expect(manager.stopShellJob(job.jobId)?.status).toBe("stopped");
    job.child.stdout.emit("data", Buffer.from("late"));
    await Promise.resolve(); expect(completed).toBe(false);
    job.child.emit("close", 9); await job.completion;
    expect(await manager.waitForShellJob(job.jobId, 0)).toMatchObject({ status: "stopped", totalBytes: 0, exitCode: null, processSettled: true });
  });
  it.each([0, 999, 1000])("clamps short total timeout %s to one second", async totalMs => {
    const job = start({ totalMs });
    await vi.advanceTimersByTimeAsync(999);
    expect((await manager.waitForShellJob(job.jobId, 0))?.status).toBe("running");
    await vi.advanceTimersByTimeAsync(1);
    expect(await manager.waitForShellJob(job.jobId, 0)).toMatchObject({ status: "timed_out", reason: "total_timeout_exceeded", exitCode: null });
    job.child.emit("close", 0); await job.completion;
    expect(manager.stopShellJob(job.jobId)?.status).toBe("timed_out");
  });
  it.each([undefined, 9_999_999])("defaults/caps total timeout at 30 minutes: %s", async totalMs => {
    const job = start({ totalMs });
    await vi.advanceTimersByTimeAsync(manager.SHELL_JOB_TOTAL_TIMEOUT_MS - 1);
    expect((await manager.waitForShellJob(job.jobId, 0))?.status).toBe("running");
    await vi.advanceTimersByTimeAsync(1);
    expect((await manager.waitForShellJob(job.jobId, 0))?.status).toBe("timed_out");
  });
  it("fails at the combined output limit and discards later chunks", async () => {
    const job = start({ logMaxBytes: 6 });
    job.child.stdout.emit("data", Buffer.from("abc"));
    expect((await manager.waitForShellJob(job.jobId, 0))?.status).toBe("running");
    job.child.stderr.emit("data", Buffer.from("def"));
    job.child.stdout.emit("data", Buffer.from("ignored"));
    job.child.emit("close", 0); await job.completion;
    expect(await manager.waitForShellJob(job.jobId, 0)).toMatchObject({ status: "failed", reason: "output_limit_exceeded", totalBytes: 6, tail: "abcdef", exitCode: null });
  });
  it("reports asynchronous spawn errors and preserves the first terminal cause", async () => {
    const job = start();
    job.child.emit("error", new Error("ENOENT fixture"));
    job.child.emit("close", -1); await job.completion;
    expect(await manager.waitForShellJob(job.jobId, 0)).toMatchObject({ status: "failed", reason: "spawn_error: ENOENT fixture", exitCode: null, processSettled: true });
  });
  it("waits until the requested deadline while the job keeps running", async () => {
    const job = start(); const waiting = manager.waitForShellJob(job.jobId, 50);
    await vi.advanceTimersByTimeAsync(50);
    expect(await waiting).toMatchObject({ status: "running", durationMs: 50 });
  });
  it("wakes all waiters on terminal state", async () => {
    const job = start();
    const waits = [manager.waitForShellJob(job.jobId, 500), manager.waitForShellJob(job.jobId, 600)];
    job.child.emit("close", 0);
    expect((await Promise.all(waits)).map(s => s?.status)).toEqual(["exited", "exited"]);
  });
  it.each([true, false])("cancels only the wait, including pre-abort=%s", async preAbort => {
    const job = start(); const ctrl = new AbortController();
    if (preAbort) ctrl.abort();
    const waiting = manager.waitForShellJob(job.jobId, 500, ctrl.signal);
    if (!preAbort) ctrl.abort();
    expect((await waiting)?.status).toBe("running");
  });
  it.each([true, false])("stops scope-owned jobs on abort, including pre-abort=%s", async preAbort => {
    const ctrl = new AbortController(); if (preAbort) ctrl.abort();
    const job = start({ executionScope: scope, signal: ctrl.signal });
    if (!preAbort) ctrl.abort();
    expect((await manager.waitForShellJob(job.jobId, 0))?.status).toBe("stopped");
    expect(manager.isShellJobControlAuthorized(job.jobId, { ...scope, childRunId: "other" })).toBe(true);
    expect(manager.isShellJobControlAuthorized(job.jobId, { ...scope, parentRunId: "other" })).toBe(false);
    expect(manager.isShellJobControlAuthorized(job.jobId, { ...scope, workspaceId: "other" })).toBe(false);
  });
  it("keeps standalone jobs independent of cancellation", async () => {
    const ctrl = new AbortController(); const job = start({ signal: ctrl.signal }); ctrl.abort();
    expect((await manager.waitForShellJob(job.jobId, 0))?.status).toBe("running");
    expect(manager.isShellJobControlAuthorized(job.jobId, scope)).toBe(false);
  });
  it("copies the trusted owner scope so later caller mutations cannot transfer ownership", () => {
    const owner = { ...scope }; const job = start({ executionScope: owner });
    owner.workspaceId = "foreign"; owner.parentRunId = "foreign";
    expect(manager.isShellJobControlAuthorized(job.jobId, scope)).toBe(true);
    expect(manager.isShellJobControlAuthorized(job.jobId, owner)).toBe(false);
  });
  it("returns terminal snapshots without waiting, even with a positive wait", async () => {
    const job = start(); job.child.emit("close", null); await job.completion;
    expect(await manager.waitForShellJob(job.jobId, 60_000)).toMatchObject({ status: "exited", exitCode: null, processSettled: true });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("cleans only expired log files during initial lifecycle setup", async () => {
    const old = path.join(dir, "old.log"), fresh = path.join(dir, "fresh.log"), unrelated = path.join(dir, "keep.txt");
    for (const file of [old, fresh, unrelated]) fs.writeFileSync(file, "fixture");
    const oldTime = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    fs.utimesSync(old, oldTime, oldTime); fs.utimesSync(unrelated, oldTime, oldTime);
    start();
    // Filesystem cleanup uses real promises, independent of the fake job timers.
    await vi.waitFor(() => expect(fs.existsSync(old)).toBe(false));
    expect(fs.existsSync(fresh)).toBe(true); expect(fs.existsSync(unrelated)).toBe(true);
  });
  it("can run with an unavailable Electron quit hook", async () => {
    mocks.on.mockImplementationOnce(() => { throw new Error("not Electron"); });
    const job = start(); job.child.emit("close", 0); await job.completion;
    expect((await manager.waitForShellJob(job.jobId, 0))?.status).toBe("exited");
  });
});

describe("killTree", () => {
  it("ignores missing children and missing PIDs", () => {
    manager.killTree(undefined); manager.killTree(null); manager.killTree({} as ChildProcess);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it("kills a Windows process tree without invoking a shell", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    manager.killTree(new Child() as unknown as ChildProcess);
    expect(mocks.spawn).toHaveBeenCalledWith("taskkill", ["/pid", "12345", "/T", "/F"], { windowsHide: true, shell: false, stdio: "ignore" });
  });
  it("uses the Unix process group and falls back to direct kill when it is absent", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    const child = new Child(); manager.killTree(child as unknown as ChildProcess);
    expect(kill).toHaveBeenCalledWith(-12345, "SIGKILL"); expect(child.kill).not.toHaveBeenCalled();
    kill.mockImplementation(() => { throw new Error("ESRCH"); });
    child.kill.mockImplementation(() => { throw new Error("already gone"); });
    expect(() => manager.killTree(child as unknown as ChildProcess)).not.toThrow();
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });
});
