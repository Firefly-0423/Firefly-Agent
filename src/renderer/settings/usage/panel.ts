// 设置 → 用量：按模型 / 按功能的每日堆叠柱状图（7 / 30 天）、图例占比、聊天用量排行，
// 以及消息、技能、插件三条折线。数据来自主进程的 tokenUsage.history；图用手写 SVG，跟随主题色，不依赖图表库。

import type { UsageHistoryView } from "../../../shared/usage-history";
import { t } from "../i18n";
import { showConfirm } from "../shared/modal";
import { formatTokens, legendRows, niceMax, stackSegments, type LegendRow } from "./format";

export interface UsageBridge {
  history?: (days: number) => Promise<UsageHistoryView>;
  clear?: () => Promise<void>;
}

type RangeDays = 7 | 30;
type Dimension = "model" | "feature";

/** 记录功能维度之前的用量在"按功能"里归到这一类。 */
const EARLIER = "__earlier";
const SVG_NS = "http://www.w3.org/2000/svg";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
  return node;
}

function featureLabel(id: string): string {
  if (id === EARLIER) return t("settings.usage.earlier");
  const key = `settings.usage.feature.${id}`;
  const label = t(key);
  return label === key ? id : label;
}

function categoryLabel(dimension: Dimension, row: LegendRow): string {
  if (row.isOther) return t("settings.usage.other");
  return dimension === "feature" ? featureLabel(row.name) : row.name;
}

function segmented(label: string, name: string, options: Array<{ value: string; text: string }>, current: string): HTMLElement {
  const group = el("div", "usage-seg");
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", label);
  for (const option of options) {
    const button = el("button", "usage-seg__item", option.text);
    button.type = "button";
    button.dataset[name] = option.value;
    button.setAttribute("aria-pressed", String(option.value === current));
    group.append(button);
  }
  return group;
}

/** 每日堆叠柱状图；每个柱段带原生提示（日期、分类、用量）。 */
function stackedChart(history: UsageHistoryView, dimension: Dimension, legend: LegendRow[]): SVGSVGElement {
  const width = 640, height = 220, left = 44, right = 8, top = 10, bottom = 26;
  const chart = svg("svg", { viewBox: `0 0 ${width} ${height}`, class: "usage-stack", role: "img", "aria-label": t("settings.usage.chartLabel") });
  const byDay = history.days.map(day => ({ day, segments: stackSegments(dimension === "model" ? day.byModel : dayFeatures(day), legend) }));
  const max = niceMax(Math.max(...byDay.map(entry => entry.segments.reduce((sum, segment) => sum + segment.tokens, 0)), 0));
  const plotHeight = height - top - bottom;
  for (let tick = 0; tick <= 4; tick += 1) {
    const y = top + plotHeight - (plotHeight * tick) / 4;
    chart.append(svg("line", { x1: left, x2: width - right, y1: y, y2: y, class: "usage-stack__grid" }));
    const label = svg("text", { x: left - 6, y: y + 4, class: "usage-stack__tick", "text-anchor": "end" });
    label.textContent = formatTokens((max * tick) / 4);
    chart.append(label);
  }
  const slot = (width - left - right) / Math.max(1, byDay.length);
  const barWidth = Math.min(36, slot * 0.62);
  const labelEvery = byDay.length > 14 ? 5 : 1;
  byDay.forEach(({ day, segments }, index) => {
    const x = left + slot * index + (slot - barWidth) / 2;
    let filled = 0;
    for (const segment of segments) {
      const segmentHeight = (segment.tokens / max) * plotHeight;
      filled += segmentHeight;
      const rect = svg("rect", { x, y: top + plotHeight - filled, width: barWidth, height: Math.max(segmentHeight, 0.5), fill: segment.color, rx: 1.5, class: "usage-stack__segment" });
      const name = dimension === "feature" ? featureLabel(segment.name || "") : segment.name;
      const title = svg("title");
      title.textContent = `${day.date} ${day.weekday} · ${segment.name ? name : t("settings.usage.other")} · ${formatTokens(segment.tokens)}`;
      rect.append(title);
      chart.append(rect);
    }
    if (index % labelEvery === 0 || index === byDay.length - 1) {
      const label = svg("text", { x: x + barWidth / 2, y: height - 8, class: "usage-stack__tick", "text-anchor": "middle" });
      label.textContent = day.date;
      chart.append(label);
    }
  });
  return chart;
}

/** 当天的功能分布；记录功能之前的用量（总量减去已归因部分）归入"此前未归类"。 */
function dayFeatures(day: UsageHistoryView["days"][number]): Record<string, number> {
  const attributed = Object.values(day.byFeature).reduce((sum, value) => sum + value, 0);
  const earlier = day.tokens - attributed;
  return earlier > 0 ? { ...day.byFeature, [EARLIER]: earlier } : day.byFeature;
}

/** 折线：每天一个点，下方轻轻填充；全 0 时只画基线。 */
/** Each trend card has its own hue (messages, skills, plugins), so the three read apart at a glance. */
export type TrendTone = "messages" | "skills" | "plugins";
let gradientSeq = 0;

/**
 * A smooth path through the points: monotone cubic (Fritsch–Carlson), so the curve never overshoots below zero or
 * above a peak the way a plain spline would.
 */
export function smoothPath(points: ReadonlyArray<readonly [number, number]>): string {
  if (points.length < 2) return "";
  const n = points.length;
  const dx = points.slice(1).map(([x], i) => x - points[i]![0]);
  const slope = points.slice(1).map(([, y], i) => (y - points[i]![1]) / (dx[i] || 1));
  const tangent = points.map((_, i) => i === 0 ? slope[0]! : i === n - 1 ? slope[n - 2]!
    : slope[i - 1]! * slope[i]! <= 0 ? 0 : (slope[i - 1]! + slope[i]!) / 2);
  for (let i = 0; i < n - 1; i += 1) {
    if (slope[i] === 0) { tangent[i] = 0; tangent[i + 1] = 0; continue; }
    const a = tangent[i]! / slope[i]!, b = tangent[i + 1]! / slope[i]!, h = Math.hypot(a, b);
    if (h > 3) { tangent[i] = (3 / h) * a * slope[i]!; tangent[i + 1] = (3 / h) * b * slope[i]!; }
  }
  const f = (value: number) => value.toFixed(1);
  let d = `M${f(points[0]![0])},${f(points[0]![1])}`;
  for (let i = 0; i < n - 1; i += 1) {
    const [x0, y0] = points[i]!, [x1, y1] = points[i + 1]!, third = dx[i]! / 3;
    d += ` C${f(x0 + third)},${f(y0 + tangent[i]! * third)} ${f(x1 - third)},${f(y1 - tangent[i + 1]! * third)} ${f(x1)},${f(y1)}`;
  }
  return d;
}

/** Trend line: a smooth curve in the card's hue over a soft gradient, a faint baseline, and a dot on the latest day. */
function lineChart(values: number[], tone: TrendTone): SVGSVGElement {
  const width = 280, height = 72, pad = 5;
  const chart = svg("svg", { viewBox: `0 0 ${width} ${height}`, class: `usage-line usage-line--${tone}`, role: "img", "aria-label": t("settings.usage.chartLabel"), preserveAspectRatio: "none" });
  const base = height - pad;
  chart.append(svg("line", { x1: pad, x2: width - pad, y1: base, y2: base, class: "usage-line__base" }));
  if (values.length < 2) return chart;
  const max = Math.max(...values, 1);
  const step = (width - pad * 2) / (values.length - 1);
  const points = values.map((value, index) => [pad + step * index, base - (value / max) * (height - pad * 2)] as const);
  const id = `usage-line-fill-${(gradientSeq += 1)}`;
  const gradient = svg("linearGradient", { id, x1: 0, y1: 0, x2: 0, y2: 1 });
  gradient.append(svg("stop", { offset: "0%", class: "usage-line__fill-top" }), svg("stop", { offset: "100%", class: "usage-line__fill-bottom" }));
  const defs = svg("defs");
  defs.append(gradient);
  const curve = smoothPath(points);
  const last = points[points.length - 1]!;
  chart.append(defs,
    svg("path", { d: `${curve} L${last[0].toFixed(1)},${base} L${pad},${base} Z`, class: "usage-line__area", fill: `url(#${id})` }),
    svg("path", { d: curve, class: "usage-line__stroke", fill: "none" }));
  // The chart stretches to the card's width, so a <circle> would turn into an oval; a zero-length stroke with a round
  // cap and a non-scaling width stays a round dot.
  if (values.some(value => value > 0)) chart.append(svg("path", { d: `M${last[0].toFixed(1)},${last[1].toFixed(1)} h0`, class: "usage-line__dot" }));
  return chart;
}

function card(title: string, summary?: string): { root: HTMLElement; body: HTMLElement } {
  const root = el("section", "usage-card");
  const head = el("header", "usage-card__head");
  head.append(el("h2", "usage-card__title", title));
  if (summary) head.append(el("span", "usage-card__summary", summary));
  const body = el("div", "usage-card__body");
  root.append(head, body);
  return { root, body };
}

function trendCard(title: string, values: number[], names: Array<{ id: string; count: number }>, tone: TrendTone): HTMLElement {
  const total = values.reduce((sum, value) => sum + value, 0);
  const { root, body } = card(title, total.toLocaleString());
  root.classList.add("usage-card--trend", `usage-card--${tone}`);
  body.append(lineChart(values, tone));
  if (names.length > 0) {
    const list = el("ul", "usage-top");
    for (const item of names.slice(0, 3)) {
      const row = el("li", "usage-top__row");
      row.append(el("span", "usage-top__name", item.id), el("span", "usage-top__count", item.count.toLocaleString()));
      list.append(row);
    }
    body.append(list);
  }
  return root;
}

function render(root: HTMLElement, history: UsageHistoryView, range: RangeDays, dimension: Dimension, hasClear: boolean): void {
  root.replaceChildren();
  const toolbar = el("div", "usage-toolbar");
  toolbar.append(
    segmented(t("settings.usage.rangeLabel"), "range", [{ value: "7", text: t("settings.usage.days7") }, { value: "30", text: t("settings.usage.days30") }], String(range)),
    segmented(t("settings.usage.dimensionLabel"), "dimension", [{ value: "model", text: t("settings.usage.byModel") }, { value: "feature", text: t("settings.usage.byFeature") }], dimension),
  );
  if (hasClear) {
    const clear = el("button", "usage-clear", t("settings.usage.clear"));
    clear.type = "button";
    clear.dataset.action = "clear";
    toolbar.append(clear);
  }
  root.append(toolbar);

  // Token usage: stacked bars + a legend with each category's share.
  const items = dimension === "model"
    ? history.models.map(item => ({ name: item.name, tokens: item.tokens }))
    : (() => {
      const attributed = history.features.map(item => ({ name: item.name, tokens: item.tokens }));
      const earlier = history.days.reduce((sum, day) => sum + Math.max(0, day.tokens - Object.values(day.byFeature).reduce((inner, value) => inner + value, 0)), 0);
      return earlier > 0 ? [...attributed, { name: EARLIER, tokens: earlier }] : attributed;
    })();
  const legend = legendRows(items);
  const totalTokens = history.days.reduce((sum, day) => sum + day.tokens, 0);
  const totalRequests = history.days.reduce((sum, day) => sum + day.requests, 0);
  const usage = card(t("settings.usage.tokenTitle"), t("settings.usage.totals", { tokens: formatTokens(totalTokens), requests: totalRequests.toLocaleString() }));
  if (totalTokens <= 0) {
    usage.body.append(el("p", "usage-empty", t("settings.usage.empty")));
  } else {
    const row = el("div", "usage-chart-row");
    row.append(stackedChart(history, dimension, legend));
    const list = el("ul", "usage-legend");
    for (const entry of legend) {
      const item = el("li", "usage-legend__row");
      const dot = el("span", "usage-legend__dot");
      dot.style.background = entry.color;
      item.append(dot, el("span", "usage-legend__name", categoryLabel(dimension, entry)), el("span", "usage-legend__tokens", formatTokens(entry.tokens)), el("span", "usage-legend__share", `${entry.share}%`));
      list.append(item);
    }
    row.append(list);
    usage.body.append(row);
    if (dimension === "feature" && history.features.length === 0) usage.body.append(el("p", "usage-note", t("settings.usage.featureNote")));
  }
  root.append(usage.root);

  // Conversation ranking.
  const ranking = card(t("settings.usage.rankTitle"));
  if (history.sessions.length === 0) {
    ranking.body.append(el("p", "usage-empty", t("settings.usage.rankEmpty")));
  } else {
    const biggest = history.sessions[0]!.tokens;
    const list = el("ol", "usage-rank");
    for (const session of history.sessions) {
      const row = el("li", "usage-rank__row");
      const bar = el("span", "usage-rank__bar");
      bar.style.width = `${Math.max(2, Math.round((session.tokens / biggest) * 100))}%`;
      const name = el("span", "usage-rank__name", session.title ?? t("settings.usage.sessionGone"));
      name.title = session.title ?? session.id;
      row.append(bar, name, el("span", "usage-rank__feature", featureLabel(session.feature)), el("span", "usage-rank__tokens", formatTokens(session.tokens)));
      list.append(row);
    }
    ranking.body.append(list);
  }
  root.append(ranking.root);

  // Messages, skills and plugins over the same range.
  const trio = el("div", "usage-trio");
  trio.append(
    trendCard(t("settings.usage.messages"), history.days.map(day => day.messages), [], "messages"),
    trendCard(t("settings.usage.skills"), history.days.map(day => day.skillCalls), history.skills, "skills"),
    trendCard(t("settings.usage.plugins"), history.days.map(day => day.pluginCalls), history.plugins, "plugins"),
  );
  root.append(trio);
}

interface PanelState {
  bridge: UsageBridge;
  range: RangeDays;
  dimension: Dimension;
  loaded: UsageHistoryView | null;
  generation: number;
}

/** One state per panel root, so the single click listener always sees the latest bridge and choices. */
const states = new WeakMap<HTMLElement, PanelState>();

function draw(root: HTMLElement, state: PanelState, focus?: string): void {
  if (!state.loaded) return;
  render(root, state.loaded, state.range, state.dimension, Boolean(state.bridge.clear));
  if (focus) root.querySelector<HTMLElement>(focus)?.focus();
}

async function load(root: HTMLElement, state: PanelState, focus?: string): Promise<void> {
  const mine = ++state.generation;
  root.setAttribute("aria-busy", "true");
  try {
    const history = await state.bridge.history!(state.range);
    if (states.get(root) !== state || mine !== state.generation) return;
    state.loaded = history;
    draw(root, state, focus);
  } catch {
    if (states.get(root) === state && mine === state.generation) root.replaceChildren(el("p", "usage-empty", t("settings.usage.loadFailed")));
  } finally {
    if (states.get(root) === state && mine === state.generation) root.removeAttribute("aria-busy");
  }
}

function bind(root: HTMLElement): void {
  root.addEventListener("click", event => {
    const state = states.get(root);
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-range], [data-dimension], [data-action]");
    if (!state || !target) return;
    if (target.dataset.range) {
      const next = Number(target.dataset.range) as RangeDays;
      if (next !== state.range) { state.range = next; void load(root, state, `[data-range="${next}"]`); }
    } else if (target.dataset.dimension) {
      state.dimension = target.dataset.dimension as Dimension;
      draw(root, state, `[data-dimension="${state.dimension}"]`);
    } else if (target.dataset.action === "clear") {
      void (async () => {
        const confirmed = await showConfirm({
          title: t("settings.usage.clearTitle"),
          message: t("settings.usage.clearMessage"),
          confirmText: t("settings.usage.clear"),
          cancelText: t("settings.usage.cancel"),
          dangerous: true,
        });
        if (!confirmed) return;
        await state.bridge.clear?.();
        await load(root, state);
      })();
    }
  });
}

/** 打开用量页：每次进入都重新读取，不显示过期数据；切换时间范围或维度只重画。 */
export async function loadUsagePanel(root: HTMLElement, bridge: UsageBridge): Promise<void> {
  if (!bridge.history) {
    root.replaceChildren(el("p", "usage-empty", t("settings.usage.unavailable")));
    return;
  }
  if (!states.has(root)) bind(root);
  const state: PanelState = { bridge, range: 7, dimension: "model", loaded: null, generation: (states.get(root)?.generation ?? 0) + 1 };
  states.set(root, state);
  await load(root, state);
}
