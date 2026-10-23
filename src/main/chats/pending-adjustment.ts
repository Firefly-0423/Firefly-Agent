// 插话拉取器：把已被标记到当前 run 的排队消息转成正式的用户消息，
// 由 harness 在两个边界（每次模型请求前、最终结算前）按入队顺序取出。
//
// 写入约束：两处落库都成功后才算注入。先写权威轨迹（ID 固定，附件元数据随行），
// 再提交聊天历史。任一步出错都会上抛，且标记保持不变（失败即关闭）。
// 下一轮拉取时轨迹按 ID 幂等命中，只重做聊天历史这一步；未可靠落库的内容不会注入，
// 已提交的条目也不会被二次注入（提交会把它移出队列，再次提交时按未找到处理）。

import * as chatsStore from "./chats-store";
import type { PendingChatAttachment, PendingChatMessage } from "../../shared/chat-types";
import type { RunAdjustmentMessage } from "../orchestrator/harness/types";

/** Opaque Main-only authority for one live, unchanged marked queue item. */
declare const adjustmentPermitBrand: unique symbol;
export type RunAdjustmentPermit = object & { readonly [adjustmentPermitBrand]: true };
type AdjustmentBinding = { sessionId: string; runId: string };
export type RunAdjustmentHandler = (permit: RunAdjustmentPermit, commitHistory: () => RunAdjustmentMessage) => Promise<RunAdjustmentMessage>;
type PollerState = AdjustmentBinding & { handler?: RunAdjustmentHandler; closed?: boolean };
const pollers = new WeakMap<object, PollerState>();
const permits = new WeakMap<object, { binding: PollerState; item: PendingChatMessage; assertPending(): void }>();
const denied = (): never => { throw new Error("MEMORY_CONTEXT_ADJUSTMENT_DENIED"); };

/** A same-shaped function or DTO cannot bind a trusted adjustment producer. */
export function bindRunAdjustmentPoller(poller: object, binding: AdjustmentBinding, handler: RunAdjustmentHandler): () => void {
  const state = pollers.get(poller);
  if (!state || state.sessionId !== binding.sessionId || state.runId !== binding.runId || state.handler || state.closed) return denied();
  state.handler = handler;
  return () => { if (state.handler === handler) { state.closed = true; state.handler = undefined; } };
}

export function requireRunAdjustmentPermit(permit: object, binding: AdjustmentBinding): Readonly<{ turnId: string; revision: 1; text: string }> {
  const state = permits.get(permit);
  if (!state || !state.binding.handler || state.binding.sessionId !== binding.sessionId || state.binding.runId !== binding.runId) return denied();
  state.assertPending();
  if (state.item.attachments?.length) throw new Error("MEMORY_ATTACHMENT_UNSUPPORTED");
  return Object.freeze({ turnId: state.item.id, revision: 1, text: state.item.rawContent });
}

/** 拉取器依赖的队列端口；默认走 chats-store，单测可替换成假实现。 */
type PendingCommitOutcome =
  | { ok: true; userMessage: { id: string }; remainingQueue: PendingChatMessage[] }
  | { ok: false; error: string };

export type PendingAdjustmentStore = {
  getPendingMessages(sessionId: string): PendingChatMessage[] | null;
  commitPendingAdjust(sessionId: string, messageId: string, runId: string): PendingCommitOutcome;
};

type TranscriptUserEntry = { turnId: string; text: string; attachments?: PendingChatAttachment[] };

/** 轨迹写入端口：以固定的 turnId 写 user 条目，附件元数据一并保存；同 ID 重复写入视为幂等。 */
export type TranscriptUserWritePort = {
  appendUser(input: TranscriptUserEntry): Promise<void>;
};

/**
 * 生成 run 级别的插话拉取函数。
 * 没有待处理插话时同步返回 undefined（不引入额外的 await 挂起点）；
 * 有插话时返回 Promise，解析为按入队顺序完成双写的消息列表。
 * 任一步写入失败会 reject，标记保留到下个边界再试，由 harness 失败关闭。
 * 未提供 transcript 端口（旧调用方未传 userTurnId）时只提交聊天历史，不写轨迹。
 */
export function createRunAdjustmentPoller(sessionId: string, runId: string, store: PendingAdjustmentStore = chatsStore, transcript?: TranscriptUserWritePort): () => Promise<RunAdjustmentMessage[]> | undefined {
  const state: PollerState = { sessionId, runId };
  let active: Promise<RunAdjustmentMessage[]> | undefined;
  const poller = () => {
    if (state.closed) return Promise.reject(new Error("MEMORY_CONTEXT_ADJUSTMENT_DENIED"));
    if (active) return active.then(() => []);
    // 队列为空或读取为 null 时，两种情况都视为"本 run 没有待插话"
    const marked = (store.getPendingMessages(sessionId) ?? []).filter((item) => item.adjustRunId === runId);
    if (!marked.length) return undefined;
    const operation = (async () => {
      const injected: RunAdjustmentMessage[] = [];
      for (const pending of marked) {
        const item = structuredClone(pending);
        if (state.handler) {
          const handler = state.handler, fingerprint = JSON.stringify(item);
          const assertPending = () => {
            const current = store.getPendingMessages(sessionId)?.filter(candidate => candidate.id === item.id);
            if (current?.length !== 1 || current[0].adjustRunId !== runId || JSON.stringify(current[0]) !== fingerprint) {
              throw new Error("MEMORY_CONTEXT_ADJUSTMENT_STALE");
            }
          };
          assertPending();
          const permit = Object.freeze({}) as RunAdjustmentPermit;
          permits.set(permit, { binding: state, item, assertPending });
          let attempted = false, committed: RunAdjustmentMessage | undefined;
          try {
            await handler(permit, () => {
              if (attempted || state.handler !== handler) return denied();
              attempted = true; assertPending();
              const result = store.commitPendingAdjust(sessionId, item.id, runId);
              if (!result.ok) throw new Error(`PENDING_ADJUST_COMMIT_FAILED:${item.id}:${result.error}`);
              committed = { id: result.userMessage.id, rawContent: item.rawContent };
              return committed;
            });
            if (!committed) return denied();
            injected.push(committed);
          } finally { permits.delete(permit); }
          continue;
        }
        // 第一步：轨迹。失败直接上抛，聊天历史不动、标记仍在；没有端口时跳过。
        if (transcript) {
          const attachments = item.attachments?.length ? item.attachments : undefined;
          await transcript.appendUser({
            turnId: item.id,
            text: item.rawContent,
            ...(attachments ? { attachments } : {}),
          });
        }
        // 第二步：聊天历史。失败同样上抛；下一轮轨迹会幂等命中，只重做这一步。
        const commit = store.commitPendingAdjust(sessionId, item.id, runId);
        if (!commit.ok) {
          throw new Error(`PENDING_ADJUST_COMMIT_FAILED:${item.id}:${commit.error}`);
        }
        // 两步都成功后才把消息交给运行
        injected.push({ id: commit.userMessage.id, rawContent: item.rawContent });
      }
      return injected;
    })();
    active = operation;
    void operation.then(() => { active = undefined; }, () => { active = undefined; });
    return operation;
  };
  pollers.set(poller, state);
  return poller;
}
