// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useScrollPinning, type ScrollPinning } from "./useScrollPinning";

// jsdom has no layout: the container's sizes are stubbed and growth is announced through a hand-driven ResizeObserver.
let grow: () => void = () => {};
class ManualResizeObserver {
  constructor(private readonly callback: () => void) { grow = () => this.callback(); }
  observe() {} disconnect() {}
}

let container: HTMLDivElement; let root: Root; let pinning: ScrollPinning; let away: boolean[];
let now = 1000;
let scrollHistory: number[] = [];
let scrollToCalls: ScrollToOptions[] = [];
const size = { scrollHeight: 2000, clientHeight: 500 };

function Harness({ onAway }: { onAway(value: boolean): void }) {
  pinning = useScrollPinning(onAway);
  return createElement("div", { ref: pinning.containerRef, onScroll: pinning.onScroll }, createElement("div"));
}
function list(): HTMLDivElement { return container.firstElementChild as HTMLDivElement; }
function userScrollTo(top: number) {
  now += 10; list().dispatchEvent(new WheelEvent("wheel", { deltaY: top < list().scrollTop ? -100 : 100 }));
  list().scrollTop = top; list().dispatchEvent(new Event("scroll"));
}
const bottom = () => size.scrollHeight - size.clientHeight;
function streamMore(by: number) { size.scrollHeight += by; now += 500; act(() => grow()); }

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("ResizeObserver", ManualResizeObserver);
  vi.spyOn(performance, "now").mockImplementation(() => now);
  size.scrollHeight = 2000; away = []; scrollHistory = []; scrollToCalls = [];
  delete document.documentElement.dataset.reduceMotion;
  container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
  act(() => root.render(createElement(Harness, { onAway: value => away.push(value) })));
  const element = list();
  Object.defineProperty(element, "scrollHeight", { configurable: true, get: () => size.scrollHeight });
  Object.defineProperty(element, "clientHeight", { configurable: true, get: () => size.clientHeight });
  // Browsers clamp scrollTop to the scrollable range.
  let top = 0;
  Object.defineProperty(element, "scrollTop", { configurable: true, get: () => top,
    set: (value: number) => {
      top = Math.max(0, Math.min(value, size.scrollHeight - size.clientHeight));
      scrollHistory.push(top);
    } });
  element.scrollTo = ((options: ScrollToOptions) => {
    scrollToCalls.push(options);
    element.scrollTop = options.top ?? 0;
  }) as typeof element.scrollTo;
  act(() => pinning.scrollToBottom("auto"));
});
afterEach(() => {
  delete document.documentElement.dataset.reduceMotion;
  act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("useScrollPinning", () => {
  it("follows streamed content while the reader is at the bottom", () => {
    expect(list().scrollTop).toBe(1500);
    streamMore(300);
    expect(list().scrollTop).toBe(bottom());
    streamMore(300);
    expect(list().scrollTop).toBe(bottom());
  });

  it("lets go when the reader scrolls up and shows the jump control", () => {
    userScrollTo(800);
    streamMore(300);
    expect(list().scrollTop).toBe(800);
    expect(away.at(-1)).toBe(true);
  });

  it("pins again once the reader returns to the bottom", () => {
    userScrollTo(800);
    userScrollTo(size.scrollHeight - size.clientHeight - 20);
    expect(away.at(-1)).toBe(false);
    streamMore(300);
    expect(list().scrollTop).toBe(bottom());
  });

  it("does not unpin on a scroll it caused itself", () => {
    // A scroll event with no recent user input (e.g. a frame of the smooth jump) leaves the pin in place.
    now += 5000;
    list().scrollTop = 600; list().dispatchEvent(new Event("scroll"));
    streamMore(300);
    expect(list().scrollTop).toBe(bottom());
  });

  it("does not pull the viewport during the input cooldown", () => {
    now += 10; list().dispatchEvent(new WheelEvent("wheel", { deltaY: 100 }));
    size.scrollHeight += 300; act(() => grow());
    expect(list().scrollTop).toBe(1500);
    streamMore(100);
    expect(list().scrollTop).toBe(bottom());
  });

  it("re-pins on the explicit jump action", () => {
    userScrollTo(300);
    act(() => pinning.scrollToBottom("auto"));
    expect(away.at(-1)).toBe(false);
    streamMore(300);
    expect(list().scrollTop).toBe(bottom());
  });

  it("treats scroll keys inside the composer-like fields as typing, not scrolling", () => {
    const input = document.createElement("textarea"); list().append(input);
    now += 10; input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    size.scrollHeight += 300; act(() => grow());
    expect(list().scrollTop).toBe(bottom());
  });

  it("immediately unpins on wheel-up even inside bottom tolerance", () => {
    expect(list().scrollTop).toBe(1500);
    userScrollTo(1485); // 15px from bottom, inside PIN_TOLERANCE=40
    streamMore(300);
    expect(list().scrollTop).toBe(1485);
    expect(away.at(-1)).toBe(true);
  });

  it("keeps the first visible message position unchanged across appends when unpinned off-bottom", () => {
    const msgTop = 720;
    userScrollTo(650);
    const viewportOffsetBefore = msgTop - list().scrollTop;
    streamMore(120);
    streamMore(240);
    streamMore(180);
    expect(list().scrollTop).toBe(650);
    expect(msgTop - list().scrollTop).toBe(viewportOffsetBefore);
  });

  it("follows pinned growth monotonically with zero back-and-forth oscillation across streaming and tool-card expansion", () => {
    scrollHistory = [];
    streamMore(80);
    streamMore(120);
    // Simulate a tool card expanding and collapsing/expanding further.
    streamMore(450);
    expect(scrollHistory).toEqual([1580, 1700, 2150]);
    expect(list().scrollTop).toBe(bottom());

    // When unpinned, tool-card expansion does not pull the viewport.
    userScrollTo(900);
    scrollHistory = [];
    streamMore(450);
    expect(scrollHistory).toEqual([]);
    expect(list().scrollTop).toBe(900);
  });

  it("handles native scrollbar dragging and external scroll-pill dragging", () => {
    // Native scrollbar drag (pointerdown on container element) up even within PIN_TOLERANCE unpins.
    now += 10;
    list().dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }) as unknown as PointerEvent);
    list().scrollTop = 1480;
    list().dispatchEvent(new Event("scroll"));
    streamMore(300);
    expect(list().scrollTop).toBe(1480);

    // Dragging back down to bottom re-pins.
    now += 10;
    list().dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }) as unknown as PointerEvent);
    list().scrollTop = bottom() - 10;
    list().dispatchEvent(new Event("scroll"));
    streamMore(200);
    expect(list().scrollTop).toBe(bottom());

    // ScrollPill drag (markUserScroll) up immediately unpins.
    now += 10;
    pinning.markUserScroll();
    list().scrollTop = 1000;
    list().dispatchEvent(new Event("scroll"));
    streamMore(200);
    expect(list().scrollTop).toBe(1000);
  });

  it("uses instant jump when reduced motion is enabled", () => {
    document.documentElement.dataset.reduceMotion = "on";
    userScrollTo(400);
    scrollToCalls = [];
    act(() => pinning.scrollToBottom("smooth"));
    expect(scrollToCalls.at(-1)).toEqual({ top: size.scrollHeight, behavior: "auto" });
    expect(list().scrollTop).toBe(bottom());
  });
});
