import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { useTranslation } from "../../../i18n";
import "./FloatingComposer.css";

type Offset = { x: number; y: number };
type Box = { left: number; top: number; right: number; bottom: number };
type FloatingComposerState = Offset & { collapsed: boolean };

const STORAGE_KEY = "ff.floatingComposer";
const EDGE_MARGIN = 8;
const KEY_STEP = 16;

/** 把拖动后的偏移限制在工作区内：base 是偏移为 0 时输入框的位置，area 是工作区；放不下的方向保持原位。 */
export function clampFloatingOffset(desired: Offset, base: Box, area: Box, margin: number): Offset {
  const clamp = (value: number, min: number, max: number) => (min > max ? 0 : Math.min(max, Math.max(min, value)));
  return {
    x: clamp(desired.x, area.left + margin - base.left, area.right - margin - base.right),
    y: clamp(desired.y, area.top + margin - base.top, area.bottom - margin - base.bottom),
  };
}

/** 读取上次的位置和收起状态；数据损坏时回到默认位置。 */
export function parseFloatingComposerState(raw: string | null): FloatingComposerState {
  const fallback = { x: 0, y: 0, collapsed: false };
  try {
    const value: unknown = JSON.parse(raw ?? "null");
    if (!value || typeof value !== "object") return fallback;
    const { x, y, collapsed } = value as Record<string, unknown>;
    if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) return fallback;
    return { x, y, collapsed: collapsed === true };
  } catch {
    return fallback;
  }
}

function readState(): FloatingComposerState {
  try { return parseFloatingComposerState(window.localStorage.getItem(STORAGE_KEY)); } catch { return parseFloatingComposerState(null); }
}

function writeState(state: FloatingComposerState): void {
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* the position then lasts for this window only */ }
}

function MinusIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12" /></svg>;
}

function ChatIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4A8 8 0 1 1 20 12Z" /></svg>;
}

function GripIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {[9, 15].flatMap((cx) => [6, 12, 18].map((cy) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="1.4" />))}
    </svg>
  );
}

type FloatingComposerProps = {
  /** 会话里已有消息时可以拖动和收起；新会话页保持原来的位置。 */
  floating: boolean;
  /** 有审批、提问等卡片等待处理时，收起的输入框自动展开。 */
  attention?: boolean;
  children: ReactNode;
};

/** 输入框外观不变；鼠标移上去时右上角出现收起和拖动。拖动后停在工作区里的任意位置，收起后只留一个小圆按钮。 */
export function FloatingComposer({ floating, attention = false, children }: FloatingComposerProps) {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<FloatingComposerState>(() => (typeof window === "undefined" ? parseFloatingComposerState(null) : readState()));
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ pointerId: number; startX: number; startY: number; origin: Offset; base: Box; area: Box } | null>(null);
  // 用户最后一次选定的位置；显示位置可能因为工作区变小被临时挤回来，但不覆盖它。
  const chosen = useRef<Offset>({ x: state.x, y: state.y });
  const collapsed = floating && state.collapsed && !attention;

  const update = (next: FloatingComposerState) => {
    chosen.current = { x: next.x, y: next.y };
    setState(next);
    writeState(next);
  };

  const bounds = (offset: Offset) => {
    const root = rootRef.current;
    const area = root?.closest(".ff-workspace")?.getBoundingClientRect();
    const rect = root?.getBoundingClientRect();
    if (!area || !rect) return null;
    return {
      area,
      base: { left: rect.left - offset.x, top: rect.top - offset.y, right: rect.right - offset.x, bottom: rect.bottom - offset.y },
    };
  };

  // 工作区或输入框自身尺寸变化（窗口缩放、侧栏开合、刚加载完消息、输入框随文字长高）时，按用户选的位置重新放进工作区；
  // 只调整显示，不改保存的位置。
  useEffect(() => {
    if (!floating) return;
    const settle = () => setState((current) => {
      const box = bounds(current);
      if (!box) return current;
      const next = clampFloatingOffset(chosen.current, box.base, box.area, EDGE_MARGIN);
      return next.x === current.x && next.y === current.y ? current : { ...current, ...next };
    });
    settle();
    const root = rootRef.current;
    const area = root?.closest(".ff-workspace");
    const observer = typeof ResizeObserver === "function" && area ? new ResizeObserver(settle) : null;
    if (observer && area) observer.observe(area);
    if (observer && root) observer.observe(root);
    // 打开会话时输入框有一段下滑动画，动画中途量到的位置不准，结束后再放一次。
    root?.addEventListener("transitionend", settle);
    window.addEventListener("resize", settle);
    return () => { observer?.disconnect(); root?.removeEventListener("transitionend", settle); window.removeEventListener("resize", settle); };
  }, [floating]); // eslint-disable-line react-hooks/exhaustive-deps

  const moveTo = (desired: Offset) => {
    const box = bounds(state);
    if (!box) return;
    update({ ...state, ...clampFloatingOffset(desired, box.base, box.area, EDGE_MARGIN) });
  };

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    const box = bounds(state);
    if (!box) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, origin: { x: state.x, y: state.y }, ...box };
    setDragging(true);
  };

  const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const desired = { x: active.origin.x + event.clientX - active.startX, y: active.origin.y + event.clientY - active.startY };
    setState((current) => ({ ...current, ...clampFloatingOffset(desired, active.base, active.area, EDGE_MARGIN) }));
  };

  const endDrag = (event: PointerEvent<HTMLButtonElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
    setState((current) => { chosen.current = { x: current.x, y: current.y }; writeState(current); return current; });
  };

  const onHandleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const step = { ArrowLeft: [-KEY_STEP, 0], ArrowRight: [KEY_STEP, 0], ArrowUp: [0, -KEY_STEP], ArrowDown: [0, KEY_STEP] }[event.key];
    if (step) { event.preventDefault(); moveTo({ x: state.x + step[0], y: state.y + step[1] }); }
    else if (event.key === "Home") { event.preventDefault(); update({ ...state, x: 0, y: 0 }); }
  };

  const expand = () => {
    update({ ...state, collapsed: false });
    requestAnimationFrame(() => rootRef.current?.querySelector<HTMLTextAreaElement>(".ff-floating-composer__body textarea")?.focus());
  };

  const className = ["ff-floating-composer", floating && "is-floating", collapsed && "is-collapsed", dragging && "is-dragging"]
    .filter(Boolean).join(" ");

  return (
    <div ref={rootRef} className={className} style={floating ? { transform: `translate(${state.x}px, ${state.y}px)` } : undefined}>
      {floating && !collapsed && (
        <div className="ff-floating-composer__controls">
          <button type="button" className="ff-floating-composer__control" aria-label={t("composer.floatingCollapse")} title={t("composer.floatingCollapse")}
            onClick={() => update({ ...state, collapsed: true })}>
            <MinusIcon />
          </button>
          <button type="button" className="ff-floating-composer__control is-handle" aria-label={t("composer.floatingMove")} title={t("composer.floatingMove")}
            onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag}
            onDoubleClick={() => update({ ...state, x: 0, y: 0 })} onKeyDown={onHandleKeyDown}>
            <GripIcon />
          </button>
        </div>
      )}
      {collapsed && (
        <button type="button" className="ff-floating-composer__restore" aria-label={t("composer.floatingExpand")} title={t("composer.floatingExpand")} onClick={expand}>
          <ChatIcon />
        </button>
      )}
      {/* 收起时只隐藏，不卸载：草稿、附件和语音输入的状态都保留。 */}
      <div className="ff-floating-composer__body" hidden={collapsed}>{children}</div>
    </div>
  );
}
