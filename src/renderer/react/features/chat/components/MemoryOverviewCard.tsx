// 概览里的“记忆”卡片：只有类别和数量（记忆原文留在设置窗口），画成一张静态小图，点按钮打开设置里的完整关系图。
import { useEffect, useState } from "react";
import type { MemoryGraphSummary } from "../../../../../shared/memory-panel-contracts";
import { MEMORY_GRAPH_CATEGORY_RGB } from "../../../../../shared/memory-graph-categories";
import { useTranslation } from "../../../i18n";

/** Read again when a run ends (busy → false): a run is where memories are learned. */
export function useMemorySummary(busy: boolean | undefined): MemoryGraphSummary | null {
  const [summary, setSummary] = useState<MemoryGraphSummary | null>(null);
  useEffect(() => {
    if (busy) return;
    const load = window.memoryPanel?.graphSummary;
    if (!load) return;
    let active = true;
    load().then((value) => { if (active) setSummary(value); }).catch(() => {});
    return () => { active = false; };
  }, [busy]);
  return summary;
}

export function memorySummaryTotals(summary: MemoryGraphSummary | null): { facts: number; pending: number } {
  return (summary?.categories ?? []).reduce((sum, item) => ({ facts: sum.facts + item.facts, pending: sum.pending + item.pending }), { facts: 0, pending: 0 });
}

/** You in the middle, one dot per category around you sized by how much it holds; pending ones as a ring. */
function MiniGraph({ summary }: { summary: MemoryGraphSummary }) {
  const width = 220, height = 120, cx = width / 2, cy = height / 2, ring = 42;
  const items = summary.categories.filter((item) => item.facts + item.pending > 0);
  return (
    <svg className="ff-memory-mini" viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      {items.map((item, index) => {
        const angle = -Math.PI / 2 + (index / items.length) * Math.PI * 2;
        const x = cx + Math.cos(angle) * ring * 1.6, y = cy + Math.sin(angle) * ring;
        const r = 5 + Math.sqrt(item.facts + item.pending) * 2.5, rgb = MEMORY_GRAPH_CATEGORY_RGB[item.key] ?? MEMORY_GRAPH_CATEGORY_RGB.other;
        return (
          <g key={item.key}>
            <line x1={cx} y1={cy} x2={x} y2={y} style={{ stroke: `rgb(${rgb} / .4)` }} />
            <circle cx={x} cy={y} r={r} style={{ fill: item.facts > 0 ? `rgb(${rgb} / .85)` : "transparent", stroke: `rgb(${rgb})` }}
              strokeDasharray={item.facts > 0 ? undefined : "3 2"} />
          </g>
        );
      })}
      <circle className="ff-memory-mini__self" cx={cx} cy={cy} r={11} />
    </svg>
  );
}

export function MemoryCardBody({ summary, onOpenGraph }: { summary: MemoryGraphSummary | null; onOpenGraph?: () => void }) {
  const { t } = useTranslation();
  const totals = memorySummaryTotals(summary);
  if (!summary?.available) return <p className="ff-overview-card__empty">{t("sessionOverview.memoryUnavailable")}</p>;
  if (!totals.facts && !totals.pending) return <p className="ff-overview-card__empty">{t("sessionOverview.memoryEmpty")}</p>;
  return (
    <>
      <MiniGraph summary={summary} />
      <ul className="ff-memory-mini__legend">
        {summary.categories.filter((item) => item.facts + item.pending > 0).map((item) => (
          <li key={item.key}>
            <span className="ff-memory-mini__dot" style={{ background: `rgb(${MEMORY_GRAPH_CATEGORY_RGB[item.key] ?? MEMORY_GRAPH_CATEGORY_RGB.other})` }} aria-hidden="true" />
            <span className="ff-memory-mini__name">{t(`sessionOverview.memoryCategory.${item.key}`)}</span>
            <span className="ff-memory-mini__count">
              {item.facts}{item.pending > 0 ? ` · ${t("sessionOverview.memoryPending", { count: item.pending })}` : ""}
            </span>
          </li>
        ))}
      </ul>
      <p className="ff-overview-card__note">{t("sessionOverview.memorySources", { count: summary.sources })}</p>
      {onOpenGraph && <button type="button" className="ff-memory-mini__open" onClick={onOpenGraph}>{t("sessionOverview.memoryOpen")}</button>}
    </>
  );
}
