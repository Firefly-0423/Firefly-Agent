import type { AlertOptions, ConfirmOptions } from "../../shared/feedback-types";

// 调用方负责保证传入 HTML 可信。
export interface HtmlModalOptions {
  title: string; htmlBody: string;
  icon?: string; confirmText?: string;
}

export interface InputModalOptions {
  title: string; message: string;
  placeholder?: string; defaultValue?: string;
  icon?: string; confirmText?: string; cancelText?: string;
}

type PendingDialog<Kind extends string, Options, Result extends unknown[]> = {
  kind: Kind;
  options: Options;
  resolve: (...values: Result) => void;
};

export type BlockingDialogRequest =
  | PendingDialog<"alert", AlertOptions, []>
  | PendingDialog<"confirm", ConfirmOptions, [value: boolean]>
  | PendingDialog<"html", HtmlModalOptions, []>
  | PendingDialog<"input", InputModalOptions, [value: string | null]>;

interface DialogState {
  ffOverlay: HTMLElement | null;
  ffHtmlOverlay: HTMLElement | null;
  ffInputOverlay: HTMLElement | null;
  noticeContainer: HTMLElement | null;
  blockingQueue: BlockingDialogRequest[];
  blockingActive: boolean;
}

// 三种容器通过同一份状态协调排队展示。
export const modalState: DialogState = {
  ffOverlay: null, ffHtmlOverlay: null, ffInputOverlay: null,
  noticeContainer: null, blockingQueue: [], blockingActive: false,
};
