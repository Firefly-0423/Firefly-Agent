import { expect, describe, it, vi } from "vitest";
import { executeToolDefinition as run } from "./tool-executor";
import { ToolExecutionError } from "./tool-execution-error";
import type { ToolDefinition } from "./tool-registry";
import type { ToolContext } from "./tool-context";

const tool = (execute: ToolDefinition["execute"]): ToolDefinition => ({
  execute, id: "inspect_request", enabled: true, name: "Inspect request", description: "Return request evidence",
  inputSchema: { type: "object", properties: {} },
});
const returning = (value: unknown) => tool(async () => typeof value === "string" ? value : JSON.stringify(value));

describe("execution boundary outcomes", () => {
  it("forwards arguments and cancellation context and normalizes a successful return", async () => {
    const execute = vi.fn(async () => "inspection complete");
    const signal = new AbortController().signal;
    const args = { document: "briefing" };
    expect(await run(tool(execute), args, { userQuery: "Inspect briefing", signal }))
      .toEqual({ status: "succeeded", output: "inspection complete", terminal: true, retryable: false });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(args, expect.objectContaining({ signal }));
  });
  it("retains all facts from a typed execution failure", async () => {
    const execute = async () => { throw new ToolExecutionError("E_REMOTE_TIMEOUT", "Remote outcome unavailable", "timeout", false, "unknown"); };
    expect(await run(tool(execute), {})).toEqual({
      status: "failed", output: "Remote outcome unavailable", errorCode: "E_REMOTE_TIMEOUT",
      category: "timeout", retryable: false, effectState: "unknown", terminal: true,
    });
  });
  it("propagates cancellation to the caller", async () => {
    const cancellation = Object.assign(new Error("Stop inspection"), { name: "AbortError" });
    await expect(run(tool(async () => { throw cancellation; }), {})).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("legacy return-value compatibility", () => {
  it("recognizes explicit business failure with retry metadata", async () => {
    expect(await run(returning({ success: false, error: "Resource not ready", errorCode: "E_BAD", retryable: true }), {}))
      .toMatchObject({ status: "failed", output: "Resource not ready", errorCode: "E_BAD", retryable: true });
  });
  it.each([false, true])("retains the entire timed-out payload with explicit failure=%s", async (explicit) => {
    const payload = { ...(explicit ? { success: false } : {}), command: "serve preview", exitCode: null,
      stdout: "preview started", stderr: "idle deadline expired", timedOut: true, truncated: false };
    const output = JSON.stringify(payload);
    expect(await run(returning(output), {})).toEqual({
      status: "failed", output, errorCode: "E_TOOL_TIMEOUT", category: "timeout",
      retryable: false, effectState: "unknown", terminal: true,
    });
  });
  it("preserves structured failure evidence when no error text is present", async () => {
    const output = JSON.stringify({ success: false, errorCode: "E_EXIT", category: "semantic_failure", effectState: "unknown", exitCode: 7, stdout: "incomplete evidence" });
    expect(await run(returning(output), {})).toMatchObject({ status: "failed", output, errorCode: "E_EXIT", effectState: "unknown" });
  });
  it.each([
    ["[错误] Resource unavailable", "failed", "semantic_failure"],
    ["[拒绝] Access blocked", "failed", "permission_denied"],
    ["A guide to error handling", "succeeded", undefined],
  ])("interprets only a leading marker in %j", async (output, status, category) => {
    const result = await run(returning(output), {});
    expect(result.status).toBe(status);
    expect(result.category).toBe(category);
  });
});

describe("write evidence trust boundary", () => {
  it("uses independently recorded partial writes even when returned JSON claims success", async () => {
    const writes = [{ path: "/fixture/briefing.md", canonicalPath: "/fixture/briefing.md", agentId: "writer-73",
      childRunId: "child-73", toolCallId: "call-73", state: "partially_applied", before: { sha256: "initial" },
      after: { sha256: "changed" }, eventIds: ["event-73"] }];
    const execution = { coordinator: { getWriteEvidence: () => structuredClone(writes) }, scope: {
      workspaceId: "workspace-73", parentRunId: "parent-73", groupId: "group-73", agentId: "writer-73", childRunId: "child-73", toolCallId: "call-73",
    } } as unknown as NonNullable<ToolContext["execution"]>;
    const result = await run(returning({ success: false, error: "Remaining write refused", writes: [{ state: "applied", path: "/untrusted" }] }), {}, { userQuery: "", execution });
    expect(result.output).toEqual("Remaining write refused");
    expect(result.writes).toEqual(writes);
  });
  it("ignores returned write claims when no independent evidence exists", async () => {
    const result = await run(returning({ success: false, error: "Write refused", writes: [{ state: "applied", path: "/untrusted" }] }), {});
    expect(result.writes).toBeUndefined();
  });
});
