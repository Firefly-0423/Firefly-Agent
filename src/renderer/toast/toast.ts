import "../ui/theme";
import { TOAST_MAX_VISIBLE, type ToastApprovalDetail, type ToastItem, type ToastPushPayload, type ToastRendererApi, type ToastTier } from "../../shared/toast-types";
import { resolveAsset } from "../../shared/renderer-base";
import actionSoundUrl from "./assets/toast-action.wav";
import notifySoundUrl from "./assets/toast-notify.wav";

const bridge: ToastRendererApi | undefined = window.toast;
const container = document.getElementById("toast-stack");
type ReviewUiState =
  | { phase: "idle" }
  | { phase: "inspecting" }
  | { phase: "error" }
  | { phase: "loaded"; detail: ToastApprovalDetail };
type CardEntry = {
  item: ToastItem;
  el: HTMLElement;
  removalTimer: number | null;
  approvalLocked: boolean;
  reviewState: ReviewUiState;
};
const registry = new Map<string, CardEntry>();
const attentionAudio = new Audio(actionSoundUrl);
const notificationAudio = new Audio(notifySoundUrl);
function isApprovalReminder(item: ToastItem): boolean {
  return item.kind === "approval" || Boolean(item.review);
}
function playSound(tier: ToastTier): void {
  const selected = tier === "action-pending" ? attentionAudio : notificationAudio;
  selected.currentTime = 0;
  void selected.play().catch(() => { /* 失败时维持现有流程。 */ });
}
function setApprovalButtonsDisabled(el: HTMLElement, disabled: boolean): void {
  el.querySelectorAll<HTMLButtonElement>(".toast-card__approve, .toast-card__deny").forEach((button) => {
    button.disabled = disabled;
  });
}
async function submitApprovalAction(entry: CardEntry, allowed: boolean): Promise<void> {
  if (entry.approvalLocked) return;
  const approvalId = entry.item.review?.approvalId;
  if (!approvalId) return;
  entry.approvalLocked = true;
  setApprovalButtonsDisabled(entry.el, true);
  try {
    if (!bridge) throw new Error("toast bridge unavailable");
    const result = await bridge.resolveApproval(approvalId, allowed);
    if (entry.item.review?.approvalId !== approvalId) return;
    if (!result?.ok) {
      entry.approvalLocked = false;
      entry.reviewState = { phase: "loaded", detail: { state: "expired", approvalId } };
      renderReviewSection(entry);
      relayout();
    }
  } catch {
    if (entry.item.review?.approvalId !== approvalId) return;
    entry.approvalLocked = false;
    setApprovalButtonsDisabled(entry.el, false);
  }
}
function buildActionButton(label: string, className: string, onClick: (pointer: MouseEvent) => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  button.addEventListener("click", (pointer) => {
    pointer.stopPropagation();
    onClick(pointer);
  });
  return button;
}
function buildApprovalActions(entry: CardEntry): HTMLElement {
  const actions = document.createElement("div");
  actions.className = "toast-card__actions";
  const approve = buildActionButton("批准", "toast-card__approve", () => {
    void submitApprovalAction(entry, true);
  });
  const deny = buildActionButton("拒绝", "toast-card__deny", () => {
    void submitApprovalAction(entry, false);
  });
  approve.disabled = entry.approvalLocked;
  deny.disabled = entry.approvalLocked;
  actions.append(approve, deny);
  return actions;
}
function appendReviewMeta(parent: HTMLElement, text: string): void {
  const row = document.createElement("div");
  row.className = "toast-card__review-meta";
  row.textContent = text;
  parent.append(row);
}
function buildReviewDetailBlock(detail: Exclude<ToastApprovalDetail, { state: "expired" }>): HTMLElement {
  const block = document.createElement("div");
  block.className = "toast-card__review-detail";
  if (detail.state === "pending") {
    appendReviewMeta(block, `所属会话：${detail.session.title || detail.session.id}`);
  } else if (detail.state === "runless") {
    appendReviewMeta(block, "所属会话：无所属会话");
  }
  if (detail.agentId) {
    appendReviewMeta(block, `发起伙伴：${detail.agentId}`);
  }
  appendReviewMeta(block, `工具：${detail.toolName}`);
  if (detail.args.length > 0) {
    const argsList = document.createElement("div");
    argsList.className = "toast-card__review-args";
    for (const arg of detail.args) {
      const row = document.createElement("div");
      row.className = "toast-card__review-arg";
      const key = document.createElement("span");
      key.className = "toast-card__review-arg-key";
      key.textContent = arg.key;
      const value = document.createElement("span");
      value.className = "toast-card__review-arg-value";
      value.textContent = arg.value;
      row.append(key, value);
      argsList.append(row);
    }
    block.append(argsList);
  }
  return block;
}
function buildReviewNotice(text: string): HTMLElement {
  const notice = document.createElement("div");
  notice.className = "toast-card__review-notice";
  notice.textContent = text;
  return notice;
}
async function inspectReview(entry: CardEntry): Promise<void> {
  if (entry.reviewState.phase === "inspecting") return;
  const approvalId = entry.item.review?.approvalId;
  if (!approvalId) return;
  entry.reviewState = { phase: "inspecting" };
  renderReviewSection(entry);
  relayout();
  try {
    if (!bridge) throw new Error("toast bridge unavailable");
    const detail = await bridge.inspectApproval(approvalId);
    if (entry.item.review?.approvalId !== approvalId) return;
    entry.approvalLocked = false;
    entry.reviewState = { phase: "loaded", detail };
    renderReviewSection(entry);
    relayout();
  } catch {
    if (entry.item.review?.approvalId !== approvalId) return;
    entry.reviewState = { phase: "error" };
    renderReviewSection(entry);
    relayout();
  }
}
function renderReviewSection(entry: CardEntry): void {
  const section = entry.el.querySelector<HTMLElement>(".toast-card__review");
  if (!section) return;
  section.replaceChildren();
  const state = entry.reviewState;
  if (state.phase === "idle" || state.phase === "inspecting") {
    const actions = document.createElement("div");
    actions.className = "toast-card__actions";
    const inspectButton = buildActionButton(
      state.phase === "inspecting" ? "正在核实…" : "查看审批",
      "toast-card__inspect",
      () => { void inspectReview(entry); },
    );
    inspectButton.disabled = state.phase === "inspecting";
    actions.append(inspectButton);
    section.append(actions);
    return;
  }
  if (state.phase === "error") {
    const actions = document.createElement("div");
    actions.className = "toast-card__actions";
    const retryButton = buildActionButton("查看审批", "toast-card__inspect", () => {
      void inspectReview(entry);
    });
    actions.append(retryButton);
    section.append(buildReviewNotice("暂时无法核实，请稍后再试"), actions);
    return;
  }
  const detail = state.detail;
  if (detail.state === "expired") {
    section.append(buildReviewNotice("审批已失效"));
    return;
  }
  section.append(buildReviewDetailBlock(detail));
  if (detail.state === "runless") {
    // 没有运行 ID 的审批：主进程确认不了它来自独立的审批入口，只显示，不在这里批准。
    section.append(buildReviewNotice("这项审批没有所属任务，无法确认来源，不能在这里批准"));
    return;
  }
  if (detail.state === "unverified") {
    const actions = document.createElement("div");
    actions.className = "toast-card__actions";
    const openChat = buildActionButton("打开聊天窗口", "toast-card__open-chat", () => {
      bridge?.clicked(entry.item.id);
    });
    actions.append(openChat);
    section.append(buildReviewNotice("无法核实这项审批属于哪个会话，不能在这里批准"), actions);
    return;
  }
  section.append(buildApprovalActions(entry));
}
function populateCard(entry: CardEntry): HTMLElement {
  const { item, el: card } = entry;
  card.className = `toast-card toast-card--${item.tier}`;
  card.dataset.id = item.id;
  const emblem = document.createElement("span");
  emblem.className = "toast-card__icon";
  const portrait = document.createElement("img");
  portrait.src = resolveAsset("avatars/firefly-avatar.png");
  portrait.alt = "";
  portrait.draggable = false;
  emblem.appendChild(portrait);
  const content = document.createElement("div");
  content.className = "toast-card__body";
  const heading = document.createElement("div");
  heading.className = "toast-card__title";
  heading.textContent = item.title;
  const description = document.createElement("div");
  description.className = "toast-card__summary";
  description.textContent = item.summary ?? "";
  if (!item.summary) description.hidden = true;
  content.append(heading, description);
  if (item.review) {
    card.classList.add("toast-card--review");
    const reviewSection = document.createElement("div");
    reviewSection.className = "toast-card__review";
    content.append(reviewSection);
    card.append(emblem, content);
    card.addEventListener("click", () => { bridge?.clicked(entry.item.id); });
    renderReviewSection(entry);
    return card;
  }
  if (isApprovalReminder(item)) {
    card.classList.add("toast-card--approval");
    card.append(emblem, content);
    card.addEventListener("click", () => { bridge?.clicked(entry.item.id); });
    return card;
  }
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "toast-card__close";
  dismiss.setAttribute("aria-label", "关闭提醒");
  dismiss.innerHTML = '<svg width="9" height="9" viewBox="0 0 9 9" fill="none" aria-hidden="true">'
    + '<line x1="2" y1="2" x2="7" y2="7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>'
    + '<line x1="7" y1="2" x2="2" y2="7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
  dismiss.addEventListener("click", (pointer) => { pointer.stopPropagation(); bridge?.dismissed(entry.item.id); });
  card.append(emblem, content, dismiss);
  card.addEventListener("click", () => { bridge?.clicked(entry.item.id); });
  return card;
}
function createCardEntry(item: ToastItem): CardEntry {
  const entry: CardEntry = {
    item,
    el: document.createElement("article"),
    removalTimer: null,
    approvalLocked: false,
    reviewState: { phase: "idle" },
  };
  populateCard(entry);
  return entry;
}
function updateCardContent(entry: CardEntry, prevItem: ToastItem): void {
  const { el, item } = entry;
  const prevShape = prevItem.review ? "review" : isApprovalReminder(prevItem) ? "bare-approval" : "standard";
  const nextShape = item.review ? "review" : isApprovalReminder(item) ? "bare-approval" : "standard";
  if (prevShape !== nextShape) {
    entry.approvalLocked = false;
    entry.reviewState = { phase: "idle" };
    const next = document.createElement("article");
    entry.el = next;
    populateCard(entry);
    el.replaceWith(next);
    return;
  }
  if (prevItem.review?.approvalId !== item.review?.approvalId) {
    entry.approvalLocked = false;
    entry.reviewState = { phase: "idle" };
    renderReviewSection(entry);
  }
  const heading = el.querySelector<HTMLElement>(".toast-card__title");
  if (heading !== null) heading.textContent = item.title;
  const description = el.querySelector<HTMLElement>(".toast-card__summary");
  if (description !== null) {
    description.textContent = item.summary ?? "";
    description.hidden = !item.summary;
  }
  if (item.review) {
    setApprovalButtonsDisabled(el, entry.approvalLocked);
  }
}
function cancelRemoval(entry: CardEntry): void {
  if (entry.removalTimer === null) return;
  window.clearTimeout(entry.removalTimer);
  entry.removalTimer = null;
  const card = entry.el;
  card.classList.remove("toast-card--leaving");
  card.style.height = "";
  card.style.marginBottom = "";
}
function orderedEntries(): CardEntry[] {
  const groups: [CardEntry[], CardEntry[]] = [[], []];
  for (const card of registry.values()) groups[card.item.tier === "action-pending" ? 0 : 1].push(card);
  groups.forEach((group) => group.sort((left, right) => left.item.createdAt - right.item.createdAt));
  return groups[0].concat(groups[1]);
}
let reportedHeight = 0;
function reportHeight(): void {
  if (!container) return;
  const measured = container.scrollHeight;
  if (measured === reportedHeight) return;
  reportedHeight = measured;
  bridge?.reportHeight(measured);
}
function relayout(): void {
  if (!container) return;
  const sorted = orderedEntries();
  for (const card of sorted) container.appendChild(card.el);
  if (sorted.length > TOAST_MAX_VISIBLE) {
    let needed = 28;
    for (let ordinal = 0; ordinal < TOAST_MAX_VISIBLE; ordinal++) needed += sorted[ordinal].el.offsetHeight + 12;
    container.style.maxHeight = `${needed - 12}px`;
  } else container.style.maxHeight = "";
  reportHeight();
}
function push(payload: ToastPushPayload): void {
  if (!container) return;
  const card = registry.get(payload.id);
  if (card) {
    cancelRemoval(card);
    const prevItem = card.item;
    card.item = payload;
    updateCardContent(card, prevItem);
  } else {
    registry.set(payload.id, createCardEntry(payload));
  }
  if (payload.sound) playSound(payload.tier);
  relayout();
}
function remove(id: string): void {
  if (!container) return;
  const card = registry.get(id);
  if (!card || card.removalTimer !== null) return;
  const element = card.el;
  element.style.height = `${element.offsetHeight}px`;
  void element.offsetHeight;
  element.classList.add("toast-card--leaving");
  element.style.height = "0";
  element.style.marginBottom = `-${12}px`;
  card.removalTimer = window.setTimeout(() => {
    card.removalTimer = null;
    registry.delete(id);
    element.remove();
    relayout();
  }, 220);
}
async function restore(): Promise<void> {
  if (!container || !bridge) return;
  try {
    const snapshot = await bridge.getAll();
    for (const saved of snapshot) {
      if (registry.has(saved.id)) continue;
      registry.set(saved.id, createCardEntry(saved));
    }
    relayout();
  } catch { /* 失败时维持现有流程。 */ }
}
function main(): void {
  if (!container) return;
  bridge?.onPush(push);
  bridge?.onRemove(remove);
  new ResizeObserver(() => relayout()).observe(container);
  void restore();
}
main();
