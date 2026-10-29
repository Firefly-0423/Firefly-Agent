import { describe, expect, it, vi } from "vitest";
import { ExecutionLedger } from "../execution-ledger";
import { ToolExecutionError } from "../tools/registry/tool-execution-error";
import type { ToolDefinition } from "../tools/registry/tool-registry";
import type { AgentState } from "./types";
import { dispatchToolCall, truncateOutput, DEFAULT_TRUNCATION, type ToolDispatchContext } from "./tool-dispatcher";
import { resolveUncertainEffect } from "./uncertain-effect-guard";
import { ToolOutputPersistenceError } from "./tool-output/file-tool-output-store";
import type { ToolOutputStore } from "./tool-output/tool-output-store";
import { RunExecutionCoordinator } from "./execution-coordinator";

const state = (): AgentState => ({ uncertainEffects: [], todoItems: [] });
const request = (id: string, args: object = { destination: "recipient@invalid.test" }) => ({ id, name: "publish_digest", arguments: JSON.stringify(args) });
function setup(execute: ToolDefinition["execute"] = async () => "Published", effectKind: ToolDefinition["effectKind"] = "read"): ToolDispatchContext {
  return {
    state: state(), tools: [{ id: "publish_digest", name: "Publish digest", description: "Deliver workspace findings", enabled: true,
      inputSchema: { type: "object", properties: {} }, effectKind, execute }],
    toolContext: { userQuery: "Deliver audit", conversationId: "dialog-pearl", runId: "run-pearl" },
  };
}
function outputStore(output: string, name = "publish_digest", id = "publish-pearl") {
  const reference = {
    recordId: "e".repeat(64), resultRef: `tool-result://v1/${"e".repeat(64)}`, runId: "run-pearl", toolCallId: id, toolName: name,
    bytes: Buffer.byteLength(output), codePoints: [...output].length, truncatedForModel: [...output].length > 30000, createdAt: 64,
  };
  const put = vi.fn(async () => reference);
  const store: ToolOutputStore = { put, read: vi.fn(), find: vi.fn(), deleteConversation: vi.fn() };
  return { reference, put, store };
}
function latch<T>() {
  let fulfill!: (value: T) => void;
  const pending = new Promise<T>(resolve => { fulfill = resolve; });
  return { pending, fulfill };
}
const scopeFor = (coordinator: RunExecutionCoordinator) => ({
  workspaceId: coordinator.workspaceId, parentRunId: "parent-pearl", groupId: "group-pearl", agentId: "main", childRunId: "parent-pearl", toolCallId: "old-pearl",
});

describe("Dispatch facts and model-visible output", () => {
  it("prunes only above the inclusive 30000-code-point threshold, retaining both ends", () => {
    const full = "BEGIN_EVIDENCE\n" + "q".repeat(31000) + "\nEND_EVIDENCE";
    const pruned = truncateOutput(full, DEFAULT_TRUNCATION, "publish-pearl");
    expect(pruned.truncated).toBe(true);
    expect(pruned.preview).toEqual(full.slice(0, 12000) + "\n\n[... tool result middle pruned ...]\n\n" + full.slice(-8000));
    expect(pruned.preview).toContain("BEGIN_EVIDENCE");
    expect(pruned.preview).toContain("END_EVIDENCE");
    expect(pruned.preview.length).toBeLessThanOrEqual(12000 + 8000 + 100);
    for (const length of [20000, 30000]) {
      const text = "p".repeat(length);
      expect(truncateOutput(text, DEFAULT_TRUNCATION, "publish-pearl")).toEqual({ truncated: false, preview: text });
    }
  });

  it("binds a successful permission check to a fresh invocation context only", async () => {
    const received: unknown[] = [], argsSeen: unknown[] = [];
    const execute = vi.fn(async (args, context) => { received.push(context); argsSeen.push(args); return "Allowed"; });
    const context = setup(execute);
    context.checkPermission = vi.fn(async () => true);
    const shared = context.toolContext!;
    await dispatchToolCall(request("authorized-pearl"), context);
    expect(context.checkPermission).toHaveBeenCalledTimes(1);
    expect(received[0]).toMatchObject({ authorizedToolCall: { toolId: "publish_digest", args: argsSeen[0] } });
    expect(received[0]).not.toBe(shared);
    expect(shared).not.toHaveProperty("authorizedToolCall");
    const ungated = vi.fn(async (_args, ctx) => { expect(ctx?.authorizedToolCall).toBeUndefined(); return "Ungated"; });
    await dispatchToolCall(request("ungated-pearl"), setup(ungated));
    expect(ungated).toHaveBeenCalledTimes(1);
  });

  it("preserves typed timeout facts while propagating AbortError unchanged", async () => {
    const timedOut = await dispatchToolCall(request("timeout-pearl"), setup(async () => {
      throw new ToolExecutionError("E_TIMEOUT", "Unconfirmed completion", "timeout", false, "unknown");
    }));
    expect(timedOut).toMatchObject({ outcome: "failure", category: "timeout", rawResult: { status: "failed", errorCode: "E_TIMEOUT", category: "timeout", effectState: "unknown" } });
    const aborted = Object.assign(new Error("Dispatch cancelled"), { name: "AbortError" });
    await expect(dispatchToolCall(request("abort-pearl"), setup(async () => { throw aborted; }))).rejects.toMatchObject({ name: "AbortError" });
  });

  it("replays only a matching logical invocation and executes a new intent with the same arguments", async () => {
    const execute = vi.fn(async () => "Delivered");
    const context = { ...setup(execute, "external_side_effect"), executionLedger: new ExecutionLedger() };
    const original = await dispatchToolCall(request("delivery-east"), context);
    const replay = await dispatchToolCall(request("delivery-east"), context);
    const another = await dispatchToolCall(request("delivery-west"), context);
    expect(original.rawResult?.deduplicated).not.toBe(true);
    expect(replay.rawResult?.deduplicated).toBe(true);
    expect(another.rawResult?.deduplicated).not.toBe(true);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("blocks an unresolved matching effect until confirmed while allowing a different fingerprint", async () => {
    const execute = vi.fn().mockRejectedValueOnce(new ToolExecutionError("E_TIMEOUT", "No acknowledgement", "timeout", false, "unknown")).mockResolvedValue("Delivered after verification");
    const context = { ...setup(execute, "external_side_effect"), executionLedger: new ExecutionLedger() };
    expect((await dispatchToolCall(request("delivery-unknown"), context)).outcome).toBe("unknown");
    expect(context.state.uncertainEffects).toHaveLength(1);
    const blocked = await dispatchToolCall(request("delivery-blocked"), context);
    expect(blocked).toMatchObject({ outcome: "not_executed", category: "runtime_safety" });
    expect(blocked.message).toContain(context.state.uncertainEffects[0].id);
    expect(execute).toHaveBeenCalledTimes(1);
    resolveUncertainEffect(context.state, context.state.uncertainEffects[0].toolCallId);
    expect((await dispatchToolCall(request("delivery-authorized"), context)).outcome).toBe("success");
    expect(context.state.uncertainEffects).toHaveLength(0);
    expect(execute).toHaveBeenCalledTimes(2);

    const other = setup(vi.fn().mockRejectedValueOnce(new ToolExecutionError("E_TIMEOUT", "Missing ack", "timeout", false, "unknown")).mockResolvedValue("Different recipient"), "external_side_effect");
    await dispatchToolCall(request("unknown-recipient"), other);
    expect((await dispatchToolCall(request("different-recipient", { destination: "other@invalid.test" }), other)).outcome).toBe("success");
  });

  it.each(["small", "large"] as const)("persists the full %s output before exposing the observation", async size => {
    const output = size === "small" ? "OK" : "FIRST_EVIDENCE\n" + "middle".repeat(6500) + "\nLAST_EVIDENCE";
    const storage = outputStore(output);
    const context = { ...setup(async () => output), toolOutputStore: storage.store };
    const result = await dispatchToolCall(request("publish-pearl"), context);
    expect(storage.put).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: "dialog-pearl", runId: "run-pearl", toolCallId: "publish-pearl", output, truncatedForModel: size === "large",
    }));
    expect(result.fullOutputRef).toBe(storage.reference.resultRef);
    if (size === "large") {
      expect(result.preview).not.toBe(output);
      expect(result.preview).toContain("FIRST_EVIDENCE");
      expect(result.preview).toContain("LAST_EVIDENCE");
      expect(result.preview!.length).toBeLessThanOrEqual(12000 + 8000 + 100);
    } else expect(result.output).toBe(output);
  });

  it("rethrows persistence failure instead of reporting a successful external operation as failed", async () => {
    const error = new ToolOutputPersistenceError("Storage device offline");
    const storage = outputStore("Already delivered");
    storage.put.mockRejectedValue(error);
    await expect(dispatchToolCall(request("publish-pearl"), { ...setup(async () => "Already delivered"), toolOutputStore: storage.store })).rejects.toBe(error);
  });

  it("saves delegated final reports while keeping ordinary control builtin output out of the store", async () => {
    const report = { agentId: "auditor", sessionId: "child-pearl", status: "completed" as const, text: "完整审查记录" };
    const output = JSON.stringify(report), storage = outputStore(output, "delegate_agent", "child-pearl");
    const context = { ...setup(), tools: [], toolOutputStore: storage.store, agentExecutor: async () => report };
    const result = await dispatchToolCall({ id: "child-pearl", name: "delegate_agent", arguments: '{"agent_id":"auditor","prompt":"Review all event contracts"}' }, context);
    expect(storage.put).toHaveBeenCalledWith(expect.objectContaining({ toolName: "delegate_agent", output }));
    expect(result.fullOutputRef).toBe(storage.reference.resultRef);
    storage.put.mockClear();
    await dispatchToolCall({ id: "notebook-pearl", name: "update_todo", arguments: '{"todos":[]}' }, context);
    expect(storage.put).not.toHaveBeenCalled();
  });
});

describe("Built-in tool start events", () => {
  it("announces a non-interactive built-in by name so the UI can label it", async () => {
    const events: unknown[] = [];
    await dispatchToolCall({ id: "plan-pearl", name: "update_todo", arguments: '{"todos":[]}' }, { ...setup(), tools: [], onEvent: (event: unknown) => events.push(event) } as never);
    expect(events).toContainEqual({ type: "tool_start", toolCallId: "plan-pearl", toolName: "update_todo", args: { todos: [] } });
  });
});

describe("Approval and acquired workspace ownership", () => {
  it.each([true, false])("cancels pending approval before a late answer can execute (reply immediately=%s)", async immediate => {
    const controller = new AbortController(), approval = latch<boolean>();
    const execute = vi.fn(async () => "Applied"), started = vi.fn();
    let settled = false;
    const running = dispatchToolCall(request("awaiting-approval"), {
      ...setup(execute, "mutation"), checkPermission: () => approval.pending, onExecutionStarted: started,
      toolContext: { userQuery: "Approve mutation", signal: controller.signal },
    }).then(result => { settled = true; return result; });
    controller.abort();
    if (immediate) approval.fulfill(true);
    try {
      await expect.poll(() => settled).toBe(true);
      expect(await running).toMatchObject({ outcome: "not_executed" });
      expect(execute).not.toHaveBeenCalled();
      expect(started).not.toHaveBeenCalled();
    } finally { approval.fulfill(true); await running; }
    expect(execute).not.toHaveBeenCalled();
  });

  it("starts only inside the leaf permit and passes the actual invocation scope", async () => {
    const gate = latch<void>(), permit = {}, started = vi.fn();
    const coordinator = { runLeaf: vi.fn(async (_scope, _mode, _signal, action) => { await gate.pending; return action(permit); }), getWriteEvidence: () => [] };
    const scope = { workspaceId: "workspace-pearl", parentRunId: "parent-pearl", groupId: "group-pearl", agentId: "auditor", childRunId: "child-pearl", toolCallId: "prior-call" };
    const execute = vi.fn(async (_args, context) => {
      expect(started).toHaveBeenCalledTimes(1);
      expect(context!.execution).toEqual({ coordinator, scope: { ...scope, toolCallId: "actual-pearl" }, permit });
      return "Acquired";
    });
    const running = dispatchToolCall(request("actual-pearl"), { ...setup(execute), onExecutionStarted: started,
      toolContext: { userQuery: "Inspect", execution: { coordinator: coordinator as never, scope } } });
    await Promise.resolve();
    expect(execute).not.toHaveBeenCalled();
    expect(started).not.toHaveBeenCalled();
    gate.fulfill();
    expect(await running).toMatchObject({ outcome: "success" });
    expect(coordinator.runLeaf).toHaveBeenCalledWith({ ...scope, toolCallId: "actual-pearl" }, "exclusive", undefined, expect.any(Function));
  });

  it("holds a cancelled parent mutation's lease until its original promise actually settles", async () => {
    const coordinator = new RunExecutionCoordinator("dispatch-parent-workspace"), scope = scopeFor(coordinator);
    const controller = new AbortController(), operation = latch<string>();
    const mutate = vi.fn(async () => operation.pending), read = vi.fn(async () => "Child facts"), started = vi.fn();
    const writing = dispatchToolCall(request("write-pearl"), { ...setup(mutate, "mutation"), onExecutionStarted: started,
      toolContext: { userQuery: "Write", signal: controller.signal, execution: { coordinator, scope } } });
    expect(mutate).toHaveBeenCalledOnce();
    controller.abort();
    const context = setup(read);
    context.tools[0] = { ...context.tools[0], id: "safe_lookup", isConcurrencySafe: () => true };
    const reading = dispatchToolCall({ id: "read-pearl", name: "safe_lookup", arguments: "{}" }, { ...context,
      toolContext: { userQuery: "Read", execution: { coordinator, scope: { ...scope, agentId: "auditor", childRunId: "child-pearl" } } } });
    await Promise.resolve();
    expect(read).not.toHaveBeenCalled();
    expect(started).toHaveBeenCalledOnce();
    operation.fulfill("Actually applied");
    expect(await writing).toMatchObject({ outcome: "success" });
    expect(await reading).toMatchObject({ outcome: "success" });
    expect(read).toHaveBeenCalledOnce();
    await coordinator.closeGroup(scope.groupId);
  });

  it("revalidates a queued permission decision before emitting started or executing", async () => {
    const coordinator = new RunExecutionCoordinator("dispatch-policy-workspace"), scope = scopeFor(coordinator), gate = latch<void>();
    const owner = coordinator.runLeaf(scope, "exclusive", undefined, async () => gate.pending);
    let allowed = true;
    const execute = vi.fn(async () => "Changed"), started = vi.fn(), checkPermission = vi.fn(async () => true);
    const running = dispatchToolCall(request("queued-pearl"), { ...setup(execute, "mutation"), onExecutionStarted: started, checkPermission,
      toolContext: { userQuery: "Change", execution: { coordinator, scope }, revalidateToolPermission: () => allowed } });
    await expect.poll(() => checkPermission.mock.calls.length).toBe(1);
    allowed = false; gate.fulfill(); await owner;
    expect(await running).toMatchObject({ outcome: "failure", category: "permission_denied" });
    expect(checkPermission).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
    expect(started).not.toHaveBeenCalled();
    await coordinator.closeGroup(scope.groupId);
  });

  it("allows only the exact scope-bound builtin to control a retained shell job", async () => {
    const { shellJobTool } = await import("../tools/builtin-tools/shell-job-tool");
    const { startShellJob, stopShellJob } = await import("../tools/builtin-tools/shell-job-manager");
    const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-retained-job-"));
    const coordinator = new RunExecutionCoordinator(root), scope = scopeFor(coordinator);
    let job: ReturnType<typeof startShellJob> | undefined;
    try {
      await coordinator.runLeaf(scope, "exclusive", undefined, async permit => {
        job = startShellJob({
          spec: { command: process.execPath, args: ["-e", "setInterval(() => {}, 2000)"], env: process.env, cwd: root, windowsVerbatimArguments: false, ranViaSandbox: false },
          command: "Controlled fixture lifetime", shell: "node", logDir: root, executionScope: scope,
        });
        coordinator.retainUntil(permit, job.completion);
      });
      const context = { ...setup(), tools: [shellJobTool], toolContext: { userQuery: "Inspect retained process", execution: { coordinator, scope } } };
      const statusCall = { id: "inspect-job-pearl", name: "shell_job", arguments: JSON.stringify({ job_id: job!.jobId, action: "status" }) };
      const status = await dispatchToolCall(statusCall, context);
      expect(status.outcome).toBe("success");
      expect(JSON.parse(status.output!).status).toBe("running");
      const impostor = vi.fn(async () => "Impostor"), foreignStarted = vi.fn();
      const spoofed = dispatchToolCall(statusCall, { ...context, tools: [{ ...shellJobTool, execute: impostor }] });
      const foreign = dispatchToolCall(statusCall, { ...context, onExecutionStarted: foreignStarted,
        toolContext: { userQuery: "Foreign scope", execution: { coordinator, scope: { ...scope, parentRunId: "unrelated-parent", groupId: "foreign-pearl", childRunId: "foreign-child" } } } });
      await Promise.resolve();
      expect(impostor).not.toHaveBeenCalled();
      expect(foreignStarted).not.toHaveBeenCalled();
      const stopped = await dispatchToolCall({ ...statusCall, id: "stop-job-pearl", arguments: JSON.stringify({ job_id: job!.jobId, action: "stop" }) }, context);
      expect(JSON.parse(stopped.output!).stopped).toBe(true);
      await job!.completion; await Promise.all([spoofed, foreign]);
      expect(impostor).toHaveBeenCalledOnce();
      expect(foreignStarted).toHaveBeenCalledOnce();
      await coordinator.closeGroup(scope.groupId); await coordinator.closeGroup("foreign-pearl");
    } finally {
      if (job) { stopShellJob(job.jobId); await job.completion; }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
