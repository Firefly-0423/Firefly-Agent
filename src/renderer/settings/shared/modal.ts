// Electron 提示框由页面绘制；阻塞弹窗排队，轻提示独立计时。
import {
  FEEDBACK_NOTICE_DURATION_MS, FEEDBACK_NOTICE_MAX_COUNT,
  type AlertOptions, type ConfirmOptions, type FeedbackTone, type NoticeOptions,
} from "../../shared/feedback-types";
import { activateDialogFocus } from "./dialog-focus";
import { modalState, type BlockingDialogRequest, type HtmlModalOptions, type InputModalOptions } from "./modal-state";

const feedbackGlyphs: Record<FeedbackTone, string> = {
  success:
    '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 10 3 3 7-7"/></svg>',
  info:
    '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7"/><path d="M10 9v5M10 6.5h.01"/></svg>',
  warning:
    '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3 18 17H2L10 3Z"/><path d="M10 8v4M10 14.5h.01"/></svg>',
  error:
    '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7"/><path d="m7.5 7.5 5 5M12.5 7.5l-5 5"/></svg>',
};
const pencilGlyph = '<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M5.32497 43.4996L13.81 43.4998L44.9227 12.3871L36.4374 3.90186L5.32471 35.0146L5.32497 43.4996Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M27.9521 12.3872L36.4374 20.8725" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const noticeExpiryByElement = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();
let dismissCurrentDialog: (() => void) | null = null;
let unloadHookInstalled = false;
let drainingForUnload = false;

export function showAlert(options: AlertOptions): Promise<void> {
  return new Promise<void>((complete) => {
    queueDialogRequest({ kind: "alert", options, resolve: complete });
  });
}

export function showConfirm(options: ConfirmOptions): Promise<boolean> {
  const effectiveTone = options.tone ?? (options.dangerous ? "error" : "warning");
  return new Promise<boolean>((complete) => {
    queueDialogRequest({ kind: "confirm", options: { ...options, tone: effectiveTone }, resolve: complete });
  });
}

// 兼容旧参数；icon 字段仍不参与确认框展示。
export function showModal(options: {
  title: string;
  message: string;
  icon?: string;
  confirmText?: string;
  cancelText?: string;
}): Promise<boolean> {
  return showConfirm({
    title: options.title, message: options.message,
    confirmText: options.confirmText, cancelText: options.cancelText,
  });
}

// 正文与图标的 HTML 可信性由调用方保证。
export function showHtmlModal(options: HtmlModalOptions): Promise<void> {
  return new Promise<void>((complete) => {
    queueDialogRequest({ kind: "html", options, resolve: complete });
  });
}

export function showInputModal(options: InputModalOptions): Promise<string | null> {
  return new Promise<string | null>((complete) => {
    queueDialogRequest({ kind: "input", options, resolve: complete });
  });
}

function getAttachedNoticeStack(): HTMLElement {
  const attachedStack = modalState.noticeContainer;
  if (attachedStack?.isConnected) return attachedStack;
  const stack = document.createElement("div");
  stack.className = "ff-notice-stack";
  document.body.appendChild(stack);
  modalState.noticeContainer = stack;
  return stack;
}

export function showNotice(options: NoticeOptions): void {
  const stack = getAttachedNoticeStack();
  const lifetime = options.durationMs ?? FEEDBACK_NOTICE_DURATION_MS;
  const identity = `${options.tone}:${options.message}`;
  const duplicate = [...stack.children].find(
    (candidate) => (candidate as HTMLElement).dataset.noticeKey === identity,
  ) as HTMLElement | undefined;

  if (duplicate) {
    const oldTimer = noticeExpiryByElement.get(duplicate);
    if (oldTimer !== undefined) clearTimeout(oldTimer);
    noticeExpiryByElement.set(duplicate, setTimeout(() => duplicate.remove(), lifetime));
    stack.append(duplicate);
    options.focusTarget?.focus();
    return;
  }

  // 提示已满时仍需响应字段聚焦。
  options.focusTarget?.focus();
  if (stack.children.length >= FEEDBACK_NOTICE_MAX_COUNT) return;
  const notice = document.createElement("div");
  notice.className = `ff-notice ff-notice--${options.tone}`;
  notice.dataset.noticeKey = identity;
  notice.setAttribute("role", options.tone === "error" ? "alert" : "status");
  const symbol = document.createElement("span");
  symbol.className = "ff-notice__icon";
  symbol.innerHTML = feedbackGlyphs[options.tone];
  const copy = document.createElement("span");
  copy.className = "ff-notice__message";
  copy.textContent = options.message;
  notice.append(symbol, copy);
  stack.append(notice);
  noticeExpiryByElement.set(notice, setTimeout(() => notice.remove(), lifetime));
}

function resolveCancellation(pending: BlockingDialogRequest): void {
  if (pending.kind === "confirm") pending.resolve(false);
  else if (pending.kind === "input") pending.resolve(null);
  else pending.resolve();
}

function installUnloadCleanup(): void {
  if (unloadHookInstalled) return;
  unloadHookInstalled = true;
  window.addEventListener("beforeunload", () => {
    // 卸载收尾期间不打开下一条请求。
    drainingForUnload = true;
    try {
      dismissCurrentDialog?.();
      while (modalState.blockingQueue.length > 0) {
        const queued = modalState.blockingQueue.shift();
        if (!queued) break;
        resolveCancellation(queued);
      }
    } finally {
      // 导航可被取消，之后仍允许展示新弹窗。
      drainingForUnload = false;
    }
  });
}

function queueDialogRequest(pending: BlockingDialogRequest): void {
  installUnloadCleanup();
  modalState.blockingQueue.push(pending);
  openNextQueuedDialog();
}

function openNextQueuedDialog(): void {
  if (drainingForUnload || modalState.blockingActive) return;
  const pending = modalState.blockingQueue.shift();
  if (!pending) return;
  modalState.blockingActive = true;
  try {
    displayQueuedRequest(pending);
  } catch (renderError) {
    console.error("[settings-feedback] 阻塞弹窗渲染失败", renderError);
    modalState.blockingActive = false;
    resolveCancellation(pending);
    openNextQueuedDialog();
  }
}

function displayQueuedRequest(pending: BlockingDialogRequest): void {
  if (pending.kind === "html") displayHtmlDialog(pending);
  else if (pending.kind === "input") displayInputDialog(pending);
  else displayFeedbackDialog(pending);
}

function completeQueuedRequest(pending: BlockingDialogRequest, complete: () => void): void {
  dismissCurrentDialog = null;
  modalState.blockingActive = false;
  complete();
  openNextQueuedDialog();
}

export function _initModalOverlay(): void {
  if (modalState.ffOverlay) return;
  modalState.ffOverlay = document.createElement("div");
  const layer = modalState.ffOverlay;
  layer.id = "ff-modal-overlay";
  layer.className = "ff-modal-overlay is-hidden";
  layer.innerHTML = `<div class="ff-modal" role="alertdialog" aria-modal="true" aria-labelledby="ff-modal-title" aria-describedby="ff-modal-message">
  <div class="ff-modal__head">
    <span class="ff-modal__icon ff-modal__icon--warning" id="ff-modal-icon" aria-hidden="true"></span>
    <h3 class="ff-modal__title" id="ff-modal-title">提示</h3>
  </div>
  <p class="ff-modal__body" id="ff-modal-message"></p>
  <details class="ff-modal__details-wrap" id="ff-modal-details-wrap" hidden>
    <summary>查看详情</summary>
    <pre class="ff-modal__details" id="ff-modal-details"></pre>
  </details>
  <div class="ff-modal__actions" id="ff-modal-actions">
    <button type="button" class="ghost-btn" id="ff-modal-cancel">取消</button>
    <button type="button" class="btn-primary" id="ff-modal-confirm">确定</button>
  </div>
</div>`;
  document.body.appendChild(layer);
}

function displayFeedbackDialog(request: Extract<BlockingDialogRequest, { kind: "alert" | "confirm" }>): void {
  _initModalOverlay();
  const layer = modalState.ffOverlay;
  if (!layer) {
    console.error("[settings-feedback] 无法创建阻塞弹窗容器");
    completeQueuedRequest(request, () => resolveCancellation(request));
    return;
  }
  const panel = layer.querySelector(".ff-modal") as HTMLElement;
  const symbol = layer.querySelector("#ff-modal-icon") as HTMLElement;
  const heading = layer.querySelector("#ff-modal-title") as HTMLElement;
  const copy = layer.querySelector("#ff-modal-message") as HTMLElement;
  const disclosure = layer.querySelector("#ff-modal-details-wrap") as HTMLDetailsElement;
  const technicalCopy = layer.querySelector("#ff-modal-details") as HTMLElement;
  const actions = layer.querySelector("#ff-modal-actions") as HTMLElement;
  const acceptButton = layer.querySelector("#ff-modal-confirm") as HTMLButtonElement;

  const config = request.options;
  const destructive = request.kind === "confirm" && request.options.dangerous === true;
  const effectiveTone: FeedbackTone = request.kind === "alert"
    ? request.options.tone
    : (request.options.tone ?? (destructive ? "error" : "warning"));
  symbol.className = `ff-modal__icon ff-modal__icon--${effectiveTone}`;
  symbol.innerHTML = feedbackGlyphs[effectiveTone];
  panel.className = `ff-modal ff-modal--${effectiveTone}${destructive ? " ff-modal--danger" : ""}`;
  heading.textContent = config.title;
  copy.textContent = config.message;
  if (request.kind === "alert" && request.options.details) {
    disclosure.hidden = false;
    technicalCopy.textContent = request.options.details;
  } else {
    disclosure.hidden = true;
    technicalCopy.textContent = "";
  }

  let dismissButton = layer.querySelector("#ff-modal-cancel") as HTMLButtonElement | null;
  if (request.kind === "confirm" && !dismissButton) {
    dismissButton = document.createElement("button");
    dismissButton.type = "button";
    dismissButton.id = "ff-modal-cancel";
    dismissButton.className = "ghost-btn";
    actions.insertBefore(dismissButton, acceptButton);
  }
  if (request.kind === "alert") {
    dismissButton?.remove();
    acceptButton.textContent = config.confirmText ?? "知道了";
  } else {
    dismissButton!.textContent = request.options.cancelText ?? "取消";
    acceptButton.textContent = config.confirmText ?? "确定";
  }
  acceptButton.className = `btn-primary${destructive ? " btn-danger" : ""}`;
  layer.classList.remove("is-hidden");

  let completed = false;
  let release: (() => void) | null = null;
  function complete(result: boolean): void {
    if (completed) return;
    completed = true;
    release?.();
    acceptButton.removeEventListener("click", accept);
    dismissButton?.removeEventListener("click", dismiss);
    layer!.classList.add("is-hidden");
    completeQueuedRequest(request, () => {
      if (request.kind === "confirm") request.resolve(result);
      else request.resolve();
    });
  }
  const dismiss = () => complete(false);
  const accept = () => complete(request.kind === "confirm");
  dismissCurrentDialog = dismiss;
  acceptButton.addEventListener("click", accept);
  dismissButton?.addEventListener("click", dismiss);
  release = activateDialogFocus(panel, destructive ? dismissButton! : acceptButton, dismiss);
}

function ensureHtmlDialogLayer(): void {
  if (modalState.ffHtmlOverlay) return;
  modalState.ffHtmlOverlay = document.createElement("div");
  const layer = modalState.ffHtmlOverlay;
  layer.id = "ff-html-modal-overlay";
  layer.className = "ff-modal-overlay is-hidden";
  layer.innerHTML = `<div class="ff-modal ff-html-modal" role="dialog" aria-modal="true">
  <div class="ff-modal__head">
    <span class="ff-modal__icon" id="ff-html-modal-icon">📌</span>
    <h3 class="ff-modal__title" id="ff-html-modal-title">说明</h3>
  </div>
  <hr class="ff-modal__divider">
  <div class="ff-html-modal__body" id="ff-html-modal-body"></div>
  <div class="ff-modal__actions">
    <button type="button" class="btn-primary" id="ff-html-modal-confirm">知道了</button>
  </div>
</div>`;
  document.body.appendChild(layer);
}

function displayHtmlDialog(request: Extract<BlockingDialogRequest, { kind: "html" }>): void {
  ensureHtmlDialogLayer();
  const layer = modalState.ffHtmlOverlay;
  if (!layer) {
    console.error("[settings-feedback] 无法创建富文本弹窗容器");
    completeQueuedRequest(request, () => request.resolve());
    return;
  }
  const config = request.options;
  const symbol = layer.querySelector("#ff-html-modal-icon") as HTMLElement;
  const heading = layer.querySelector("#ff-html-modal-title") as HTMLElement;
  const content = layer.querySelector("#ff-html-modal-body") as HTMLElement;
  const acceptButton = layer.querySelector("#ff-html-modal-confirm") as HTMLButtonElement;
  const panel = layer.querySelector(".ff-modal") as HTMLElement;
  symbol.innerHTML = config.icon || "📌";
  heading.textContent = config.title;
  content.innerHTML = config.htmlBody;
  acceptButton.textContent = config.confirmText || "知道了";
  layer.classList.remove("is-hidden");

  let completed = false;
  let release: (() => void) | null = null;
  const complete = () => {
    if (completed) return;
    completed = true;
    release?.();
    acceptButton.removeEventListener("click", complete);
    layer.classList.add("is-hidden");
    completeQueuedRequest(request, () => request.resolve());
  };
  dismissCurrentDialog = complete;
  acceptButton.addEventListener("click", complete);
  release = activateDialogFocus(panel, acceptButton, complete);
}

function ensureInputDialogLayer(): void {
  if (modalState.ffInputOverlay) return;
  modalState.ffInputOverlay = document.createElement("div");
  const layer = modalState.ffInputOverlay;
  layer.id = "ff-input-overlay";
  layer.className = "ff-modal-overlay is-hidden";
  layer.innerHTML = `<div class="ff-modal" role="dialog" aria-modal="true" style="width:min(420px,90vw);">
  <div class="ff-modal__head">
    <span class="ff-modal__icon" id="ff-input-icon">${pencilGlyph}</span>
    <h3 class="ff-modal__title" id="ff-input-title">请输入</h3>
  </div>
  <hr class="ff-modal__divider">
  <p class="ff-modal__body" id="ff-input-message"></p>
  <input type="text" id="ff-input-field" autocomplete="off" spellcheck="false" />
  <div class="ff-modal__actions">
    <button type="button" class="ghost-btn" id="ff-input-cancel">取消</button>
    <button type="button" class="btn-primary" id="ff-input-confirm">确定</button>
  </div>
</div>`;
  document.body.appendChild(layer);
}

function displayInputDialog(request: Extract<BlockingDialogRequest, { kind: "input" }>): void {
  ensureInputDialogLayer();
  const layer = modalState.ffInputOverlay;
  if (!layer) {
    console.error("[settings-feedback] 无法创建输入弹窗容器");
    completeQueuedRequest(request, () => request.resolve(null));
    return;
  }
  const config = request.options;
  const symbol = layer.querySelector("#ff-input-icon") as HTMLElement;
  const heading = layer.querySelector("#ff-input-title") as HTMLElement;
  const copy = layer.querySelector("#ff-input-message") as HTMLElement;
  const field = layer.querySelector("#ff-input-field") as HTMLInputElement;
  const dismissButton = layer.querySelector("#ff-input-cancel") as HTMLButtonElement;
  const acceptButton = layer.querySelector("#ff-input-confirm") as HTMLButtonElement;
  const panel = layer.querySelector(".ff-modal") as HTMLElement;
  if (config.icon && config.icon.startsWith("<svg")) symbol.innerHTML = config.icon;
  else symbol.innerHTML = pencilGlyph;
  heading.textContent = config.title;
  copy.textContent = config.message;
  field.value = config.defaultValue || "";
  field.placeholder = config.placeholder || "";
  dismissButton.textContent = config.cancelText || "取消";
  acceptButton.textContent = config.confirmText || "确定";
  layer.classList.remove("is-hidden");

  let completed = false;
  let release: (() => void) | null = null;
  const complete = (answer: string | null) => {
    if (completed) return;
    completed = true;
    release?.();
    dismissButton.removeEventListener("click", dismiss);
    acceptButton.removeEventListener("click", accept);
    field.removeEventListener("keydown", enter);
    layer.classList.add("is-hidden");
    completeQueuedRequest(request, () => request.resolve(answer));
  };
  const dismiss = () => complete(null);
  const accept = () => complete(field.value);
  const enter = (keyboard: KeyboardEvent) => {
    if (keyboard.key !== "Enter") return;
    keyboard.preventDefault();
    accept();
  };
  dismissCurrentDialog = dismiss;
  dismissButton.addEventListener("click", dismiss);
  acceptButton.addEventListener("click", accept);
  field.addEventListener("keydown", enter);
  release = activateDialogFocus(panel, field, dismiss);
}
