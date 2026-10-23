/**
 * 单次 run 的轨迹提交端（CTA 第一阶段，任务 4）。
 *
 * 按协议把 Harness / ChatLoop 产生的规范消息写入 ConversationTranscriptStore：
 *   appendAssistant：assistant 声明必须先落盘，早于任何工具派发（由调用方保证失败即关闭）；
 *   appendToolResult：工具结果在生命周期标记为 committed 之前落盘；
 *   closeInterruption：取消时为 started / planned 的工具补上确定的闭合条目，并写入 interruption 边界；
 *   checkpoint：run 结束后刷新快照；失败会上抛，由调用方降级为日志，JSONL 不受影响。
 *
 * 幂等性：所有 entryId 都由 (runId, 协议点) 决定，
 * 结果不确定时的重试不会重复生成合成结果或边界。
 * 本文件只包含类型与逻辑，不依赖任何运行时对象（store 由调用方注入）。
 */

import { TranscriptPersistenceError, type TranscriptAppendGuard } from "./conversation-transcript-store";
import {
  copySAssistantBinding, copySAssistantMessage, copySAssistantSettlementPayload,
  type SAssistantBinding, type SAssistantSettlementBinding,
  type SAssistantSettlementResult, type TranscriptAppendInput,
} from "./conversation-transcript-types";
import type { ConversationTranscriptStore } from "./conversation-transcript-store";
import type { HarnessRunSession } from "./harness/run-store";
import type { ToolCallOutcome } from "./harness/types";
import type { ChatMessage } from "./vendors/types";
import { copyResponseJson } from "./vendors/response-request-snapshot";

/** 轨迹写入失败：failedKind 说明断在哪个协议点，cause 保存最初的错误。 */
export class TranscriptWriteError extends Error {
  constructor(public readonly failedKind: "assistant" | "tool_result" | "interruption", public readonly cause: unknown) {
    super(`${failedKind} 轨迹写入失败：${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "TranscriptWriteError";
  }
}

type ToolResultAppendInput = {
  assistantEntryId: string;
  message: ChatMessage;
  outcome: ToolCallOutcome;
  fullRef?: string;
  fileRead?: { path: string; canonicalPath: string; sha256: string; startLine: number; endLine: number; totalLines: number };
  roundId?: string;
  guard?: TranscriptAppendGuard;
};

/** 一个 run 绑定一个提交端，entryId 在整个 run 内保持确定。 */
export type TranscriptSink = {
  appendSAssistant(input: {
    message: ChatMessage;
    binding: SAssistantBinding;
    guard?: TranscriptAppendGuard;
  }): Promise<string>;
  settleSAssistant(input: {
    binding: SAssistantSettlementBinding;
    result: SAssistantSettlementResult;
    safeReason: string;
    guard?: TranscriptAppendGuard;
  }): Promise<void>;
  /** 写入一条规范 assistant 消息，返回它的 entryId；工具结果就挂在这个 ID 下面。 */
  appendAssistant(input: { message: ChatMessage; roundId?: string; guard?: TranscriptAppendGuard }): Promise<string>;
  /** 写入一条规范的工具结果，挂在所属的 assistant 条目之下。 */
  appendToolResult(input: ToolResultAppendInput): Promise<void>;
  /** 取消时的收尾：为 started / planned 工具补上合成结果，并写入 interruption 边界。 */
  closeInterruption(input: {
    runSession: HarnessRunSession | null;
    reason: "user_cancel";
    /** Main-only recovery fence, rechecked inside every final canonical write. */
    createGuard?: (throughSeq: number) => TranscriptAppendGuard;
    /** Main-only read fence for an already committed exact interruption marker. */
    assertCurrent?: () => void;
  }): Promise<void>;
  /** 快照检查点：只在快照写失败时 reject，永不改写 JSONL。 */
  checkpoint(): Promise<void>;
};

const bindings=new WeakMap<object,{store:ConversationTranscriptStore;conversationId:string;runId:string;assistantTurnId?:string}>();
/** Main-only identity read; a plain object or serialized facade has no authority. */
export function readTranscriptSinkBinding(sink:TranscriptSink,store?:ConversationTranscriptStore):Readonly<{conversationId:string;runId:string;assistantTurnId:string}> {
 const binding=bindings.get(sink);
 if(!binding||!binding.assistantTurnId||store!==undefined&&binding.store!==store)throw Error("MEMORY_CONTEXT_STREAM_SINK_DENIED");
 return Object.freeze({conversationId:binding.conversationId,runId:binding.runId,assistantTurnId:binding.assistantTurnId});
}
export function requireTranscriptSinkBinding(sink:TranscriptSink,target:{conversationId:string;runId:string;assistantTurnId:string},store?:ConversationTranscriptStore):void {
 const binding=bindings.get(sink);if(!binding||(store!==undefined&&binding.store!==store)||binding.conversationId!==target.conversationId||binding.runId!==target.runId||binding.assistantTurnId!==target.assistantTurnId)throw Error("MEMORY_CONTEXT_STREAM_SINK_DENIED");
}

export type TranscriptSinkMethod = keyof TranscriptSink;
export type GuardedTranscriptSinkMethod = "appendAssistant" | "appendToolResult" | "appendSAssistant" | "settleSAssistant";
export type TranscriptSinkGuardInput = Parameters<TranscriptSink[GuardedTranscriptSinkMethod]>[0];
/** Main-owned callbacks, never an IPC/renderer configuration or a way to register a foreign sink. */
export interface TranscriptSinkHooks {
  run?: <T>(method: TranscriptSinkMethod, operation: () => Promise<T>) => Promise<T>;
  guard?: (method: GuardedTranscriptSinkMethod, input: TranscriptSinkGuardInput) =>
    TranscriptAppendGuard | undefined | Promise<TranscriptAppendGuard | undefined>;
}

async function runSinkOperation<T>(invoke: () => Promise<T>, lifecycle?: (operation: () => Promise<T>) => Promise<T>): Promise<T> {
  if (!lifecycle) return invoke();
  let active = true, denied = false;
  let operation: Promise<T> | undefined;
  let hookFailure: { error: unknown } | undefined;
  const once = (): Promise<T> => {
    if (!active || operation) {
      denied = true;
      const rejection = Promise.reject<T>(Error("MEMORY_CONTEXT_STREAM_SINK_OPERATION_DENIED"));
      void rejection.catch(() => {});
      return rejection;
    }
    try { operation = Promise.resolve(invoke()); }
    catch (error) { operation = Promise.reject(error); }
    // A Main hook may fail before awaiting its work; keep the actual write owned.
    void operation.catch(() => {});
    return operation;
  };
  try { await lifecycle(once); }
  catch (error) { hookFailure = { error }; }
  finally { active = false; }
  let result: T | undefined, operationFailure: { error: unknown } | undefined;
  if (operation) {
    try { result = await operation; }
    catch (error) { operationFailure = { error }; }
  }
  if (hookFailure) throw hookFailure.error;
  if (denied || !operation) throw Error("MEMORY_CONTEXT_STREAM_SINK_OPERATION_DENIED");
  if (operationFailure) throw operationFailure.error;
  return result as T;
}

function freezeSinkData<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeSinkData(child);
    Object.freeze(value);
  }
  return value;
}
function snapshotGuard(source?: TranscriptAppendGuard): TranscriptAppendGuard | undefined {
  if (!source) return undefined;
  const { throughSeq, validate, commit } = source;
  if (!Number.isSafeInteger(throughSeq) || throughSeq < 0 || typeof validate !== "function" || typeof commit !== "function")
    throw Error("MEMORY_CONTEXT_STREAM_SINK_OPERATION_DENIED");
  return Object.freeze({
    throughSeq,
    validate: (ticket: object) => validate.call(source, ticket),
    commit: (write, ticket) => runSinkOperation(write, operation => commit.call(source, operation, ticket)),
  } satisfies TranscriptAppendGuard);
}
function snapshotGuardedInput<K extends GuardedTranscriptSinkMethod>(method: K, input: Parameters<TranscriptSink[K]>[0]): Parameters<TranscriptSink[K]>[0] {
  const fail = (): never => { throw Error("MEMORY_CONTEXT_STREAM_SINK_INPUT_INVALID"); };
  if (!input || Object.getPrototypeOf(input) !== Object.prototype) fail();
  const fields = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(fields).some(key => typeof key !== "string") || Object.values(fields).some(field => !("value" in field))) fail();
  const data = Object.fromEntries(Object.entries(fields).filter(([key]) => key !== "guard").map(([key, field]) => [key, field.value]));
  let copied: object;
  if (method === "appendSAssistant") copied = { message: copySAssistantMessage(data.message), binding: copySAssistantBinding(data.binding) };
  else if (method === "settleSAssistant") copied = copySAssistantSettlementPayload(data);
  else copied = copyResponseJson(data, true, fail);
  const guard = snapshotGuard(fields.guard?.value);
  return Object.freeze({ ...freezeSinkData(copied), ...(guard ? { guard } : {}) }) as Parameters<TranscriptSink[K]>[0];
}

function combinedGuard(first?: TranscriptAppendGuard, second?: TranscriptAppendGuard): TranscriptAppendGuard | undefined {
  if (!first || first === second) return second ?? first;
  if (!second) return first;
  if (first.throughSeq !== second.throughSeq) throw Error("MEMORY_CONTEXT_TRANSCRIPT_STALE");
  // Both guards share the real store's same validation/mutation ticket. Neither
  // guard may replace the other's receipt, validation, or commit coordinator.
  return {
    throughSeq: first.throughSeq,
    validate: async ticket => { await first.validate(ticket); await second.validate(ticket); },
    commit: (write, ticket) => runSinkOperation(
      () => runSinkOperation(write, operation => second.commit(operation, ticket)),
      operation => first.commit(operation, ticket),
    ),
  };
}

/**
 * Build a facade only around an already registered Main sink. The caller cannot
 * supply an identity, register a same-shaped object, or replace the real methods.
 * Hooks can reject work, but cannot fabricate a successful persistence result.
 */
export function wrapTranscriptSink(sink: TranscriptSink, hooks: TranscriptSinkHooks): TranscriptSink {
  const binding = bindings.get(sink);
  if (!binding) throw Error("MEMORY_CONTEXT_STREAM_SINK_DENIED");
  const { run: lifecycle, guard: injectGuard } = hooks;
  function run<T>(method: TranscriptSinkMethod, invoke: () => Promise<T>): Promise<T> {
    return runSinkOperation(invoke, lifecycle ? operation => lifecycle(method, operation) : undefined);
  }
  async function guarded<K extends GuardedTranscriptSinkMethod>(
    method: K, input: Parameters<TranscriptSink[K]>[0], invoke: (input: Parameters<TranscriptSink[K]>[0]) => ReturnType<TranscriptSink[K]>,
  ): Promise<Awaited<ReturnType<TranscriptSink[K]>>> {
    // Both the Main guard and the eventual store append receive this same private
    // immutable payload; caller mutation cannot race a queued validation/write.
    input = snapshotGuardedInput(method, input);
    return run(method, async () => {
      const supplied = await injectGuard?.(method, input);
      const guard = combinedGuard(input.guard, supplied === input.guard ? supplied : snapshotGuard(supplied));
      return invoke({ ...input, ...(guard ? { guard } : {}) });
    }) as Promise<Awaited<ReturnType<TranscriptSink[K]>>>;
  }
  const facade: TranscriptSink = {
    appendSAssistant: input => guarded("appendSAssistant", input, value => sink.appendSAssistant(value)),
    settleSAssistant: input => guarded("settleSAssistant", input, value => sink.settleSAssistant(value)),
    appendAssistant: input => guarded("appendAssistant", input, value => sink.appendAssistant(value)),
    appendToolResult: input => guarded("appendToolResult", input, value => sink.appendToolResult(value)),
    closeInterruption: input => run("closeInterruption", () => sink.closeInterruption(input)),
    checkpoint: () => run("checkpoint", () => sink.checkpoint()),
  };
  bindings.set(facade, binding);
  return Object.freeze(facade);
}

export function createTranscriptSink(input: { store: ConversationTranscriptStore; conversationId: string; runId: string; assistantTurnId?: string }): TranscriptSink {
  const { store, conversationId, runId, assistantTurnId } = input;
  // 记录每个 toolCallId 是由哪条 assistant 条目声明的，合成闭合时需要这个锚点
  const assistantEntryOfCall = new Map<string, string>();
  // ChatLoop 单轮路径没有 roundId，用递增序号代替
  let assistantCounter = 0;

  const assertOwned = (binding: SAssistantBinding) => {
    if (binding.runId !== runId || !assistantTurnId || binding.assistantTurnId !== assistantTurnId) {
      throw Error("TRANSCRIPT_S_BINDING_INVALID");
    }
  };
  const sink: TranscriptSink = {
    async appendSAssistant(input) {
      const binding = copySAssistantBinding(input.binding);
      const message = copySAssistantMessage(input.message);
      const guard = input.guard;
      assertOwned(binding);
      const id = `${runId}:assistant:s-response`;
      const entry = await store.append(conversationId, {
        kind: "assistant", id, at: Date.now(), runId, turnId: assistantTurnId,
        roundId: "s-response",
        sSettlement: {version: 1, userTurnId: binding.userTurnId, userRevision: binding.userRevision},
        payload: message,
      }, guard);
      return entry.id;
    },
    async settleSAssistant(input) {
      const payload = copySAssistantSettlementPayload({
        binding: input.binding, result: input.result, safeReason: input.safeReason,
      });
      const guard = input.guard;
      assertOwned(payload.binding);
      const draft: Extract<TranscriptAppendInput, {kind: "assistant_settlement"}> = {
        kind: "assistant_settlement", id: `s-settlement:v1:${payload.binding.assistantEntryId}`,
        at: Date.now(), runId, turnId: assistantTurnId, payload,
      };
      try {
        await store.append(conversationId, draft, guard);
      } catch (error) {
        if (!(error instanceof TranscriptPersistenceError)) throw error;
        try {
          if (await store.confirmSAssistantSettlement(conversationId, draft)) return;
        } catch { /* no durable proof */ }
        throw Error("TRANSCRIPT_S_SETTLEMENT_UNKNOWN", {cause: error});
      }
    },
    async appendAssistant({ message, roundId, guard }) {
      const entryId = `${runId}:assistant:${roundId ?? `n${assistantCounter++}`}`;
      for (const call of message.toolCalls ?? []) assistantEntryOfCall.set(call.id, entryId);
      const entry = await store.append(conversationId, {
        kind: "assistant", id: entryId, at: Date.now(), runId,
        ...(assistantTurnId ? { turnId: assistantTurnId } : {}),
        ...(roundId ? { roundId } : {}),
        payload: message,
      }, guard);
      return entry.id;
    },

    async appendToolResult({ assistantEntryId, message, outcome, fullRef, fileRead, roundId, guard }) {
      const toolCallId = message.toolCallId ?? `unknown-${runId}-${assistantEntryId}`;
      const payload = { assistantEntryId, toolCallId, outcome, message, ...(fullRef ? { fullRef } : {}), ...(fileRead ? { fileRead } : {}) };
      await store.append(conversationId, { kind: "tool_result", id: `${runId}:tool:${toolCallId}`, at: Date.now(), runId, ...(roundId ? { roundId } : {}), payload }, guard);
    },

    async closeInterruption({ reason, runSession, createGuard, assertCurrent }) {
      assertCurrent?.();
      // 幂等闭合：以权威轨迹为准（限本 run），已有结果的调用不重复补写
      const snapshot = await store.read(conversationId);
      assertCurrent?.();
      let throughSeq = snapshot.throughSeq;
      const declaredCalls = new Map<string, { toolCallId: string; toolName: string }>();
      const closedToolCallIds = new Set<string>();
      for (const entry of snapshot.entries) {
        if (entry.runId !== runId) continue;
        if (entry.kind === "tool_result") {
          closedToolCallIds.add(entry.payload.toolCallId);
          assistantEntryOfCall.set(entry.payload.toolCallId, entry.payload.assistantEntryId);
        } else if (entry.kind === "assistant") {
          for (const call of entry.payload.toolCalls ?? []) {
            assistantEntryOfCall.set(call.id, entry.id);
            declaredCalls.set(call.id, { toolCallId: call.id, toolName: call.name });
          }
        }
      }
      if (runSession && (runSession.runId !== runId || runSession.conversationId !== conversationId)) throw Error("TRANSCRIPT_RUN_EVIDENCE_MISMATCH");
      if (!runSession && [...declaredCalls.keys()].some(id => !closedToolCallIds.has(id))) throw Error("TRANSCRIPT_RUN_EVIDENCE_MISSING");
      const statusById = new Map(runSession?.toolCalls.map(call => [call.toolCallId, call]));
      for (const call of declaredCalls.values()) {
        if (!closedToolCallIds.has(call.toolCallId) && statusById.get(call.toolCallId)?.status === "committed") throw Error("TRANSCRIPT_TOOL_RESULT_MISSING");
      }
      const markerId = `${runId}:interruption:${reason}`;
      const matchesMarker = (entry: import("./conversation-transcript-types").TranscriptEntry | undefined): boolean =>
        !!entry && entry.kind === "interruption" && entry.id === markerId && entry.runId === runId
        && entry.payload.reason === reason && Object.keys(entry.payload).length === 1
        && Object.keys(entry).every(key => ["seq", "id", "at", "kind", "runId", "payload"].includes(key));
      const existingMarker = snapshot.entries.find(entry => entry.id === markerId);
      if (existingMarker) {
        if (!matchesMarker(existingMarker)) throw Error("TRANSCRIPT_IDEMPOTENCY_CONFLICT");
        if ([...declaredCalls.keys()].some(id => !closedToolCallIds.has(id))) throw Error("TRANSCRIPT_INTERRUPTION_INCOMPLETE");
        // Guarded append intentionally rejects an existing ID. Validate a completed
        // recovery under a fresh read lease instead, without entering any write gate.
        if (createGuard && !assertCurrent) throw Error("TRANSCRIPT_RECOVERY_READ_FENCE_REQUIRED");
        await store.withReadLease(conversationId, async read => {
          const current = await read(); assertCurrent?.();
          if (current.throughSeq !== snapshot.throughSeq) throw Error("MEMORY_CONTEXT_TRANSCRIPT_STALE");
          if (!matchesMarker(current.entries.find(entry => entry.id === markerId))) throw Error("TRANSCRIPT_IDEMPOTENCY_CONFLICT");
          assertCurrent?.();
        });
        return;
      }
      for (const call of declaredCalls.values()) {
        if (closedToolCallIds.has(call.toolCallId)) continue;
        // 派发过但没有结果的（started / unknown）记为 unknown；还没派发的（planned）记为 not_executed。
        // 其它状态的结果在生命周期发布前已经写入轨迹，这里不需要再补。
        const status = statusById.get(call.toolCallId)?.status;
        const outcome: ToolCallOutcome = status === "started" || status === "unknown" ? "unknown" : "not_executed";
        const assistantEntryId = assistantEntryOfCall.get(call.toolCallId) ?? "unknown-assistant";
        const reasonText = outcome === "unknown" ? "工具执行中被取消，结果未知" : "取消时未开始执行";
        const message: ChatMessage = {
          role: "tool", toolCallId: call.toolCallId, name: call.toolName,
          content: JSON.stringify({ outcome, tool: call.toolName, message: reasonText }),
        };
        const closeId = `${runId}:tool-close:${assistantEntryId}:${call.toolCallId}`;
        const closed = await store.append(conversationId, {
          kind: "tool_result", id: closeId, at: Date.now(), runId,
          payload: { assistantEntryId, toolCallId: call.toolCallId, outcome, message },
        }, createGuard?.(throughSeq));
        throughSeq = Math.max(throughSeq, closed.seq);
      }
      await store.append(conversationId, {
        kind: "interruption",
        id: markerId,
        at: Date.now(),
        runId,
        payload: { reason },
      }, createGuard?.(throughSeq));
    },

    async checkpoint() {
      await store.checkpoint(conversationId);
    },
  };
  bindings.set(sink,{store,conversationId,runId,assistantTurnId});return Object.freeze(sink);
}
