import { useRef, useState, useEffect, type MouseEvent as ReactMouseEvent } from "react";

export type FloatingCardPosition = { y: number; x: number };

export function clampFloatingCardPosition(position: FloatingCardPosition,
  card: { width: number; minVisibleHeight: number }, viewport: { width: number; height: number }): FloatingCardPosition {
  const horizontal = Math.max(0, viewport.width - card.width);
  const vertical = Math.max(0, viewport.height - card.minVisibleHeight);
  return { x: Math.min(Math.max(0, position.x), horizontal), y: Math.min(Math.max(0, position.y), vertical) };
}

export function useFloatingCard(options: { width: number; top?: number; right?: number; defaultCollapsed?: boolean }) {
  const { width, top = 80, right = 24 } = options;
  const [folded, fold] = useState(options.defaultCollapsed ?? false);
  const [coordinates, move] = useState<FloatingCardPosition>({
    x: typeof window !== "undefined" ? window.innerWidth - width - right : 0, y: top,
  });
  const [dragging, markDrag] = useState(false);
  const origin = useRef<{ pointerX: number; pointerY: number; cardX: number; cardY: number } | null>(null);

  useEffect(() => {
    function track(pointer: MouseEvent) {
      const start = origin.current;
      if (!start) return;
      const offsetX = pointer.clientX - start.pointerX;
      const offsetY = pointer.clientY - start.pointerY;
      if (Math.abs(offsetX) > 3 || Math.abs(offsetY) > 3) markDrag(true);
      const next = { x: start.cardX + offsetX, y: start.cardY + offsetY };
      move(clampFloatingCardPosition(next, { width, minVisibleHeight: 48 }, {
        width: window.innerWidth, height: window.innerHeight,
      }));
    }
    function finish() {
      origin.current = null;
      window.setTimeout(() => markDrag(false), 0);
    }
    window.addEventListener("mousemove", track);
    window.addEventListener("mouseup", finish);
    return () => {
      window.removeEventListener("mousemove", track);
      window.removeEventListener("mouseup", finish);
    };
  }, [width]);

  return {
    collapsed: folded,
    position: coordinates,
    toggle: () => fold((before) => !before),
    onHeaderMouseDown(event: ReactMouseEvent) {
      if ((event.target as HTMLElement).closest("[data-floating-toggle]")) return;
      origin.current = { pointerX: event.clientX, pointerY: event.clientY, cardX: coordinates.x, cardY: coordinates.y };
    },
    onHeaderClick() { if (!dragging) fold((before) => !before); },
  };
}
