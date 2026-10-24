import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarnessRun } from "./firefly-harness";
import type { ToolDefinition } from "../tools/registry/tool-registry";
import type { ToolCall } from "../vendors/types";
import { DEFAULT_HARNESS_CONFIG, type AgentState, type HarnessInput } from "./types";
import { StreamController } from "./stream-controller";
import { TranscriptWriteError } from "../transcript-sink";

vi.mock("../../rag/index", () => ({ searchMemory: vi.fn() }));
vi.mock("electron", () => ({ app: { getPath: () => { throw new Error("no user data in unit test"); }, on: vi.fn() } }));
vi.mock("../../logging/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, LogTag: {} }));
vi.mock("./retry-policy", async original => ({ ...await original<typeof import("./retry-policy")>(), sleepWithJitter: vi.fn(async () => {}) }));
vi.mock("./tool-dispatcher", async original => {
  const actual = await original<typeof import("./tool-dispatcher")>();
  return { ...actual, dispatchToolCall: vi.fn(actual.dispatchToolCall) };
});
import { dispatchToolCall } from "./tool-dispatcher";
import { runToolRound } from "./tool-round";

const call = (id: string, name = "fixture", args = "{}"): ToolCall => ({ id, name, arguments: args });
function fixture(extra: Partial<ToolDefinition> = {}, input: Partial<HarnessInput> = {}) {
  const state: AgentState = { todoItems: [], uncertainEffects: [] };
  const tool: ToolDefinition = { id: "fixture", name: "Fixture", description: "Synthetic", enabled: true,
    effectKind: "read", inputSchema: { type: "object", properties: {} }, execute: vi.fn(async () => "ok"), ...extra };
  const events = vi.fn(); const lifecycle = vi.fn(); const finished = vi.fn(); const checkpoint = vi.fn();
  const run = {
    input: { tools: [tool], runId: "run", onEvent: events, onToolLifecycle: lifecycle, onToolFinished: finished, ...input },
    state, config: { ...DEFAULT_HARNESS_CONFIG }, rounds: 2, messages: [], toolOutputs: [], toolCallStartedAt: new Map(),
    streamController: new StreamController(), checkpoint, currentAssistantEntryId: "assistant-entry",
    clock: { startUserWait: vi.fn(), stopUserWait: vi.fn() },
    toolDispatchContext: { state, tools: [tool], deferOutputPersistence: true },
    askDispatchContext: { state, tools: [tool], deferOutputPersistence: true },
  } as unknown as HarnessRun;
  return { run, tool, state, events, lifecycle, finished, checkpoint,
    observations: () => run.messages.map(message => JSON.parse(String(message.content))) };
}
afterEach(() => { vi.mocked(dispatchToolCall).mockClear(); vi.restoreAllMocks(); });

describe("runToolRound", () => {
  it("accepts an empty round and flushes buffered progress once", async () => {
    const f = fixture(); f.run.streamController.bufferProgressContent("working");
    expect(await runToolRound(f.run, [])).toBe("completed");
    expect(f.events.mock.calls.map(([event]) => event)).toEqual([{ type: "progress_text", content: "working" }]);
    expect(f.run.messages).toEqual([]);
    expect(await runToolRound(f.run, [])).toBe("completed");
    expect(f.events).toHaveBeenCalledTimes(1);
  });
  it("persists the result and checkpoint before publishing committed", async () => {
    const f = fixture(); const order: string[] = [];
    f.run.input.transcriptSink = { appendToolResult: async () => { order.push("persist"); } } as unknown as HarnessInput["transcriptSink"];
    f.checkpoint.mockImplementation(() => order.push("checkpoint"));
    f.lifecycle.mockImplementation(event => order.push(event.status));
    expect(await runToolRound(f.run, [call("a")])).toBe("completed");
    expect(order).toEqual(["planned", "started", "persist", "checkpoint", "committed"]);
    expect(f.observations()[0]).toMatchObject({ outcome: "success", tool: "fixture", output: "ok" });
    expect(f.finished.mock.calls[0][0]).toMatchObject({ toolId: "fixture", toolCallId: "a", runId: "run", status: "success", risk: "safe", durationMs: expect.any(Number) });
  });
  it("uses a planned batch callback and refuses execution if it throws", async () => {
    const planned = vi.fn<NonNullable<HarnessInput["onToolsPlanned"]>>(() => { throw new Error("planned persistence failed"); });
    const f = fixture({}, { onToolsPlanned: planned });
    await expect(runToolRound(f.run, [call("a"), call("b")])).rejects.toThrow(/^planned persistence failed$/);
    expect(planned.mock.calls[0][0].map((e: { toolCallId: string }) => e.toolCallId)).toEqual(["a", "b"]);
    expect(f.tool.execute).not.toHaveBeenCalled(); expect(f.lifecycle).not.toHaveBeenCalled();
  });
  it("commits concurrent calls in declaration order even if the second finishes first", async () => {
    let finishFirst!: (value: string) => void; let secondFinished!: () => void;
    const second = new Promise<void>(resolve => { secondFinished = resolve; });
    const first = new Promise<string>(resolve => { finishFirst = resolve; });
    const f = fixture({ isConcurrencySafe: () => true,
      execute: vi.fn(async args => { if (args.order === 1) return first; secondFinished(); return "second"; }) });
    const pending = runToolRound(f.run, [call("a", "fixture", '{"order":1}'), call("b", "fixture", '{"order":2}')]);
    await second; expect(f.run.messages).toEqual([]);
    finishFirst("first"); await pending;
    expect(f.run.messages.map(m => m.toolCallId)).toEqual(["a", "b"]);
    expect(f.observations().map(o => o.output)).toEqual(["first", "second"]);
  });
  it.each(["null", "[]", "{"])("records invalid arguments without executing: %s", async args => {
    const f = fixture(); await runToolRound(f.run, [call("bad", "fixture", args)]);
    expect(f.tool.execute).not.toHaveBeenCalled();
    expect(f.observations()[0]).toMatchObject({ outcome: "failure", category: "invalid_arguments", message: "工具参数必须是有效的 JSON 对象" });
    expect(f.lifecycle.mock.calls[0][0]).toMatchObject({ status: "planned", toolSideEffect: "non_idempotent_side_effect" });
  });
  it("blocks a tripped tool without resetting its failure streak", async () => {
    const f = fixture(); f.state.toolFailureStreaks = { fixture: 5 };
    await runToolRound(f.run, [call("a")]);
    expect(f.tool.execute).not.toHaveBeenCalled(); expect(f.state.toolFailureStreaks.fixture).toBe(5);
    expect(f.observations()[0]).toMatchObject({ outcome: "not_executed", category: "runtime_safety" });
    expect(f.finished.mock.calls[0][0]).not.toHaveProperty("durationMs");
  });
  it("clears a failure streak after success and increments it on failure", async () => {
    const f = fixture(); f.state.toolFailureStreaks = { fixture: 2 };
    await runToolRound(f.run, [call("a")]); expect(f.state.toolFailureStreaks).toEqual({});
    vi.mocked(dispatchToolCall).mockResolvedValueOnce({ outcome: "failure", category: "invalid_arguments", tool: "fixture", message: "invalid" });
    await runToolRound(f.run, [call("b")]); expect(f.state.toolFailureStreaks).toEqual({ fixture: 1 });
  });
  it("halts on an uncertain non-idempotent effect and records it once", async () => {
    const f = fixture({ effectKind: "external_side_effect" });
    f.run.input.toolContext = { runId: "context-run" } as NonNullable<HarnessInput["toolContext"]>;
    vi.mocked(dispatchToolCall).mockResolvedValueOnce({ outcome: "unknown", tool: "fixture", message: "unknown", toolSideEffect: "non_idempotent_side_effect" });
    await runToolRound(f.run, [call("a"), call("b")]);
    expect(f.state.uncertainEffects).toEqual([{ id: "context-run:a", toolCallId: "a", fingerprint: "fixture()", toolName: "fixture", message: "副作用已发起，但 Runtime 无法确认是否生效" }]);
    expect(f.observations().map(o => o.outcome)).toEqual(["unknown", "not_executed"]);
  });
  it("continues after unknown read-only results but halts on fatal results", async () => {
    const f = fixture();
    vi.mocked(dispatchToolCall).mockResolvedValueOnce({ outcome: "unknown", tool: "fixture", message: "unclear", toolSideEffect: "read_only" });
    await runToolRound(f.run, [call("a"), call("b")]);
    expect(f.observations().map(o => o.outcome)).toEqual(["unknown", "success"]); expect(f.state.uncertainEffects).toEqual([]);
    vi.mocked(dispatchToolCall).mockResolvedValueOnce({ outcome: "failure", category: "fatal", tool: "fixture", message: "fatal" });
    await runToolRound(f.run, [call("c"), call("d")]);
    expect(f.observations().slice(2).map(o => o.outcome)).toEqual(["failure", "not_executed"]);
  });
  it("keeps full runtime output references out of model-visible messages", async () => {
    const f = fixture();
    const ref = { recordId: "output-1" } as NonNullable<Awaited<ReturnType<typeof dispatchToolCall>>["toolOutputRef"]>;
    vi.mocked(dispatchToolCall).mockResolvedValueOnce({ outcome: "success", tool: "fixture", message: "result", truncated: true,
      preview: "short", output: "full secret output", toolOutputRef: ref, rawResult: { output: "internal" } as never });
    await runToolRound(f.run, [call("a")]);
    expect(f.observations()[0]).toMatchObject({ output: "short", preview: "short", truncated: true });
    expect(f.observations()[0]).not.toHaveProperty("rawResult"); expect(f.observations()[0]).not.toHaveProperty("toolOutputRef");
    expect(f.run.toolOutputs).toEqual([ref]);
    vi.mocked(dispatchToolCall).mockResolvedValueOnce({ outcome: "success", tool: "fixture", message: "result", toolOutputRef: ref });
    await runToolRound(f.run, [call("b")]); expect(f.run.toolOutputs).toHaveLength(1);
  });
  it.each(["persist", "checkpoint", "missing-assistant"])("fails closed at the %s boundary and preserves non-idempotent effects", async boundary => {
    const f = fixture({ effectKind: "external_side_effect" });
    f.run.input.transcriptSink = { appendToolResult: async () => { if (boundary === "persist") throw new Error("disk full"); } } as unknown as HarnessInput["transcriptSink"];
    if (boundary === "checkpoint") f.run.checkpointFailure = "snapshot failed";
    if (boundary === "missing-assistant") f.run.currentAssistantEntryId = undefined;
    const error = await runToolRound(f.run, [call("a")]).catch(e => e);
    expect(error).toBeInstanceOf(TranscriptWriteError);
    expect(error.failedKind).toBe("tool_result");
    expect(error.message).toBe(`tool_result 轨迹写入失败：${boundary === "persist" ? "disk full" : boundary === "checkpoint" ? "执行状态保存失败：snapshot failed" : "TRANSCRIPT_ASSISTANT_ENTRY_MISSING"}`);
    expect(f.state.uncertainEffects).toHaveLength(1);
    expect(f.state.uncertainEffects[0]).toMatchObject({ id: "run:a", toolCallId: "a", message: "工具已执行，但结果持久化失败，效果状态未知" });
    expect(f.lifecycle.mock.calls.some(([e]) => e.status === "committed")).toBe(false);
  });
  it.each([true, false])("includes read-file evidence only when the full read is valid (truncated=%s)", async truncated => {
    const f = fixture({ id: "read_file" });
    const append = vi.fn<NonNullable<HarnessInput["transcriptSink"]>["appendToolResult"]>(async () => {});
    f.run.input.transcriptSink = { appendToolResult: append } as unknown as HarnessInput["transcriptSink"];
    const evidence = { path: "a.ts", canonicalPath: "E:/fixture/a.ts", sha256: "hash", startLine: 1, endLine: 2, totalLines: 2 };
    vi.mocked(dispatchToolCall).mockResolvedValueOnce({ outcome: "success", tool: "read_file", message: "read", output: JSON.stringify({ ...evidence, truncated }) });
    await runToolRound(f.run, [call("a", "read_file")]);
    expect(append.mock.calls[0][0].fileRead).toEqual(truncated ? undefined : evidence);
  });
  it("returns cancelled for a pre-aborted ordinary round", async () => {
    const ctrl = new AbortController(); ctrl.abort(); const f = fixture({}, { signal: ctrl.signal });
    expect(await runToolRound(f.run, [call("a")])).toBe("cancelled"); expect(f.tool.execute).not.toHaveBeenCalled();
  });
});

describe("interactive tool rounds", () => {
  it("executes only the first clarification and commits explicit reasons for the other calls", async () => {
    const f = fixture(); f.run.streamController.bufferProgressContent("discard me");
    vi.mocked(dispatchToolCall).mockResolvedValueOnce({ outcome: "success", tool: "ask_user", message: "answer", output: "full answer" });
    await runToolRound(f.run, [call("other"), call("ask1", "ask_user"), call("ask2", "confirm_uncertain_effect")]);
    expect(f.run.messages.map(m => m.toolCallId)).toEqual(["ask2", "other", "ask1"]);
    expect(f.observations()).toEqual([
      { outcome: "not_executed", reason: "not_executed_due_to_another_ask", contentTrust: "untrusted_tool_result" },
      { outcome: "not_executed", reason: "not_executed_due_to_clarification", contentTrust: "untrusted_tool_result" },
      { outcome: "success", tool: "ask_user", message: "answer", output: "full answer", contentTrust: "user_response" },
    ]);
    expect(f.tool.execute).not.toHaveBeenCalled(); expect(f.run.streamController.getBuffered()).toBe("");
    expect(f.events.mock.calls[0][0]).toEqual({ type: "candidate_text_discard", roundId: "round-2" });
    expect(f.run.clock.startUserWait).toHaveBeenCalledTimes(1); expect(f.run.clock.stopUserWait).toHaveBeenCalledTimes(1);
  });
  it("records invalid interactive arguments without starting user-wait timing", async () => {
    const f = fixture(); await runToolRound(f.run, [call("a", "ask_user", "[]")]);
    expect(f.observations()[0]).toMatchObject({ outcome: "failure", category: "invalid_arguments" });
    expect(f.run.clock.startUserWait).not.toHaveBeenCalled();
  });
  it("stops user-wait timing on cancellation", async () => {
    const f = fixture(); const error = Object.assign(new Error("cancelled"), { name: "AbortError" });
    vi.mocked(dispatchToolCall).mockRejectedValueOnce(error);
    expect(await runToolRound(f.run, [call("a", "ask_user")])).toBe("cancelled");
    expect(f.run.clock.stopUserWait).toHaveBeenCalledTimes(1);
  });
  it("propagates non-cancellation interactive errors", async () => {
    const f = fixture(); vi.mocked(dispatchToolCall).mockRejectedValueOnce(new Error("ask storage failed"));
    await expect(runToolRound(f.run, [call("a", "ask_user")])).rejects.toThrow(/^ask storage failed$/);
    expect(f.run.clock.stopUserWait).toHaveBeenCalledTimes(1);
  });
  it("treats interactive tools as ordinary calls when the channel disables them", async () => {
    const f = fixture({}, { includeInteractiveTools: false });
    f.run.toolDispatchContext.includeInteractiveTools = false;
    await runToolRound(f.run, [call("ask", "ask_user"), call("ordinary")]);
    expect(f.observations()[0]).toMatchObject({ outcome: "failure", category: "not_found", message: "当前渠道不支持交互式工具" });
    expect(f.observations()[1].outcome).toBe("success"); expect(f.run.clock.startUserWait).not.toHaveBeenCalled();
  });
});
