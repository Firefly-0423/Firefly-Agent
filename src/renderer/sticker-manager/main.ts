import "../ui/base.css";
import "./style.css";
import "../ui/theme";
import { resolveAsset } from "../../shared/renderer-base";

import type { StickerConfigItem as StickerItem } from "../../shared/sticker-types";
import { FIREFLY_AUTO_STICKERS } from "../../shared/firefly-stickers";

const grid = document.getElementById("sticker-grid") as HTMLElement;
const minBtn = document.getElementById("min-btn") as HTMLButtonElement;
const closeBtn = document.getElementById("close-btn") as HTMLButtonElement;

const AUTO_IDS = new Set<string>(FIREFLY_AUTO_STICKERS.map(sticker => sticker.id));

/** Three groups: what Firefly sends by herself, what we can send from the chat box, and stickers added by hand. */
export function groupStickers(items: readonly StickerItem[]): { key: string; title: string; items: StickerItem[] }[] {
  return [
    { key: "auto", title: "流萤会自动发送", items: items.filter(item => AUTO_IDS.has(item.id)) },
    { key: "chat", title: "对话框里可以发送", items: items.filter(item => item.builtIn && !AUTO_IDS.has(item.id)) },
    { key: "mine", title: "自己添加的", items: items.filter(item => !item.builtIn) },
  ].filter(group => group.items.length > 0);
}

// Which groups are folded, remembered on this device; storage can be unavailable, so it only ever helps.
const FOLD_KEY = "firefly.stickerManager.folded";
const folded = new Set<string>((() => { try { return JSON.parse(localStorage.getItem(FOLD_KEY) ?? "[]") as string[]; } catch { return []; } })());
const saveFolded = () => { try { localStorage.setItem(FOLD_KEY, JSON.stringify([...folded])); } catch { /* not persisted */ } };
const CHEVRON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';

function render(items: StickerItem[]): void {
  grid.replaceChildren();
  for (const group of groupStickers(items)) {
    // The heading is the fold toggle: a chevron that turns a quarter, and the cards slide open (grid row 0fr → 1fr).
    const section = document.createElement("section");
    section.className = "sticker-section";
    section.dataset.group = group.key;
    section.toggleAttribute("data-open", !folded.has(group.key));
    const heading = document.createElement("button");
    heading.type = "button";
    heading.className = "sticker-group__title";
    heading.setAttribute("aria-expanded", String(!folded.has(group.key)));
    heading.innerHTML = CHEVRON;
    heading.append(`${group.title} · ${group.items.length}`);
    heading.addEventListener("click", () => {
      const open = folded.has(group.key);
      if (open) folded.delete(group.key); else folded.add(group.key);
      saveFolded();
      section.toggleAttribute("data-open", open);
      heading.setAttribute("aria-expanded", String(open));
    });
    const body = document.createElement("div");
    body.className = "sticker-section__body";
    const cards = document.createElement("div");
    cards.className = "sticker-group";
    for (const item of group.items) cards.appendChild(renderCard(item));
    body.appendChild(cards);
    section.append(heading, body);
    grid.appendChild(section);
  }
}

/** 创建元素；只有传入类名时才会写 class 属性。 */
function makeElement<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

/** 单张表情卡片：缩略图加一个启用开关；开关变化后用主进程返回的最新配置整体重绘。 */
function renderCard(item: StickerItem): HTMLElement {
  const card = makeElement("article", "sticker-card");
  card.classList.toggle("is-disabled", !item.enabled);

  const preview = makeElement("img");
  preview.src = item.src.startsWith("/stickers/") ? resolveAsset(item.src) : item.src;
  preview.alt = item.description || "";
  preview.draggable = false;

  const toggleLabel = makeElement("label", "mini-switch");
  const checkbox = makeElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = item.enabled;
  const track = makeElement("span", "mini-switch__track");
  track.appendChild(makeElement("span", "mini-switch__thumb"));
  toggleLabel.append(checkbox, track);

  checkbox.addEventListener("change", async () => {
    const next = await window.stickerManager?.setEnabled(item.id, checkbox.checked);
    if (next) render(next);
  });

  card.append(preview, toggleLabel);
  return card;
}

async function bootstrap(): Promise<void> {
  const items = await window.stickerManager?.getConfig();
  render(items ?? []);
}

minBtn.addEventListener("click", () => window.stickerManager?.minimize());
closeBtn.addEventListener("click", () => window.stickerManager?.close());
void bootstrap();
