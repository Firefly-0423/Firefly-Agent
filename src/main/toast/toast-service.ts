// 注意力 toast 的主进程状态机。可见列表（visible）与去重记忆（seenKeys）分开存放：
// 前者只描述屏幕上此刻有什么，后者记录哪些等待类业务已经提醒过。
// 用户关闭或点击后卡片消失，但去重记忆留到业务结算才清除。

import { IPC } from "../../shared/ipc-channels";
import type { ToastItem, ToastPushPayload } from "../../shared/toast-types";
import type { IpcScope } from "../application/ipc-scope";
import type { WindowActivationRequest } from "../application/window-activation";
import type { ToastWindowController } from "./toast-window";
import type {
  ApprovalPendingEvent,
  ApprovalSettledEvent,
  ChoiceCardEvent,
  ChoiceDismissEvent,
  PlanApprovedEvent,
  PlanReviewEndedEvent,
  PlanReviewEvent,
  QuizPendingEvent,
  QuizSettledEvent,
  SchedulerFinishedEvent,
  ToastEventBus,
} from "./toast-events";
import { TOAST_NOTIFY_TIMEOUT_MS, TOAST_SOUND_MERGE_MS, type ToastTier } from "./types";

export interface ToastServiceDeps {
  bus: ToastEventBus;
  window: ToastWindowController;
  /** 激活聊天窗口（可附带切换到某个会话） */
  activate(request: WindowActivationRequest): void;
  /** toast 唯一 id 的生成函数，测试时可替换 */
  newId?: () => string;
  /** 时间来源（毫秒），测试时可替换 */
  now?: () => number;
  /** 设置页提示音开关，未提供时视为开启 */
  isSoundEnabled?: () => boolean;
  /** 通知档焦点抑制：返回 true 时整条通知直接丢弃 */
  shouldSuppressNotify?: (event: SchedulerFinishedEvent) => boolean;
}

type ItemKind = ToastItem["kind"];
type ItemTarget = ToastItem["target"];

/** 去重键由类别与业务 id 拼成，两者任一不同都视为不同业务 */
function seenKeyOf(kind: ItemKind, sourceId: string): string {
  return [kind, sourceId].join(":");
}

function chatWindowTarget(): ItemTarget {
  return { type: "window", window: "chat" };
}

export function createToastService(deps: ToastServiceDeps) {
  const mintId = deps.newId ?? (() => `toast-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const clock = deps.now ?? (() => Date.now());
  const readSoundFlag = deps.isSoundEnabled ?? (() => true);
  const suppressNotify = deps.shouldSuppressNotify ?? (() => false);

  const visible = new Map<string, ToastItem>();
  const seenKeys = new Set<string>();
  /** 计划流 runId：这些 runId 的选择卡归入 plan-review，不走 ask-choice */
  const planRuns = new Set<string>();
  const autoHideTimers = new Map<string, ReturnType<typeof setTimeout>>();

  let lastSoundStamp = Number.NEGATIVE_INFINITY;
  let lastSoundTier: ToastTier | null = null;

  // ── 提示音：合并窗口内只放一次，等待操作档可以盖过刚响的通知档 ──

  function claimSound(stamp: number, tier: ToastTier): boolean {
    lastSoundStamp = stamp;
    lastSoundTier = tier;
    return true;
  }

  function resolveSound(tier: ToastTier): boolean {
    if (!readSoundFlag()) return false;
    const stamp = clock();
    if (stamp - lastSoundStamp > TOAST_SOUND_MERGE_MS) {
      return claimSound(stamp, tier);
    }
    const outranks = tier === "action-pending" && lastSoundTier === "notify";
    return outranks ? claimSound(stamp, tier) : false;
  }

  // ── 展示与移除：渲染页只被动接收指令 ──

  function present(item: ToastItem): void {
    visible.set(item.id, item);
    const payload: ToastPushPayload = { ...item, sound: resolveSound(item.tier) };
    deps.window.send(IPC.TOAST_PUSH, payload);
    deps.window.syncVisibility(true);
  }

  function dismiss(id: string): void {
    const pendingTimer = autoHideTimers.get(id);
    if (pendingTimer !== undefined) {
      clearTimeout(pendingTimer);
      autoHideTimers.delete(id);
    }
    if (!visible.delete(id)) return;
    deps.window.send(IPC.TOAST_REMOVE, id);
    deps.window.syncVisibility(visible.size > 0);
  }

  function findVisible(kind: ItemKind, sourceId: string): ToastItem | undefined {
    return [...visible.values()].find((item) => item.kind === kind && item.sourceId === sourceId);
  }

  /** 等待操作档：首次出现才展示；已记入去重表的同一业务直接忽略 */
  function raiseActionItem(item: ToastItem): void {
    const key = seenKeyOf(item.kind, item.sourceId);
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    present(item);
  }

  /** 业务结算：去重记录与仍在屏幕上的卡片一并清掉 */
  function settle(kind: ItemKind, sourceId: string): void {
    seenKeys.delete(seenKeyOf(kind, sourceId));
    const live = findVisible(kind, sourceId);
    if (live) dismiss(live.id);
  }

  function buildItem(
    fields: Pick<ToastItem, "kind" | "tier" | "sourceId" | "title" | "target"> & { summary?: string },
  ): ToastItem {
    const id = mintId();
    return { id, ...fields, createdAt: clock() };
  }

  /** 等待操作档条目统一指向聊天窗口，仅在有摘要时带 summary 字段 */
  function waitingForChat(kind: ItemKind, sourceId: string, title: string, summary?: string): ToastItem {
    return buildItem({ kind, tier: "action-pending", sourceId, title, summary, target: chatWindowTarget() });
  }

  // ── 四类等待操作档 + 计划流 ──

  const onApprovalPending = (event: ApprovalPendingEvent): void => {
    raiseActionItem(waitingForChat("approval", event.id, "流萤在等你的批准", event.toolName));
  };

  const onApprovalSettled = (event: ApprovalSettledEvent): void => {
    settle("approval", event.id);
  };

  const onChoiceCard = (event: ChoiceCardEvent): void => {
    if (event.runId && planRuns.has(event.runId)) return;
    raiseActionItem(waitingForChat("ask-choice", event.cardId, "流萤想问你一个问题", event.intro));
  };

  const onChoiceDismiss = (event: ChoiceDismissEvent): void => {
    if (event.runId && planRuns.has(event.runId)) {
      onPlanCardDismissed(event);
      return;
    }
    settle("ask-choice", event.cardId);
  };

  /**
   * 计划卡结算：revision 1 之后可能还有补充卡，此时只撤掉可见卡片、保留去重；
   * revision 2 结束或任何 cancelled 才算整个计划流结束。
   */
  function onPlanCardDismissed(event: { runId?: string; revision: number; reason: string }): void {
    const runId = event.runId;
    if (!runId) return;
    const finished = event.revision >= 2 || event.reason === "cancelled";
    if (finished) {
      settle("plan-review", runId);
      planRuns.delete(runId);
      return;
    }
    const live = findVisible("plan-review", runId);
    if (live) dismiss(live.id);
  }

  const onPlanReview = (event: PlanReviewEvent): void => {
    planRuns.add(event.runId);
    raiseActionItem(
      buildItem({
        kind: "plan-review",
        tier: "action-pending",
        sourceId: event.runId,
        title: "计划已写好，等你批准",
        target: { type: "session", sessionId: event.sessionId },
      }),
    );
  };

  const onPlanApproved = (event: PlanApprovedEvent): void => {
    settle("plan-review", event.runId);
    planRuns.delete(event.runId);
  };

  /** 计划流结束但未获批准：整体清理，多次触发不会产生副作用 */
  const onPlanReviewEnded = (event: PlanReviewEndedEvent): void => {
    settle("plan-review", event.runId);
    planRuns.delete(event.runId);
  };

  const onQuizPending = (event: QuizPendingEvent): void => {
    raiseActionItem(waitingForChat("pop-quiz", event.quizId, "流萤出了道抽查题", event.firstQuestion));
  };

  const onQuizSettled = (event: QuizSettledEvent): void => {
    settle("pop-quiz", event.quizId);
  };

  // ── 通知档：定时任务完成，仅成功时提醒，超时后自动消失 ──

  const onSchedulerFinished = (event: SchedulerFinishedEvent): void => {
    if (event.status !== "success") return;
    if (suppressNotify(event)) return;
    const item = buildItem({
      kind: "task-finished",
      tier: "notify",
      sourceId: event.schedulerRunId,
      title: `「${event.taskTitle}」跑完了`,
      summary: event.outputPreview,
      target: chatWindowTarget(),
    });
    present(item);
    const handle = setTimeout(() => {
      autoHideTimers.delete(item.id);
      dismiss(item.id);
    }, TOAST_NOTIFY_TIMEOUT_MS);
    if (typeof handle.unref === "function") handle.unref();
    autoHideTimers.set(item.id, handle);
  };

  // ── 用户交互：渲染页只上报 id，跳转目标从主进程状态中解析 ──

  function routeTo(target: ItemTarget): void {
    if (target.type === "session") {
      deps.activate({ kind: "chat", sessionId: target.sessionId });
    } else if (target.type === "window") {
      deps.activate({ kind: "chat" });
    }
  }

  function onClicked(id: string): void {
    const item = visible.get(id);
    if (!item) return;
    routeTo(item.target);
    dismiss(id);
  }

  function onDismissed(id: string): void {
    dismiss(id);
  }

  // ── 订阅与 IPC ──

  const detachers: Array<() => void> = [
    deps.bus.onApprovalPending(onApprovalPending),
    deps.bus.onApprovalSettled(onApprovalSettled),
    deps.bus.onChoiceCard(onChoiceCard),
    deps.bus.onChoiceDismiss(onChoiceDismiss),
    deps.bus.onPlanReview(onPlanReview),
    deps.bus.onPlanApproved(onPlanApproved),
    deps.bus.onPlanReviewEnded(onPlanReviewEnded),
    deps.bus.onQuizPending(onQuizPending),
    deps.bus.onQuizSettled(onQuizSettled),
    deps.bus.onSchedulerFinished(onSchedulerFinished),
  ];

  /** 只接受来自 toast 窗口自身的上报，其余发送方的消息一律丢弃 */
  function fromToastWindowOnly(handler: (arg: unknown) => void) {
    return (event: { sender: { id: number } }, arg: unknown): void => {
      if (deps.window.owns(event.sender)) handler(arg);
    };
  }

  function registerIpc(ipc: IpcScope): void {
    ipc.handle(IPC.TOAST_GET_ALL, () => [...visible.values()]);
    const idFrom = (run: (id: string) => void) => (arg: unknown) => {
      if (typeof arg === "string") run(arg);
    };
    ipc.on(IPC.TOAST_CLICKED, fromToastWindowOnly(idFrom(onClicked)));
    ipc.on(IPC.TOAST_DISMISSED, fromToastWindowOnly(idFrom(onDismissed)));
    ipc.on(
      IPC.TOAST_RESIZE,
      fromToastWindowOnly((arg) => {
        if (typeof arg === "number") deps.window.updateHeight(arg);
      }),
    );
  }

  return {
    registerIpc,
    /** 返回当前屏幕上的 toast 列表，供测试与状态查询使用 */
    getActiveToasts(): ToastItem[] {
      return [...visible.values()];
    },
    /** 指定类别与业务 id 是否仍在去重表中，供测试使用 */
    hasPendingSeen(kind: ItemKind, sourceId: string): boolean {
      return seenKeys.has(seenKeyOf(kind, sourceId));
    },
    dispose(): void {
      for (const detach of detachers) detach();
      detachers.length = 0;
    },
  };
}

export type ToastService = ReturnType<typeof createToastService>;
