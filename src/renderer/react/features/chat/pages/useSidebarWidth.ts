import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";

const STORAGE_KEY = "firefly.chat.sidebar-width";
const MIN_WIDTH = 180;
const MAX_WIDTH = 360;
const DEFAULT_WIDTH = 240;
// Docked navigation reserves the horizontal chat/workspace area. A floating
// sidebar only reserves the rail and edge inset; it does not consume chat width.
function maximum(viewport: number, overlay: boolean) {
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, viewport - (overlay ? 64 : 710)));
}
function clamp(width: number, viewport: number, overlay: boolean) { return Math.max(MIN_WIDTH, Math.min(maximum(viewport, overlay), width)); }
function savedWidth() {
  try {
    const value = Number(window.localStorage.getItem(STORAGE_KEY));
    if (Number.isFinite(value) && value >= MIN_WIDTH && value <= MAX_WIDTH) return value;
  } catch { /* Layout remains usable when storage is unavailable. */ }
  return DEFAULT_WIDTH;
}

export function useSidebarWidth(collapsed = false) {
  const [requested, setRequested] = useState(savedWidth);
  const requestedRef = useRef(requested);
  const [isResizing, setIsResizing] = useState(false);
  const [viewport, setViewport] = useState(() => typeof window === "undefined" ? 1280 : window.innerWidth);
  const overlay = collapsed || viewport <= 900;
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;
  const drag = useRef<{ pointerId: number; x: number; width: number; element: HTMLElement } | null>(null);
  const save = () => { try { window.localStorage.setItem(STORAGE_KEY, String(requestedRef.current)); } catch { /* Optional persistence. */ } };
  const update = (value: number) => {
    requestedRef.current = clamp(value, window.innerWidth, collapsedRef.current || window.innerWidth <= 900);
    setRequested(requestedRef.current);
  };
  const finish = useCallback((event?: Event) => {
    if (!drag.current) return;
    if (event && "pointerId" in event && event.pointerId !== drag.current.pointerId) return;
    const active = drag.current;
    drag.current = null;
    if (active.element.hasPointerCapture?.(active.pointerId)) active.element.releasePointerCapture(active.pointerId);
    setIsResizing(false);
    try { window.localStorage.setItem(STORAGE_KEY, String(requestedRef.current)); } catch { /* Optional persistence. */ }
  }, []);
  useEffect(() => { finish(); }, [collapsed, finish]);

  useEffect(() => {
    const resize = () => setViewport(window.innerWidth);
    const move = (event: globalThis.PointerEvent) => {
      const active = drag.current;
      if (!active || active.pointerId !== event.pointerId) return;
      update(active.width + event.clientX - active.x);
    };
    window.addEventListener("resize", resize);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    window.addEventListener("lostpointercapture", finish);
    window.addEventListener("blur", finish);
    return () => {
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      window.removeEventListener("lostpointercapture", finish);
      window.removeEventListener("blur", finish);
      const active = drag.current;
      drag.current = null;
      if (active?.element.hasPointerCapture?.(active.pointerId)) active.element.releasePointerCapture(active.pointerId);
    };
  }, [finish]);
  const width = clamp(requested, viewport, overlay);
  return {
    width, isResizing, overlay, min: MIN_WIDTH, max: maximum(viewport, overlay),
    beginResize(event: PointerEvent<HTMLElement>) {
      if (event.button !== 0 || drag.current) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      drag.current = { pointerId: event.pointerId, x: event.clientX, width, element: event.currentTarget };
      setIsResizing(true);
    },
    resizeBy(delta: number) { update(width + delta); save(); },
  };
}
