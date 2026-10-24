// useScrollPinning — keeps a scroll container anchored to its bottom while content grows (streaming replies,
// tool cards expanding), and lets go the moment the user scrolls away.
//
// Rules:
// - Content growth never unpins; only the user does (wheel up, touch drag, scroll keys, dragging the scrollbar).
// - Reaching the bottom again (within PIN_TOLERANCE) re-pins, whoever scrolled there.
// - Right after a user input there is a short cooldown in which growth does not pull the viewport, so a wheel
//   tick that is still in flight is not fought.
// - Re-anchoring is instant ("auto"); smooth scrolling is only used for the explicit jump-to-latest action.

import { useCallback, useEffect, useRef, type RefObject } from "react";

export const PIN_TOLERANCE = 40;
/** Distance from the bottom past which the jump-to-latest control appears. */
export const JUMP_THRESHOLD = 100;
export const USER_INPUT_COOLDOWN_MS = 150;

const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

export interface ScrollPinning {
  containerRef: RefObject<HTMLDivElement | null>;
  onScroll(): void;
  scrollToBottom(behavior?: ScrollBehavior): void;
  /** A scroll the user drives from outside the container (the scroll pill): counts like a wheel or scrollbar drag. */
  markUserScroll(): void;
}

export function useScrollPinning(onAwayChange?: (away: boolean) => void): ScrollPinning {
  const containerRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const lastUserInputRef = useRef(Number.NEGATIVE_INFINITY);
  const awayRef = useRef(false);
  const onAwayChangeRef = useRef(onAwayChange);
  onAwayChangeRef.current = onAwayChange;

  const reportAway = useCallback((away: boolean) => {
    if (awayRef.current === away) return;
    awayRef.current = away;
    onAwayChangeRef.current?.(away);
  }, []);

  const distanceFromBottom = (element: HTMLElement) => element.scrollHeight - element.scrollTop - element.clientHeight;

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const element = containerRef.current;
    if (!element) return;
    pinnedRef.current = true;
    element.scrollTo({ top: element.scrollHeight, behavior });
    reportAway(false);
  }, [reportAway]);

  const markUserScroll = useCallback(() => { lastUserInputRef.current = performance.now(); }, []);

  const onScroll = useCallback(() => {
    const element = containerRef.current;
    if (!element) return;
    const distance = distanceFromBottom(element);
    if (distance <= PIN_TOLERANCE) pinnedRef.current = true;
    // Only a scroll the user caused can unpin; intermediate frames of our own smooth scroll leave the pin alone.
    else if (performance.now() - lastUserInputRef.current < 1000) pinnedRef.current = false;
    reportAway(distance > JUMP_THRESHOLD);
  }, [reportAway]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const markUserInput = () => { lastUserInputRef.current = performance.now(); };
    const onWheel = (event: WheelEvent) => {
      markUserInput();
      // Scrolling up is an intent to read back even when there is nothing to scroll yet.
      if (event.deltaY < 0) pinnedRef.current = false;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      if (SCROLL_KEYS.has(event.key)) markUserInput();
    };
    // A press on the container itself (not on its content) is a scrollbar drag.
    const onPointerDown = (event: PointerEvent) => { if (event.target === element) markUserInput(); };

    const reanchor = () => {
      const distance = distanceFromBottom(element);
      if (pinnedRef.current && performance.now() - lastUserInputRef.current > USER_INPUT_COOLDOWN_MS && distance > 0) {
        element.scrollTop = element.scrollHeight;
        reportAway(false);
        return;
      }
      reportAway(distance > JUMP_THRESHOLD);
    };
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(reanchor);
    const observeChildren = () => {
      if (!observer) return;
      observer.disconnect();
      observer.observe(element);
      for (const child of Array.from(element.children)) observer.observe(child);
    };
    observeChildren();
    // Children come and go (the channel banner, the list itself on first render); keep observing the current set.
    const mutations = typeof MutationObserver === "undefined" ? undefined : new MutationObserver(observeChildren);
    mutations?.observe(element, { childList: true });

    element.addEventListener("wheel", onWheel, { passive: true });
    element.addEventListener("touchmove", markUserInput, { passive: true });
    element.addEventListener("keydown", onKeyDown);
    element.addEventListener("pointerdown", onPointerDown);
    return () => {
      observer?.disconnect();
      mutations?.disconnect();
      element.removeEventListener("wheel", onWheel);
      element.removeEventListener("touchmove", markUserInput);
      element.removeEventListener("keydown", onKeyDown);
      element.removeEventListener("pointerdown", onPointerDown);
    };
  }, [reportAway]);

  return { containerRef, onScroll, scrollToBottom, markUserScroll };
}
