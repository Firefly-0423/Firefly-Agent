// 会话概览：对话面板外侧的一摞卡片，只展示真实数据，参照 Claude 桌面版：环境、连接器、后台任务、上下文、变更、产出。
// 环境、连接器是单行入口（点开对应面板或设置页）；其余可折叠。
// 上下文来自主进程的估算快照（不是账单）；变更与后台任务来自本会话各次 run 的工具/委托记录。
// 卡片没有数据时说明"暂无"，不放示例内容。
// 交互参照 open-claude-ui：按住卡片标题或右上角六点抓取柄可上下拖动换顺序（4px 死区，整张卡片跟着鼠标走、
// 微倾斜浮起，其余卡片实时滑开让位），键盘在抓取柄上按 ↑↓ 也能挪；顺序记在本机。展开收起用 Grid 0fr→1fr 的高度动画。

import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { ChevronRight, GripVertical } from "lucide-react";
import { useTranslation } from "../../../i18n";
import type { ContextUsageSnapshot } from "../../../../../shared/context-usage";
import type { WorkspaceChangedFile, WorkspaceRunOutput } from "../workspace/workspace-artifacts";
import { OUTPUT_FILE_ICONS } from "../workspace/output-file-icons";
import { getCharacterPortraitByAssetFileName } from "../../../character-portraits";
import { contextUsageCategoryMeta, formatTokenCount } from "./ContextUsageRing";
import {
  buildContextOverview,
  summarizeChanges,
  summarizeOutputFiles,
  summarizeTasks,
  type OverviewContext,
} from "./session-overview-model";
import { DRAG_DEAD_ZONE, moveId, reconcileOrder } from "./reorder-list";
import { UsageCardBody, usageCardSummary, useUsageData } from "./TokenUsageBar";
import "./SessionOverviewPanel.css";

const OPEN_STORAGE_PREFIX = "ff.sessionOverview.open.";
const ORDER_STORAGE_KEY = "ff.sessionOverview.order";

function readOrder(): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(ORDER_STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function writeOrder(order: readonly string[]): void {
  try {
    window.localStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify(order));
  } catch {
    // 存储不可用时顺序只在本次有效。
  }
}

function readOpen(id: string, fallback: boolean): boolean {
  try {
    const stored = window.localStorage.getItem(OPEN_STORAGE_PREFIX + id);
    return stored === null ? fallback : stored === "1";
  } catch {
    return fallback;
  }
}

function writeOpen(id: string, open: boolean): void {
  try {
    window.localStorage.setItem(OPEN_STORAGE_PREFIX + id, open ? "1" : "0");
  } catch {
    // 存储不可用（隐私窗口、被禁用）时折叠状态只在本次有效。
  }
}

function fileBaseName(file: string): string {
  const slash = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"));
  return slash < 0 ? file : file.slice(slash + 1);
}

interface CardDrag {
  /** Starts a press that becomes a drag after the dead zone; the whole card follows the pointer. */
  onPointerDown(event: ReactPointerEvent<HTMLElement>): void;
  onGripKeyDown(event: KeyboardEvent<HTMLButtonElement>): void;
  /** True right after a drag ended on this card, so the release does not also fold it. */
  consumeClick(): boolean;
  dragging: boolean;
  /** How far the pointer has travelled since the press, so the lifted card follows it. */
  offsetY: number;
  /** How far this card slides to make room for the dragged one. */
  shiftY: number;
}

function OverviewCard({ id, title, summary, defaultOpen = true, drag, onActivate, children }: {
  id: string;
  title: string;
  /** A one-line entry card: the whole bar opens something instead of folding a body. */
  onActivate?: () => void;
  /** 折叠时也看得到的一行摘要。 */
  summary?: ReactNode;
  defaultOpen?: boolean;
  drag?: CardDrag;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(() => readOpen(id, defaultOpen));
  const isEntry = children === undefined;
  const bodyId = useId();
  return (
    <section className="ff-overview-card" data-overview-card={id} data-open={isEntry ? undefined : open} data-entry={isEntry || undefined}
      data-dragging={drag?.dragging || undefined}
      style={drag?.dragging ? { "--ff-drag-y": `${drag.offsetY}px` } as CSSProperties
        : drag?.shiftY ? { "--ff-shift-y": `${drag.shiftY}px` } as CSSProperties : undefined}>
      <div className="ff-overview-card__bar">
        <button
          type="button"
          className="ff-overview-card__head"
          aria-expanded={isEntry ? undefined : open}
          aria-controls={isEntry ? undefined : bodyId}
          disabled={isEntry && !onActivate}
          onPointerDown={drag?.onPointerDown}
          onClick={() => {
            if (drag?.consumeClick()) return;
            if (isEntry) { onActivate?.(); return; }
            setOpen(!open); writeOpen(id, !open);
          }}
        >
          <ChevronRight className="ff-overview-card__chevron" size={14} aria-hidden="true" />
          <span className="ff-overview-card__title">{title}</span>
          {summary !== undefined && <span className="ff-overview-card__summary">{summary}</span>}
        </button>
        {drag && (
          <button type="button" className="ff-overview-card__grip" data-overview-grip=""
            aria-label={t("sessionOverview.reorder", { name: title })} title={t("sessionOverview.reorderHint")}
            onPointerDown={drag.onPointerDown} onKeyDown={drag.onGripKeyDown}>
            <GripVertical size={14} aria-hidden="true" />
          </button>
        )}
      </div>
      {/* Grid 0fr -> 1fr: the body grows and shrinks without measuring its height. */}
      {!isEntry && (
        <div id={bodyId} className="ff-overview-card__fold" aria-hidden={!open} inert={!open}>
          <div className="ff-overview-card__body">{children}</div>
        </div>
      )}
    </section>
  );
}

function ContextCardBody({ overview }: { overview: OverviewContext }) {
  const { t } = useTranslation();
  const meta = contextUsageCategoryMeta();
  const usedText = overview.usedPercent !== undefined
    ? t("sessionOverview.contextUsed", { percent: overview.usedPercent })
    : t("sessionOverview.contextUsedUnknown");
  const totals = overview.windowTokens > 0
    ? `${formatTokenCount(overview.totalTokens)} / ${formatTokenCount(overview.windowTokens)}`
    : formatTokenCount(overview.totalTokens);
  return (
    <>
      <div className="ff-overview-context__totals">
        <strong>{usedText}</strong>
        <span>{totals}</span>
      </div>
      <div className={`ff-overview-context__bar is-${overview.tone}`} aria-hidden="true">
        {overview.rows.map((row) => (
          <span key={row.key} style={{ width: `${row.windowRatio * 100}%`, background: meta[row.key].color }} />
        ))}
      </div>
      <ul className="ff-overview-context__rows">
        {overview.rows.map((row) => (
          <li key={row.key}>
            <span className="ff-overview-context__dot" style={{ background: meta[row.key].color }} aria-hidden="true" />
            <span className="ff-overview-context__name">{meta[row.key].label}</span>
            <span className="ff-overview-context__tokens">{formatTokenCount(row.tokens)}</span>
            <span className="ff-overview-context__share">{row.share !== undefined ? `${row.share}%` : ""}</span>
          </li>
        ))}
        {overview.freeTokens !== undefined && (
          <li className="is-free">
            <span className="ff-overview-context__dot" aria-hidden="true" />
            <span className="ff-overview-context__name">{t("sessionOverview.contextFree")}</span>
            <span className="ff-overview-context__tokens">{formatTokenCount(overview.freeTokens)}</span>
            <span className="ff-overview-context__share" />
          </li>
        )}
      </ul>
      <p className="ff-overview-card__note">{t(overview.measured ? "sessionOverview.contextMeasured" : "sessionOverview.contextEstimate")}</p>
    </>
  );
}

export interface OverviewEnvironment {
  mode: "chat" | "work" | "code";
  /** The bound project's display name, when the session has one. */
  workspaceName?: string;
  temporary?: boolean;
}

export interface SessionOverviewPanelProps {
  usage?: ContextUsageSnapshot;
  outputs: readonly WorkspaceRunOutput[];
  environment?: OverviewEnvironment;
  onOpenChange?: (output: WorkspaceRunOutput, file: WorkspaceChangedFile) => void;
  onOpenTask?: (output: WorkspaceRunOutput, taskId: string) => void;
  /** Opens the project (file panel) or lets the user pick one. */
  onOpenEnvironment?: () => void;
  /** Opens the connector (MCP) settings page. */
  onOpenConnectors?: () => void;
  /** Opens a produced file (project-relative path) in the file preview. */
  onOpenOutputFile?: (relPath: string) => void;
  /** The bound project's folder: produced files inside it can be opened. */
  workspaceRoot?: string;
  /** The conversation whose run stats the usage card shows. */
  sessionId?: string;
  /** A run is in flight: usage is read again when it ends. */
  busy?: boolean;
}

interface CardSlot { id: string; top: number; height: number }
interface CardDragState { id: string; startY: number; offsetY: number; active: boolean; target: number; slots: CardSlot[]; gap: number }

/** Where the dragged card lands among the others: its centre against each other card's resting midpoint. */
function landingIndex(state: CardDragState): number {
  const dragged = state.slots.find(slot => slot.id === state.id)!;
  const centre = dragged.top + state.offsetY + dragged.height / 2;
  const others = state.slots.filter(slot => slot.id !== state.id);
  const index = others.findIndex(slot => centre < slot.top + slot.height / 2);
  return index < 0 ? others.length : index;
}

/** How far a resting card slides so the dragged one has room at its landing place. */
function slideFor(state: CardDragState, id: string): number {
  const from = state.slots.findIndex(slot => slot.id === state.id);
  const at = state.slots.findIndex(slot => slot.id === id);
  if (from < 0 || at < 0 || at === from) return 0;
  const among = at > from ? at - 1 : at;
  const landed = among >= state.target ? among + 1 : among;
  return (landed - at) * (state.slots[from]!.height + state.gap);
}

/** Entry cards that sit on top, as in Claude desktop, even for an order saved before they existed. */
const LEADING_CARDS = ["environment", "connectors"];


/** The partner's portrait with the running dot on its corner; just the dot when there is no portrait. */
function TaskPartner({ assetFileName }: { assetFileName: string }) {
  const portrait = getCharacterPortraitByAssetFileName(assetFileName);
  if (!portrait) return <span className="ff-overview-list__pulse" aria-hidden="true" />;
  return (
    <span className="ff-overview-list__partner" aria-hidden="true">
      <img className="ff-overview-list__avatar" src={portrait} alt="" draggable={false} />
      <span className="ff-overview-list__pulse" />
    </span>
  );
}

export function SessionOverviewPanel({ usage, outputs, environment, onOpenChange, onOpenTask, onOpenEnvironment, onOpenConnectors, onOpenOutputFile, workspaceRoot, sessionId, busy }: SessionOverviewPanelProps) {
  const usageData = useUsageData(busy, sessionId);
  const { t } = useTranslation();
  const context = buildContextOverview(usage);
  const changes = summarizeChanges(outputs);
  const tasks = summarizeTasks(outputs);
  const produced = summarizeOutputFiles(outputs, workspaceRoot);
  const hasTasks = tasks.running.length > 0 || tasks.finished > 0;
  const [order, setOrder] = useState<string[]>(readOrder);
  const [drag, setDrag] = useState<CardDragState | null>(null);
  const [settling, setSettling] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const justDraggedRef = useRef<string | null>(null);
  useEffect(() => () => stopRef.current?.(), []);
  // After a drop the cards already sit where they land; turn their slide off for one frame so nothing animates back.
  useEffect(() => {
    if (!settling) return;
    const frame = requestAnimationFrame(() => setSettling(false));
    return () => cancelAnimationFrame(frame);
  }, [settling]);
  // Scroll fade: a 28px feathered edge only where cards are hidden past it.
  const updateFade = (element: HTMLElement) => {
    element.toggleAttribute("data-fade-top", element.scrollTop > 2);
    element.toggleAttribute("data-fade-bottom", element.scrollHeight - element.scrollTop - element.clientHeight > 2);
  };
  useEffect(() => {
    const element = listRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => updateFade(element));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const environmentSummary = !environment ? undefined
    : environment.temporary ? t("sessionOverview.environmentTemporary")
    : environment.workspaceName ?? t(environment.mode === "chat" ? "sessionOverview.environmentLocal" : "sessionOverview.environmentNoProject");
  const cards: Array<{ id: string; title: string; summary?: ReactNode; body?: ReactNode; onActivate?: () => void }> = [
    { id: "environment", title: t("sessionOverview.environment"), summary: environmentSummary, onActivate: onOpenEnvironment },
    { id: "connectors", title: t("sessionOverview.connectors"), summary: t("sessionOverview.connectorsManage"), onActivate: onOpenConnectors },
    {
      id: "tasks",
      title: t("sessionOverview.tasks"),
      summary: hasTasks ? t("sessionOverview.tasksRunning", { count: tasks.running.length }) : undefined,
      body: (
        <>
          {!hasTasks && <p className="ff-overview-card__empty">{t("sessionOverview.tasksEmpty")}</p>}
          {tasks.running.length > 0 && (
            <ul className="ff-overview-list">
              {tasks.running.map(({ task, output }) => (
                <li key={task.invocationId}>
                  <button type="button" className="ff-overview-list__row" disabled={!onOpenTask}
                    onClick={() => onOpenTask?.(output, task.taskId)} title={task.description}>
                    <TaskPartner assetFileName={task.assetFileName} />
                    <span className="ff-overview-list__name">{task.description || task.nickname}</span>
                    <span className="ff-overview-list__meta">{task.nickname}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {tasks.finished > 0 && (
            <p className="ff-overview-card__line">
              {t("sessionOverview.tasksFinished", { count: tasks.finished })}
              {tasks.failed > 0 && <span className="ff-overview-card__warn"> · {t("sessionOverview.tasksFailed", { count: tasks.failed })}</span>}
            </p>
          )}
        </>
      ),
    },
    {
      id: "context",
      title: t("sessionOverview.context"),
      summary: context?.usedPercent !== undefined ? `${context.usedPercent}%` : undefined,
      body: context ? <ContextCardBody overview={context} /> : <p className="ff-overview-card__empty">{t("sessionOverview.contextEmpty")}</p>,
    },
    {
      id: "changes",
      title: t("sessionOverview.changes"),
      summary: changes.files.length > 0 ? (
        <>
          <span className="ff-overview-diffstat is-add">+{changes.insertions}</span>{" "}
          <span className="ff-overview-diffstat is-del">−{changes.deletions}</span>
        </>
      ) : undefined,
      body: changes.files.length === 0
        ? <p className="ff-overview-card__empty">{t("sessionOverview.changesEmpty")}</p>
        : (
          <ul className="ff-overview-list">
            {changes.files.map((item) => (
              <li key={item.file}>
                <button type="button" className="ff-overview-list__row" disabled={!onOpenChange}
                  onClick={() => onOpenChange?.(item.output, item.changed)} title={item.file}>
                  <span className="ff-overview-list__name">{fileBaseName(item.file)}</span>
                  <span className="ff-overview-list__meta">
                    <span className="ff-overview-diffstat is-add">+{item.insertions}</span>{" "}
                    <span className="ff-overview-diffstat is-del">−{item.deletions}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ),
    },
    {
      id: "outputs",
      title: t("sessionOverview.outputs"),
      summary: produced.length > 0 ? String(produced.length) : undefined,
      body: produced.length === 0
        ? <p className="ff-overview-card__empty">{t("sessionOverview.outputsEmpty")}</p>
        : (
          <ul className="ff-overview-list ff-overview-outputs">
            {produced.map((item) => {
              const Icon = OUTPUT_FILE_ICONS[item.type];
              return (
                <li key={item.file}>
                  <button type="button" className="ff-overview-list__row" data-output-kind={item.type} title={item.file}
                    disabled={!onOpenOutputFile || !item.relPath} onClick={() => item.relPath && onOpenOutputFile?.(item.relPath)}>
                    <Icon className="ff-overview-outputs__icon" size={14} strokeWidth={1.7} aria-hidden="true" />
                    <span className="ff-overview-list__name">{fileBaseName(item.file)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        ),
    },
    {
      id: "usage",
      title: t("sessionOverview.usage"),
      summary: usageCardSummary(usageData),
      body: <UsageCardBody data={usageData} />,
    },
  ];
  const reconciled = reconcileOrder(order, cards.map(card => card.id));
  const leading = LEADING_CARDS.filter(id => !order.includes(id));
  const ordered = [...leading, ...reconciled.filter(id => !leading.includes(id))].map(id => cards.find(card => card.id === id)!);
  const commit = (next: string[]) => { setOrder(next); writeOrder(next); };
  /** Presses on a card's header or grip become a drag past the dead zone; listening on the window keeps it following the pointer anywhere. */
  const beginDrag = (id: string, event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    stopRef.current?.();
    const nodes = Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-overview-card]") ?? []);
    const slots = nodes.map(node => { const rect = node.getBoundingClientRect(); return { id: node.dataset.overviewCard!, top: rect.top, height: rect.height }; });
    const gap = slots.length > 1 ? Math.max(0, slots[1]!.top - (slots[0]!.top + slots[0]!.height)) : 0;
    let state: CardDragState = { id, startY: event.clientY, offsetY: 0, active: false, target: 0, slots, gap };
    const move = (next: PointerEvent) => {
      if (!state.active && Math.abs(next.clientY - state.startY) <= DRAG_DEAD_ZONE) return;
      state = { ...state, active: true, offsetY: next.clientY - state.startY };
      state = { ...state, target: landingIndex(state) };
      setDrag(state);
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key);
      stopRef.current = null;
    };
    const up = () => {
      stop();
      if (state.active) {
        justDraggedRef.current = id;
        setTimeout(() => { if (justDraggedRef.current === id) justDraggedRef.current = null; }, 0);
        setSettling(true);
        commit(moveId(slots.map(slot => slot.id), id, state.target));
      }
      setDrag(null);
    };
    const cancel = () => { stop(); setDrag(null); };
    // Escape puts a lifted card back where it was, like the reference's drag state machine.
    const key = (next: globalThis.KeyboardEvent) => { if (next.key === "Escape" && state.active) { next.preventDefault(); cancel(); } };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key);
    stopRef.current = stop;
  };
  const dragFor = (id: string): CardDrag => ({
    dragging: Boolean(drag?.active && drag.id === id),
    offsetY: drag?.id === id ? drag.offsetY : 0,
    shiftY: drag?.active ? slideFor(drag, id) : 0,
    onPointerDown: (event) => {
      // The grip and the header both start a drag; buttons inside a card body do not.
      if ((event.target as HTMLElement).closest(".ff-overview-card__fold")) return;
      beginDrag(id, event);
    },
    consumeClick: () => {
      if (justDraggedRef.current !== id) return false;
      justDraggedRef.current = null;
      return true;
    },
    onGripKeyDown: (event) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      const ids = ordered.map(card => card.id);
      commit(moveId(ids, id, ids.indexOf(id) + (event.key === "ArrowUp" ? -1 : 1)));
    },
  });

  return (
    <div ref={listRef} className="ff-session-overview" aria-label={t("sessionOverview.title")}
      data-dragging={drag?.active || undefined} data-settling={settling || undefined} onScroll={event => updateFade(event.currentTarget)}>
      {ordered.map(card => (
        <OverviewCard key={card.id} id={card.id} title={card.title} summary={card.summary} drag={dragFor(card.id)} onActivate={card.onActivate}>
          {card.body}
        </OverviewCard>
      ))}
    </div>
  );
}
