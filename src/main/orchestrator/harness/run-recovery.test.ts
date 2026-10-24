import { describe, expect, it } from "vitest";
import { prepareHarnessRecovery } from "./run-recovery";
import { materializeTranscript } from "../conversation-transcript-context";
import type { HarnessRunSession, PersistedToolCall } from "./run-store";
import type { TranscriptEntry } from "../conversation-transcript-types";

const workspace = "D:\\projects\\copper";
function interrupted(calls: Array<Omit<PersistedToolCall, "updatedAt">> = []): HarnessRunSession {
  return {
    schemaVersion: 1, conversationId: "dialog-copper", runId: "paused-copper", status: "interrupted",
    messages: [{ role: "assistant", content: "Collecting workspace facts", toolCalls: calls.map(c => ({
      id: c.toolCallId, name: c.toolName, arguments: JSON.stringify({ filename: "inventory.md" }),
    })) }],
    state: { todoItems: [{ id: "resume-audit", content: "Resume audit", status: "in_progress" }], uncertainEffects: [] },
    toolCalls: calls.map(call => ({ ...call, updatedAt: 41 })), toolOutputs: [], rounds: 6,
    cache: { cacheEpoch: 8, epochReason: "compaction" },
    request: { provider: "custom", model: "previous-model", contextWindowTokens: 64000, mode: "work", promptFingerprint: "persona-copper", toolSchemaFingerprint: "catalog-copper", workspaceRoot: workspace },
    createdAt: 40, updatedAt: 41,
  };
}

describe("Explicit recovery of an interrupted run", () => {
  it("records unknown external work and a paired result without scheduling a replay", () => {
    const original = interrupted([{ toolCallId: "delivery-copper", toolName: "send_email", sideEffect: "non_idempotent_side_effect", status: "started" }]);
    const recovered = prepareHarnessRecovery(original, { workspaceRoot: workspace });
    expect(recovered.state.uncertainEffects).toEqual([expect.objectContaining({ toolCallId: "delivery-copper", toolName: "send_email" })]);
    expect(recovered.messages.at(-1)).toEqual({
      role: "tool", toolCallId: "delivery-copper", content: JSON.stringify({
        outcome: "unknown_after_interruption", tool: "send_email", message: "应用在该副作用完成前中断；不得自动重放，先查证或询问用户。",
      }),
    });
    expect(recovered.recoveryContext).toContain("不得自动重放");
  });

  it("marks planned reads as not executed and carries the cache into a fresh recovery epoch", () => {
    const original = interrupted([{ toolCallId: "lookup-copper", toolName: "read_file", sideEffect: "read_only", status: "planned" }]);
    const before = structuredClone(original);
    const recovered = prepareHarnessRecovery(original, { workspaceRoot: workspace });
    expect(recovered.messages.at(-1)?.content).toContain("not_executed_after_interruption");
    expect(recovered.state.uncertainEffects).toEqual([]);
    expect(recovered.cache).toEqual({ cacheEpoch: 9, epochReason: "recovery" });
    expect(original).toEqual(before);
  });

  it("rejects incompatible workspace binding and runs that are no longer interrupted", () => {
    expect(() => prepareHarnessRecovery(interrupted(), { workspaceRoot: "D:\\projects\\other" })).toThrow("HARNESS_RECOVERY_WORKSPACE_MISMATCH");
    expect(() => prepareHarnessRecovery({ ...interrupted(), status: "completed" }, { workspaceRoot: workspace })).toThrow("HARNESS_RECOVERY_NOT_INTERRUPTED");
  });

  it("states model and removed-tool differences in the recovery context", () => {
    const original = interrupted();
    original.request.enabledToolIds = ["read_file", "legacy_export"];
    const { recoveryContext } = prepareHarnessRecovery(original, { workspaceRoot: workspace, provider: "claude", model: "replacement-model", enabledToolIds: ["read_file"] });
    expect(recoveryContext).toContain("模型已变化：原为 custom/previous-model，当前为 claude/replacement-model。");
    expect(recoveryContext).toContain("恢复时不可用的旧工具：legacy_export。不得假装调用成功。");
  });

  it("pairs all declarations once and agrees with canonical transcript materialization about dispatch boundaries", () => {
    const original = interrupted([
      { toolCallId: "queued-mutation", toolName: "write_file", sideEffect: "non_idempotent_side_effect", status: "planned" },
      { toolCallId: "dispatched-mutation", toolName: "write_file", sideEffect: "non_idempotent_side_effect", status: "started" },
      { toolCallId: "dispatched-read", toolName: "read_file", sideEffect: "read_only", status: "started" },
      { toolCallId: "unconfirmed-mutation", toolName: "write_file", sideEffect: "non_idempotent_side_effect", status: "unknown" },
      { toolCallId: "finished-read", toolName: "read_file", sideEffect: "read_only", status: "committed" },
    ]);
    original.messages[0].toolCalls!.push({ id: "unjournaled", name: "write_file", arguments: "{}" });
    const committed = { role: "tool" as const, toolCallId: "finished-read", content: '{"outcome":"success"}' };
    original.messages.push(committed);
    const recovered = prepareHarnessRecovery(original, { workspaceRoot: workspace });
    const pairs = recovered.messages.filter(m => m.role === "tool");
    const outcomes = pairs.map(m => [m.toolCallId, JSON.parse(m.content as string).outcome]);
    expect(outcomes).toEqual([
      ["finished-read", "success"], ["queued-mutation", "not_executed_after_interruption"],
      ["dispatched-mutation", "unknown_after_interruption"], ["dispatched-read", "unknown_after_interruption"],
      ["unconfirmed-mutation", "unknown_after_interruption"], ["unjournaled", "not_executed_after_interruption"],
    ]);
    for (const declaration of original.messages[0].toolCalls!) expect(pairs.filter(m => m.toolCallId === declaration.id)).toHaveLength(1);
    expect(recovered.state.uncertainEffects.map(e => e.toolCallId)).toEqual(["dispatched-mutation", "unconfirmed-mutation"]);
    const entries = [
      { kind: "assistant", id: "turn-copper", seq: 1, at: 40, runId: original.runId, payload: original.messages[0] },
      { kind: "tool_result", id: "result-copper", seq: 2, at: 41, runId: original.runId, payload: { assistantEntryId: "turn-copper", toolCallId: "finished-read", outcome: "success", message: committed } },
    ] as TranscriptEntry[];
    for (const result of materializeTranscript(entries, { get: () => original }).messages.filter(m => m.role === "tool")) {
      expect(new Map(outcomes).get(result.toolCallId)).toContain(JSON.parse(result.content as string).outcome);
    }
  });
});
