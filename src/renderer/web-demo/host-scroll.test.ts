import { describe, expect, it, vi } from "vitest";
import { keepHostScroll } from "./host-scroll";

/** A demo window whose focus() and scrollIntoView() drag the host page, as browsers do for same-origin frames. */
function embedded(drag: { x: number; y: number }) {
  const host = { scrollX: 0, scrollY: 2800, scrollTo: vi.fn((to: ScrollToOptions) => { host.scrollX = to.left ?? 0; host.scrollY = to.top ?? 0; }) };
  const focus = vi.fn((_options?: FocusOptions) => { host.scrollX = drag.x; host.scrollY = drag.y; });
  const scrollIntoView = vi.fn((_arg?: boolean | ScrollIntoViewOptions) => { host.scrollX = drag.x; host.scrollY = drag.y; });
  const win = { parent: host as unknown, HTMLElement: { prototype: { focus } }, Element: { prototype: { scrollIntoView } } };
  return { host, win, focus, scrollIntoView };
}

describe("keepHostScroll", () => {
  it("lets focus run inside the demo and puts the host page back", () => {
    const { host, win, focus } = embedded({ x: 0, y: 280 });
    keepHostScroll(win as never);
    const element = {};
    win.HTMLElement.prototype.focus.call(element as HTMLElement, { preventScroll: false });
    expect(focus).toHaveBeenCalledWith({ preventScroll: false });
    expect(host.scrollY).toBe(2800);
  });

  it("scrolls into view at once inside the demo, keeping the caller's alignment, and restores the host", () => {
    const { host, win, scrollIntoView } = embedded({ x: 0, y: 2010 });
    keepHostScroll(win as never);
    win.Element.prototype.scrollIntoView.call({} as Element, { block: "nearest", behavior: "smooth" });
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest", behavior: "instant" });
    expect(host.scrollY).toBe(2800);
    win.Element.prototype.scrollIntoView.call({} as Element, false);
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "end", behavior: "instant" });
  });

  it("leaves a host that did not move alone", () => {
    const { host, win } = embedded({ x: 0, y: 2800 });
    keepHostScroll(win as never);
    win.HTMLElement.prototype.focus.call({} as HTMLElement);
    expect(host.scrollTo).not.toHaveBeenCalled();
  });

  it("changes nothing when the demo is the top-level page", () => {
    const { win, focus } = embedded({ x: 0, y: 0 });
    win.parent = win;
    keepHostScroll(win as never);
    expect(win.HTMLElement.prototype.focus).toBe(focus);
  });
});
