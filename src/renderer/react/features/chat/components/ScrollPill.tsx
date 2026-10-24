// 对话区的滚动指示：一根固定长度的小圆条，代替会随内容变长的原生滚动条。
// 它贴在整个对话面板的最右边（右侧概览卡片的外侧），像 Claude 桌面版那样，不夹在对话和卡片之间把两者隔开。
// 平时隐藏，指针在对话区上或刚滚动过时出现；可以拖动。用 fixed 定位，不会被中间容器裁掉。
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import "./ScrollPill.css";

/** Pill length and the margin kept from the top and bottom of the conversation. */
export const PILL_LENGTH = 36;
const EDGE = 8;
/** Distance from the pill's left side to the right edge of the panel it hugs. */
const INSET = 8;
const IDLE_MS = 900;

export interface PillGeometry { top: number; left: number; visible: boolean }

/** Where the pill sits, in viewport coordinates, for a given scroll position; pure so it can be tested without layout. */
export function pillGeometry(input: { scrollTop: number; scrollHeight: number; clientHeight: number; listTop: number; panelRight: number }): PillGeometry {
  const range = input.scrollHeight - input.clientHeight;
  if (range <= 1) return { top: 0, left: 0, visible: false };
  const ratio = Math.min(1, Math.max(0, input.scrollTop / range));
  const travel = Math.max(0, input.clientHeight - PILL_LENGTH - EDGE * 2);
  return { top: Math.round(input.listTop + EDGE + ratio * travel), left: Math.round(input.panelRight - INSET), visible: true };
}

export function ScrollPill({ target, panel, onUserScroll }: {
  target: RefObject<HTMLElement | null>;
  /** Selector of the panel whose right edge the pill hugs (the conversation plus its overview cards). */
  panel: string;
  /** Called as the pill is dragged, so bottom-pinning treats it as the user's own scroll and lets go. */
  onUserScroll?(): void;
}) {
  const [geometry, setGeometry] = useState<PillGeometry>({ top: 0, left: 0, visible: false });
  const [active, setActive] = useState(false);
  const idle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const drag = useRef<{ pointerId: number; startY: number; startTop: number } | null>(null);

  const measure = useCallback(() => {
    const element = target.current;
    if (!element) return;
    const box = element.getBoundingClientRect();
    const frame = (element.closest(panel) ?? element).getBoundingClientRect();
    setGeometry(pillGeometry({
      scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight,
      listTop: box.top, panelRight: frame.right,
    }));
  }, [target, panel]);

  const wake = useCallback(() => {
    setActive(true);
    clearTimeout(idle.current);
    idle.current = setTimeout(() => { if (!drag.current) setActive(false); }, IDLE_MS);
  }, []);

  useEffect(() => {
    const element = target.current;
    if (!element) return;
    const onScroll = () => { measure(); wake(); };
    const onEnter = () => { measure(); setActive(true); clearTimeout(idle.current); };
    const onLeave = () => { if (!drag.current) setActive(false); };
    element.addEventListener("scroll", onScroll, { passive: true });
    element.addEventListener("pointerenter", onEnter);
    element.addEventListener("pointerleave", onLeave);
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    // Watch every child (a channel banner can come before the message column), and keep up as children come and go.
    const observeChildren = () => {
      if (!observer) return;
      observer.disconnect();
      observer.observe(element);
      for (const child of Array.from(element.children)) observer.observe(child);
    };
    observeChildren();
    // The panel can change width (window resize, cards opening) without the list itself resizing.
    const frame = element.closest(panel);
    if (frame) observer?.observe(frame);
    window.addEventListener("resize", measure);
    const mutations = typeof MutationObserver === "undefined" ? undefined : new MutationObserver(() => { observeChildren(); measure(); });
    mutations?.observe(element, { childList: true });
    measure();
    return () => {
      element.removeEventListener("scroll", onScroll);
      element.removeEventListener("pointerenter", onEnter);
      element.removeEventListener("pointerleave", onLeave);
      observer?.disconnect();
      mutations?.disconnect();
      window.removeEventListener("resize", measure);
      clearTimeout(idle.current);
    };
  }, [target, panel, measure, wake]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { pointerId: event.pointerId, startY: event.clientY, startTop: target.current?.scrollTop ?? 0 };
    setActive(true);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const element = target.current;
    if (!drag.current || drag.current.pointerId !== event.pointerId || !element) return;
    const travel = Math.max(1, element.clientHeight - PILL_LENGTH - EDGE * 2);
    const range = element.scrollHeight - element.clientHeight;
    onUserScroll?.();
    element.scrollTop = drag.current.startTop + ((event.clientY - drag.current.startY) / travel) * range;
  };
  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    wake();
  };

  if (!geometry.visible) return null;
  return (
    <div className={`ff-scroll-pill ${active ? "is-active" : ""}`} aria-hidden="true"
      style={{ top: geometry.top, left: geometry.left, height: PILL_LENGTH }}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag} />
  );
}
