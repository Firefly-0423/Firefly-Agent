import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isPidExecuting } from "../../../../../scripts/testing/process-liveness.mjs";

vi.mock("electron", () => ({ app: { on: vi.fn(), getPath: () => { throw new Error("test"); } } }));
vi.mock("../../../logging/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn() }, LogTag: { BuiltinTools: "test" } }));

import { disposeAllShellJobs, startShellJob, stopShellJob, waitForShellJob } from "./shell-job-manager";

// An intermediate parent exits before cleanup. taskkill /T on the original PID
// cannot reliably discover the surviving detached grandchild through that gap.
describe.runIf(process.platform === "win32")("direct Windows shell descendant lifetime", () => {
  let dir: string;
  let descendantPid: number | undefined;
  let completion: Promise<void> | undefined;

  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-descendants-")); });
  afterEach(async () => {
    disposeAllShellJobs();
    // Independent cleanup also works on the vulnerable implementation (RED run).
    if (descendantPid && isPidExecuting(descendantPid)) {
      spawnSync(path.join(process.env.SystemRoot!, "System32", "taskkill.exe"),
        ["/PID", String(descendantPid), "/T", "/F"], { windowsHide: true });
    }
    await completion;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    descendantPid = undefined;
    completion = undefined;
  });

  async function until(predicate: () => boolean, timeout = 10_000) {
    const end = Date.now() + timeout;
    while (!predicate()) {
      if (Date.now() >= end) throw new Error("descendant lifecycle did not converge");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async function launch(mode: "exit" | "hold", totalMs = 60_000, signal?: AbortSignal, inheritOutput = false) {
    const pidFile = path.join(dir, "descendant.pid");
    const readyFile = path.join(dir, "intermediate-closed");
    const middle = path.join(dir, "middle.cjs");
    const root = path.join(dir, "root.cjs");
    fs.writeFileSync(middle, [
      'const { spawn } = require("node:child_process");',
      `const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: ${JSON.stringify(inheritOutput ? ["ignore", "inherit", "inherit"] : "ignore")} });`,
      `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
      "child.unref();",
    ].join("\n"));
    fs.writeFileSync(root, [
      `const middle = require("node:child_process").spawn(process.execPath, [${JSON.stringify(middle)}], { stdio: ["ignore", "inherit", "inherit"] });`,
      `middle.on("exit", () => { require("node:fs").writeFileSync(${JSON.stringify(readyFile)}, "ready"); ${mode === "hold" ? "setInterval(() => {}, 1000);" : ""} });`,
    ].join("\n"));
    const scope = { workspaceId: dir, parentRunId: "p", groupId: "g", agentId: "a", childRunId: "c", toolCallId: "t" };
    const job = startShellJob({
      spec: { command: process.execPath, args: [root], cwd: dir, env: { ...process.env }, windowsVerbatimArguments: false, ranViaSandbox: false },
      command: "descendant fixture", shell: "cmd", logDir: dir, totalMs,
      ...(signal ? { executionScope: scope, signal } : {}),
    });
    completion = job.completion;
    await until(() => fs.existsSync(readyFile));
    descendantPid = Number(fs.readFileSync(pidFile, "utf8"));
    return job;
  }

  it.each([false, true])("reaps detached descendants before natural completion (inherited output: %s)", async (inheritOutput) => {
    const job = await launch("exit", 60_000, undefined, inheritOutput);
    await until(() => !isPidExecuting(descendantPid!), 3000);
    await job.completion;
    expect(await waitForShellJob(job.jobId, 0)).toMatchObject({ status: "exited", exitCode: 0, processSettled: true });
    expect(stopShellJob(job.jobId)?.status).toBe("exited");
    disposeAllShellJobs();
    expect(isPidExecuting(descendantPid!)).toBe(false);
  }, 20_000);

  it.each(["deadline", "stop", "cancel", "shutdown"] as const)("reaps descendants across an exited intermediate on %s", async (action) => {
    const controller = new AbortController();
    const job = await launch("hold", action === "deadline" ? 6000 : 60_000, controller.signal);
    expect(isPidExecuting(descendantPid!)).toBe(true);
    if (action === "stop") stopShellJob(job.jobId);
    if (action === "cancel") controller.abort();
    if (action === "shutdown") disposeAllShellJobs();
    await until(() => !isPidExecuting(descendantPid!));
    await job.completion;
    expect(await waitForShellJob(job.jobId, 0)).toMatchObject({ status: action === "deadline" ? "timed_out" : "stopped", processSettled: true });
  }, 25_000);
});
