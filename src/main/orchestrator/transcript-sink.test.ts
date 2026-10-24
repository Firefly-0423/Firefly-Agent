/**
 * TranscriptSink 契约测试（CTA Phase 1 Task 4）。
 *
 * 验收不变量：
 * - appendAssistant 落盘 canonical assistant 条目并返回其 entryId；
 * - closeInterruption 只为 started（unknown）/ planned（not_executed）调用补确定性闭合，
 *   已有结果的调用不重复补写，interruption 边界恰好一条（重试幂等）。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationTranscriptStore } from "./conversation-transcript-store";
import { classifySAssistantSettlement } from "./conversation-transcript-settlement";
import { SRunSettlementGate } from "./run-settlement";
import { createTranscriptSink, requireTranscriptSinkBinding, wrapTranscriptSink } from "./transcript-sink";
import type { TranscriptAppendGuard } from "./conversation-transcript-store";
import type { HarnessRunSession, PersistedToolCall } from "./harness/run-store";
import type { ToolCallOutcome } from "./harness/types";
import type { ChatMessage } from "./vendors/types";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeStore(): ConversationTranscriptStore {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-sink-"));
  roots.push(root);
  return new ConversationTranscriptStore(root);
}

function makeRunSession(toolCalls: PersistedToolCall[]): HarnessRunSession {
  return {
    schemaVersion: 1,
    conversationId: "c1",
    runId: "run-1",
    status: "interrupted",
    messages: [],
    state: { todoItems: [], uncertainEffects: [] },
    toolOutputs: [],
    toolCalls,
    rounds: 1,
    cache: { cacheEpoch: 1, epochReason: "run_start" },
    request: {
      provider: "fake",
      model: "fake-model",
      contextWindowTokens: 100_000,
      promptFingerprint: "p",
      toolSchemaFingerprint: "t",
    },
    createdAt: 0,
    updatedAt: 0,
  };
}

/** 从轨迹读取 toolCallId → outcome 映射（只看 tool_result 条目）。 */
async function outcomes(store: ConversationTranscriptStore): Promise<Record<string, ToolCallOutcome>> {
  const snapshot = await store.read("c1");
  const map: Record<string, ToolCallOutcome> = {};
  for (const entry of snapshot.entries) {
    if (entry.kind === "tool_result") map[entry.payload.toolCallId] = entry.payload.outcome;
  }
  return map;
}

describe("TranscriptSink", () => {
  it("commits an assistant group and returns its entry id", async () => {
    const store = makeStore();
    const sink = createTranscriptSink({ store, conversationId: "c1", runId: "run-1" });
    const id = await sink.appendAssistant({
      message: {
        role: "assistant",
        content: "checking",
        toolCalls: [{ id: "call-1", name: "write_file", arguments: "{}" }],
      },
      roundId: "round-0",
    });
    expect((await store.read("c1")).entries).toContainEqual(expect.objectContaining({
      id,
      kind: "assistant",
      runId: "run-1",
      roundId: "round-0",
    }));
  });

  it("closes cancellation with unknown only for started calls", async () => {
    const store = makeStore();
    const sink = createTranscriptSink({ store, conversationId: "c1", runId: "run-1" });
    const assistantWithTwoCalls: ChatMessage = {
      role: "assistant",
      content: "checking",
      toolCalls: [
        { id: "startedCall", name: "send_email", arguments: "{}" },
        { id: "queuedCall", name: "write_file", arguments: "{}" },
      ],
    };
    await sink.appendAssistant({ message: assistantWithTwoCalls, roundId: "round-0" });
    const runSession = makeRunSession([
      { toolCallId: "startedCall", toolName: "send_email", sideEffect: "non_idempotent_side_effect", status: "started", updatedAt: 0 },
      { toolCallId: "queuedCall", toolName: "write_file", sideEffect: "idempotent_mutation", status: "planned", updatedAt: 0 },
    ]);

    await sink.closeInterruption({ reason: "user_cancel", runSession });

    expect(await outcomes(store)).toEqual({ startedCall: "unknown", queuedCall: "not_executed" });
    const entries = (await store.read("c1")).entries;
    expect(entries.filter((entry) => entry.kind === "interruption")).toHaveLength(1);

    // 确定性 entryId：不确定确认后的重试闭合不会复制合成结果或边界
    await sink.closeInterruption({ reason: "user_cancel", runSession });
    expect((await store.read("c1")).entries).toHaveLength(entries.length);
  });

  it("skips calls whose results are already committed to the transcript", async () => {
    const store = makeStore();
    const sink = createTranscriptSink({ store, conversationId: "c1", runId: "run-1" });
    const assistant = await sink.appendAssistant({
      message: {
        role: "assistant",
        content: "checking",
        toolCalls: [{ id: "doneCall", name: "write_file", arguments: "{}" }],
      },
      roundId: "round-0",
    });
    await sink.appendToolResult({
      assistantEntryId: assistant,
      message: { role: "tool", toolCallId: "doneCall", name: "write_file", content: "{\"outcome\":\"success\"}" },
      outcome: "success",
      roundId: "round-0",
    });

    // runStore 状态落后于轨迹（committed 但轨迹已闭合）：不得改写既有结果
    const runSession = makeRunSession([
      { toolCallId: "doneCall", toolName: "write_file", sideEffect: "idempotent_mutation", status: "committed", updatedAt: 0 },
    ]);
    await sink.closeInterruption({ reason: "user_cancel", runSession });

    expect(await outcomes(store)).toEqual({ doneCall: "success" });
  });
});


describe("S canonical append and durable settlement", () => {
  const binding = { runId: "s-run", assistantTurnId: "s-a", userTurnId: "s-u", userRevision: 1 };
  async function setup() { const store = makeStore(); await store.append("c1", { id: "s-user-entry", kind: "user", turnId: "s-u", revision: 1, at: 10, payload: { text: "synthetic user" } }); const sink = createTranscriptSink({ store, conversationId: "c1", runId: binding.runId, assistantTurnId: binding.assistantTurnId }) as any; expect(sink.appendSAssistant).toBeTypeOf("function"); expect(sink.settleSAssistant).toBeTypeOf("function"); return { store, sink }; }
  it("writes one marked reply and one exact success marker without changing original text or event identity", async () => { const { store, sink } = await setup(); const id = await sink.appendSAssistant({ message: { role: "assistant", content: "synthetic complete reply" }, binding }); const original = (await store.read("c1")).entries.at(-1)!; const settle = { binding: { ...binding, assistantEntryId: id }, result: "success", safeReason: "completed" }; await sink.settleSAssistant(settle); await sink.settleSAssistant(settle); const rows = (await store.read("c1")).entries; expect(rows.filter(e => e.kind === "assistant")).toEqual([original]); expect(original).toMatchObject({ runId: "s-run", turnId: "s-a", roundId: "s-response", sSettlement: { version: 1, userTurnId: "s-u", userRevision: 1 }, payload: { role: "assistant", content: "synthetic complete reply" } }); expect(rows.filter(e => e.kind === "assistant_settlement")).toHaveLength(1); expect(rows.at(-1)?.payload).toEqual(settle); });
  it.each(["runId", "assistantTurnId", "userTurnId", "userRevision"])("rejects wrong %s before assistant write", async (key) => { const { store, sink } = await setup(), before = await store.read("c1"); await expect(sink.appendSAssistant({ message: { role: "assistant", content: "synthetic complete" }, binding: { ...binding, [key]: key === "userRevision" ? 2 : "other" } })).rejects.toThrow("TRANSCRIPT_S_BINDING_INVALID"); expect(await store.read("c1")).toEqual(before); });
  it("rejects tools or partial/empty messages without canonical append", async () => {
    const { store, sink } = await setup(); for (const message of [{ role: "assistant", content: "" }, { role: "user", content: "fake" }, { role: "assistant", content: "tool", toolCalls: [{ id: "t", name: "noop", arguments: "{}" }] }])
      await expect(sink.appendSAssistant({ message, binding })).rejects.toThrow(); expect((await store.read("c1")).entries).toHaveLength(1);
  });
  it("refuses a conflicting terminal result and preserves the successful marker", async () => { const { store, sink } = await setup(), id = await sink.appendSAssistant({ message: { role: "assistant", content: "complete" }, binding }); await sink.settleSAssistant({ binding: { ...binding, assistantEntryId: id }, result: "success", safeReason: "completed" }); await expect(sink.settleSAssistant({ binding: { ...binding, assistantEntryId: id }, result: "interrupted", safeReason: "user_cancel" })).rejects.toThrow("TRANSCRIPT_S_SETTLEMENT_CONFLICT"); expect((await store.read("c1")).entries.filter(e => e.kind === "assistant_settlement")).toHaveLength(1); });
  it("cannot success-settle after external user append, but can preserve an interrupted original reply", async () => { const { store, sink } = await setup(), id = await sink.appendSAssistant({ message: { role: "assistant", content: "complete" }, binding }); await store.append("c1", { id: "other-u", kind: "user", turnId: "other-u", revision: 1, payload: { text: "later user" } }); await expect(sink.settleSAssistant({ binding: { ...binding, assistantEntryId: id }, result: "success", safeReason: "completed" })).rejects.toThrow("TRANSCRIPT_S_BINDING_INVALID"); await sink.settleSAssistant({ binding: { ...binding, assistantEntryId: id }, result: "interrupted", safeReason: "source_changed" }); expect((await store.read("c1")).entries.at(-1)).toMatchObject({ kind: "assistant_settlement", payload: { result: "interrupted" } }); });
  it("snapshots caller binding and text before queued append can run", async () => { const { store, sink } = await setup(); let release!: () => void, entered!: () => void; const entry = new Promise<void>(r => entered = r), hold = new Promise<void>(r => release = r); const lease = store.withReadLease("c1", async () => { entered(); await hold; }); await entry; const b = { ...binding }, message = { role: "assistant", content: "original text" }; const pending = sink.appendSAssistant({ message, binding: b }); b.userTurnId = "mutated"; message.content = "mutated"; release(); await lease; const id = await pending; expect((await store.read("c1")).entries.find(e => e.id === id)).toMatchObject({ sSettlement: { userTurnId: "s-u" }, payload: { content: "original text" } }); });
  async function reply() {
    const { store, sink } = await setup();
    const id = await sink.appendSAssistant({ message: { role: "assistant", content: "synthetic complete" }, binding });
    return { store, sink, id, settlement: { binding: { ...binding, assistantEntryId: id }, result: "success" as const, safeReason: "completed" } };
  }
  it("recovers a written marker after acknowledgement loss without a second append", async () => {
    const { store, sink, id, settlement } = await reply();
    const original = fs.promises.appendFile.bind(fs.promises);
    const append = vi.spyOn(fs.promises, "appendFile").mockImplementationOnce(async (...args) => {
      await original(...args);
      throw Error("synthetic_ack_loss");
    });
    await sink.settleSAssistant(settlement);
    expect(append).toHaveBeenCalledTimes(1);
    const entries = (await store.read("c1")).entries;
    expect(classifySAssistantSettlement(entries, id)).toBe("success");
    expect(entries.filter(e => e.kind === "assistant_settlement")).toHaveLength(1);
  });
  it.each(["before-bytes", "half-line"])("%s write failure remains unknown and keeps the reply pending", async (phase) => {
    const { store, sink, id, settlement } = await reply();
    const original = fs.promises.appendFile.bind(fs.promises);
    const append = vi.spyOn(fs.promises, "appendFile").mockImplementationOnce(async (...args) => {
      if (phase === "half-line")
        await original(args[0], '{"seq":3,"id":"synthetic-broken"', "utf8");
      throw Error("synthetic_io_unknown");
    });
    await expect(sink.settleSAssistant(settlement)).rejects.toThrow("TRANSCRIPT_S_SETTLEMENT_UNKNOWN");
    expect(append).toHaveBeenCalledTimes(1);
    const entries = (await store.read("c1")).entries;
    expect(classifySAssistantSettlement(entries, id)).toBe("pending");
    expect(entries.filter(e => e.kind === "assistant_settlement")).toHaveLength(0);
    expect(entries.find(e => e.id === id)?.payload).toEqual({ role: "assistant", content: "synthetic complete" });
  });
  it("cannot confirm success when recovery itself is unreadable", async () => {
    const { store, sink, settlement } = await reply();
    const original = fs.promises.appendFile.bind(fs.promises);
    const append = vi.spyOn(fs.promises, "appendFile").mockImplementationOnce(async (...args) => {
      await original(...args);
      throw Error("synthetic_ack_loss");
    });
    vi.spyOn(store, "confirmSAssistantSettlement").mockRejectedValueOnce(Error("synthetic_unreadable"));
    await expect(sink.settleSAssistant(settlement)).rejects.toThrow("TRANSCRIPT_S_SETTLEMENT_UNKNOWN");
    expect(append).toHaveBeenCalledTimes(1);
  });
  it("does not recover a mismatched result from the same marker ID", async () => {
    const { store, sink, id, settlement } = await reply();
    const original = fs.promises.appendFile.bind(fs.promises);
    vi.spyOn(fs.promises, "appendFile").mockImplementationOnce(async (...args) => {
      const forged = JSON.parse(String(args[1]));
      forged.payload.result = "interrupted";
      await original(args[0], JSON.stringify(forged) + "\n", "utf8");
      throw Error("synthetic_ack_loss");
    });
    await expect(sink.settleSAssistant(settlement)).rejects.toThrow("TRANSCRIPT_S_SETTLEMENT_UNKNOWN");
    expect(classifySAssistantSettlement((await store.read("c1")).entries, id)).toBe("interrupted");
  });
  it("refuses invalidation failure before dispatch and does not wrap it as unknown", async () => {
    const { store, sink, id, settlement } = await reply(), before = await store.read("c1");
    const append = vi.spyOn(fs.promises, "appendFile");
    store.observeMutations("c1", async () => { throw Error("synthetic_invalidation_denied"); });
    await expect(sink.settleSAssistant(settlement)).rejects.toThrow("synthetic_invalidation_denied");
    expect(append).not.toHaveBeenCalled();
    expect(await store.read("c1")).toEqual(before);
    expect(classifySAssistantSettlement(before.entries, id)).toBe("pending");
  });
  it("cancel during an awaited validation wins before reservation and writes no marker", async () => {
    const { store, sink, id, settlement } = await reply();
    const gate = new SRunSettlementGate();
    let ready!: () => void, release!: () => void;
    const entered = new Promise<void>(r => ready = r), hold = new Promise<void>(r => release = r);
    const append = vi.spyOn(fs.promises, "appendFile");
    const pending = sink.settleSAssistant({
      ...settlement, guard: {
        throughSeq: 2,
        validate: async () => { ready(); await hold; },
        commit: async (write: any) => {
          if (!gate.reserve("success"))
            throw Error("synthetic_cancel_won"); return write();
        },
      }
    });
    const failed = expect(pending).rejects.toThrow("synthetic_cancel_won");
    await entered;
    expect(gate.requestCancel()).toBe(true);
    release();
    await failed;
    expect(append).not.toHaveBeenCalled();
    expect(gate.get()).toBe("cancel_requested");
    expect(classifySAssistantSettlement((await store.read("c1")).entries, id)).toBe("pending");
  });
  it("reserves immediately at marker dispatch; late cancel and queued rewind cannot downgrade it", async () => {
    const { store, sink, id, settlement } = await reply(), gate = new SRunSettlementGate();
    let ready!: () => void, release!: () => void;
    const entered = new Promise<void>(r => ready = r), hold = new Promise<void>(r => release = r);
    const original = fs.promises.appendFile.bind(fs.promises);
    vi.spyOn(fs.promises, "appendFile").mockImplementationOnce(async (...args) => {
      ready();
      await hold;
      return original(...args);
    });
    const pending = sink.settleSAssistant({
      ...settlement, guard: {
        throughSeq: 2, validate: async () => { },
        commit: async (write: any) => {
          if (!gate.reserve("success"))
            throw Error("synthetic_reserved"); return write();
        },
      }
    });
    await entered;
    expect(gate.get()).toBe("success_reserved");
    expect(gate.requestCancel()).toBe(false);
    const rewind = store.append("c1", { id: "later-rewind", kind: "turn_rewind", at: 20, turnId: binding.userTurnId, payload: { anchorUserTurnId: binding.userTurnId, disposition: "keep_user", reason: "regenerate" } });
    release();
    await pending;
    expect(gate.confirm("success")).toBe(true);
    await rewind;
    const entries = (await store.read("c1")).entries;
    expect(entries.at(-1)?.kind).toBe("turn_rewind");
    expect(classifySAssistantSettlement(entries, id)).toBe("success");
    expect(gate.get()).toBe("success");
  });
  it("keeps the first safe reason when an identical result is retried", async () => {
    const { store, sink, settlement } = await reply();
    await sink.settleSAssistant(settlement);
    await sink.settleSAssistant({ ...settlement, safeReason: "recovered" });
    const entries = (await store.read("c1")).entries;
    expect(entries.filter(e => e.kind === "assistant_settlement")).toHaveLength(1);
    expect(entries.at(-1)?.payload).toMatchObject({ safeReason: "completed" });
  });
  it("serializes competing settlement results with only the first durable result accepted", async () => {
    const { store, sink, settlement } = await reply();
    const results = await Promise.allSettled([
      sink.settleSAssistant(settlement),
      sink.settleSAssistant({ ...settlement, result: "interrupted", safeReason: "user_cancel" }),
    ]);
    expect(results[0].status).toBe("fulfilled");
    expect(results[1].status).toBe("rejected");
    expect((await store.read("c1")).entries.filter(e => e.kind === "assistant_settlement")).toHaveLength(1);
  });
  it("rejects accessor bindings without invoking their getter", async () => {
    const { store, sink } = await setup(), getter = vi.fn(() => binding.userTurnId);
    const supplied = { ...binding };
    Object.defineProperty(supplied, "userTurnId", { get: getter });
    await expect(sink.appendSAssistant({ message: { role: "assistant", content: "complete" }, binding: supplied })).rejects.toThrow("TRANSCRIPT_S_BINDING_INVALID");
    expect(getter).not.toHaveBeenCalled();
    expect((await store.read("c1")).entries).toHaveLength(1);
  });

  it("re-syncs a complete marker when its first durable acknowledgement fails",async()=>{
    const {store,sink,settlement}=await reply();
    const original=fs.promises.open.bind(fs.promises);
    const append=vi.spyOn(fs.promises,"appendFile");
    const open=vi.spyOn(fs.promises,"open").mockImplementationOnce(async (...args)=>{
      const handle=await original(...args);
      vi.spyOn(handle,"sync").mockRejectedValueOnce(Error("synthetic_sync_failure"));
      return handle;
    });
    await sink.settleSAssistant(settlement);
    expect(append).toHaveBeenCalledTimes(1);expect(open).toHaveBeenCalledTimes(2);
    expect((await store.read("c1")).entries.filter(e=>e.kind==="assistant_settlement")).toHaveLength(1);
  });
  it("does not confirm an idempotent marker while both durable checks fail",async()=>{
    const {store,sink,settlement}=await reply();await sink.settleSAssistant(settlement);
    const original=fs.promises.open.bind(fs.promises);
    const append=vi.spyOn(fs.promises,"appendFile");
    vi.spyOn(fs.promises,"open").mockImplementation(async (...args)=>{
      const handle=await original(...args);
      vi.spyOn(handle,"sync").mockRejectedValue(Error("synthetic_sync_failure"));return handle;
    });
    await expect(sink.settleSAssistant(settlement)).rejects.toThrow("TRANSCRIPT_S_SETTLEMENT_UNKNOWN");
    expect(append).not.toHaveBeenCalled();
  });
});


describe("Main-owned TranscriptSink facade", () => {
  const target = { conversationId: "c1", runId: "run-1", assistantTurnId: "a1" };
  async function fixture() {
    const store = makeStore(), sink = createTranscriptSink({ store, ...target });
    const assistantEntryId = await sink.appendAssistant({ message: { role: "assistant", content: "checking",
      toolCalls: [{ id: "call-1", name: "lookup", arguments: "{}" }] }, roundId: "round-0" });
    const result = { assistantEntryId, message: { role: "tool" as const, toolCallId: "call-1", content: "result" }, outcome: "success" as const };
    return { store, sink, result };
  }
  function guard(throughSeq: number, trace: string[], label: string): TranscriptAppendGuard {
    return { throughSeq,
      validate: async ticket => { expect(typeof ticket).toBe("object"); trace.push(`${label}:validate`); },
      commit: async (write, ticket) => { expect(typeof ticket).toBe("object"); trace.push(`${label}:commit`); return write(); },
    };
  }

  it.each(["validate", "commit"] as const)("refuses a tool-result %s guard before persistent bytes", async phase => {
    const { store, sink, result } = await fixture(), before = await store.read("c1");
    const append = vi.spyOn(fs.promises, "appendFile");
    const gate = guard(before.throughSeq, [], "tool");
    if (phase === "validate") gate.validate = async () => { throw Error("MEMORY_CONTEXT_CANCELLED"); };
    else gate.commit = async () => { throw Error("MEMORY_CONTEXT_RESPONSE_PROGRESS_STALE"); };
    await expect(sink.appendToolResult({ ...result, guard: gate })).rejects.toThrow(phase === "validate" ? "MEMORY_CONTEXT_CANCELLED" : "MEMORY_CONTEXT_RESPONSE_PROGRESS_STALE");
    expect(append).not.toHaveBeenCalled(); expect(await store.read("c1")).toEqual(before);
  });

  it("rejects tool-result stale throughSeq and preserves both call arguments and receipts", async () => {
    const { store, sink, result } = await fixture(), before = await store.read("c1");
    const validate = vi.fn(), commit = vi.fn();
    await expect(sink.appendToolResult({ ...result, guard: { throughSeq: 0, validate, commit } })).rejects.toThrow("MEMORY_CONTEXT_TRANSCRIPT_STALE");
    expect(validate).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled(); expect(await store.read("c1")).toEqual(before);
  });

  it("rejects forged sinks without evaluating hooks or registering their identity", async () => {
    const { sink, store } = await fixture(), run = vi.fn();
    const forged = { ...sink };
    expect(() => wrapTranscriptSink(forged, { run })).toThrow("MEMORY_CONTEXT_STREAM_SINK_DENIED");
    expect(() => requireTranscriptSinkBinding(forged, target, store)).toThrow("MEMORY_CONTEXT_STREAM_SINK_DENIED");
    expect(run).not.toHaveBeenCalled();
  });

  it("retains a real sink's exact private binding through nested frozen facades", async () => {
    const { sink, store } = await fixture();
    const facade = wrapTranscriptSink(wrapTranscriptSink(sink, {}), {});
    expect(Object.isFrozen(facade)).toBe(true);
    expect(() => requireTranscriptSinkBinding(facade, target, store)).not.toThrow();
    expect(() => requireTranscriptSinkBinding(facade, { ...target, runId: "forged-run" }, store)).toThrow("MEMORY_CONTEXT_STREAM_SINK_DENIED");
    expect(() => requireTranscriptSinkBinding(facade, target, makeStore())).toThrow("MEMORY_CONTEXT_STREAM_SINK_DENIED");
    expect(() => wrapTranscriptSink({ ...facade }, {})).toThrow("MEMORY_CONTEXT_STREAM_SINK_DENIED");
  });

  it("composes both guards inside the same real store ticket and tracks the real operation", async () => {
    const { sink, store, result } = await fixture(), trace: string[] = [];
    const original = guard(1, trace, "original"), injected = guard(1, trace, "injected");
    const facade = wrapTranscriptSink(sink, {
      run: async (method, operation) => { trace.push(`${method}:start`); try { return await operation(); } finally { trace.push(`${method}:end`); } },
      guard: () => injected,
    });
    await facade.appendToolResult({ ...result, guard: original });
    expect(trace).toEqual(["appendToolResult:start", "original:validate", "injected:validate", "original:commit", "injected:commit", "appendToolResult:end"]);
    expect((await store.read("c1")).entries.at(-1)).toMatchObject({ kind: "tool_result", payload: { message: result.message, outcome: "success" } });
  });

  it("rejects conflicting guard receipts rather than replacing the caller guard", async () => {
    const { sink, store, result } = await fixture(), before = await store.read("c1"), append = vi.spyOn(fs.promises, "appendFile");
    const facade = wrapTranscriptSink(sink, { guard: () => guard(2, [], "new") });
    await expect(facade.appendToolResult({ ...result, guard: guard(1, [], "old") })).rejects.toThrow("MEMORY_CONTEXT_TRANSCRIPT_STALE");
    expect(append).not.toHaveBeenCalled(); expect(await store.read("c1")).toEqual(before);
  });

  it("cannot claim a successful wrapper operation without invoking the real sink", async () => {
    const { sink, store, result } = await fixture(), before = await store.read("c1");
    const facade = wrapTranscriptSink(sink, { run: async () => undefined as never });
    await expect(facade.appendToolResult(result)).rejects.toThrow("MEMORY_CONTEXT_STREAM_SINK_OPERATION_DENIED");
    expect(await store.read("c1")).toEqual(before);
  });

  it("preserves an explicit lifecycle rejection without invoking persistence", async () => {
    const { sink, store, result } = await fixture(), before = await store.read("c1");
    const facade = wrapTranscriptSink(sink, { run: async () => { throw Error("MEMORY_CONTEXT_RUN_CLOSED"); } });
    await expect(facade.appendToolResult(result)).rejects.toThrow("MEMORY_CONTEXT_RUN_CLOSED");
    expect(await store.read("c1")).toEqual(before);
  });

  it("permits cancellation closure after stopping ordinary append operations", async () => {
    const { sink, store, result } = await fixture();
    const facade = wrapTranscriptSink(sink, { run: async (method, operation) => {
      if (method !== "closeInterruption" && method !== "checkpoint") throw Error("MEMORY_CONTEXT_CANCELLED");
      return operation();
    } });
    await expect(facade.appendToolResult(result)).rejects.toThrow("MEMORY_CONTEXT_CANCELLED");
    await facade.closeInterruption({ reason: "user_cancel", runSession: makeRunSession([
      { toolCallId: "call-1", toolName: "lookup", sideEffect: "read_only", status: "started", updatedAt: 0 },
    ]) });
    await facade.checkpoint();
    expect(await outcomes(store)).toEqual({ "call-1": "unknown" });
    expect((await store.read("c1")).entries.at(-1)?.kind).toBe("interruption");
  });

  it("keeps the lifecycle pending until an unawaited real append settles", async () => {
    const { sink, store, result } = await fixture();
    let ready!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { ready = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const original = fs.promises.appendFile.bind(fs.promises);
    vi.spyOn(fs.promises, "appendFile").mockImplementationOnce(async (...args) => { ready(); await gate; return original(...args); });
    const facade = wrapTranscriptSink(sink, { run: async (_method, operation) => { void operation(); return undefined as never; } });
    let settled = false;
    const pending = facade.appendToolResult(result).finally(() => { settled = true; });
    await entered; await new Promise(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    release(); await pending;
    expect((await store.read("c1")).entries.at(-1)?.kind).toBe("tool_result");
  });
});

describe("TranscriptSink facade ownership edges", () => {
  it("refuses duplicate operation invocation even when a hook swallows its rejection", async () => {
    const store = makeStore(), sink = createTranscriptSink({ store, conversationId: "c1", runId: "run-1" });
    const facade = wrapTranscriptSink(sink, { run: async (_method, operation) => {
      const result = await operation(); await operation().catch(() => undefined); return result;
    } });
    const append = vi.spyOn(fs.promises, "appendFile");
    await expect(facade.appendAssistant({ message: { role: "assistant", content: "once" } })).rejects.toThrow("MEMORY_CONTEXT_STREAM_SINK_OPERATION_DENIED");
    expect(append).toHaveBeenCalledTimes(1); expect((await store.read("c1")).entries).toHaveLength(1);
  });

  it("does not let a hook return a fabricated assistant entry ID", async () => {
    const store = makeStore(), sink = createTranscriptSink({ store, conversationId: "c1", runId: "run-1" });
    const facade = wrapTranscriptSink(sink, { run: async (_method, operation) => { await operation(); return "forged-entry-id" as never; } });
    const id = await facade.appendAssistant({ message: { role: "assistant", content: "real" }, roundId: "round-0" });
    expect(id).toBe("run-1:assistant:round-0"); expect((await store.read("c1")).entries.at(-1)?.id).toBe(id);
  });

  it("retains S binding/message snapshots across an asynchronous lifecycle hook", async () => {
    const store = makeStore();
    await store.append("c1", { kind: "user", id: "u-entry", turnId: "u1", revision: 1, payload: { text: "question" } });
    const sink = createTranscriptSink({ store, conversationId: "c1", runId: "run-1", assistantTurnId: "a1" });
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; }), hold = new Promise<void>(resolve => { release = resolve; });
    const facade = wrapTranscriptSink(sink, { run: async (_method, operation) => { entered(); await hold; return operation(); } });
    const binding = { runId: "run-1", assistantTurnId: "a1", userTurnId: "u1", userRevision: 1 };
    const message: ChatMessage = { role: "assistant", content: "original" };
    const pending = facade.appendSAssistant({ binding, message });
    await ready; binding.userTurnId = "mutated"; message.content = "mutated"; release();
    const id = await pending;
    expect((await store.read("c1")).entries.find(entry => entry.id === id)).toMatchObject({ sSettlement: { userTurnId: "u1" }, payload: { content: "original" } });
  });

  it("does not let one combined guard bypass the other commit or fabricate persistence", async () => {
    const store = makeStore(), sink = createTranscriptSink({ store, conversationId: "c1", runId: "run-1" });
    const commit = vi.fn(async (write: () => Promise<any>) => write());
    const facade = wrapTranscriptSink(sink, { guard: () => ({ throughSeq: 0, validate: async () => {}, commit }) });
    await expect(facade.appendAssistant({ message: { role: "assistant", content: "forbidden fake success" }, guard: {
      throughSeq: 0, validate: async () => {}, commit: async () => ({ id: "fake" } as never),
    } })).rejects.toThrow("MEMORY_CONTEXT_STREAM_SINK_OPERATION_DENIED");
    expect(commit).not.toHaveBeenCalled(); expect((await store.read("c1")).entries).toHaveLength(0);
  });
});

describe("TranscriptSink immutable guarded payloads", () => {
  it.each(["guard-selection", "commit"])("pins a tool-result payload before awaited %s", async phase => {
    const store = makeStore(), sink = createTranscriptSink({ store, conversationId: "c1", runId: "run-1" });
    const assistantEntryId = await sink.appendAssistant({ message: { role: "assistant", content: "tool", toolCalls: [{ id: "call-1", name: "lookup", arguments: "{}" }] } });
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; }), hold = new Promise<void>(resolve => { release = resolve; });
    const input = { assistantEntryId, message: { role: "tool" as const, toolCallId: "call-1", content: "original" }, outcome: "success" as ToolCallOutcome,
      fileRead: { path: "a.txt", canonicalPath: "/synthetic/a.txt", sha256: "a".repeat(64), startLine: 1, endLine: 1, totalLines: 1 } };
    let owned: any;
    const facade = wrapTranscriptSink(sink, { guard: async (_method, value) => {
      owned = value;
      if (phase === "guard-selection") { entered(); await hold; }
      return { throughSeq: 1, validate: async () => {}, commit: async write => {
        if (phase === "commit") { entered(); await hold; }
        return write();
      } };
    } });
    const pending = facade.appendToolResult(input);
    await ready;
    input.message.content = "mutated after guard proof"; input.outcome = "unknown"; input.fileRead.sha256 = "b".repeat(64);
    release(); await pending;
    expect(Object.isFrozen(owned)).toBe(true); expect(Object.isFrozen(owned.message)).toBe(true); expect(Object.isFrozen(owned.fileRead)).toBe(true);
    expect((await store.read("c1")).entries.at(-1)).toMatchObject({ kind: "tool_result", payload: {
      message: { content: "original" }, outcome: "success", fileRead: { sha256: "a".repeat(64) },
    } });
  });

  it("pins caller guard functions before an asynchronous guard hook", async () => {
    const store = makeStore(), sink = createTranscriptSink({ store, conversationId: "c1", runId: "run-1" });
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; }), hold = new Promise<void>(resolve => { release = resolve; });
    const callerGuard: TranscriptAppendGuard = { throughSeq: 0, validate: async () => { throw Error("original guard denied"); }, commit: async write => write() };
    const facade = wrapTranscriptSink(sink, { guard: async () => { entered(); await hold; return undefined; } });
    const pending = facade.appendAssistant({ message: { role: "assistant", content: "guarded" }, guard: callerGuard });
    const rejected = expect(pending).rejects.toThrow("original guard denied");
    await ready; callerGuard.validate = async () => {}; release(); await rejected;
    expect((await store.read("c1")).entries).toHaveLength(0);
  });
});
it("reads immutable identity only from a genuine sink and matching canonical store",async()=>{
 const {readTranscriptSinkBinding}=await import("./transcript-sink"),store=makeStore();
 const sink=createTranscriptSink({store,conversationId:"session-a",runId:"run-a",assistantTurnId:"assistant-a"});
 const identity=readTranscriptSinkBinding(sink,store);expect(identity).toEqual({conversationId:"session-a",runId:"run-a",assistantTurnId:"assistant-a"});expect(Object.isFrozen(identity)).toBe(true);
 expect(()=>readTranscriptSinkBinding({...sink},store)).toThrow("MEMORY_CONTEXT_STREAM_SINK_DENIED");
 expect(()=>readTranscriptSinkBinding(sink,makeStore())).toThrow("MEMORY_CONTEXT_STREAM_SINK_DENIED");
});

it("closes canonical declared calls that crashed before planned persistence without inventing starts", async () => {
  const store = makeStore(), sink = createTranscriptSink({ store, conversationId: "c1", runId: "run-1" });
  const call = { id: "declared-only", name: "write_file", arguments: '{"path":"fixture.txt"}' };
  await sink.appendAssistant({ message: { role: "assistant", content: "", toolCalls: [call] }, roundId: "round-1" });
  await sink.closeInterruption({ reason: "user_cancel", runSession: makeRunSession([]) });
  await sink.closeInterruption({ reason: "user_cancel", runSession: makeRunSession([]) });
  const entries = (await store.read("c1")).entries, results = entries.filter(entry => entry.kind === "tool_result");
  expect(results).toHaveLength(1); expect(results[0].kind === "tool_result" && results[0].payload.outcome).toBe("not_executed");
  expect(entries.filter(entry => entry.kind === "interruption")).toHaveLength(1);
});

it("fences every interruption append and drains already started IO without starting the next closure write", async () => {
  const store = makeStore(), sink = createTranscriptSink({ store, conversationId: "c1", runId: "run-1" });
  const calls = [{ id: "started", name: "write_file", arguments: "{}" }, { id: "planned", name: "write_file", arguments: "{}" }];
  await sink.appendAssistant({ message: { role: "assistant", content: "", toolCalls: calls }, roundId: "round-1" });
  let entered!: () => void, release!: () => void, stopped = false;
  const started = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const original = fs.promises.appendFile.bind(fs.promises);
  vi.spyOn(fs.promises, "appendFile").mockImplementationOnce(async (...args) => { entered(); await held; return original(...args); });
  const pending = sink.closeInterruption({ reason: "user_cancel", runSession: makeRunSession(calls.map((call, index) => ({ toolCallId: call.id, toolName: call.name,
    sideEffect: "idempotent_mutation", status: index === 0 ? "started" : "planned", updatedAt: 1 }))),
    createGuard: throughSeq => ({ throughSeq, validate: async () => { if (stopped) throw Error("owner stopped"); }, commit: async write => { if (stopped) throw Error("owner stopped"); return write(); } }),
  });
  const rejected = expect(pending).rejects.toThrow("owner stopped");
  await started; stopped = true; release(); await rejected;
  const entries = (await store.read("c1")).entries;
  expect(entries.filter(entry => entry.kind === "tool_result")).toHaveLength(1);
  expect(entries.filter(entry => entry.kind === "interruption")).toHaveLength(0);
});

it("refuses missing or foreign run evidence and committed calls with missing canonical results", async () => {
  const store = makeStore(), sink = createTranscriptSink({ store, conversationId: "c1", runId: "run-1" });
  await sink.appendAssistant({ message: { role: "assistant", content: "", toolCalls: [{ id: "unresolved", name: "write_file", arguments: "{}" }] }, roundId: "round-1" });
  const before = await store.read("c1");
  await expect(sink.closeInterruption({ reason: "user_cancel", runSession: null })).rejects.toThrow("TRANSCRIPT_RUN_EVIDENCE_MISSING");
  await expect(sink.closeInterruption({ reason: "user_cancel", runSession: { ...makeRunSession([]), conversationId: "foreign" } })).rejects.toThrow("TRANSCRIPT_RUN_EVIDENCE_MISMATCH");
  await expect(sink.closeInterruption({ reason: "user_cancel", runSession: makeRunSession([{ toolCallId: "unresolved", toolName: "write_file", sideEffect: "idempotent_mutation", status: "committed", updatedAt: 1 }]) })).rejects.toThrow("TRANSCRIPT_TOOL_RESULT_MISSING");
  expect(await store.read("c1")).toEqual(before);
});

it("validates a matching committed interruption marker read-only with a current Main fence", async () => {
  const store = makeStore(), sink = createTranscriptSink({ store, conversationId: "c1", runId: "run-1" }), runSession = makeRunSession([]);
  await sink.closeInterruption({ reason: "user_cancel", runSession });
  const before = await store.read("c1"), append = vi.spyOn(store, "append");
  let validations = 0, stopped = false;
  const input = { reason: "user_cancel" as const, runSession, assertCurrent: () => { validations++; if (stopped) throw Error("owner stopped"); },
    createGuard: (_throughSeq: number): TranscriptAppendGuard => { throw Error("existing marker must not enter a write gate"); } };
  await sink.closeInterruption(input); expect(validations).toBeGreaterThan(0); expect(append).not.toHaveBeenCalled();
  expect(await store.read("c1")).toEqual(before);
  stopped = true; await expect(sink.closeInterruption(input)).rejects.toThrow("owner stopped"); expect(append).not.toHaveBeenCalled();
});

it("refuses a mismatched existing interruption marker without overwriting it", async () => {
  const store = makeStore(), sink = createTranscriptSink({ store, conversationId: "c1", runId: "run-1" });
  await store.append("c1", { id: "run-1:interruption:user_cancel", kind: "interruption", runId: "foreign-run", payload: { reason: "user_cancel" } });
  const before = await store.read("c1"), append = vi.spyOn(store, "append");
  await expect(sink.closeInterruption({ reason: "user_cancel", runSession: makeRunSession([]), assertCurrent: () => undefined })).rejects.toThrow("TRANSCRIPT_IDEMPOTENCY_CONFLICT");
  expect(await store.read("c1")).toEqual(before); expect(append).not.toHaveBeenCalled();
});

it("rechecks owner lifetime after an awaited existing-marker read lease", async () => {
  const store = makeStore(), sink = createTranscriptSink({ store, conversationId: "c1", runId: "run-1" }), runSession = makeRunSession([]);
  await sink.closeInterruption({ reason: "user_cancel", runSession });
  let ready!: () => void, release!: () => void, stopped = false;
  const entered = new Promise<void>(resolve => { ready = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const original = store.withReadLease.bind(store);
  vi.spyOn(store, "withReadLease").mockImplementation((id, operation) => original(id, read => operation(async () => { const snapshot = await read(); ready(); await held; return snapshot; })));
  const append = vi.spyOn(store, "append");
  const pending = sink.closeInterruption({ reason: "user_cancel", runSession, assertCurrent: () => { if (stopped) throw Error("owner stopped"); },
    createGuard: () => { throw Error("existing marker must not enter a write gate"); } });
  const rejected = expect(pending).rejects.toThrow("owner stopped");
  await entered; stopped = true; release(); await rejected; expect(append).not.toHaveBeenCalled();
});
