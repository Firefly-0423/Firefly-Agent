import type { PluginPromptMode, PluginTurnStatus } from "../../plugins/api";
import type { LifecyclePublisher } from "./lifecycle-publisher";

/** 桌面轮次开始时已知的标识信息。 */
export interface PendingTurnInput {
  runId: string;
  conversationId: string;
  mode: PluginPromptMode;
  /** 已落盘的用户消息 id，是桌面轮次事件的必填边界。 */
  inputMessageId: string;
  /** 助手占位消息 id；只有收到对应的落盘确认后才会作为 finalMessageId 发布。 */
  assistantMessageId?: string;
  startedAt: number;
  /** 运行超时（毫秒）；整体期限 = startedAt + runTimeoutMs + graceMs。 */
  runTimeoutMs?: number;
}

export interface PendingTurnTerminal {
  status: PluginTurnStatus;
  durationMs?: number;
}

export interface PendingTurnPersistenceAck {
  /** 落盘确认对应的助手消息 id；缺失表示只确认了终态快照。 */
  finalMessageId?: string;
}

export interface PendingTurnLifecycleDeps {
  publisher: LifecyclePublisher;
  /** 时钟（epoch 毫秒），缺省为 Date.now。 */
  now?: () => number;
  /** 终态到达后等待落盘确认的时限，默认 60 秒。 */
  ackTimeoutMs?: number;
  /** 超出运行超时之外的宽限时间，默认 60 秒。 */
  graceMs?: number;
  /** 放弃某个轮次（尽力而为、至多发布一次）时的诊断回调。 */
  onAbandon?: (runId: string, reason: string) => void;
}

interface TurnSlot {
  input: PendingTurnInput;
  createdAt: number;
  /** 整体期限到点即清理，不论是否已有终态。 */
  expiresAt: number;
  terminal?: PendingTurnTerminal;
  persistenceAck?: PendingTurnPersistenceAck;
  published: boolean;
  overallTimer: ReturnType<typeof setTimeout>;
  ackTimer?: ReturnType<typeof setTimeout>;
}

/**
 * 桌面轮次生命周期协调器。turn:started 在运行开始时立即发布；
 * turn:finished 只有同时拿到主进程终态和渲染端落盘确认后才发布一次。
 * 落盘确认迟迟不到或整体期限已过时直接放弃，绝不伪造消息边界。
 */
export function createPendingTurnLifecycle(deps: PendingTurnLifecycleDeps) {
  const clock = deps.now ?? (() => Date.now());
  const ackWindow = deps.ackTimeoutMs ?? 60_000;
  const graceWindow = deps.graceMs ?? 60_000;
  const slots = new Map<string, TurnSlot>();

  function stopAckTimer(slot: TurnSlot): void {
    if (slot.ackTimer === undefined) return;
    clearTimeout(slot.ackTimer);
    slot.ackTimer = undefined;
  }

  /** 释放轮次：停掉所有计时器并移出表；带 reason 时视为放弃并回调。 */
  function release(runId: string, reason?: string): void {
    const slot = slots.get(runId);
    if (slot === undefined) return;
    clearTimeout(slot.overallTimer);
    stopAckTimer(slot);
    slots.delete(runId);
    if (reason) {
      deps.onAbandon?.(runId, reason);
    }
  }

  /** 终态与落盘确认都就位时发布 turn:finished，然后释放轮次。 */
  function tryPublishFinished(slot: TurnSlot): void {
    if (slot.published || !slot.terminal) return;
    slot.published = true;
    // finalMessageId 只取真实的落盘确认值，绝不用会话的最后一条消息补位。
    const confirmedId = slot.persistenceAck?.finalMessageId;
    deps.publisher.publishTurnFinished({
      source: "desktop",
      runId: slot.input.runId,
      mode: slot.input.mode,
      conversationId: slot.input.conversationId,
      inputMessageId: slot.input.inputMessageId,
      ...(confirmedId ? { finalMessageId: confirmedId } : {}),
      status: slot.terminal.status,
      ...(slot.terminal.durationMs !== undefined ? { durationMs: slot.terminal.durationMs } : {}),
    });
    release(slot.input.runId);
  }

  function beginTurn(input: PendingTurnInput): void {
    // 没有用户消息 id 就无法描述轮次边界，整轮跳过并记录诊断。
    if (!input.inputMessageId) {
      deps.onAbandon?.(input.runId, "missing inputMessageId");
      return;
    }
    release(input.runId);
    const openedAt = clock();
    const budget = (input.runTimeoutMs ?? 0) + graceWindow;
    const slot: TurnSlot = {
      input,
      createdAt: openedAt,
      expiresAt: openedAt + budget,
      published: false,
      overallTimer: setTimeout(() => {
        release(input.runId, "lifetime expired");
      }, Math.max(budget, 0)),
    };
    // 计时器不能把主进程挂住。
    slot.overallTimer.unref?.();
    slots.set(input.runId, slot);
    deps.publisher.publishTurnStarted({
      source: "desktop",
      runId: input.runId,
      mode: input.mode,
      conversationId: input.conversationId,
      inputMessageId: input.inputMessageId,
    });
  }

  function settleTerminal(runId: string, terminal: PendingTurnTerminal): void {
    const slot = slots.get(runId);
    if (slot === undefined) return;
    // 终态只取第一次：complete 与 error 两条路径都可能调用它。
    if (slot.terminal) return;
    slot.terminal = terminal;
    if (slot.persistenceAck) {
      tryPublishFinished(slot);
      return;
    }
    // 终态先到，等待落盘确认，超时则放弃（至多发布一次）。
    slot.ackTimer = setTimeout(() => {
      release(runId, "persistence ack timeout");
    }, ackWindow);
    slot.ackTimer.unref?.();
  }

  function confirmPersistence(runId: string, ack: PendingTurnPersistenceAck): void {
    const slot = slots.get(runId);
    if (slot === undefined || slot.published) return;
    slot.persistenceAck = ack;
    // 确认先于终态到达时，留到终态到达再发布。
    if (slot.terminal) {
      tryPublishFinished(slot);
    }
  }

  return {
    beginTurn,
    settleTerminal,
    confirmPersistence,
    disposeEntry: release,
    /** 应用关闭或渲染进程失效时清空全部轮次，且不发布任何事件。 */
    disposeAll(): void {
      for (const runId of [...slots.keys()]) {
        release(runId);
      }
    },
    /** 仅供测试：当前尚未结算的轮次数量。 */
    pendingCount(): number {
      return slots.size;
    },
  };
}

export type PendingTurnLifecycle = ReturnType<typeof createPendingTurnLifecycle>;
