import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolCall, ChatMessage } from "../vendors/types";
import type { ToolDefinition } from "../tools/registry/tool-registry";
import type { HarnessRun } from "./firefly-harness";
import { getHarnessBuiltinToolSpecs } from "./builtin-tools";
import { HarnessRunStore } from "./run-store";
import { prepareHarnessRecovery } from "./run-recovery";
import { StreamController } from "./stream-controller";
import { TimeoutClock } from "./timeout-clock";
import { runToolRound } from "./tool-round";
import { dispatchToolCall } from "./tool-dispatcher";
import { DEFAULT_HARNESS_CONFIG, parseToolCallArgs, type AgentState } from "./types";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture(calls: ToolCall[], options: {
  request?: (card: unknown) => Promise<unknown>;
  interactive?: boolean;
  signal?: AbortSignal;
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-tool-protocol-"));
  roots.push(root);
  const store = new HarnessRunStore(root);
  const state: AgentState = { todoItems: [], uncertainEffects: [{
    id: "old-effect", toolCallId: "old-call", toolName: "synthetic_write", fingerprint: "synthetic_write()", message: "unknown",
  }] };
  let executions = 0;
  const executedArgs: Record<string, unknown>[] = [];
  const tool: ToolDefinition = { id: "synthetic_read", name: "Read", description: "Synthetic local operation", enabled: true,
    effectKind: "read", inputSchema: { type: "object", properties: {} }, execute: async args => { executions++; executedArgs.push(args); return "read"; } };
  const messages: ChatMessage[] = [{ role: "assistant", content: "", toolCalls: calls }];
  store.create({ conversationId: "protocol-chat", runId: "protocol-run", messages, state,
    request: { provider: "synthetic", model: "synthetic", contextWindowTokens: 1000, promptFingerprint: "p", toolSchemaFingerprint: "t" } });
  const context = { state, tools: [tool], requestUserClarification: options.request, includeInteractiveTools: options.interactive,
    toolContext: { userQuery: "fixture", signal: options.signal } };
  const run = {
    input: { tools: [tool], signal: options.signal, includeInteractiveTools: options.interactive,
      onToolsPlanned: events => store.recordTools("protocol-run", events.map(event => ({ toolCallId: event.toolCallId,
        toolName: event.toolName, sideEffect: event.toolSideEffect, status: event.status }))),
      onToolLifecycle: event => store.recordTool("protocol-run", { toolCallId: event.toolCallId,
        toolName: event.toolName, sideEffect: event.toolSideEffect, status: event.status }),
    }, config: DEFAULT_HARNESS_CONFIG, state, messages, rounds: 0, toolOutputs: [], toolCallStartedAt: new Map(),
    clock: new TimeoutClock(0, 0), streamController: new StreamController(),
    askDispatchContext: context, toolDispatchContext: { ...context, deferOutputPersistence: true },
    checkpoint() { store.checkpoint("protocol-run", { messages: run.messages, state }); },
  } as unknown as HarnessRun;
  return { run, store, root, executedArgs, executions: () => executions,
    observation: (id: string) => JSON.parse(String(run.messages.find(message => message.toolCallId === id)?.content)) };
}

const confirmation = (effectId = "old-effect"): ToolCall => ({ id: "confirm", name: "confirm_uncertain_effect", arguments: JSON.stringify({ effectId }) });
const answer = (decision: string) => ({ answers: [{ field: "decision", selectedValues: [decision] }] });

describe("confirmation through the real tool round", () => {
  it.each(["allow_repeat", "do_not_repeat"])("persists %s and retains paired results across restart", async decision => {
    expect(getHarnessBuiltinToolSpecs().some(spec => spec.name === "confirm_uncertain_effect")).toBe(true);
    const sibling = { id: "sibling", name: "synthetic_read", arguments: "{}" };
    const f = fixture([confirmation(), sibling], { request: async () => answer(decision) });
    expect(await runToolRound(f.run, [confirmation(), sibling])).toBe("completed");
    expect(f.observation("confirm")).toMatchObject({ outcome: "success" });
    expect(JSON.parse(f.observation("confirm").output)).toEqual({ effectId: "old-effect", authorized: decision === "allow_repeat" });
    expect(f.observation("sibling").outcome).toBe("not_executed");
    expect(f.executions()).toBe(0);
    const restarted = new HarnessRunStore(f.root);
    const recovered = prepareHarnessRecovery(restarted.get("protocol-run")!, {});
    expect(recovered.state.uncertainEffects).toHaveLength(decision === "allow_repeat" ? 0 : 1);
    for (const id of ["confirm", "sibling"]) expect(recovered.messages.filter(message => message.toolCallId === id)).toHaveLength(1);
  });

  it("keeps the unknown effect when the confirmation times out", async () => {
    const f = fixture([confirmation()], { request: async () => { throw new Error("confirmation timeout"); } });
    await runToolRound(f.run, [confirmation()]);
    expect(f.observation("confirm")).toMatchObject({ outcome: "failure", category: "timeout" });
    expect(new HarnessRunStore(f.root).get("protocol-run")?.state.uncertainEffects).toHaveLength(1);
  });

  it("rejects an unknown effectId without asking the user", async () => {
    const f = fixture([confirmation("missing")], { request: async () => { throw new Error("must not ask"); } });
    await runToolRound(f.run, [confirmation("missing")]);
    expect(f.observation("confirm")).toMatchObject({ outcome: "failure", category: "invalid_arguments" });
    expect(f.run.state.uncertainEffects).toHaveLength(1);
  });

  it("does not expose confirmation in a noninteractive channel", async () => {
    expect(getHarnessBuiltinToolSpecs({ includeInteractive: false }).some(spec => spec.name === "confirm_uncertain_effect")).toBe(false);
    const f = fixture([confirmation()], { interactive: false, request: async () => { throw new Error("must not ask"); } });
    await runToolRound(f.run, [confirmation()]);
    expect(f.observation("confirm")).toMatchObject({ outcome: "failure", category: "not_found" });
    expect(f.run.state.uncertainEffects).toHaveLength(1);
  });

  it("a late answer cannot clear an unknown effect after cancellation", async () => {
    const controller = new AbortController();
    let respond!: (value: unknown) => void;
    let asked!: () => void;
    const entered = new Promise<void>(resolve => { asked = resolve; });
    const f = fixture([confirmation()], { signal: controller.signal, request: () => {
      asked(); return new Promise(resolve => { respond = resolve; });
    } });
    const round = runToolRound(f.run, [confirmation()]);
    await entered;
    controller.abort();
    expect(await round).toBe("cancelled");
    respond(answer("allow_repeat"));
    await new Promise(resolve => setImmediate(resolve));
    expect(f.run.state.uncertainEffects).toHaveLength(1);
    expect(new HarnessRunStore(f.root).get("protocol-run")?.state.uncertainEffects).toHaveLength(1);
  });

  it("does not authorize when cancellation wins before the answer continuation", async () => {
    const controller = new AbortController();
    let respond!: (value: unknown) => void;
    const response = new Promise(resolve => { respond = resolve; });
    const f = fixture([confirmation()], { signal: controller.signal, request: () => response });
    const result = dispatchToolCall(confirmation(), f.run.askDispatchContext);
    respond(answer("allow_repeat"));
    queueMicrotask(() => controller.abort());
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(f.run.state.uncertainEffects).toHaveLength(1);
  });
});

const invalidArguments = ["{", "null", "[]", '[{"path":"a"}]', '"text"', "1", "true"];
describe("tool arguments at the protocol boundary", () => {
  it.each(invalidArguments)("rejects %s at the parser", argumentsText => {
    expect(() => parseToolCallArgs({ id: "invalid", name: "synthetic_read", arguments: argumentsText })).toThrow();
  });

  it.each(invalidArguments)("pairs %s with invalid_arguments without entering the tool body", async argumentsText => {
    const calls = [{ id: "invalid", name: "synthetic_read", arguments: argumentsText }, { id: "valid", name: "synthetic_read", arguments: "{}" }];
    const f = fixture(calls);
    expect(await runToolRound(f.run, calls)).toBe("completed");
    expect(f.observation("invalid")).toMatchObject({ outcome: "failure", category: "invalid_arguments" });
    expect(f.observation("valid")).toMatchObject({ outcome: "success" });
    expect(f.executions()).toBe(1);
    for (const id of ["invalid", "valid"]) expect(f.run.messages.filter(message => message.toolCallId === id)).toHaveLength(1);
  });

  it.each(invalidArguments)("rejects %s for an interactive builtin without asking", async argumentsText => {
    const call = { id: "invalid", name: "confirm_uncertain_effect", arguments: argumentsText };
    const f = fixture([call], { request: async () => { throw new Error("must not ask"); } });
    await runToolRound(f.run, [call]);
    expect(f.observation("invalid")).toMatchObject({ outcome: "failure", category: "invalid_arguments" });
    expect(f.run.state.uncertainEffects).toHaveLength(1);
  });

  it("keeps valid nested object arguments intact", async () => {
    const args = { payload: { a: 1 }, list: [true, null, "text"], path: "a" };
    const call = { id: "valid", name: "synthetic_read", arguments: JSON.stringify(args) };
    const f = fixture([call]);
    await runToolRound(f.run, [call]);
    expect(f.observation("valid")).toMatchObject({ outcome: "success" });
    expect(f.executedArgs).toEqual([args]);
  });

  it("does not invent an unknown side effect when saving a rejected call fails", async () => {
    const call = { id: "invalid", name: "synthetic_read", arguments: "null" };
    const f = fixture([call]);
    f.run.currentAssistantEntryId = "assistant";
    f.run.input.transcriptSink = { appendToolResult: async () => { throw new Error("synthetic disk failure"); } } as unknown as NonNullable<HarnessRun["input"]["transcriptSink"]>;
    await expect(runToolRound(f.run, [call])).rejects.toThrow();
    expect(f.executions()).toBe(0);
    expect(f.run.state.uncertainEffects).toEqual([{ id: "old-effect", toolCallId: "old-call", toolName: "synthetic_write", fingerprint: "synthetic_write()", message: "unknown" }]);
  });
});

describe("legacy interrupted calls with invalid arguments", () => {
  it("does not recreate a cleared effect from a paired historical unknown result", () => {
    const call = { id: "cleared", name: "synthetic_read", arguments: "null" };
    const f = fixture([call]);
    f.store.checkpoint("protocol-run", { state: { todoItems: [], uncertainEffects: [] },
      messages: [...f.run.messages, { role: "tool", toolCallId: call.id, content: '{"outcome":"unknown"}' }] });
    f.store.recordTool("protocol-run", { toolCallId: call.id, toolName: call.name, sideEffect: "non_idempotent_side_effect", status: "unknown" });
    const recovered = prepareHarnessRecovery(new HarnessRunStore(f.root).get("protocol-run")!, {});
    expect(recovered.state.uncertainEffects).toEqual([]);
    expect(recovered.messages.filter(message => message.toolCallId === call.id)).toHaveLength(1);
  });
  it.each(invalidArguments)("keeps %s conservatively blocked across checkpoints and restart", async argumentsText => {
    const call = { id: "legacy", name: "synthetic_read", arguments: argumentsText };
    const f = fixture([call]);
    f.store.recordTool("protocol-run", { toolCallId: call.id, toolName: call.name, sideEffect: "non_idempotent_side_effect", status: "started" });
    const recovered = prepareHarnessRecovery(new HarnessRunStore(f.root).get("protocol-run")!, {});
    expect(recovered.state.uncertainEffects).toContainEqual(expect.objectContaining({ toolCallId: "legacy", toolName: call.name, argumentsUnavailable: true }));
    expect(recovered.messages.filter(message => message.toolCallId === "legacy")).toHaveLength(1);
    expect(JSON.parse(String(recovered.messages.at(-1)?.content)).outcome).toBe("unknown_after_interruption");
    f.store.checkpoint("protocol-run", { state: recovered.state, messages: recovered.messages });
    const restarted = new HarnessRunStore(f.root).get("protocol-run")!;
    const result = await dispatchToolCall({ ...call, id: "corrected", arguments: '{"path":"corrected"}' }, { ...f.run.toolDispatchContext, state: restarted.state });
    expect(result).toMatchObject({ outcome: "not_executed", category: "runtime_safety" });
    expect(f.executions()).toBe(0);
    expect(restarted.state.uncertainEffects).toContainEqual(expect.objectContaining({ toolCallId: "legacy", argumentsUnavailable: true }));
  });

  it("upgrades an existing unresolved effect even when an unknown result already pairs the call", async () => {
    const call = { id: "legacy", name: "synthetic_read", arguments: "null" };
    const f = fixture([call]);
    const state: AgentState = { todoItems: [], uncertainEffects: [{ id: "old-legacy", toolCallId: call.id,
      toolName: call.name, fingerprint: "synthetic_read()", message: "unknown" }] };
    f.store.checkpoint("protocol-run", { state, messages: [...f.run.messages, { role: "tool", toolCallId: call.id, content: '{"outcome":"unknown"}' }] });
    f.store.recordTool("protocol-run", { toolCallId: call.id, toolName: call.name, sideEffect: "non_idempotent_side_effect", status: "unknown" });
    const recovered = prepareHarnessRecovery(new HarnessRunStore(f.root).get("protocol-run")!, {});
    expect(recovered.messages.filter(message => message.toolCallId === call.id)).toHaveLength(1);
    const result = await dispatchToolCall({ ...call, id: "corrected", arguments: '{"path":"new"}' }, { ...f.run.toolDispatchContext, state: recovered.state });
    expect(result).toMatchObject({ outcome: "not_executed", category: "runtime_safety" });
    expect(f.executions()).toBe(0);
    expect(recovered.state.uncertainEffects).toEqual([{ ...state.uncertainEffects[0], argumentsUnavailable: true }]);
  });
});
