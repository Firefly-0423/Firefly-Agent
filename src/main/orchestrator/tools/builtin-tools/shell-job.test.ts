import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const electronPaths = vi.hoisted(() => ({ root: "" }));
vi.mock("electron", () => ({ app: {
  getPath: () => { if (!electronPaths.root) throw new Error("Fixture directory has not been allocated"); return electronPaths.root; },
  on: () => undefined,
} }));
import { clampWaitMs, disposeAllShellJobs, isShellJobControlAuthorized, startShellJob, stopShellJob, waitForShellJob, type ShellJobSnapshot, type ShellSpawnSpec } from "./shell-job-manager";
import { getWorkspaceExecutionCoordinator } from "../../harness/execution-coordinator";
import { toolRegistry } from "../registry/tool-registry";
import { isPidExecuting } from "../../../../../scripts/testing/process-liveness.mjs";

// Fixture processes have a final self-exit so a broken OS tree-kill cannot leak them indefinitely.
const sleeping = "setTimeout(() => process.exit(0), 45000); setInterval(() => undefined, 750)";
const completions: Promise<void>[] = [];
let root: string;
function spec(script: string): ShellSpawnSpec {
  return { command: process.execPath, args: ["-e", script], cwd: root, env: { ...process.env }, windowsVerbatimArguments: false, ranViaSandbox: false };
}
function remember(job: ReturnType<typeof startShellJob>) { completions.push(job.completion); return job; }
function launch(script = sleeping, options: Partial<Parameters<typeof startShellJob>[0]> = {}) {
  return remember(startShellJob({ spec: spec(script), command: "fixture background process", shell: "cmd", totalMs: 60_000, ...options }));
}
async function until(jobId: string, predicate: (value: ShellJobSnapshot) => boolean, limit = 8000) {
  const end = Date.now() + limit;
  while (Date.now() <= end) {
    const value = await waitForShellJob(jobId, 0);
    if (!value) throw new Error("Background fixture disappeared: " + jobId);
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Background fixture did not reach the expected state: " + jobId);
}
async function assertDead(pids: Array<number | null>, limit = 8000) {
  const end = Date.now() + limit;
  while (pids.some(pid => isPidExecuting(pid))) {
    if (Date.now() > end) throw new Error("Fixture processes still executing: " + pids.join(", "));
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  for (const pid of pids) expect(isPidExecuting(pid)).toBe(false);
}
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "background-contract-73-"));
  electronPaths.root = root;
  await import("../built-in-tools");
});
afterAll(async () => {
  disposeAllShellJobs();
  await Promise.race([Promise.allSettled(completions), new Promise(resolve => setTimeout(resolve, 1000))]);
  const target = resolve(root);
  if (target.startsWith(resolve(tmpdir()) + (process.platform === "win32" ? "\\" : "/"))) {
    try {
      rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch (error) {
      // Windows may still hold a failed fixture's log; keep it for diagnosis.
      if (!(error && typeof error === "object" && "code" in error && ["EBUSY", "EPERM"].includes(String(error.code)))) throw error;
    }
  }
});

describe("background wait argument normalization", () => {
  it.each([[undefined, 0], [-5, 0], ["abc", 0], ["2500", 2500], [1500.6, 1501], [999_999, 60_000]] as const)("normalizes %j to %s milliseconds", (input, milliseconds) => {
    expect(clampWaitMs(input)).toEqual(milliseconds);
  });
});

describe("observable background process lifecycle", () => {
  it("returns a running process and an existing empty log immediately", async () => {
    const job = launch();
    const state = await waitForShellJob(job.jobId, 0);
    expect(state?.status).toBe("running");
    expect(state?.exitCode).toBeNull();
    expect(state?.pid).toBeGreaterThan(0);
    expect(existsSync(job.logFile)).toBe(true);
    stopShellJob(job.jobId);
    await assertDead([state!.pid]);
  }, 15_000);
  it("keeps actual completion pending until stop has closed the process and log", async () => {
    const job = launch();
    expect(job.completion).toBeInstanceOf(Promise);
    let completed = false;
    void job.completion.then(() => { completed = true; });
    const state = await waitForShellJob(job.jobId, 0);
    expect(completed).toBe(false);
    const stopped = stopShellJob(job.jobId);
    expect(stopped?.status).toBe("stopped");
    expect(stopped?.processSettled).toBe(false);
    expect(completed).toBe(false);
    await job.completion;
    expect((await waitForShellJob(job.jobId, 0))?.processSettled).toBe(true);
    expect(isPidExecuting(state!.pid)).toBe(false);
  }, 15_000);
  it("ends a long wait early when the process exits and preserves flushed output", async () => {
    const job = launch("console.log('OBSERVATION_FINISHED_73')");
    const began = Date.now();
    const state = await waitForShellJob(job.jobId, 15_000);
    expect(state).toMatchObject({ status: "exited", exitCode: 0 });
    expect(Date.now() - began).toBeLessThan(10_000);
    expect((await until(job.jobId, value => value.tail.includes("OBSERVATION_FINISHED_73"), 3000)).tail).toContain("OBSERVATION_FINISHED_73");
  }, 20_000);
  it("returns a running snapshot after a bounded wait expires", async () => {
    const job = launch();
    const began = Date.now();
    const state = await waitForShellJob(job.jobId, 500);
    const duration = Date.now() - began;
    expect(state?.status).toBe("running");
    expect(duration).toBeGreaterThanOrEqual(450);
    expect(duration).toBeLessThan(5000);
    stopShellJob(job.jobId);
    await assertDead([state!.pid]);
  }, 15_000);
  it("aborts a status wait promptly without stopping an independent background process", async () => {
    const job = launch();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 300);
    const began = Date.now();
    const state = await waitForShellJob(job.jobId, 30_000, controller.signal);
    clearTimeout(timer);
    expect(state?.status).toBe("running");
    expect(Date.now() - began).toBeLessThan(5000);
    stopShellJob(job.jobId);
    await assertDead([state!.pid]);
  }, 15_000);
  it("kills both the job process and its descendant on stop", async () => {
    const job = launch(`const cp=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(sleeping)}]); console.log('descendant='+cp.pid); ${sleeping}`);
    const state = await until(job.jobId, value => value.tail.includes("descendant="), 10_000);
    const descendant = Number(/descendant=(\d+)/.exec(state.tail)?.[1]);
    expect(state.pid).toBeTruthy();
    expect(descendant).toBeGreaterThan(0);
    expect(isPidExecuting(state.pid)).toBe(true);
    expect(isPidExecuting(descendant)).toBe(true);
    expect(stopShellJob(job.jobId)).toMatchObject({ status: "stopped", exitCode: null });
    await assertDead([state.pid, descendant]);
  }, 25_000);
  it("makes stop idempotent and never replaces an already exited state", async () => {
    const finished = launch("console.log('completed before stop')");
    expect((await until(finished.jobId, value => value.status === "exited", 10_000)).exitCode).toBe(0);
    expect(stopShellJob(finished.jobId)?.status).toBe("exited");
    const active = launch();
    const stopped = stopShellJob(active.jobId);
    expect(stopped?.status).toBe("stopped");
    expect(stopShellJob(active.jobId)?.status).toBe("stopped");
    await assertDead([stopped!.pid]);
  }, 20_000);
  it("fails and kills the job once output reaches its configured byte budget", async () => {
    const job = launch("setTimeout(()=>process.exit(0),45000);setInterval(()=>process.stdout.write(Buffer.alloc(512,114)),10)", { logMaxBytes: 4096 });
    const state = await until(job.jobId, value => value.status === "failed", 10_000);
    expect(state.reason).toBe("output_limit_exceeded");
    expect(state.totalBytes).toBeGreaterThanOrEqual(4096);
    await assertDead([state.pid]);
  }, 20_000);
  it("terminates a silent job at its total execution deadline", async () => {
    const job = launch(sleeping, { totalMs: 1200 });
    const state = await until(job.jobId, value => value.status === "timed_out", 10_000);
    expect(state.reason).toBe("total_timeout_exceeded");
    expect(state.exitCode).toBeNull();
    await assertDead([state.pid]);
  }, 20_000);
  it("returns null for both operations on an unknown job", async () => {
    expect(await waitForShellJob("absent-background-73", 0)).toBeNull();
    expect(stopShellJob("absent-background-73")).toBeNull();
  });
});

describe("trusted ownership and coordinator lifetime", () => {
  it("authorizes control only within the bound workspace and parent run", async () => {
    const owner = { workspaceId: "fixture-workspace-73", parentRunId: "parent-73", groupId: "group-73", agentId: "agent-73", childRunId: "child-73", toolCallId: "tool-73" };
    const job = launch(sleeping, { executionScope: owner });
    expect(isShellJobControlAuthorized(job.jobId, owner)).toBe(true);
    expect(isShellJobControlAuthorized(job.jobId, { ...owner, childRunId: "control-child-91" })).toBe(true);
    expect(isShellJobControlAuthorized(job.jobId, { ...owner, parentRunId: "other-parent-91" })).toBe(false);
    expect(isShellJobControlAuthorized(job.jobId, { ...owner, workspaceId: "other-workspace-91" })).toBe(false);
    expect(isShellJobControlAuthorized("missing-owner-job", owner)).toBe(false);
    stopShellJob(job.jobId);
    await job.completion;
  });
  it("retains exclusive workspace access until an owned cancellation really closes the process", async () => {
    const coordinator = getWorkspaceExecutionCoordinator(root);
    const owner = { workspaceId: coordinator.workspaceId, parentRunId: "owned-parent-73", groupId: "owned-group-73", agentId: "writer-73", childRunId: "owned-child-73", toolCallId: "owned-tool-73" };
    const controller = new AbortController();
    const job = await coordinator.runLeaf(owner, "exclusive", controller.signal, async permit => {
      const started = launch(sleeping, { executionScope: owner, signal: controller.signal });
      coordinator.retainUntil(permit, started.completion);
      return started;
    });
    const state = await waitForShellJob(job.jobId, 0);
    let entered = false;
    const queued = coordinator.runLeaf({ ...owner, agentId: "reader-91", childRunId: "read-child-91", toolCallId: "read-tool-91" }, "shared", undefined, async () => {
      entered = true;
      expect(isPidExecuting(state!.pid)).toBe(false);
      expect((await waitForShellJob(job.jobId, 0))?.processSettled).toBe(true);
    });
    await Promise.resolve();
    expect(entered).toBe(false);
    controller.abort();
    expect((await waitForShellJob(job.jobId, 0))?.status).toBe("stopped");
    await job.completion;
    await queued;
    expect(entered).toBe(true);
    await coordinator.closeGroup(owner.groupId);
  }, 15_000);
});

describe("registered background tools", () => {
  const control = async (args: Record<string, unknown>) => JSON.parse(await toolRegistry.getById("shell_job")!.execute(args, { userQuery: "" }));
  it("reports missing job identity and preserves received argument key order", async () => {
    const result = await control({ action: "status", wait_ms: 0 });
    expect(result.errorCode).toBe("MISSING_JOB_ID");
    expect(result.receivedParams).toBe("action, wait_ms");
  });
  it.each(["status", "stop"])("returns JOB_NOT_FOUND for %s on an unknown id", async action => {
    expect((await control({ action, job_id: "unregistered-job-73" })).errorCode).toBe("JOB_NOT_FOUND");
  });
  it.runIf(process.platform === "win32")("starts, queries and stops a real command through the public tools", async () => {
    const result = JSON.parse(await toolRegistry.getById("run_shell")!.execute({
      command: 'node -e "setTimeout(()=>process.exit(0),30000)"', run_in_background: true,
    }, { permissionMode: "allow_all" } as never));
    expect(result).toMatchObject({ ranInBackground: true, status: "running" });
    expect(String(result.jobId)).toMatch(/^job-/);
    expect(existsSync(String(result.logFile))).toBe(true);
    const state = await control({ action: "status", job_id: result.jobId });
    expect(state).toMatchObject({ status: "running", waitedMs: 0 });
    expect(Number(state.pid)).toBeGreaterThan(0);
    expect(await control({ action: "stop", job_id: result.jobId })).toMatchObject({ status: "stopped", stopped: true });
    await assertDead([Number(state.pid)]);
  }, 20_000);
});
