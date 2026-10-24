import { CheckCircleOutlined, CloseCircleOutlined, InfoCircleOutlined, WarningOutlined } from "@ant-design/icons";
import { Modal, message } from "antd";
import * as React from "react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import { FEEDBACK_NOTICE_DURATION_MS, FEEDBACK_NOTICE_MAX_COUNT, type AlertOptions, type ConfirmOptions, type FeedbackApi, type FeedbackTone } from "../../../shared/feedback-types";
import "./Feedback.css";

type ModalApi = ReturnType<typeof Modal.useModal>[0];
type DialogClosers = Set<() => void>;
const FeedbackContext = createContext<FeedbackApi | null>(null);

function feedbackSymbol(kind: FeedbackTone): ReactNode {
  switch (kind) {
    case "success": return <CheckCircleOutlined />;
    case "info": return <InfoCircleOutlined />;
    case "warning": return <WarningOutlined />;
    case "error": return <CloseCircleOutlined />;
  }
}

function AlertBody({ message: body, details: extra }: Pick<AlertOptions, "message" | "details">) {
  return <div className="ff-feedback-alert__content">
    <p>{body}</p>
    {extra ? <details><summary>查看详情</summary><pre>{extra}</pre></details> : null}
  </div>;
}

// 卸载与点击共用幂等的结算回调。
function dialogResult<T>(closers: DialogClosers, cancelled: T, display: (finish: (answer: T) => void, dismiss: () => void) => void): Promise<T> {
  return new Promise<T>((complete) => {
    let done = false;
    const finish = (answer: T) => {
      if (done) return;
      done = true;
      closers.delete(dismiss);
      complete(answer);
    };
    const dismiss = () => finish(cancelled);
    closers.add(dismiss);
    display(finish, dismiss);
  });
}

function openQuestion(dialogs: ModalApi, closers: DialogClosers, request: ConfirmOptions) {
  return dialogResult(closers, false, (finish, dismiss) => {
    dialogs.confirm({
      title: request.title,
      content: request.message,
      icon: feedbackSymbol(request.tone ?? (request.dangerous ? "error" : "warning")),
      okText: request.confirmText ?? "确定",
      cancelText: request.cancelText ?? "取消",
      maskClosable: false,
      autoFocusButton: request.dangerous ? "cancel" : "ok",
      okButtonProps: request.dangerous ? { danger: true } : undefined,
      rootClassName: `ff-feedback-modal${request.dangerous ? " ff-feedback-modal--danger" : ""}`,
      onOk: () => finish(true),
      onCancel: dismiss,
    });
  });
}

function openAlert(dialogs: ModalApi, closers: DialogClosers, request: AlertOptions) {
  return dialogResult<void>(closers, undefined, (_finish, dismiss) => {
    dialogs.confirm({
      title: request.title,
      content: <AlertBody message={request.message} details={request.details} />,
      icon: feedbackSymbol(request.tone),
      cancelButtonProps: { style: { display: "none" } },
      okText: request.confirmText ?? "知道了",
      maskClosable: false,
      autoFocusButton: "ok",
      rootClassName: `ff-feedback-modal ff-feedback-modal--${request.tone}`,
      onOk: dismiss,
      onCancel: dismiss,
    });
  });
}

export function useFeedback(): FeedbackApi {
  const current = useContext(FeedbackContext);
  if (current) return current;
  throw new Error("useFeedback 必须在 FeedbackProvider 内使用");
}

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [dialogs, dialogPortal] = Modal.useModal();
  const [notices, noticePortal] = message.useMessage({ maxCount: FEEDBACK_NOTICE_MAX_COUNT });
  const closers = useRef(new Set<() => void>());
  const queueEnd = useRef<Promise<void>>(Promise.resolve());
  const live = useRef(true);

  // 空队列也走微任务链，保持后续请求的顺序。
  const schedule = useCallback(<T,>(display: () => Promise<T>, cancelled: T): Promise<T> => {
    const next = () => live.current ? display() : Promise.resolve(cancelled);
    const completion = queueEnd.current.then(next, next);
    queueEnd.current = completion.then(() => undefined, () => undefined);
    return completion;
  }, []);

  const facade = useMemo<FeedbackApi>(() => ({
    notice(request) {
      request.focusTarget?.focus();
      void notices.open({
        key: `${request.tone}:${request.message}`,
        type: request.tone,
        content: request.message,
        duration: (request.durationMs ?? FEEDBACK_NOTICE_DURATION_MS) / 1000,
        className: "ff-feedback-notice",
      });
    },
    alert(request) {
      return schedule(() => openAlert(dialogs, closers.current, request), undefined);
    },
    confirm(request) {
      return schedule(() => openQuestion(dialogs, closers.current, request), false);
    },
  }), [schedule, notices, dialogs]);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      for (const dismiss of closers.current) dismiss();
      closers.current.clear();
    };
  }, []);

  return <FeedbackContext.Provider value={facade}>{noticePortal}{dialogPortal}{children}</FeedbackContext.Provider>;
}
