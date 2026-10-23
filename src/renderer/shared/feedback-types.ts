export type FeedbackTone = "success" | "info" | "warning" | "error";
export const FEEDBACK_NOTICE_MAX_COUNT = 3;
export const FEEDBACK_NOTICE_DURATION_MS = 3000;

export interface FeedbackApi {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  notice: (options: NoticeOptions) => void;
  alert: (options: AlertOptions) => Promise<void>;
}
export interface NoticeOptions {
  focusTarget?: { focus: () => void } | null;
  durationMs?: number;
  message: string;
  tone: FeedbackTone;
}
export interface AlertOptions {
  confirmText?: string;
  details?: string;
  message: string;
  title: string;
  tone: FeedbackTone;
}
export interface ConfirmOptions {
  dangerous?: boolean;
  cancelText?: string;
  confirmText?: string;
  message: string;
  title: string;
  tone?: Exclude<FeedbackTone, "success">;
}
