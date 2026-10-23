// 主进程内部的注意力事件通道。事件源（审批、选择卡、计划流、抽查、定时任务）
// 只负责发布；toast 服务在组合阶段订阅。发布前由事件源自行整理字段，
// 这里不引用任何具体卡片类型，因此 toast 模块不会反向依赖业务模块。

/** 审批请求刚生成，尚等用户决定 */
export interface ApprovalPendingEvent {
  runId?: string;
  toolName: string;
  toolId: string;
  id: string;
}

/** 审批已有结论（回答、取消或不可用之一） */
export interface ApprovalSettledEvent {
  reason: string;
  runId?: string;
  id: string;
}

/** 选择类卡片已出现：ASK 工具、计划审批卡、计划补充卡共用此事件 */
export interface ChoiceCardEvent {
  revision: number;
  runId?: string;
  intro: string;
  /** 卡片标识：ask 载荷的交互 id，或旧版卡片的 id */
  cardId: string;
}

/** 选择类卡片结束（回答、超时、不可用或取消） */
export interface ChoiceDismissEvent {
  reason: string;
  revision: number;
  runId?: string;
  cardId: string;
}

/** 计划草稿写完并进入待审阅状态；先于同一次运行的选择卡发出 */
export interface PlanReviewEvent {
  runId: string;
  sessionId: string;
}

/** 计划获批，转入执行 */
export interface PlanApprovedEvent {
  runId: string;
  sessionId: string;
}

/** 计划流结束但没有走批准路径：要么退回讨论且不再补卡，要么流程异常 */
export interface PlanReviewEndedEvent {
  runId: string;
  sessionId: string;
}

/** 抽查题已出卡，等待作答 */
export interface QuizPendingEvent {
  firstQuestion: string;
  runId: string;
  quizId: string;
}

/** 抽查有结论（提交、跳过或取消） */
export interface QuizSettledEvent {
  reason: string;
  runId: string;
  quizId: string;
}

/** 定时任务进入终态；通知档使用，sessionId 仅在可归属会话时存在 */
export interface SchedulerFinishedEvent {
  /** 与会话的归属关系，用于焦点抑制判断；调度执行目前不带会话 */
  sessionId?: string;
  outputPreview?: string;
  status: string;
  taskTitle: string;
  taskId: string;
  schedulerRunId: string;
}

/** 事件种类：键名生成 on* / publish* 方法名，类型参数约束每个主题的载荷 */
interface ToastEventMap {
  ApprovalPending: ApprovalPendingEvent;
  ApprovalSettled: ApprovalSettledEvent;
  ChoiceCard: ChoiceCardEvent;
  ChoiceDismiss: ChoiceDismissEvent;
  PlanReview: PlanReviewEvent;
  PlanApproved: PlanApprovedEvent;
  PlanReviewEnded: PlanReviewEndedEvent;
  QuizPending: QuizPendingEvent;
  QuizSettled: QuizSettledEvent;
  SchedulerFinished: SchedulerFinishedEvent;
}

const TOPIC_LABELS: { [K in keyof ToastEventMap]: string } = {
  ApprovalPending: "approval-pending",
  ApprovalSettled: "approval-settled",
  ChoiceCard: "choice-card",
  ChoiceDismiss: "choice-dismiss",
  PlanReview: "plan-review",
  PlanApproved: "plan-approved",
  PlanReviewEnded: "plan-review-ended",
  QuizPending: "quiz-pending",
  QuizSettled: "quiz-settled",
  SchedulerFinished: "scheduler-finished",
};

type ToastEventBusMethods = {
  [K in keyof ToastEventMap as `on${K}`]: (listener: (event: ToastEventMap[K]) => void) => () => void;
};

type ToastEventPublishers = {
  [K in keyof ToastEventMap as `publish${K}`]: (event: ToastEventMap[K]) => void;
};

export type ToastEventBus = ToastEventBusMethods & ToastEventPublishers;

interface TopicHandle<T> {
  subscribe(listener: (event: T) => void): () => void;
  publish(event: T): void;
}

/**
 * 单个主题：每次发布都对监听器做一份快照，因此回调里退订不会影响本轮派发；
 * 退订通过 Set 删除实现，多次调用无副作用；单个监听器抛错只记日志，不打断其他监听器。
 */
function makeTopic<T>(label: string): TopicHandle<T> {
  const registry = new Set<(event: T) => void>();

  const subscribe = (listener: (event: T) => void) => {
    registry.add(listener);
    return () => {
      registry.delete(listener);
    };
  };

  const publish = (event: T) => {
    const snapshot = Array.from(registry);
    for (const listener of snapshot) {
      try {
        listener(event);
      } catch (error) {
        console.warn(`[ToastEvents] ${label} 监听器执行失败:`, error);
      }
    }
  };

  return { subscribe, publish };
}

export function createToastEventBus(): ToastEventBus {
  const bag: Record<string, unknown> = {};
  for (const name of Object.keys(TOPIC_LABELS) as Array<keyof ToastEventMap>) {
    const topic = makeTopic<ToastEventMap[typeof name]>(TOPIC_LABELS[name]);
    bag[`on${name}`] = topic.subscribe;
    bag[`publish${name}`] = topic.publish;
  }
  return bag as ToastEventBus;
}

/**
 * 进程级单例：事件源直接 import 后发布，组合根再把同一实例交给 ToastService。
 */
export const toastEvents: ToastEventBus = createToastEventBus();
