import { describe, expect, it, vi } from "vitest";
import { delegateAgentToolSpec, executeDelegateAgent, getHarnessBuiltinToolSpecs, isHarnessBuiltin } from "./builtin-tools";
import { dispatchToolCall } from "./tool-dispatcher";
import { getPlanState } from "../plan-mode";

const call = (args: Record<string, unknown>) => ({ id: "delegate-1", name: "delegate_agent", arguments: JSON.stringify(args) });

describe("persistent agent delegation contract", () => {
  it("never exposes the retired public task schema in a new run", () => {
    expect(isHarnessBuiltin("task")).toBe(false);
    expect(getHarnessBuiltinToolSpecs().some(tool => tool.name === "task")).toBe(false);
  });
  it.each(["null", "[]", "123", "\"text\""])("rejects non-object JSON %s without invoking an agent", async raw => {
    const executor = vi.fn();
    expect(await executeDelegateAgent({ id: "invalid", name: "delegate_agent", arguments: raw }, executor))
      .toMatchObject({ outcome: "failure", category: "invalid_arguments" });
    expect(executor).not.toHaveBeenCalled();
  });
  it("rejects ungranted child control tools before changing parent plan state", async () => {
    const conversationId = "child-control-isolation-fixture";
    const original = getPlanState(conversationId);
    for (const name of ["enter_plan_mode", "write_plan", "delegate_agent", "task"]) {
      const result = await dispatchToolCall({ id: name, name, arguments: JSON.stringify({ content: "fixture" }) }, {
        state: { todoItems: [], uncertainEffects: [] }, tools: [], includeInteractiveTools: false,
        allowedBuiltinToolIds: new Set(["update_todo", "read_tool_result"]),
        toolContext: { userQuery: "", conversationId },
        checkPermission: vi.fn(async () => false),
      });
      expect(result).toMatchObject(name === "task"
        ? { outcome: "failure", category: "not_found" }
        : { outcome: "not_executed", category: "runtime_safety" });
    }
    expect(getPlanState(conversationId)).toEqual(original);
  });
  it("advertises the persistent contract without caller-controlled session identity", () => {
    expect(delegateAgentToolSpec.parameters).toMatchObject({
      required: ["agent_id", "prompt"], additionalProperties: false,
    });
    expect(Object.keys(delegateAgentToolSpec.parameters.properties)).toEqual(["agent_id", "prompt"]);
    expect(getHarnessBuiltinToolSpecs({ includeInteractive: false, includeAgent: true }).map(tool => tool.name))
      .toEqual(["update_todo", "delegate_agent", "read_tool_result"]);
  });

  it("delegates exact identity and preserves the structured terminal result", async () => {
    const executor = vi.fn(async () => ({ agentId: "fixture-review", sessionId: "session-1", status: "completed" as const, text: "checked" }));
    const result = await executeDelegateAgent(call({ agent_id: "fixture-review", prompt: "inspect public fixture" }), executor);
    expect(executor).toHaveBeenCalledWith({ agentId: "fixture-review", prompt: "inspect public fixture" });
    expect(result).toMatchObject({ outcome: "success", tool: "delegate_agent" });
    expect(JSON.parse(result.output!)).toEqual({ agentId: "fixture-review", sessionId: "session-1", status: "completed", text: "checked" });
    expect(result.message).not.toContain("inspect public fixture");
  });

  it.each([
    { agent_id: "", prompt: "inspect" },
    { agent_id: "fixture-review", prompt: " " },
    { agent_id: "fixture-review", prompt: "inspect", task_id: "other-session" },
    { agent_id: "fixture-review", prompt: "inspect", allowed_tools: ["run_shell"] },
  ])("rejects invalid or authority-bearing input before delegation", async args => {
    const executor = vi.fn();
    expect(await executeDelegateAgent(call(args), executor)).toMatchObject({ outcome: "failure", category: "invalid_arguments" });
    expect(executor).not.toHaveBeenCalled();
  });

  it("fails closed without an executor and never marks cancellation successful", async () => {
    expect(await executeDelegateAgent(call({ agent_id: "fixture-review", prompt: "inspect" }), undefined))
      .toMatchObject({ outcome: "failure", category: "runtime_safety" });
    const executor = vi.fn(async () => ({ agentId: "fixture-review", sessionId: "session-1", status: "cancelled" as const, text: "" }));
    expect(await executeDelegateAgent(call({ agent_id: "fixture-review", prompt: "inspect" }), executor))
      .toMatchObject({ outcome: "failure" });
  });

  it("routes through the existing dispatcher and persists the full child result", async () => {
    const put = vi.fn(async () => ({ recordId: "a".repeat(64), resultRef: `tool-result://v1/${"a".repeat(64)}` }));
    const result = await dispatchToolCall(call({ agent_id: "fixture-review", prompt: "inspect" }), {
      state: { todoItems: [], uncertainEffects: [] }, tools: [],
      toolContext: { userQuery: "", conversationId: "conversation-1", runId: "run-1" },
      toolOutputStore: { put, read: vi.fn(), find: vi.fn(), deleteConversation: vi.fn() },
      agentExecutor: async () => ({ agentId: "fixture-review", sessionId: "session-1", status: "completed", text: "full report" }),
    });
    expect(put).toHaveBeenCalledWith(expect.objectContaining({ toolName: "delegate_agent", output: expect.stringContaining("full report") }));
    expect(result.fullOutputRef).toBe(`tool-result://v1/${"a".repeat(64)}`);
  });
});

it("passes trusted delegation scope separately from the unchanged model request", async () => {
  const executor = vi.fn(async () => ({ agentId: "fixture-review", sessionId: "session-1", status: "completed" as const, text: "done" }));
  const delegationScope = { groupId: "main-owned-group", toolCallId: "delegate-1" };
  await dispatchToolCall(call({ agent_id: "fixture-review", prompt: "inspect" }), {
    state: { todoItems: [], uncertainEffects: [] }, tools: [], agentExecutor: executor, delegationScope,
  });
  expect(executor).toHaveBeenCalledWith({ agentId: "fixture-review", prompt: "inspect" }, delegationScope);
});

it("duplicate_role_and_failed_sibling_are_local_failures", async () => {
  const executor = vi.fn(async () => { throw new Error("AGENT_ALREADY_RUNNING"); });
  expect(await executeDelegateAgent(call({ agent_id: "fixture-review", prompt: "inspect" }), executor))
    .toMatchObject({ outcome: "failure", category: "runtime_safety", message: expect.stringContaining("AGENT_ALREADY_RUNNING") });
});

it("child_leaf_does_not_deadlock_parent_delegate", async () => {
  const { RunExecutionCoordinator } = await import("./execution-coordinator");
  const coordinator = new RunExecutionCoordinator("synthetic-delegation-workspace");
  const parentScope = { workspaceId: coordinator.workspaceId, parentRunId: "parent", groupId: "group", agentId: "main", childRunId: "parent", toolCallId: "delegate-1" };
  let childEntered = false;
  const result = await dispatchToolCall(call({ agent_id: "fixture-review", prompt: "inspect" }), {
    state: { todoItems: [], uncertainEffects: [] }, tools: [], delegationScope: { groupId: "group", toolCallId: "delegate-1" },
    toolContext: { userQuery: "synthetic", execution: { coordinator, scope: parentScope } },
    agentExecutor: async () => {
      await coordinator.runLeaf({ ...parentScope, agentId: "fixture-review", childRunId: "child", toolCallId: "child-read" }, "shared", undefined, async () => { childEntered = true; });
      return { agentId: "fixture-review", sessionId: "session", status: "completed", text: "done" };
    },
  });
  expect(childEntered).toBe(true);
  expect(result.outcome).toBe("success");
  await coordinator.closeGroup("group");
});
