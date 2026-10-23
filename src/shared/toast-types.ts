// 注意力 Toast 中心的共享契约。
// 主进程的 ToastService 是 toast 生命周期的唯一权威（创建、去重、抑制、超时、结算清退）；
// 渲染页只负责显示、动画、音效和上报用户输入。
// 超时时长、窗口宽度等运行时常量放在 src/main/toast/types.ts，属主进程私有。

/** 等待操作（agent 挂起等用户）或通知（事情已发生） */
export type ToastTier = "action-pending" | "notify";

/** 任务完成 / 权限审批 / ASK 选择 / 抽查 / 计划审批 */
export type ToastKind = "task-finished" | "approval" | "ask-choice" | "pop-quiz" | "plan-review";

/**
 * 点击 toast 后的跳转目标，由主进程解析并转给激活代理，渲染端只上报点了哪个 toast。
 * session：切到指定会话（计划审批卡事件自带 sessionId）；
 * window：仅激活窗口（审批/选择/抽查事件在主进程拿不到所属会话，
 * 任务完成结果也在任务历史而不是聊天流里）。
 */
export type ToastTarget =
  | { type: "session"; sessionId: string }
  | { type: "window"; window: "chat" };

/** 主进程维护并推给渲染页的 toast 条目 */
export type ToastItem = {
  createdAt: number;
  target: ToastTarget;
  summary?: string;
  title: string;
  /** 去重与结算匹配用的业务身份：审批 id / 选择卡 id / quizId / schedulerRunId / 计划 runId */
  sourceId: string;
  tier: ToastTier;
  kind: ToastKind;
  id: string;
};

/** 推送载荷：条目加上本次是否播提示音（由主进程结合设置页开关与并发合并决定） */
export interface ToastPushPayload extends ToastItem {
  sound: boolean;
}

/** 单窗口最多同时显示的条数；等待操作档优先占位，超出部分在容器内滚动 */
export const TOAST_MAX_VISIBLE = 4;

/** preload 暴露给 toast 渲染页的 API（经 contextBridge 后只保留函数） */
export type ToastRendererApi = {
  /** 订阅移除（主进程已决定移除，渲染页播退出动画），返回退订函数 */
  onRemove(callback: (id: string) => void): () => void;
  /** 订阅推送（同 id 覆盖），返回退订函数 */
  onPush(callback: (payload: ToastPushPayload) => void): () => void;
  /** 上报内容区实际高度，主进程 clamp 后调整窗口 */
  reportHeight(height: number): void;
  /** 点击关闭按钮，只上报 id，是否消隐由主进程回执决定 */
  dismissed(id: string): void;
  /** 点击卡片主体，只上报 id，跳转由主进程解析 */
  clicked(id: string): void;
  /** 页面加载或重载后取回主进程权威状态的当前显示列表 */
  getAll(): Promise<ToastItem[]>;
};
