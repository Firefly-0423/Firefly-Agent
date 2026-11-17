// 插话拉取器：把已被标记到当前 run 的排队消息转成正式的用户消息，
// 由 harness 在两个边界（每次模型请求前、最终结算前）按入队顺序取出（#96）。
//
// 写入顺序：先提交聊天历史（出队与进历史是同一次文件写入，并带上 runInsertion 标记），
// 再写会话记录（turnId 固定，同 id 已存在时读回正文核对，不一致即冲突、不交付）。
// 这样会话记录里不会出现聊天历史没有的半截条目。
// 两处都成功才交付。某一条卡住时停在这里：已交付的前缀照常返回，卡住的那条以 blocked 报给
// harness，后面的留到下一次拉取，保持入队顺序。聊天历史已提交、会话记录没写成的条目，
// 下一次拉取凭 runInsertion 找回，补写会话记录后交付，不会因为已经出队而丢失。
// 默认记忆路径（handler）同样先提交历史：许可在历史提交后进入 committed 阶段，
// 找回时签发的也是 committed 许可，handler 据此只补写会话记录，不再申请来源凭据。

import type { ChatMessage, PendingChatAttachment, PendingChatMessage } from "../../../shared/chat-types";
import type { RunAdjustmentMessage, RunAdjustmentPoll } from "../loop/types";

/** Opaque Main-only authority for one live, unchanged marked queue item. */
declare const adjustmentPermitBrand: unique symbol;
export type RunAdjustmentPermit = object & { readonly [adjustmentPermitBrand]: true };
type AdjustmentBinding = { sessionId: string; runId: string };
export type RunAdjustmentHandler = (permit: RunAdjustmentPermit, commitHistory: () => RunAdjustmentMessage) => Promise<RunAdjustmentMessage>;
type PollerState = AdjustmentBinding & { handler?: RunAdjustmentHandler; closed?: boolean };
type PermitState = { binding: PollerState; item: PendingChatMessage; committed: boolean; assertPending(): void; assertCommitted(): void };
const pollers = new WeakMap<object, PollerState>();
const permits = new WeakMap<object, PermitState>();
const denied = (): never => { throw new Error("MEMORY_CONTEXT_ADJUSTMENT_DENIED"); };

/**
 * A failure the run may retry before its next model request: either history was certainly not
 * written, or a transcript storage call failed after this attempt recorded its own progress.
 * Every other error stops the run.
 */
export class RunAdjustmentRetryableError extends Error {
  constructor(readonly reason: string, options?: { cause?: unknown }) { super(`RUN_ADJUSTMENT_RETRYABLE:${reason}`, options); this.name = "RunAdjustmentRetryableError"; }
}
/** Stable codes pass through as the blocked reason; anything else is reported generically. */
const reasonOf = (error: unknown) => error instanceof Error && /^[A-Z][A-Z0-9_]*(:[\w-]+)*$/.test(error.message) ? error.message : "ADJUSTMENT_FAILED";
/** Queue items a poller has taken and is writing into the run; only these may not be withdrawn. */
const inFlight = new Set<string>();
const flightKey = (sessionId: string, messageId: string) => sessionId + "\u0000" + messageId;

/** True while a run is injecting this marked item; until then the user may withdraw or edit it. */
export function isRunAdjustmentInFlight(sessionId: string, messageId: string): boolean {
  return inFlight.has(flightKey(sessionId, messageId));
}

/** A same-shaped function or DTO cannot bind a trusted adjustment producer. */
export function bindRunAdjustmentPoller(poller: object, binding: AdjustmentBinding, handler: RunAdjustmentHandler): () => void {
  const state = pollers.get(poller);
  if (!state || state.sessionId !== binding.sessionId || state.runId !== binding.runId || state.handler || state.closed) return denied();
  state.handler = handler;
  return () => { if (state.handler === handler) { state.closed = true; state.handler = undefined; } };
}

/**
 * Checks a permit against current data. Before its history commit the queue item must be unchanged;
 * after it (committed) history must hold exactly this message inserted into this run.
 */
export function requireRunAdjustmentPermit(permit: object, binding: AdjustmentBinding): Readonly<{ turnId: string; revision: 1; text: string; committed: boolean }> {
  const state = permits.get(permit);
  if (!state || !state.binding.handler || state.binding.sessionId !== binding.sessionId || state.binding.runId !== binding.runId) return denied();
  if (state.committed) state.assertCommitted(); else state.assertPending();
  if (state.item.attachments?.length) throw new Error("MEMORY_ATTACHMENT_UNSUPPORTED");
  return Object.freeze({ turnId: state.item.id, revision: 1, text: state.item.rawContent, committed: state.committed });
}

/** 拉取器依赖的队列端口：由调用方传入（生产环境是会话存储），本模块不直接依赖会话层。 */
type PendingCommitOutcome =
  | { ok: true; userMessage: { id: string }; remainingQueue: PendingChatMessage[] }
  | { ok: false; error: string };

export type PendingAdjustmentStore = {
  getPendingMessages(sessionId: string): PendingChatMessage[] | null;
  commitPendingAdjust(sessionId: string, messageId: string, runId: string, options?: { assistantTurnId?: string }): PendingCommitOutcome;
  /** History messages already inserted into this run (runInsertion), in commit order. */
  listRunInsertions(sessionId: string, runId: string): ChatMessage[];
};

/** `runId` marks the entry as inserted into that run; the model context frames it (#96). */
type TranscriptUserEntry = { turnId: string; runId: string; text: string; attachments?: PendingChatAttachment[] };

/**
 * 轨迹写入端口：以固定的 turnId 写 user 条目，附件元数据一并保存。
 * 同 ID 已存在时不覆盖，返回已存的正文，由拉取器核对是否就是这条消息。
 */
export type TranscriptUserWritePort = {
  appendUser(input: TranscriptUserEntry): Promise<{ text: string; runId?: string }>;
};

type Blocked = NonNullable<RunAdjustmentPoll["blocked"]>;

/** Writes (or finds) the transcript entry for a committed insertion; returns why it is blocked, if it is. */
async function ensureTranscript(transcript: TranscriptUserWritePort | undefined, entry: TranscriptUserEntry): Promise<Omit<Blocked, "messageId"> | undefined> {
  if (!transcript) return undefined;
  let stored: { text: string; runId?: string };
  try { stored = await transcript.appendUser(entry); }
  catch { return { reason: "transcript-write-failed", retryable: true }; }
  // The store keeps the first write for an id; a different text there is not this message.
  if (stored?.text !== entry.text || stored.runId !== entry.runId) return { reason: "transcript-conflict", retryable: false };
  return undefined;
}

/**
 * 生成 run 级别的插话拉取函数。
 * 没有待处理插话时同步返回 undefined（不引入额外的 await 挂起点）；
 * 有插话时返回 Promise，解析为 { delivered, blocked? }：按入队顺序完成双写的消息，
 * 以及第一条没能完成的条目（可否重试由原因决定）。
 * 未提供 transcript 端口（旧调用方未传 userTurnId）时只提交聊天历史，不写轨迹。
 */
export function createRunAdjustmentPoller(
  sessionId: string, runId: string, store: PendingAdjustmentStore, transcript?: TranscriptUserWritePort,
  options: { assistantTurnId?: string } = {},
): () => Promise<RunAdjustmentPoll> | undefined {
  const state: PollerState = { sessionId, runId };
  let active: Promise<RunAdjustmentPoll> | undefined;
  /** Insertions this poller has handed to the run; the loop's receipts also guard against repeats. */
  const handed = new Set<string>();
  const poller = () => {
    if (state.closed) return Promise.reject(new Error("MEMORY_CONTEXT_ADJUSTMENT_DENIED"));
    if (active) return active.then(() => ({ delivered: [] }));
    // Committed to history earlier but not yet handed over (its transcript write failed): finish those first.
    const committed = store.listRunInsertions(sessionId, runId).filter((message) => !handed.has(message.id));
    // 队列为空或读取为 null 时，两种情况都视为"本 run 没有待插话"
    const marked = (store.getPendingMessages(sessionId) ?? []).filter((item) => item.adjustRunId === runId);
    if (!marked.length && !committed.length) return undefined;
    // Taken synchronously, before the first await, so a removal request handled meanwhile sees it.
    const keys = marked.map((item) => flightKey(sessionId, item.id));
    for (const key of keys) inFlight.add(key);
    const operation = (async (): Promise<RunAdjustmentPoll> => {
      const injected: RunAdjustmentMessage[] = [];
      const block = (messageId: string, why: Omit<Blocked, "messageId">): RunAdjustmentPoll => ({ delivered: injected, blocked: { messageId, ...why } });
      const assertCommitted = (id: string, text: string) => () => {
        const found = store.listRunInsertions(sessionId, runId).filter(message => message.id === id);
        if (found.length !== 1 || found[0].content !== text || found[0].runInsertion?.runId !== runId) throw new Error("MEMORY_CONTEXT_ADJUSTMENT_STALE");
      };
      /** Runs the bound handler for one item; every item-level failure becomes a blocked result. */
      const viaHandler = async (item: PendingChatMessage, start: Pick<PermitState, "committed" | "assertPending">, known?: RunAdjustmentMessage): Promise<Omit<Blocked, "messageId"> | RunAdjustmentMessage> => {
        const handler = state.handler!;
        const permit = Object.freeze({}) as RunAdjustmentPermit;
        const permitState: PermitState = { binding: state, item, ...start, assertCommitted: assertCommitted(item.id, item.rawContent) };
        permits.set(permit, permitState);
        let attempted = false, result = known;
        try {
          const returned = await handler(permit, () => {
            if (attempted || state.handler !== handler) return denied();
            attempted = true;
            // Recovery: history already holds this message; never write it again.
            if (known) { permitState.assertCommitted(); return known; }
            permitState.assertPending();
            const outcome = store.commitPendingAdjust(sessionId, item.id, runId, options);
            if (!outcome.ok) {
              if (outcome.error === "write-failed") throw new RunAdjustmentRetryableError("write-failed");
              throw new Error(`PENDING_ADJUST_COMMIT_FAILED:${item.id}:${outcome.error}`);
            }
            permitState.committed = true;
            result = { id: outcome.userMessage.id, rawContent: item.rawContent, revision: 1 };
            return result;
          });
          if (!result || returned?.id !== result.id || returned.rawContent !== result.rawContent || returned.revision !== result.revision) return denied();
          return result;
        } catch (error) {
          return error instanceof RunAdjustmentRetryableError ? { reason: error.reason, retryable: true } : { reason: reasonOf(error), retryable: false };
        } finally { permits.delete(permit); }
      };
      for (const message of committed) {
        const known = { id: message.id, rawContent: message.content, revision: message.runInsertion?.revision ?? 1 };
        if (state.handler) {
          const item: PendingChatMessage = { id: message.id, rawContent: message.content, visibleContent: message.content, enqueuedAt: 0, adjustRunId: runId };
          const outcome = await viaHandler(item, { committed: true, assertPending: () => denied() }, known);
          if (!("id" in outcome)) return block(message.id, outcome);
        } else {
          const why = await ensureTranscript(transcript, { turnId: message.id, runId, text: message.content });
          if (why) return block(message.id, why);
        }
        injected.push(known);
        handed.add(message.id);
      }
      for (const pending of marked) {
        const item = structuredClone(pending);
        if (state.handler) {
          const fingerprint = JSON.stringify(item);
          const assertPending = () => {
            const current = store.getPendingMessages(sessionId)?.filter(candidate => candidate.id === item.id);
            if (current?.length !== 1 || current[0].adjustRunId !== runId || JSON.stringify(current[0]) !== fingerprint) {
              throw new Error("MEMORY_CONTEXT_ADJUSTMENT_STALE");
            }
          };
          let outcome: Omit<Blocked, "messageId"> | RunAdjustmentMessage;
          try { assertPending(); outcome = await viaHandler(item, { committed: false, assertPending }); }
          catch (error) { outcome = { reason: reasonOf(error), retryable: false }; }
          if (!("id" in outcome)) return block(item.id, outcome);
          injected.push(outcome);
          handed.add(outcome.id);
          continue;
        }
        // 第一步：聊天历史（出队 + 进历史 + runInsertion，同一次写入）。失败时队列与标记不变。
        const commit = store.commitPendingAdjust(sessionId, item.id, runId, options);
        if (!commit.ok) return block(item.id, { reason: commit.error, retryable: commit.error === "write-failed" });
        // 第二步：会话记录。失败时这条已在聊天历史里，下一次拉取凭 runInsertion 找回补写。
        const attachments = item.attachments?.length ? item.attachments : undefined;
        const why = await ensureTranscript(transcript, { turnId: item.id, runId, text: item.rawContent, ...(attachments ? { attachments } : {}) });
        if (why) return block(item.id, why);
        // 两步都成功后才把消息交给运行
        injected.push({ id: commit.userMessage.id, rawContent: item.rawContent, revision: 1 });
        handed.add(item.id);
      }
      return { delivered: injected };
    })();
    active = operation;
    const settle = () => { active = undefined; for (const key of keys) inFlight.delete(key); };
    void operation.then(settle, settle);
    return operation;
  };
  pollers.set(poller, state);
  return poller;
}
