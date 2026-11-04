// 宣传页把演示嵌在 iframe 里。桌面版里 focus() 和 scrollIntoView() 只滚动应用自己，
// 嵌入后浏览器会连同外层页面一起滚动：Ant Design 的弹出菜单先摆在屏幕外再定位，对它 focus 会把整页拉到顶上。
// 这里让这两个方法照常在演示里生效，然后把外层页面放回原位。宣传页开了平滑滚动，focus() 引起的滚动会在调用返回后继续，
// 所以 focus 改为不滚动地聚焦，再用下面的即时 scrollIntoView 显示该元素。

type ScrollHost = Pick<Window, "scrollX" | "scrollY" | "scrollTo">;
type DemoWindow = { parent: unknown; HTMLElement: { prototype: { focus: HTMLElement["focus"] } }; Element: { prototype: { scrollIntoView: Element["scrollIntoView"] } } };

/** Reads the host page when it is same-origin; a cross-origin host is already isolated by the browser. */
function sameOriginHost(win: DemoWindow): ScrollHost | null {
  if (win.parent === win) return null;
  try {
    const host = win.parent as ScrollHost;
    return typeof host.scrollY === "number" ? host : null;
  } catch {
    return null;
  }
}

export function keepHostScroll(win: DemoWindow): void {
  const host = sameOriginHost(win);
  if (!host) return;
  const restore = (x: number, y: number) => {
    if (host.scrollX !== x || host.scrollY !== y) host.scrollTo({ left: x, top: y, behavior: "instant" });
  };
  const focus = win.HTMLElement.prototype.focus;
  win.HTMLElement.prototype.focus = function (this: HTMLElement, options?: FocusOptions) {
    if (options?.preventScroll) {
      focus.call(this, options);
      return;
    }
    // The host page scrolls smoothly, so a scroll started by focus() keeps going after it returns and no restore can catch it.
    // Focus without scrolling, then reveal the element the way focus would, through the instant scrollIntoView below.
    focus.call(this, { ...options, preventScroll: true });
    win.Element.prototype.scrollIntoView.call(this, { block: "nearest", inline: "nearest" });
  };
  const scrollIntoView = win.Element.prototype.scrollIntoView;
  win.Element.prototype.scrollIntoView = function (this: Element, arg?: boolean | ScrollIntoViewOptions) {
    const x = host.scrollX, y = host.scrollY;
    // A smooth scroll would move the host after this call returns; scroll at once so the host can be put back.
    const options: ScrollIntoViewOptions = typeof arg === "object" ? arg : arg === false ? { block: "end" } : { block: "start" };
    scrollIntoView.call(this, { ...options, behavior: "instant" });
    restore(x, y);
  };
}
