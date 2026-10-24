import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentFileAccessLevel } from "../../../permission/permission-policy";
import type { ToolContext } from "../registry/tool-context";
import type { HarnessRun } from "../../harness/firefly-harness";
import { DEFAULT_HARNESS_CONFIG, INITIAL_HARNESS_CACHE_STATE, type HarnessEvent, type HarnessToolFinishedEvent } from "../../harness/types";

const mocks = vi.hoisted(() => ({
  level: "full" as AgentFileAccessLevel,
  spawn: vi.fn(), wrap: vi.fn(), resolve: vi.fn(), invocation: vi.fn(), background: vi.fn(), kill: vi.fn(),
}));
vi.mock("../../../permission/permission", () => ({ getCurrentLevel: () => mocks.level }));
vi.mock("child_process", () => ({ spawn: (...args: unknown[]) => mocks.spawn(...args) }));
vi.mock("../../sandbox/sandbox-exec", () => ({ wrapWithSandbox: (...args: unknown[]) => mocks.wrap(...args) }));
vi.mock("../../shell-runtime", () => ({
  resolveShellExecutable: (...args: unknown[]) => mocks.resolve(...args),
  buildDirectShellInvocation: (...args: unknown[]) => mocks.invocation(...args),
}));
vi.mock("./shell-job-manager", () => ({
  killTree: (...args: unknown[]) => mocks.kill(...args),
  startShellJob: (...args: unknown[]) => mocks.background(...args),
}));
vi.mock("../../../logging/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, LogTag: { BuiltinTools: "test" } }));

import { runShellTool } from "./run-shell-tool";
import { executeToolDefinition } from "../registry/tool-executor";
import { dispatchToolCall, type ToolDispatchContext } from "../../harness/tool-dispatcher";
import { runToolRound } from "../../harness/tool-round";
import { StreamController } from "../../harness/stream-controller";
import { TimeoutClock } from "../../harness/timeout-clock";
import { ExecutionLedger } from "../../execution-ledger";
import { enterPlanDiscussing, resetPlanSessionsForTest } from "../../plan-mode";

const resolved = { kind: "cmd", executable: "synthetic-cmd" };
const args = { command: "echo synthetic", shell: "cmd" };
const call = { id: "shell-1", name: "run_shell", arguments: JSON.stringify(args) };
const context: ToolContext = { userQuery: "synthetic", conversationId: "r3-r4", runId: "r3-r4", fileAccessLevel: "full" };

function child() {
  return Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
function round(toolContext = context, ledger = new ExecutionLedger()) {
  const events: HarnessEvent[] = [];
  const finished: HarnessToolFinishedEvent[] = [];
  const state = { todoItems: [], uncertainEffects: [], toolFailureStreaks: {} };
  const toolDispatchContext: ToolDispatchContext = { state, tools: [runShellTool], toolContext, executionLedger: ledger, deferOutputPersistence: true };
  const run: HarnessRun = {
    input: { systemPrompt: "synthetic", messages: [], tools: [runShellTool], vendorConfig: { provider: "openai", model: "synthetic", apiKey: "synthetic", baseUrl: "https://invalid.example" },
      signal: toolContext.signal, toolContext, onEvent: event => events.push(event), onToolFinished: event => finished.push(event) },
    config: DEFAULT_HARNESS_CONFIG, state, clock: new TimeoutClock(0, 0), streamController: new StreamController(),
    allToolSpecs: [], messages: [], toolOutputs: [], cache: { ...INITIAL_HARNESS_CACHE_STATE }, rounds: 0,
    askDispatchContext: toolDispatchContext, toolDispatchContext, toolCallStartedAt: new Map(), checkpoint: vi.fn(),
  };
  return { run, events, finished, ledger };
}

beforeEach(() => {
  vi.resetAllMocks(); resetPlanSessionsForTest(); mocks.level = "full";
  mocks.resolve.mockResolvedValue(resolved);
  mocks.invocation.mockReturnValue({ command: resolved.executable, args: [], windowsVerbatimArguments: true });
  mocks.wrap.mockResolvedValue({ ok: false, reason: "disabled" });
  mocks.background.mockReturnValue({ jobId: "synthetic-job", logFile: "synthetic-log" });
  mocks.spawn.mockImplementation(() => {
    const process = child();
    queueMicrotask(() => { process.stdout.emit("data", Buffer.from("shell evidence")); process.emit("close", 0); });
    return process;
  });
});
afterEach(() => { vi.useRealTimers(); resetPlanSessionsForTest(); });

describe("R3 actual shell through shared executor, scheduler and ledger", () => {
  const cases = [
    { name: "unsupported shell", input: { ...args, shell: "powershell" }, outcome: "failure", code: "SHELL_UNSUPPORTED", category: "invalid_arguments", spawn: 0 },
    { name: "missing Bash", input: { ...args, shell: "bash" }, outcome: "failure", code: "BASH_UNAVAILABLE", category: "not_found", spawn: 0 },
    { name: "catastrophic refusal", input: { ...args, command: "shutdown /s /t 0" }, outcome: "failure", code: "E_SHELL_REJECTED", category: "permission_denied", spawn: 0 },
    { name: "sandbox refusal", input: args, outcome: "failure", code: "E_SHELL_REJECTED", category: "permission_denied", spawn: 0 },
    { name: "spawn error", input: args, outcome: "failure", code: "E_SHELL_SPAWN", category: "semantic_failure", spawn: 1 },
    { name: "setup error", input: args, outcome: "failure", code: "E_SHELL_SETUP", category: "semantic_failure", spawn: 0 },
    { name: "nonzero exit", input: args, outcome: "unknown", code: "E_SHELL_EXIT", category: "semantic_failure", spawn: 1 },
    { name: "signal exit without code", input: args, outcome: "unknown", code: "E_SHELL_EXIT", category: "semantic_failure", spawn: 1 },
    { name: "success", input: args, outcome: "success", code: undefined, category: undefined, spawn: 1 },
  ] as const;
  for (const scenario of cases) {
    it(`${scenario.name} has honest status, evidence and success-cache behavior`, async () => {
      if (scenario.name === "missing Bash") mocks.resolve.mockResolvedValue(null);
      if (scenario.name === "sandbox refusal") mocks.level = "scoped";
      if (scenario.name === "setup error") mocks.invocation.mockImplementation(() => { throw new Error("synthetic setup failure"); });
      if (["spawn error", "nonzero exit", "signal exit without code"].includes(scenario.name)) {
        mocks.spawn.mockImplementation(() => {
          const process = child();
          queueMicrotask(() => {
            process.stdout.emit("data", Buffer.from("shell evidence"));
            if (scenario.name === "spawn error") process.emit("error", new Error("synthetic spawn failure"));
            else process.emit("close", scenario.name === "nonzero exit" ? 7 : null);
          });
          return process;
        });
      }
      const execute = vi.fn(runShellTool.execute);
      const tool = { ...runShellTool, execute };
      const fixture = round({ ...context, fileAccessLevel: mocks.level, resolvedWorkspaceRoot: process.cwd() });
      fixture.run.input.tools = [tool]; fixture.run.toolDispatchContext.tools = [tool];
      const request = { ...call, arguments: JSON.stringify(scenario.input) };
      await runToolRound(fixture.run, [request]);
      const observation = JSON.parse(fixture.run.messages[0].content as string);
      expect(observation.outcome).toBe(scenario.outcome);
      expect(observation.category).toBe(scenario.category);
      expect(fixture.events.filter(e => e.type === "tool_end")).toEqual([expect.objectContaining({ outcome: scenario.outcome })]);
      expect(fixture.finished).toEqual([expect.objectContaining({ status: scenario.outcome })]);
      expect(fixture.run.state.toolFailureStreaks?.run_shell ?? 0).toBe(scenario.outcome === "failure" ? 1 : 0);
      const raw = await fixture.ledger.execute({ logicalInvocationId: `${context.runId}:${call.id}`, capability: "run_shell", targetRefs: [], args: scenario.input },
        () => executeToolDefinition(tool, scenario.input, fixture.run.input.toolContext));
      expect(raw.outcome).toMatchObject({ status: scenario.outcome === "success" ? "succeeded" : "failed", terminal: true, retryable: false });
      expect(raw.outcome.errorCode).toBe(scenario.code);
      expect(raw.cached).toBe(scenario.outcome === "success");
      expect(execute).toHaveBeenCalledTimes(scenario.outcome === "success" ? 1 : 2);
      expect(mocks.spawn).toHaveBeenCalledTimes(scenario.spawn * (scenario.outcome === "success" ? 1 : 2));
      if (scenario.spawn) expect(observation.output).toContain("shell evidence");
      expect(fixture.run.state.uncertainEffects).toHaveLength(scenario.outcome === "unknown" ? 1 : 0);
    });
  }

  it("foreground result can finish kill grace while retained actual close is still pending", async () => {
    vi.useFakeTimers();
    const process = child();
    mocks.spawn.mockReturnValue(process);
    let retained: Promise<unknown> | undefined;
    const execution = {
      coordinator: { assertPermit: () => ({}), retainUntil: (_permit: unknown, completion: Promise<unknown>) => { retained = completion; }, getWriteEvidence: () => [] },
      scope: { workspaceId: "workspace", parentRunId: "parent", groupId: "group", agentId: "a", childRunId: "child", toolCallId: "shell" },
      permit: {},
    } as unknown as NonNullable<ToolContext["execution"]>;
    const result = runShellTool.execute({ ...args, timeout_ms: 1000 }, { ...context, execution });
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledTimes(1));
    expect(retained).toBeInstanceOf(Promise);
    let closed = false;
    void retained!.then(() => { closed = true; });
    await vi.advanceTimersByTimeAsync(3000);
    expect(JSON.parse(await result).timedOut).toBe(true);
    expect(closed).toBe(false);
    process.emit("close", 1);
    await retained;
    expect(closed).toBe(true);
  });

  it("cancelled before execution is not an applied timeout or success", async () => {
    const controller = new AbortController(); controller.abort();
    const result = await executeToolDefinition(runShellTool, args, { ...context, signal: controller.signal });
    expect(result).toMatchObject({ status: "failed", errorCode: "E_ABORTED", category: "runtime_safety", effectState: "not_applied", retryable: false });
    expect(mocks.spawn).not.toHaveBeenCalled(); expect(mocks.background).not.toHaveBeenCalled();
  });

  for (const reason of ["cancelled", "timeout"] as const) {
    it(`started foreground ${reason} retains partial output and uncertain effects`, async () => {
      vi.useFakeTimers();
      const controller = new AbortController(); const process = child(); mocks.spawn.mockReturnValue(process);
      const fixture = round({ ...context, signal: controller.signal });
      // Dispatcher consumes the completed shell result; the Harness cancellation race is tested separately.
      const running = dispatchToolCall({ ...call, arguments: JSON.stringify({ ...args, timeout_ms: 1000 }) }, fixture.run.toolDispatchContext);
      await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledTimes(1));
      process.stdout.emit("data", Buffer.from("partial evidence"));
      if (reason === "cancelled") controller.abort(); else await vi.advanceTimersByTimeAsync(1000);
      process.emit("close", 1);
      const result = await running;
      expect(result.outcome).toBe("unknown");
      expect(result.rawResult).toMatchObject({ status: "failed", effectState: "unknown", errorCode: reason === "cancelled" ? "E_ABORTED" : "E_TOOL_TIMEOUT", category: reason === "cancelled" ? "runtime_safety" : "timeout", retryable: false });
      expect(result.output).toContain("partial evidence"); expect(fixture.run.state.uncertainEffects).toHaveLength(1);
      expect(mocks.kill).toHaveBeenCalledTimes(1);
    });
  }
});

describe("R4 delayed cancellation and R2 live guards", () => {
  for (const background of [false, true]) {
    for (const phase of ["permission", "resolve", "wrap"] as const) {
      it(`cancel during ${phase} never launches after setup resumes, background=${background}`, async () => {
        const controller = new AbortController(); const entered = deferred<void>(); const release = deferred<void>();
        mocks.level = phase === "wrap" ? "scoped" : "full";
        const wait = async () => { entered.resolve(); await release.promise; };
        const permission = vi.fn(async () => { if (phase === "permission") await wait(); return true; });
        if (phase === "resolve") mocks.resolve.mockImplementation(async () => { await wait(); return resolved; });
        if (phase === "wrap") mocks.wrap.mockImplementation(async () => { await wait(); return { ok: true, argv: ["synthetic-sandbox"], env: {} }; });
        const fixture = round({ ...context, signal: controller.signal, fileAccessLevel: mocks.level, resolvedWorkspaceRoot: process.cwd() });
        fixture.run.toolDispatchContext.checkPermission = permission;
        let execution: Promise<unknown> | undefined;
        const execute = vi.fn((...input: Parameters<typeof runShellTool.execute>) => { execution = runShellTool.execute(...input); void execution.catch(() => {}); return execution as Promise<string>; });
        fixture.run.toolDispatchContext.tools = [{ ...runShellTool, execute }];
        const running = runToolRound(fixture.run, [{ ...call, arguments: JSON.stringify({ ...args, run_in_background: background }) }, { ...call, id: "shell-never-dispatched" }]);
        await entered.promise; controller.abort();
        let roundSettled = false;
        void running.then(() => { roundSettled = true; });
        await Promise.resolve();
        expect(roundSettled).toBe(false);
        release.resolve();
        expect(await running).toBe("cancelled");
        if (phase === "permission") {
          expect(execute).not.toHaveBeenCalled();
          expect(execution).toBeUndefined();
        } else {
          expect(execute).toHaveBeenCalledTimes(1);
          await expect(execution).rejects.toMatchObject({ name: "AbortError" });
        }
        expect(mocks.spawn).not.toHaveBeenCalled(); expect(mocks.background).not.toHaveBeenCalled();
        expect(fixture.finished).not.toContainEqual(expect.objectContaining({ status: "success" }));
      });
    }
    it(`rechecks cancellation after spawn-spec construction, background=${background}`, async () => {
      const controller = new AbortController();
      mocks.invocation.mockImplementation(() => { controller.abort(); return { command: "synthetic", args: [] }; });
      await expect(runShellTool.execute({ ...args, run_in_background: background }, { ...context, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
      expect(mocks.spawn).not.toHaveBeenCalled(); expect(mocks.background).not.toHaveBeenCalled();
    });
    for (const guard of ["plan", "permission"] as const) {
      it(`keeps R2 ${guard} guard during delayed setup, background=${background}`, async () => {
        const entered = deferred<void>(); const release = deferred<void>();
        mocks.resolve.mockImplementation(async () => { entered.resolve(); await release.promise; return resolved; });
        const running = executeToolDefinition(runShellTool, { ...args, run_in_background: background }, context);
        await entered.promise;
        if (guard === "plan") enterPlanDiscussing(context.conversationId!, "synthetic-workspace");
        else mocks.level = "per-action";
        release.resolve();
        expect(await running).toMatchObject({ status: "failed", category: "permission_denied", effectState: "not_applied", errorCode: guard === "plan" ? "E_PLAN_READ_ONLY" : "E_PERMISSION_APPROVAL_REQUIRED" });
        expect(mocks.spawn).not.toHaveBeenCalled(); expect(mocks.background).not.toHaveBeenCalled();
      });
    }
  }
  it("a background job already started remains owned by its independent lifecycle", async () => {
    const controller = new AbortController();
    const result = await runShellTool.execute({ ...args, run_in_background: true }, { ...context, signal: controller.signal });
    expect(JSON.parse(result)).toMatchObject({ ranInBackground: true, jobId: "synthetic-job", status: "running" });
    controller.abort();
    expect(mocks.background).toHaveBeenCalledTimes(1); expect(mocks.kill).not.toHaveBeenCalled();
  });
});
