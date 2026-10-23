import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, ChatRequest, ChatResponse, ToolCall } from "../vendors/types";
import type { ToolDefinition } from "../tools/registry/tool-registry";
import type { TranscriptSink } from "../transcript-sink";
import type { HarnessCacheDiagnostic, HarnessCheckpoint, HarnessEvent, HarnessInput, HarnessToolFinishedEvent, HarnessToolLifecycleEvent, RunAdjustmentMessage } from "./types";
import type { ToolDispatchResult } from "./tool-dispatcher";

const provider = vi.hoisted(() => {
  const adapter = { id: "contract-provider", buildRequest: (request: unknown) => ({
    url: "https://harness.invalid/chat", method: "POST" as const, headers: { "Content-Type": "application/json" }, body: JSON.stringify(request),
  }), parseResponse: (raw: unknown) => raw };
  return { adapter, select: vi.fn(() => adapter), stream: vi.fn(), usage: vi.fn(), requests: vi.fn() };
});
vi.mock("../vendors", () => ({ getAdapterForConfig: provider.select, streamChatWithSdk: provider.stream, resolveTransport: () => "openai" }));
vi.mock("./tool-dispatcher", () => ({ dispatchToolCall: vi.fn(), persistToolDispatchResult: async (_call: unknown, result: unknown) => result }));
vi.mock("../../token-usage-store", () => ({ recordModelCall: vi.fn(), recordToolCall: vi.fn(), recordUsage: provider.usage, recordRequest: provider.requests }));
import { runFireflyHarness } from "./firefly-harness";
import { dispatchToolCall } from "./tool-dispatcher";
import { DEFAULT_HARNESS_CONFIG } from "./types";
import { projectCacheRelevantChatRequest } from "../prompt-layers";

const dispatch = vi.mocked(dispatchToolCall);
const config = { provider: "custom", model: "contract-model", apiKey: "", baseUrl: "https://harness.invalid" } as HarnessInput["vendorConfig"];
const toolCall = (id = "save-amber", name = "write_file", args: object = { path: "D:/fixture/audit.md", content: "Verified contracts" }): ToolCall =>
  ({ id, name, arguments: JSON.stringify(args) });
function response(text = "", calls: ToolCall[] = []): ChatResponse {
  return { text, toolCalls: calls, assistantMessage: { role: "assistant", content: text, ...(calls.length ? { toolCalls: calls } : {}) }, finishReason: calls.length ? "tool_calls" : "stop", raw: {} };
}
function tool(id = "write_file", effectKind: ToolDefinition["effectKind"] = "mutation"): ToolDefinition {
  return { id, name: `Fixture ${id}`, description: "Operate on fixture evidence", enabled: true,
    effectKind, inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } }, execute: vi.fn(),
    ...(effectKind === "read" ? { isConcurrencySafe: () => true } : {}) };
}
const success = (name = "write_file"): ToolDispatchResult => ({
  outcome: "success", tool: name, message: "Saved evidence", preview: "Saved evidence", output: "Saved evidence", truncated: false,
  rawResult: { toolId: name, args: {}, output: "Saved evidence", status: "succeeded", terminal: true, retryable: false },
});
function latch<T>() {
  let release!: (value: T) => void;
  const pending = new Promise<T>(resolve => { release = resolve; });
  return { pending, release };
}
function sequence(...responses: ChatResponse[]) {
  const remaining = [...responses];
  provider.stream.mockImplementation(async () => {
    const next = remaining.shift();
    if (!next) throw new Error("Fixture model responses exhausted");
    return next;
  });
}
function run(extra: Partial<HarnessInput> = {}) {
  const events: HarnessEvent[] = [];
  const input: HarnessInput = { systemPrompt: "Evidence review persona", messages: [{ role: "user", content: "Review observable contracts" }], tools: [], vendorConfig: config, onEvent: event => events.push(event), ...extra };
  return { input, events, result: runFireflyHarness(input) };
}
const sentRequest = (index: number): ChatRequest => provider.stream.mock.calls[index][0].request;
const selectedEvents = <T extends HarnessEvent["type"]>(events: HarnessEvent[], type: T) =>
  events.filter((event): event is Extract<HarnessEvent, { type: T }> => event.type === type);
function sink(overrides: Partial<TranscriptSink> = {}): TranscriptSink {
  return { appendAssistant: vi.fn(async () => "canonical-amber"), appendToolResult: vi.fn(async () => {}),
    closeInterruption: vi.fn(async () => {}), checkpoint: vi.fn(async () => {}), ...overrides };
}
beforeEach(() => { vi.resetAllMocks(); provider.select.mockReturnValue(provider.adapter); dispatch.mockResolvedValue(success()); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Provider request and public streaming behavior", () => {
  it("starts native tool streaming with bounded defaults and no fixed OpenAI output cap", async () => {
    sequence(response("Audit delivered"));
    const job = run({ tools: [tool()] });
    expect((await job.result).finalAnswer).toBe("Audit delivered");
    expect(DEFAULT_HARNESS_CONFIG).toMatchObject({ maxRounds: 200, totalTimeoutMs: 7200000, modelRequestTimeoutMs: 600000 });
    expect(provider.stream).toHaveBeenCalledTimes(1);
    expect(provider.stream).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 600000, request: expect.objectContaining({ stream: true, tools: expect.any(Array) }) }));
    expect("maxTokens" in sentRequest(0)).toBe(false);
  });

  it("forwards explicit zero limits and adapter cache routing hints", async () => {
    const adapter = { ...provider.adapter, applyCacheHints: (request: ChatRequest) => ({ ...request, extraBody: { prompt_cache_key: "session-amber-cache" } }) };
    provider.select.mockReturnValueOnce(adapter);
    sequence(response("Unbounded fixture complete"));
    await run({ config: { maxRounds: 0, totalTimeoutMs: 0, modelRequestTimeoutMs: 0 } }).result;
    expect(provider.stream).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 0, request: expect.objectContaining({ extraBody: { prompt_cache_key: "session-amber-cache" } }) }));
  });

  it("records provider-reported usage including cached input tokens", async () => {
    sequence({ ...response("Metered answer"), usage: { input: 31, output: 9, cachedInput: 14 } });
    await run().result;
    expect(provider.usage).toHaveBeenCalledExactlyOnceWith(31, 9, 1, 14, "contract-model", undefined);
  });

  it("preserves reasoning start, delta order and end using the current round identity", async () => {
    provider.stream.mockImplementationOnce(async ({ onDelta }) => {
      onDelta({ type: "reasoning_delta", delta: "核对声明" });
      onDelta({ type: "reasoning_delta", delta: "再核对结果" });
      return response("Reasoned answer");
    });
    const job = run();
    await job.result;
    expect(job.events.filter(event => event.type.startsWith("reasoning_"))).toEqual([
      { type: "reasoning_start", messageId: "reasoning-0" },
      { type: "reasoning_delta", messageId: "reasoning-0", delta: "核对声明" },
      { type: "reasoning_delta", messageId: "reasoning-0", delta: "再核对结果" },
      { type: "reasoning_end", messageId: "reasoning-0" },
    ]);
  });

  it("filters the timestamp prefix while delivering each visible chunk before final settlement", async () => {
    const middle = latch<void>(), ending = latch<void>();
    provider.stream.mockImplementationOnce(async ({ onDelta }) => {
      onDelta({ type: "text_delta", delta: "[2026-10-20 09:30, Asia/Singapore] " });
      onDelta({ type: "text_delta", delta: "先核对，" });
      await middle.pending;
      onDelta({ type: "text_delta", delta: "再运行检查，" });
      await ending.pending;
      onDelta({ type: "text_delta", delta: "最后交付报告。" });
      return response("先核对，再运行检查，最后交付报告。");
    });
    const job = run();
    const candidates = () => selectedEvents(job.events, "candidate_text_delta");
    await expect.poll(candidates).toEqual([{ type: "candidate_text_delta", roundId: "round-0", delta: "先核对，" }]);
    middle.release();
    await expect.poll(candidates).toEqual([
      { type: "candidate_text_delta", roundId: "round-0", delta: "先核对，" },
      { type: "candidate_text_delta", roundId: "round-0", delta: "再运行检查，" },
    ]);
    expect(job.events.some(event => event.type === "final_answer")).toBe(false);
    ending.release();
    await job.result;
    expect(candidates()).toEqual([
      { type: "candidate_text_delta", roundId: "round-0", delta: "先核对，" },
      { type: "candidate_text_delta", roundId: "round-0", delta: "再运行检查，" },
      { type: "candidate_text_delta", roundId: "round-0", delta: "最后交付报告。" },
    ]);
    expect(job.events.findIndex(event => event.type === "candidate_text_delta")).toBeLessThan(job.events.findIndex(event => event.type === "final_answer"));
  });

  it("retries a zero-delta explicit stream rejection once as a nonstream request", async () => {
    provider.stream.mockRejectedValueOnce(Object.assign(new Error("stream unsupported on this endpoint"), { status: 400 }));
    const fetch = vi.fn(async () => ({ ok: true, json: async () => response("Fallback answer") }));
    vi.stubGlobal("fetch", fetch);
    expect((await run().result).finalAnswer).toBe("Fallback answer");
    expect(provider.stream).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse((fetch.mock.calls[0] as unknown as [unknown, RequestInit])[1].body as string)).toMatchObject({ stream: false });
  });

  it("never replays a partially delivered stream even if the provider later rejects streaming", async () => {
    provider.stream.mockImplementationOnce(async ({ onDelta }) => {
      onDelta({ type: "reasoning_delta", delta: "Already delivered a token" });
      throw Object.assign(new Error("stream unsupported after data"), { status: 400 });
    });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect((await run().result).terminateReason).toBe("error");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("appends the exact truncation notice to a length-limited final answer", async () => {
    sequence({ ...response("Partial audit"), finishReason: "length" });
    const answer = (await run().result).finalAnswer;
    expect(answer).toBe("Partial audit\n\n⚠️ 模型输出达到长度上限，以上回复可能不完整。");
    expect(answer.endsWith("以上回复可能不完整。")).toBe(true);
  });
});

describe("Tool rounds, completion and output projection", () => {
  it("accepts the next no-tool answer after mutation and exposes ordered round boundaries", async () => {
    sequence(response("", [toolCall()]), response("Saved the audit"));
    const job = run();
    const result = await job.result;
    expect(provider.stream).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ finalAnswer: "Saved the audit", terminated: false });
    expect(result.terminateReason).toBeUndefined();
    expect("completionObligations" in result.finalState).toBe(false);
    expect(selectedEvents(job.events, "runtime_feedback")).toEqual([]);
    expect(job.events.filter(event => event.type === "round_start" || event.type === "round_end")).toEqual([
      { type: "round_start", roundId: "round-0" }, { type: "round_end", roundId: "round-0" },
      { type: "round_start", roundId: "round-1" }, { type: "round_end", roundId: "round-1" },
    ]);
    expect(job.events.findIndex(event => event.type === "round_end" && event.roundId === "round-1")).toBeLessThan(job.events.findIndex(event => event.type === "final_answer"));
  });

  it("publishes delegated structured results independently from the short tool preview", async () => {
    const taskResult = { agentId: "auditor", sessionId: "child-amber", status: "completed", text: "Evidence report " + "detail ".repeat(90) };
    sequence(response("", [toolCall("delegate-amber", "delegate_agent", { agent_id: "auditor", prompt: "Audit evidence" })]), response("Delegation reviewed"));
    dispatch.mockResolvedValue({ ...success("delegate_agent"), output: JSON.stringify(taskResult), preview: "Agent auditor: completed" });
    const job = run();
    await job.result;
    expect(selectedEvents(job.events, "tool_end")[0]).toMatchObject({ toolCallId: "delegate-amber", preview: "Agent auditor: completed", taskResult });
  });

  it("starts safe reads together but commits events and model observations in declaration order", async () => {
    const first = latch<void>(), second = latch<void>(), started: string[] = [];
    sequence(response("", [toolCall("east-amber", "read_east", {}), toolCall("west-amber", "read_west", {})]), response("Reads complete"));
    dispatch.mockImplementation(async call => { started.push(call.id); await (call.id === "east-amber" ? first.pending : second.pending); return success(call.name); });
    const job = run({ tools: [tool("read_east", "read"), tool("read_west", "read")], config: { maxParallelToolCalls: 2 } });
    await expect.poll(() => started).toEqual(["east-amber", "west-amber"]);
    second.release();
    await Promise.resolve();
    expect(selectedEvents(job.events, "tool_end")).toEqual([]);
    first.release();
    expect((await job.result).finalAnswer).toBe("Reads complete");
    expect(selectedEvents(job.events, "tool_end").map(event => event.toolCallId)).toEqual(["east-amber", "west-amber"]);
    expect(sentRequest(1).messages.filter(m => m.role === "tool").map(m => m.toolCallId)).toEqual(["east-amber", "west-amber"]);
  });

  it("continues through 51 tool rounds and enforces an explicit one-round cap before another request", async () => {
    sequence(...Array.from({ length: 51 }, (_, index) => response("", [toolCall(`long-amber-${index}`)])), response("Long audit complete"));
    const long = await run().result;
    expect(long.finalAnswer).toBe("Long audit complete");
    expect(long.rounds).toBe(51);
    expect(long.terminateReason).toBeUndefined();
    expect(provider.stream).toHaveBeenCalledTimes(52);
    provider.stream.mockClear();
    sequence(response("", [toolCall()]), response("Must remain unused"));
    const bounded = await run({ config: { maxRounds: 1 } }).result;
    expect(bounded.rounds).toBe(1);
    expect(bounded.terminateReason).toBe("max_rounds");
    expect(bounded.finalAnswer).toBe("任务已达到工具轮次上限（1），已停止继续执行。\n\n中断原因：工具轮次上限");
    expect(provider.stream).toHaveBeenCalledTimes(1);
  });

  it("trips after five semantic failures and supplies a synthetic refusal for the sixth call", async () => {
    sequence(...Array.from({ length: 6 }, (_, i) => response("", [toolCall(`streak-amber-${i}`)])), response("Alternative completed"));
    dispatch.mockResolvedValue({ outcome: "failure", category: "semantic_failure", tool: "write_file", message: "Required filename omitted" });
    expect((await run({ tools: [tool()] }).result).finalAnswer).toBe("Alternative completed");
    expect(dispatch).toHaveBeenCalledTimes(5);
    const last = sentRequest(6).messages.filter(message => message.role === "tool").at(-1)!;
    expect(last.toolCallId).toBe("streak-amber-5");
    expect(String(last.content)).toContain("not_executed");
    expect(String(last.content)).toContain("熔断");
  });

  it("keeps intermediate tool-round text in progress and publishes only the last answer as final", async () => {
    sequence(response("Inspecting declarations", [toolCall("inspect-amber")]), response("Checking results", [toolCall("verify-amber")]), response("Final evidence"));
    const job = run({ tools: [tool()] });
    expect((await job.result).finalAnswer).toBe("Final evidence");
    expect(selectedEvents(job.events, "progress_text").map(event => event.content)).toEqual(["Inspecting declarations", "Checking results"]);
    expect(selectedEvents(job.events, "final_answer")).toEqual([{ type: "final_answer", content: "Final evidence" }]);
  });

  it("accepts an honest final after an unknown external effect while retaining uncertainty", async () => {
    sequence(response("", [toolCall("send-amber", "send_email", { to: "recipient@invalid.test" })]), response("Delivery cannot be confirmed"));
    dispatch.mockResolvedValue({ outcome: "unknown", tool: "send_email", message: "Remote acknowledgement absent", rawResult: { toolId: "send_email", args: {}, output: "", status: "failed", terminal: true, retryable: false } });
    const job = run({ tools: [tool("send_email", "external_side_effect")] });
    const result = await job.result;
    expect(provider.stream).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ finalAnswer: "Delivery cannot be confirmed", terminated: false });
    expect(result.terminateReason).toBeUndefined();
    expect("completionObligations" in result.finalState).toBe(false);
    expect(result.finalState.uncertainEffects).toHaveLength(1);
    expect(result.finalState.uncertainEffects[0].toolName).toBe("send_email");
    expect(selectedEvents(job.events, "runtime_feedback")).toEqual([]);
  });

  it("exposes only the pruned observation to the next model request and retains full-output references in checkpoints", async () => {
    const raw = "BEGIN_AUDIT\n" + "x".repeat(4700) + "\nHIDDEN_MIDDLE_EVIDENCE\n" + "y".repeat(4700) + "\nEND_AUDIT";
    const preview = "BEGIN_AUDIT\n\n[... tool result middle pruned ...]\n\nEND_AUDIT";
    const reference = { recordId: "f".repeat(64), resultRef: `tool-result://v1/${"f".repeat(64)}`, runId: "run-amber", toolCallId: "output-amber", toolName: "write_file", bytes: raw.length, codePoints: [...raw].length, truncatedForModel: true, createdAt: 91 };
    sequence(response("", [toolCall("output-amber")]), response("Output reviewed"));
    dispatch.mockResolvedValue({ ...success(), output: raw, message: preview, preview, truncated: true, toolOutputRef: reference });
    const checkpoints: HarnessCheckpoint[] = [];
    await run({ onCheckpoint: checkpoint => checkpoints.push(checkpoint) }).result;
    const message = sentRequest(1).messages.find(m => m.role === "tool")!;
    expect(message.content).toContain("BEGIN_AUDIT");
    expect(message.content).toContain("END_AUDIT");
    expect(message.content).not.toContain("HIDDEN_MIDDLE_EVIDENCE");
    expect(message.content).not.toContain("toolOutputRef");
    expect(checkpoints.some(c => c.messages.some(m => m.role === "tool"))).toBe(true);
    expect(checkpoints.some(c => c.toolOutputs[0]?.toolCallId === "output-amber")).toBe(true);
    expect(checkpoints.at(-1)).toMatchObject({ rounds: 1 });
    expect(checkpoints.at(-1)!.messages).toBe(checkpoints.at(-2)!.messages);
  });

  it("passes the same live checkpoint references while their observed transcript lengths grow", async () => {
    sequence(response("", [toolCall()]), response("Checkpointed"));
    const snapshots: HarnessCheckpoint[] = [], lengths: number[] = [];
    await run({ tools: [tool()], onCheckpoint: checkpoint => { snapshots.push(checkpoint); lengths.push(checkpoint.messages.length); } }).result;
    expect(snapshots.length).toBeGreaterThanOrEqual(2);
    expect(snapshots.at(-1)!.messages).toBe(snapshots[0].messages);
    expect(snapshots.at(-1)!.state).toBe(snapshots[0].state);
    expect(snapshots.at(-1)!.toolOutputs).toBe(snapshots[0].toolOutputs);
    expect(lengths.at(-1)!).toBeGreaterThan(lengths[0]);
  });

  it("publishes planned, actual started and committed lifecycle facts and a bounded completion event", async () => {
    sequence(response("", [toolCall("lifecycle-amber")]), response("Lifecycle complete"));
    dispatch.mockImplementation(async (_call, context) => { context.onExecutionStarted?.(); return success(); });
    const lifecycle: HarnessToolLifecycleEvent[] = [], finished: HarnessToolFinishedEvent[] = [];
    await run({ tools: [{ ...tool(), risk: "fs-write" }], runId: "run-amber", onToolLifecycle: event => lifecycle.push(event), onToolFinished: event => finished.push(event) }).result;
    expect(lifecycle).toEqual([
      { toolCallId: "lifecycle-amber", toolName: "write_file", toolSideEffect: "idempotent_mutation", status: "planned" },
      { toolCallId: "lifecycle-amber", toolName: "write_file", toolSideEffect: "idempotent_mutation", status: "started" },
      { toolCallId: "lifecycle-amber", toolName: "write_file", toolSideEffect: "idempotent_mutation", status: "committed" },
    ]);
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ toolId: "write_file", toolCallId: "lifecycle-amber", runId: "run-amber", status: "success", risk: "fs-write" });
    expect(finished[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(Object.keys(finished[0]).sort()).toEqual(["durationMs", "risk", "runId", "status", "toolCallId", "toolId"]);
  });
});

describe("Interactive tools and append-only runtime facts", () => {
  it("forwards the canonical signal to uncertain-effect confirmation", async () => {
    const controller = new AbortController();
    sequence(response("", [toolCall("confirm-amber", "confirm_uncertain_effect", { effectId: "pending-amber" })]), response("Confirmation processed"));
    dispatch.mockImplementation(async (call, context) => {
      expect(context.toolContext?.signal).toBe(controller.signal);
      return { outcome: "success", tool: call.name, message: "Confirmed" };
    });
    expect((await run({ signal: controller.signal }).result).finalAnswer).toBe("Confirmation processed");
  });

  it("retains the child's builtin allowlist in both schemas and dispatch context", async () => {
    const allowedBuiltinToolIds = new Set(["update_todo", "read_tool_result"]);
    sequence(response("", [toolCall("forbidden-plan", "enter_plan_mode", {})]), response("Restricted run complete"));
    dispatch.mockResolvedValue({ outcome: "not_executed", category: "runtime_safety", tool: "enter_plan_mode", message: "Not authorized" });
    await run({ allowedBuiltinToolIds, planState: "NORMAL", includeInteractiveTools: false }).result;
    expect(sentRequest(0).tools!.map(spec => spec.name)).toEqual(["read_tool_result", "update_todo"]);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ name: "enter_plan_mode" }), expect.objectContaining({ allowedBuiltinToolIds }));
  });

  it("displaces other calls with Ask, discards candidate text and exposes completion timing only for the actual Ask", async () => {
    sequence(response("Before asking", [toolCall("ask-amber", "ask_user", { questions: [{ id: "delivery", question: "Delivery preference?", type: "text" }] }), toolCall("read-amber", "read_file", {})]), response("Following preferences"));
    dispatch.mockResolvedValue({ outcome: "success", tool: "ask_user", message: "User answered" });
    const finished: HarnessToolFinishedEvent[] = [];
    const job = run({ runId: "interactive-amber", tools: [tool("read_file", "read")], onToolFinished: event => finished.push(event) });
    await job.result;
    expect(finished).toEqual([
      expect.objectContaining({ toolId: "read_file", toolCallId: "read-amber", status: "not_executed", risk: "safe" }),
      expect.objectContaining({ toolId: "ask_user", toolCallId: "ask-amber", status: "success", risk: "safe" }),
    ]);
    expect("durationMs" in finished[0]).toBe(false);
    expect(finished[1].durationMs).toBeGreaterThanOrEqual(0);
    expect(job.events).toContainEqual({ type: "candidate_text_discard", roundId: "round-0" });
  });

  it("keeps all Ask answers available to the next model decision within the same run", async () => {
    sequence(response("Requesting preferences", [toolCall("ask-answers", "ask_user", { questions: [] })]), response("Preferences applied"));
    dispatch.mockResolvedValue({ outcome: "success", tool: "ask_user", message: "Three answers received", output: JSON.stringify({ answers: [
      { questionId: "delivery", selectedValues: ["web"], selectedLabels: ["网页"] },
      { questionId: "chapters", selectedValues: ["findings", "evidence"], selectedLabels: ["结论", "证据"] },
      { questionId: "instruction", customInput: "终止这次调查" },
    ] }) });
    expect((await run().result).finalAnswer).toBe("Preferences applied");
    expect(provider.stream).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(sentRequest(1).messages)).toContain("终止这次调查");
  });

  it("extends the cached request prefix after notebook updates without reinjecting notebook context", async () => {
    sequence(response("Recording progress", [toolCall("todo-amber", "update_todo", { todos: [{ id: "scan", content: "Inspect contracts", status: "in_progress" }] })]), response("Continuing inspection"));
    dispatch.mockImplementation(async (_call, context) => {
      context.state.todoItems = [{ id: "scan", content: "Inspect contracts", status: "in_progress" }];
      return { outcome: "success", tool: "update_todo", message: "Updated notebook", output: "{}" };
    });
    await run().result;
    const first = projectCacheRelevantChatRequest(sentRequest(0)), second = projectCacheRelevantChatRequest(sentRequest(1));
    expect(second.stableSystem).toEqual(first.stableSystem);
    expect(second.tools).toEqual(first.tools);
    expect(second.messages.slice(0, first.messages.length)).toEqual(first.messages);
    expect(second.messages.some(message => String(message.content).includes("CURRENT_TODO_NOTEBOOK"))).toBe(false);
  });

  it("materializes recovered notebook facts once and strips all local metadata before provider transmission", async () => {
    sequence(response("Recovered audit"));
    await run({ systemPrompt: "Recovery persona", initialState: { todoItems: [{ id: "verify", content: "核对取消契约", status: "in_progress" }], uncertainEffects: [] },
      initialInternalContext: { kind: "recovery", content: '<internal_context type="recovery">恢复后的运行证据</internal_context>' } }).result;
    const messages = sentRequest(0).messages;
    expect(messages[0].content).toBe("Recovery persona");
    expect(messages.some(m => String(m.content).includes("恢复后的运行证据"))).toBe(true);
    expect(messages.some(m => String(m.content).includes("[in_progress] verify: 核对取消契约"))).toBe(true);
    expect(messages.every(m => m.visibility === undefined && m.internal === undefined)).toBe(true);
  });
});

describe("Compaction and request diagnostics", () => {
  const history = (): ChatMessage[] => [
    ...Array.from({ length: 20 }, (_, index): ChatMessage => ({ role: index % 2 ? "assistant" : "user", content: index === 0 ? "首个历史请求".repeat(100) : "历史证据".repeat(100) })),
    { role: "user", content: "继续审查".repeat(40) },
  ];
  const smallWindow = { contextWindowTokens: 200, reservedOutputTokens: 20, safetyMarginTokens: 0, compactionThreshold: 0.3, compactionRetainRatio: 0.16 };
  it("persists a structured checkpoint and incremented cache epoch before asking the model again", async () => {
    const fetch = vi.fn(async () => ({ ok: true, json: async () => response("## 原始任务与意图\n- 核对契约\n\n## 下一步\n- 继续") }));
    vi.stubGlobal("fetch", fetch); sequence(response("Compacted audit complete"));
    const checkpoints: HarnessCheckpoint[] = [], lifecycle: unknown[] = [];
    await run({ messages: history(), config: smallWindow, onCheckpoint: checkpoint => checkpoints.push(checkpoint), onCompactionLifecycle: event => lifecycle.push(event) }).result;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(provider.stream).toHaveBeenCalledTimes(1);
    const request = JSON.parse((fetch.mock.calls[0] as unknown as [unknown, RequestInit])[1].body as string);
    expect(request.messages.some((m: ChatMessage) => m.content === "首个历史请求".repeat(100))).toBe(true);
    expect(request.messages.at(-1).content).toContain("## 原始任务与意图");
    expect(checkpoints.at(-1)!.messages[0].content).toContain("<firefly_compaction_checkpoint>");
    expect(checkpoints.at(-1)!.cache).toEqual({ cacheEpoch: 2, epochReason: "compaction" });
    expect(lifecycle).toEqual([
      expect.objectContaining({ status: "started", messageCountBefore: 21 }),
      expect.objectContaining({ status: "committed", cache: { cacheEpoch: 2, epochReason: "compaction" } }),
    ]);
  });

  it("halts after summary persistence failure without issuing the next model request", async () => {
    const fetch = vi.fn(async () => ({ ok: true, json: async () => response("## 原始任务与意图\n- 简短检查点") }));
    vi.stubGlobal("fetch", fetch);
    const result = await run({ messages: history(), config: smallWindow, onCheckpoint: () => { throw new Error("Fixture volume unavailable"); } }).result;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(provider.stream).not.toHaveBeenCalled();
    expect(result.terminateReason).toBe("error");
    expect(result.finalAnswer).toContain("执行状态保存失败");
  });

  it("retains original history and the initial cache epoch when summary generation fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, text: async () => "Unavailable" })));
    sequence(response("Continuing without compaction"));
    const checkpoints: HarnessCheckpoint[] = [];
    const result = await run({ messages: history(), config: smallWindow, onCheckpoint: value => checkpoints.push(value) }).result;
    expect(result.finalAnswer).toBe("Continuing without compaction");
    expect(checkpoints.at(-1)!.messages.some(m => m.content === "首个历史请求".repeat(100))).toBe(true);
    expect(checkpoints.at(-1)!.cache).toEqual({ cacheEpoch: 1, epochReason: "run_start" });
  });

  it("emits hash-only per-request diagnostics and increasing context snapshots through final settlement", async () => {
    sequence(response("", [toolCall()]), response("Final audit evidence ".repeat(12)));
    const diagnostics: HarnessCacheDiagnostic[] = [];
    const job = run({ runId: "diagnostic-amber", onCacheDiagnostic: diagnostic => diagnostics.push(diagnostic) });
    await job.result;
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[1]).toMatchObject({
      runId: "diagnostic-amber", round: 1, cacheEpoch: 1, stablePromptFingerprint: diagnostics[0].stablePromptFingerprint, toolSchemaFingerprint: diagnostics[0].toolSchemaFingerprint,
    });
    expect(diagnostics[1].messageCount).toBeGreaterThan(diagnostics[0].messageCount);
    expect(diagnostics[0].messagePrefixFingerprint).toMatch(/^[a-f0-9]{64}$/);
    const snapshots = selectedEvents(job.events, "context_usage").map(event => event.snapshot);
    expect(snapshots.map(snapshot => snapshot.phase)).toEqual(["preRequest", "preRequest", "terminal"]);
    const conversationTokens = snapshots.map(snapshot => snapshot.categories.find(c => c.key === "conversation")?.tokens ?? -1);
    expect(conversationTokens[1]).toBeGreaterThan(conversationTokens[0]);
    expect(conversationTokens[2]).toBeGreaterThan(conversationTokens[1]);
    const terminal = snapshots[2];
    expect(terminal.round).toBe(1);
    expect(terminal.contextWindowTokens).toBeGreaterThan(0);
    expect(terminal.totalTokens).toBe(terminal.categories.reduce((sum, category) => sum + category.tokens, 0));
  });

  it("emits a terminal usage snapshot on cancellation", async () => {
    const controller = new AbortController();
    sequence(response("", [toolCall()]));
    dispatch.mockImplementation(async () => { controller.abort(); return success(); });
    const job = run({ signal: controller.signal });
    expect((await job.result).terminateReason).toBe("cancelled");
    expect(selectedEvents(job.events, "context_usage").map(event => event.snapshot.phase)).toEqual(["preRequest", "terminal"]);
  });
});

describe("Durable transcript failure boundaries", () => {
  it.each(["model", "assistant", "adjustment", "checkpoint"] as const)("keeps %s context failures reason-only without exposing secret text", async boundary => {
    const secret = "fixture-private-credential-amber";
    const error = Object.assign(new Error(secret), { code: "MEMORY_CONTEXT_TRANSCRIPT_SECRET" });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    if (boundary === "model") provider.stream.mockRejectedValueOnce(error);
    else sequence(response("Safe answer"));
    const extra: Partial<HarnessInput> = boundary === "assistant" ? { transcriptSink: sink({ appendAssistant: async () => { throw error; } }) }
      : boundary === "adjustment" ? { pollRunAdjustments: () => Promise.reject(error) }
      : boundary === "checkpoint" ? { onCheckpoint: () => { throw error; } } : {};
    const result = await run(extra).result;
    expect(result.failure).toEqual({ code: "MEMORY_CONTEXT_TRANSCRIPT_SECRET", source: "context" });
    expect(result.terminateReason).toBe("error");
    expect(result.finalAnswer).not.toContain(secret);
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
  });

  it("awaits canonical assistant persistence before any tool dispatch", async () => {
    sequence(response("", [toolCall()]), response("Persisted assistant"));
    const release = latch<void>(), appendAssistant = vi.fn(async () => { await release.pending; return "canonical-amber"; });
    const job = run({ transcriptSink: sink({ appendAssistant }) });
    await expect.poll(() => appendAssistant.mock.calls.length).toBe(1);
    expect(dispatch).not.toHaveBeenCalled();
    release.release();
    await job.result;
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("stops before tools if canonical assistant persistence or the predispatch snapshot fails", async () => {
    sequence(response("", [toolCall()]));
    const failed = await run({ transcriptSink: sink({ appendAssistant: async () => { throw new Error("Fixture disk full"); } }) }).result;
    expect(failed.terminateReason).toBe("error");
    expect(failed.finalAnswer).toContain("会话轨迹保存失败");
    expect(dispatch).not.toHaveBeenCalled();
    provider.stream.mockClear(); sequence(response("", [toolCall("snapshot-amber")]));
    const appendAssistant = vi.fn(async () => "canonical-amber"), lifecycle = vi.fn();
    const result = await run({ transcriptSink: sink({ appendAssistant }), onToolLifecycle: lifecycle, onCheckpoint: () => { throw new Error("Snapshot refused"); } }).result;
    expect(appendAssistant).toHaveBeenCalledOnce();
    expect(dispatch).not.toHaveBeenCalled();
    expect(lifecycle).not.toHaveBeenCalled();
    expect(result.terminateReason).toBe("error");
    expect(result.finalAnswer).toContain("执行状态保存失败");
  });

  it("retains the exact declaration in the recovery snapshot before planned, started and dispatch", async () => {
    const declaration = toolCall("durable-amber"), trace: string[] = [];
    let snapshot: HarnessCheckpoint | undefined, atDispatch: HarnessCheckpoint | undefined;
    sequence(response("", [declaration]), response("Durable declaration"));
    dispatch.mockImplementation(async (_call, context) => { atDispatch = structuredClone(snapshot); context.onExecutionStarted?.(); trace.push("execute"); return success(); });
    await run({ tools: [tool()], transcriptSink: sink({ appendAssistant: vi.fn(async () => { trace.push("canonical"); return "canonical-amber"; }) }),
      onCheckpoint: value => { snapshot = structuredClone(value); trace.push("snapshot"); },
      onToolLifecycle: event => trace.push(event.status),
    }).result;
    expect(atDispatch?.messages.at(-1)).toMatchObject({ role: "assistant", toolCalls: [declaration] });
    expect(trace.slice(0, 5)).toEqual(["canonical", "snapshot", "planned", "started", "execute"]);
  });

  it("never publishes committed after a tool-result persistence failure and retains external uncertainty", async () => {
    sequence(response("", [toolCall("send-durable", "send_email", { to: "recipient@invalid.test" })]), response("Must remain unused"));
    dispatch.mockImplementation(async (_call, context) => { context.onExecutionStarted?.(); return success("send_email"); });
    const lifecycle: HarnessToolLifecycleEvent[] = [];
    const result = await run({ tools: [tool("send_email", "external_side_effect")],
      transcriptSink: sink({ appendToolResult: async () => { throw new Error("Tool result write refused"); } }), onToolLifecycle: event => lifecycle.push(event),
    }).result;
    expect(provider.stream).toHaveBeenCalledTimes(1);
    expect(lifecycle).toContainEqual(expect.objectContaining({ status: "started" }));
    expect(lifecycle).not.toContainEqual(expect.objectContaining({ status: "committed" }));
    expect(result.finalState.uncertainEffects).toContainEqual(expect.objectContaining({ toolName: "send_email" }));
    expect(result.terminateReason).toBe("error");
  });

  it("settles unexpected dispatch errors through terminal context and a closed synthetic transcript", async () => {
    sequence(response("", [toolCall("broken-dispatch")]));
    dispatch.mockRejectedValue(new Error("Infrastructure dispatch failure"));
    const checkpoints: HarnessCheckpoint[] = [], job = run({ tools: [tool()], onCheckpoint: value => checkpoints.push(value) });
    const result = await job.result;
    expect(result.terminateReason).toBe("error");
    expect(result.finalAnswer).toContain("工具执行异常");
    expect(selectedEvents(job.events, "context_usage").at(-1)?.snapshot.phase).toBe("terminal");
    expect(checkpoints.length).toBeGreaterThan(0);
    expect(checkpoints.at(-1)!.messages.some(message => message.role === "tool")).toBe(true);
    expect(provider.stream).toHaveBeenCalledTimes(1);
  });

  it("fails closed if the terminal checkpoint cannot be saved", async () => {
    sequence(response("Unsaved final"));
    const result = await run({ onCheckpoint: () => { throw new Error("Terminal snapshot refused"); } }).result;
    expect(result.terminateReason).toBe("error");
    expect(result.finalAnswer).toContain("执行状态保存失败");
  });
});

describe("Queued user adjustments", () => {
  it("appends queued adjustments in order immediately after the tool result and checkpoints them before the next request", async () => {
    sequence(response("", [toolCall()]), response("Revised audit complete"));
    const queued: RunAdjustmentMessage[] = [];
    dispatch.mockImplementation(async () => { queued.push({ id: "adjust-east", rawContent: "Inspect the second document" }, { id: "adjust-west", rawContent: "Include command evidence" }); return success(); });
    const poll = vi.fn(() => queued.length ? Promise.resolve(queued.splice(0)) : undefined), checkpoints: HarnessCheckpoint[] = [];
    const result = await run({ tools: [tool()], pollRunAdjustments: poll, onCheckpoint: value => checkpoints.push(value) }).result;
    expect(poll).toHaveBeenCalledTimes(3);
    const messages = sentRequest(1).messages;
    expect(messages.slice(-2).map(({ role, content }) => ({ role, content }))).toEqual([
      { role: "user", content: "Inspect the second document" }, { role: "user", content: "Include command evidence" },
    ]);
    expect(messages.findIndex(message => message.role === "tool")).toBe(messages.length - 3);
    expect(checkpoints.some(c => c.messages.some(m => m.role === "user" && m.content === "Inspect the second document"))).toBe(true);
    expect(result.finalAnswer).toBe("Revised audit complete");
  });

  it("turns an imminent final into progress when a late adjustment arrives and advances the round", async () => {
    sequence(response("Initial conclusion"), response("Adjusted conclusion"));
    const poll = vi.fn().mockReturnValueOnce(undefined).mockResolvedValueOnce([{ id: "late-amber", rawContent: "Add missing constraints" }]).mockReturnValue(undefined);
    const job = run({ pollRunAdjustments: poll });
    const result = await job.result;
    expect(provider.stream).toHaveBeenCalledTimes(2);
    expect(selectedEvents(job.events, "progress_text").map(event => event.content)).toEqual(["Initial conclusion"]);
    expect(result.finalAnswer).toBe("Adjusted conclusion");
    expect(sentRequest(1).messages.at(-1)).toMatchObject({ role: "user", content: "Add missing constraints" });
    expect(result.rounds).toBe(1);
    const order = [
      job.events.findIndex(event => event.type === "round_end" && event.roundId === "round-0"),
      job.events.findIndex(event => event.type === "progress_text"),
      job.events.findIndex(event => event.type === "round_start" && event.roundId === "round-1"),
      job.events.findIndex(event => event.type === "final_answer"),
    ];
    expect(order[0]).toBeLessThan(order[1]); expect(order[1]).toBeLessThan(order[2]); expect(order[2]).toBeLessThan(order[3]);
  });

  it.each(["cancel", "round-cap"] as const)("does not consume queued adjustments or request another model response after %s", async boundary => {
    sequence(response("", [toolCall()]), response("Must remain unused"));
    const queued: RunAdjustmentMessage[] = [], controller = new AbortController();
    dispatch.mockImplementation(async () => { queued.push({ id: "deferred-amber", rawContent: "Defer this change" }); if (boundary === "cancel") controller.abort(); return success(); });
    const poll = vi.fn(() => queued.length ? Promise.resolve(queued.splice(0)) : undefined);
    const result = await run({ tools: [tool()], signal: controller.signal, config: boundary === "round-cap" ? { maxRounds: 1 } : {}, pollRunAdjustments: poll }).result;
    expect(result.terminateReason).toBe(boundary === "cancel" ? "cancelled" : "max_rounds");
    expect(provider.stream).toHaveBeenCalledTimes(1);
    expect(poll).toHaveBeenCalledTimes(1);
    expect(queued).toHaveLength(1);
  });

  it("fails closed before the next request when adjustment persistence rejects", async () => {
    sequence(response("", [toolCall()]), response("Must remain unused"));
    const poll = vi.fn().mockReturnValueOnce(undefined).mockRejectedValueOnce(new Error("PENDING_ADJUST_COMMIT_FAILED:adjust-amber:unavailable"));
    const result = await run({ tools: [tool()], pollRunAdjustments: poll }).result;
    expect(result.terminateReason).toBe("error");
    expect(result.finalAnswer).toContain("插话提交失败");
    expect(provider.stream).toHaveBeenCalledTimes(1);
  });

  it("stops after an injected adjustment if its recovery checkpoint fails", async () => {
    sequence(response("", [toolCall()]), response("Must remain unused"));
    const queued: RunAdjustmentMessage[] = [];
    dispatch.mockImplementation(async () => { queued.push({ id: "checkpoint-adjust", rawContent: "New requirement awaiting checkpoint" }); return success(); });
    const result = await run({ tools: [tool()], pollRunAdjustments: () => queued.length ? Promise.resolve(queued.splice(0)) : undefined,
      onCheckpoint: checkpoint => { if (checkpoint.messages.some(message => message.content === "New requirement awaiting checkpoint")) throw new Error("Adjustment checkpoint refused"); },
    }).result;
    expect(result.terminateReason).toBe("error");
    expect(result.finalAnswer).toContain("执行状态保存失败");
    expect(provider.stream).toHaveBeenCalledTimes(1);
  });
});

describe("Workspace lifetime and settlement", () => {
  const scope = { workspaceId: "fixture-workspace", parentRunId: "parent-amber", groupId: "group-amber", agentId: "main", childRunId: "parent-amber", toolCallId: "parent-amber" };
  it.each(["success", "cancelled", "throw"] as const)("waits for exactly one Main group drain on %s", async exit => {
    const gate = latch<void>(), closeGroup = vi.fn(async () => gate.pending), checkpoint = vi.fn(), controller = new AbortController();
    const unexpected = new Error("Public event callback failed");
    if (exit === "cancelled") controller.abort();
    else sequence(response("Drained final"));
    let returned = false;
    const pending = run({
      signal: controller.signal, onCheckpoint: checkpoint,
      onEvent: event => { if (exit === "throw" && event.type === "round_start") throw unexpected; },
      toolContext: { userQuery: "Drain", execution: { coordinator: { closeGroup } as never, scope } },
    }).result.then(result => { returned = true; return { result }; }, error => { returned = true; return { error }; });
    await expect.poll(() => closeGroup.mock.calls.length).toBe(1);
    expect(returned).toBe(false);
    expect(checkpoint).not.toHaveBeenCalled();
    gate.release();
    const settled = await pending;
    if (exit === "throw") expect(settled).toEqual({ error: unexpected });
    else {
      expect(settled).toMatchObject({ result: exit === "success" ? { finalAnswer: "Drained final" } : { terminateReason: "cancelled" } });
      expect(checkpoint).toHaveBeenCalledOnce();
    }
    expect(closeGroup).toHaveBeenCalledExactlyOnceWith("group-amber");
  });

  it("drains only the child's leaves without closing the sibling group", async () => {
    sequence(response("Child audit complete"));
    const whenChildSettled = vi.fn(async () => {}), closeGroup = vi.fn(async () => {});
    await run({ toolContext: { userQuery: "Child audit", execution: { coordinator: { whenChildSettled, closeGroup } as never, scope: { ...scope, agentId: "auditor", childRunId: "child-amber" } } } }).result;
    expect(whenChildSettled).toHaveBeenCalledExactlyOnceWith("child-amber");
    expect(closeGroup).not.toHaveBeenCalled();
  });

  it("keeps delegation serial when no workspace execution guard exists", async () => {
    const gate = latch<void>(), started: string[] = [];
    sequence(response("", [toolCall("role-east", "delegate_agent", { agent_id: "auditor", prompt: "Inspect east" }), toolCall("role-west", "delegate_agent", { agent_id: "editor", prompt: "Inspect west" })]), response("Rootless delegation complete"));
    dispatch.mockImplementation(async (call, context) => { context.onExecutionStarted?.(); started.push(call.id); if (call.id === "role-east") await gate.pending; return success(call.name); });
    const job = run({ agentExecutor: async () => ({ agentId: "auditor", sessionId: "child-amber", status: "completed", text: "" }), config: { maxParallelToolCalls: 4 } });
    await expect.poll(() => started).toEqual(["role-east"]);
    gate.release(); await job.result;
    expect(started).toEqual(["role-east", "role-west"]);
    expect(dispatch.mock.calls[0][1].toolContext?.execution).toBeUndefined();
  });

  it("records planned before actual entry and drains a started dispatch before cancellation terminal", async () => {
    const declaration = toolCall("late-amber"), gate = latch<void>(), controller = new AbortController();
    sequence(response("", [declaration]));
    const lifecycle: HarnessToolLifecycleEvent[] = [], checkpoint = vi.fn();
    let entered = false, returned = false;
    dispatch.mockImplementation(async (_call, context) => {
      expect(lifecycle).toEqual([expect.objectContaining({ status: "planned", toolCallId: "late-amber" })]);
      context.onExecutionStarted?.(); entered = true; await gate.pending; return success();
    });
    const pending = run({ tools: [tool()], signal: controller.signal, onToolLifecycle: event => lifecycle.push(event), onCheckpoint: checkpoint }).result.then(value => { returned = true; return value; });
    await expect.poll(() => entered).toBe(true);
    controller.abort(); await Promise.resolve();
    expect(returned).toBe(false);
    expect(checkpoint).toHaveBeenCalledOnce();
    gate.release();
    expect((await pending).terminateReason).toBe("cancelled");
    expect(lifecycle.map(event => event.status)).toEqual(["planned", "started", "committed"]);
  });
});
