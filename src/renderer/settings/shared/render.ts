import { escapeHtml } from "./format";

const EMPTY_LIST_ICON = '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>';

export function renderEmptyState(container: HTMLElement | null, title: string, hint: string): void {
  if (!container) return;
  const markup = `<div class="memory-list__empty">
  <span>${EMPTY_LIST_ICON}</span>
  <p>${escapeHtml(title)}</p>
  <p class="memory-list__hint">${escapeHtml(hint)}</p>
</div>`;
  container.innerHTML = markup;
}

export function renderInfoList(container: HTMLElement | null, items: Array<{ title: string; body: string; meta?: string }>, emptyTitle: string, emptyHint: string): void {
  if (!container) return;
  if (items.length === 0) return renderEmptyState(container, emptyTitle, emptyHint);

  const records = items.map((entry) => {
    const metadata = entry.meta ? `<p class="memory-record__meta">${escapeHtml(entry.meta)}</p>` : "";
    return `<article class="memory-record">
  <h3 class="memory-record__title">${escapeHtml(entry.title)}</h3>
  <p class="memory-record__body">${escapeHtml(entry.body)}</p>
  ${metadata}
</article>`;
  });
  container.innerHTML = records.join("\n");
}
