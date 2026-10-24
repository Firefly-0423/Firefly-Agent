// RightInspector — 右侧面板，参照 Claude 桌面版：
// - 打开的项（浏览器、文件、文件预览、改动、任务……）是大面板，默认横向并列，中间的分隔条可以拖动调宽（或用方向键）；
// - 按住面板标题栏，整块面板跟着鼠标走，其余面板实时滑到放下后的位置（左右并列或上下叠放）；Alt+方向键也能挪；
// - 打开/关闭由主区标题行的图标开关负责，这里没有标签条。标题行：图标、名称、状态 ··· 放大、关闭。
// 放大时其余大面板隐藏（保持挂载，浏览器等状态不丢）；关闭后的焦点回退仍由上层 ChatPage 决定。
// 浏览器面板里是原生视图，会盖住页面：拖动期间先把它的内容区收起（它自己遇到零尺寸就会隐藏原生视图），松手后复原。

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { File, FileDiff, FileOutput, Files, FolderTree, GitCompareArrows, Globe, ListChecks, Maximize2, Minimize2, SquareTerminal, X } from "lucide-react";
import { useTranslation } from "../../../i18n";
import { DRAG_DEAD_ZONE } from "./reorder-list";
import { dropZoneAt, movePanel, reconcileColumns, gridPlacement, MIN_COLUMN_WIDTH, resizeColumns, resizeRows, shiftPanel, type DropZone, type PanelColumn, dockEdge, edgeGuideBox } from "./panel-layout";
import "./RightInspector.css";

export interface InspectorTab {
  id: string;
  label: string;
  /** Full path/context for tabs that share the same visible basename. */
  title?: string;
  kind?: "files" | "file" | "diff" | "browser" | "tasks" | "plan" | "result" | "changes" | "outputs";
  status?: ReactNode;
  /** 阶段色点 class（如 is-review / is-executing / is-completed），不传则不显示 */
  dotClass?: string;
  /** 是否允许关闭；不传默认可关 */
  closable?: boolean;
  content: ReactNode;
}

const tabIcons = { files: FolderTree, file: File, diff: GitCompareArrows, browser: Globe, tasks: SquareTerminal, plan: ListChecks, result: Files, changes: FileDiff, outputs: FileOutput };

type Box = { left: number; top: number; width: number; height: number };
/** A lifted panel: where it was grabbed, where the pointer is, and the panel and edge it currently sits beside. */
interface PanelDrag { id: string; startX: number; startY: number; grabX: number; grabY: number; active: boolean; x: number; y: number; drop: { id: string; zone: DropZone } | null }
const SLIDE = { duration: 200, easing: "cubic-bezier(.32, .72, 0, 1)" };
const reducedMotion = () => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
type Direction = "left" | "right" | "up" | "down";
const ARROW_DIRECTION: Record<string, Direction | undefined> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };

export function RightInspector({
  tabs,
  activeTabId,
  onTabChange,
  onCloseTab,
  visible = true,
}: {
  tabs: InspectorTab[];
  visible?: boolean;
  /** 当前聚焦的面板 ID，不在列表中时回退到第一块 */
  activeTabId: string | null;
  onTabChange: (id: string) => void;
  /** 关闭指定面板 */
  onCloseTab: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [saved, setSaved] = useState<PanelColumn[]>([]);
  const [drag, setDrag] = useState<PanelDrag | null>(null);
  const [resizing, setResizing] = useState(false);
  const asideRef = useRef<HTMLElement>(null);
  /** The blue line along an outer side of the panel area where a lifted panel would dock; positioned in the layout effect, never by React state. */
  const guideRef = useRef<HTMLDivElement>(null);
  const paneRefs = useRef(new Map<string, HTMLElement>());
  const stopRef = useRef<(() => void) | null>(null);
  const columnsRef = useRef<PanelColumn[]>([]);
  /** Resting rectangles of every panel in the current layout (no drag offset, no slide), for hit tests and slides. */
  const restingRef = useRef(new Map<string, Box>());
  const layoutKeyRef = useRef("");
  /** The grid placement this render produced; a change in it is what makes panels slide. */
  const currentLayoutRef = useRef("");
  /** The offset currently applied to the lifted panel, so its resting place can be read back from its rectangle. */
  const liftRef = useRef<{ id: string; x: number; y: number } | null>(null);
  useEffect(() => () => stopRef.current?.(), []);
  const measure = () => {
    const rects = new Map<string, Box>();
    for (const [id, node] of paneRefs.current) {
      const rect = node.getBoundingClientRect();
      const lift = liftRef.current?.id === id ? liftRef.current : null;
      rects.set(id, { left: rect.left - (lift?.x ?? 0), top: rect.top - (lift?.y ?? 0), width: rect.width, height: rect.height });
    }
    return rects;
  };
  // Panels slide to their new places (FLIP) whenever the layout changes, and the lifted panel follows the pointer.
  // A browser panel never slides once the drag is over: its native view is placed from the panel's rectangle.
  useLayoutEffect(() => {
    const key = currentLayoutRef.current;
    if (key !== layoutKeyRef.current) {
      for (const node of paneRefs.current.values()) node.getAnimations?.().forEach(animation => animation.finish());
      const before = restingRef.current;
      const after = measure();
      const moving = drag?.active ?? false;
      if (!reducedMotion()) {
        for (const [id, rect] of after) {
          const node = paneRefs.current.get(id), was = before.get(id);
          if (!node || !was || id === liftRef.current?.id || typeof node.animate !== "function") continue;
          if (!moving && node.dataset.inspectorKind === "browser") continue;
          const dx = was.left - rect.left, dy = was.top - rect.top;
          if (Math.abs(dx) + Math.abs(dy) < 1) continue;
          node.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], SLIDE);
        }
      }
      restingRef.current = after;
      layoutKeyRef.current = key;
    }
    // The drop guide only marks the outer sides of the panel area: it shows when the lifted panel would dock to one of them.
    const guide = guideRef.current;
    if (guide) {
      const drop = drag?.active ? drag.drop : null;
      const edge = drop && drag ? dockEdge(columnsRef.current, drag.id, drop.id, drop.zone) : null;
      const beside = drop ? restingRef.current.get(drop.id) : undefined;
      const origin = asideRef.current?.getBoundingClientRect();
      if (edge && beside && origin) {
        const box = edgeGuideBox(edge, { left: 0, top: 0, width: origin.width, height: origin.height }, { left: beside.left - origin.left, width: beside.width });
        guide.hidden = false;
        guide.dataset.edge = edge;
        guide.style.left = `${box.left}px`;
        guide.style.top = `${box.top}px`;
        guide.style.width = `${box.width}px`;
        guide.style.height = `${box.height}px`;
      } else {
        guide.hidden = true;
        delete guide.dataset.edge;
      }
    }
    const lifted = drag?.active ? paneRefs.current.get(drag.id) : undefined;
    const rest = drag?.active ? restingRef.current.get(drag.id) : undefined;
    if (drag?.active && lifted && rest) {
      const x = drag.x - drag.grabX - rest.left, y = drag.y - drag.grabY - rest.top;
      lifted.style.transform = `translate(${x}px, ${y}px)`;
      liftRef.current = { id: drag.id, x, y };
    } else if (liftRef.current) {
      const { id, x, y } = liftRef.current;
      const node = paneRefs.current.get(id);
      liftRef.current = null;
      if (node) {
        node.style.transform = "";
        // The dropped panel settles from where it was let go into its place.
        if (!reducedMotion() && typeof node.animate === "function" && node.dataset.inspectorKind !== "browser") {
          node.animate([{ transform: `translate(${x}px, ${y}px)` }, { transform: "none" }], SLIDE);
        }
      }
    }
  });
  // A newly opened or focused panel may sit past the edge when several share a narrow dock: bring it into view.
  useEffect(() => {
    if (!activeTabId) return;
    paneRefs.current.get(activeTabId)?.scrollIntoView?.({ block: "nearest", inline: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
  }, [activeTabId]);
  if (tabs.length === 0) return null;
  const active = tabs.find(tab => tab.id === activeTabId) ?? tabs[0];
  const panels = tabs;
  const columns = reconcileColumns(saved, panels.map(tab => tab.id));
  columnsRef.current = columns;
  const byId = new Map(panels.map(tab => [tab.id, tab]));
  const expandedId = expanded !== null && panels.length > 1 && panels.some(tab => tab.id === expanded) ? expanded : null;
  const focus = (id: string) => { if (id !== active.id) onTabChange(id); };
  const activeDrag = drag?.active ? drag : null;
  // While a panel is lifted the others already take the places they would have if it were dropped now.
  const live = activeDrag?.drop ? movePanel(columns, activeDrag.id, activeDrag.drop.id, activeDrag.drop.zone) : columns;
  // Expanding one panel lays it out alone; the others stay mounted, just hidden.
  const placed = expandedId === null ? live : [{ ids: [expandedId], weight: 1 }];
  const { tracks, byId: placement } = gridPlacement(placed);
  currentLayoutRef.current = JSON.stringify([expandedId, [...placement]]);

  /** The resting panel under the pointer and which edge of it the pointer is nearest. */
  const dropAt = (id: string, x: number, y: number): PanelDrag["drop"] => {
    for (const [targetId, rect] of restingRef.current) {
      const node = paneRefs.current.get(targetId);
      if (targetId === id || !node || node.hidden || x < rect.left || x > rect.left + rect.width || y < rect.top || y > rect.top + rect.height) continue;
      return { id: targetId, zone: dropZoneAt(rect, x, y) };
    }
    return null;
  };
  // Drags listen on the window, so they follow the pointer wherever it goes and never depend on pointer capture.
  const listen = (handlers: { move(event: PointerEvent): void; up(): void; cancel(): void; key?(event: globalThis.KeyboardEvent): void }) => {
    const stop = () => {
      window.removeEventListener("pointermove", handlers.move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", abort);
      if (handlers.key) window.removeEventListener("keydown", handlers.key);
      stopRef.current = null;
    };
    const end = () => { stop(); handlers.up(); };
    const abort = () => { stop(); handlers.cancel(); };
    window.addEventListener("pointermove", handlers.move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", abort);
    if (handlers.key) window.addEventListener("keydown", handlers.key);
    stopRef.current = stop;
    return abort;
  };
  const beginPanelDrag = (tab: InspectorTab, event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button") || panels.length < 2 || expandedId !== null) return;
    stopRef.current?.();
    restingRef.current = measure();
    const home = restingRef.current.get(tab.id);
    let state: PanelDrag = { id: tab.id, startX: event.clientX, startY: event.clientY, grabX: event.clientX - (home?.left ?? 0), grabY: event.clientY - (home?.top ?? 0), active: false, x: event.clientX, y: event.clientY, drop: null };
    setDrag(state);
    const abort = listen({
      move: next => {
        if (!state.active && Math.hypot(next.clientX - state.startX, next.clientY - state.startY) <= DRAG_DEAD_ZONE) return;
        // Over a gap or over its own empty slot the panel keeps the last place it was offered.
        state = { ...state, active: true, x: next.clientX, y: next.clientY, drop: dropAt(tab.id, next.clientX, next.clientY) ?? state.drop };
        setDrag(state);
      },
      up: () => {
        if (state.active && state.drop) setSaved(movePanel(columnsRef.current, state.id, state.drop.id, state.drop.zone));
        setDrag(null);
      },
      cancel: () => setDrag(null),
      // Escape puts a lifted panel back.
      key: next => { if (next.key === "Escape") abort(); },
    });
  };
  const columnWidths = () => columns.map(column => paneRefs.current.get(column.ids[0]!)?.getBoundingClientRect().width ?? 0);
  const startResize = (index: number, event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    stopRef.current?.();
    const widths = columnWidths();
    const startX = event.clientX;
    setResizing(true);
    listen({
      move: next => setSaved(resizeColumns(columnsRef.current, index, widths, (widths[index] ?? 0) + next.clientX - startX)),
      up: () => setResizing(false),
      cancel: () => setResizing(false),
    });
  };
  const paneHeights = (column: PanelColumn) => column.ids.map(id => paneRefs.current.get(id)?.getBoundingClientRect().height ?? 0);
  const startRowResize = (columnIndex: number, index: number, event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    stopRef.current?.();
    const heights = paneHeights(columns[columnIndex]!);
    const startY = event.clientY;
    setResizing(true);
    listen({
      move: next => setSaved(resizeRows(columnsRef.current, columnIndex, index, heights, (heights[index] ?? 0) + next.clientY - startY)),
      up: () => setResizing(false),
      cancel: () => setResizing(false),
    });
  };
  const resizeRowByKey = (columnIndex: number, index: number, event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const heights = paneHeights(columns[columnIndex]!);
    setSaved(resizeRows(columns, columnIndex, index, heights, (heights[index] ?? 0) + (event.key === "ArrowDown" ? 16 : -16)));
  };
  const resizeByKey = (index: number, event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const widths = columnWidths();
    setSaved(resizeColumns(columns, index, widths, (widths[index] ?? 0) + (event.key === "ArrowRight" ? 16 : -16)));
  };

  return (
    <aside ref={asideRef} className="ff-right-inspector" hidden={!visible} inert={!visible} aria-label={t("rightInspector.panelAria")}
      data-has-panels={panels.length > 0 || undefined} data-shielded={activeDrag || resizing ? true : undefined} data-moving={activeDrag ? true : undefined}>
      <div className="ff-inspector-grid" style={{
        gridTemplateColumns: placed.flatMap((column, index) => [...(index > 0 ? ["8px"] : []), `minmax(${MIN_COLUMN_WIDTH}px, ${column.weight}fr)`]).join(" "),
        gridTemplateRows: tracks.map(track => `minmax(0, ${track}fr)`).join(" "),
      }}>
        {expandedId === null && live.slice(1).map((column, index) => (
          <div key={`resizer:${column.ids[0]}`} className="ff-inspector-resizer" role="separator" aria-orientation="vertical" tabIndex={0}
            aria-label={t("rightInspector.resize")} style={{ gridColumn: (index + 1) * 2, gridRow: "1 / -1" }}
            onPointerDown={event => startResize(index, event)} onKeyDown={event => resizeByKey(index, event)} />
        ))}
        {expandedId === null && live.flatMap((column, columnIndex) => column.ids.slice(1).map((id, index) => {
          const spot = placement.get(id);
          return spot && (
            <div key={`row-resizer:${id}`} className="ff-inspector-row-resizer" role="separator" aria-orientation="horizontal" tabIndex={0}
              aria-label={t("rightInspector.resizeRows")} style={{ gridColumn: spot.column, gridRow: `${spot.row} / span 1` }}
              onPointerDown={event => startRowResize(columnIndex, index, event)} onKeyDown={event => resizeRowByKey(columnIndex, index, event)} />
          );
        }))}
        {panels.map(tab => {
          const Icon = tab.kind ? tabIcons[tab.kind] : undefined;
          const closable = tab.closable !== false;
          const isExpanded = expandedId === tab.id;
          const spot = placement.get(tab.id);
          return (
            <section key={tab.id} ref={node => { if (node) paneRefs.current.set(tab.id, node); else paneRefs.current.delete(tab.id); }}
              className="ff-inspector-pane" data-inspector-pane={tab.id} data-inspector-kind={tab.kind}
              data-active={tab.id === active.id || undefined} data-lifted={activeDrag?.id === tab.id || undefined}
              hidden={expandedId !== null && !isExpanded}
              aria-label={tab.title ?? tab.label}
              style={spot ? { gridColumn: spot.column, gridRow: `${spot.row} / span ${spot.span}` } : undefined}
              onFocusCapture={() => focus(tab.id)} onPointerDownCapture={() => focus(tab.id)}>
              <header className="ff-inspector-pane__head" tabIndex={0} aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown"
                onPointerDown={event => beginPanelDrag(tab, event)}
                onKeyDown={event => {
                  if (event.target !== event.currentTarget) return;
                  // Delete on a focused header closes that panel, like its close button.
                  if (event.key === "Delete" && closable) { event.preventDefault(); onCloseTab(tab.id); return; }
                  if (event.key === "Escape" && activeDrag) { event.preventDefault(); setDrag(null); return; }
                  const direction = event.altKey ? ARROW_DIRECTION[event.key] : undefined;
                  if (direction && expandedId === null) { event.preventDefault(); setSaved(shiftPanel(columns, tab.id, direction)); }
                }}
                onDoubleClick={event => {
                  if (!(event.target as HTMLElement).closest("button") && panels.length > 1) setExpanded(isExpanded ? null : tab.id);
                }}>
                {Icon && <Icon size={14} className="ff-inspector-pane__icon" aria-hidden="true" />}
                {tab.dotClass && <span className={`ff-right-inspector__dot ${tab.dotClass}`} aria-hidden="true" />}
                <span className="ff-inspector-pane__title" title={tab.title ?? tab.label}>{tab.label}</span>
                {tab.status}
                <span className="ff-inspector-pane__spacer" />
                {panels.length > 1 && (
                  <button type="button" className="ff-inspector-pane__action" aria-pressed={isExpanded}
                    aria-label={isExpanded ? t("rightInspector.restore") : t("rightInspector.expand")}
                    title={isExpanded ? t("rightInspector.restore") : t("rightInspector.expand")}
                    onClick={() => setExpanded(isExpanded ? null : tab.id)}>
                    {isExpanded ? <Minimize2 size={13} aria-hidden="true" /> : <Maximize2 size={13} aria-hidden="true" />}
                  </button>
                )}
                {closable && (
                  <button type="button" className="ff-inspector-pane__action ff-right-inspector__close" onClick={() => onCloseTab(tab.id)}
                    aria-label={`${t("common.close")} ${tab.label}`} title={t("rightInspector.closeTab", { name: tab.title ?? tab.label })}>
                    <X size={14} aria-hidden="true" />
                  </button>
                )}
              </header>
              <div className="ff-inspector-pane__body" role="region" aria-label={tab.label}>{tab.content}</div>
            </section>
          );
        })}
      </div>
      <div ref={guideRef} className="ff-inspector-drop-guide" aria-hidden="true" hidden />
    </aside>
  );
}
