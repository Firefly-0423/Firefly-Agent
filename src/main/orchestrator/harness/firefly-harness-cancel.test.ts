import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatResponse, ToolCall } from "../vendors/types";
import type { HarnessEvent, HarnessInput, HarnessResult } from "./types";
import type { ToolDefinition } from "../tools/registry/tool-registry";
import type { ToolDispatchResult } from "./tool-dispatcher";

const network = vi.hoisted(() => ({ stream: vi.fn(), usage: vi.fn(), requests: vi.fn() }));
vi.mock("../vendors", () => ({
  getAdapterForConfig: () => ({ id: "cancellation-fixture", buildRequest: (request: unknown) => ({ url: "https://cancel.invalid/model", headers: {}, body: JSON.stringify(request) }), parseResponse: (value: unknown) => value }),
  streamChatWithSdk: network.stream, resolveTransport: () => "openai",
}));
vi.mock("../../token-usage-store", () => ({ recordUsage: network.usage, recordRequest: network.requests, recordModelCall: vi.fn(), recordToolCall: vi.fn() }));
vi.mock("./tool-dispatcher", () => ({ dispatchToolCall: vi.fn(), persistToolDispatchResult: async (_call: unknown, result: unknown) => result }));
import { runFireflyHarness } from "./firefly-harness";
import { dispatchToolCall } from "./tool-dispatcher";
import { RunExecutionCoordinator } from "./execution-coordinator";

const dispatch = vi.mocked(dispatchToolCall);
function gate<T>() {
  let release!: (value: T) => void, reject!: (error: unknown) => void;
  const pending = new Promise<T>((resolve, fail) => { release = resolve; reject = fail; });
  return { pending, release, reject };
}
const readCall = (id = "lookup-violet"): ToolCall => ({ id, name: "read_file", arguments: '{"path":"D:/fixture/notes.md"}' });
const writeCall = (): ToolCall => ({ id: "save-violet", name: "write_file", arguments: '{"path":"D:/fixture/digest.md","content":"Audit complete"}' });
const reply = (toolCalls: ToolCall[] = [], text = ""): ChatResponse => ({
  text, toolCalls, assistantMessage: { role: "assistant", content: text, ...(toolCalls.length ? { toolCalls } : {}) }, finishReason: toolCalls.length ? "tool_calls" : "stop", raw: {},
});
const success = (): ToolDispatchResult => ({ outcome: "success", tool: "write_file", message: "Saved", output: "Saved", preview: "Saved", truncated: false,
  rawResult: { toolId: "write_file", args: {}, status: "succeeded", output: "Saved", terminal: true, retryable: false } });
const readTool = (): ToolDefinition => ({
  id: "read_file", name: "Inspect notes", description: "Inspect notes", enabled: true, effectKind: "read",
  inputSchema: { type: "object", properties: { path: { type: "string" } } }, execute: vi.fn(),
});
const vendorConfig = { provider: "custom", model: "cancel-model", apiKey: "", baseUrl: "https://cancel.invalid" } as HarnessInput["vendorConfig"];
function launch(extra: Partial<HarnessInput> = {}) {
  const events: HarnessEvent[] = [];
  const input: HarnessInput = { systemPrompt: "Cancellation contract", messages: [{ role: "user", content: "Inspect notes" }], tools: [], vendorConfig, onEvent: event => events.push(event), ...extra };
  return { events, running: runFireflyHarness(input) };
}
function cancelled(result: HarnessResult, events: HarnessEvent[]) {
  expect(result).toMatchObject({ terminated: true, terminateReason: "cancelled", finalAnswer: "" });
  expect(result.finalAnswer).not.toContain("最终回复被取消");
  expect(events.filter(event => event.type === "final_answer")).toHaveLength(0);
  if (result.terminal) expect(result.terminal).toMatchObject({ status: "cancelled", externalEffectsMayContinue: true });
}
beforeEach(() => { vi.resetAllMocks(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Cancellation at asynchronous run boundaries", () => {
  it.each([false, true])("interrupts a model request, including after a completed tool round (%s)", async afterTools => {
    const controller = new AbortController(), response = gate<ChatResponse>();
    if (afterTools) network.stream.mockResolvedValueOnce(reply([writeCall()]));
    network.stream.mockImplementationOnce(async ({ signal }: { signal: AbortSignal }) => {
      signal.addEventListener("abort", () => response.reject(Object.assign(new Error("HTTP request interrupted"), { name: "AbortError" })), { once: true });
      return response.pending;
    });
    dispatch.mockResolvedValue(success());
    const job = launch({ signal: controller.signal });
    await expect.poll(() => network.stream.mock.calls.length).toBe(afterTools ? 2 : 1);
    controller.abort();
    const result = await job.running;
    cancelled(result, job.events);
    const requestsAtReturn = network.stream.mock.calls.length;
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(network.stream).toHaveBeenCalledTimes(requestsAtReturn);
  });

  it("drains the original dispatched promise before terminal snapshot or releasing the workspace", async () => {
    const coordinator = new RunExecutionCoordinator("cancellation-owned-workspace");
    const scope = { workspaceId: coordinator.workspaceId, parentRunId: "main-violet", childRunId: "main-violet", groupId: "main-violet", agentId: "main", toolCallId: "save-violet" };
    const controller = new AbortController(), actual = gate<ToolDispatchResult>(), checkpoint = vi.fn();
    network.stream.mockResolvedValueOnce(reply([writeCall()]));
    dispatch.mockImplementation((call, context) => coordinator.runLeaf({ ...scope, toolCallId: call.id }, "exclusive", controller.signal, async () => {
      context.onExecutionStarted?.(); return actual.pending;
    }));
    let returned = false;
    const job = launch({ tools: [readTool()], signal: controller.signal, onCheckpoint: checkpoint,
      toolContext: { userQuery: "Inspect", signal: controller.signal, execution: { coordinator, scope } } });
    const result = job.running.then(value => { returned = true; return value; });
    await expect.poll(() => dispatch.mock.calls.length).toBe(1);
    controller.abort();
    const read = vi.fn(async () => {});
    const competing = coordinator.runLeaf({ ...scope, parentRunId: "other-violet", childRunId: "other-violet", groupId: "other-violet" }, "shared", undefined, read);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(returned).toBe(false);
    expect(checkpoint).toHaveBeenCalledOnce();
    expect(read).not.toHaveBeenCalled();
    actual.release(success());
    cancelled(await result, job.events);
    await competing;
    expect(read).toHaveBeenCalledOnce();
    await coordinator.closeGroup("other-violet");
  });

  it("interrupts transient retry backoff without another dispatch", async () => {
    network.stream.mockResolvedValueOnce(reply([readCall()]));
    const controller = new AbortController();
    dispatch.mockResolvedValue({
      outcome: "failure", category: "transient", tool: "read_file", message: "Connection reset",
      rawResult: { toolId: "read_file", args: {}, status: "failed", output: "Connection reset", errorCode: "TRANSIENT", retryable: true, terminal: true },
    });
    const job = launch({ tools: [readTool()], signal: controller.signal });
    await expect.poll(() => dispatch.mock.calls.length).toBe(1);
    await new Promise(resolve => setTimeout(resolve, 50));
    controller.abort();
    cancelled(await job.running, job.events);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("cancels an approval wait without execution and prevents a late approval from restarting it", async () => {
    const controller = new AbortController(), permission = gate<boolean>(), entered = vi.fn(), actual = vi.fn(async () => success());
    network.stream.mockResolvedValueOnce(reply([readCall()]));
    dispatch.mockImplementation(async (_call, context) => {
      if (!await context.checkPermission!("read_file", { path: "D:/fixture/notes.md" })) return { outcome: "failure", tool: "read_file", message: "Denied" };
      context.onExecutionStarted?.(); return actual();
    });
    const job = launch({ tools: [readTool()], signal: controller.signal, checkPermission: async () => { entered(); return permission.pending; } });
    await expect.poll(() => entered.mock.calls.length).toBe(1);
    controller.abort();
    cancelled(await job.running, job.events);
    expect(actual).not.toHaveBeenCalled();
    permission.release(true);
    await Promise.resolve(); await Promise.resolve();
    expect(actual).not.toHaveBeenCalled();
    expect(network.stream).toHaveBeenCalledTimes(1);
  });

  it("abandons the interactive wait without publishing a placeholder final answer", async () => {
    const controller = new AbortController(), answers = gate<unknown>(), entered = vi.fn();
    const ask = { id: "ask-violet", name: "ask_user", arguments: '{"questions":[{"id":"route","question":"Which route?","type":"text"}]}' };
    network.stream.mockResolvedValueOnce(reply([ask]));
    dispatch.mockImplementation(async (_call, context) => { await context.requestUserClarification!({}); return success(); });
    const job = launch({ signal: controller.signal, requestUserClarification: async () => { entered(); return answers.pending; } });
    await expect.poll(() => entered.mock.calls.length).toBe(1);
    controller.abort();
    try { cancelled(await job.running, job.events); }
    finally { answers.release({ answers: [] }); }
  });

  it("returns a single empty cancellation result when already cancelled at loop entry", async () => {
    const job = launch({ signal: AbortSignal.abort() });
    cancelled(await job.running, job.events);
    expect(network.stream).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("quiesces only the failed child before draining its retained process", async () => {
    const { startShellJob, stopShellJob, waitForShellJob } = await import("../tools/builtin-tools/shell-job-manager");
    const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "failed-child-process-"));
    const coordinator = new RunExecutionCoordinator(root), parent = new AbortController(), child = new AbortController();
    const signal = AbortSignal.any([parent.signal, child.signal]);
    const scope = { workspaceId: root, parentRunId: "parent-violet", childRunId: "child-violet", groupId: "siblings-violet", agentId: "analyst", toolCallId: "launch-violet" };
    let processJob: ReturnType<typeof startShellJob> | undefined;
    const quiesce = vi.fn(() => child.abort()), nextResponse = gate<ChatResponse>();
    network.stream.mockResolvedValueOnce(reply([readCall("launch-violet")])).mockReturnValueOnce(nextResponse.pending);
    dispatch.mockImplementation((call, context) => coordinator.runLeaf({ ...scope, toolCallId: call.id }, "exclusive", signal, async permit => {
      context.onExecutionStarted?.();
      processJob = startShellJob({
        spec: { command: process.execPath, args: ["-e", "setInterval(() => {}, 2000)"], env: process.env, cwd: root, windowsVerbatimArguments: false, ranViaSandbox: false },
        command: "Retained child fixture", shell: "node", logDir: root, executionScope: scope, signal,
      });
      coordinator.retainUntil(permit, processJob.completion);
      return success();
    }));
    const job = launch({ tools: [readTool()], signal, quiesceExecution: quiesce, toolContext: { userQuery: "Inspect", signal, execution: { coordinator, scope } } });
    try {
      await expect.poll(() => network.stream.mock.calls.length).toBe(2);
      expect((await waitForShellJob(processJob!.jobId, 0))?.status).toBe("running");
      nextResponse.reject(new Error("Next child model request failed"));
      expect((await job.running).terminateReason).toBe("error");
      expect(quiesce).toHaveBeenCalledOnce();
      expect(child.signal.aborted).toBe(true);
      expect(parent.signal.aborted).toBe(false);
      expect((await waitForShellJob(processJob!.jobId, 0))?.status).toBe("stopped");
      await processJob!.completion;
    } finally {
      child.abort();
      if (processJob) { stopShellJob(processJob.jobId); await processJob.completion; }
      await coordinator.closeGroup(scope.groupId);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
