import "../ui/theme";
import { TOAST_MAX_VISIBLE, type ToastItem, type ToastPushPayload, type ToastTier } from "../../shared/toast-types";
import { resolveAsset } from "../../shared/renderer-base";
import actionSoundUrl from "./assets/toast-action.wav";
import notifySoundUrl from "./assets/toast-notify.wav";

const bridge = window.toast;
const container = document.getElementById("toast-stack");
type CardEntry = { item: ToastItem; el: HTMLElement; removalTimer: number | null };
const registry = new Map<string, CardEntry>();
const attentionAudio = new Audio(actionSoundUrl);
const notificationAudio = new Audio(notifySoundUrl);
function playSound(tier: ToastTier): void {
  const selected = tier === "action-pending" ? attentionAudio : notificationAudio;
  selected.currentTime = 0;
  void selected.play().catch(() => { /* 失败时维持现有流程。 */ });
}
function buildCard(item: ToastItem): HTMLElement {
  const card = document.createElement("article");
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
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "toast-card__close";
  dismiss.setAttribute("aria-label", "关闭提醒");
  dismiss.innerHTML = '<svg width="9" height="9" viewBox="0 0 9 9" fill="none" aria-hidden="true">'
    + '<line x1="2" y1="2" x2="7" y2="7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>'
    + '<line x1="7" y1="2" x2="2" y2="7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
  dismiss.addEventListener("click", (pointer) => { pointer.stopPropagation(); bridge?.dismissed(item.id); });
  card.append(emblem, content, dismiss);
  card.addEventListener("click", () => { bridge?.clicked(item.id); });
  return card;
}
function updateCardContent(el: HTMLElement, item: ToastItem): void {
  const heading = el.querySelector<HTMLElement>(".toast-card__title");
  if (heading !== null) heading.textContent = item.title;
  const description = el.querySelector<HTMLElement>(".toast-card__summary");
  if (description !== null) {
    description.textContent = item.summary ?? "";
    description.hidden = !item.summary;
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
    card.item = payload;
    updateCardContent(card.el, payload);
  } else {
    const element = buildCard(payload);
    registry.set(payload.id, { item: payload, el: element, removalTimer: null });
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
      registry.set(saved.id, { item: saved, el: buildCard(saved), removalTimer: null });
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
