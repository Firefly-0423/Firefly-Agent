// 设置页搜索：按标题和说明查找所有设置项。每次输入时直接扫描当前 DOM，
// 这样动态生成的行（模型服务商、插件卡片等）和当前界面语言的文字都是最新的。
import { t } from "../i18n";

export interface SearchEntry {
  section: string;
  pageTitle: string;
  title: string;
  description: string;
  /** 整行文字（含选项标签），只用来匹配，不显示。 */
  text: string;
  element: HTMLElement;
  /** 整个页面本身（点击后只切页，不高亮某一行）。 */
  page: boolean;
}

const ROW_SELECTOR = ".setting-row, .agent-routing-row, .settings-group-title, .plugin-card, .agent-setting-card, .scheduler-card, .channels-card, .settings-list > .field";
const MAX_DESCRIPTION = 160;
const MAX_TEXT = 600;
const DESCRIPTION_SELECTOR = ":scope > div:first-child > span, :scope > p, :scope > div > p, .agent-routing-intro, .field-hint, .form-hint, .panel-hint";
export const MAX_RESULTS = 40;

const clean = (text: string | null | undefined): string => (text ?? "").replace(/\s+/g, " ").trim();

/** 标题：优先取行内的 strong / 标题元素；字段行取第一个 span。 */
function titleOf(element: HTMLElement): string {
  if (element.matches(".settings-group-title")) return clean(element.textContent);
  const heading = element.querySelector<HTMLElement>("strong, h3, h2, legend");
  if (heading) return clean(heading.textContent);
  if (element.matches(".field")) return clean(element.querySelector(":scope > span")?.textContent);
  return "";
}

/** 说明：行里“标题下面那一行”，卡片和字段里的第一段提示。不要把整张卡片的文字都当说明。 */
function descriptionOf(element: HTMLElement, title: string): string {
  for (const candidate of element.querySelectorAll<HTMLElement>(DESCRIPTION_SELECTOR)) {
    const text = clean(candidate.textContent);
    if (text && text !== title) return text.slice(0, MAX_DESCRIPTION);
  }
  return "";
}

/** 条件显示的内容（带 hidden 或 is-hidden 的祖先，不含页面本身）搜到了也跳不过去，所以不收录。 */
function visibleWithin(element: HTMLElement, panel: HTMLElement): boolean {
  for (let node: HTMLElement | null = element; node && node !== panel; node = node.parentElement) {
    if (node.hidden || node.classList.contains("is-hidden")) return false;
  }
  return true;
}

export function collectSettingsEntries(root: ParentNode, buttons: readonly HTMLButtonElement[]): SearchEntry[] {
  const entries: SearchEntry[] = [];
  for (const button of buttons) {
    const section = button.dataset.section;
    const controls = button.getAttribute("aria-controls");
    const panel = controls ? root.querySelector<HTMLElement>(`[id="${controls}"]`) : null;
    if (!section || !panel) continue;
    const pageTitle = clean(button.querySelector("span:last-child")?.textContent ?? button.textContent);
    const pageDescription = clean(panel.querySelector(".panel-heading p, .plugin-panel-heading p, :scope > .panel-hint")?.textContent).slice(0, MAX_DESCRIPTION);
    entries.push({ section, pageTitle, title: pageTitle, description: pageDescription, text: pageDescription, element: panel, page: true });
    for (const element of panel.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
      const title = titleOf(element);
      if (!title || !visibleWithin(element, panel)) continue;
      entries.push({ section, pageTitle, title, description: descriptionOf(element, title), text: clean(element.textContent).slice(0, MAX_TEXT), element, page: false });
    }
  }
  return entries;
}

/** 空格分隔的每个词都要出现；标题命中最优先，其次页面名、说明，最后是整行文字。 */
export function searchEntries(entries: readonly SearchEntry[], query: string, limit = MAX_RESULTS): SearchEntry[] {
  const tokens = clean(query).toLowerCase().split(" ").filter(Boolean);
  if (tokens.length === 0) return [];
  const scored: Array<{ entry: SearchEntry; score: number; order: number }> = [];
  entries.forEach((entry, order) => {
    const title = entry.title.toLowerCase(), page = entry.pageTitle.toLowerCase(), description = entry.description.toLowerCase(), text = entry.text.toLowerCase();
    let score = 0;
    for (const token of tokens) {
      const part = title.includes(token) ? 3 : page.includes(token) ? 2 : description.includes(token) ? 1 : text.includes(token) ? 0.5 : 0;
      if (part === 0) return;
      score += part;
    }
    scored.push({ entry, score: score + (entry.page ? 0.5 : 0), order });
  });
  return scored.sort((a, b) => b.score - a.score || a.order - b.order).slice(0, limit).map(item => item.entry);
}

export interface SettingsSearchOptions {
  root: ParentNode;
  nav: HTMLElement;
  input: HTMLInputElement;
  results: HTMLElement;
  status: HTMLElement;
  buttons: readonly HTMLButtonElement[];
  select: (section: string) => void;
}

export function mountSettingsSearch(options: SettingsSearchOptions): { refresh: () => void; clear: () => void; dispose: () => void } {
  const { root, nav, input, results, status, buttons, select } = options;
  let hitTimer: ReturnType<typeof setTimeout> | undefined;
  let hit: HTMLElement | undefined;

  const items = () => [...results.querySelectorAll<HTMLButtonElement>(".settings-search-result")];

  function setSearching(active: boolean): void {
    nav.classList.toggle("is-searching", active);
    results.hidden = !active;
    input.setAttribute("aria-expanded", String(active));
  }

  function render(): void {
    const query = input.value;
    if (!clean(query)) { results.replaceChildren(); setSearching(false); status.textContent = ""; return; }
    const found = searchEntries(collectSettingsEntries(root, buttons), query);
    results.replaceChildren();
    for (const entry of found) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "settings-search-result";
      item.setAttribute("role", "option");
      item.dataset.section = entry.section;
      const title = document.createElement("span");
      title.className = "settings-search-result__title";
      title.textContent = entry.title;
      const meta = document.createElement("span");
      meta.className = "settings-search-result__meta";
      meta.textContent = entry.page ? t("settings.search.page") : entry.pageTitle;
      item.append(title, meta);
      if (entry.description && !entry.page) {
        const description = document.createElement("span");
        description.className = "settings-search-result__desc";
        description.textContent = entry.description;
        item.append(description);
      }
      item.addEventListener("click", () => go(entry));
      results.append(item);
    }
    if (found.length === 0) {
      const empty = document.createElement("p");
      empty.className = "settings-search-empty";
      empty.textContent = t("settings.search.empty");
      results.append(empty);
    }
    status.textContent = found.length === 0 ? t("settings.search.empty") : t("settings.search.count", { count: found.length });
    setSearching(true);
  }

  function clearHit(): void {
    if (hitTimer) clearTimeout(hitTimer);
    hit?.classList.remove("is-search-hit");
    hit = undefined;
  }

  function go(entry: SearchEntry): void {
    clear();
    select(entry.section);
    if (entry.page) return;
    // 切页时显示/隐藏是同步完成的，scrollIntoView 会自己触发布局，不需要等下一帧。
    entry.element.scrollIntoView?.({ block: "center" });
    clearHit();
    hit = entry.element;
    hit.classList.add("is-search-hit");
    hitTimer = setTimeout(clearHit, 2000);
  }

  function clear(): void {
    input.value = "";
    render();
  }

  const onInput = () => render();
  const onInputKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") { if (input.value) { event.preventDefault(); clear(); } return; }
    if (event.key === "ArrowDown") { event.preventDefault(); items()[0]?.focus(); return; }
    if (event.key === "Enter") { event.preventDefault(); items()[0]?.click(); }
  };
  const onResultsKey = (event: KeyboardEvent) => {
    const list = items(), index = list.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown") { event.preventDefault(); list[Math.min(index + 1, list.length - 1)]?.focus(); }
    else if (event.key === "ArrowUp") { event.preventDefault(); (index <= 0 ? input : list[index - 1]).focus(); }
    else if (event.key === "Escape") { event.preventDefault(); clear(); input.focus(); }
  };
  // 在设置窗口里按 Ctrl+F / Ctrl+K 直接跳到搜索框；有弹窗时不抢焦点。
  const onGlobalKey = (event: KeyboardEvent) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || !["f", "k"].includes(event.key.toLowerCase())) return;
    // The shared dialogs stay in the DOM under an `is-hidden` overlay after they close; only an overlay that is showing blocks the shortcut.
    if (document.querySelector(".ff-modal-overlay:not(.is-hidden)")) return;
    event.preventDefault();
    input.focus();
    input.select();
  };

  input.addEventListener("input", onInput);
  input.addEventListener("keydown", onInputKey);
  results.addEventListener("keydown", onResultsKey);
  document.addEventListener("keydown", onGlobalKey);
  setSearching(false);

  return {
    refresh: render,
    clear,
    dispose() {
      clearHit();
      input.removeEventListener("input", onInput);
      input.removeEventListener("keydown", onInputKey);
      results.removeEventListener("keydown", onResultsKey);
      document.removeEventListener("keydown", onGlobalKey);
    },
  };
}
