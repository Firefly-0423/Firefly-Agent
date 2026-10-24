// 主进程 toast 私有常量；共享类型从 shared 层转出，供主进程内各模块统一引用。

/** 工作区高度占比上限（超出则截断，避免透明窗口挡住鼠标） */
export const TOAST_MAX_WORKAREA_RATIO = 0.6;

/** 通知档的自动消隐等待时间（毫秒，由主进程计时器执行） */
export const TOAST_NOTIFY_TIMEOUT_MS = 10_000;

/** 同一段时间窗口内只允许放行一次提示音的间隔（毫秒） */
export const TOAST_SOUND_MERGE_MS = 300;

/** toast 窗口的固定宽度（像素） */
export const TOAST_WINDOW_WIDTH = 440;

export type { ToastTier, ToastKind, ToastTarget, ToastItem, ToastPushPayload } from "../../shared/toast-types";
export { TOAST_MAX_VISIBLE } from "../../shared/toast-types";
