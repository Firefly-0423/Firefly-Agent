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
  size.scrollHeight = 2000; away = [];
  container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
  act(() => root.render(createElement(Harness, { onAway: value => away.push(value) })));
  const element = list();
  Object.defineProperty(element, "scrollHeight", { configurable: true, get: () => size.scrollHeight });
  Object.defineProperty(element, "clientHeight", { configurable: true, get: () => size.clientHeight });
  // Browsers clamp scrollTop to the scrollable range.
  let top = 0;
  Object.defineProperty(element, "scrollTop", { configurable: true, get: () => top,
    set: (value: number) => { top = Math.max(0, Math.min(value, size.scrollHeight - size.clientHeight)); } });
  element.scrollTo = ((options: ScrollToOptions) => { element.scrollTop = options.top ?? 0; }) as typeof element.scrollTo;
  act(() => pinning.scrollToBottom("auto"));
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

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
});
