import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { isPidExecuting } from "../../../../../scripts/testing/process-liveness.mjs";

vi.mock("electron", () => ({ app: { on: vi.fn(), getPath: () => { throw new Error("test"); } } }));
vi.mock("../../../logging/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn() }, LogTag: { BuiltinTools: "test" } }));

import { disposeAllShellJobs, startShellJob, waitForShellJob, type ShellSpawnSpec } from "./shell-job-manager";
import { spawnWindowsShellJob } from "./windows-shell-job";

describe.runIf(process.platform === "win32")("Windows job supervisor compatibility and ownership", () => {
  let dir: string;
  const children: ChildProcess[] = [];
  const completions: Promise<unknown>[] = [];
  let descendantPid: number | undefined;

  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "firefly job 测试-")); });
  afterEach(async () => {
    disposeAllShellJobs();
    for (const child of children.splice(0)) child.stdin?.end();
    if (descendantPid && isPidExecuting(descendantPid)) {
      spawnSync(path.join(process.env.SystemRoot!, "System32", "taskkill.exe"),
        ["/PID", String(descendantPid), "/T", "/F"], { windowsHide: true });
    }
    await Promise.all(completions.splice(0));
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    descendantPid = undefined;
  });

  function spec(args: string[]): ShellSpawnSpec {
    return { command: process.execPath, args, env: { ...process.env }, cwd: dir, windowsVerbatimArguments: false, ranViaSandbox: false };
  }

  function run(spawnSpec: ShellSpawnSpec) {
    const child = spawnWindowsShellJob(spawnSpec, path.join(dir, "startup-error"));
    children.push(child);
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    child.stdout!.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr!.on("data", (chunk: Buffer) => errors.push(chunk));
    const done = new Promise<{ code: number | null; stdout: Buffer; stderr: Buffer }>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout: Buffer.concat(output), stderr: Buffer.concat(errors) }));
    });
    completions.push(done);
    return { child, done };
  }

  it("preserves argv, cwd, supplied environment, EOF stdin, raw output and nonzero exit", async () => {
    const script = path.join(dir, "arguments.cjs");
    const args = ["", "a b", 'a"b', 'a\\"b', "a b\\", "流萤", "$();'&|<>`"];
    fs.writeFileSync(script, `
      const fs = require('fs');
      console.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), env: process.env.FIREFLY_JOB_TEST, psModule: process.env.PSModulePath, stdin: fs.readFileSync(0).length }));
      process.stderr.write(Buffer.from([0, 255, 13, 10]));
      process.exitCode = 23;
    `);
    const spawnSpec = spec([script, ...args]);
    spawnSpec.env.FIREFLY_JOB_TEST = "环境\n$()";
    // PowerShell normally rewrites this variable; the target must receive the
    // supplied environment, not its supervisor's mutated environment.
    for (const key of Object.keys(spawnSpec.env)) {
      if (key.toUpperCase() === "PSMODULEPATH") delete spawnSpec.env[key];
    }
    spawnSpec.env.PSModulePath = "original-module-path";
    const result = await run(spawnSpec).done;
    expect(result.code).toBe(23);
    expect(JSON.parse(result.stdout.toString())).toEqual({ args, cwd: dir, env: "环境\n$()", psModule: "original-module-path", stdin: 0 });
    expect(result.stderr).toEqual(Buffer.from([0, 255, 13, 10]));
  }, 15_000);

  it("preserves cmd's verbatim quotes and command operators", async () => {
    const spawnSpec = spec([]);
    spawnSpec.command = path.join(process.env.SystemRoot!, "System32", "cmd.exe");
    spawnSpec.windowsVerbatimArguments = true;
    spawnSpec.args = ["/d", "/s", "/c", '"echo first&&echo second&exit /b 7"'];
    const result = await run(spawnSpec).done;
    expect(result.code).toBe(7);
    expect(result.stdout.toString().trim().split(/\r?\n/)).toEqual(["first", "second"]);
    expect(result.stderr.toString()).toBe("");
  }, 15_000);

  it("uses the exact executable when its path contains spaces", async () => {
    const spawnSpec = spec([]);
    spawnSpec.command = path.join(dir, "command with spaces.exe");
    fs.copyFileSync(path.join(process.env.SystemRoot!, "System32", "cmd.exe"), spawnSpec.command);
    fs.copyFileSync(path.join(process.env.SystemRoot!, "System32", "where.exe"), path.join(dir, "command.exe"));
    spawnSpec.windowsVerbatimArguments = true;
    spawnSpec.args = ["/d", "/s", "/c", '"echo exact&exit /b 7"'];
    const result = await run(spawnSpec).done;
    expect(result.stdout.toString().trim()).toBe("exact");
    expect(result.stderr.length).toBe(0);
    expect(result.code).toBe(7);
  }, 15_000);

  it("reports a target spawn failure as failed rather than a command exit", async () => {
    const spawnSpec = spec([]);
    spawnSpec.command = path.join(dir, "missing.exe");
    const job = startShellJob({ spec: spawnSpec, command: "missing executable", shell: "cmd", logDir: dir });
    completions.push(job.completion);
    await job.completion;
    expect(await waitForShellJob(job.jobId, 0)).toMatchObject({ status: "failed", exitCode: null, processSettled: true, reason: expect.stringMatching(/^spawn_error:/) });
    expect(fs.readdirSync(dir).filter((name) => name.endsWith("startup-error"))).toEqual([]);
  }, 15_000);

  it.each(["command", "argument"])("rejects NUL in a %s before launching a supervisor", (where) => {
    const spawnSpec = spec([]);
    if (where === "command") spawnSpec.command += "\0ignored";
    else spawnSpec.args = ["-e", "console.log('truncated')\0ignored"];
    expect(() => spawnWindowsShellJob(spawnSpec, path.join(dir, "startup-error"))).toThrow(TypeError);
  });

  async function until(predicate: () => boolean) {
    const deadline = Date.now() + 8000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error("fixture did not converge");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  it.each(["root-exit", "supervisor-death", "control-eof"] as const)("owns detached descendants through %s", async (action) => {
    const pidFile = path.join(dir, "pid");
    const release = path.join(dir, "release");
    const script = path.join(dir, "root.cjs");
    fs.writeFileSync(script, `
      const fs = require('fs');
      const child = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
      fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); child.unref();
      const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) clearInterval(timer); }, 10);
    `);
    const { child, done } = run(spec([script]));
    await until(() => fs.existsSync(pidFile));
    descendantPid = Number(fs.readFileSync(pidFile, "utf8"));
    expect(isPidExecuting(descendantPid)).toBe(true);
    if (action === "root-exit") fs.writeFileSync(release, "exit");
    if (action === "supervisor-death") child.kill("SIGKILL");
    if (action === "control-eof") child.stdin!.end();
    await done;
    // completion must not depend on descendant stdio holding a pipe open.
    if (action === "supervisor-death") await until(() => !isPidExecuting(descendantPid!));
    expect(isPidExecuting(descendantPid)).toBe(false);
  }, 15_000);

  it("reaps a detached descendant before output-limit completion", async () => {
    const pidFile = path.join(dir, "pid");
    const script = path.join(dir, "flood.cjs");
    fs.writeFileSync(script, `
      const child = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
      require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); child.unref();
      setInterval(() => process.stdout.write('x'.repeat(512)), 10);
    `);
    const job = startShellJob({ spec: spec([script]), command: "output limit fixture", shell: "cmd", logDir: dir, logMaxBytes: 4096 });
    completions.push(job.completion);
    await until(() => fs.existsSync(pidFile));
    descendantPid = Number(fs.readFileSync(pidFile, "utf8"));
    await job.completion;
    expect(await waitForShellJob(job.jobId, 0)).toMatchObject({ status: "failed", reason: "output_limit_exceeded", processSettled: true });
    expect(isPidExecuting(descendantPid)).toBe(false);
  }, 15_000);
});
