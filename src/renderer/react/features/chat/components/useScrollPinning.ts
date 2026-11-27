// useScrollPinning — sole scroll owner for the conversation list. Keeps the outer container anchored to its
// bottom while content grows (streaming replies, tool cards expanding) ONLY when already pinned before growth,
// and lets go immediately the moment the user scrolls up (even inside PIN_TOLERANCE).
//
// Rules:
// - Content growth never unpins; only the user does (wheel up, touch drag, scroll-up keys, scrollbar drag).
// - Scrolling up immediately sets pinned = false, even within PIN_TOLERANCE, until the user actively returns
//   to the bottom or triggers jump-to-latest.
// - Re-anchoring is instant ("auto"); smooth scrolling is used for explicit jump-to-latest only when motion
//   is not reduced.

import { useCallback, useEffect, useRef, type RefObject } from "react";
import { isMotionReduced } from "../pages/message-reveal";

export const PIN_TOLERANCE = 40;
/** Distance from the bottom past which the jump-to-latest control appears. */
export const JUMP_THRESHOLD = 100;
export const USER_INPUT_COOLDOWN_MS = 150;

const SCROLL_DOWN_KEYS = new Set(["ArrowDown", "PageDown", "End", " "]);
const SCROLL_UP_KEYS = new Set(["ArrowUp", "PageUp", "Home"]);

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
  const lastWheelUpAtRef = useRef(Number.NEGATIVE_INFINITY);
  const lastScrollTopRef = useRef(0);
  const jumpingToBottomRef = useRef(false);
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
    const resolved: ScrollBehavior = isMotionReduced() ? "auto" : behavior;
    pinnedRef.current = true;
    lastWheelUpAtRef.current = Number.NEGATIVE_INFINITY;
    jumpingToBottomRef.current = resolved === "smooth";
    if (typeof element.scrollTo === "function") {
      element.scrollTo({ top: element.scrollHeight, behavior: resolved });
    } else {
      element.scrollTop = element.scrollHeight;
    }
    if (resolved === "auto") lastScrollTopRef.current = element.scrollTop;
    reportAway(false);
  }, [reportAway]);

  const markUserScroll = useCallback(() => {
    lastUserInputRef.current = performance.now();
    jumpingToBottomRef.current = false;
  }, []);

  const onScroll = useCallback(() => {
    const element = containerRef.current;
    if (!element) return;
    const prevTop = lastScrollTopRef.current;
    const nextTop = element.scrollTop;
    lastScrollTopRef.current = nextTop;

    const distance = distanceFromBottom(element);
    const now = performance.now();
    const recentUser = now - lastUserInputRef.current < 1000;
    const recentWheelUp = now - lastWheelUpAtRef.current < 250;
    const scrolledUp = nextTop < prevTop && distance > 1;

    if (scrolledUp && recentUser) {
      pinnedRef.current = false;
      jumpingToBottomRef.current = false;
    } else if (distance <= 2) {
      jumpingToBottomRef.current = false;
      if (!recentWheelUp) pinnedRef.current = true;
    } else if (distance <= PIN_TOLERANCE) {
      if (nextTop > prevTop && !recentWheelUp) pinnedRef.current = true;
    } else if (recentUser) {
      pinnedRef.current = false;
      jumpingToBottomRef.current = false;
    }
    reportAway(distance > JUMP_THRESHOLD);
  }, [reportAway]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    lastScrollTopRef.current = element.scrollTop;
    const markUserInput = () => {
      lastUserInputRef.current = performance.now();
      jumpingToBottomRef.current = false;
    };
    const onWheel = (event: WheelEvent) => {
      markUserInput();
      if (event.deltaY < 0) {
        // Scrolling up immediately unpins even within PIN_TOLERANCE.
        pinnedRef.current = false;
        lastWheelUpAtRef.current = performance.now();
      } else if (event.deltaY > 0) {
        lastWheelUpAtRef.current = Number.NEGATIVE_INFINITY;
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      if (SCROLL_UP_KEYS.has(event.key)) {
        markUserInput();
        pinnedRef.current = false;
        lastWheelUpAtRef.current = performance.now();
      } else if (SCROLL_DOWN_KEYS.has(event.key)) {
        markUserInput();
      }
    };
    // A press on the container itself (not on its content) is a scrollbar drag.
    const onPointerDown = (event: PointerEvent) => { if (event.target === element) markUserInput(); };

    const reanchor = () => {
      const distance = distanceFromBottom(element);
      if (pinnedRef.current && performance.now() - lastUserInputRef.current > USER_INPUT_COOLDOWN_MS && distance > 0) {
        element.scrollTop = element.scrollHeight;
        lastScrollTopRef.current = element.scrollTop;
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
      // The message list grows inside its own scroll box; watch that too so growth is seen even if a wrapper is capped.
      for (const box of Array.from(element.querySelectorAll(":scope > .ant-bubble-list > .ant-bubble-list-scroll-box"))) observer.observe(box);
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
