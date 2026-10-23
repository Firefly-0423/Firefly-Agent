// @vitest-environment jsdom
import React, { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PILL_LENGTH, ScrollPill, pillGeometry } from "./ScrollPill";

describe("scroll pill geometry", () => {
  const base = { scrollHeight: 3000, clientHeight: 1000, listTop: 100, panelRight: 1800 };
  it("keeps one fixed length and travels from top to bottom with the scroll position", () => {
    expect(pillGeometry({ ...base, scrollTop: 0 }).top).toBe(108);
    expect(pillGeometry({ ...base, scrollTop: 2000 }).top).toBe(100 + 1000 - PILL_LENGTH - 8);
    expect(pillGeometry({ ...base, scrollTop: 1000 }).top).toBe(Math.round(108 + 0.5 * (1000 - PILL_LENGTH - 16)));
  });
  it("hugs the right edge of the whole panel, outside the overview cards", () => {
    expect(pillGeometry({ ...base, scrollTop: 0 }).left).toBe(1792);
  });
  it("is hidden when there is nothing to scroll", () => {
    expect(pillGeometry({ ...base, scrollHeight: 1000, scrollTop: 0 }).visible).toBe(false);
  });
});

describe("scroll pill", () => {
  let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
  beforeEach(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  it("shows while scrolling and drags the conversation with it", () => {
    const list = document.createElement("div");
    Object.defineProperties(list, { scrollHeight: { value: 3000 }, clientHeight: { value: 1000 } });
    host.append(list);
    const ref = createRef<HTMLElement>();
    (ref as { current: HTMLElement }).current = list;
    act(() => root.render(React.createElement(ScrollPill, { target: ref, panel: ".none" })));
    const pill = host.querySelector<HTMLElement>(".ff-scroll-pill")!;
    expect(pill.style.height).toBe(`${PILL_LENGTH}px`);
    expect(pill.classList.contains("is-active")).toBe(false);
    act(() => { list.scrollTop = 500; list.dispatchEvent(new Event("scroll")); });
    expect(pill.classList.contains("is-active")).toBe(true);
    act(() => {
      pill.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, clientY: 100 }));
      pill.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientY: 100 + (1000 - PILL_LENGTH - 16) / 4 }));
    });
    expect(list.scrollTop).toBe(1000);
  });

  it("tells bottom-pinning the user is scrolling while the pill is dragged", () => {
    const list = document.createElement("div");
    Object.defineProperties(list, { scrollHeight: { value: 3000 }, clientHeight: { value: 1000 } });
    host.append(list);
    const ref = createRef<HTMLElement>();
    (ref as { current: HTMLElement }).current = list;
    const onUserScroll = vi.fn();
    act(() => root.render(React.createElement(ScrollPill, { target: ref, panel: ".none", onUserScroll })));
    const pill = host.querySelector<HTMLElement>(".ff-scroll-pill")!;
    act(() => {
      pill.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 2, clientY: 400 }));
      pill.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 2, clientY: 300 }));
    });
    expect(onUserScroll).toHaveBeenCalled();
  });
});
